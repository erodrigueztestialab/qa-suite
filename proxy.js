/**
 * TestIALab — QA Suite IA Backend
 * Motor: dual — Gemini (via Antigravity CLI, Google Auth) o Claude CLI (Plan Pro, sin API key)
 * Puerto: 3001
 *
 * Nota sobre "gemini" (2026-08-26): el `gemini` CLI viejo (npm @google/gemini-cli,
 * login OAuth individual) quedo muerto cuando Google cerro ese tier gratis el
 * 18/06/2026 (IneligibleTierError). El motor "gemini" de esta app ahora corre sobre
 * **Antigravity CLI** (binario `agy`, instalado via winget), que es el reemplazo
 * gratuito oficial para cuentas individuales -- validado en vivo (spawn headless,
 * prompts largos, lectura de imagenes via --add-dir, todo funciona). Ojo: tiene
 * cuota semanal ajustada (se agota en ~20-30 min de uso real), por eso el motor
 * por defecto es Claude, no Gemini (ver ENGINE_DEFAULT abajo).
 *
 * Estrategia de documentos:
 *   PDF  → se guarda en /tmp y se pasa al motor via vision nativa
 *          (--add-dir + instruccion de leer el archivo -- mismo mecanismo para
 *           Gemini/Antigravity y Claude, ambos son agentes con herramienta de
 *           lectura de archivos, no hace falta una sintaxis distinta por motor.)
 *   DOCX → se convierte a PDF con LibreOffice, luego vision nativa
 *   TXT  → texto plano embebido en el prompt
 *
 * Selección de motor: el body de /api/analyze acepta "engine": "gemini" | "claude".
 * Default: "claude" (ENGINE_DEFAULT abajo) -- Gemini/Antigravity queda disponible
 * pero hay que elegirlo a proposito, justamente por la cuota semanal ajustada.
 */

const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const mammoth  = require('mammoth');
const { PDFParse } = require('pdf-parse');
const { spawn, execFile } = require('child_process');
const crossSpawn = require('cross-spawn');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ImageRun, AlignmentType, BorderStyle, ShadingType, Header, Footer, PageNumber,
} = require('docx');
const { pipeline } = require('@huggingface/transformers');

const app  = express();
const PORT = 3001;
const ENGINE_DEFAULT = 'claude'; // 'gemini' | 'claude' -- Gemini/Antigravity tiene cuota semanal ajustada, no debe ser el default silencioso

// ── Chatbot QA: carpeta de conocimiento (transcripciones de negocio) ──────────
// PoC: apunta a ./knowledge dentro del repo con 2 documentos de prueba. Para
// la carpeta real (sincronizada via OneDrive/Drive), definir KNOWLEDGE_DIR
// antes de arrancar el proxy, igual patron que CLAUDE_CLI_PATH.
var KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || 'C:\\Esteban\\1.TESTIALAB-TODO\\Capacitaciones';

// Las transcripciones reales vienen como .docx (a veces junto a un .mp4 de la
// grabacion, que no se procesa -- fuera de alcance sin pipeline de transcripcion).
// Claude Code CLI no extrae texto de .docx de forma confiable con su herramienta
// Read (es un binario ZIP) -- por eso, antes de cada consulta, se genera un .txt
// hermano (mismo nombre) con mammoth, y el Chatbot QA busca sobre esos .txt.
async function ensureKnowledgeTextCache(dir) {
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await ensureKnowledgeTextCache(full); continue; }
    if (!/\.docx$/i.test(entry.name)) continue;
    var txtPath = full.replace(/\.docx$/i, '.txt');
    try {
      var needsExtract = !fs.existsSync(txtPath) || fs.statSync(full).mtimeMs > fs.statSync(txtPath).mtimeMs;
      if (!needsExtract) continue;
      var result = await mammoth.extractRawText({ path: full });
      fs.writeFileSync(txtPath, result.value, 'utf-8');
    } catch (e) {
      console.warn('[knowledge] no se pudo extraer texto de', full, '-', e.message);
    }
  }
}

// Lee todos los .txt de la base de conocimiento y los devuelve para incrustar
// en el prompt. Se probo darle a Claude CLI acceso directo a la carpeta via
// --add-dir/Glob/Grep (asi funciona igual en M1 con PDFs), pero al spawnear el
// CLI desde este proceso Node en Windows la herramienta Glob queda bloqueada
// por el permission-checker del CLI (permission_denials en el JSON de salida)
// incluso con --permission-mode bypassPermissions -- reproducible y consistente
// via node, pese a que invocando el mismo comando a mano desde una shell si
// funciona. Como la base de conocimiento es chica (transcripciones de reunion,
// no video), es mas simple y confiable incrustar el texto directo en el prompt.
function readKnowledgeTextFiles(dir, baseDir) {
  baseDir = baseDir || dir;
  var out = [];
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out = out.concat(readKnowledgeTextFiles(full, baseDir)); continue; }
    if (!/\.txt$/i.test(entry.name)) continue;
    try {
      var content = fs.readFileSync(full, 'utf-8');
      out.push({ relPath: path.relative(baseDir, full), content: content });
    } catch (e) {
      console.warn('[knowledge] no se pudo leer', full, '-', e.message);
    }
  }
  return out;
}

// ── Chatbot QA: RAG con embeddings locales ─────────────────────────────────────
// Antes se incrustaba el banco de conocimiento COMPLETO en cada pregunta (podia
// pesar cientos de KB), gastando presupuesto de sesion sin necesidad -- la mayor
// parte del texto no tiene nada que ver con la pregunta puntual del QA. Ahora se
// indexa una sola vez (embeddings locales via @huggingface/transformers, modelo
// ONNX corriendo en este mismo proceso, sin costo de API externa) y en cada
// pregunta solo se recuperan los fragmentos realmente relevantes por similitud
// semantica -- no por coincidencia de palabras exactas, asi que una pregunta
// parafraseada (que no usa los terminos literales del documento) sigue
// encontrando el fragmento correcto.
var EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
var _embedderPromise = null;
function getEmbedder() {
  if (!_embedderPromise) _embedderPromise = pipeline('feature-extraction', EMBED_MODEL);
  return _embedderPromise;
}
async function embedText(text) {
  var embedder = await getEmbedder();
  var out = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

// Parte cada archivo en fragmentos de ~1000 caracteres respetando parrafos donde
// se puede (no corta una idea a la mitad si el parrafo entero cabe), con solape
// entre fragmentos consecutivos para no perder contexto justo en el borde de corte.
var CHUNK_SIZE = 1000;
var CHUNK_OVERLAP = 150;
function chunkText(text) {
  var paragraphs = text.split(/\n\s*\n/).map(function(p){ return p.trim(); }).filter(Boolean);
  var chunks = [];
  var current = '';
  paragraphs.forEach(function(p) {
    if (p.length > CHUNK_SIZE) {
      // Parrafo mas largo que el tamano de fragmento -- se corta por oraciones.
      if (current) { chunks.push(current); current = ''; }
      var sentences = p.split(/(?<=[.!?])\s+/);
      var piece = '';
      sentences.forEach(function(s) {
        if (piece && (piece + ' ' + s).length > CHUNK_SIZE) { chunks.push(piece); piece = s; }
        else piece = piece ? piece + ' ' + s : s;
      });
      if (piece) current = piece;
      return;
    }
    if (current && (current + '\n\n' + p).length > CHUNK_SIZE) {
      chunks.push(current);
      current = current.slice(-CHUNK_OVERLAP) + '\n\n' + p; // overlap con la cola del fragmento anterior
    } else {
      current = current ? current + '\n\n' + p : p;
    }
  });
  if (current) chunks.push(current);
  return chunks;
}

// Ambos vectores ya vienen normalizados (normalize:true al generarlos), asi que
// el producto punto es directamente el coseno -- no hace falta dividir por normas.
function cosineSimilarity(a, b) {
  var dot = 0;
  for (var i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// Indice en memoria: se reconstruye solo si cambio el contenido de la carpeta de
// conocimiento (firma = ruta+tamano de cada .txt) -- evita re-generar embeddings
// en cada pregunta si nadie subio/edito transcripciones desde la ultima vez.
var _knowledgeIndex = { signature: null, chunks: [] };
function knowledgeSignature(files) {
  return files.map(function(f){ return f.relPath + ':' + f.content.length; }).join('|');
}
async function ensureKnowledgeIndex(dir) {
  var files = readKnowledgeTextFiles(dir);
  var sig = knowledgeSignature(files);
  if (_knowledgeIndex.signature === sig) return _knowledgeIndex;
  var chunks = [];
  for (var i = 0; i < files.length; i++) {
    var pieces = chunkText(files[i].content);
    for (var j = 0; j < pieces.length; j++) {
      chunks.push({ relPath: files[i].relPath, text: pieces[j], embedding: await embedText(pieces[j]) });
    }
  }
  _knowledgeIndex = { signature: sig, chunks: chunks };
  return _knowledgeIndex;
}

// Top-K fragmentos mas relevantes para la pregunta, ademas acotados a un tope de
// caracteres -- asi el prompt final sigue siendo chico sin importar cuantos
// fragmentos existan en total en la base de conocimiento.
var RETRIEVE_TOP_K = 8;
var RETRIEVE_CHAR_BUDGET = 6000;
async function retrieveRelevantChunks(question, index) {
  if (!index.chunks.length) return [];
  var qEmbedding = await embedText(question);
  var scored = index.chunks.map(function(c){
    return { relPath: c.relPath, text: c.text, score: cosineSimilarity(qEmbedding, c.embedding) };
  }).sort(function(a,b){ return b.score - a.score; });
  var picked = [];
  var totalChars = 0;
  for (var i = 0; i < scored.length && picked.length < RETRIEVE_TOP_K; i++) {
    if (picked.length > 0 && totalChars + scored[i].text.length > RETRIEVE_CHAR_BUDGET) break;
    picked.push(scored[i]);
    totalChars += scored[i].text.length;
  }
  return picked;
}

// El logo embebido en qa-suite.html esta etiquetado "image/png" pero el binario
// real es JPEG (bytes empiezan en FFD8FF, firma JPEG) -- importa para el "type"
// que exige ImageRun de la libreria docx (ver mas abajo).
var LOGO_PATH = path.join(__dirname, 'assets', 'logo.jpg');
var LOGO_BUFFER = null;
var LOGO_ASPECT = 2030 / 775; // ancho/alto real del logo, para no deformarlo en el docx
try { LOGO_BUFFER = fs.readFileSync(LOGO_PATH); } catch (e) { console.warn('[docx] logo no encontrado en', LOGO_PATH); }

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Sirve qa-suite.html (y cualquier otro asset estático) desde este mismo
// directorio y puerto, para no depender de abrir el HTML como archivo local.
app.use(express.static(__dirname));
app.get('/', function(_req, res) {
  res.sendFile(path.join(__dirname, 'qa-suite.html'));
});

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB para PDFs grandes
});

// ── SSE progress store ────────────────────────────────────────────────────────
// Simple per-request progress using a Map keyed by sessionId
const progressClients = new Map();

// ── Gemini (via Antigravity CLI) ────────────────────────────────────────────
// El motor "gemini" corre sobre el binario `agy` (Antigravity CLI, reemplazo
// gratuito oficial de Google para cuentas individuales -- ver nota de cabecera
// del archivo). A diferencia del `gemini` viejo, el prompt va PEGADO al flag
// -p como argumento, no por stdin -- por eso usamos cross-spawn (args reales,
// sin pasar por shell) en vez de spawn({shell:true}): con el prompt como
// argumento de linea de comandos, shell:true arriesgaria romper/inyectar shell
// si el prompt trae comillas, backticks o "$" (mismo motivo por el que
// spawnClaudeOnce ya usa cross-spawn para Claude).

// Mapeo de modelo: los endpoints ya mandan opts.model: 'sonnet'|'opus' (nomenclatura
// de Claude) sin distincion de motor -- se reusa el mismo valor para no tener que
// tocar cada endpoint. 'gemini-3.1-pro-low' ~ tier Sonnet (default, uso general),
// 'gemini-3.1-pro-high' ~ tier Opus (razonamiento mas alto, casos/cobertura/gaps).
var GEMINI_MODEL_MAP = { opus: 'gemini-3.1-pro-high', sonnet: 'gemini-3.1-pro-low' };

// Resolver el binario de Antigravity CLI: env var explicita, el shim de winget
// (si existe), la carpeta real de instalacion de winget (nombre con hash de
// publisher variable segun la version -- ej "Google.AntigravityCLI_Microsoft.
// Winget.Source_8wekyb3d8bbwe" -- por eso se busca por prefijo en vez de
// hardcodear el hash), y por ultimo el comando a secas resuelto por PATH.
function candidateGeminiBins() {
  var list = [];
  if (process.env.AGY_CLI_PATH) list.push(process.env.AGY_CLI_PATH);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    list.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'agy.exe'));
    try {
      var pkgsDir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
      var match = fs.readdirSync(pkgsDir).find(function(name){ return name.indexOf('Google.AntigravityCLI_') === 0; });
      if (match) list.push(path.join(pkgsDir, match, 'agy.exe'));
    } catch (e) { /* carpeta de winget no existe todavia -- ok, se prueba el siguiente candidato */ }
  }
  list.push('agy');
  return list;
}

function spawnGeminiOnce(bin, args, timeoutMs, onProcess) {
  return new Promise(function(resolve, reject) {
    var proc = crossSpawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (onProcess) onProcess(proc); // permite al caller (ruta HTTP) matarlo si el cliente cancela
    var stdout = '', stderr = '', settled = false;

    proc.stdout.on('data', function(d){ stdout += d.toString(); });
    proc.stderr.on('data', function(d){
      stderr += d.toString();
      process.stderr.write('[gemini/agy] ' + d.toString());
    });

    var timer = setTimeout(function(){
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('Antigravity CLI timeout (8 min).'));
    }, timeoutMs);

    proc.on('error', function(err){
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err); // conserva err.code ('ENOENT', etc.) para el retry por candidato
    });

    proc.on('close', function(code){
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code, stdout: stdout, stderr: stderr });
    });
  });
}

async function callGemini(prompt, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || 480000;
  var model     = GEMINI_MODEL_MAP[opts.model] || GEMINI_MODEL_MAP.sonnet;
  var filePath  = opts.filePath || null;
  var imagePaths = opts.imagePaths || null;
  var addDir = opts.addDir || (filePath ? path.dirname(filePath)
             : (imagePaths && imagePaths.length) ? path.dirname(imagePaths[0])
             : null);

  var args = ['-p', prompt, '--model', model];
  if (addDir) args.push('--add-dir', addDir);

  var candidates = candidateGeminiBins();
  var lastErr = null;

  for (var i = 0; i < candidates.length; i++) {
    var bin = candidates[i];
    console.log('\n-> GEMINI/AGY  bin='+bin+'  model='+model+'  prompt_len='+prompt.length+(addDir?'  addDir='+addDir:''));
    try {
      var result = await spawnGeminiOnce(bin, args, timeoutMs, opts.onProcess);
      var text = result.stdout.trim();
      console.log('<- GEMINI/AGY  rc='+result.code+'  len='+text.length);

      if (result.code !== 0 || !text) {
        var signInLike = /sign in|not authenticated|please sign in/i.test(result.stderr);
        var msg = signInLike
          ? 'Antigravity CLI no esta autenticado. Ejecuta "agy" sin argumentos en una terminal para iniciar sesion (login gratuito con la cuenta de Google de TestiAlab), y reinicia el proxy. Detalle: ' + result.stderr.slice(0, 300)
          : (result.stderr.slice(0, 500) || 'Antigravity CLI codigo ' + result.code);
        throw new Error(msg);
      }
      return text; // exito
    } catch (e) {
      lastErr = e;
      if (e.code !== 'ENOENT') {
        // Error real (timeout, auth, respuesta vacia, etc.) -- no tiene sentido
        // seguir probando otros candidatos de binario, se reporta de una.
        throw e;
      }
      // ENOENT: este candidato no existe/no se encontro; probar el siguiente.
    }
  }

  throw new Error(
    'No se encontro el ejecutable "agy" (Antigravity CLI) en este equipo. ' +
    'Instalalo con: winget install --id Google.AntigravityCLI --exact ' +
    '(o el instalador oficial en antigravity.google). Si ya esta instalado y el error ' +
    'persiste, definí la variable de entorno AGY_CLI_PATH con la ruta completa al ejecutable ' +
    'antes de iniciar el proxy.'
  );
}

// ── Chequeo real de disponibilidad de Gemini/Antigravity ────────────────────
// A diferencia de un simple "--version" (que solo confirma que el binario existe,
// no que la sesion este autenticada), "agy models" requiere auth real: si no hay
// sesion, falla con un mensaje claro ("Please sign in..."). Usado por
// /api/engine-status para que el sidebar no diga "Conectado" con Gemini roto.
async function checkGeminiAvailable(timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  var candidates = candidateGeminiBins();
  var lastErr = null;
  for (var i = 0; i < candidates.length; i++) {
    var bin = candidates[i];
    try {
      var result = await spawnGeminiOnce(bin, ['models'], timeoutMs, null);
      if (result.code === 0 && result.stdout.trim()) {
        var modelCount = result.stdout.trim().split('\n').filter(Boolean).length;
        return { available: true, detail: 'Antigravity CLI (' + modelCount + ' modelos disponibles)' };
      }
      var signInLike = /sign in|not authenticated|please sign in/i.test(result.stderr);
      return {
        available: false,
        detail: signInLike
          ? 'No autenticado -- ejecuta "agy" sin argumentos en una terminal para iniciar sesion.'
          : (result.stderr.slice(0, 200) || 'Antigravity CLI codigo ' + result.code)
      };
    } catch (e) {
      lastErr = e;
      if (e.code !== 'ENOENT') return { available: false, detail: e.message };
      // ENOENT: probar el siguiente candidato de binario.
    }
  }
  return { available: false, detail: (lastErr && lastErr.message) || 'No se encontro "agy" (Antigravity CLI) en este equipo.' };
}

// ── Claude CLI ───────────────────────────────────────────────────────────
// Usa la sesion Plan Pro del usuario (sin API key). Modo headless con
// --print --output-format stream-json, igual que en el proyecto Cinemark.
// Si hay filePath (vision nativa de PDF), se habilita --add-dir sobre la carpeta
// que lo contiene + --allowedTools Read, y el prompt le indica la ruta exacta a leer.

function parseClaudeStreamJson(raw) {
  var resultText = '', assistantText = '', deltaText = '';
  var isError = false, apiErrorStatus = 0, errorCode = '';

  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    try {
      var ev = JSON.parse(line);

      if (ev.type === 'result') {
        if (ev.is_error === true) isError = true;
        if (ev.api_error_status) apiErrorStatus = Number(ev.api_error_status) || apiErrorStatus;
        if (ev.error) errorCode = ev.error;
        if (typeof ev.result === 'string' && ev.result.length > 0) resultText = ev.result;
      }
      if (ev.error_status) apiErrorStatus = Number(ev.error_status) || apiErrorStatus;
      if (ev.api_error_status) apiErrorStatus = Number(ev.api_error_status) || apiErrorStatus;
      if (ev.error && !errorCode) errorCode = ev.error;

      if (ev.type === 'assistant' && Array.isArray(ev.message && ev.message.content)) {
        var blockText = '';
        for (var j = 0; j < ev.message.content.length; j++) {
          var block = ev.message.content[j];
          if (block.type === 'text' && block.text) blockText += block.text;
        }
        if (blockText.length > assistantText.length) assistantText = blockText;
      }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        deltaText += ev.delta.text || '';
      }
    } catch (e) {}
  }

  var best = resultText || assistantText || deltaText;
  return { text: best.trim(), isError: isError, apiErrorStatus: apiErrorStatus, errorCode: errorCode };
}

// ── Resolver el binario de Claude CLI ────────────────────────────────────
// "claude" en Windows suele ser un shim .cmd (via npm global) — shell:true ya
// deja que cmd.exe lo resuelva por PATH, pero si "claude" no vive en el PATH que
// hereda el proceso de Node (ej: quedo agregado solo en la sesion de otra app,
// o hay multiples instalaciones de Node/npm) igual da ENOENT. Se prueban, en orden:
//   1) CLAUDE_CLI_PATH (variable de entorno, si el usuario la definio)
//   2) La ruta tipica del bin global de npm en Windows (%APPDATA%\npm\claude.cmd)
//   3) "claude" a secas, resuelto por PATH via el shell (funciona en la mayoria de casos)
function candidateClaudeBins() {
  var list = [];
  if (process.env.CLAUDE_CLI_PATH) list.push(process.env.CLAUDE_CLI_PATH);
  if (process.platform === 'win32' && process.env.APPDATA) {
    list.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
  }
  list.push('claude');
  return list;
}

function spawnClaudeOnce(bin, args, prompt, timeoutMs, extraEnv, onProcess) {
  return new Promise(function(resolve, reject) {
    var env = extraEnv ? Object.assign({}, process.env, extraEnv) : process.env;
    // cross-spawn resuelve .cmd en Windows sin pasar por shell:true, que en Windows
    // concatena args sin escapar (DEP0190) y corrompe valores largos/con puntuacion
    // como --add-dir o --append-system-prompt (rompia el Chatbot QA con carpetas reales).
    var proc = crossSpawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env });
    if (onProcess) onProcess(proc); // permite al caller (ruta HTTP) matarlo si el cliente cancela
    var stdout = '', stderr = '', settled = false;

    proc.stdout.on('data', function(d){ stdout += d.toString(); });
    proc.stderr.on('data', function(d){
      stderr += d.toString();
      process.stderr.write('[claude] ' + d.toString());
    });

    var timer = setTimeout(function(){
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('Claude CLI timeout (8 min).'));
    }, timeoutMs);

    proc.on('error', function(err){
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err); // conserva err.code ('ENOENT', etc.) para el retry por candidato
    });

    proc.on('close', function(code){
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code, stdout: stdout, stderr: stderr });
    });

    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();
  });
}

async function callClaude(prompt, opts) {
  opts = opts || {};
  var timeoutMs   = opts.timeoutMs || 480000;
  var filePath    = opts.filePath || null;
  var imagePaths  = opts.imagePaths || null; // imagenes extraidas de un DOCX (mismo tmp dir)
  var model       = opts.model || 'sonnet'; // 'sonnet' | 'opus' | 'haiku'
  var effort      = opts.effort || null; // 'low'|'medium'|'high'|'xhigh'|'max' -- flag nativo del CLI, no confundir con opts.thinking (hack de ultrathink)
  var thinkingHigh = opts.thinking === 'high';
  // Directorio a habilitar para herramientas de archivo: el del PDF nativo, el que
  // contiene las imagenes extraidas del DOCX, o uno explicito (ej: carpeta de
  // conocimiento del Chatbot QA) via opts.addDir.
  var addDir = opts.addDir || (filePath ? path.dirname(filePath)
             : (imagePaths && imagePaths.length) ? path.dirname(imagePaths[0])
             : null);
  var allowedTools = opts.allowedTools || ['Read']; // ej: ['Read','Grep','Glob'] para el Chatbot QA

  var systemPrompt = opts.systemPrompt || (
    'Eres un agente de analisis QA optimizado para velocidad y precision. ' +
    'Reglas: (1) Si te piden leer archivos, usa la herramienta Read EN PARALELO (todos en un solo bloque) sobre las rutas exactas indicadas. ' +
    '(2) Responde en una sola pasada, sin re-leer ni re-pensar. ' +
    '(3) Sigue el formato de salida solicitado al pie de la letra.' +
    (thinkingHigh ? ' (4) Este encargo requiere razonamiento profundo (ultrathink): dedica tu maximo presupuesto de pensamiento extendido antes de responder, verificando cobertura completa antes de entregar el resultado final.' : '')
  );

  // Presupuesto de pensamiento extendido -- Claude CLI lo activa via env var
  // ademas de la palabra clave "ultrathink" en el prompt (no hay flag de CLI para esto).
  var extraEnv = thinkingHigh ? { MAX_THINKING_TOKENS: '31999' } : null;
  if (thinkingHigh) prompt = 'ultrathink.\n\n' + prompt;

  var args = [
    '--print', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--append-system-prompt', systemPrompt,
    '--permission-mode', 'bypassPermissions',
  ];
  if (effort) args.push('--effort', effort);
  if (addDir) {
    args.push('--allowedTools', allowedTools.join(','), '--add-dir', addDir);
  }

  var candidates = candidateClaudeBins();
  var lastErr = null;

  for (var i = 0; i < candidates.length; i++) {
    var bin = candidates[i];
    console.log('\n-> CLAUDE CLI  bin='+bin+'  model='+model+'  prompt_len='+prompt.length+(addDir?'  addDir='+addDir:''));
    try {
      var result = await spawnClaudeOnce(bin, args, prompt, timeoutMs, extraEnv, opts.onProcess);
      var parsed = parseClaudeStreamJson(result.stdout);
      console.log('<- CLAUDE CLI  rc='+result.code+'  len='+parsed.text.length);

      if (!parsed.text) {
        throw new Error(result.stderr.slice(0, 500) || 'Claude CLI no devolvio respuesta');
      }
      if (parsed.isError || result.code !== 0) {
        var authLike = parsed.apiErrorStatus === 401 ||
          /auth|credential|api key|api-key|unauthorized/i.test(parsed.text + ' ' + parsed.errorCode);
        var msg = authLike
          ? 'Claude CLI no esta autenticado o la sesion expiro. Ejecuta "claude auth login" y reinicia el proxy. Detalle: ' + parsed.text
          : parsed.text;
        throw new Error(msg);
      }
      return parsed.text; // exito
    } catch (e) {
      lastErr = e;
      if (e.code !== 'ENOENT') {
        // Error real (timeout, auth, respuesta vacia, etc.) — no tiene sentido
        // seguir probando otros candidatos de binario, se reporta de una.
        throw e;
      }
      // ENOENT: este candidato no existe/no se encontro; probar el siguiente.
    }
  }

  throw new Error(
    'No se encontro el ejecutable "claude" (Claude CLI) en este equipo. ' +
    'Verifica corriendo "claude --version" en la MISMA terminal donde ejecutas "node proxy.js" ' +
    '(el proxy solo ve el PATH de esa terminal, no el de otras ventanas o apps donde "claude" si funcione). ' +
    'Si ahi tampoco corre, instalalo o agregalo al PATH. Si ya funciona en esa terminal y el error persiste, ' +
    'definí la variable de entorno CLAUDE_CLI_PATH con la ruta completa al ejecutable ' +
    '(ej: set CLAUDE_CLI_PATH=C:\\ruta\\a\\claude.cmd) antes de iniciar el proxy.'
  );
}

// ── Dispatcher de motor IA ────────────────────────────────────────────────────
// Punto unico de entrada para todos los modulos (M1..M7). Elegir motor por
// request deja la puerta abierta a que cada proyecto/cliente use el que prefiera,
// sin tocar el resto del pipeline.
function callAI(prompt, opts) {
  opts = opts || {};
  var engine = (opts.engine === 'claude') ? 'claude' : 'gemini';
  if (engine === 'claude') return callClaude(prompt, opts);
  return callGemini(prompt, opts);
}

// ── Extraer texto + imágenes incrustadas de un DOCX (100% JS, sin binarios externos) ──
// mammoth lee el .docx directamente (es un ZIP con XML adentro) y expone un callback
// por cada imagen incrustada; la escribimos a disco para poder pasarla luego como
// input multimodal a Gemini/Claude, igual que se hace con las capturas de M4.
function htmlToPlainText(html) {
  return html
    .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Import de Plan de Pruebas desde .docx (espejo estructural de
// buildPlanPruebasDocxBuffer) ───────────────────────────────────────────────
// Los encabezados "N. Titulo" usan HeadingLevel.HEADING_1 (mammoth los
// convierte a <h1> reales); los subtitulos "N.N Titulo" son parrafos en
// negrita sin heading real (mammoth los deja como <p><strong>...) -- por eso
// el reconocimiento aca es por TEXTO LITERAL exacto, no por tag. Alcance y
// Responsables usan listas numeradas manuales (texto "N. algo" dentro de un
// <p>, no <ol> real), Supuestos/Riesgos/Criterios y los items de Tipos/Niveles
// SI usan bullet nativo (<ul><li>).
var PLAN_SECTION_MARKERS = [
  '1. Objetivo', '2. Alcance', '2.1 Dentro del Alcance', '2.2 Fuera del Alcance',
  '3. Supuestos', '4. Riesgos', '4.1 Riesgos Funcionales', '4.2 Riesgos de Negocio',
  '5. Estrategia de Pruebas', '6. Tipos y Niveles de Pruebas', '6.1 Tipos de Pruebas',
  '6.2 Niveles de Pruebas', '7. Criterios de Entrada y de Salida',
  '7.1 Criterios de Entrada', '7.2 Criterios de Salida', '8. Responsables',
];
function extractTopLevelBlocks(html) {
  return html.match(/<(h1|h2|h3|p|ul|ol|table)[^>]*>[\s\S]*?<\/\1>/gi) || [];
}
function blockTag(block) {
  var m = /^<(\w+)/.exec(block);
  return m ? m[1].toLowerCase() : '';
}
function blockText(block) {
  return htmlToPlainText(block).replace(/\s+/g, ' ').trim();
}
function extractListItems(block) {
  var items = [];
  var re = /<li[^>]*>([\s\S]*?)<\/li>/gi, m;
  while ((m = re.exec(block))) items.push(htmlToPlainText(m[1]).trim());
  return items.filter(Boolean);
}
function extractTableRows(block) {
  var rows = [];
  var trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, trM;
  while ((trM = trRe.exec(block))) {
    var cells = [], tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, tdM;
    while ((tdM = tdRe.exec(trM[1]))) cells.push(htmlToPlainText(tdM[1]).trim());
    rows.push(cells);
  }
  return rows;
}
function stripLeadingNumber(text) {
  return text.replace(/^\s*\d+\.\s*/, '').trim();
}

function parsePlanDocxHtml(html) {
  var blocks = extractTopLevelBlocks(html);
  var out = {
    objetivo: '', alcanceDentro: [], alcanceFuera: [], supuestos: [],
    riesgosFuncionales: [], riesgosNegocio: [], estrategia: '',
    tiposPrueba: [], nivelesPrueba: [], criteriosEntrada: [], criteriosSalida: [],
    responsables: [],
  };
  var marker = null;
  var namedItemsTarget = null; // 'tiposPrueba' | 'nivelesPrueba' mientras esa subseccion esta activa
  var currentNamedEntry = null;

  blocks.forEach(function(block){
    var tag = blockTag(block);
    var text = tag !== 'ul' && tag !== 'ol' && tag !== 'table' ? blockText(block) : '';

    if (PLAN_SECTION_MARKERS.indexOf(text) !== -1) {
      marker = text;
      namedItemsTarget = (marker === '6.1 Tipos de Pruebas') ? 'tiposPrueba' : (marker === '6.2 Niveles de Pruebas') ? 'nivelesPrueba' : null;
      currentNamedEntry = null;
      return;
    }

    switch (marker) {
      case '1. Objetivo': if (text) out.objetivo = (out.objetivo ? out.objetivo + '\n' : '') + text; break;
      case '2.1 Dentro del Alcance': if (text) out.alcanceDentro.push(stripLeadingNumber(text)); break;
      case '2.2 Fuera del Alcance': if (text) out.alcanceFuera.push(stripLeadingNumber(text)); break;
      case '3. Supuestos': if (tag === 'ul' || tag === 'ol') out.supuestos = out.supuestos.concat(extractListItems(block)); break;
      case '4.1 Riesgos Funcionales': if (tag === 'ul' || tag === 'ol') out.riesgosFuncionales = out.riesgosFuncionales.concat(extractListItems(block)); break;
      case '4.2 Riesgos de Negocio': if (tag === 'ul' || tag === 'ol') out.riesgosNegocio = out.riesgosNegocio.concat(extractListItems(block)); break;
      case '5. Estrategia de Pruebas': if (text) out.estrategia = (out.estrategia ? out.estrategia + '\n' : '') + text; break;
      case '6.1 Tipos de Pruebas':
      case '6.2 Niveles de Pruebas':
        if (namedItemsTarget) {
          if (tag === 'ul' || tag === 'ol') {
            if (currentNamedEntry) currentNamedEntry.items = currentNamedEntry.items.concat(extractListItems(block));
          } else if (text) {
            currentNamedEntry = { nombre: stripLeadingNumber(text), items: [] };
            out[namedItemsTarget].push(currentNamedEntry);
          }
        }
        break;
      case '7.1 Criterios de Entrada': if (tag === 'ul' || tag === 'ol') out.criteriosEntrada = out.criteriosEntrada.concat(extractListItems(block)); break;
      case '7.2 Criterios de Salida': if (tag === 'ul' || tag === 'ol') out.criteriosSalida = out.criteriosSalida.concat(extractListItems(block)); break;
      case '8. Responsables':
        if (tag === 'table') {
          var rows = extractTableRows(block).slice(1); // salta el header
          out.responsables = rows.filter(function(r){ return r.length >= 3; }).map(function(r){
            return { equipo: r[0]||'', cargo: r[1]||'', contacto: r[2]||'' };
          });
        }
        break;
    }
  });
  return out;
}

// ── Import de Historia de Usuario desde .docx (espejo de buildHUDocxBuffer) ──
// A diferencia del Plan de Pruebas, la HU no tiene un S.xxx propio -- toda la
// app (M2-M6) depende de _analysis, el string crudo "---TAG---" que devuelve
// /api/analyze. Por eso este parser no devuelve un objeto de campos sueltos,
// sino que RECONSTRUYE ese mismo formato de texto, para que el cliente lo
// trate exactamente como una respuesta real de analisis (mismo renderAnalysis,
// mismo reset de todo lo demas que ya ocurre en un analisis nuevo).
var HU_LABELED_SECTIONS = [
  { marker: '3. Criterios de Aceptación', tag: 'CRITERIOS_DE_ACEPTACION' },
  { marker: '4. Reglas de Negocio', tag: 'REGLAS_DE_NEGOCIO' },
  { marker: '5. Riesgos', tag: 'RIESGOS' },
  { marker: '6. Impactos', tag: 'IMPACTOS' },
  { marker: '7. Escenarios QA Sugeridos', tag: 'ESCENARIOS_QA' },
];
function labeledBulletsToRawLines(items) {
  return items.map(function(text){
    var m = /^([A-Z_0-9]+):\s*(.*)/.exec(text);
    return m ? (m[1] + ' | ' + m[2]) : text;
  }).join('\n');
}
function parseHUDocxHtml(html) {
  var blocks = extractTopLevelBlocks(html);
  var out = { como:'', quiero:'', para:'', nivel:'', justificacion:'', sections: {} };
  HU_LABELED_SECTIONS.forEach(function(s){ out.sections[s.tag] = []; });
  var marker = null; // '1'|'2'|tag de HU_LABELED_SECTIONS|null
  var nivelHeadingRe = /^2\.\s*Nivel de Riesgo Global:\s*(.*)$/i;

  blocks.forEach(function(block){
    var tag = blockTag(block);
    var text = (tag === 'ul' || tag === 'ol' || tag === 'table') ? '' : blockText(block);

    if (tag === 'h1' && text === '1. Historia de Usuario') { marker = '1'; return; }
    var nivelM = tag === 'h1' ? nivelHeadingRe.exec(text) : null;
    if (nivelM) { out.nivel = nivelM[1].trim(); marker = '2'; return; }
    var labeled = HU_LABELED_SECTIONS.find(function(s){ return tag === 'h1' && text === s.marker; });
    if (labeled) { marker = labeled.tag; return; }

    if (marker === '1') {
      var m = /^(Como|Quiero|Para):\s*(.*)/i.exec(text);
      if (m) out[m[1].toLowerCase()] = m[2].trim();
    } else if (marker === '2') {
      if (text) out.justificacion = (out.justificacion ? out.justificacion + '\n' : '') + text;
    } else if (marker && out.sections[marker] !== undefined && (tag === 'ul' || tag === 'ol')) {
      out.sections[marker] = out.sections[marker].concat(extractListItems(block));
    }
  });

  var paraLimpio = (out.para||'---').replace(/\.\s*$/, '');
  var huLine = 'Como ' + (out.como||'---') + ', quiero ' + (out.quiero||'---') + ', para ' + paraLimpio + '.';
  var raw = '---HISTORIA_DE_USUARIO---\n' + huLine + '\n' +
    '---NIVEL_RIESGO_GLOBAL---\n' + (out.nivel||'MEDIO') + '\n' +
    '---JUSTIFICACION_RIESGO---\n' + (out.justificacion||'---') + '\n';
  HU_LABELED_SECTIONS.forEach(function(s){
    raw += '---' + s.tag + '---\n' + labeledBulletsToRawLines(out.sections[s.tag]) + '\n';
  });
  return raw;
}

async function extractDocx(docxPath) {
  var imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-img-'));
  var imagePaths = [];
  var imgIdx = 0;

  var result = await mammoth.convertToHtml(
    { path: docxPath },
    { convertImage: mammoth.images.imgElement(function(image) {
        return image.read().then(function(buffer) {
          imgIdx++;
          var subtype = (image.contentType || 'image/png').split('/')[1] || 'png';
          var imgPath = path.join(imgDir, 'img_' + String(imgIdx).padStart(3, '0') + '.' + subtype);
          fs.writeFileSync(imgPath, buffer);
          imagePaths.push(imgPath);
          return { src: '' }; // no hace falta el data-URI en el HTML, ya la guardamos en disco
        });
      })
    }
  );

  var text = htmlToPlainText(result.value);
  if (!imagePaths.length) {
    try { fs.rmdirSync(imgDir); } catch (e) {}
  }
  return { text: text, imagePaths: imagePaths, imgDir: imagePaths.length ? imgDir : null };
}

// ── Bloque de secciones de salida, compartido por el prompt de analisis ───────
function outputSectionsBlock() {
  return [
    '---HISTORIA_DE_USUARIO---',
    'Formato: Como [rol especifico], quiero [accion concreta], para [beneficio medible].',
    '',
    '---NIVEL_RIESGO_GLOBAL---',
    'Una sola palabra: ALTO, MEDIO o BAJO. Evalua objetivamente.',
    '',
    '---JUSTIFICACION_RIESGO---',
    '3 a 5 oraciones especificas con elementos concretos del requerimiento.',
    '',
    '---CRITERIOS_DE_ACEPTACION---',
    'Minimo 6. Formato por linea: CA_N | Dado que [contexto], Cuando [accion], Entonces [resultado verificable].',
    '',
    '---REGLAS_DE_NEGOCIO---',
    'Minimo 4. Formato por linea: RN_N | Descripcion tecnica especifica con condiciones.',
    '',
    '---RIESGOS---',
    'Minimo 4. Formato: R_N | Alto/Medio/Bajo | Descripcion | Impacto concreto.',
    '',
    '---IMPACTOS---',
    'Formato: AREA | Descripcion del impacto tecnico y funcional.',
    '',
    '---ESCENARIOS_QA---',
    'Minimo 6. Formato: ESC_N | Positivo/Negativo/Borde | Titulo | Descripcion con datos de prueba.',
  ].join('\n');
}

// ── Build prompt: analisis de requerimiento (M1), 1 o VARIOS archivos mezclados ──
// Reemplaza los 3 builders viejos (texto plano / PDF vision / DOCX+imagenes) por
// uno solo que soporta cualquier combinacion: cada archivo llega ya normalizado
// por /api/upload como {mode:'native'|'text'|'text-images', filePath?, text?,
// imagePaths?, filename}. Los PDF (mode 'native') se referencian por ruta para que
// el motor los lea con su herramienta de lectura de archivos; el texto de
// DOCX/TXT se embebe directo; las imagenes incrustadas de un DOCX tambien se
// referencian por ruta -- todo en UN solo bloque de lectura, ambos motores por igual.
function buildMultiFileAnalysisPrompt(files, engine) {
  var fileRefLines = [];
  files.forEach(function(f){
    if (f.mode === 'native') {
      fileRefLines.push(f.filePath + '  [PDF -- ' + (f.filename || 'documento') + ']');
    } else {
      // El texto NUNCA se embebe inline en el prompt -- /api/analyze ya lo volco a
      // un .txt temporal (f._textFilePath) antes de llamar esta funcion. Con un solo
      // archivo chico el inline nunca daba problema, pero con varios archivos (o uno
      // largo) el prompt total crecia lo suficiente para que agy.exe (recibe el
      // prompt como argumento de linea de comandos, no por stdin) tirara
      // "spawn ENAMETOOLONG" en Windows -- referenciar por ruta mantiene el prompt
      // corto sin importar cuantos archivos o que tan largos sean.
      if (f._textFilePath) fileRefLines.push(f._textFilePath + '  [texto extraido de ' + (f.filename || 'documento') + ']');
      (f.imagePaths || []).forEach(function(p){
        fileRefLines.push(p + '  [imagen incrustada en ' + (f.filename || 'documento') + ']');
      });
    }
  });
  var refBlock = fileRefLines.length
    ? 'Usa tu herramienta de lectura de archivos EN PARALELO sobre estas ' + fileRefLines.length + ' ruta(s) exactas antes de responder:\n' +
      fileRefLines.map(function(l, i){ return (i+1) + '. ' + l; }).join('\n')
    : '';
  var multi = files.length > 1;
  return [
    'Eres un Analista de Requerimientos senior con mas de 15 anios de experiencia en proyectos de software empresarial.',
    multi
      ? 'A continuacion tienes ' + files.length + ' archivos que en conjunto conforman UN MISMO requerimiento (ej: el documento ' +
        'principal + anexos + una transcripcion de reunion). Leelos TODOS integralmente -- texto, imagenes, tablas, diagramas, ' +
        'wireframes, cualquier contenido visual -- y trata su contenido como UNA sola fuente de verdad combinada, no como ' +
        'requerimientos independientes.'
      : 'A continuacion tienes un documento de requerimiento. Leelo integralmente, incluyendo todo el texto, imagenes, tablas, ' +
        'diagramas, wireframes y cualquier contenido visual.',
    'Comprende el requerimiento en su totalidad, incluyendo lo implicito, y produce un analisis tecnico objetivo, detallado y accionable.',
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. NO uses plantillas genericas ni frases de relleno.',
    '2. NO asumas que el riesgo siempre es ALTO. Evalua el riesgo real basandote en: complejidad tecnica, integracion de',
    '   sistemas, impacto financiero/operativo, usuarios afectados, reversibilidad, dependencias externas, cobertura de datos.',
    '3. TODOS los criterios de aceptacion deben ser verificables, medibles y especificos.',
    '4. Las reglas de negocio deben surgir de los documentos, no inventarse.',
    '5. COBERTURA EXHAUSTIVA, sin techo: en Criterios de Aceptacion, Reglas de Negocio, Riesgos y Escenarios QA, el "Minimo" que',
    '   pide cada seccion es un PISO para documentos escuetos, no una meta a cumplir y detenerte ahi. Identifica y lista CADA',
    '   condicion, regla, riesgo o escenario atomico y verificable que el documento (y sus anexos/transcripciones si los hay)',
    '   permita sustentar, sin importar si terminan siendo 6 o 30 -- la cantidad la determina lo que el requerimiento realmente',
    '   contiene, no un numero comodo. No agrupes dos aserciones verificables distintas bajo un mismo ID (CA_N/RN_N/R_N/ESC_N)',
    '   solo para reducir la cantidad total -- cada ID debe quedar centrado en UNA sola condicion verificable. Solo evita',
    '   duplicar literalmente la misma asercion dos veces.',
    multi
      ? '6. Si dos archivos se contradicen entre si, prioriza el mas especifico o mas reciente (ej: una transcripcion de reunion ' +
        'posterior prevalece sobre el documento inicial) y menciona la discrepancia en la justificacion de riesgo si es relevante.'
      : null,
    (multi ? '7' : '6') + '. Responde UNICAMENTE con las secciones delimitadas. Sin texto adicional.',
    '',
    refBlock,
    '',
    outputSectionsBlock(),
  ].filter(function(l){ return l !== null; }).join('\n');
}

// ── Build prompt: Escenarios y Casos QA ────────────────────────────────────────
// Toma el analisis crudo de M1 (todas sus secciones) + la configuracion que el
// QA confirmo en M2 (notas/areas validadas) y pide los casos
// en el formato exacto de la plantilla real de TestIALab (ver handoff).
function buildCasesPrompt(analysisRaw, m2Context, engine, transcripts) {
  m2Context = m2Context || {};
  var areas = (m2Context.impactAreas || []).filter(function(a){ return a.checked; })
    .map(function(a){ return a.label + (a.desc ? ': ' + a.desc : ''); }).join('\n') || 'Ninguna area especifica marcada.';
  var transcriptsBlock = (transcripts && transcripts.length)
    ? [
        '',
        'TRANSCRIPCIONES ADICIONALES (reuniones posteriores al analisis inicial -- el requerimiento pudo',
        'cambiar desde la primera reunion de contextualizacion; si algo aqui contradice o amplia el analisis',
        'de arriba, esta informacion mas reciente tiene prioridad):',
        transcripts.map(function(t){ return '--- ' + t.filename + ' ---\n' + t.text; }).join('\n\n'),
      ].join('\n')
    : '';
  return [
    'Eres un Disenador de Casos de Prueba QA senior con mas de 15 anios de experiencia.',
    'Con base en el analisis de requerimiento (Historia de Usuario, Criterios de Aceptacion, Reglas de Negocio,',
    'Riesgos, Escenarios QA sugeridos) y la configuracion definida por el QA, genera los CASOS DE PRUEBA detallados.',
    '',
    'ANALISIS DEL REQUERIMIENTO:',
    analysisRaw,
    transcriptsBlock,
    '',
    'CONFIGURACION DEFINIDA POR EL QA:',
    'Areas de impacto validadas:',
    areas,
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Cobertura OBLIGATORIA sin excepcion: TODOS los criterios de aceptacion (CA_N) y TODAS las reglas de negocio (RN_N)',
    '   listados en el analisis deben quedar cubiertos por al menos un caso de prueba. No omitas ninguno.',
    '2. La columna "Requisito Funcional" de cada caso debe citar el/los ID(s) exactos que ese caso cubre (ej: "CA_1, RN_2").',
    '3. CASOS NEGATIVOS Y DE BORDE SON OBLIGATORIOS, no opcionales: (a) TODO escenario QA del analisis con tipo Negativo o',
    '   Borde debe quedar convertido en al menos un caso de prueba -- no te limites a "priorizarlos", conviertelos TODOS,',
    '   sin excepcion. (b) Ademas, para cada CA_N/RN_N que describa un filtro, un parametro de busqueda/ejecucion, o un',
    '   campo mencionado como obligatorio, genera tambien el/los casos negativos/borde correspondientes aunque el analisis',
    '   no los haya sugerido como escenario aparte -- como minimo, cuando aplique segun el contexto: "ejecutar/consultar sin',
    '   diligenciar ese filtro", "filtro valido pero sin resultados/datos asociados", y "campo obligatorio vacio o no',
    '   diligenciado". No los dejes como responsabilidad implicita del QA que ejecuta despues -- si el requerimiento tiene',
    '   un filtro o un campo obligatorio, el caso negativo correspondiente tiene que existir explicitamente en el set.',
    '   Incluye tambien casos de los otros 3 tipos (Smoke, Funcional, UI/UX) que aplican en TestIALab.',
    '   (c) Ademas, dos tipos de caso adicionales son obligatorios cuando aplican, aunque el analisis no los sugiera como',
    '   escenario aparte: primero, si un CA_N/RN_N define un CONJUNTO configurable de elementos que el sistema debe',
    '   mostrar/procesar (columnas de un reporte, campos de un filtro, opciones seleccionadas, etc.), genera un caso que',
    '   valide el CONJUNTO EXACTO -- no solo que los elementos esperados esten presentes, sino tambien que no aparezca',
    '   NINGUN elemento adicional no configurado (ni de mas, ni de menos). Segundo, si un CA_N/RN_N describe que un',
    '   registro/reporte HEREDA, REMAPEA o COPIA campos desde un documento/registro origen hacia un destino, genera un',
    '   caso de AUDITORIA CAMPO POR CAMPO dedicado que compare TODOS los campos remapeados contra el origen de uno en',
    '   uno -- esto es distinto y adicional a los casos que ya validan campos especificos por separado; cubre el remapeo',
    '   completo como unidad, no reemplaza a esos otros casos. IMPORTANTE: estas dos reglas se aplican POR CADA CA_N/RN_N',
    '   que las cumpla, no una sola vez para todo el requerimiento. Si el requerimiento tiene VARIOS flujos, modulos o',
    '   tipos de registro distintos que cada uno hace su propio remapeo/herencia de campos o define su propio conjunto',
    '   configurable (ej: un flujo de venta Y un flujo de transferencia, cada uno con su propia configuracion), un solo',
    '   caso para uno de ellos NO cubre al otro -- genera el caso de conjunto exacto y/o el de auditoria campo por campo',
    '   PARA CADA flujo/modulo que lo requiera, de forma simetrica. No asumas que aplicar la regla una vez ya la satisface',
    '   para el resto del requerimiento.',
    '4. COBERTURA SIN COMPACTAR: no hay numero minimo ni maximo de casos -- la cantidad la determina unicamente lo que el',
    '   analisis necesita cubrir, no un objetivo de "ser breve". NO fusiones validaciones distintas en un solo caso grande',
    '   solo para reducir la cantidad total; cada caso debe seguir centrado en UN objetivo de prueba claro. Variantes',
    '   distintas de un mismo flujo (camino feliz, dato invalido, campo vacio, limite de caracteres, rol sin permiso,',
    '   valor limite, etc.) NO son redundantes entre si -- van como casos separados. Solo evita la REDUNDANCIA real:',
    '   dos casos que terminarian validando exactamente lo mismo (mismos pasos, mismo objetivo, mismo resultado esperado),',
    '   esos si fusionalos o elimina el duplicado. Cada caso debe aportar cobertura que ningun otro caso ya aporta.',
    '   SENAL DE ALERTA: si un caso termina citando 3 o mas IDs (CA_N/RN_N) distintos, detente y revisalo antes de',
    '   continuar -- en la gran mayoria de los casos eso significa que en realidad son 2 o 3 casos distintos que deberias',
    '   separar. Fusionar 3 o mas IDs en un solo caso solo se justifica cuando son literalmente inseparables en una unica',
    '   ejecucion (ej: dos validaciones que ocurren en el mismo paso y no pueden probarse por separado sin repetir todo el',
    '   flujo). Si tienes duda, separa -- el costo de un caso de mas es menor que el de perder trazabilidad clara.',
    '5. Cada paso a paso debe ser ejecutable por un QA sin conocimiento previo del sistema.',
    '6. El resultado esperado debe ser verificable, no ambiguo.',
    '7. NO inventes datos de negocio que no esten en el analisis. Esto aplica en especial a VALORES concretos (correos,',
    '   nombres, IDs, montos, fechas puntuales): si el analisis no especifica un valor exacto para un campo, describe la',
    '   ACCION de forma generica orientada a la funcionalidad, no un dato inventado. MAL: "Ingresar pepitoperez@correo.com',
    '   y la clave Clave123". BIEN: "Ingresar un correo corporativo valido y la contrasena correcta en los campos',
    '   respectivos". Usa un valor literal UNICAMENTE cuando (a) el analisis lo menciona explicitamente, o (b) el objetivo',
    '   del caso es validar ese dato exacto (ej: "el campo debe rechazar un correo con formato invalido", "el sistema debe',
    '   truncar el ID a 10 caracteres") -- ahi si el dato especifico ES la funcionalidad bajo prueba. Esto no debe bajar la',
    '   calidad del caso: sigue siendo tan detallado y ejecutable como antes, solo evita fabricar datos que despues no',
    '   coincidiran con la evidencia real que suba el QA.',
    '8. Antes de responder, verifica internamente TODO lo siguiente y corrige lo que falte:',
    '   (a) Cada CA_N y RN_N del analisis aparece citado en al menos un caso -- si falta alguno, agrega el caso que lo cubra.',
    '   (b) Cada escenario QA de tipo Negativo o Borde del analisis quedo convertido en al menos un caso -- si falta alguno, agregalo.',
    '   (c) Cada filtro/parametro de ejecucion y cada campo obligatorio mencionado en el analisis tiene su caso negativo/borde',
    '   correspondiente (sin diligenciar, sin resultados, vacio) segun aplique -- si falta, agregalo.',
    '   (d) Ningun caso quedo citando 3 o mas IDs sin que sea una inseparabilidad real -- si encuentras uno, separalo en 2-3 casos.',
    '   (e) No hay dos casos redundantes entre si (misma validacion exacta) -- si los hay, fusionalos.',
    '   (f) Cada CA_N/RN_N que define un conjunto configurable de elementos tiene su caso de "conjunto exacto" (ni de mas ni',
    '   de menos) -- si hay VARIOS flujos/modulos distintos que cada uno define su propio conjunto, cada uno tiene el suyo,',
    '   no solo el primero -- si falta alguno, agregalo.',
    '   (g) Cada CA_N/RN_N que describe un remapeo/herencia de campos entre documentos tiene su caso de auditoria campo por',
    '   campo contra el origen -- si hay VARIOS flujos/modulos distintos que cada uno hace su propio remapeo (ej: venta Y',
    '   transferencia), cada uno tiene el suyo, no solo el primero -- si falta alguno, agregalo.',
    '9. Responde UNICAMENTE con la seccion delimitada. Sin texto adicional.',
    '',
    '---CASOS_DE_PRUEBA---',
    'Minimo 8 casos. Formato EXACTO -- un bloque por caso, cada campo en su propia linea. NINGUN campo es opcional,',
    'ni siquiera en casos con un paso a paso muy largo: Tipo y Complejidad SIEMPRE van presentes en TODOS los casos,',
    'sin excepcion, sin importar cuantos casos generes ni que tan extenso sea el paso a paso de cada uno.',
    '### CP_1',
    'Requisito: CA_1, RN_2',
    'Tipo: Smoke',
    'Complejidad: Bajo',
    'Escenario: nombre corto del escenario QA que cubre',
    'Caso: titulo corto del caso',
    'Objetivo: una frase que describe que se valida',
    'Pasos:',
    '1. Ingresar al modulo X >> Se muestra el formulario',
    '2. Seleccionar Y >> Y queda resaltado',
    '3. Confirmar >> Se registra la transaccion',
    '### CP_2',
    '(...siguiente caso, mismo formato...)',
    'Donde: ID=CP_N correlativo. Tipo=UNICAMENTE uno de: Smoke, Funcional, UI, UX (no uses otros valores).',
    'Complejidad de EJECUCION de ese caso especifico (cuantos pasos/validaciones/dependencias tiene) = UNICAMENTE Alto, Medio o Bajo.',
    'Requisito=ID(s) exacto(s) de CA_N/RN_N que este caso cubre.',
    'Pasos=una linea por paso, "N. Texto del paso >> Resultado esperado especifico" -- cada paso debe tener su propio',
    'resultado esperado verificable, distinto del de los demas pasos. No fusiones varios pasos en una sola linea.',
  ].join('\n');
}

// ── Build prompt: Verificacion REAL de cobertura RF/CA (M4) ───────────────────
// El cruce por defecto en el frontend es solo texto (indexOf del ID dentro del
// campo "Requisito Funcional" de cada caso) -- esto le pide a la IA verificar
// SEMANTICAMENTE si el paso a paso de los casos citados de verdad valida cada
// CA_N/RN_N, no solo si lo mencionan.
function buildCoverageVerificationPrompt(analysisRaw, cases) {
  var casesText = (cases || []).map(function(c){
    var pasos = (c.steps || []).map(function(s, i){ return (i+1)+'. '+s.paso+' -> '+s.resultado; }).join(' / ') || '(sin pasos)';
    return c.id + ' | Requisito citado: ' + (c.requisito||'-') + ' | Objetivo: ' + (c.objetivo||'-') + ' | Pasos: ' + pasos;
  }).join('\n');
  return [
    'Eres un QA Lead senior auditando si un set de casos de prueba REALMENTE cubre cada Criterio de Aceptacion (CA_N)',
    'y Regla de Negocio (RN_N) de un requerimiento -- no si solo lo MENCIONAN en su campo "Requisito Funcional".',
    '',
    'ANALISIS DEL REQUERIMIENTO (contiene las secciones CRITERIOS_DE_ACEPTACION y REGLAS_DE_NEGOCIO a verificar):',
    analysisRaw,
    '',
    'CASOS DE PRUEBA A AUDITAR:',
    casesText,
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Para CADA CA_N y RN_N del analisis, evalua si el paso a paso de los casos que lo citan REALMENTE verifica ese',
    '   criterio/regla especifico -- no basta con que el caso mencione el ID, los pasos deben demostrar la validacion.',
    '2. Si un caso cita un ID pero sus pasos no verifican nada relacionado con ese criterio, marcalo como NO cubierto.',
    '3. Se honesto: no marques 100% de cobertura si no es real. TestiAlab necesita saber la verdad, no un numero bonito.',
    '4. Responde UNICAMENTE con la seccion delimitada. Sin texto adicional.',
    '',
    '---COBERTURA_VERIFICADA---',
    'Un renglon por CADA CA_N/RN_N del analisis (todos, sin omitir ninguno), formato exacto (4 columnas separadas por "|"):',
    'ID | SI o NO (cubierto de verdad) | IDs de casos que lo cubren de verdad (separados por coma, o vacio si NO) | Justificacion breve (1 frase)',
  ].join('\n');
}

// ── Build prompt: Generar SOLO los casos faltantes de una verificacion de cobertura ──
// Se dispara desde el boton "Generar casos para lo faltante" en Escenarios y Casos QA,
// una vez que /api/verify-coverage ya identifico que CA_N/RN_N especificos no estan
// realmente cubiertos. A diferencia de buildCasesPrompt (que genera el set completo
// desde cero), este prompt esta acotado a esos gaps puntuales y conoce los casos ya
// existentes para no duplicar validaciones -- doble chequeo de seguridad para el QA,
// no una regeneracion completa.
function buildGapCasesPrompt(analysisRaw, existingCases, gapItems, m2Context, engine) {
  m2Context = m2Context || {};
  var areas = (m2Context.impactAreas || []).filter(function(a){ return a.checked; })
    .map(function(a){ return a.label + (a.desc ? ': ' + a.desc : ''); }).join('\n') || 'Ninguna area especifica marcada.';
  var existingText = (existingCases || []).map(function(c){
    var pasos = (c.steps || []).map(function(s){ return s.paso; }).join(' / ') || '(sin pasos)';
    return c.id + ' | Requisito: ' + (c.requisito||'-') + ' | Caso: ' + (c.caso||'-') + ' | Pasos: ' + pasos;
  }).join('\n') || '(no hay casos existentes)';
  var gapsText = (gapItems || []).map(function(g){
    return g.id + ' -- ' + (g.justificacion || 'No cubierto por ningun caso existente.');
  }).join('\n');
  var lastNum = 0;
  (existingCases || []).forEach(function(c){
    var m = /CP_(\d+)/.exec(c.id||''); if (m) lastNum = Math.max(lastNum, parseInt(m[1],10));
  });
  return [
    'Eres un Disenador de Casos de Prueba QA senior con mas de 15 anios de experiencia.',
    'Un set de casos de prueba YA fue generado para este requerimiento, y una auditoria de cobertura real con IA',
    'encontro que los siguientes Criterios de Aceptacion (CA_N) / Reglas de Negocio (RN_N) NO estan realmente',
    'cubiertos por ningun caso existente. Tu unica tarea es generar los casos ADICIONALES necesarios para cerrar',
    'exactamente esos gaps -- nada mas.',
    '',
    'ANALISIS DEL REQUERIMIENTO:',
    analysisRaw,
    '',
    'CONFIGURACION DEFINIDA POR EL QA:',
    'Areas de impacto validadas:',
    areas,
    '',
    'CASOS YA EXISTENTES (NO los repitas, NO los regeneres, NO valides de nuevo lo que ya validan):',
    existingText,
    '',
    'CA_N / RN_N QUE FALTAN POR CUBRIR (justificacion de la auditoria de cobertura):',
    gapsText,
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Genera SOLAMENTE los casos necesarios para cubrir los items listados arriba como faltantes. No generes casos',
    '   adicionales para cosas que los casos existentes ya cubren.',
    '2. Si dos de los items faltantes se pueden cubrir con un solo caso robusto, hazlo asi -- no generes casos triviales',
    '   que se solapan entre si.',
    '3. La columna "Requisito Funcional" de cada caso debe citar el/los ID(s) exacto(s) que cubre.',
    '4. Cada paso a paso debe ser ejecutable por un QA sin conocimiento previo del sistema, con resultado esperado',
    '   verificable.',
    '5. NO inventes datos de negocio que no esten en el analisis. Esto aplica en especial a VALORES concretos (correos,',
    '   nombres, IDs, montos, fechas puntuales): si el analisis no especifica un valor exacto para un campo, describe la',
    '   ACCION de forma generica orientada a la funcionalidad, no un dato inventado. MAL: "Ingresar pepitoperez@correo.com',
    '   y la clave Clave123". BIEN: "Ingresar un correo corporativo valido y la contrasena correcta en los campos',
    '   respectivos". Usa un valor literal UNICAMENTE cuando (a) el analisis lo menciona explicitamente, o (b) el objetivo',
    '   del caso es validar ese dato exacto -- ahi si el dato especifico ES la funcionalidad bajo prueba. Esto no debe',
    '   bajar la calidad del caso, solo evitar fabricar datos que despues no coincidiran con la evidencia real.',
    '6. Responde UNICAMENTE con la seccion delimitada. Sin texto adicional.',
    '',
    '---CASOS_DE_PRUEBA---',
    'Formato EXACTO -- un bloque por caso, cada campo en su propia linea. Tipo y Complejidad SIEMPRE van presentes',
    'en TODOS los casos, sin excepcion, sin importar que tan extenso sea el paso a paso de cada uno.',
    '### CP_'+(lastNum+1),
    'Requisito: CA_1, RN_2',
    'Tipo: Smoke',
    'Complejidad: Bajo',
    'Escenario: nombre corto del escenario QA que cubre',
    'Caso: titulo corto del caso',
    'Objetivo: una frase que describe que se valida',
    'Pasos:',
    '1. Ingresar al modulo X >> Se muestra el formulario',
    '2. Seleccionar Y >> Y queda resaltado',
    '### CP_'+(lastNum+2),
    '(...siguiente caso, mismo formato, continuando la numeracion correlativa desde CP_'+(lastNum+1)+'...)',
    'Tipo=UNICAMENTE uno de: Smoke, Funcional, UI, UX. Complejidad de EJECUCION = UNICAMENTE Alto, Medio o Bajo.',
    'Pasos=una linea por paso, "N. Texto del paso >> Resultado esperado especifico", cada uno con su propio resultado.',
  ].join('\n');
}

// ── Build prompt: Complejidad del requerimiento (Estimador QA) ────────────────
// Portado del "Estimador de tiempos QA" original de TestIALab (LIZ) -- clasifica
// la complejidad GENERAL del requerimiento para efectos de estimacion de esfuerzo.
function buildComplexityPrompt(analysisRaw) {
  return [
    'Eres un analista de QA senior. Evalua la complejidad GENERAL de este requerimiento para efectos de',
    'estimacion de esfuerzo de pruebas de QA (reglas de negocio, integraciones, plataformas afectadas,',
    'ambiguedad, dependencias tecnicas).',
    '',
    'ANALISIS DEL REQUERIMIENTO:',
    analysisRaw,
    '',
    'Responde UNICAMENTE con las secciones delimitadas. Sin texto adicional.',
    '',
    '---COMPLEJIDAD_REQUERIMIENTO---',
    'Una sola palabra: Alto, Medio o Bajo.',
    '',
    '---JUSTIFICACION_COMPLEJIDAD---',
    '2 a 3 oraciones especificas del requerimiento.',
  ].join('\n');
}


// ── Build prompt: Plan de Pruebas ─────────────────────────────────────────────
// Estructura del ejemplo real de TestIALab (Totto): Objetivo, Alcance dentro/fuera,
// Supuestos, Riesgos funcionales/negocio, Estrategia, Tipos/Niveles, Criterios
// de entrada/salida, Responsables. Se genera al inicio del ciclo, antes de los casos.
function buildPlanPruebasPrompt(analysisRaw, m2Context, engine) {
  m2Context = m2Context || {};
  return [
    'Eres un Lider de QA senior redactando un Plan de Pruebas formal para un cliente, siguiendo el formato',
    'estandar de la empresa (Objetivo, Alcance, Supuestos, Riesgos, Estrategia, Tipos y Niveles de Prueba,',
    'Criterios de Entrada/Salida, Responsables).',
    '',
    'ANALISIS DEL REQUERIMIENTO (base para el plan):',
    analysisRaw,
    '',
    'CONFIGURACION DEFINIDA POR EL QA:',
    'Notas/criterios de salida: ' + (m2Context.notes || '(sin notas)'),
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Redacta en prosa profesional, especifica al requerimiento -- nada generico.',
    '2. El alcance dentro/fuera debe surgir del analisis, no inventarse. Este documento lo lee el usuario final para su',
    '   aprobacion -- CERO informacion inventada. Si un dato no esta en el analisis, no lo afirmes con certeza.',
    '3. Los riesgos funcionales y de negocio deben ser distintos entre si y concretos.',
    '4. NO menciones en ningun lado que la ejecucion de pruebas usa o se apoya en inteligencia artificial -- este',
    '   documento describe el plan de QA hacia el cliente, no la herramienta interna que usa TestiAlab.',
    '5. Tipos y Niveles de prueba: usa UNICAMENTE los definidos abajo, en ese orden exacto -- son los unicos que',
    '   usa TestiAlab hoy, no agregues ni inventes otros.',
    '6. Responde UNICAMENTE con las secciones delimitadas. Sin texto adicional.',
    '',
    '---OBJETIVO---',
    '1 a 2 parrafos.',
    '',
    '---ALCANCE_DENTRO---',
    'Lista de items dentro del alcance, uno por linea con "- ".',
    '',
    '---ALCANCE_FUERA---',
    'Lista de items fuera del alcance, uno por linea con "- ".',
    '',
    '---SUPUESTOS---',
    'Lista de supuestos, uno por linea con "- ".',
    '',
    '---RIESGOS_FUNCIONALES---',
    'Minimo 3. Uno por linea con "- ".',
    '',
    '---RIESGOS_NEGOCIO---',
    'Minimo 2. Uno por linea con "- ".',
    '',
    '---ESTRATEGIA---',
    '1 a 2 parrafos describiendo el enfoque de pruebas (ciclos, regresion, ambientes) -- sin mencionar herramientas ni IA.',
    '',
    '---TIPOS_PRUEBA---',
    'EXACTAMENTE estos 4 tipos, en este orden, cada uno con 2-4 puntos concretos de ESTE requerimiento (formato: Nombre | punto 1 / punto 2):',
    'Pruebas funcionales | ...',
    'Pruebas de integracion | ...',
    'Pruebas negativas | ...',
    'Pruebas de regresion focalizada | ...',
    '',
    '---NIVELES_PRUEBA---',
    'EXACTAMENTE estos 3 niveles, en este orden, cada uno con 1-3 puntos concretos de ESTE requerimiento (formato: Nombre | punto 1 / punto 2):',
    'Pruebas de sistema | ...',
    'Pruebas de integracion | ...',
    'Pruebas de aceptacion (UAT) | ...',
    '',
    '---CRITERIOS_ENTRADA---',
    'Lista de criterios de entrada, uno por linea con "- ".',
    '',
    '---CRITERIOS_SALIDA---',
    'Lista de criterios de salida, uno por linea con "- ".',
  ].join('\n');
}

// ── Generador de docx real del Plan de Pruebas ─────────────────────────────────
// Replica la estructura exacta de la plantilla real de TestIALab (Totto/Dafiti):
// encabezado Proyecto/Version/Fecha, secciones numeradas 1-8 con subsecciones en
// negrita, listas numeradas y con vinetas, tabla de Responsables, logo arriba.
// El contenido siempre sale de lo que la IA genero para ESTE requerimiento
// (nunca texto fijo de la plantilla) -- solo se toma el FORMATO de la plantilla.
var DOCX_TEAL = '0F9B82';
var DOCX_NAVY = '1A2E44';
var DOCX_FONT = 'Calibri'; // fuente real de la plantilla (confirmada en footer1.xml del docx original)

function docxHeading(numberedTitle) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 280, after: 120 },
    children: [ new TextRun({ text: numberedTitle, bold: true, size: 26, color: DOCX_NAVY, font: DOCX_FONT }) ],
  });
}
function docxSubheading(title) {
  return new Paragraph({
    spacing: { before: 180, after: 80 },
    children: [ new TextRun({ text: title, bold: true, size: 22, color: DOCX_TEAL, font: DOCX_FONT }) ],
  });
}
function docxPara(text) {
  return new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 },
    children: [ new TextRun({ text: text || '---', size: 21, font: DOCX_FONT }) ] });
}
function docxBullet(text) {
  return new Paragraph({ alignment: AlignmentType.JUSTIFIED, bullet: { level: 0 }, spacing: { after: 40 },
    children: [ new TextRun({ text: text, size: 21, font: DOCX_FONT }) ] });
}
function docxNumbered(text, n) {
  return new Paragraph({ alignment: AlignmentType.JUSTIFIED, indent: { left: 300 }, spacing: { after: 40 },
    children: [ new TextRun({ text: n + '. ' + text, size: 21, font: DOCX_FONT }) ] });
}
function docxBulletList(items) {
  if (!items || !items.length) return [ docxPara('---') ];
  return items.map(function(t){ return docxBullet(t); });
}
function docxNumberedList(items) {
  if (!items || !items.length) return [ docxPara('---') ];
  return items.map(function(t, i){ return docxNumbered(t, i+1); });
}
function docxNamedItemsBlock(list) {
  var out = [];
  (list || []).forEach(function(entry, i){
    out.push(new Paragraph({ spacing: { before: 100, after: 40 }, children: [ new TextRun({ text: (i+1)+'. '+entry.nombre, bold: true, size: 21, font: DOCX_FONT }) ] }));
    (entry.items || []).forEach(function(it){ out.push(docxBullet(it)); });
  });
  if (!out.length) out.push(docxPara('---'));
  return out;
}
function docxCell(text, opts) {
  opts = opts || {};
  return new TableCell({
    width: { size: opts.width || 33, type: WidthType.PERCENTAGE },
    shading: opts.header ? { type: ShadingType.CLEAR, fill: DOCX_NAVY } : undefined,
    children: [ new Paragraph({ children: [ new TextRun({ text: text || '', bold: !!opts.header, color: opts.header ? 'FFFFFF' : undefined, size: 20, font: DOCX_FONT }) ] }) ],
  });
}
function docxResponsablesTable(rows) {
  var header = new TableRow({ children: [
    docxCell('Equipo', {header:true}), docxCell('Cargo / Rol', {header:true}), docxCell('Contacto', {header:true}),
  ]});
  var body = (rows && rows.length ? rows : [{equipo:'Por definir',cargo:'Por definir',contacto:'Por definir'}]).map(function(r){
    return new TableRow({ children: [ docxCell(r.equipo), docxCell(r.cargo), docxCell(r.contacto) ] });
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header].concat(body) });
}

// Encabezado/pie de pagina compartidos por Plan de Pruebas y Certificacion QA.
// La plantilla real tiene una banda con degradado + logo + titulo en cuadro de
// texto flotante -- eso no es practico de replicar 1:1 con esta libreria (VML/
// shapes), asi que se aproxima con logo a proporcion real + titulo + una linea
// de acento de color debajo, que es lo que realmente importa visualmente.
function docxHeaderFooter(titulo) {
  var logoWidth = 170;
  var headerRunChildren = [];
  if (LOGO_BUFFER) {
    headerRunChildren.push(new ImageRun({ data: LOGO_BUFFER, type: 'jpg', transformation: { width: logoWidth, height: Math.round(logoWidth / LOGO_ASPECT) } }));
  }
  headerRunChildren.push(new TextRun({ text: '\t' + titulo, bold: true, size: 28, color: DOCX_NAVY, font: DOCX_FONT }));
  var header = new Header({ children: [
    new Paragraph({
      tabStops: [{ type: 'right', position: 9026 }],
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: DOCX_TEAL, space: 4 } },
      children: headerRunChildren,
    }),
  ] });
  var footer = new Footer({ children: [
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [ new TextRun({
        children: [ 'Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES ],
        size: 18, color: '2C7FCE', font: DOCX_FONT,
      }) ],
    }),
  ] });
  return { header: header, footer: footer };
}

async function buildPlanPruebasDocxBuffer(p) {
  p = p || {};
  var meta = p.meta || {};
  var headerChildren = [];
  headerChildren.push(new Paragraph({ spacing: { before: 200 }, children: [ new TextRun({ text: 'Proyecto: ', bold: true, size: 21, font: DOCX_FONT }), new TextRun({ text: meta.proyecto || '(sin nombre)', size: 21, font: DOCX_FONT }) ] }));
  headerChildren.push(new Paragraph({ children: [ new TextRun({ text: 'Versión: ', bold: true, size: 21, font: DOCX_FONT }), new TextRun({ text: meta.version || '1.0', size: 21, font: DOCX_FONT }) ] }));
  headerChildren.push(new Paragraph({ spacing: { after: 200 }, children: [ new TextRun({ text: 'Fecha: ', bold: true, size: 21, font: DOCX_FONT }), new TextRun({ text: meta.fecha || new Date().toLocaleDateString('es-CO'), size: 21, font: DOCX_FONT }) ] }));

  var children = headerChildren.concat([
    docxHeading('1. Objetivo'),
    docxPara(p.objetivo),

    docxHeading('2. Alcance'),
    docxSubheading('2.1 Dentro del Alcance'),
  ]).concat(docxNumberedList(p.alcanceDentro)).concat([
    docxSubheading('2.2 Fuera del Alcance'),
  ]).concat(docxNumberedList(p.alcanceFuera)).concat([

    docxHeading('3. Supuestos'),
  ]).concat(docxBulletList(p.supuestos)).concat([

    docxHeading('4. Riesgos'),
    docxSubheading('4.1 Riesgos Funcionales'),
  ]).concat(docxBulletList(p.riesgosFuncionales)).concat([
    docxSubheading('4.2 Riesgos de Negocio'),
  ]).concat(docxBulletList(p.riesgosNegocio)).concat([

    docxHeading('5. Estrategia de Pruebas'),
    docxPara(p.estrategia),

    docxHeading('6. Tipos y Niveles de Pruebas'),
    docxSubheading('6.1 Tipos de Pruebas'),
  ]).concat(docxNamedItemsBlock(p.tiposPrueba)).concat([
    docxSubheading('6.2 Niveles de Pruebas'),
  ]).concat(docxNamedItemsBlock(p.nivelesPrueba)).concat([

    docxHeading('7. Criterios de Entrada y de Salida'),
    docxSubheading('7.1 Criterios de Entrada'),
  ]).concat(docxBulletList(p.criteriosEntrada)).concat([
    docxSubheading('7.2 Criterios de Salida'),
  ]).concat(docxBulletList(p.criteriosSalida)).concat([

    docxHeading('8. Responsables'),
    docxResponsablesTable(p.responsables),
  ]);

  var hf = docxHeaderFooter('Plan de pruebas');
  var doc = new Document({
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21 } } } },
    sections: [ { properties: {}, headers: { default: hf.header }, footers: { default: hf.footer }, children: children } ],
  });
  return Packer.toBuffer(doc);
}

// Cada linea del analisis de M1 viene "TAG_N | descripcion" (ej. "CA_1 | El sistema
// debe..."). Se conserva el ID en negrita al inicio de la vineta -- es la misma
// referencia que se usa en Casos QA/Coverage, vale la pena que quede visible en el
// documento para trazabilidad, no solo el texto plano.
function docxLabeledBulletList(lines) {
  var items = (lines || '').split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
  if (!items.length) return [ docxPara('---') ];
  return items.map(function(l){
    var m = l.match(/^([A-Z_0-9]+)\s*\|\s*(.*)/);
    if (m) {
      return new Paragraph({ alignment: AlignmentType.JUSTIFIED, bullet: { level: 0 }, spacing: { after: 40 }, children: [
        new TextRun({ text: m[1]+': ', bold: true, size: 21, font: DOCX_FONT }),
        new TextRun({ text: m[2], size: 21, font: DOCX_FONT }),
      ] });
    }
    return docxBullet(l.replace(/^[-*]\s*/, ''));
  });
}

// Misma plantilla visual que Plan de Pruebas (logo/banda teal/Calibri via
// docxHeaderFooter, secciones numeradas) -- reemplaza el RTF a mano/jsPDF viejos
// de exportHU_Word/exportHU_PDF en el cliente.
async function buildHUDocxBuffer(p) {
  p = p || {};
  var hu = p.hu || {};
  var headerChildren = [
    new Paragraph({ spacing: { before: 100, after: 200 }, children: [ new TextRun({ text: 'Fecha: ', bold: true, size: 21, font: DOCX_FONT }), new TextRun({ text: p.fecha || new Date().toLocaleDateString('es-CO'), size: 21, font: DOCX_FONT }) ] }),
  ];
  var children = headerChildren.concat([
    docxHeading('1. Historia de Usuario'),
    docxLabelPara('Como', hu.como),
    docxLabelPara('Quiero', hu.quiero),
    docxLabelPara('Para', hu.para),

    docxHeading('2. Nivel de Riesgo Global: ' + (p.nivelRiesgo || '---')),
    docxPara(p.justificacionRiesgo),

    docxHeading('3. Criterios de Aceptación'),
  ]).concat(docxLabeledBulletList(p.criterios)).concat([

    docxHeading('4. Reglas de Negocio'),
  ]).concat(docxLabeledBulletList(p.reglas)).concat([

    docxHeading('5. Riesgos'),
  ]).concat(docxLabeledBulletList(p.riesgos)).concat([

    docxHeading('6. Impactos'),
  ]).concat(docxLabeledBulletList(p.impactos)).concat([

    docxHeading('7. Escenarios QA Sugeridos'),
  ]).concat(docxLabeledBulletList(p.escenarios));

  var hf = docxHeaderFooter('Historia de Usuario');
  var doc = new Document({
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21 } } } },
    sections: [ { properties: {}, headers: { default: hf.header }, footers: { default: hf.footer }, children: children } ],
  });
  return Packer.toBuffer(doc);
}

function docxDefectosTable(bugs) {
  var header = new TableRow({ children: [
    docxCell('ID Bug', {header:true, width:15}), docxCell('Caso de Prueba', {header:true, width:15}),
    docxCell('Descripcion', {header:true, width:50}), docxCell('Estado', {header:true, width:20}),
  ]});
  var body = (bugs && bugs.length ? bugs : [{id:'--', caseId:'--', descripcion:'Ningun bug registrado.', estado:'--'}]).map(function(b){
    return new TableRow({ children: [ docxCell(b.id), docxCell(b.caseId||'-'), docxCell(b.descripcion), docxCell(b.estado) ] });
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header].concat(body) });
}

// Estructura calcada de la plantilla real (Plantillas/Certificacion de Calidad-
// Totto....docx): bloque Proyecto/Version/Fecha de ejecucion/Responsable QA,
// secciones SIN numerar con el texto exacto de la plantilla, Alcance separado
// en Dentro/Fuera, Gestion de Defectos con parrafo + tabla, y una seccion final
// de Observacion importante con prerequisitos de configuracion.
async function buildCertificacionDocxBuffer(p) {
  p = p || {};
  var meta = p.meta || {};
  var headerChildren = [
    new Paragraph({ spacing: { before: 100 }, children: [ new TextRun({ text: 'Proyecto: ', bold: true, size: 21, font: DOCX_FONT }), new TextRun({ text: meta.proyecto || '(sin nombre)', size: 21, font: DOCX_FONT }) ] }),
    new Paragraph({ children: [ new TextRun({ text: 'Versión: ', bold: true, size: 21, font: DOCX_FONT }), new TextRun({ text: meta.version || '1.0', size: 21, font: DOCX_FONT }) ] }),
    new Paragraph({ children: [ new TextRun({ text: 'Fecha de ejecución: ', bold: true, size: 21, font: DOCX_FONT }), new TextRun({ text: meta.fecha || new Date().toLocaleDateString('es-CO'), size: 21, font: DOCX_FONT }) ] }),
    new Paragraph({ spacing: { after: 200 }, children: [ new TextRun({ text: 'Responsable QA: ', bold: true, size: 21, font: DOCX_FONT }), new TextRun({ text: meta.responsableQA || 'Equipo QA - TestIALab', size: 21, font: DOCX_FONT }) ] }),
  ];
  var children = headerChildren.concat([
    docxHeading('Información General del Proyecto'),
    docxPara(p.infoGeneral),

    docxHeading('Alcance de las Pruebas'),
    docxSubheading('Dentro del alcance'),
  ]).concat(docxBulletList(p.alcanceDentro)).concat([
    docxSubheading('No se incluyeron cambios en'),
  ]).concat(docxBulletList(p.alcanceFuera)).concat([

    docxHeading('Resumen de Ejecución'),
    docxPara(p.resumenEjecucion),

    docxHeading('Justificación de Casos no Ejecutados'),
    docxPara(p.justificacionNoEjecutados),

    docxHeading('Gestión de Defectos'),
    docxPara(p.gestionDefectosTexto),
    docxDefectosTable(p.bugs),

    docxHeading('Validaciones Clave Realizadas'),
  ]).concat(docxBulletList(p.validacionesClave)).concat([

    docxHeading('Conclusión de Calidad'),
    docxPara(p.conclusionCalidad),

    docxHeading('Observación importante'),
  ]).concat(docxNumberedList(p.observacionImportante));

  var hf = docxHeaderFooter('Certificación de Calidad');
  var doc = new Document({
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21 } } } },
    sections: [ { properties: {}, headers: { default: hf.header }, footers: { default: hf.footer }, children: children } ],
  });
  return Packer.toBuffer(doc);
}

function docxLabelPara(label, value) {
  return new Paragraph({ spacing: { after: 120 }, children: [
    new TextRun({ text: label + ': ', bold: true, size: 21, font: DOCX_FONT }),
    new TextRun({ text: value || '(sin dato)', size: 21, font: DOCX_FONT }),
  ] });
}
// Estructura calcada de la plantilla real (Plantillas/Bug traker1.docx):
// Titulo / Descripcion / Paso a paso (numerado) / Resultado esperado / Tipo
// de error (vinetas) / Severidad / Evidencia / Asignado a. Reemplaza el uso
// indebido anterior del endpoint de Plan de Pruebas para exportar bugs.
// Dimensiones reales del PNG/JPEG (sin libreria pesada -- lee los bytes del header
// directamente) para incrustar la evidencia sin deformarla. Si el formato no matchea
// ninguno de los dos (raro para una captura de pantalla), cae a un tamano generico.
function getImageDimensions(buffer) {
  if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    var offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xFF) { offset++; continue; }
      var marker = buffer[offset+1];
      if (marker === 0xC0 || marker === 0xC2) {
        return { height: buffer.readUInt16BE(offset+5), width: buffer.readUInt16BE(offset+7) };
      }
      offset += 2 + buffer.readUInt16BE(offset+2);
    }
  }
  return null;
}
// Incrusta UNA imagen de evidencia (dataURL base64) como parrafos reales de Word --
// compartido por el Word del bug y el dossier de evidencias de Certificacion, para
// no duplicar el parser de dimensiones PNG/JPEG ni la logica de escalado.
function embedOneEvidenceImage(img, i) {
  try {
    var m = /^data:(image\/\w+);base64,(.+)$/.exec((img && img.dataUrl) || '');
    if (!m) return null;
    var buffer = Buffer.from(m[2], 'base64');
    var dims = getImageDimensions(buffer) || { width: 800, height: 450 };
    var scale = Math.min(500/dims.width, 650/dims.height, 1);
    var type = m[1].indexOf('png') !== -1 ? 'png' : 'jpg';
    return [
      new Paragraph({ spacing: { before: 80, after: 40 }, children: [
        new TextRun({ text: img.name || ('Evidencia ' + (i+1)), italics: true, size: 18, font: DOCX_FONT }),
      ] }),
      new Paragraph({ children: [ new ImageRun({ data: buffer, type: type,
        transformation: { width: Math.round(dims.width*scale), height: Math.round(dims.height*scale) } }) ] }),
    ];
  } catch (e) { console.warn('[embedOneEvidenceImage] no se pudo incrustar una imagen de evidencia:', e.message); return null; }
}
// Evidencia de imagen incrustada de verdad en el Word (no solo un texto diciendo
// "ver adjuntos") -- el cliente ya manda cada imagen en base64 (capturada en
// reportBugFromCase() mientras el File original seguia en memoria del navegador).
function bugEvidenceChildren(images) {
  var out = [];
  (images || []).forEach(function(img, i){
    var r = embedOneEvidenceImage(img, i);
    if (r) out = out.concat(r);
  });
  return out.length ? out : [ docxPara('(sin evidencia de imagen disponible para incrustar en este Word)') ];
}
// Tabla Paso/Resultado esperado del CASO DE PRUEBA vinculado al bug -- distinto del
// "Paso a paso" del bug (que es como reproducir el bug en si). El QA pidio que el
// Word del bug tambien deje registrado el caso completo que se estaba ejecutando.
function bugCaseChildren(casoAsociado) {
  if (!casoAsociado) return [ docxPara('(este bug no tiene un caso de prueba vinculado)') ];
  var steps = casoAsociado.steps || [];
  var header = new TableRow({ children: [
    docxCell('#', {header:true, width:8}), docxCell('Paso', {header:true, width:46}), docxCell('Resultado esperado', {header:true, width:46}),
  ]});
  var body = steps.length
    ? steps.map(function(s, i){ return new TableRow({ children: [ docxCell(String(i+1)), docxCell(s.paso||'-'), docxCell(s.resultado||'-') ] }); })
    : [ new TableRow({ children: [ docxCell('-'), docxCell('(sin pasos definidos)'), docxCell('-') ] }) ];
  return [
    docxLabelPara('Caso', casoAsociado.caso),
    docxLabelPara('Objetivo', casoAsociado.objetivo),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header].concat(body) }),
  ];
}
async function buildBugDocxBuffer(p) {
  p = p || {};
  var children = [
    new Paragraph({ spacing: { before: 100, after: 200 }, children: [
      new TextRun({ text: 'Bug -- ' + (p.caseId || '--'), bold: true, size: 26, color: DOCX_NAVY, font: DOCX_FONT }),
    ] }),
    docxLabelPara('Título', p.titulo),
    docxSubheading('Descripción'),
    docxPara(p.descripcion),
    docxSubheading('Paso a paso'),
  ].concat(docxNumberedList(p.pasos)).concat([
    docxSubheading('Resultado esperado'),
    docxPara(p.resultadoEsperado),
    docxSubheading('Tipo de error'),
  ]).concat(docxBulletList(p.tipoError)).concat([
    docxLabelPara('Severidad', p.severidad),
    docxSubheading('Evidencia'),
  ]).concat(bugEvidenceChildren(p.evidenceImages)).concat([
    docxLabelPara('Asignado a', p.dev),
    docxSubheading('Caso de Prueba Asociado'),
  ]).concat(bugCaseChildren(p.casoAsociado));
  var hf = docxHeaderFooter('Reporte de Bug');
  var doc = new Document({
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21 } } } },
    sections: [ { properties: {}, headers: { default: hf.header }, footers: { default: hf.footer }, children: children } ],
  });
  return Packer.toBuffer(doc);
}

// Dossier de Evidencias (cierre de Certificacion QA): por cada caso ejecutado, su
// paso a paso + resultado esperado + veredicto + evidencia real (imagenes, ya
// persistidas via c.evidenceData en el cliente -- Fase 6). Reusa embedOneEvidenceImage
// (mismo parser de dimensiones que el Word del bug) en vez de duplicarlo.
function dossierCaseTable(steps) {
  var header = new TableRow({ children: [
    docxCell('#', {header:true, width:8}), docxCell('Paso', {header:true, width:46}), docxCell('Resultado esperado', {header:true, width:46}),
  ]});
  var body = (steps && steps.length)
    ? steps.map(function(s, i){ return new TableRow({ children: [ docxCell(String(i+1)), docxCell(s.paso||'-'), docxCell(s.resultado||'-') ] }); })
    : [ new TableRow({ children: [ docxCell('-'), docxCell('(sin pasos definidos)'), docxCell('-') ] }) ];
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header].concat(body) });
}
function dossierCaseChildren(c) {
  var out = [
    new Paragraph({ spacing: { before: 220, after: 60 }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: DOCX_TEAL, space: 8 } }, children: [
      new TextRun({ text: (c.id||'-') + ' -- ' + (c.caso||'-'), bold: true, size: 24, color: DOCX_NAVY, font: DOCX_FONT }),
    ] }),
    docxLabelPara('Objetivo', c.objetivo),
    docxLabelPara('Estado', c.statusLabel + (c.estadoNota ? ' -- ' + c.estadoNota : '')),
    docxSubheading('Paso a paso y resultado esperado'),
    dossierCaseTable(c.steps),
  ];
  if (c.verdict) {
    out.push(docxLabelPara('Veredicto IA', c.verdict + (c.verdictNote ? ' -- ' + c.verdictNote : '')));
  }
  out.push(docxSubheading('Evidencia'));
  out = out.concat(bugEvidenceChildren(c.evidenceImages));
  return out;
}
async function buildEvidenceDossierDocxBuffer(p) {
  p = p || {};
  var meta = p.meta || {};
  var cases = p.cases || [];
  var children = [
    new Paragraph({ spacing: { before: 100, after: 60 }, children: [
      new TextRun({ text: 'Dossier de Evidencias -- ' + (meta.proyecto || '--'), bold: true, size: 28, color: DOCX_NAVY, font: DOCX_FONT }),
    ] }),
    docxLabelPara('Fecha', meta.fecha),
    docxLabelPara('Casos incluidos', String(cases.length)),
  ];
  cases.forEach(function(c){ children = children.concat(dossierCaseChildren(c)); });
  if (!cases.length) children.push(docxPara('No hay casos ejecutados todavia para incluir en el dossier.'));
  var hf = docxHeaderFooter('Dossier de Evidencias');
  var doc = new Document({
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21 } } } },
    sections: [ { properties: {}, headers: { default: hf.header }, footers: { default: hf.footer }, children: children } ],
  });
  return Packer.toBuffer(doc);
}

// ── Build prompt: Veredicto de evidencia (Ejecucion y Evidencias) ──────────────
// Vision sobre una o mas imagenes de evidencia, mismo patron @ruta/Read-tool que
// buildVisionPrompt/buildDocxAnalysisPrompt. Veredicto binario (PASS/FAIL): si la
// evidencia no confirma con certeza el resultado esperado, el caso es FAIL --
// TestiAlab no quiere un tercer estado ambiguo aca, el QA revisa la justificacion.
function buildEvidenceVerdictPrompt(caseData, filePaths, engine, textEvidence) {
  caseData = caseData || {};
  textEvidence = textEvidence || [];
  var steps = caseData.steps || [];
  var pasosText = steps.length
    ? steps.map(function(s,i){ return (i+1)+'. '+s.paso+' -- Resultado esperado: '+s.resultado; }).join('\n')
    : '(sin pasos definidos)';
  var fileRefs = filePaths.map(function(fp){
    return 'Evidencia a analizar (usa tu herramienta de lectura de archivos sobre esta ruta exacta antes de responder -- puede ser imagen o PDF): ' + fp;
  }).join('\n');
  var textEvidenceBlock = textEvidence.length
    ? '\nEVIDENCIA EN TEXTO (' + textEvidence.length + ' documento(s) DOCX/TXT, ya extraido):\n' +
      textEvidence.map(function(t){ return '--- ' + t.filename + ' ---\n' + t.text; }).join('\n\n') + '\n'
    : '';
  var totalEvidencia = filePaths.length + textEvidence.length;
  return [
    'Eres un QA Tester senior verificando el resultado de un caso de prueba a partir de '+(totalEvidencia>1?'varias evidencias (capturas de pantalla, PDF y/o documentos de texto).':'una evidencia (captura de pantalla, PDF o documento de texto).'),
    '',
    'CASO DE PRUEBA:',
    'Objetivo: ' + (caseData.objetivo || '-'),
    'Pasos y resultado esperado de CADA paso:',
    pasosText,
    '',
    fileRefs,
    textEvidenceBlock,
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Primero evalua si la evidencia CORRESPONDE al caso: si la(s) imagen(es) no tienen relacion alguna con el objetivo/pasos',
    '   de este caso (ej: es una pantalla de otro modulo, un caso distinto, o algo irrelevante), marca EVIDENCIA_VALIDA=NO --',
    '   en ese escenario NO evalues veredicto por contenido, es simplemente evidencia incorrecta que hay que resubir.',
    '2. Si la evidencia SI corresponde, compara lo que se ve contra el resultado esperado de CADA paso individualmente.',
    '3. Al comparar, distingue el DATO de ejemplo (un correo, nombre, ID, monto o fecha concreta escrita en el paso solo para',
    '   ilustrar el caso) de la ASERCION FUNCIONAL real que el paso quiere validar. El centro de la prueba es la funcionalidad,',
    '   no la data. Si la evidencia muestra el mismo comportamiento funcional esperado pero con un dato valido distinto al',
    '   escrito en el paso (ej: el paso dice ingresar "ana.gomez@aurora.com" y la evidencia usa "pedro.diaz@empresa.com", pero',
    '   en ambos casos el login funciona igual de bien), el paso se considera CUMPLIDO -- NO falles un paso solo porque el',
    '   valor literal no coincide con el del enunciado. Excepcion: si el OBJETIVO del caso es especificamente validar ese dato',
    '   exacto (ej: "el campo debe mostrar el correo tal como fue digitado", "el sistema debe rechazar este ID puntual"), ahi',
    '   si compara el dato literal, porque en ese caso el dato ES la funcionalidad bajo prueba.',
    '4. El veredicto general es BINARIO: PASS solo si TODOS los pasos se cumplieron. Si algun paso fallo o la evidencia es',
    '   insuficiente/ambigua para confirmarlo, el veredicto general es FAIL -- no existe un tercer estado ambiguo.',
    '5. Responde UNICAMENTE con las secciones delimitadas. Sin texto adicional.',
    '',
    '---EVIDENCIA_VALIDA---',
    'Una sola palabra: SI o NO.',
    '',
    '---VEREDICTO---',
    'Una sola palabra: PASS o FAIL. Si EVIDENCIA_VALIDA es NO, responde FAIL aca tambien.',
    '',
    '---PASOS_VERDICTO---',
    'Un renglon por paso EN EL MISMO ORDEN que los pasos de arriba, SIEMPRE con una razon puntual (1 frase corta) citando',
    'especificamente que se ve en la evidencia -- tanto si el paso paso como si fallo, el QA necesita poder auditar el',
    'criterio de la IA en ambos casos, no solo cuando algo sale mal.',
    'Si el paso paso: escribe PASS seguido de " -- " y la razon puntual de por que se da por cumplido. Ejemplo:',
    '"PASS -- La pantalla muestra el pedido en estado Enviado, tal como pide el resultado esperado."',
    'Si el paso fallo: escribe FAIL seguido de " -- " y una razon puntual y especifica citando que se ve en la evidencia',
    'que no cumple el resultado esperado de ESE paso. Ejemplo: "FAIL -- La pantalla muestra el pedido en estado Cancelado,',
    'no Enviado como pide el resultado esperado." Si EVIDENCIA_VALIDA es NO, deja esta seccion vacia.',
    '',
    '---OBSERVACIONES---',
    '2 a 4 oraciones especificas citando lo observado en la(s) evidencia(s), paso por paso cuando sea relevante.',
    'Si EVIDENCIA_VALIDA es NO, explica aca claramente que evidencia se esperaba en su lugar para que el QA suba la correcta.',
  ].join('\n');
}

// ── Build prompt: Certificacion de Calidad QA (M7c, cierre) ──────────────────
// Estructura del ejemplo real Nalsani/Totto. Se basa en resultados REALES de
// ejecucion (S.cases) y defectos (S.bugs) que manda el frontend -- nunca inventa cifras.
// Extrae una seccion delimitada "---TAG---...(hasta el siguiente --- o el final)"
// del texto crudo de analisis de M1 -- mismo formato/logica que parseSection() en
// qa-suite.html (cliente), pero server-side, para poder mandarle a Certificacion
// SOLO las secciones que de verdad necesita (Criterios/Reglas) en vez del analisis
// completo (HU narrativa + Riesgos + Impactos + Escenarios QA, que para este punto
// del ciclo ya estan reflejados en el Plan de Pruebas y los casos generados).
function extractAnalysisSection(raw, tag) {
  var re = new RegExp('---'+tag+'---([\\s\\S]*?)(?=---|$)', 'i');
  var m = (raw || '').match(re);
  return m ? m[1].trim() : '';
}
function summarizeCasesForPrompt(cases) {
  if (!cases || !cases.length) return '(sin casos registrados)';
  return cases.map(function(c){
    return (c.id || 'CP') + ' | ' + (c.caso || c.escenario || '') + ' | estado: ' + (c.status || 'todo') +
      (c.verdict ? ' | resultado de verificacion: ' + c.verdict : '');
  }).join('\n');
}
function summarizeBugsForPrompt(bugs) {
  if (!bugs || !bugs.length) return '(sin bugs registrados)';
  return bugs.map(function(b){
    return (b.id || 'BUG') + ' | ' + (b.titulo || '') + ' | severidad: ' + (b.severidad || '-') +
      ' | estado: ' + (b.estado || '-') + (b.caseId ? ' | caso: ' + b.caseId : '');
  }).join('\n');
}
// Antes se reenviaba el analisisRaw COMPLETO de M1 (HU narrativa + Criterios +
// Reglas + Riesgos + Impactos + Escenarios QA sugeridos) para que la IA re-derivara
// Alcance/Info General desde cero -- pero para cuando se genera Certificacion, el
// QA YA aprobo el Alcance/Objetivo en el Plan de Pruebas, asi que volver a pedirle
// a la IA que los re-invente arriesga una segunda interpretacion distinta a la ya
// aprobada. Ahora se le pasa el Alcance/Objetivo del Plan como referencia principal
// (que solo debe ajustar si la ejecucion real muestra una desviacion), y del
// analisis crudo solo Criterios de Aceptacion + Reglas de Negocio (lo unico que
// de verdad hace falta para justificar casos no ejecutados) -- el resto del
// analisis ya esta reflejado en el Plan y en los casos, no aporta nada nuevo aca.
function buildCertificationPrompt(analysisRaw, m2Context, cases, bugs, engine, planSections) {
  m2Context = m2Context || {};
  var ps = planSections || {};
  var total = (cases || []).length;
  var passN = (cases || []).filter(function(c){ return c.status === 'pass'; }).length;
  var retiredN = (cases || []).filter(function(c){ return c.status === 'retired'; }).length;
  var failN = (cases || []).filter(function(c){ return c.status === 'fail'; }).length;
  var blkN  = (cases || []).filter(function(c){ return c.status === 'blocked'; }).length;
  var todoN = total - passN - retiredN - failN - blkN;
  var criterios = extractAnalysisSection(analysisRaw, 'CRITERIOS_DE_ACEPTACION');
  var reglas = extractAnalysisSection(analysisRaw, 'REGLAS_DE_NEGOCIO');
  return [
    'Eres un Lider de QA senior redactando la Certificacion de Calidad final de un ciclo de pruebas, siguiendo el',
    'formato estandar de la empresa (Informacion general, Alcance, Resumen de ejecucion, Justificacion de no',
    'ejecutados, Validaciones clave, Conclusion de calidad, Observaciones).',
    '',
    'OBJETIVO Y ALCANCE YA APROBADOS POR EL QA EN EL PLAN DE PRUEBAS DE ESTE CICLO -- usalos como referencia',
    'PRINCIPAL para Informacion General y Alcance; ajustalos solo si los resultados de ejecucion de mas abajo',
    'muestran una desviacion real (ej. algo planeado que termino sin ningun caso asociado):',
    'Objetivo: ' + (ps.objetivo || '(no definido en el Plan de Pruebas)'),
    'Alcance Dentro (Plan): ' + ((ps.alcanceDentro||[]).join('; ') || '(no definido)'),
    'Alcance Fuera (Plan): ' + ((ps.alcanceFuera||[]).join('; ') || '(no definido)'),
    '',
    'CRITERIOS DE ACEPTACION Y REGLAS DE NEGOCIO DEL REQUERIMIENTO (para justificar casos no ejecutados/pendientes):',
    criterios || '(sin criterios de aceptacion identificados)',
    '',
    reglas || '(sin reglas de negocio identificadas)',
    '',
    'RESULTADOS DE EJECUCION (' + total + ' casos totales -- Pass: ' + passN + ', Retired: ' + retiredN + ', Fail: ' + failN + ', Blocked: ' + blkN + ', To Do: ' + todoN + '):',
    summarizeCasesForPrompt(cases),
    '',
    'DEFECTOS REGISTRADOS:',
    summarizeBugsForPrompt(bugs),
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Basate UNICAMENTE en los resultados reales de arriba -- no inventes cifras ni resultados. Este documento certifica',
    '   la calidad ante el cliente final -- CERO informacion inventada, sin excepcion.',
    '2. Si hay casos en To Do o Blocked, justifica su impacto en la conclusion.',
    '3. La conclusion de calidad debe ser honesta: si hay fails criticos sin resolver, no certifiques como apto sin condiciones.',
    '4. NO menciones que la ejecucion de pruebas uso o se apoyo en inteligencia artificial -- este documento describe',
    '   los resultados de QA hacia el cliente, no la herramienta interna que usa TestiAlab.',
    '5. Responde UNICAMENTE con las secciones delimitadas. Sin texto adicional.',
    '',
    '---META---',
    'Una sola linea con formato: Version | Responsable QA. Ejemplo: "1.0 | Equipo QA - TestIALab".',
    '',
    '---INFO_GENERAL---',
    '2 a 3 parrafos de prosa (NO bullets, NO "Campo | Valor") describiendo el proyecto y el objetivo del ciclo de',
    'pruebas certificado, igual al estilo de un informe formal de certificacion de calidad.',
    '',
    '---ALCANCE_DENTRO_CERT---',
    'Lista de componentes/flujos SI evaluados en este ciclo, una por linea con "- ".',
    '',
    '---ALCANCE_FUERA_CERT---',
    'Lista de cambios/flujos que NO se incluyeron en el alcance de este ciclo, una por linea con "- ".',
    '',
    '---RESUMEN_EJECUCION---',
    '2 a 3 parrafos citando los numeros reales de arriba, el porcentaje de avance, y de los casos ejecutados cuantos',
    'fueron aprobados y cuantos quedaron pendientes (con su %).',
    '',
    '---JUSTIFICACION_NO_EJECUTADOS---',
    'Si no hay pendientes ni blocked, escribe "No aplica -- todos los casos fueron ejecutados." De lo contrario, justifica.',
    '',
    '---GESTION_DEFECTOS_TEXTO---',
    '1 a 2 parrafos narrando los defectos identificados durante el ciclo (cuantos, de que naturaleza) y su estado actual.',
    'Si no hay bugs, escribe "No se identificaron defectos durante el ciclo de pruebas."',
    '',
    '---VALIDACIONES_CLAVE---',
    'Lista de validaciones criticas confirmadas, una por linea con "- ".',
    '',
    '---CONCLUSION_CALIDAD---',
    '1 a 2 parrafos con veredicto de apto / apto con observaciones / no apto.',
    '',
    '---OBSERVACION_IMPORTANTE---',
    'Lista numerada de condiciones/configuraciones/prerequisitos que deben verificarse para que el desarrollo',
    'certificado funcione correctamente en produccion (si el analisis del requerimiento las menciona), una por linea',
    'con "- ". Si no aplica ninguna, escribe "- Ninguna observacion adicional."',
  ].join('\n');
}

// ── Health ────────────────────────────────────────────────────────────────────
// Esto solo confirma que el proxy (Express) esta arriba — NO que el motor de IA
// elegido realmente pueda ejecutarse. Para eso ver /api/engine-status abajo.
app.get('/health', function(_req, res) {
  res.json({ status: 'ok', engines: ['gemini', 'claude'], defaultEngine: ENGINE_DEFAULT, port: PORT });
});

// ── Engine status ─────────────────────────────────────────────────────────────
// Verifica de verdad que el binario del motor elegido pueda ejecutarse (corre
// "--version" con timeout corto). Esto es lo que decide si el punto de estado
// en el sidebar dice "Conectado" o no — un /health en 200 no alcanza para saber
// si "claude" o "gemini" realmente estan disponibles en este equipo.
function spawnVersionCheck(bin, timeoutMs) {
  timeoutMs = timeoutMs || 7000;
  return new Promise(function(resolve, reject) {
    var proc = spawn(bin, ['--version'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    var out = '', err = '', settled = false;
    proc.stdout.on('data', function(d){ out += d.toString(); });
    proc.stderr.on('data', function(d){ err += d.toString(); });
    var timer = setTimeout(function(){
      if (settled) return;
      settled = true; proc.kill();
      reject(new Error('timeout verificando ' + bin));
    }, timeoutMs);
    proc.on('error', function(e){
      if (settled) return;
      settled = true; clearTimeout(timer); reject(e);
    });
    proc.on('close', function(code){
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) return resolve((out || err).trim());
      reject(new Error((err || out || ('codigo ' + code)).trim().slice(0, 200)));
    });
  });
}

app.get('/api/engine-status', async function(req, res) {
  var engine = (req.query.engine === 'claude') ? 'claude' : 'gemini';
  try {
    if (engine === 'claude') {
      var candidates = candidateClaudeBins();
      var lastErr = null;
      for (var i = 0; i < candidates.length; i++) {
        try {
          var v = await spawnVersionCheck(candidates[i]);
          return res.json({ engine: engine, available: true, detail: v || 'Claude CLI' });
        } catch (e) { lastErr = e; }
      }
      return res.json({ engine: engine, available: false, detail: (lastErr && lastErr.message) || 'No disponible' });
    } else {
      var status = await checkGeminiAvailable();
      return res.json({ engine: engine, available: status.available, detail: status.detail });
    }
  } catch (e) {
    return res.json({ engine: engine, available: false, detail: e.message });
  }
});

// ── SSE Progress endpoint ─────────────────────────────────────────────────────
app.get('/api/analyze-progress', function(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  var id = Date.now()+'_'+Math.random();
  progressClients.set(id, res);
  req.on('close', function(){ progressClients.delete(id); });
  // Send initial event so client knows SSE is connected
  res.write('event: connected\ndata: {"id":"'+id+'"}\n\n');
});

// reqId identifica a que llamada del cliente pertenece cada evento -- el canal SSE
// sigue siendo un solo broadcast a todos los conectados (simple, sin Map por cliente),
// pero cada consola del cliente ahora filtra por su propio reqId antes de reaccionar,
// asi que dos acciones IA en paralelo (ej. Plan de Pruebas en M3 + Casos QA en M4) no
// se pisan entre si aunque compartan el mismo canal de red.
function emitProgress(reqId, pct, label) {
  var data = JSON.stringify({reqId: reqId, pct: pct, label: label});
  progressClients.forEach(function(res){
    try { res.write('event: progress\ndata: '+data+'\n\n'); } catch(e){}
  });
}
function emitDone(reqId) {
  var data = JSON.stringify({reqId: reqId});
  progressClients.forEach(function(res){
    try { res.write('event: done\ndata: '+data+'\n\n'); } catch(e){}
  });
}

// multer/busboy en Windows decodifica el header Content-Disposition (de donde
// sale originalname) como latin1, no utf8 -- un nombre real en UTF-8 como
// "Integración" llega aca como "IntegraciÃ³n". Re-interpretar los bytes como
// latin1 y decodificarlos de nuevo como utf8 revierte la corrupcion. Para un
// nombre ya puramente ASCII esta operacion es un no-op (round-trip identico).
function fixMojibake(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// Mismo patron de extraccion que extractDesarrolloTitle() en qa-suite.html --
// duplicado aca (no hay bundler que comparta codigo cliente/servidor) porque
// solo el servidor puede extraer texto de un PDF (mammoth/pdf-parse corren en
// Node). Si se ajusta el regex de un lado, ajustar tambien el otro.
function extractDesarrolloTitleFromText(text) {
  if (!text) return '';
  var lines = text.split('\n').map(function(l){ return l.trim(); });
  for (var i = 0; i < lines.length; i++) {
    var m = /^DESARROLLO\b[\s:.\-]*(.*)$/i.exec(lines[i]);
    if (m) {
      if (m[1]) return m[1].trim().slice(0,120);
      for (var j = i+1; j < lines.length; j++) {
        if (lines[j]) return lines[j].slice(0,120);
      }
    }
  }
  return '';
}

// ── Upload ────────────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No se recibio ningun archivo.' });

  var ext      = path.extname(req.file.originalname).toLowerCase();
  var tmpPath  = req.file.path;
  var filename = fixMojibake(req.file.originalname);

  try {
    if (ext === '.pdf') {
      // Native vision mode — keep PDF in /tmp with .pdf extension
      var pdfPath = tmpPath + '.pdf';
      fs.renameSync(tmpPath, pdfPath);
      // Extraccion de texto SOLO para detectar el titulo real ("DESARROLLO...")
      // para el nombre del requerimiento -- el analisis de IA sigue yendo 100%
      // por vision nativa sobre el PDF (mode:'native' no cambia). Best-effort:
      // si pdf-parse falla (PDF escaneado/protegido/corrupto), no rompe la subida,
      // solo se pierde la deteccion automatica del titulo para ese archivo.
      var desarrolloTitle = '';
      try {
        var pdfBuffer = fs.readFileSync(pdfPath);
        var parser = new PDFParse({ data: pdfBuffer });
        var pdfText = (await parser.getText()).text;
        await parser.destroy();
        desarrolloTitle = extractDesarrolloTitleFromText(pdfText);
      } catch (e) { /* best-effort, ver comentario arriba */ }
      // Store path for later use in analyze
      return res.json({
        filename        : filename,
        mode            : 'native',
        filePath        : pdfPath,
        chars           : 0,
        desarrolloTitle : desarrolloTitle,
      });
    }

    if (ext === '.docx' || ext === '.doc') {
      if (ext === '.doc') {
        fs.unlink(tmpPath, function(){});
        return res.status(422).json({
          error: 'El formato .doc (Word 97-2003, binario) no es soportado. ' +
                 'Guarda el archivo como .docx desde Word ("Guardar como" > Word Document) y vuelve a subirlo.'
        });
      }
      // Extraccion 100% JS con mammoth: texto + imagenes incrustadas a disco.
      // Sin LibreOffice, sin binarios externos, sin depender del PATH del sistema.
      emitProgress(req.body.reqId || '', 10, 'Extrayendo texto e imagenes del DOCX...');
      var tmpDocx = tmpPath + ext;
      fs.renameSync(tmpPath, tmpDocx);
      var extracted = await extractDocx(tmpDocx);
      fs.unlink(tmpDocx, function(){});
      emitProgress(req.body.reqId || '', 30, 'Extraccion completada (' + extracted.imagePaths.length + ' imagen(es))');
      return res.json({
        filename   : filename,
        mode       : extracted.imagePaths.length ? 'text-images' : 'text',
        text       : extracted.text,
        chars      : extracted.text.length,
        imagePaths : extracted.imagePaths,
      });
    }

    if (ext === '.txt') {
      var text = fs.readFileSync(tmpPath, 'utf-8');
      fs.unlink(tmpPath, function(){});
      return res.json({
        filename : filename,
        mode     : 'text',
        text     : text,
        chars    : text.length,
      });
    }

    fs.unlink(tmpPath, function(){});
    return res.status(422).json({ error: 'Formato no soportado: '+ext+'. Usa PDF, DOCX o TXT.' });

  } catch(err) {
    try { fs.unlink(tmpPath, function(){}); } catch(e){}
    return res.status(422).json({ error: err.message });
  }
});

// ── Analyze ───────────────────────────────────────────────────────────────────
app.post('/api/analyze', async function(req, res) {
  // files[]: forma nueva -- uno o varios resultados de /api/upload ya normalizados
  // ({mode:'native'|'text'|'text-images', filePath?, text?, imagePaths?, filename}).
  // Se mantiene compat con la forma vieja (un solo filePath/docxText+imagePaths o
  // requirement pegado a mano) por si algo externo la sigue llamando asi.
  var files = req.body.files;
  if (!files || !files.length) {
    if (req.body.filePath) {
      files = [{ mode: 'native', filePath: req.body.filePath, filename: req.body.filename }];
    } else if (req.body.docxText != null) {
      var imagePaths = req.body.imagePaths || [];
      files = [{ mode: imagePaths.length ? 'text-images' : 'text', text: req.body.docxText, imagePaths: imagePaths, filename: req.body.filename }];
    } else if (req.body.requirement) {
      files = [{ mode: 'text', text: req.body.requirement, filename: 'requerimiento.txt' }];
    }
  }
  var engine = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var reqId  = req.body.reqId || '';

  if (!files || !files.length) {
    return res.status(400).json({ error: 'Se requiere al menos un archivo (files[]), filePath, docxText o requirement.' });
  }

  var engineLabel = engine === 'claude' ? 'Claude CLI' : 'Gemini (Antigravity CLI)';
  emitProgress(reqId, 10, 'Preparando prompt para '+engineLabel+'...');

  // El texto de cada archivo no-PDF se vuelca a un .txt temporal y se referencia por
  // RUTA en el prompt (igual que ya se hace con PDFs/imagenes) en vez de embeberlo
  // inline -- con un solo archivo chico nunca daba problema, pero con varios
  // archivos (o uno largo) el prompt total crecia lo suficiente para que agy.exe
  // (recibe el prompt como argumento de linea de comandos, no por stdin) tirara
  // "spawn ENAMETOOLONG" en Windows. Referenciar por ruta mantiene el prompt corto
  // sin importar cuantos archivos haya o que tan largos sean.
  var textTmpPaths = [];
  files.forEach(function(f){
    if (f.mode !== 'native' && f.text != null) {
      var tp = path.join(os.tmpdir(), 'analyze-text-' + Date.now() + '-' + Math.round(Math.random()*1e6) + '.txt');
      fs.writeFileSync(tp, f.text, 'utf-8');
      f._textFilePath = tp;
      textTmpPaths.push(tp);
    }
  });

  var prompt = buildMultiFileAnalysisPrompt(files, engine);

  emitProgress(reqId, 20, 'Enviando a '+engineLabel+'...');

  // Simulate staged progress while waiting for el motor elegido
  var stages = [
    [30, engineLabel+' leyendo el/los documento(s)...'],
    [45, 'Analizando requerimientos...'],
    [60, 'Generando Historia de Usuario...'],
    [72, 'Detallando criterios de aceptacion...'],
    [82, 'Elaborando reglas de negocio...'],
    [90, 'Identificando riesgos e impactos...'],
    [95, 'Finalizando analisis...'],
  ];

  var stageIdx = 0;
  var stageTimer = setInterval(function(){
    if (stageIdx < stages.length) {
      emitProgress(reqId, stages[stageIdx][0], stages[stageIdx][1]);
      stageIdx++;
    }
  }, 8000); // Every 8s advance one stage (conservative for 30-90s total)

  // Archivos/imagenes que el motor debe leer con su herramienta de archivos --
  // todos viven bajo os.tmpdir() (multer + extractDocx asi los crean), asi que un
  // solo --add-dir a la raiz temporal cubre cualquier combinacion de PDFs nativos
  // + carpetas de imagenes extraidas de varios DOCX, sin importar cuantos sean.
  var nativePdfPaths = files.filter(function(f){ return f.mode === 'native'; }).map(function(f){ return f.filePath; });
  var allImagePaths  = [].concat.apply([], files.map(function(f){ return f.imagePaths || []; }));
  // needsFileAccess es practicamente siempre true ahora (hasta el texto plano vive
  // en un .txt temporal que hay que leer), pero se deja la condicion explicita por
  // claridad y como salvaguarda si algun dia hay un modo sin ningun archivo real.
  var needsFileAccess = nativePdfPaths.length > 0 || allImagePaths.length > 0 || textTmpPaths.length > 0;
  function cleanupTmpFiles() {
    nativePdfPaths.forEach(function(p){ try { fs.unlink(p, function(){}); } catch(e){} });
    textTmpPaths.forEach(function(p){ try { fs.unlink(p, function(){}); } catch(e){} });
    files.forEach(function(f){
      if (f.imagePaths && f.imagePaths.length) { try { fs.rmSync(path.dirname(f.imagePaths[0]), { recursive: true, force: true }); } catch(e){} }
    });
  }

  try {
    var text = await callAI(prompt, {
      engine: engine,
      addDir: needsFileAccess ? os.tmpdir() : null,
      allowedTools: ['Read'],
      model: 'sonnet',
      effort: 'medium'
    });
    clearInterval(stageTimer);
    cleanupTmpFiles();

    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ analysis: text, engine: engine });

  } catch(err) {
    clearInterval(stageTimer);
    cleanupTmpFiles();
    emitDone(reqId);
    console.error('[/api/analyze]', err.message);
    return res.status(502).json({ error: engineLabel+': '+err.message });
  }
});

// ── M4 (Escenarios y Casos QA): Generar casos de prueba ────────────────────────
// Fijo a Claude CLI + modelo Opus con razonamiento extendido -- a diferencia
// del resto de modulos, aca NO se respeta el selector de motor del sidebar,
// porque el usuario definio que la generacion de casos siempre debe ser Opus.
app.post('/api/generate-cases', async function(req, res) {
  var analysisRaw = req.body.analysisRaw;
  var m2Context   = req.body.m2Context || {};
  var transcripts = req.body.transcripts || []; // [{filename, text}] -- transcripciones opcionales de reuniones posteriores
  // Respeta el motor elegido por el QA (antes quedaba fijo a Claude) -- si hoy
  // no hay acceso a Claude, con Gemini seleccionado el modulo sigue funcionando.
  // Cuando el motor SI es Claude, se usa Opus (sin thinking alto -- no hay flag
  // real de "esfuerzo" en el CLI, asi que simplemente no se activa el modo
  // ultrathink/MAX_THINKING_TOKENS que antes se forzaba aca, para gastar menos
  // presupuesto de la sesion Pro en esta llamada).
  var engine      = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var engineLabel = engine === 'claude' ? 'Claude Opus' : 'Gemini (Antigravity)';
  var reqId       = req.body.reqId || '';
  if (!analysisRaw) return res.status(400).json({ error: 'Se requiere analysisRaw.' });
  var prompt = buildCasesPrompt(analysisRaw, m2Context, engine, transcripts);

  emitProgress(reqId, 8, 'Preparando prompt para '+engineLabel+'...');
  var stages = [
    [20, 'Enviando a '+engineLabel+'...'],
    [40, 'Disenando escenarios y casos...'],
    [65, 'Verificando cobertura de CA/RN...'],
    [85, 'Redactando pasos y resultados esperados...'],
  ];
  var stageIdx = 0;
  var stageTimer = setInterval(function(){
    if (stageIdx < stages.length) { emitProgress(reqId, stages[stageIdx][0], stages[stageIdx][1]); stageIdx++; }
  }, 8000);

  try {
    // M4 siempre usa el modelo mas fuerte de cada motor (Opus para Claude,
    // gemini-3.1-pro-high para Gemini via GEMINI_MODEL_MAP) -- antes solo
    // Claude recibia ese override; con Gemini caia al default 'sonnet'
    // (gemini-3.1-pro-low), el modelo mas debil, sin que nadie lo pidiera asi.
    var callOpts = { engine: engine, model: 'opus' };
    var text = await callAI(prompt, callOpts);
    clearInterval(stageTimer);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ cases: text, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    emitDone(reqId);
    console.error('[/api/generate-cases]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── Escenarios y Casos QA: generar SOLO los casos faltantes de una cobertura ──
// Se dispara desde "Generar casos para lo faltante" una vez que el QA ya corrio
// "Verificar cobertura con IA" y quedaron CA_N/RN_N sin cubrir de verdad.
app.post('/api/generate-gap-cases', async function(req, res) {
  var analysisRaw   = req.body.analysisRaw;
  var existingCases = req.body.existingCases || [];
  var gapItems       = req.body.gapItems || [];
  var m2Context      = req.body.m2Context || {};
  var engine         = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var engineLabel    = engine === 'claude' ? 'Claude Opus' : 'Gemini (Antigravity)';
  var reqId          = req.body.reqId || '';
  if (!analysisRaw) return res.status(400).json({ error: 'Se requiere analysisRaw.' });
  if (!gapItems.length) return res.status(400).json({ error: 'No hay items sin cubrir para generar.' });
  var prompt = buildGapCasesPrompt(analysisRaw, existingCases, gapItems, m2Context, engine);

  emitProgress(reqId, 10, 'Preparando prompt para '+engineLabel+'...');
  var stages = [
    [30, 'Enviando a '+engineLabel+'...'],
    [55, 'Disenando casos para lo faltante...'],
    [80, 'Redactando pasos y resultados esperados...'],
  ];
  var stageIdx = 0;
  var stageTimer = setInterval(function(){
    if (stageIdx < stages.length) { emitProgress(reqId, stages[stageIdx][0], stages[stageIdx][1]); stageIdx++; }
  }, 8000);

  try {
    // M4 siempre usa el modelo mas fuerte de cada motor (Opus para Claude,
    // gemini-3.1-pro-high para Gemini via GEMINI_MODEL_MAP) -- antes solo
    // Claude recibia ese override; con Gemini caia al default 'sonnet'
    // (gemini-3.1-pro-low), el modelo mas debil, sin que nadie lo pidiera asi.
    var callOpts = { engine: engine, model: 'opus' };
    var text = await callAI(prompt, callOpts);
    clearInterval(stageTimer);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ cases: text, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    emitDone(reqId);
    console.error('[/api/generate-gap-cases]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── Escenarios y Casos QA: verificar cobertura RF/CA REAL con IA ──────────────
// Manual (boton "Verificar cobertura con IA"), no automatico en cada render --
// el cruce por defecto (texto) es gratis e instantaneo; esto cuesta una llamada
// real, asi que el QA lo dispara cuando quiere confirmar de verdad.
app.post('/api/verify-coverage', async function(req, res) {
  var analysisRaw = req.body.analysisRaw;
  var cases       = req.body.cases || [];
  var engine      = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var engineLabel = engine === 'claude' ? 'Claude Opus' : 'Gemini (Antigravity)';
  var reqId       = req.body.reqId || '';
  if (!analysisRaw) return res.status(400).json({ error: 'Se requiere analysisRaw.' });
  var prompt = buildCoverageVerificationPrompt(analysisRaw, cases);

  emitProgress(reqId, 10, 'Preparando prompt para '+engineLabel+'...');
  var stages = [
    [25, 'Enviando a '+engineLabel+'...'],
    [50, 'Auditando cobertura real de CA/RN...'],
    [80, 'Cruzando pasos de cada caso contra el analisis...'],
  ];
  var stageIdx = 0;
  var stageTimer = setInterval(function(){
    if (stageIdx < stages.length) { emitProgress(reqId, stages[stageIdx][0], stages[stageIdx][1]); stageIdx++; }
  }, 8000);

  try {
    // M4 siempre usa el modelo mas fuerte de cada motor (Opus para Claude,
    // gemini-3.1-pro-high para Gemini via GEMINI_MODEL_MAP) -- antes solo
    // Claude recibia ese override; con Gemini caia al default 'sonnet'
    // (gemini-3.1-pro-low), el modelo mas debil, sin que nadie lo pidiera asi.
    var callOpts = { engine: engine, model: 'opus' };
    var text = await callAI(prompt, callOpts);
    clearInterval(stageTimer);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ raw: text, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    emitDone(reqId);
    console.error('[/api/verify-coverage]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── Plan de Pruebas: generar (inicio del ciclo, antes de casos) ──────────────
app.post('/api/generate-plan', async function(req, res) {
  var analysisRaw = req.body.analysisRaw;
  var m2Context   = req.body.m2Context || {};
  var engine      = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var engineLabel = engine === 'claude' ? 'Claude CLI' : 'Gemini (Antigravity CLI)';
  var reqId       = req.body.reqId || '';
  if (!analysisRaw) return res.status(400).json({ error: 'Se requiere analysisRaw.' });
  var prompt = buildPlanPruebasPrompt(analysisRaw, m2Context, engine);

  emitProgress(reqId, 8, 'Preparando prompt para '+engineLabel+'...');
  var stages = [
    [20, 'Enviando a '+engineLabel+'...'],
    [40, 'Redactando objetivo, alcance y supuestos...'],
    [65, 'Definiendo estrategia y riesgos...'],
    [85, 'Definiendo criterios de entrada/salida...'],
  ];
  var stageIdx = 0;
  var stageTimer = setInterval(function(){
    if (stageIdx < stages.length) { emitProgress(reqId, stages[stageIdx][0], stages[stageIdx][1]); stageIdx++; }
  }, 8000);

  try {
    var text = await callAI(prompt, { engine: engine, model: 'sonnet', effort: 'medium' });
    clearInterval(stageTimer);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ plan: text, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    emitDone(reqId);
    console.error('[/api/generate-plan]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── Exportar Plan de Pruebas a .docx real (con formato de la plantilla) ────────
app.post('/api/export-plan-docx', async function(req, res) {
  try {
    var buffer = await buildPlanPruebasDocxBuffer(req.body || {});
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="TestIALab-PlanDePruebas.docx"');
    return res.send(buffer);
  } catch (err) {
    console.error('[/api/export-plan-docx]', err.message);
    return res.status(500).json({ error: 'Error generando el docx: ' + err.message });
  }
});

app.post('/api/import-plan-docx', upload.single('file'), async function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No se recibio ningun archivo.' });
  var docxPath = req.file.path + '.docx';
  try {
    fs.renameSync(req.file.path, docxPath);
    var result = await mammoth.convertToHtml({ path: docxPath });
    var parsed = parsePlanDocxHtml(result.value);
    return res.json(parsed);
  } catch (err) {
    console.error('[/api/import-plan-docx]', err.message);
    return res.status(500).json({ error: 'No se pudo leer el documento: ' + err.message });
  } finally {
    fs.unlink(docxPath, function(){});
  }
});

app.post('/api/import-hu-docx', upload.single('file'), async function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No se recibio ningun archivo.' });
  var docxPath = req.file.path + '.docx';
  try {
    fs.renameSync(req.file.path, docxPath);
    var result = await mammoth.convertToHtml({ path: docxPath });
    var raw = parseHUDocxHtml(result.value);
    return res.json({ raw: raw, filename: fixMojibake(req.file.originalname) });
  } catch (err) {
    console.error('[/api/import-hu-docx]', err.message);
    return res.status(500).json({ error: 'No se pudo leer el documento: ' + err.message });
  } finally {
    fs.unlink(docxPath, function(){});
  }
});

app.post('/api/export-bug-docx', async function(req, res) {
  try {
    var buffer = await buildBugDocxBuffer(req.body || {});
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="TestIALab-Bug.docx"');
    return res.send(buffer);
  } catch (err) {
    console.error('[/api/export-bug-docx]', err.message);
    return res.status(500).json({ error: 'Error generando el docx: ' + err.message });
  }
});

app.post('/api/export-cert-docx', async function(req, res) {
  try {
    var buffer = await buildCertificacionDocxBuffer(req.body || {});
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="TestIALab-CertificacionQA.docx"');
    return res.send(buffer);
  } catch (err) {
    console.error('[/api/export-cert-docx]', err.message);
    return res.status(500).json({ error: 'Error generando el docx: ' + err.message });
  }
});

app.post('/api/export-hu-docx', async function(req, res) {
  try {
    var buffer = await buildHUDocxBuffer(req.body || {});
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="TestIALab-HU.docx"');
    return res.send(buffer);
  } catch (err) {
    console.error('[/api/export-hu-docx]', err.message);
    return res.status(500).json({ error: 'Error generando el docx: ' + err.message });
  }
});

// ── PDF de Plan de Pruebas / Certificacion: identico al Word, no un layout aparte ──
// El PDF a mano (jsPDF) nunca quedaba igual al Word real por mas que se ajustara --
// dos motores de layout para el mismo documento es doble mantenimiento y siempre
// termina divergiendo. En vez de eso: se genera el .docx real (mismo generador que
// ya usan los botones de Word, sin tocar), y se convierte a PDF con Word mismo via
// automatizacion COM (PowerShell) -- asi el PDF es, por construccion, el mismo
// documento. Requiere Microsoft Word instalado en la maquina que corre este proxy
// (ya es el caso hoy; consistente con depender tambien de Claude CLI instalado localmente).
var DOCX_TO_PDF_PS1 = path.join(os.tmpdir(), 'testialab-docx-to-pdf.ps1');
function ensureDocxToPdfScript() {
  if (fs.existsSync(DOCX_TO_PDF_PS1)) return;
  var script = [
    'param([string]$docxPath, [string]$pdfPath)',
    '$ErrorActionPreference = "Stop"',
    '$word = New-Object -ComObject Word.Application',
    '$word.Visible = $false',
    '$word.DisplayAlerts = 0',
    'try {',
    '  $doc = $word.Documents.Open($docxPath, $false, $true)',
    '  $doc.SaveAs([ref]$pdfPath, [ref]17)', // 17 = wdFormatPDF
    '  $doc.Close($false)',
    '} finally {',
    '  $word.Quit()',
    '  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null',
    '}',
  ].join('\r\n');
  fs.writeFileSync(DOCX_TO_PDF_PS1, script, 'utf-8');
}
function docxToPdfViaWord(docxPath, pdfPath) {
  ensureDocxToPdfScript();
  return new Promise(function(resolve, reject) {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', DOCX_TO_PDF_PS1, docxPath, pdfPath,
    ], { timeout: 60000 }, function(err, stdout, stderr) {
      if (err) return reject(new Error((stderr || err.message || '').toString().trim() || 'Fallo la conversion con Word.'));
      if (!fs.existsSync(pdfPath)) return reject(new Error('Word no genero el PDF esperado -- ¿esta instalado en este equipo?'));
      resolve();
    });
  });
}
async function exportDocxAsPdf(res, buildFn, body, baseName) {
  var stamp = Date.now() + '-' + Math.round(Math.random()*1e6);
  var tmpDocx = path.join(os.tmpdir(), 'testialab-'+baseName+'-'+stamp+'.docx');
  var tmpPdf  = path.join(os.tmpdir(), 'testialab-'+baseName+'-'+stamp+'.pdf');
  try {
    var buffer = await buildFn(body || {});
    fs.writeFileSync(tmpDocx, buffer);
    await docxToPdfViaWord(tmpDocx, tmpPdf);
    var pdfBuffer = fs.readFileSync(tmpPdf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="TestIALab-'+baseName+'.pdf"');
    return res.send(pdfBuffer);
  } finally {
    try { fs.unlinkSync(tmpDocx); } catch(e){}
    try { fs.unlinkSync(tmpPdf); } catch(e){}
  }
}
app.post('/api/export-plan-pdf', async function(req, res) {
  try {
    await exportDocxAsPdf(res, buildPlanPruebasDocxBuffer, req.body, 'PlanDePruebas');
  } catch (err) {
    console.error('[/api/export-plan-pdf]', err.message);
    return res.status(500).json({ error: 'Error generando el PDF: ' + err.message });
  }
});
app.post('/api/export-cert-pdf', async function(req, res) {
  try {
    await exportDocxAsPdf(res, buildCertificacionDocxBuffer, req.body, 'CertificacionQA');
  } catch (err) {
    console.error('[/api/export-cert-pdf]', err.message);
    return res.status(500).json({ error: 'Error generando el PDF: ' + err.message });
  }
});
app.post('/api/export-evidence-dossier-docx', async function(req, res) {
  try {
    var buffer = await buildEvidenceDossierDocxBuffer(req.body || {});
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="TestIALab-DossierEvidencias.docx"');
    return res.send(buffer);
  } catch (err) {
    console.error('[/api/export-evidence-dossier-docx]', err.message);
    return res.status(500).json({ error: 'Error generando el docx: ' + err.message });
  }
});
app.post('/api/export-evidence-dossier-pdf', async function(req, res) {
  try {
    await exportDocxAsPdf(res, buildEvidenceDossierDocxBuffer, req.body, 'DossierEvidencias');
  } catch (err) {
    console.error('[/api/export-evidence-dossier-pdf]', err.message);
    return res.status(500).json({ error: 'Error generando el PDF: ' + err.message });
  }
});
app.post('/api/export-hu-pdf', async function(req, res) {
  try {
    await exportDocxAsPdf(res, buildHUDocxBuffer, req.body, 'HU');
  } catch (err) {
    console.error('[/api/export-hu-pdf]', err.message);
    return res.status(500).json({ error: 'Error generando el PDF: ' + err.message });
  }
});

// ── Estimador QA (M2): complejidad del requerimiento ──────────────────────────
app.post('/api/estimate-complexity', async function(req, res) {
  var analysisRaw = req.body.analysisRaw;
  var engine = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var engineLabel = engine === 'claude' ? 'Claude CLI' : 'Gemini (Antigravity CLI)';
  var reqId = req.body.reqId || '';
  if (!analysisRaw) return res.status(400).json({ error: 'Se requiere analysisRaw.' });
  var prompt = buildComplexityPrompt(analysisRaw);

  emitProgress(reqId, 15, 'Preparando prompt para '+engineLabel+'...');
  var stages = [
    [35, 'Enviando a '+engineLabel+'...'],
    [60, 'Evaluando complejidad del requerimiento...'],
    [85, 'Redactando justificacion...'],
  ];
  var stageIdx = 0;
  var stageTimer = setInterval(function(){
    if (stageIdx < stages.length) { emitProgress(reqId, stages[stageIdx][0], stages[stageIdx][1]); stageIdx++; }
  }, 8000);

  try {
    var text = await callAI(prompt, { engine: engine, model: 'sonnet', effort: 'medium' });
    clearInterval(stageTimer);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ raw: text, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    emitDone(reqId);
    console.error('[/api/estimate-complexity]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── Ejecucion y Evidencias: Verificar evidencia con IA (veredicto por caso) ────
// Acepta 1 a 6 archivos de evidencia por caso (antes solo uno).
app.post('/api/verify-evidence', upload.array('evidence', 6), async function(req, res) {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No se recibio ninguna evidencia.' });
  var engine = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var engineLabel = engine === 'claude' ? 'Claude CLI' : 'Gemini (Antigravity CLI)';
  var reqId = req.body.reqId || '';
  var steps = [];
  try { steps = JSON.parse(req.body.steps || '[]'); } catch (e) {}
  var caseData = { objetivo: req.body.objetivo || '', steps: steps };
  emitProgress(reqId, 10, 'Procesando evidencia subida...');

  // Botón "Detener" del QA: si el cliente cierra la conexión (fetch abortado) antes
  // de que termine, se mata el proceso hijo de Claude/Gemini en curso -- reusa el
  // mismo proc.kill() que ya existia solo para timeouts, ahora tambien accesible aca.
  var childProc = null;
  req.on('close', function(){
    if (!res.headersSent && childProc) { try { childProc.kill(); } catch(e){} }
  });

  var visionPaths = []; // imagenes + PDF -- se referencian como archivo (vision nativa / Read tool)
  var textEvidence = []; // [{filename, text}] -- DOCX/TXT, extraidos a texto real
  var cleanupPaths = [];
  try {
    for (var i = 0; i < req.files.length; i++) {
      var f = req.files[i];
      f.originalname = fixMojibake(f.originalname);
      var ext = path.extname(f.originalname).toLowerCase();
      if (ext === '.docx') {
        var docxPath = f.path + ext;
        fs.renameSync(f.path, docxPath);
        cleanupPaths.push(docxPath);
        var extracted = await extractDocx(docxPath);
        textEvidence.push({ filename: f.originalname, text: extracted.text });
        extracted.imagePaths.forEach(function(p){ cleanupPaths.push(p); });
      } else if (ext === '.doc') {
        throw new Error('"'+f.originalname+'": el formato .doc no es soportado, usa .docx.');
      } else if (ext === '.txt') {
        cleanupPaths.push(f.path);
        textEvidence.push({ filename: f.originalname, text: fs.readFileSync(f.path, 'utf-8') });
      } else {
        var refPath = f.path + (ext || '.png');
        fs.renameSync(f.path, refPath);
        visionPaths.push(refPath);
        cleanupPaths.push(refPath);
      }
    }
    var prompt = buildEvidenceVerdictPrompt(caseData, visionPaths, engine, textEvidence);
    emitProgress(reqId, 30, 'Enviando a '+engineLabel+'...');
    var stageIdx = 0;
    var stages = [
      [55, 'Analizando evidencia contra el paso a paso...'],
      [80, 'Redactando veredicto por paso...'],
    ];
    var stageTimer = setInterval(function(){
      if (stageIdx < stages.length) { emitProgress(reqId, stages[stageIdx][0], stages[stageIdx][1]); stageIdx++; }
    }, 8000);
    var text = await callAI(prompt, {
      engine: engine, imagePaths: visionPaths, model: 'sonnet',
      onProcess: function(p){ childProc = p; },
    });
    clearInterval(stageTimer);
    cleanupPaths.forEach(function(p){ fs.unlink(p, function(){}); });
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ raw: text, engine: engine });
  } catch (err) {
    if (typeof stageTimer !== 'undefined') clearInterval(stageTimer);
    try { cleanupPaths.forEach(function(p){ fs.unlink(p, function(){}); }); } catch(e){}
    emitDone(reqId);
    console.error('[/api/verify-evidence]', err.message);
    if (!res.headersSent) return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── Chatbot QA (banco de conocimiento) ─────────────────────────────────────────
// El QA pregunta dudas de negocio de nivel 1; en vez de incrustar TODA la base de
// conocimiento en cada pregunta (se probo, gastaba presupuesto de sesion sin
// necesidad -- ver ensureKnowledgeIndex/retrieveRelevantChunks arriba), se recupera
// solo un puñado de fragmentos relevantes por busqueda semantica (RAG local).
// Siempre Claude (Gemini no tiene en este proyecto un mecanismo de busqueda de carpeta).
function buildChatQaSystemPrompt() {
  return [
    'Eres el "Chatbot QA" de TestiAlab: un asistente de nivel 1 para dudas de NEGOCIO (no tecnicas de QA),',
    'para que el equipo de QA pueda resolver preguntas sin depender de un especialista de negocio humano.',
    '',
    'REGLAS ESTRICTAS:',
    '1. Busca la respuesta EXCLUSIVAMENTE en los FRAGMENTOS de transcripciones que se te dan mas abajo en el prompt',
    '   (son extractos relevantes, no el documento completo -- ya vienen con su nombre de archivo, no hay archivos para leer aparte).',
    '2. Si la respuesta esta en los fragmentos, respondela de forma clara y concisa, y SIEMPRE cita el archivo exacto de donde la sacaste (nombre de archivo, y la carpeta/requerimiento si ayuda a ubicarlo).',
    '3. Si NO encontras informacion relevante en los fragmentos, decilo explicitamente -- NO inventes ni completes con conocimiento general. Sugiere escalar la pregunta a un especialista de negocio real. Es posible que la respuesta exista en el documento pero no haya quedado entre los fragmentos recuperados -- en ese caso, decilo tambien en vez de asumir que el documento no la tiene.',
    '4. Si la pregunta es ambigua o el fragmento tiene informacion parcial, decí que es parcial y qué falta.',
    '5. Respondes en español, tono profesional y directo, sin relleno.',
  ].join('\n');
}
function buildChatQaPrompt(question, historyMsgs, chunks) {
  var historyText = (historyMsgs || []).map(function(m){
    return (m.role === 'user' ? 'QA' : 'Chatbot') + ': ' + m.text;
  }).join('\n');
  var chunksText = (chunks || []).map(function(c){
    return '--- FRAGMENTO DE: ' + c.relPath + ' (relevancia ' + c.score.toFixed(2) + ') ---\n' + c.text;
  }).join('\n\n');
  return [
    'FRAGMENTOS RELEVANTES DE LA BASE DE CONOCIMIENTO (' + (chunks || []).length + ' fragmento(s), recuperados por similitud semantica con la pregunta):',
    '',
    chunksText || '(no se encontro ningun fragmento relevante en la base de conocimiento)',
    '',
    '=====================================',
    '',
    historyText ? 'HISTORIAL DE LA CONVERSACION (para contexto, mas reciente al final):\n' + historyText : '',
    '',
    'PREGUNTA ACTUAL DEL QA:',
    question,
    '',
    'Responde UNICAMENTE con la seccion delimitada. Sin texto adicional.',
    '',
    '---RESPUESTA---',
    'Tu respuesta a la pregunta actual.',
    '',
    '---FUENTE---',
    'Nombre(s) de archivo citado(s), o "Ninguna -- no encontrado en la base de conocimiento" si no hay match.',
  ].join('\n');
}

app.post('/api/chat-qa', async function(req, res) {
  var question = (req.body.question || '').trim();
  var history  = req.body.history || [];
  var reqId    = req.body.reqId || '';
  if (!question) return res.status(400).json({ error: 'Se requiere una pregunta.' });
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    return res.status(500).json({ error: 'No se encontro la carpeta de conocimiento en ' + KNOWLEDGE_DIR + '. Define KNOWLEDGE_DIR si vive en otra ruta.' });
  }
  try {
    emitProgress(reqId, 8, 'Preparando transcripciones (.docx -> .txt)...');
    await ensureKnowledgeTextCache(KNOWLEDGE_DIR);
    // El servidor precarga el modelo de embeddings al arrancar (ver app.listen), pero
    // si esta es la primera pregunta y ese precalentamiento todavia no termino, se
    // avisa explicitamente en vez de dejar "Indexando..." colgado sin explicacion.
    emitProgress(reqId, 15, _embedderPromise ? 'Indexando base de conocimiento (embeddings locales)...' : 'Cargando modelo de embeddings (primera vez en este servidor, puede tardar)...');
    var index = await ensureKnowledgeIndex(KNOWLEDGE_DIR);
    emitProgress(reqId, 45, 'Buscando fragmentos relevantes...');
    var chunks = await retrieveRelevantChunks(question, index);
    var prompt = buildChatQaPrompt(question, history, chunks);
    emitProgress(reqId, 60, 'Enviando a Claude CLI...');
    var text = await callAI(prompt, {
      engine: 'claude', model: 'sonnet',
      systemPrompt: buildChatQaSystemPrompt(),
    });
    emitProgress(reqId, 98, 'Redactando respuesta...');
    emitDone(reqId);
    return res.json({ raw: text, engine: 'claude' });
  } catch (err) {
    emitDone(reqId);
    console.error('[/api/chat-qa]', err.message);
    return res.status(502).json({ error: 'Claude CLI: ' + err.message });
  }
});

// ── M7c: Generar Certificacion de Calidad (cierre) ────────────────────────────
app.post('/api/generate-certification', async function(req, res) {
  var analysisRaw   = req.body.analysisRaw;
  var m2Context     = req.body.m2Context || {};
  var cases         = req.body.cases || [];
  var bugs          = req.body.bugs || [];
  var planSections  = req.body.planSections || {};
  var engine        = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var engineLabel   = engine === 'claude' ? 'Claude CLI' : 'Gemini (Antigravity CLI)';
  var reqId         = req.body.reqId || '';
  if (!analysisRaw) return res.status(400).json({ error: 'Se requiere analysisRaw.' });
  var prompt = buildCertificationPrompt(analysisRaw, m2Context, cases, bugs, engine, planSections);

  emitProgress(reqId, 10, 'Preparando prompt para '+engineLabel+'...');
  var stages = [
    [25, 'Enviando a '+engineLabel+'...'],
    [45, 'Resumiendo ejecucion y alcance...'],
    [65, 'Redactando gestion de defectos...'],
    [85, 'Redactando conclusion de calidad...'],
  ];
  var stageIdx = 0;
  var stageTimer = setInterval(function(){
    if (stageIdx < stages.length) { emitProgress(reqId, stages[stageIdx][0], stages[stageIdx][1]); stageIdx++; }
  }, 8000);

  try {
    var text = await callAI(prompt, { engine: engine, model: 'sonnet' });
    clearInterval(stageTimer);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ certification: text, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    emitDone(reqId);
    console.error('[/api/generate-certification]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Precalienta el modelo de embeddings del Chatbot QA al arrancar el servidor --
// getEmbedder() es perezoso (_embedderPromise) y sin esto la carga en frio del
// modelo ONNX ocurria en medio de la PRIMERA pregunta real del QA (varios minutos
// sin ningun mensaje que lo explicara). Se paga el costo una sola vez aca, sin
// bloquear app.listen.
getEmbedder().then(function(){
  console.log('  🤖 Chatbot QA: modelo de embeddings ('+EMBED_MODEL+') precargado.');
}).catch(function(e){
  console.warn('  ⚠ Chatbot QA: no se pudo precargar el modelo de embeddings:', e.message);
});
app.listen(PORT, function() {
  console.log('\n  +------------------------------------------+');
  console.log('  |   TestIALab QA Suite IA -- Backend       |');
  console.log('  +------------------------------------------+');
  console.log('  ✅ QA Suite:  http://localhost:'+PORT);
  console.log('  PORT     : '+PORT);
  console.log('  ENGINES  : Gemini (via Antigravity CLI) + Claude CLI (default: '+ENGINE_DEFAULT+')');
  console.log('  SELECCION: body.engine = "gemini" | "claude" en /api/analyze');
  console.log('  PDF      : vision nativa (--add-dir + herramienta de lectura, ambos motores)');
  console.log('  DOCX     : mammoth (texto + imagenes, 100% JS, sin binarios externos)');
  console.log('  TXT      : texto embebido en prompt');
  console.log('  +------------------------------------------+\n');
  console.log('  GET  /                    QA Suite (HTML)');
  console.log('  GET  /health              Estado del proxy');
  console.log('  GET  /api/engine-status   Estado real del motor IA (?engine=gemini|claude)');
  console.log('  GET  /api/analyze-progress  SSE progreso');
  console.log('  POST /api/upload          Subir documento');
  console.log('  POST /api/analyze         Analizar');
  console.log('  POST /api/generate-cases         M4  Generar Escenarios y Casos QA (Claude Opus)');
  console.log('  POST /api/generate-plan          M3  Plan de Pruebas (inicio de ciclo)');
  console.log('  POST /api/estimate-complexity    M2  Estimador QA - complejidad del requerimiento');
  console.log('  POST /api/verify-evidence        M4  Veredicto IA sobre evidencia');
  console.log('  POST /api/generate-certification M7c Certificacion de Calidad\n');
});
