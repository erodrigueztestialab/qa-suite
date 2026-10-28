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
const huValidator = require('./validators/huValidator.js');
const planValidator = require('./validators/planValidator.js');
const casesValidator = require('./validators/casesValidator.js');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ImageRun, AlignmentType, BorderStyle, ShadingType, Header, Footer, PageNumber,
} = require('docx');
const { pipeline } = require('@huggingface/transformers');

const app  = express();
const PORT = 3001;
const ENGINE_DEFAULT = 'claude'; // 'gemini' | 'claude' -- Gemini/Antigravity tiene cuota semanal ajustada, no debe ser el default silencioso

// ── Chatbot QA: base de conocimiento = Confluence Cloud ────────────────────────
// Mismo patron de config que CLAUDE_CLI_PATH/AGY_CLI_PATH -- variables de entorno
// simples seteadas antes de arrancar el proxy, sin agregar dotenv como dependencia
// nueva. El token se genera en id.atlassian.com/manage-profile/security/api-tokens
// -- NUNCA hardcodear un valor real aca, solo leerlo de process.env.
var CONFLUENCE_BASE_URL     = process.env.CONFLUENCE_BASE_URL || '';
var CONFLUENCE_EMAIL        = process.env.CONFLUENCE_EMAIL || '';
var CONFLUENCE_API_TOKEN    = process.env.CONFLUENCE_API_TOKEN || '';
var CONFLUENCE_FOLDER_ID    = process.env.CONFLUENCE_FOLDER_ID || '';
var CONFLUENCE_SYNC_MINUTES = parseFloat(process.env.CONFLUENCE_SYNC_MINUTES || '20');

function confluenceConfigured() {
  return !!(CONFLUENCE_BASE_URL && CONFLUENCE_EMAIL && CONFLUENCE_API_TOKEN && CONFLUENCE_FOLDER_ID);
}

// Pegarle a la API de Confluence en CADA pregunta seria lento/innecesario (a
// diferencia de leer una carpeta local, que es casi gratis) -- se cachea el
// resultado y solo se vuelve a llamar a la API si paso mas de
// CONFLUENCE_SYNC_MINUTES desde el ultimo fetch exitoso.
var _confluenceCache = { fetchedAtMs: 0, pages: [] };

function confluenceAuthHeader() {
  return 'Basic ' + Buffer.from(CONFLUENCE_EMAIL + ':' + CONFLUENCE_API_TOKEN).toString('base64');
}

// Devuelve [{relPath, content}] -- la forma que espera ensureKnowledgeIndex().
// `relPath` es el titulo de la pagina (para citar la fuente en la respuesta del
// chatbot).
async function fetchConfluencePages() {
  var ageMs = Date.now() - _confluenceCache.fetchedAtMs;
  if (_confluenceCache.fetchedAtMs && ageMs < CONFLUENCE_SYNC_MINUTES * 60000) {
    return _confluenceCache.pages;
  }
  var pages = [];
  var url = CONFLUENCE_BASE_URL + '/wiki/rest/api/content/' + CONFLUENCE_FOLDER_ID + '/descendant/page?expand=body.storage&limit=50';
  while (url) {
    var resp = await fetch(url, { headers: { 'Authorization': confluenceAuthHeader(), 'Accept': 'application/json' } });
    if (!resp.ok) {
      var errText = await resp.text().catch(function(){ return ''; });
      throw new Error('Confluence API respondio ' + resp.status + ': ' + errText.slice(0, 300));
    }
    var data = await resp.json();
    (data.results || []).forEach(function(page){
      var html = (page.body && page.body.storage && page.body.storage.value) || '';
      pages.push({ relPath: page.title, content: htmlToPlainText(html) });
    });
    url = (data._links && data._links.next) ? (CONFLUENCE_BASE_URL + data._links.next) : null;
  }
  _confluenceCache = { fetchedAtMs: Date.now(), pages: pages };
  return pages;
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
async function ensureKnowledgeIndex() {
  var files = await fetchConfluencePages();
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
// tocar cada endpoint. 'gemini-4-argon-low' ~ tier Sonnet (default, uso general),
// 'gemini-4-argon-high' ~ tier Opus (razonamiento mas alto, casos/cobertura/gaps).
// El 2026-10-21 agy se auto-actualizo (1.4.4) y retiro los gemini-3.1-pro-*: todas
// las llamadas Gemini fallaban con "invalid model selection". Por eso, ademas del
// mapa, callGemini() resuelve el modelo con "agy models" si el nombre deja de existir.
var GEMINI_MODEL_MAP = { opus: 'gemini-4-argon-high', sonnet: 'gemini-4-argon-low' };
var _geminiResolvedModel = {}; // tier -> modelo encontrado con "agy models" (cache del proceso)

// Equivalente del tier en la lista actual de "agy models": la familia Gemini principal
// (no Flash) con el mismo nivel (high/low) que el mapa. null si no hay ninguno.
function pickGeminiModel(modelsStdout, tier) {
  var level = tier === 'opus' ? 'high' : 'low';
  var ids = String(modelsStdout || '').split('\n').map(function(l){ return l.trim().split(/\s+/)[0]; })
    .filter(function(id){ return /^gemini-/i.test(id || '') && !/flash/i.test(id); });
  return ids.filter(function(id){ return new RegExp('-' + level + '$', 'i').test(id); })[0] || ids[0] || null;
}

// Resolver el binario de Antigravity CLI: env var explicita, el shim de winget
// (solo si existe en disco), la carpeta real de instalacion de winget (nombre con hash de
// publisher variable segun la version -- ej "Google.AntigravityCLI_Microsoft.
// Winget.Source_8wekyb3d8bbwe" -- por eso se busca por prefijo en vez de
// hardcodear el hash), y por ultimo el comando a secas resuelto por PATH.
function candidateGeminiBins() {
  var list = [];
  if (process.env.AGY_CLI_PATH) list.push(process.env.AGY_CLI_PATH);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    // El shim de Links no siempre se crea (depende de la version de winget); si
    // no existe se omite, para no hacer un spawn fallido en cada llamada.
    var linkBin = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'agy.exe');
    if (fs.existsSync(linkBin)) list.push(linkBin);
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
  var tier      = GEMINI_MODEL_MAP[opts.model] ? opts.model : 'sonnet';
  var model     = _geminiResolvedModel[tier] || GEMINI_MODEL_MAP[tier];
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

      // Modelo retirado por una actualizacion de agy: se busca el equivalente en
      // "agy models" y se reintenta una sola vez con ese nombre.
      if (result.code !== 0 && /invalid model selection|not recognized as a known model/i.test(result.stderr + result.stdout) && !opts._modelRetried) {
        var listed = await spawnGeminiOnce(bin, ['models'], 30000, null);
        var alt = listed.code === 0 ? pickGeminiModel(listed.stdout, tier) : null;
        if (alt && alt !== model) {
          console.log('!! GEMINI/AGY  modelo "'+model+'" ya no existe -> usando "'+alt+'"');
          _geminiResolvedModel[tier] = alt;
          return await callGemini(prompt, Object.assign({}, opts, { _modelRetried: true }));
        }
      }
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
    'persiste, define la variable de entorno AGY_CLI_PATH con la ruta completa al ejecutable ' +
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
// --print --output-format stream-json (modo headless del CLI).
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
    'define la variable de entorno CLAUDE_CLI_PATH con la ruta completa al ejecutable ' +
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
// Las tablas se aplanan como filas "| celda | celda |": sin esto las celdas de una
// misma fila quedaban pegadas ("NombreTexto50Si") o sueltas una por linea, y el
// modelo no podia leer bien los cuadros de campos/longitudes/obligatoriedad.
function htmlToPlainText(html) {
  return html
    .replace(/<table[^>]*>[\s\S]*?<\/table>/gi, function(table){
      var rows = extractTableRows(table).map(function(cells){
        return '| ' + cells.map(function(c){ return c.replace(/\s*\n\s*/g, ' '); }).join(' | ') + ' |';
      });
      return '\n\n' + rows.join('\n') + '\n\n';
    })
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
// Camino inverso de docxLabeledBulletList: "ID: campo - campo" -> "ID | campo | campo".
// Los " - " solo se cortan donde la seccion tiene columnas fijas (nivel del riesgo,
// tipo y titulo del escenario, area del impacto); en CA/RN el texto queda entero. Un
// Word exportado antes del cambio ("ID: campo | campo") se sigue aceptando tal cual.
function labeledBulletsToRawLines(items, tag) {
  return items.map(function(text){
    var m = tag === 'IMPACTOS' ? /^([^:|]+?):\s*(.*)$/.exec(text) : /^([A-Z_0-9]+):\s*(.*)/.exec(text);
    if (!m) return text;
    var id = m[1].trim(), rest = m[2];
    if (rest.indexOf('|') >= 0) return id + ' | ' + rest;
    var fields = [rest];
    if (tag === 'RIESGOS') {
      var lv = /^(Alto|Medio|Bajo)\s+-\s+([\s\S]*)$/i.exec(rest);
      if (lv) {
        var cut = lv[2].lastIndexOf(' - ');
        fields = [lv[1]].concat(cut >= 0 ? [lv[2].slice(0, cut), lv[2].slice(cut + 3)] : [lv[2]]);
      }
    } else if (tag === 'ESCENARIOS_QA') {
      var tp = /^(Positivo|Negativo|Borde)\s+-\s+([\s\S]*)$/i.exec(rest);
      if (tp) {
        var cut2 = tp[2].indexOf(' - ');
        fields = [tp[1]].concat(cut2 >= 0 ? [tp[2].slice(0, cut2), tp[2].slice(cut2 + 3)] : [tp[2]]);
      }
    }
    return id + ' | ' + fields.map(function(s){ return s.trim(); }).join(' | ');
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
    raw += '---' + s.tag + '---\n' + labeledBulletsToRawLines(out.sections[s.tag], s.tag) + '\n';
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
    'Minimo 6. Formato por linea: CA_N | Dado que [contexto], Cuando [accion], Entonces [resultado verificable]. [src: N,N]',
    '',
    '---REGLAS_DE_NEGOCIO---',
    'Minimo 4. Formato por linea: RN_N | Descripcion tecnica especifica con condiciones. [src: N,N]',
    '',
    '---RIESGOS---',
    'Minimo 4. Formato: R_N | Alto/Medio/Bajo | Descripcion | Impacto (con "puede"/"posible" si el documento no lo declara). [src: N,N]',
    '',
    '---IMPACTOS---',
    'Formato: AREA | Descripcion del impacto tecnico y funcional (con "puede"/"posible" si el documento no lo declara).',
    '',
    '---ESCENARIOS_QA---',
    'Minimo 6. Formato: ESC_N | Positivo/Negativo/Borde | Titulo | Descripcion con marcadores abstractos (N, N-1, X, valor dentro/fuera del limite). [src: N,N] [cubre: CA_N,RN_N]',
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
function buildAnalysisFileRefBlock(files) {
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
  return fileRefLines.length
    ? 'Usa tu herramienta de lectura de archivos EN PARALELO sobre estas ' + fileRefLines.length + ' ruta(s) exactas antes de responder:\n' +
      fileRefLines.map(function(l, i){ return (i+1) + '. ' + l; }).join('\n')
    : '';
}

// ── M1, pasada 1 (ambos motores): inventario de condiciones + glosario ────────
// Nacio para Gemini, que se ancla en los "Minimo N" de cada seccion aunque el prompt
// pida exhaustividad (medido el 2026-10-02: 7-10 CA en una pasada, 14-16 con
// inventario previo). Desde la auditoria de alineacion del HU corre en AMBOS motores:
// el inventario (con estado, referencia y glosario) es la base contra la que el
// validador deterministico y el auditor comparan el HU (validators/huValidator.js).
function buildAnalysisInventoryPrompt(files) {
  return [
    'Eres un Analista de Requerimientos senior. Lee integralmente ' +
      (files.length > 1 ? 'los ' + files.length + ' archivos, que en conjunto conforman UN MISMO requerimiento' : 'el documento de requerimiento') +
      ' (texto, tablas, imagenes, diagramas).',
    'Tu UNICA tarea: enumerar en una lista plana CADA condicion atomica y verificable que el requerimiento contiene o implica:',
    'reglas de negocio, validaciones, atributos de cada campo (tipo, longitud, obligatoriedad, formato, mensajes),',
    'transiciones de estado, limites y umbrales, tiempos, mensajes del sistema, permisos, excepciones, casos limite,',
    'dependencias, supuestos, riesgos que el documento declara y lo que el documento deja fuera del alcance.',
    'Registra tambien lo que NO es comportamiento del sistema (objetivo, antecedentes, tareas del proyecto...) con su',
    'Tipo de contexto, para que no se confunda con una regla.',
    '',
    'Formato, una condicion por linea:  N | Tipo | Estado | Ref | Condicion',
    '- N: numero consecutivo desde 1.',
    '- Tipo: Regla, Validacion, Campo, Estado, Limite, Mensaje, Permiso, Excepcion, Dependencia, Supuesto, Riesgo o',
    '  EXCLUSION. EXCLUSION es SOLO para lo que el documento declara fuera del alcance; lo que se deja para otra fase,',
    '  otro mejoramiento o "despues" tambien es EXCLUSION (no Contexto).',
    '  Tipos de CONTEXTO (no son comportamiento del sistema; nunca usar Regla para ellos):',
    '  Objetivo = proposito o beneficio esperado ("optimizar", "reducir", "mejorar"); Contexto = antecedentes, como',
    '  funciona hoy (situacion actual o comportamiento estandar que no cambia), desarrollos previos, ambiente, pais o',
    '  etapa de despliegue; Tarea = actividad o compromiso del proyecto que hace una persona o equipo (evaluar, estimar,',
    '  conseguir accesos o credenciales, localizar o descubrir codigo, entregar evidencias o documentos; aunque algo',
    '  dependa de ella, es Tarea y no Dependencia); Decision = alternativa tecnica o de diseno que debe',
    '  resolver el equipo de desarrollo; IndicacionPrueba = como, donde o con que datos conviene probar.',
    '- Estado: DEFINIDO, PENDIENTE o CONTRADICCION. Es PENDIENTE todo lo que el documento marque como por definir,',
    '  abierto, en revision, dependencia sin resolver, supuesto sin confirmar o pregunta abierta. Es CONTRADICCION',
    '  cuando el requerimiento dice dos cosas incompatibles sobre el mismo punto (entre archivos o dentro del mismo) y',
    '  ninguna corrige explicitamente a la otra; en Condicion escribe las dos: "Version 1: ...; Version 2: ...". Si una',
    '  fuente posterior corrige de forma explicita a la anterior ("ya no", "se cambia", "mejor"), no es contradiccion:',
    '  registra solo la version vigente.',
    '- Ref: la etiqueta o codigo propio que el documento le da (por ejemplo, DEP-01 o SUP-2). Vacia si no tiene. La',
    '  numeracion de una lista (1., 2., a), b)) NO es una Ref.',
    '- Condicion: redactada con la MISMA fuerza que el original: conserva el modal ("puede", "debe", "deberia"), la',
    '  premisa si la hay ("si X ocurre, podria Y") y los terminos y nombres propios tal cual los escribe el documento.',
    '  Si el documento asigna criticidad, severidad o prioridad, agregala al final: "Criticidad: Alta".',
    'No agrupes dos condiciones en una linea. No resumas. No agregues nada que el documento no diga.',
    '',
    'Despues de la lista, una linea ---GLOSARIO--- y debajo, uno por linea:  Termino | Tipo',
    'con los terminos y nombres propios del documento escritos exactamente como el documento los escribe:',
    'proveedores y terceros, sistemas y plataformas, pantallas, procesos, roles, documentos y codigos.',
    'Tipo: Proveedor, Sistema, Pantalla, Proceso, Rol, Documento u Otro.',
    '',
    'No cites la fuente ni nombres de archivos o personas. Responde SOLO con la lista y el glosario.',
    '',
    buildAnalysisFileRefBlock(files),
  ].join('\n');
}

// Reglas de redaccion del HU (brief de alineacion M1). Genericas: aplican a cualquier
// requerimiento; los ejemplos son neutros a proposito.
var REGLAS_ALINEACION_HU = [
  'REGLAS DE ALINEACION CON EL REQUERIMIENTO (obligatorias, se validan automaticamente despues):',
  'A. FIDELIDAD: cada afirmacion debe tener respaldo en el requerimiento. No agregues hechos, entidades ni calificativos',
  '   de magnitud (bajo, alto, critico, masivo, en tiempo real) que el documento no use. Usa los terminos del documento',
  '   tal cual y los nombres propios del GLOSARIO sin cambiarlos por genericos (MAL: "un tercero". BIEN: el nombre que',
  '   usa el documento). Las consecuencias que el documento no declara y tu infieres (columna de impacto de un riesgo,',
  '   seccion IMPACTOS) se escriben con "puede" o "posible", nunca como hecho.',
  'B. MODALES Y PREMISAS: conserva la fuerza del original: "puede" no es "debe"; "sin esperas por X" no es "sin X".',
  '   Si la fuente plantea algo con premisa ("si X ocurre, podria Y"), el item conserva la premisa y el modal.',
  'C. PENDIENTES: todo CA, RN o ESC que derive de un item PENDIENTE o CONTRADICCION del inventario termina con',
  '   "Condicionado a <Ref>" (o una descripcion corta si no tiene Ref; para una contradiccion, "Condicionado a confirmar',
  '   <tema>"). Todo ESC que cubre un CA o RN condicionado lleva esa MISMA condicion. Una CONTRADICCION nunca se resuelve',
  '   eligiendo una version: un R_N describe las dos versiones y el resultado esperado no fija ninguna.',
  '   La justificacion del riesgo no puede contradecir el estado del inventario (no digas que algo "sigue sin',
  '   definirse" si esta DEFINIDO, ni lo trates como definido si esta PENDIENTE). Si el documento define un mismo',
  '   punto de dos maneras, no elijas en silencio: marcalo condicionado y registra un riesgo.',
  'D. ABSOLUTOS: "solo", "siempre", "nunca", "unicamente" en un CA o RN exigen que ninguna otra regla lo exceptue.',
  '   Si existe una excepcion, va en el MISMO enunciado ("solo cuando X, salvo Y").',
  'E. RIESGOS: si el documento asigna criticidad a un elemento, el nivel del R_N la hereda (Alta=Alto, Media=Medio,',
  '   Baja=Bajo). Todo PENDIENTE aparece en al menos un R_N.',
  'F. ESCENARIOS: usa marcadores abstractos (N, N-1, X, "valor dentro del limite", "valor fuera del limite") en lugar',
  '   de cifras inventadas; solo usa cifras que el requerimiento defina literalmente. Un ESC por alternativa: no',
  '   combines con "o" condiciones de prueba distintas. Todo CA tiene al menos un ESC. Todo PENDIENTE que afecte',
  '   comportamiento observable (lo cita un CA o una RN) tiene al menos un ESC condicionado.',
  'G. COBERTURA: todo item del inventario queda en al menos un CA, RN, R o ESC. Los items EXCLUSION se reflejan como',
  '   una RN de alcance ("... queda fuera del alcance"), sin ESC. Los items de contexto se rigen por la regla K.',
  'H. CODIGOS DEL DOCUMENTO: la prohibicion de citar la fuente es para meta-citas, NO para los codigos propios del',
  '   requerimiento (dependencias, supuestos, riesgos del documento), que si deben aparecer. MAL: "Segun el documento,',
  '   la notificacion depende del proveedor". BIEN: "La notificacion por correo se envia al aprobar. Condicionado a DEP-01".',
  'I. CONVENCIONES: "Por ejemplo," con coma despues de "ejemplo"; "Cliente" con mayuscula cuando es un rol; sin rayas',
  '   largas (em dash). Las etiquetas del inventario (PENDIENTE, DEFINIDO, CONTRADICCION, "Version 1:") son internas:',
  '   en el HU se escribe en lenguaje natural ("esta por definir", "hay dos versiones: ... y ...").',
  'J. TRAZABILIDAD: cada linea de CA, RN, R y ESC termina con [src: N,N] (los numeros N del inventario de los que sale).',
  '   Cada ESC termina ademas con [cubre: CA_N,RN_N] (los CA/RN que valida). Estas marcas son internas: la herramienta',
  '   las quita antes de mostrar el HU. No las pongas en HISTORIA_DE_USUARIO, JUSTIFICACION_RIESGO ni IMPACTOS.',
  'K. CONTEXTO NO ES REGLA: los items de Tipo Objetivo, Contexto, Tarea, Decision o IndicacionPrueba NO son',
  '   comportamiento del sistema: ningun CA, RN ni ESC sale solo de ellos. El objetivo va en el "Para" de la HU; el',
  '   contexto y las decisiones, en la justificacion del riesgo o los impactos si aportan; toda Tarea o Decision',
  '   PENDIENTE va en un R_N (lo que puede pasar si no se resuelve). Lo que el sistema debe hacer distinto de como',
  '   funciona hoy si es CA o RN; como funciona hoy, no. Una RN nunca dice que algo "no esta definido": eso es un R_N.',
  '   Solo un pendiente que gobierna un CA o una RN necesita ESC condicionado; uno que solo vive en un R_N, no.',
  'L. UNA RN NO REPITE UN CA: el CA dice el comportamiento observable (Dado/Cuando/Entonces) y la RN la regla o',
  '   restriccion que lo gobierna (limites, excepciones, condiciones, formulas, atributos de campos). Si lo que dirias',
  '   como RN ya queda dicho completo en un CA, no escribas la RN: el item del inventario queda cubierto por el CA.',
  '   Un campo que solo se nombra (sin atributos) se cubre dentro del CA que lo usa, sin RN propia.',
].join('\n');

// inventoryPath: .txt con el inventario + glosario de la pasada 1 (ambos motores).
function buildMultiFileAnalysisPrompt(files, engine, inventoryPath) {
  var refBlock = buildAnalysisFileRefBlock(files);
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
    inventoryPath
      ? 'INVENTARIO PREVIO: en ' + inventoryPath + ' hay un inventario numerado de las condiciones atomicas del requerimiento ' +
        '(N | Tipo | Estado | Ref | Condicion) y, despues de ---GLOSARIO---, los terminos y nombres propios del documento. ' +
        'Leelo tambien. Cada item del inventario debe quedar reflejado en tu analisis (regla G) y citado por su N en [src]. ' +
        'No copies el inventario tal cual: redactalo en el formato de cada seccion.\n'
      : null,
    'INSTRUCCIONES CRITICAS:',
    '1. NO uses plantillas genericas ni frases de relleno.',
    '2. NO asumas que el riesgo siempre es ALTO. Evalua el riesgo solo con factores que el documento permita sustentar',
    '   (complejidad tecnica, integraciones, dependencias, pendientes, criticidades declaradas, etc.). Si el documento no',
    '   trata un factor (por ejemplo, impacto financiero, usuarios afectados o reversibilidad), no lo afirmes ni lo niegues.',
    '   Cada factor que cites en la justificacion debe existir en el documento.',
    '3. TODOS los criterios de aceptacion deben ser verificables, medibles y especificos.',
    '4. Las reglas de negocio deben surgir de los documentos, no inventarse.',
    '5. COBERTURA EXHAUSTIVA, sin techo: en Criterios de Aceptacion, Reglas de Negocio, Riesgos y Escenarios QA, el "Minimo" que',
    '   pide cada seccion es un PISO para documentos escuetos, no una meta a cumplir y detenerte ahi. Identifica y lista CADA',
    '   condicion, regla, riesgo o escenario atomico y verificable que el documento (y sus anexos/transcripciones si los hay)',
    '   permita sustentar, sin importar si terminan siendo 6 o 30 -- la cantidad la determina lo que el requerimiento realmente',
    '   contiene, no un numero comodo. No agrupes dos aserciones verificables distintas bajo un mismo ID (CA_N/RN_N/R_N/ESC_N)',
    '   solo para reducir la cantidad total -- cada ID debe quedar centrado en UNA sola condicion verificable. Solo evita',
    '   duplicar literalmente la misma asercion dos veces.',
    '6. CUADROS Y TABLAS DE CAMPOS: si el documento trae cuadros/tablas que describen campos (diccionario de datos, campos',
    '   de un formulario, pantalla, archivo o reporte, con columnas como tipo, longitud, obligatoriedad, formato, valores',
    '   permitidos, etc.), analizalos fila por fila, sin resumirlos ni agruparlos. En el texto las tablas llegan como filas',
    '   "| celda | celda |" (la primera fila suele ser el encabezado); tambien pueden venir dentro de imagenes o del PDF.',
    '   Genera UNA regla de negocio por CADA campo, con TODOS los atributos que el cuadro documenta para ese campo: tipo de',
    '   dato, longitud minima/maxima, obligatoriedad, formato o mascara, valores permitidos, valor por defecto, si es',
    '   editable o de solo lectura, validaciones y mensajes de error. Ejemplo: RN_12 | Campo "Razon social" (pantalla Alta',
    '   de proveedor): texto, maximo 100 caracteres, obligatorio, admite letras, numeros y espacios. NO inventes atributos',
    '   que el cuadro no trae, y no omitas ningun campo del cuadro.',
    '7. REDACCION: escribe los criterios, reglas, riesgos y escenarios como enunciados sobre el comportamiento del sistema,',
    '   en lenguaje claro y natural, con la misma fuerza que el original (regla B). NUNCA cites ni atribuyas la fuente de la informacion: prohibido escribir cosas como "en la',
    '   reunion se dijo", "segun la transcripcion", "el documento indica", "el cliente menciono", "se acordo que", ni',
    '   nombres de personas o de archivos. MAL: "Segun lo conversado en la reunion, el NIT es obligatorio". BIEN: "El NIT',
    '   es obligatorio para registrar el proveedor".',
    multi
      ? '8. Si una fuente posterior (ej: una transcripcion de reunion) corrige de forma explicita a una anterior, deja en los ' +
        'CA/RN solo la version que prevalece, redactada como hecho (regla 7). Si dicen cosas incompatibles sin que una corrija ' +
        'a la otra (o la misma fuente dice dos cosas), es un item CONTRADICCION del inventario: aplica la regla C (condicionado ' +
        '+ riesgo con las dos versiones), sin atribuirlo a personas ni a reuniones.'
      : null,
    (multi ? '9' : '8') + '. Responde UNICAMENTE con las secciones delimitadas. Sin texto adicional.',
    '',
    REGLAS_ALINEACION_HU,
    '',
    ORTOGRAFIA_DOC_CLIENTE,
    '',
    refBlock,
    '',
    outputSectionsBlock(),
  ].filter(function(l){ return l !== null; }).join('\n');
}

// ── M1: auditor semantico del HU (una llamada, Sonnet medium, ambos motores) ───
// Recibe por RUTA (agy recibe el prompt por argumento: ENAMETOOLONG) el inventario,
// el HU con trazas y los hallazgos del validador deterministico, y busca lo que un
// regex no puede decidir: contradicciones, afirmaciones sin sustento o mas fuertes
// que la fuente y pendientes no marcados. Devuelve JSON.
function buildHUAuditorPrompt(files, inventoryPath, huPath, findingsPath) {
  return [
    'Eres un auditor de calidad de Historias de Usuario. Tu tarea es verificar que el HU este alineado con el requerimiento',
    'fuente. NO reescribas el HU: solo reporta defectos concretos.',
    '',
    'Lee estos archivos:',
    '- Inventario numerado del requerimiento (N | Tipo | Estado | Ref | Condicion) y glosario: ' + inventoryPath,
    '- HU a auditar (cada linea trae [src: N] con los items del inventario de los que sale, y los ESC [cubre: ...]): ' + huPath,
    '- Hallazgos del validador automatico (JSON; los de severidad "juicio" necesitan tu decision): ' + findingsPath,
    '- El requerimiento original, si necesitas confirmar algo:',
    buildAnalysisFileRefBlock(files),
    '',
    'Busca SOLO estos tipos de defecto:',
    '- CONTRADICCION: dos secciones o items se contradicen (por ejemplo, la justificacion dice que algo sigue sin',
    '  definirse y un CA/RN ya lo define; una RN dice "solo cuando X" y otra agrega un caso adicional sin que la primera',
    '  lo mencione). Revisa en especial la justificacion del riesgo contra los CA/RN y contra el Estado del inventario.',
    '- SIN_SUSTENTO: afirmaciones, entidades, calificativos o valores que el requerimiento no respalda; nombres propios',
    '  del glosario cambiados por un generico; terminos del documento parafraseados con otro sentido; consecuencias',
    '  inferidas escritas como hecho (sin "puede"/"posible").',
    '- MAS_FUERTE_QUE_FUENTE: el item es mas categorico que la fuente ("puede" -> "debe", "sin esperas por X" -> "sin X",',
    '  una premisa "si X, podria Y" escrita como hecho).',
    '- PENDIENTE_NO_MARCADO: un item describe como firme algo que el inventario tiene PENDIENTE o CONTRADICCION, sin',
    '  "Condicionado a"; o resuelve una CONTRADICCION eligiendo una de sus versiones.',
    '- SIN_SUSTENTO tambien: un CA, RN o ESC que convierte en comportamiento del sistema algo que es objetivo, contexto,',
    '  tarea del proyecto, decision tecnica o indicacion de prueba (aunque el inventario no lo haya marcado asi).',
    'Para cada hallazgo "juicio" del validador decide si es un defecto real; si lo es, reportalo con uno de estos tipos.',
    'No reportes estilo, ni cosas que el requerimiento si respalda. Si no hay defectos, responde [].',
    '',
    'Responde SOLO con un arreglo JSON, sin texto adicional ni bloque de codigo:',
    '[{"id":"<ID del item, ej. RN_2, o JUSTIFICACION_RIESGO>","tipo":"<CONTRADICCION|SIN_SUSTENTO|MAS_FUERTE_QUE_FUENTE|PENDIENTE_NO_MARCADO>",',
    '  "evidencia":"<que dice el HU y que dice la fuente>","correccion_propuesta":"<como deberia quedar>"}]',
  ].join('\n');
}

// ── M1: reparacion acotada del HU (una llamada, maximo una iteracion) ──────────
// Aplica SOLO las correcciones de los hallazgos aceptados; el resto del HU debe salir
// identico. No es una regeneracion.
function buildHURepairPrompt(files, inventoryPath, huPath, findingsPath) {
  return [
    'Eres un Analista de Requerimientos senior. Debes CORREGIR un HU aplicando unicamente los hallazgos indicados.',
    '',
    'Lee estos archivos:',
    '- Inventario numerado del requerimiento y glosario: ' + inventoryPath,
    '- HU actual, con marcas [src: N] y [cubre: ...]: ' + huPath,
    '- Hallazgos a corregir (JSON): ' + findingsPath,
    '- El requerimiento original, si necesitas confirmar algo:',
    buildAnalysisFileRefBlock(files),
    '',
    'REGLAS DE LA CORRECCION:',
    '1. Corrige SOLO los items que mencionan los hallazgos. Todas las demas lineas deben quedar EXACTAMENTE iguales.',
    '2. Si un hallazgo pide cobertura que falta (un CA sin escenario, un item del inventario sin reflejo, un pendiente',
    '   sin riesgo o sin escenario condicionado), agrega el item nuevo al final de su seccion con el siguiente numero.',
    '3. Si eliminas un item, renumera la seccion para que los IDs queden continuos y actualiza las referencias a esos IDs',
    '   (en el texto y en [cubre]).',
    '3.1 V14 (sale solo de contexto): elimina el CA, RN o ESC; si el item de contexto esta PENDIENTE y no tiene R_N, agrega',
    '   el riesgo. V15 (RN que repite un CA): elimina la RN (o dejala solo con lo que el CA no dice) y en [cubre] de los',
    '   ESC cambia esa RN por el CA que la repite.',
    '3.2 V16 (RN que solo dice que algo no esta definido): quitala de REGLAS_DE_NEGOCIO, asegura un R_N con ese punto y',
    '   cambia en [cubre] de los ESC esa RN por el CA que dependa de la definicion (o elimina el ESC si no cubre nada mas).',
    '4. Conserva el formato de cada seccion y las marcas [src: N] y [cubre: ...] en cada linea de CA, RN, R y ESC.',
    '5. Respeta estas reglas mientras corriges:',
    REGLAS_ALINEACION_HU,
    '',
    ORTOGRAFIA_DOC_CLIENTE + ' Conserva las tildes que ya trae el HU.',
    '',
    'Responde con el HU COMPLETO corregido, con TODAS las secciones delimitadas en este orden y sin texto adicional:',
    '---HISTORIA_DE_USUARIO--- ---NIVEL_RIESGO_GLOBAL--- ---JUSTIFICACION_RIESGO--- ---CRITERIOS_DE_ACEPTACION---',
    '---REGLAS_DE_NEGOCIO--- ---RIESGOS--- ---IMPACTOS--- ---ESCENARIOS_QA---',
  ].join('\n');
}

// Extrae el primer arreglo JSON de la respuesta del auditor (tolera texto o ``` alrededor).
function parseAuditorJson(text) {
  var s = String(text || '');
  var a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b < a) return null;
  try {
    var arr = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (e) { return null; }
}

// Demo 2026-10-08 (Liz): los casos deben ser ejecutables por el QA en el ambiente de
// pruebas, sobre flujos reales del usuario -- no pruebas que en la practica se
// desestiman porque no se pueden hacer. Generico: aplica a cualquier requerimiento.
var REGLA_CASOS_OPERATIVOS =
  'CASOS OPERATIVOS Y EJECUTABLES: cada caso debe poder ejecutarlo un QA en el ambiente de pruebas siguiendo un flujo\n' +
  '   real del usuario del negocio, con las pantallas, datos y permisos que ese ambiente normalmente ofrece. NO generes\n' +
  '   casos de carga, estres, rendimiento con volumenes masivos, concurrencia, seguridad/penetracion, ni casos que exijan\n' +
  '   herramientas especiales o condiciones que el QA no puede producir (caidas de servidor, millones de registros,\n' +
  '   manipular la base de datos, esperar dias reales). Si el analisis menciona un requisito no funcional, conviertelo\n' +
  '   SOLO en lo que el usuario puede observar al operar (ej: que un proceso se ejecuta en segundo plano sin bloquear la\n' +
  '   pantalla), o no lo conviertas en caso si no es observable.';

// Reglas de alineacion de los casos con el requerimiento (brief de M4). Genericas; se
// validan despues con validators/casesValidator.js. Las usan generacion, faltantes,
// consolidacion y reparacion.
var REGLAS_ALINEACION_CASOS = [
  'REGLAS DE ALINEACION CON EL REQUERIMIENTO (obligatorias, se validan automaticamente despues):',
  'A. LA CONDICION VIAJA COMPLETA: si un CA_N, RN_N o ESC_N esta "Condicionado a <Ref>" (o sale de un item PENDIENTE del',
  '   inventario), cada caso que lo cubre lleva "Condicionado a <Ref>" en el titulo (Caso) o en el Objetivo, con TODOS',
  '   los codigos que apliquen, y su resultado esperado NO inventa lo que la definicion pendiente aun no fija (describe',
  '   que se verifica "segun lo que defina <Ref>"). La condicion es la misma que en la HU y en el plan.',
  'B. UN CASO, UN COMPORTAMIENTO: prohibido "A o B" en un resultado esperado. Si hay dos alternativas posibles, son dos',
  '   casos (cada uno condicionado a lo que lo define) o un caso que describe de que definicion depende.',
  'C. EXCLUSIONES: un item EXCLUSION del inventario (lo que queda fuera del alcance) se cubre SOLO con un caso negativo que',
  '   verifica que esa capacidad NO ocurre. Nunca generes un caso que ejecute la funcionalidad excluida. Ninguna otra',
  '   regla de este prompt te obliga a probar algo excluido.',
  'D. COBERTURA POR TRAZABILIDAD, NO POR CANTIDAD: todo CA_N, RN_N, ESC_N y cada item de "Dentro del Alcance" del plan tiene',
  '   al menos un caso. Ningun caso se agrega para llegar a un numero; no hay minimos.',
  'E. FIDELIDAD: un resultado esperado no puede ser mas fuerte que su fuente. Conserva los modales ("puede", "podria",',
  '   "si ..., entonces ..."); no inventes plazos, "tiempo real" ni obligaciones ("exige"); no conviertas un dano',
  '   comercial en legal o normativo.',
  'F. NOMBRES Y TERMINOS: usa los nombres del GLOSARIO y los terminos exactos del requerimiento (si el documento dice',
  '   "solicitud", no escribas "solicitud de integracion"); nunca genericos como "terceros" o "el proveedor" cuando la',
  '   fuente nombra al actor. El campo Escenario usa el titulo EXACTO de un ESC_N de la HU (salvo el caso negativo de una',
  '   exclusion, que no tiene ESC).',
  'G. CONVENCIONES: "Cliente" con mayuscula cuando es un rol; "por ejemplo," con coma despues y nunca antes; los datos que',
  '   el caso invente van como N, N-1 o X (las cifras que el requerimiento define si se usan). Tipo SOLO Smoke, Funcional,',
  '   UI o UX. Cada paso tiene su resultado esperado (mismo numero de pasos y de resultados). La complejidad y el riesgo',
  '   del caso heredan los del CA o escenario que cubre.',
  'I. UN CASO POR FLUJO: lo que se verifica en la misma ejecucion (precargas de una pantalla, botones, datos de un',
  '   registro) son pasos de UN caso que cita todos los CA/RN/ESC que cubre; los valores invalidos de un mismo dato, un',
  '   caso con un paso por valor. "Conjunto exacto" o "auditoria campo por campo" SOLO si un CA/RN exige exactitud.',
  'J. NADA DE CONTEXTO COMO CASO: objetivo, antecedentes, tareas del proyecto (accesos, ubicar codigo, estimar),',
  '   decisiones tecnicas, ambiente o pais de despliegue no se prueban como caso; son precondiciones o notas del plan.',
  'H. MARCAS INTERNAS: la linea del ID de cada caso termina con [src: ...] (el CA_N/RN_N/ESC_N o el codigo del inventario',
  '   del que sale) y [cubre: ...] (todos los CA_N/RN_N/ESC_N que valida). Ej: "### CP_4 [src: CA_4,DEP-01] [cubre: CA_4,',
  '   ESC_4]". La herramienta las quita antes de mostrar o exportar. El campo "Requisito" sigue citando los CA_N/RN_N.',
].join('\n');

// Bloque de contexto estructurado de M1/M3 para los prompts de M4 (archivos por ruta:
// agy recibe el prompt por argumento y un plan + inventario inline lo harian crecer).
function casesCtxBlock(ctx) {
  if (!ctx || !ctx.inventoryPath) return '';
  var glossary = (ctx.glossary || []).map(function(g){ return g.termino + (g.tipo ? ' (' + g.tipo + ')' : ''); }).join('; ');
  return [
    '',
    'CONTEXTO ESTRUCTURADO (leelo con tu herramienta de lectura de archivos antes de responder):',
    '- Inventario numerado del requerimiento (N | Tipo | Estado | Ref | Condicion) y glosario: ' + ctx.inventoryPath +
      ' -- dice que esta PENDIENTE (y su codigo), que es EXCLUSION y que nombres se conservan.',
    ctx.planPath ? '- Plan de Pruebas aprobado (alcance condicionado, supuestos, riesgos, tipos y niveles): ' + ctx.planPath : null,
    glossary ? '- GLOSARIO (nombres que se conservan tal cual): ' + glossary : null,
  ].filter(function(l){ return l !== null; }).join('\n');
}

// ── Build prompt: Escenarios y Casos QA ────────────────────────────────────────
// Toma el analisis crudo de M1 (todas sus secciones) + la configuracion que el
// QA confirmo en M2 (notas/areas validadas) y pide los casos
// en el formato exacto de la plantilla real de TestIALab (ver handoff).
// ctx (opcional, desde M1/M3): { inventoryPath, planPath, glossary }. Sin inventario
// los casos se generan como antes (sin marcas ni validacion).
function buildCasesPrompt(analysisRaw, m2Context, engine, transcripts, ctx) {
  m2Context = m2Context || {};
  ctx = ctx || {};
  var areas = (m2Context.impactAreas || []).filter(function(a){ return a.checked; })
    .map(function(a){ return a.label + (a.desc ? ': ' + a.desc : ''); }).join('\n') || 'Ninguna area especifica marcada.';
  var transcriptsBlock = (transcripts && transcripts.length)
    ? [
        '',
        'TRANSCRIPCIONES ADICIONALES (reuniones posteriores al analisis inicial -- el requerimiento pudo',
        'cambiar desde la primera reunion de contextualizacion; si algo aqui contradice o amplia el analisis',
        'de arriba, esta informacion mas reciente tiene prioridad). Usalas solo como contexto para entender el',
        'requerimiento: los casos NUNCA deben mencionar la reunion, la transcripcion ni a quien dijo que (ver regla 8):',
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
    casesCtxBlock(ctx),
    '',
    'CONFIGURACION DEFINIDA POR EL QA:',
    'Areas de impacto validadas:',
    areas,
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Cobertura OBLIGATORIA sin excepcion: TODOS los criterios de aceptacion (CA_N) y TODAS las reglas de negocio (RN_N)',
    '   listados en el analisis deben quedar cubiertos por al menos un caso de prueba. No omitas ninguno.' +
      (ctx.inventoryPath ? ' Lo mismo para cada escenario QA (ESC_N) y cada item de "Dentro del Alcance" del plan.' : ''),
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
    '   (c) Ademas, dos tipos de caso adicionales, SOLO cuando un CA_N/RN_N lo exige explicitamente (por ejemplo, "solo',
    '   estas columnas" o "copiar todos los campos del origen") -- no por cada CA_N/RN_N que pudiera admitirlos, y nunca para',
    '   llegar a un numero de casos: primero, si un CA_N/RN_N define un CONJUNTO configurable de elementos que el sistema debe',
    '   mostrar/procesar (columnas de un reporte, campos de un filtro, opciones seleccionadas, etc.), genera un caso que',
    '   valide el CONJUNTO EXACTO -- no solo que los elementos esperados esten presentes, sino tambien que no aparezca',
    '   NINGUN elemento adicional no configurado (ni de mas, ni de menos). Segundo, si un CA_N/RN_N describe que un',
    '   registro/reporte HEREDA, REMAPEA o COPIA campos desde un documento/registro origen hacia un destino, genera un',
    '   caso de AUDITORIA CAMPO POR CAMPO dedicado que compare TODOS los campos remapeados contra el origen de uno en',
    '   uno -- esto es distinto y adicional a los casos que ya validan campos especificos por separado; cubre el remapeo',
    '   completo como unidad, no reemplaza a esos otros casos. Si VARIOS flujos lo exigen explicitamente, cada uno tiene',
    '   el suyo. Si ningun CA_N/RN_N lo exige con palabras de exactitud ("exactamente", "solo estas columnas", "ni mas ni',
    '   menos", "todos los campos"), NO generes estos casos: que un CA liste campos o precargas no es exigir exactitud',
    '   (sus campos se verifican como pasos del caso de ese flujo, regla 4).',
    '   (e) ENTRADAS DEL USUARIO: por cada dato que el usuario digita o escanea en el flujo (cantidades, codigos,',
    '   ubicaciones, fechas, textos), genera UN caso negativo que agrupe, un paso por valor, las clases invalidas que',
    '   tienen sentido para ese dato (vacio, cero, negativo, no numerico, mayor al disponible o al maximo, inexistente,',
    '   igual al origen, de otro almacen o entidad, etc.) y, si el requerimiento define un limite, un caso de borde con el',
    '   valor justo en el limite. Solo clases que apliquen al dato; si el requerimiento no define el mensaje, el',
    '   resultado esperado dice que el sistema no permite continuar o rechaza el valor, sin inventar el texto del mensaje.',
    '   Si un CA_N/RN_N ya cubre una de esas clases, ese caso la incluye como paso (no un caso aparte).',
    '   (d) VALIDACION DE CAMPOS: por CADA RN_N que especifique un campo con sus atributos (tipo, longitud, obligatoriedad,',
    '   formato, valores permitidos, etc.), genera UN caso dedicado a ese campo, con un paso por cada validacion que el',
    '   RN_N documente, segun aplique: dejarlo vacio si es obligatorio (se rechaza con el mensaje correspondiente),',
    '   ingresar exactamente la longitud maxima permitida (se acepta), superar la longitud maxima en un caracter (se',
    '   rechaza o se trunca, segun lo que diga el requerimiento), ingresar un tipo o formato invalido (se rechaza), elegir',
    '   o ingresar un valor fuera de la lista permitida (se rechaza), y un valor valido (se acepta). Solo las validaciones',
    '   que el RN_N documenta -- no inventes restricciones. Un caso por campo: no juntes varios campos en un mismo caso.',
    '   Ese caso por campo ABSORBE todas las validaciones de ese campo: en "Requisito" cita el RN_N del campo MAS todos los',
    '   CA_N (y RN_N) cuyo unico objetivo es una restriccion de ese mismo campo (vacio, longitud, formato, tipo, valores',
    '   permitidos), y NO generes casos aparte para esos CA_N -- serian redundantes con los pasos del caso del campo. Esto',
    '   tambien reemplaza, para esos campos, el caso "campo obligatorio vacio" de la regla (b). Los CA_N que involucran',
    '   varios campos o un comportamiento distinto (ej: formulario completo vacio, dato duplicado, que no se notifique si',
    '   falla una validacion) si van en su propio caso.',
    '4. UN CASO POR FLUJO, NO POR VERIFICACION: no hay numero minimo ni maximo de casos; la cantidad sale de la cobertura.',
    '   Lo que se verifica en la MISMA ejecucion del mismo flujo, con los mismos datos y precondiciones (los campos que una',
    '   pantalla precarga, los botones que aparecen, los datos que muestra un registro, el mensaje del mismo error), va en',
    '   UN caso con un paso de verificacion por cada cosa, aunque cubra varios CA_N/RN_N/ESC_N: cita todos en Requisito y',
    '   en [cubre]. Prohibido repetir la misma preparacion en varios casos cambiando solo la verificacion final.',
    '   Van en casos SEPARADOS las variantes que necesitan otros datos u otra precondicion: camino feliz frente a dato',
    '   invalido, parametro activo frente a apagado, rol con y sin permiso, registro con y sin un atributo. Los valores',
    '   invalidos de un MISMO dato son un solo caso con un paso por valor (regla 3(e)), igual que el caso de un campo de la',
    '   regla 3(d). Elimina la redundancia: ningun caso puede verificar solo lo que otro caso ya verifica.',
    '5. Cada paso a paso debe ser ejecutable por un QA sin conocimiento previo del sistema.',
    '5.1 ' + REGLA_CASOS_OPERATIVOS,
    '6. El resultado esperado debe ser verificable, no ambiguo.',
    '7. NO inventes datos de negocio que no esten en el analisis. Esto aplica en especial a VALORES concretos (correos,',
    '   nombres, IDs, montos, fechas puntuales, cantidades/valores numericos de campos del sistema en formulas o calculos):',
    '   si el analisis no especifica un valor exacto para un campo, describe la ACCION de forma generica orientada a la',
    '   funcionalidad, no un dato inventado. MAL: "Ingresar pepitoperez@correo.com y la clave Clave123". BIEN: "Ingresar un',
    '   correo corporativo valido y la contrasena correcta en los campos respectivos". MAL (formulas/calculos de negocio):',
    '   "Verificar una reserva con Asignacion=2200 y Facturado=1024, y confirmar que el disponible es 1176". BIEN:',
    '   "Verificar una reserva vigente con Asignacion mayor a Facturado, y confirmar que el disponible calculado es',
    '   exactamente Asignacion menos Facturado". Usa un valor literal UNICAMENTE cuando (a) el analisis lo menciona',
    '   explicitamente, o (b) el objetivo del caso es validar ese dato exacto (ej: "el campo debe rechazar un correo con',
    '   formato invalido", "el sistema debe truncar el ID a 10 caracteres") -- ahi si el dato especifico ES la',
    '   funcionalidad bajo prueba. Esto no debe bajar la calidad del caso: sigue siendo tan detallado y ejecutable como',
    '   antes (el paso debe seguir indicando QUE relacion/condicion entre los valores se necesita, solo sin fijar el',
    '   numero exacto), solo evita fabricar datos que despues no coincidiran con la evidencia real que suba el QA.',
    '8. REDACCION NATURAL: escribe cada caso como lo escribiria un analista QA con experiencia para que otra persona del',
    '   equipo lo ejecute: frases completas y claras, en imperativo ("Ingresar", "Seleccionar", "Verificar"), con el',
    '   vocabulario del negocio y de la pantalla, sin tono telegrafico ni jerga interna. NUNCA cites ni atribuyas la',
    '   fuente: prohibido escribir "en la reunion dijeron", "segun la transcripcion", "el documento indica", "el cliente',
    '   menciono", "segun el analisis", ni nombres de personas o de archivos -- el caso describe que hacer y que debe pasar,',
    '   no de donde salio. Los IDs (CA_N, RN_N) van SOLO en el campo "Requisito", nunca dentro del titulo, el objetivo ni',
    '   los pasos. MAL: "Validar RN_3 segun lo que dijo el cliente en la reunion: campo NIT obligatorio >> Error". BIEN:',
    '   "Dejar vacio el campo NIT y dar clic en Guardar >> El sistema no guarda el proveedor y muestra el mensaje de',
    '   campos obligatorios".',
    '9. Antes de responder, verifica internamente TODO lo siguiente y corrige lo que falte:',
    '   (a) Cada CA_N y RN_N del analisis aparece citado en al menos un caso -- si falta alguno, agrega el caso que lo cubra.',
    '   (b) Cada escenario QA de tipo Negativo o Borde del analisis quedo convertido en al menos un caso -- si falta alguno, agregalo.',
    '   (c) Cada filtro/parametro de ejecucion y cada campo obligatorio mencionado en el analisis tiene su caso negativo/borde',
    '   correspondiente (sin diligenciar, sin resultados, vacio) segun aplique -- si falta, agregalo.',
    '   (d) Ningun grupo de casos repite la misma preparacion cambiando solo la verificacion final -- si lo hay, unelos en un',
    '   caso con un paso de verificacion por cada uno (regla 4).',
    '   (e) No hay casos redundantes: ninguno verifica solo lo que otro ya verifica (un Smoke no repite un Funcional) -- si',
    '   los hay, fusionalos. Cada dato que el usuario digita tiene su caso negativo (regla 3(e)).',
    '   (f) Cada CA_N/RN_N que EXIGE EXPLICITAMENTE un conjunto exacto de elementos tiene su caso de "conjunto exacto" (ni',
    '   de mas ni de menos) -- si hay VARIOS flujos/modulos distintos que cada uno lo exige, cada uno tiene el suyo -- si',
    '   falta alguno, agregalo. Si ningun CA_N/RN_N lo exige, no agregues casos de este tipo.',
    '   (g) Cada CA_N/RN_N que EXIGE EXPLICITAMENTE copiar/heredar campos entre documentos tiene su caso de auditoria campo',
    '   por campo contra el origen -- si hay VARIOS flujos/modulos distintos que cada uno lo exige, cada uno tiene el suyo --',
    '   si falta alguno, agregalo. Si ningun CA_N/RN_N lo exige, no agregues casos de este tipo.',
    '   (h) Cada RN_N que especifica un campo con sus atributos tiene su caso de validacion de ese campo -- si falta, agregalo.',
    '   Y ninguna validacion de un solo campo quedo duplicada en un caso aparte fuera del caso de ese campo -- si la hay,',
    '   quitala y cita su CA_N en el caso del campo.',
    '   (i) Ningun caso menciona reuniones, transcripciones, documentos o personas como fuente, ni trae IDs fuera del campo',
    '   "Requisito" -- si encuentras alguno, reescribelo.',
    '   (j) Ningun caso es de carga, estres, volumen masivo u otra prueba que el QA no pueda ejecutar en el ambiente (regla',
    '   5.1) -- si encuentras alguno, conviertelo en lo que el usuario puede observar o quitalo.',
    '10. Responde UNICAMENTE con la seccion delimitada. Sin texto adicional.',
    ctx.inventoryPath ? '\n' + REGLAS_ALINEACION_CASOS : null,
    '',
    '---CASOS_DE_PRUEBA---',
    'Sin minimo ni maximo de casos: la cantidad la define la cobertura. Formato EXACTO -- un bloque por caso, cada campo en',
    'su propia linea. NINGUN campo es opcional, ni siquiera en casos con un paso a paso muy largo: Tipo y Complejidad',
    'SIEMPRE van presentes en TODOS los casos, sin excepcion, sin importar que tan extenso sea el paso a paso de cada uno.',
    ctx.inventoryPath ? '### CP_1 [src: CA_1] [cubre: CA_1, RN_2, ESC_1]' : '### CP_1',
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
  ].filter(function(l){ return l !== null; }).join('\n');
}

// ── Build prompt: Consolidar casos de varias fuentes (M4) ─────────────────────
// Demo 2026-10-08 (Liz): el QA tiene sus propios casos y a veces el cliente entrega
// los suyos (Excel con cualquier plantilla, Word...). La IA los cruza con los que ya
// genero la QA Suite y entrega UNA version final: sin duplicados, mejorando lo que se
// pueda y agregando lo que salga de combinar las fuentes, con trazabilidad del origen.
function buildConsolidateCasesPrompt(analysisRaw, existingCases, sources, m2Context, ctx) {
  m2Context = m2Context || {};
  ctx = ctx || {};
  var areas = (m2Context.impactAreas || []).filter(function(a){ return a.checked; })
    .map(function(a){ return a.label + (a.desc ? ': ' + a.desc : ''); }).join('\n') || 'Ninguna area especifica marcada.';
  var existingText = (existingCases || []).map(function(c){
    var pasos = (c.steps || []).map(function(st, i){ return (i+1) + '. ' + (st.paso||'') + ' >> ' + (st.resultado||''); }).join(' / ') || '(sin pasos)';
    // c.marks: "[src: ...] [cubre: ...]" del caso generado (S.casesTrace), para no perderlos al consolidar.
    return c.id + (c.marks ? ' ' + c.marks : '') + ' | Requisito: ' + (c.requisito||'-') + ' | Tipo: ' + (c.tipo||'-') + ' | Escenario: ' + (c.escenario||'-') +
      ' | Caso: ' + (c.caso||'-') + ' | Objetivo: ' + (c.objetivo||'-') + ' | Pasos: ' + pasos;
  }).join('\n') || '(no hay casos generados todavia)';
  var sourcesText = (sources || []).map(function(src){
    return '=== FUENTE: ' + (src.origen === 'Cliente' ? 'CLIENTE' : 'QA') + ' -- archivo "' + (src.filename||'-') + '" ===\n' + (src.text||'');
  }).join('\n\n');
  return [
    'Eres un Disenador de Casos de Prueba QA senior. Debes CONSOLIDAR en un solo set final los casos de prueba de',
    'varias fuentes para el mismo requerimiento:',
    '- IA: los casos que ya genero la herramienta (abajo, con su ID CP_N).',
    '- QA: casos propios del analista QA (pueden venir completos o solo como titulos/escenarios).',
    '- Cliente: casos que entrego el cliente (pueden venir en cualquier formato o plantilla).',
    '',
    'ANALISIS DEL REQUERIMIENTO:',
    analysisRaw,
    '',
    'CONFIGURACION DEFINIDA POR EL QA:',
    'Areas de impacto validadas:',
    areas,
    '',
    'CASOS GENERADOS POR LA IA:',
    existingText,
    '',
    'CASOS EXTERNOS (texto extraido de los archivos; las hojas de calculo vienen como filas separadas por comas y la',
    'plantilla puede ser cualquiera -- identifica tu mismo que columna es el titulo, los pasos, el resultado esperado, etc.;',
    'ignora encabezados, logos, filas vacias y columnas de ejecucion/estado):',
    sourcesText || '(ninguno)',
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Entrega UNA version final: cada validacion distinta aparece UNA sola vez. Si un caso externo valida lo mismo que',
    '   un caso de la IA (mismo objetivo, aunque este redactado distinto), NO lo dupliques: fusionalos en uno solo y quedate',
    '   con lo mejor de ambos (pasos mas completos, datos o condiciones que el otro no tenia).',
    '2. Si un caso externo cubre algo que ningun caso de la IA cubre, agregalo como caso completo. Si viene solo como',
    '   titulo o escenario, completalo con objetivo, pasos y resultados esperados a partir del analisis.',
    '3. Si al combinar fuentes aparece una validacion que ninguna tenia por separado (ej: el escenario del cliente con la',
    '   condicion que propuso el QA), agregala como caso nuevo.',
    '4. Mejora la redaccion de un caso solo si de verdad aporta (pasos ambiguos, resultado no verificable). No cambies por',
    '   cambiar: un caso de la IA que ya esta bien se mantiene igual.',
    '5. Descarta (no los incluyas en el set) los casos externos que esten duplicados exactos, fuera del alcance del',
    '   requerimiento o que no sean ejecutables segun la regla 6, y listalos en DESCARTADOS con el motivo.',
    '6. ' + REGLA_CASOS_OPERATIVOS,
    '7. Cobertura OBLIGATORIA: al final, TODOS los CA_N y RN_N del analisis deben quedar cubiertos por al menos un caso.',
    '   El campo "Requisito" cita el/los ID(s) exactos que cubre cada caso (si un caso externo no trae IDs, asignalos tu).',
    '8. NO inventes datos de negocio (correos, montos, IDs, fechas, valores numericos) que no esten en el analisis ni en',
    '   las fuentes: describe la accion de forma generica si no hay un valor exacto.',
    '9. REDACCION NATURAL: como la escribiria un analista QA para que otra persona la ejecute, en imperativo, con el',
    '   vocabulario del negocio. NUNCA cites la fuente dentro del caso ("segun el cliente", "el QA propuso", nombres de',
    '   archivos o personas): el origen va SOLO en las lineas Origen/Accion/Detalle. Los IDs CA_N/RN_N van SOLO en',
    '   "Requisito".',
    '10. Responde UNICAMENTE con las dos secciones delimitadas. Sin texto adicional.',
    ctx.inventoryPath
      ? '11. Al fusionar o mejorar un caso, CONSERVA su "Condicionado a <Ref>" y sus marcas [src]/[cubre] (unelas si fusionas ' +
        'dos casos); un caso externo que cubra algo condicionado o una exclusion se ajusta a las reglas A y C de abajo.\n\n' + REGLAS_ALINEACION_CASOS
      : null,
    casesCtxBlock(ctx),
    '',
    '---CASOS_DE_PRUEBA---',
    'Formato EXACTO -- un bloque por caso, numerados CP_1, CP_2... en orden, cada campo en su propia linea, ninguno opcional:',
    ctx.inventoryPath ? '### CP_1 [src: CA_1] [cubre: CA_1, RN_2]' : '### CP_1',
    'Requisito: CA_1, RN_2',
    'Tipo: Funcional',
    'Complejidad: Medio',
    'Escenario: nombre corto del escenario',
    'Caso: titulo corto del caso',
    'Objetivo: una frase que describe que se valida',
    'Origen: IA',
    'Accion: Se mantiene',
    'Detalle: (vacio si Accion es "Se mantiene"; si no, una frase con que se hizo, ej: "Fusionado con el caso del cliente \'Alta de registro\', se agrego el paso de confirmacion")',
    'Pasos:',
    '1. Texto del paso >> Resultado esperado especifico',
    '2. Texto del paso >> Resultado esperado especifico',
    'Donde: Tipo=UNICAMENTE Smoke, Funcional, UI o UX. Complejidad=UNICAMENTE Alto, Medio o Bajo.',
    'Origen=UNICAMENTE IA, QA, Cliente o Combinado (Combinado = salio de mezclar dos o mas fuentes).',
    'Accion=UNICAMENTE "Se mantiene", "Mejorado", "Fusionado" o "Nuevo".',
    '',
    '---DESCARTADOS---',
    'Una linea por caso externo descartado: Origen (QA o Cliente) | titulo del caso externo | motivo concreto.',
    'Si no se descarto ninguno, escribe NINGUNO.',
  ].filter(function(l){ return l !== null; }).join('\n');
}

// ── Build prompt: Verificacion REAL de cobertura RF/CA (M4) ───────────────────
// El cruce por defecto en el frontend es solo texto (indexOf del ID dentro del
// campo "Requisito Funcional" de cada caso) -- esto le pide a la IA verificar
// SEMANTICAMENTE si el paso a paso de los casos citados de verdad valida cada
// CA_N/RN_N, no solo si lo mencionan.
// ctx (desde M1/M3): con inventario se verifica ademas cada ESC_N y se reportan
// hallazgos de alineacion (condiciones DEP, exclusiones, nombres propios, alcance del plan).
function buildCoverageVerificationPrompt(analysisRaw, cases, ctx) {
  ctx = ctx || {};
  var casesText = (cases || []).map(function(c){
    var pasos = (c.steps || []).map(function(s, i){ return (i+1)+'. '+s.paso+' -> '+s.resultado; }).join(' / ') || '(sin pasos)';
    return c.id + ' | Requisito citado: ' + (c.requisito||'-') + (c.caso ? ' | Caso: ' + c.caso : '') + ' | Objetivo: ' + (c.objetivo||'-') + ' | Pasos: ' + pasos;
  }).join('\n');
  if (ctx.inventoryPath) {
    return [
      'Eres un QA Lead senior auditando si un set de casos de prueba REALMENTE cubre el requerimiento y esta alineado con el.',
      '',
      'ANALISIS DEL REQUERIMIENTO (CRITERIOS_DE_ACEPTACION, REGLAS_DE_NEGOCIO y ESCENARIOS_QA a verificar):',
      analysisRaw,
      casesCtxBlock(ctx),
      '',
      'CASOS DE PRUEBA A AUDITAR:',
      casesText,
      '',
      'INSTRUCCIONES CRITICAS:',
      '1. Para CADA CA_N, RN_N y ESC_N del analisis, evalua si el paso a paso de los casos REALMENTE lo verifica -- no basta',
      '   con que el caso mencione el ID.',
      '2. Se honesto: no marques 100% de cobertura si no es real. TestIAlab necesita saber la verdad, no un numero bonito.',
      '3. Ademas, revisa la alineacion: (a) casos que cubren algo condicionado a un pendiente (DEP-XX) y no dicen',
      '   "Condicionado a <Ref>" o inventan el resultado pendiente; (b) casos que ejecutan una funcionalidad EXCLUIDA del',
      '   alcance (solo se admite el caso negativo de que no ocurre); (c) nombres propios del glosario cambiados por',
      '   genericos; (d) items de "Dentro del Alcance" del plan sin ningun caso.',
      '4. Responde UNICAMENTE con las dos secciones delimitadas. Sin texto adicional.',
      '',
      '---COBERTURA_VERIFICADA---',
      'Un renglon por CADA CA_N/RN_N/ESC_N del analisis (todos, sin omitir ninguno), formato exacto (4 columnas separadas por "|"):',
      'ID | SI o NO (cubierto de verdad) | IDs de casos que lo cubren de verdad (separados por coma, o vacio si NO) | Justificacion breve (1 frase)',
      '',
      '---HALLAZGOS_ALINEACION---',
      'Un renglon por hallazgo de la instruccion 3: Tipo (CONDICION, EXCLUSION, NOMBRE o ALCANCE_PLAN) | IDs de casos o item | que',
      'esta mal, en 1 frase. Si no hay hallazgos, escribe NINGUNO.',
    ].filter(function(l){ return l !== null; }).join('\n');
  }
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
function buildGapCasesPrompt(analysisRaw, existingCases, gapItems, m2Context, engine, ctx) {
  m2Context = m2Context || {};
  ctx = ctx || {};
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
    casesCtxBlock(ctx),
    '',
    'CA_N / RN_N / ESC_N / ALCANCE DEL PLAN QUE FALTAN POR CUBRIR (justificacion de la auditoria de cobertura):',
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
    '4.1 ' + REGLA_CASOS_OPERATIVOS,
    '5. NO inventes datos de negocio que no esten en el analisis. Esto aplica en especial a VALORES concretos (correos,',
    '   nombres, IDs, montos, fechas puntuales, cantidades/valores numericos de campos del sistema en formulas o calculos):',
    '   si el analisis no especifica un valor exacto para un campo, describe la ACCION de forma generica orientada a la',
    '   funcionalidad, no un dato inventado. MAL: "Ingresar pepitoperez@correo.com y la clave Clave123". BIEN: "Ingresar un',
    '   correo corporativo valido y la contrasena correcta en los campos respectivos". MAL (formulas/calculos de negocio):',
    '   "Verificar una reserva con Asignacion=2200 y Facturado=1024, y confirmar que el disponible es 1176". BIEN:',
    '   "Verificar una reserva vigente con Asignacion mayor a Facturado, y confirmar que el disponible calculado es',
    '   exactamente Asignacion menos Facturado". Usa un valor literal UNICAMENTE cuando (a) el analisis lo menciona',
    '   explicitamente, o (b) el objetivo del caso es validar ese dato exacto -- ahi si el dato especifico ES la',
    '   funcionalidad bajo prueba. Esto no debe bajar la calidad del caso (el paso debe seguir indicando QUE relacion/',
    '   condicion entre los valores se necesita, solo sin fijar el numero exacto), solo evitar fabricar datos que',
    '   despues no coincidiran con la evidencia real.',
    '6. Si un item faltante es un RN_N que especifica un campo con sus atributos (tipo, longitud, obligatoriedad, formato,',
    '   valores permitidos), genera UN caso dedicado a ese campo con un paso por cada validacion que el RN_N documente',
    '   (vacio si es obligatorio, longitud maxima exacta, longitud excedida, tipo/formato invalido, valor fuera de la',
    '   lista, valor valido). Solo las validaciones documentadas; no juntes varios campos en un mismo caso. Si entre los',
    '   faltantes hay CA_N cuyo unico objetivo es una restriccion de ese mismo campo, cubrelos dentro de ese caso (citalos',
    '   en "Requisito") en vez de crear un caso aparte para cada uno.',
    '7. REDACCION NATURAL: escribe cada caso como lo escribiria un analista QA con experiencia para que otra persona del',
    '   equipo lo ejecute: frases completas y claras, en imperativo, con el vocabulario del negocio y de la pantalla, sin',
    '   tono telegrafico ni jerga interna. NUNCA cites ni atribuyas la fuente: prohibido escribir "en la reunion dijeron",',
    '   "segun la transcripcion", "el documento indica", "el cliente menciono", "segun el analisis", ni nombres de personas',
    '   o de archivos. Los IDs (CA_N, RN_N) van SOLO en el campo "Requisito", nunca dentro del titulo, el objetivo ni los',
    '   pasos. MAL: "Validar RN_3 segun lo que dijo el cliente en la reunion: campo NIT obligatorio >> Error". BIEN:',
    '   "Dejar vacio el campo NIT y dar clic en Guardar >> El sistema no guarda el proveedor y muestra el mensaje de',
    '   campos obligatorios".',
    '8. Responde UNICAMENTE con la seccion delimitada. Sin texto adicional.',
    '9. Si al revisar los casos existentes concluyes que NINGUN item faltante necesita un caso nuevo (ya lo cubren, o',
    '   el analisis no da informacion suficiente para disenar un caso ejecutable), NO inventes casos: responde',
    '   unicamente con la linea ---CASOS_DE_PRUEBA--- seguida de la linea SIN_CASOS_NUEVOS.',
    ctx.inventoryPath ? '\n' + REGLAS_ALINEACION_CASOS : null,
    '',
    '---CASOS_DE_PRUEBA---',
    'Formato EXACTO -- un bloque por caso, cada campo en su propia linea. Tipo y Complejidad SIEMPRE van presentes',
    'en TODOS los casos, sin excepcion, sin importar que tan extenso sea el paso a paso de cada uno.',
    '### CP_'+(lastNum+1) + (ctx.inventoryPath ? ' [src: CA_1] [cubre: CA_1, RN_2]' : ''),
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
  ].filter(function(l){ return l !== null; }).join('\n');
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
// Regla de ortografia para los documentos que se entregan al cliente (Plan de
// Pruebas y Certificacion): el QA no deberia tener que corregir tildes a mano.
// Los prompts estan escritos sin tildes por costumbre del codigo, por eso se
// pide explicito que la SALIDA no copie esa forma.
var ORTOGRAFIA_DOC_CLIENTE =
  'ORTOGRAFIA (obligatorio): redacta en espanol de Colombia/Latinoamerica con ortografia impecable: todas las tildes ' +
  '(ej. "integración", "regresión", "aceptación", "también", "módulo", "validación", "información"), la letra ñ, ' +
  'signos de apertura ¿ y ¡, y mayusculas/puntuacion correctas. Estas instrucciones vienen escritas sin tildes; NO ' +
  'copies esa forma en tu respuesta. Antes de entregar, relee todo el texto y corrige cualquier falta.';

// Reglas de alineacion del Plan con el requerimiento (brief de M3). Genericas: los
// ejemplos son neutros. Se validan despues con validators/planValidator.js.
var REGLAS_ALINEACION_PLAN = [
  'REGLAS DE ALINEACION CON EL REQUERIMIENTO (obligatorias, se validan automaticamente despues):',
  'A. PENDIENTES: todo item del inventario con Estado PENDIENTE o CONTRADICCION que gobierna comportamiento (lo cita un',
  '   CA_N o RN_N del analisis; nunca los de contexto, regla J) va en',
  '   ALCANCE_DENTRO terminado en "(condicionado a <Ref>)" (para una contradiccion, "(condicionado a confirmar <tema>)"),',
  '   con TODAS las Ref que apliquen ("(condicionado a DEP-01 y DEP-03)"). NUNCA va en ALCANCE_FUERA. En ALCANCE_FUERA',
  '   solo van las exclusiones explicitas del requerimiento (Tipo EXCLUSION del inventario).',
  'B. FIDELIDAD: ninguna afirmacion puede ser mas fuerte que su fuente. Conserva los modales ("puede", "podria",',
  '   "si ..., entonces ..."): si la fuente es condicional, escribe la condicion. No inventes plazos, "tiempo real",',
  '   obligaciones ("exige") ni consecuencias que la fuente no declara; si las infieres, escribelas con "puede" o',
  '   "posible". Distingue un dano comercial de uno legal o normativo: no hables de incumplimiento normativo, multas o',
  '   sanciones si la fuente no lo dice.',
  'C. NOMBRES PROPIOS: usa los terminos y nombres del GLOSARIO tal como los escribe el documento. Prohibido cambiarlos',
  '   por genericos ("terceros", "desarrollo de terceros", "el proveedor", "proveedor externo") cuando la fuente los',
  '   nombra. "Proveedor de Desarrollo" (equipo de la plantilla) si se permite.',
  'D. TRAZABILIDAD: cada supuesto, riesgo y criterio de entrada que se origine en un pendiente cita su codigo (DEP-XX)',
  '   en el texto. Todo pendiente con codigo aparece al menos una vez en SUPUESTOS, RIESGOS o CRITERIOS_ENTRADA. Cada',
  '   riesgo del analisis (R_N) aparece en RIESGOS_FUNCIONALES o RIESGOS_NEGOCIO, con la criticidad que hereda de lo que',
  '   afecta. Los codigos propios del documento (DEP-XX, SUP-X) SI se citan; los IDs internos del analisis (CA_N, RN_N,',
  '   R_N, ESC_N) NO (instruccion 7).',
  'E. COHERENCIA: Objetivo, Alcance, Estrategia, Tipos y Niveles y Criterios de salida hablan del mismo conjunto de',
  '   items con las mismas condiciones: si un item esta condicionado en un apartado, lo esta en todos los apartados',
  '   donde aparece. No agregues en Estrategia o Tipos algo que no este en Alcance. Evita parentesis anidados: prefiere',
  '   una frase simple.',
  'F. CONVENCIONES: "Cliente" con mayuscula cuando es un rol; "por ejemplo," con coma despues y nunca con coma antes;',
  '   sin rayas largas (em dash); el nombre del equipo de QA se escribe "TestIAlab". En lugar de cifras o fechas que el',
  '   requerimiento no define, usa N, N-1 o X.',
  'G. NOMBRE DEL PROYECTO: si lo mencionas, escribelo exactamente como se indica arriba (conectores en minuscula), nunca',
  '   copiado del nombre del archivo.',
  'H. RESPONSABLES: no hay seccion de responsables en tu respuesta (los llena el QA). No inventes nombres de personas,',
  '   cargos ni contactos en ninguna seccion.',
  'I. MARCAS INTERNAS: cada linea de ALCANCE_DENTRO, ALCANCE_FUERA, SUPUESTOS, RIESGOS_*, CRITERIOS_* termina con',
  '   [src: N,N] (numeros del inventario de los que sale) y/o el codigo del pendiente ([src: 5,DEP-01]); en OBJETIVO y',
  '   ESTRATEGIA, al final del parrafo; en TIPOS_PRUEBA y NIVELES_PRUEBA, al final de cada punto. Los supuestos y',
  '   criterios genericos del modelo de entrega (que no salen del requerimiento) van sin marca. La herramienta quita',
  '   las marcas antes de mostrar el plan.',
  'J. CONTEXTO: los items de Tipo Objetivo, Contexto, Tarea, Decision o IndicacionPrueba no son funcionalidades a',
  '   probar: nunca van en ALCANCE_DENTRO ni ALCANCE_FUERA. El objetivo alimenta OBJETIVO; el contexto, el ambiente y',
  '   las indicaciones de prueba, ESTRATEGIA o SUPUESTOS; una Tarea o Decision PENDIENTE va en SUPUESTOS, RIESGOS o',
  '   CRITERIOS_ENTRADA. Una CONTRADICCION va ademas en RIESGOS con las dos versiones.',
  '   Un pendiente que el analisis solo tiene en un riesgo (R_N), como accesos, ubicar codigo o definiciones del',
  '   proyecto, tampoco es alcance: va en SUPUESTOS, RIESGOS o CRITERIOS_ENTRADA.',
].join('\n');

// ctx (opcional, desde M1): { inventoryPath, glossary, projectName }. Sin inventario el
// plan se genera como antes (analisis viejo), sin marcas ni validacion.
function buildPlanPruebasPrompt(analysisRaw, m2Context, engine, ctx) {
  m2Context = m2Context || {};
  ctx = ctx || {};
  var glossary = (ctx.glossary || []).map(function(g){ return g.termino + (g.tipo ? ' (' + g.tipo + ')' : ''); }).join('; ');
  return [
    'Eres un Lider de QA senior redactando un Plan de Pruebas formal para un cliente, siguiendo el formato',
    'estandar de la empresa (Objetivo, Alcance, Supuestos, Riesgos, Estrategia, Tipos y Niveles de Prueba,',
    'Criterios de Entrada/Salida, Responsables).',
    '',
    ctx.projectName ? 'NOMBRE DEL PROYECTO: ' + ctx.projectName : null,
    ctx.inventoryPath
      ? 'INVENTARIO DEL REQUERIMIENTO: en ' + ctx.inventoryPath + ' esta el inventario numerado de condiciones (N | Tipo | Estado | ' +
        'Ref | Condicion) y, despues de ---GLOSARIO---, los nombres propios del documento. Leelo con tu herramienta de lectura ' +
        'de archivos antes de responder: dice que esta PENDIENTE, que es EXCLUSION y que codigo (Ref) tiene cada pendiente.'
      : null,
    glossary ? 'GLOSARIO (nombres que se conservan tal cual): ' + glossary : null,
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
    '6. MODELO DE ENTREGA Y ESTRATEGIA DE TESTIALAB (obligatorio, es la forma real de trabajo -- no propongas otra):',
    '   Desarrollo entrega a QA el desarrollo COMPLETO en una sola entrega (no hay entregas parciales, ciclos, sprints',
    '   ni iteraciones de QA). QA ejecuta TODOS los casos de prueba sobre esa entrega. A medida que Desarrollo corrige',
    '   los bugs reportados, QA hace re-test de cada bug corregido y regresión focalizada de los casos impactados por',
    '   esa corrección, hasta cerrar. Refleja este modelo en la Estrategia, los Supuestos y los Criterios de entrada y',
    '   de salida. NUNCA hables de "ciclo 1/ciclo 2", "primer ciclo", "entregas parciales", "sprints" ni "iteraciones".',
    '7. NO cites los identificadores internos del analisis (CA_N, RN_N, R_N, ESC_N ni rangos como "CA_5 a CA_7") en',
    '   NINGUNA seccion: el cliente no conoce esa numeracion, no aparece en su requerimiento. Describe cada punto por su',
    '   contenido. MAL: "Bloqueo de la cuenta al tercer intento fallido (CA_5, RN_1)." BIEN: "Bloqueo de la cuenta al',
    '   tercer intento fallido consecutivo."',
    '8. ' + ORTOGRAFIA_DOC_CLIENTE,
    '9. Responde UNICAMENTE con las secciones delimitadas. Sin texto adicional.',
    '',
    ctx.inventoryPath ? REGLAS_ALINEACION_PLAN : null,
    ctx.inventoryPath ? '' : null,
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
    '1 a 2 parrafos describiendo el enfoque de pruebas segun el modelo de la instruccion 6 (entrega completa, ejecución',
    'de todos los casos, re-test de bugs corregidos y regresión focalizada de los casos impactados), aplicado a los',
    'flujos concretos de ESTE requerimiento y al ambiente de pruebas -- sin mencionar herramientas ni IA.',
    '',
    '---TIPOS_PRUEBA---',
    'EXACTAMENTE estos 4 tipos, en este orden, cada uno con 2-4 puntos concretos de ESTE requerimiento (formato: Nombre | punto 1 / punto 2):',
    'Pruebas funcionales | ...',
    'Pruebas de integración | ...',
    'Pruebas negativas | ...',
    'Pruebas de regresión focalizada | ...',
    '',
    '---NIVELES_PRUEBA---',
    'EXACTAMENTE estos 3 niveles, en este orden, cada uno con 1-3 puntos concretos de ESTE requerimiento (formato: Nombre | punto 1 / punto 2):',
    'Pruebas de sistema | ...',
    'Pruebas de integración | ...',
    'Pruebas de aceptación (UAT) | ...',
    '',
    '---CRITERIOS_ENTRADA---',
    'Lista de criterios de entrada, uno por linea con "- ". Deben incluir, como base: el desarrollo completo desplegado',
    'en el ambiente de pruebas, los casos de prueba aprobados y los datos de prueba disponibles; agrega los que',
    'apliquen especificamente a ESTE requerimiento (ej: accesos, integraciones o configuraciones necesarias).',
    '',
    '---CRITERIOS_SALIDA---',
    'Lista de criterios de salida, uno por linea con "- ". Deben incluir, como base: todos los casos de prueba',
    'ejecutados, todos los bugs corregidos y re-testeados (o aceptados formalmente por el Cliente), y la regresión',
    'focalizada de los casos impactados en estado Exitoso; agrega los que apliquen especificamente a ESTE requerimiento.',
  ].filter(function(l){ return l !== null; }).join('\n');
}

// ── M3: auditor semantico del Plan (una llamada, Sonnet medium, ambos motores) ──
// Busca lo que el validador no puede decidir con texto: modales endurecidos, premisas
// escritas como hecho, consecuencias inferidas e incoherencias entre apartados.
function buildPlanAuditorPrompt(inventoryPath, analysisPath, planPath, findingsPath) {
  return [
    'Eres un auditor de calidad de Planes de Pruebas. Verifica que el plan este alineado con el requerimiento.',
    'NO reescribas el plan: solo reporta defectos concretos.',
    '',
    'Lee estos archivos con tu herramienta de lectura de archivos:',
    '- Inventario numerado del requerimiento (N | Tipo | Estado | Ref | Condicion) y glosario: ' + inventoryPath,
    '- Analisis del requerimiento (HU, criterios, reglas, riesgos): ' + analysisPath,
    '- Plan a auditar (cada linea trae [src: ...] con los items del inventario de los que sale): ' + planPath,
    '- Hallazgos del validador automatico (JSON): ' + findingsPath,
    '',
    'Busca SOLO estos tipos de defecto:',
    '- MAS_FUERTE_QUE_FUENTE: el plan es mas categorico que la fuente ("puede requerir" -> "exige", "si X" -> hecho,',
    '  "tiempo real" o plazos que la fuente no dice).',
    '- PREMISA_COMO_HECHO: una premisa condicional de la fuente ("si el servicio usa X, ...") escrita como hecho.',
    '- CONSECUENCIA_INFERIDA: una consecuencia que la fuente no declara, escrita como hecho, o un dano comercial',
    '  presentado como legal o normativo.',
    '- INCOHERENCIA: Objetivo, Alcance, Estrategia, Tipos y Niveles o Criterios de salida no dicen lo mismo (un item que',
    '  esta en un apartado y no en Alcance, o condicionado en uno y no en otro).',
    '- SIN_SUSTENTO: afirmaciones o nombres que el requerimiento no respalda, o un nombre propio cambiado por un generico.',
    'No reportes estilo ni cosas que la fuente si respalda. Si no hay defectos, responde [].',
    '',
    'Responde SOLO con un arreglo JSON, sin texto adicional ni bloque de codigo:',
    '[{"seccion":"<OBJETIVO|ALCANCE_DENTRO|...>","frase":"<frase exacta del plan>","tipo":"<MAS_FUERTE_QUE_FUENTE|PREMISA_COMO_HECHO|',
    'CONSECUENCIA_INFERIDA|INCOHERENCIA|SIN_SUSTENTO>","motivo":"<que dice la fuente>","correccion":"<como deberia quedar>"}]',
  ].join('\n');
}

// ── M3: reparacion acotada del Plan (una sola pasada) ─────────────────────────
function buildPlanRepairPrompt(inventoryPath, analysisPath, planPath, findingsPath) {
  return [
    'Eres un Lider de QA senior. Debes CORREGIR un Plan de Pruebas aplicando unicamente los hallazgos indicados.',
    '',
    'Lee estos archivos con tu herramienta de lectura de archivos:',
    '- Inventario numerado del requerimiento y glosario: ' + inventoryPath,
    '- Analisis del requerimiento: ' + analysisPath,
    '- Plan actual, con marcas [src: ...]: ' + planPath,
    '- Hallazgos a corregir (JSON): ' + findingsPath,
    '',
    'REGLAS DE LA CORRECCION:',
    '1. Corrige SOLO las frases o items que mencionan los hallazgos. Todo lo demas debe quedar EXACTAMENTE igual.',
    '2. Si un hallazgo pide algo que falta (un pendiente en Dentro del Alcance condicionado, un codigo DEP en supuestos,',
    '   riesgos o criterios de entrada, un riesgo del analisis), agrega la linea en la seccion correspondiente.',
    '3. Si un item pendiente esta en ALCANCE_FUERA, muevelo a ALCANCE_DENTRO con "(condicionado a <Ref>)".',
    '4. Conserva el formato de cada seccion y las marcas [src: ...].',
    '5. Respeta estas reglas mientras corriges:',
    REGLAS_ALINEACION_PLAN,
    '',
    ORTOGRAFIA_DOC_CLIENTE + ' Conserva las tildes que ya trae el plan.',
    '',
    'Responde con el plan COMPLETO corregido, con TODAS las secciones delimitadas en este orden y sin texto adicional:',
    '---OBJETIVO--- ---ALCANCE_DENTRO--- ---ALCANCE_FUERA--- ---SUPUESTOS--- ---RIESGOS_FUNCIONALES--- ---RIESGOS_NEGOCIO---',
    '---ESTRATEGIA--- ---TIPOS_PRUEBA--- ---NIVELES_PRUEBA--- ---CRITERIOS_ENTRADA--- ---CRITERIOS_SALIDA---',
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
var DOCX_LANG = 'es-CO'; // idioma de revision ortografica de Word -- sin esto Word revisa con el idioma del equipo (ej. ingles) y subraya todo en rojo

function docxHeading(numberedTitle) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    keepNext: true, keepLines: true,
    spacing: { before: 280, after: 120 },
    children: [ new TextRun({ text: numberedTitle, bold: true, size: 26, color: DOCX_NAVY, font: DOCX_FONT }) ],
  });
}
function docxSubheading(title) {
  return new Paragraph({
    keepNext: true, keepLines: true,
    spacing: { before: 180, after: 80 },
    children: [ new TextRun({ text: title, bold: true, size: 22, color: DOCX_TEAL, font: DOCX_FONT }) ],
  });
}
function docxPara(text) {
  return new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 },
    children: [ new TextRun({ text: text || '---', size: 21, font: DOCX_FONT }) ] });
}
// opts.keepLines: la vineta no se parte entre dos paginas (hoy solo lo pide el HU).
function docxBullet(text, opts) {
  opts = opts || {};
  return new Paragraph({ alignment: AlignmentType.JUSTIFIED, bullet: { level: 0 }, spacing: { after: 40 }, keepLines: !!opts.keepLines,
    children: [ new TextRun({ text: text, size: 21, font: DOCX_FONT }) ] });
}
function docxNumbered(text, n) {
  return new Paragraph({ alignment: AlignmentType.JUSTIFIED, indent: { left: 300 }, spacing: { after: 40 },
    children: [ new TextRun({ text: n + '. ' + text, size: 21, font: DOCX_FONT }) ] });
}
// Texto con saltos de linea -> un parrafo por linea (Word ignora los saltos dentro de
// un TextRun: el 'Resultado esperado' del bug salia todo pegado en una sola linea).
function docxLinesBlock(text) {
  var lines = String(text || '').split(/\r?\n/).map(function(l){ return l.trim(); }).filter(Boolean);
  if (!lines.length) return [ docxPara('---') ];
  return lines.map(function(l){ return docxPara(l); });
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
    out.push(new Paragraph({ keepNext: true, keepLines: true, spacing: { before: 100, after: 40 }, children: [ new TextRun({ text: (i+1)+'. '+entry.nombre, bold: true, size: 21, font: DOCX_FONT }) ] }));
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
  var header = new TableRow({ cantSplit: true, children: [
    docxCell('Equipo', {header:true}), docxCell('Nombre / Rol', {header:true}), docxCell('Contacto', {header:true}),
  ]});
  // Sin datos del QA: las 3 filas de la plantilla solo con el Equipo (nunca "Por definir").
  var empty = planValidator.RESP_TEAMS.map(function(e){ return { equipo: e, cargo: '', contacto: '' }; });
  var body = (rows && rows.length ? rows : empty).map(function(r){
    return new TableRow({ cantSplit: true, children: [ docxCell(r.equipo), docxCell(r.cargo), docxCell(r.contacto) ] });
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
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21, language: { value: DOCX_LANG } } } } },
    sections: [ { properties: {}, headers: { default: hf.header }, footers: { default: hf.footer }, children: children } ],
  });
  return Packer.toBuffer(doc);
}

// Cada linea del analisis de M1 viene "TAG_N | campo | campo" (ej. "R_1 | Alto |
// Descripcion | Impacto", o "AREA | descripcion" en Impactos). En el Word se escribe
// "ID: campo - campo" (decision del equipo: menos "|" en los documentos), con el ID en
// negrita -- es la misma referencia que se usa en Casos QA/Coverage. parseHUDocxHtml
// hace el camino inverso al importar. keepLines: una vineta no se parte entre paginas.
function docxLabeledBulletList(lines) {
  var items = (lines || '').split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
  if (!items.length) return [ docxPara('---') ];
  return items.map(function(l){
    var parts = l.split('|').map(function(s){ return s.trim(); });
    if (parts.length >= 2 && parts[0]) {
      return new Paragraph({ alignment: AlignmentType.JUSTIFIED, bullet: { level: 0 }, spacing: { after: 40 }, keepLines: true, children: [
        new TextRun({ text: parts[0]+': ', bold: true, size: 21, font: DOCX_FONT }),
        new TextRun({ text: parts.slice(1).filter(Boolean).join(' - '), size: 21, font: DOCX_FONT }),
      ] });
    }
    return docxBullet(l.replace(/^[-*]\s*/, ''), { keepLines: true });
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
    docxLabelPara('Como', hu.como, { justify: true }),
    docxLabelPara('Quiero', hu.quiero, { justify: true }),
    docxLabelPara('Para', hu.para, { justify: true }),

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
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21, language: { value: DOCX_LANG } } } } },
    sections: [ { properties: {}, headers: { default: hf.header }, footers: { default: hf.footer }, children: children } ],
  });
  return Packer.toBuffer(doc);
}

function docxDefectosTable(bugs) {
  var header = new TableRow({ cantSplit: true, children: [
    docxCell('ID Bug', {header:true, width:15}), docxCell('Caso de Prueba', {header:true, width:15}),
    docxCell('Descripcion', {header:true, width:50}), docxCell('Estado', {header:true, width:20}),
  ]});
  var body = (bugs && bugs.length ? bugs : [{id:'--', caseId:'--', descripcion:'Ningun bug registrado.', estado:'--'}]).map(function(b){
    return new TableRow({ cantSplit: true, children: [ docxCell(b.id), docxCell(b.caseId||'-'), docxCell(b.descripcion), docxCell(b.estado) ] });
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
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21, language: { value: DOCX_LANG } } } } },
    sections: [ { properties: {}, headers: { default: hf.header }, footers: { default: hf.footer }, children: children } ],
  });
  return Packer.toBuffer(doc);
}

// opts.justify: texto justificado (hoy solo Como/Quiero/Para del HU; Bug/Dossier igual que antes).
function docxLabelPara(label, value, opts) {
  opts = opts || {};
  return new Paragraph({ alignment: opts.justify ? AlignmentType.JUSTIFIED : undefined, spacing: { after: 120 }, children: [
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
async function buildBugDocxBuffer(p) {
  p = p || {};
  var children = [
    new Paragraph({ spacing: { before: 100, after: 200 }, children: [
      new TextRun({ text: 'Bug -- ' + (p.caseId || '--'), bold: true, size: 26, color: DOCX_NAVY, font: DOCX_FONT }),
    ] }),
    docxLabelPara('Título', p.titulo),
    docxLabelPara('Caso de prueba', p.casoTitulo ? (p.caseId + ' -- ' + p.casoTitulo) : p.caseId),
    docxSubheading('Descripción'),
    docxPara(p.descripcion),
    docxSubheading('Pasos para reproducir'),
  ].concat(docxNumberedList(p.pasos)).concat([
    docxSubheading('Resultado esperado'),
  ]).concat(docxLinesBlock(p.resultadoEsperado)).concat([
    docxSubheading('Resultado obtenido'),
  ]).concat(docxLinesBlock(p.resultadoObtenido)).concat([
    docxSubheading('Tipo de error'),
  ]).concat(docxBulletList(p.tipoError)).concat([
    docxLabelPara('Severidad', p.severidad),
    docxSubheading('Evidencia'),
  ]).concat(bugEvidenceChildren(p.evidenceImages)).concat([
    docxLabelPara('Asignado a', p.dev),
  ]);
  var hf = docxHeaderFooter('Reporte de Bug');
  var doc = new Document({
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21, language: { value: DOCX_LANG } } } } },
    sections: [ { properties: {}, headers: { default: hf.header }, footers: { default: hf.footer }, children: children } ],
  });
  return Packer.toBuffer(doc);
}

// Dossier de Evidencias (cierre de Certificacion QA): por cada caso ejecutado, su
// paso a paso + resultado esperado + veredicto + evidencia real (imagenes, ya
// persistidas via c.evidenceData en el cliente -- Fase 6). Reusa embedOneEvidenceImage
// (mismo parser de dimensiones que el Word del bug) en vez de duplicarlo.
function dossierCaseTable(steps) {
  var header = new TableRow({ cantSplit: true, children: [
    docxCell('#', {header:true, width:8}), docxCell('Paso', {header:true, width:46}), docxCell('Resultado esperado', {header:true, width:46}),
  ]});
  var body = (steps && steps.length)
    ? steps.map(function(s, i){ return new TableRow({ cantSplit: true, children: [ docxCell(String(i+1)), docxCell(s.paso||'-'), docxCell(s.resultado||'-') ] }); })
    : [ new TableRow({ cantSplit: true, children: [ docxCell('-'), docxCell('(sin pasos definidos)'), docxCell('-') ] }) ];
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header].concat(body) });
}
function dossierCaseChildren(c) {
  var out = [
    new Paragraph({ keepNext: true, keepLines: true, spacing: { before: 220, after: 60 }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: DOCX_TEAL, space: 8 } }, children: [
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
    styles: { default: { document: { run: { font: DOCX_FONT, size: 21, language: { value: DOCX_LANG } } } } },
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
// Estados en espanol (decision 2026-10-08: no hay audiencia en ingles) -- la IA los
// copia tal cual al documento del cliente.
var ESTADOS_ES = { todo: 'Sin ejecutar', pass: 'Exitoso', retired: 'Desestimado', fail: 'Fallido', blocked: 'Bloqueado' };
function summarizeCasesForPrompt(cases) {
  if (!cases || !cases.length) return '(sin casos registrados)';
  return cases.map(function(c){
    return (c.id || 'CP') + ' | ' + (c.caso || c.escenario || '') + ' | estado: ' + (ESTADOS_ES[c.status || 'todo'] || c.status) +
      (c.verdict ? ' | resultado de verificacion: ' + (c.verdict === 'PASS' ? 'Exitoso' : c.verdict === 'FAIL' ? 'Fallido' : c.verdict) : '') +
      (c.estadoNota && String(c.estadoNota).trim() ? ' | motivo registrado por el QA: ' + String(c.estadoNota).trim() : '') +
      (c.bloqueoDestino ? ' | destino del caso bloqueado: ' + c.bloqueoDestino : '');
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
    'RESULTADOS DE EJECUCION (' + total + ' casos totales -- Exitosos: ' + passN + ', Desestimados: ' + retiredN + ', Fallidos: ' + failN + ', Bloqueados: ' + blkN + ', Sin ejecutar: ' + todoN + '):',
    summarizeCasesForPrompt(cases),
    '',
    'DEFECTOS REGISTRADOS:',
    summarizeBugsForPrompt(bugs),
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Basate UNICAMENTE en los resultados reales de arriba -- no inventes cifras ni resultados. Este documento certifica',
    '   la calidad ante el cliente final -- CERO informacion inventada, sin excepcion.',
    '2. Si hay casos Sin ejecutar, Bloqueados o Desestimados, justifica su impacto en la conclusion. Usa como motivo',
    '   UNICAMENTE el "motivo registrado por el QA" de cada caso (si lo trae) o un bug asociado en DEFECTOS REGISTRADOS.',
    '   Si un caso no trae motivo, NO lo inventes (priorizacion, falta de tiempo, ambiente, ventana de pruebas...): di',
    '   solo que esta pendiente, que su cumplimiento no esta evidenciado y que impacto tiene eso.',
    '   Usa siempre los nombres de estado en espanol (Exitoso, Fallido, Bloqueado, Desestimado, Sin ejecutar).',
    '3. La conclusion de calidad debe ser honesta: si hay fails criticos sin resolver, no certifiques como apto sin condiciones.',
    '4. NO menciones que la ejecucion de pruebas uso o se apoyo en inteligencia artificial -- este documento describe',
    '   los resultados de QA hacia el cliente, no la herramienta interna que usa TestiAlab.',
    '5. NO cites los identificadores internos del analisis (CA_N, RN_N, R_N, ESC_N ni rangos como "CA_5 a CA_7") en',
    '   NINGUNA seccion: el cliente no conoce esa numeracion. Describe cada criterio o regla por su contenido. Los IDs de',
    '   casos (CP_N) y de bugs (BUG_N) SI se pueden citar -- el cliente los ve en el Excel de casos y en el reporte del bug.',
    '6. MODELO DE ENTREGA DE TESTIALAB (el mismo del Plan de Pruebas): Desarrollo entrega el desarrollo COMPLETO en una',
    '   sola entrega y QA ejecuta TODOS los casos sobre ella; a medida que se corrigen bugs, QA hace re-test de cada bug y',
    '   regresión focalizada de los casos impactados, hasta cerrar. Los pendientes se ejecutan sobre ESA misma entrega.',
    '   NUNCA hables de "otra iteracion", "iteracion complementaria", "siguiente ciclo", "segundo ciclo", "entregas',
    '   parciales" ni "sprints". "El ciclo de pruebas" en singular, como nombre de todo el proceso, si esta permitido.',
    '7. ' + ORTOGRAFIA_DOC_CLIENTE,
    '8. Responde UNICAMENTE con las secciones delimitadas. Sin texto adicional.',
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
// Desde multer 2.4 (npm audit fix, 2026-10-08) el nombre YA llega bien en UTF-8:
// re-decodificarlo convertia "Integración" en "Integraci�n" y Chrome cambiaba
// ese caracter por "_" al descargar. Solo se repara si el resultado es UTF-8 valido
// (sin �) y distinto; si no, el nombre ya estaba bien y se deja igual.
function fixMojibake(name) {
  name = String(name || '');
  if (/[^\u0000-ÿ]/.test(name)) return name; // tiene caracteres fuera de latin1: ya es UTF-8 real
  var fixed = Buffer.from(name, 'latin1').toString('utf8');
  return fixed.indexOf('�') === -1 ? fixed : name;
}

// Mismo patron de extraccion que extractDesarrolloTitle() en qa-suite.html --
// duplicado aca (no hay bundler que comparta codigo cliente/servidor) porque
// solo el servidor puede extraer texto de un PDF (mammoth/pdf-parse corren en
// Node). Si se ajusta el regex de un lado, ajustar tambien el otro.
// Mismo recorte que cleanReqTitle() del frontend: el campo "FECHA <fecha>" del
// encabezado a veces viene en el mismo renglon del titulo y no es parte del nombre.
function cleanReqTitle(t) {
  return String(t || '')
    .replace(/_+/g, ' ') // nombres de archivo con "_" en vez de espacios
    .replace(/[\s\-–—|:_]*FECHA(?![a-záéíóúñ]).*$/i, '')
    .replace(/[\s\-–—|:_]*\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\s*$/, '')
    .replace(/[\s\-–—|:_]*(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])20\d{2}\s*$/, '')
    .replace(/(?:^|[\s\-–—_]+)v(?:ersi[oó]n)?\.?\s*\d+(?:[._ ]\d+)*\s*$/i, '')
    .replace(/[\s\-–—|:_]*\b(?:Documento|Especificaci[oó]n)\s+(?:Funcional|T[eé]cnic[oa])\b[\s\-–—|:_]*/i, ' - ')
    .replace(/^[\s\-–—|:_]+|[\s\-–—|:_]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function extractDesarrolloTitleFromText(text) {
  if (!text) return '';
  var lines = text.split('\n').map(function(l){ return l.trim(); });
  for (var i = 0; i < lines.length; i++) {
    var m = /^DESARROLLO\b[\s:.\-]*(.*)$/i.exec(lines[i]);
    if (m) {
      if (m[1]) return cleanReqTitle(m[1]).slice(0,200);
      for (var j = i+1; j < lines.length; j++) {
        if (lines[j]) return cleanReqTitle(lines[j]).slice(0,200);
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

// ── M1: helpers del flujo inventario -> analisis -> auditoria -> reparacion ─────
function m1TmpFile(prefix, content, list) {
  var p = path.join(os.tmpdir(), prefix + Date.now() + '-' + Math.round(Math.random()*1e6) + '.txt');
  fs.writeFileSync(p, content, 'utf-8');
  if (list) list.push(p);
  return p;
}
// Algunas respuestas llegan envueltas en ```...```; el validador y el front esperan
// las secciones ---TAG--- desde la primera linea.
function stripCodeFences(text) {
  return String(text || '').replace(/^\s*```[a-z]*\s*\n/i, '').replace(/\n\s*```\s*$/, '').trim();
}
// Archivos/imagenes que el motor debe leer con su herramienta de archivos --
// todos viven bajo os.tmpdir() (multer + extractDocx asi los crean), asi que un
// solo --add-dir a la raiz temporal cubre cualquier combinacion de PDFs nativos
// + carpetas de imagenes extraidas de varios DOCX, sin importar cuantos sean.
function m1FileContext(files, textTmpPaths, engine) {
  var nativePdfPaths = files.filter(function(f){ return f.mode === 'native'; }).map(function(f){ return f.filePath; });
  var allImagePaths  = [].concat.apply([], files.map(function(f){ return f.imagePaths || []; }));
  // needsFileAccess es practicamente siempre true ahora (hasta el texto plano vive
  // en un .txt temporal que hay que leer), pero se deja la condicion explicita por
  // claridad y como salvaguarda si algun dia hay un modo sin ningun archivo real.
  var needsFileAccess = nativePdfPaths.length > 0 || allImagePaths.length > 0 || textTmpPaths.length > 0;
  return {
    aiOpts: { engine: engine, addDir: needsFileAccess ? os.tmpdir() : null, allowedTools: ['Read'], model: 'sonnet', effort: 'medium' },
    cleanup: function() {
      nativePdfPaths.forEach(function(p){ try { fs.unlink(p, function(){}); } catch(e){} });
      textTmpPaths.forEach(function(p){ try { fs.unlink(p, function(){}); } catch(e){} });
      files.forEach(function(f){
        if (f.imagePaths && f.imagePaths.length) { try { fs.rmSync(path.dirname(f.imagePaths[0]), { recursive: true, force: true }); } catch(e){} }
      });
    },
  };
}

function m1ItemCounts(traced) {
  return ['CA', 'RN', 'R', 'ESC'].map(function(p){
    return p + ':' + (String(traced).match(new RegExp('^\\s*' + p + '_\\d+', 'gm')) || []).length;
  }).join(',');
}

// Validador deterministico -> auditor IA (siempre, modo estricto) -> una reparacion
// acotada si hay hallazgos -> revalidacion. Si el auditor o la reparacion fallan, NO
// se cae el analisis: se devuelve el HU sin reparar y la auditoria lo dice.
async function auditAndRepairHU(o) {
  var tiempos = o.tiempos || {};
  function lap(name, since) { tiempos[name] = Math.round((Date.now() - since) / 100) / 10; }
  o.progress(60, 'Validando alineacion con el requerimiento...');
  var v1 = huValidator.validateHU({ traced: o.traced, inventory: o.inventory, conTrazas: o.conTrazas });

  o.progress(66, 'Auditando contradicciones y afirmaciones sin sustento...');
  var tAud = Date.now();
  var huPath = m1TmpFile('hu-audit-', o.traced, o.tmpList);
  var findingsPath = m1TmpFile('hu-findings-', JSON.stringify(v1.hallazgos, null, 1), o.tmpList);
  var auditorOk = true, auditorFindings = [];
  try {
    var arr = parseAuditorJson(await callAI(buildHUAuditorPrompt(o.files, o.inventoryPath, huPath, findingsPath), o.aiOpts));
    if (!arr) auditorOk = false;
    else auditorFindings = arr.filter(function(x){ return x && x.tipo; }).map(function(x){
      return { codigo: String(x.tipo).toUpperCase(), severidad: 'advertencia', ids: x.id ? [String(x.id)] : [],
               mensaje: x.evidencia || '', correccion: x.correccion_propuesta || '', origen: 'auditor' };
    });
  } catch (e) {
    auditorOk = false;
    console.error('[auditor HU]', e.message);
  }
  lap('auditoria', tAud);

  var toFix = v1.hallazgos.filter(function(h){ return h.severidad === 'error' || h.severidad === 'advertencia'; }).concat(auditorFindings);
  var traced = o.traced, reparado = false, repairError = null, final = v1;
  if (o.repair && toFix.length) {
    o.progress(80, 'Corrigiendo ' + toFix.length + ' hallazgo(s)...');
    var tRep = Date.now();
    var fixPath = m1TmpFile('hu-fix-', JSON.stringify(toFix, null, 1), o.tmpList);
    try {
      var fixed = stripCodeFences(await callAI(buildHURepairPrompt(o.files, o.inventoryPath, huPath, fixPath), o.aiOpts));
      if (/---CRITERIOS_DE_ACEPTACION---/i.test(fixed) && /---ESCENARIOS_QA---/i.test(fixed)) {
        console.log('[reparacion HU] items antes=' + m1ItemCounts(traced) + ' despues=' + m1ItemCounts(fixed));
        traced = fixed; reparado = true;
      }
      else repairError = 'la reparacion no devolvio un HU con todas sus secciones';
    } catch (e) {
      repairError = e.message;
      console.error('[reparacion HU]', e.message);
    }
    lap('reparacion', tRep);
    if (reparado) {
      o.progress(94, 'Revalidando el HU corregido...');
      final = huValidator.validateHU({ traced: traced, inventory: o.inventory, conTrazas: o.conTrazas });
    }
  }

  // Lo que queda despues de la (unica) reparacion se devuelve como advertencia. Los
  // "juicio" que el auditor ya reviso y no reporto pasan a informativos.
  var hallazgos = final.hallazgos.map(function(h){
    if (h.severidad === 'juicio' && auditorOk) return Object.assign({}, h, { severidad: 'info' });
    if (h.severidad === 'error' && reparado) return Object.assign({}, h, { severidad: 'advertencia' });
    return h;
  });
  if (!reparado) hallazgos = hallazgos.concat(auditorFindings);
  if (!auditorOk) hallazgos.push({ codigo: 'AUDITOR', severidad: 'advertencia', ids: [], origen: 'sistema',
    mensaje: 'El auditor IA no devolvio un resultado valido; solo se aplico el validador automatico.' });
  if (repairError) hallazgos.push({ codigo: 'REPARACION', severidad: 'advertencia', ids: [], origen: 'sistema',
    mensaje: 'No se pudo aplicar la correccion automatica (' + repairError + '); el HU se muestra tal como se genero.' });

  return {
    traced: traced,
    audit: {
      estado: huValidator.auditEstado(hallazgos),
      hallazgos: hallazgos,
      corregidos: reparado ? toFix : [],
      cobertura: final.cobertura,
      reparado: reparado,
      auditor: auditorOk ? 'ok' : 'fallo',
      tiempos: tiempos,
    },
  };
}

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

  var ctx = m1FileContext(files, textTmpPaths, engine);
  var t0 = Date.now(), tiempos = {};
  function lap(name, since) { tiempos[name] = Math.round((Date.now() - since) / 100) / 10; }

  try {
    // Pasada 1 (ambos motores): inventario + glosario (ver buildAnalysisInventoryPrompt).
    // Va a un .txt temporal y se referencia por ruta en las pasadas siguientes, para no
    // inflar el prompt (agy recibe el prompt por argumento).
    emitProgress(reqId, 15, 'Inventariando condiciones del requerimiento ('+engineLabel+')...');
    var tInv = Date.now();
    var inventory = stripCodeFences(await callAI(buildAnalysisInventoryPrompt(files), ctx.aiOpts));
    lap('inventario', tInv);
    var inventoryPath = m1TmpFile('analyze-inventory-', inventory, textTmpPaths);

    emitProgress(reqId, 35, 'Generando Historia de Usuario, criterios, reglas, riesgos y escenarios...');
    var tAn = Date.now();
    var traced = stripCodeFences(await callAI(buildMultiFileAnalysisPrompt(files, engine, inventoryPath), ctx.aiOpts));
    lap('analisis', tAn);
    console.log('[/api/analyze] ' + engine + ' items del analisis=' + m1ItemCounts(traced));

    var result = await auditAndRepairHU({
      files: files, aiOpts: ctx.aiOpts, inventory: inventory, inventoryPath: inventoryPath,
      traced: traced, conTrazas: true, repair: true, tmpList: textTmpPaths, tiempos: tiempos,
      progress: function(pct, label){ emitProgress(reqId, pct, label); },
    });
    lap('total', t0);
    ctx.cleanup();

    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    console.log('[/api/analyze] ' + engine + ' tiempos(s)=' + JSON.stringify(tiempos) + ' estado=' + result.audit.estado +
      ' hallazgos=' + result.audit.hallazgos.length + ' reparado=' + result.audit.reparado);
    return res.json({
      analysis: huValidator.stripTraceMarks(result.traced).trim(),
      engine: engine,
      trace: { traced: result.traced, inventory: inventory, glossary: huValidator.parseInventory(inventory).glossary },
      audit: result.audit,
    });

  } catch(err) {
    ctx.cleanup();
    emitDone(reqId);
    console.error('[/api/analyze]', err.message);
    return res.status(502).json({ error: engineLabel+': '+err.message });
  }
});

// ── M1: auditar un HU que NO salio de /api/analyze (importado desde Word) ──────
// Solo tiene sentido si hay un requerimiento cargado contra el cual comparar. Se arma
// el inventario de ese requerimiento y se corre validador (sin trazas: el Word no las
// trae) + auditor. NO se repara: el QA importo un HU corregido a proposito.
app.post('/api/audit-hu', async function(req, res) {
  var files = req.body.files;
  var analysis = req.body.analysis;
  var engine = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var reqId = req.body.reqId || '';
  if (!analysis || !files || !files.length) return res.status(400).json({ error: 'Se requiere el HU (analysis) y el requerimiento (files[]).' });
  var engineLabel = engine === 'claude' ? 'Claude CLI' : 'Gemini (Antigravity CLI)';
  var textTmpPaths = [];
  files.forEach(function(f){
    if (f.mode !== 'native' && f.text != null) f._textFilePath = m1TmpFile('audit-text-', f.text, textTmpPaths);
  });
  // A diferencia de /api/analyze, aca NO se borran los PDF subidos: siguen siendo del
  // QA (puede analizarlos despues). Solo se borran los .txt temporales de esta llamada.
  var aiOpts = { engine: engine, addDir: os.tmpdir(), allowedTools: ['Read'], model: 'sonnet', effort: 'medium' };
  function cleanup() { textTmpPaths.forEach(function(p){ try { fs.unlink(p, function(){}); } catch(e){} }); }
  var t0 = Date.now(), tiempos = {};
  // /api/analyze borra los PDF subidos al terminar: si el inventario no viene del
  // analisis previo (mismo set de archivos), un PDF ya borrado no se puede releer.
  var missing = files.filter(function(f){ return f.mode === 'native' && !(f.filePath && fs.existsSync(f.filePath)); });
  if (!req.body.inventory && missing.length) {
    cleanup();
    return res.status(409).json({ error: 'El requerimiento ' + missing.map(function(f){ return f.filename; }).join(', ') +
      ' ya no esta disponible en el servidor. Vuelve a subirlo para auditar el HU importado.' });
  }
  files = files.filter(function(f){ return missing.indexOf(f) < 0; });
  try {
    var inventory = req.body.inventory;
    if (!inventory) {
      emitProgress(reqId, 15, 'Inventariando el requerimiento cargado ('+engineLabel+')...');
      inventory = stripCodeFences(await callAI(buildAnalysisInventoryPrompt(files), aiOpts));
      tiempos.inventario = Math.round((Date.now() - t0) / 100) / 10;
    }
    var inventoryPath = m1TmpFile('audit-inventory-', inventory, textTmpPaths);
    var result = await auditAndRepairHU({
      files: files, aiOpts: aiOpts, inventory: inventory, inventoryPath: inventoryPath,
      traced: analysis, conTrazas: false, repair: false, tmpList: textTmpPaths, tiempos: tiempos,
      progress: function(pct, label){ emitProgress(reqId, pct, label); },
    });
    tiempos.total = Math.round((Date.now() - t0) / 100) / 10;
    cleanup();
    emitDone(reqId);
    return res.json({
      trace: { traced: null, inventory: inventory, glossary: huValidator.parseInventory(inventory).glossary },
      audit: result.audit,
    });
  } catch (err) {
    cleanup();
    emitDone(reqId);
    console.error('[/api/audit-hu]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── M4: auditor semantico de los casos (una llamada, Sonnet medium, ambos motores) ──
function buildCasesAuditorPrompt(inventoryPath, analysisPath, planPath, casesPath, findingsPath) {
  return [
    'Eres un auditor de calidad de casos de prueba. Verifica que los casos esten alineados con el requerimiento, la HU',
    'y el plan. NO reescribas los casos: solo reporta defectos concretos.',
    '',
    'Lee estos archivos con tu herramienta de lectura de archivos:',
    '- Inventario numerado del requerimiento (N | Tipo | Estado | Ref | Condicion) y glosario: ' + inventoryPath,
    '- HU (criterios, reglas, riesgos, escenarios): ' + analysisPath,
    planPath ? '- Plan de Pruebas: ' + planPath : null,
    '- Casos a auditar (la linea del ID trae [src: ...] y [cubre: ...]): ' + casesPath,
    '- Hallazgos del validador automatico (JSON): ' + findingsPath,
    '',
    'Busca SOLO estos tipos de defecto:',
    '- MAS_FUERTE_QUE_FUENTE: el resultado esperado es mas categorico que la fuente ("debe" donde dice "puede", plazos,',
    '  "tiempo real").',
    '- PREMISA_COMO_HECHO: una premisa condicional de la fuente escrita como hecho, o un resultado que inventa lo que una',
    '  definicion pendiente (DEP-XX) aun no fija.',
    '- CONSECUENCIA_INFERIDA: una consecuencia que la fuente no declara, o un dano comercial presentado como legal.',
    '- INCOHERENCIA: el caso contradice la HU o el plan (condicionado alla y no aqui, escenario con otro nombre, prueba',
    '  algo excluido del alcance).',
    '- RELLENO: un caso que no cubre ningun CA, RN, ESC o item del plan que no este ya cubierto, agregado solo por cantidad,',
    '  o que prueba algo que no es comportamiento del sistema (una tarea del proyecto, un acceso, una estimacion, el pais',
    '  o ambiente de despliegue).',
    '- FALTA_NEGATIVO_ENTRADA: un dato que el usuario digita o escanea en el flujo no tiene caso negativo con sus clases',
    '  invalidas (vacio, cero, negativo, mayor al disponible, inexistente, igual al origen...). En "caso" pon el CP_N del',
    '  flujo donde se digita, en "frase" el nombre del dato y en "correccion" las clases invalidas que aplican.',
    'NO es defecto: el caso NEGATIVO que verifica que una EXCLUSION del inventario no ocurre (por ejemplo, que no existe la',
    'opcion o la integracion excluida). Ese caso es obligatorio para cubrir la exclusion; no lo reportes como INCOHERENCIA,',
    'RELLENO ni "prueba algo excluido". Solo es defecto si EJECUTA la funcionalidad excluida.',
    'No reportes estilo ni cosas que la fuente respalda. Si no hay defectos, responde [].',
    '',
    'Responde SOLO con un arreglo JSON, sin texto adicional ni bloque de codigo:',
    '[{"caso":"CP_N","frase":"<frase exacta del caso>","tipo":"<MAS_FUERTE_QUE_FUENTE|PREMISA_COMO_HECHO|CONSECUENCIA_INFERIDA|',
    'INCOHERENCIA|RELLENO|FALTA_NEGATIVO_ENTRADA>","motivo":"<que dice la fuente>","correccion":"<como deberia quedar, o',
    'ELIMINAR si es relleno>"}]',
  ].filter(function(l){ return l !== null; }).join('\n');
}

// ── M4: reparacion acotada (una pasada, Sonnet medium): solo los casos senalados ──
function buildCasesRepairPrompt(inventoryPath, analysisPath, planPath, casesPath, findingsPath) {
  return [
    'Eres un Disenador de Casos de Prueba QA senior. Debes CORREGIR unicamente los casos que mencionan los hallazgos.',
    '',
    'Lee estos archivos con tu herramienta de lectura de archivos:',
    '- Inventario numerado del requerimiento y glosario: ' + inventoryPath,
    '- HU: ' + analysisPath,
    planPath ? '- Plan de Pruebas: ' + planPath : null,
    '- Casos actuales, con marcas [src]/[cubre]: ' + casesPath,
    '- Hallazgos a corregir (JSON): ' + findingsPath,
    '',
    'REGLAS DE LA CORRECCION:',
    '1. Devuelve SOLO los casos que corriges, completos y con su MISMO ID (### CP_N [src: ...] [cubre: ...]). No devuelvas',
    '   los casos que no cambian: la herramienta los conserva tal cual.',
    '2. Si un hallazgo dice que un caso es RELLENO o que hay que eliminarlo, devuelvelo con la linea "Eliminar: SI" debajo',
    '   del ID y nada mas. Nunca elimines el unico caso que cubre un CA_N, RN_N o ESC_N (corrigelo en su lugar), ni el caso',
    '   negativo que verifica que una EXCLUSION no ocurre.',
    '2.1 V11 (casos con la misma preparacion): devuelve el PRIMER caso del grupo con la preparacion una sola vez y un paso',
    '   de verificacion por cada caso del grupo, con Requisito y [cubre] = la union de todos; los demas del grupo van con',
    '   "Eliminar: SI". Si un caso del grupo necesita OTROS datos u otra precondicion (por ejemplo, un registro con un',
    '   atributo y otro sin el, o una configuracion distinta), dejalo aparte: une solo los que se verifican en la misma',
    '   ejecucion. V10 (no aporta cobertura) y V12 (conjunto exacto o campo por campo sin requisito que lo pida):',
    '   "Eliminar: SI" (si cubre algo que ningun otro caso cubre, pasa esa verificacion como paso al caso que nombra el',
    '   hallazgo y devuelvelo).',
    '3. Conserva el formato de cada caso (Requisito, Tipo, Complejidad, Escenario, Caso, Objetivo, Pasos "N. paso >>',
    '   resultado") y sus marcas.',
    '3.1 "por ejemplo" nunca lleva coma antes: si la frase queda "..., por ejemplo, ...", reescribela con parentesis',
    '   ("X igual al maximo permitido (por ejemplo, facturas)") o en una oracion aparte ("Por ejemplo, ...").',
    '4. Respeta estas reglas mientras corriges:',
    REGLAS_ALINEACION_CASOS,
    '',
    ORTOGRAFIA_DOC_CLIENTE + ' Conserva las tildes que ya traen los casos.',
    '',
    'Responde con la linea ---CASOS_DE_PRUEBA--- seguida de los casos corregidos, sin texto adicional. Si ninguno',
    'necesita cambio, responde ---CASOS_DE_PRUEBA--- y la linea SIN_CAMBIOS.',
  ].filter(function(l){ return l !== null; }).join('\n');
}

// Bloques "### CP_N ..." de un texto de casos (conserva las marcas); viven en el validador.
var m4CaseBlocks = casesValidator.caseBlocks;
var m4JoinCases = casesValidator.joinCases;

// Casos: validador -> auditor (siempre) -> faltantes de cobertura con el prompt de
// /api/generate-gap-cases (modelo fuerte, lista exacta) -> reparacion Sonnet de los casos
// senalados -> revalidacion. Misma forma que auditAndRepairPlan; nunca bloquea.
async function auditAndRepairCases(o) {
  var tiempos = o.tiempos || {};
  function lap(name, since) { tiempos[name] = Math.round((Date.now() - since) / 100) / 10; }
  function validate(traced) {
    return casesValidator.validateCases({ traced: traced, inventory: o.inventory, glossary: o.glossary,
      analysisTraced: o.analysisTraced || o.analysisRaw, planTraced: o.planTraced });
  }
  var traced = o.traced;
  o.progress(55, 'Validando los casos contra el requerimiento y el plan...');
  var v1 = validate(traced);

  o.progress(60, 'Auditando modales, premisas, incoherencias y relleno...');
  var tAud = Date.now();
  var casesPath = m1TmpFile('cases-audit-', traced, o.tmpList);
  var analysisPath = m1TmpFile('cases-analysis-', huValidator.stripTraceMarks(o.analysisRaw), o.tmpList);
  var findingsPath = m1TmpFile('cases-findings-', JSON.stringify(v1.hallazgos, null, 1), o.tmpList);
  var auditorOk = true, auditorFindings = [];
  try {
    var arr = parseAuditorJson(await callAI(buildCasesAuditorPrompt(o.inventoryPath, analysisPath, o.planPath, casesPath, findingsPath), o.fixOpts));
    if (!arr) auditorOk = false;
    else auditorFindings = arr.filter(function(x){ return x && x.tipo; }).map(function(x){
      return { codigo: String(x.tipo).toUpperCase(), severidad: 'advertencia', ids: x.caso ? [String(x.caso)] : [],
               mensaje: (x.frase ? '"' + x.frase + '": ' : '') + (x.motivo || ''), correccion: x.correccion || '', origen: 'auditor' };
    });
  } catch (e) {
    auditorOk = false;
    console.error('[auditor casos]', e.message);
  }
  lap('auditoria', tAud);

  var toFix = v1.hallazgos.filter(function(h){ return h.severidad === 'error' || h.severidad === 'advertencia'; }).concat(auditorFindings);
  var reparado = false, repairError = null, gapAdded = 0, keptDeletes = [];

  // Cobertura faltante: mismo prompt de "Generar casos para lo faltante", con la lista exacta.
  var gaps = v1.cobertura.hu.faltantes.map(function(id){ return { id: id, justificacion: 'Ningun caso lo cubre ([cubre]).' }; })
    .concat(v1.cobertura.plan.faltantes.map(function(t){ return { id: 'ALCANCE DEL PLAN', justificacion: t }; }))
    // Un dato que el usuario digita sin caso negativo: se genera con el mismo paso (no lo inventa la reparacion).
    .concat(auditorFindings.filter(function(h){ return h.codigo === 'FALTA_NEGATIVO_ENTRADA'; }).map(function(h){
      return { id: 'NEGATIVO DE UNA ENTRADA DEL USUARIO', justificacion: h.mensaje + (h.correccion ? ' Clases invalidas: ' + h.correccion : '') +
        ' Un solo caso con un paso por valor invalido (regla 3(e)), en el flujo de ' + (h.ids[0] || 'ese dato') + '.' };
    }));
  if (gaps.length) {
    o.progress(68, 'Generando casos para ' + gaps.length + ' item(s) sin cubrir...');
    var tGap = Date.now();
    try {
      var existing = casesValidator.parseCasesTraced(traced);
      var gapText = stripCodeFences(await callAI(buildGapCasesPrompt(o.analysisRaw, existing, gaps, o.m2Context, o.engine,
        { inventoryPath: o.inventoryPath, planPath: o.planPath, glossary: o.glossary }), o.genOpts));
      var newBlocks = /###\s*CP_/i.test(gapText) ? m4CaseBlocks(gapText) : [];
      if (newBlocks.length) {
        var all = m4CaseBlocks(traced).concat(newBlocks);
        // Renumera para evitar colisiones (mismo criterio que generateGapCases en el front).
        all = all.map(function(b, k){ return { id: 'CP_' + (k + 1), text: b.text.replace(/^###\s*CP_\d+/, '### CP_' + (k + 1)) }; });
        traced = m4JoinCases(all);
        gapAdded = newBlocks.length;
      }
    } catch (e) {
      console.error('[faltantes casos]', e.message);
    }
    lap('faltantes', tGap);
  }

  // Reparacion de los casos senalados (cobertura ya se atendio arriba).
  var caseFix = toFix.filter(function(h){ return h.codigo !== 'V1' && h.codigo !== 'FALTA_NEGATIVO_ENTRADA' && h.ids.some(function(id){ return /^CP_\d+$/.test(id); }); });
  if (caseFix.length) {
    o.progress(82, 'Corrigiendo ' + caseFix.length + ' hallazgo(s) en los casos...');
    var tRep = Date.now();
    var casesPath2 = m1TmpFile('cases-current-', traced, o.tmpList);
    var fixPath = m1TmpFile('cases-fix-', JSON.stringify(caseFix, null, 1), o.tmpList);
    try {
      var fixedText = stripCodeFences(await callAI(buildCasesRepairPrompt(o.inventoryPath, analysisPath, o.planPath, casesPath2, fixPath), o.fixOpts));
      // Reemplaza solo los casos devueltos, aplica "Eliminar: SI" salvo que deje sin caso
      // un CA/RN/ESC (salvaguarda) y renumera.
      var m = casesValidator.mergeRepairedCases(traced, fixedText);
      if (m.ok) {
        traced = m.traced;
        keptDeletes = m.conservados;
        reparado = true;
      } else repairError = 'la reparacion no devolvio casos en el formato esperado';
    } catch (e) {
      repairError = e.message;
      console.error('[reparacion casos]', e.message);
    }
    lap('reparacion', tRep);
  }

  var final = v1;
  if (gapAdded || reparado) {
    o.progress(94, 'Revalidando los casos corregidos...');
    final = validate(traced);
  }
  var fixedAny = gapAdded > 0 || reparado;
  var hallazgos = final.hallazgos.map(function(h){
    if (h.severidad === 'juicio' && auditorOk) return Object.assign({}, h, { severidad: 'info' });
    if (h.severidad === 'error' && fixedAny) return Object.assign({}, h, { severidad: 'advertencia' });
    return h;
  });
  // Los negativos faltantes ya se atendieron con casos nuevos si el paso de faltantes agrego alguno.
  if (!reparado) hallazgos = hallazgos.concat(auditorFindings.filter(function(h){ return !(gapAdded && h.codigo === 'FALTA_NEGATIVO_ENTRADA'); }));
  hallazgos = hallazgos.concat(keptDeletes);
  if (!auditorOk) hallazgos.push({ codigo: 'AUDITOR', severidad: 'advertencia', ids: [], origen: 'sistema',
    mensaje: 'El auditor IA no devolvio un resultado valido; solo se aplico el validador automatico.' });
  if (repairError) hallazgos.push({ codigo: 'REPARACION', severidad: 'advertencia', ids: [], origen: 'sistema',
    mensaje: 'No se pudo aplicar la correccion automatica (' + repairError + '); los casos se muestran tal como se generaron.' });

  return {
    traced: traced,
    audit: {
      estado: casesValidator.auditEstado(hallazgos), hallazgos: hallazgos, corregidos: fixedAny ? toFix : [],
      cobertura: final.cobertura, reparado: reparado, casosAgregados: gapAdded, auditor: auditorOk ? 'ok' : 'fallo', tiempos: tiempos,
    },
  };
}

// Contexto estructurado de M1/M3 para los endpoints de M4: inventario y plan a .txt
// temporales (se referencian por ruta). Sin inventario -> null (M4 funciona como antes).
function m4Context(body, tmpList) {
  if (!body.inventory) return null;
  return {
    inventory: body.inventory,
    glossary: body.glossary || [],
    analysisTraced: body.analysisTraced || '',
    planTraced: body.planTraced || '',
    inventoryPath: m1TmpFile('m4-inventory-', body.inventory, tmpList),
    planPath: body.planTraced ? m1TmpFile('m4-plan-', huValidator.stripTraceMarks(body.planTraced), tmpList) : null,
  };
}
function m4Cleanup(tmpList) { tmpList.forEach(function(p){ try { fs.unlink(p, function(){}); } catch(e){} }); }

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
  // Desde M1/M3: inventario + glosario + HU y plan con trazas. Sin inventario (analisis
  // viejo, HU importado sin requerimiento) los casos salen como antes y no se auditan.
  var tmpList = [];
  var ctx = m4Context(req.body, tmpList);
  var prompt = buildCasesPrompt(analysisRaw, m2Context, engine, transcripts, ctx);

  emitProgress(reqId, 8, 'Preparando prompt para '+engineLabel+'...');
  // Con auditoria, la generacion llega hasta ~50% y el resto lo reporta auditAndRepairCases.
  var stages = ctx ? [
    [15, 'Enviando a '+engineLabel+'...'],
    [30, 'Disenando escenarios y casos...'],
    [45, 'Redactando pasos y resultados esperados...'],
  ] : [
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
    // gemini-4-argon-high para Gemini via GEMINI_MODEL_MAP) -- antes solo
    // Claude recibia ese override; con Gemini caia al default 'sonnet'
    // (gemini-4-argon-low), el modelo mas debil, sin que nadie lo pidiera asi.
    var genOpts = { engine: engine, model: 'opus' };
    if (ctx) { genOpts.addDir = os.tmpdir(); genOpts.allowedTools = ['Read']; }
    var t0 = Date.now(), tiempos = {};
    var traced = stripCodeFences(await callAI(prompt, genOpts));
    clearInterval(stageTimer);
    tiempos.generacion = Math.round((Date.now() - t0) / 100) / 10;
    var result;
    if (ctx) {
      result = await auditAndRepairCases({
        engine: engine, genOpts: genOpts,
        fixOpts: { engine: engine, model: 'sonnet', effort: 'medium', addDir: os.tmpdir(), allowedTools: ['Read'] },
        inventory: ctx.inventory, inventoryPath: ctx.inventoryPath, glossary: ctx.glossary,
        analysisTraced: ctx.analysisTraced, analysisRaw: analysisRaw, planTraced: ctx.planTraced, planPath: ctx.planPath,
        m2Context: m2Context, traced: traced, tmpList: tmpList, tiempos: tiempos,
        progress: function(pct, label){ emitProgress(reqId, pct, label); },
      });
    } else {
      result = { traced: traced, audit: { estado: 'NO_AUDITADO', hallazgos: [], corregidos: [], reparado: false,
        motivo: 'El analisis de M1 no trae inventario (analisis anterior a la auditoria de alineacion o HU importado sin requerimiento).' } };
    }
    tiempos.total = Math.round((Date.now() - t0) / 100) / 10;
    result.audit.tiempos = tiempos;
    m4Cleanup(tmpList);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    console.log('[/api/generate-cases] ' + engine + ' tiempos(s)=' + JSON.stringify(tiempos) + ' estado=' + result.audit.estado +
      ' hallazgos=' + result.audit.hallazgos.length + ' reparado=' + result.audit.reparado + ' agregados=' + (result.audit.casosAgregados || 0));
    // cases: sin marcas (pantalla/Excel); casesTraced: con [src]/[cubre] (validador, consolidacion).
    return res.json({ cases: casesValidator.stripTraceMarks(result.traced).trim(), casesTraced: result.traced, audit: result.audit, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    m4Cleanup(tmpList);
    emitDone(reqId);
    console.error('[/api/generate-cases]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── Escenarios y Casos QA: consolidar casos de IA + QA + Cliente ──────────────
// M4 = modelo fuerte de cada motor (misma politica que /api/generate-cases).
app.post('/api/consolidate-cases', async function(req, res) {
  var analysisRaw = req.body.analysisRaw;
  var cases       = req.body.cases || [];
  var sources     = req.body.sources || []; // [{origen:'QA'|'Cliente', filename, text}]
  var m2Context   = req.body.m2Context || {};
  var engine      = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var engineLabel = engine === 'claude' ? 'Claude Opus' : 'Gemini (Antigravity)';
  var reqId       = req.body.reqId || '';
  if (!analysisRaw) return res.status(400).json({ error: 'Se requiere analysisRaw.' });
  if (!sources.length) return res.status(400).json({ error: 'Adjunta al menos un archivo con casos.' });
  emitProgress(reqId, 8, 'Preparando prompt para '+engineLabel+'...');
  var stages = [
    [20, 'Enviando a '+engineLabel+'...'],
    [40, 'Leyendo los casos externos...'],
    [60, 'Cruzando con los casos generados...'],
    [80, 'Armando la version final sin duplicados...'],
  ];
  var stageIdx = 0;
  var stageTimer = setInterval(function(){
    if (stageIdx < stages.length) { emitProgress(reqId, stages[stageIdx][0], stages[stageIdx][1]); stageIdx++; }
  }, 9000);
  var tmpList = [];
  var ctx = m4Context(req.body, tmpList);
  var callOpts = { engine: engine, model: 'opus' };
  if (ctx) { callOpts.addDir = os.tmpdir(); callOpts.allowedTools = ['Read']; }
  try {
    var text = await callAI(buildConsolidateCasesPrompt(analysisRaw, cases, sources, m2Context, ctx), callOpts);
    clearInterval(stageTimer);
    m4Cleanup(tmpList);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    // Con marcas si hubo contexto: el front las separa y revalida al aplicar (/api/validate-cases).
    return res.json({ raw: text, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    m4Cleanup(tmpList);
    emitDone(reqId);
    console.error('[/api/consolidate-cases]', err.message);
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
  var tmpList = [];
  var ctx = m4Context(req.body, tmpList);
  var prompt = buildGapCasesPrompt(analysisRaw, existingCases, gapItems, m2Context, engine, ctx);

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
    // gemini-4-argon-high para Gemini via GEMINI_MODEL_MAP) -- antes solo
    // Claude recibia ese override; con Gemini caia al default 'sonnet'
    // (gemini-4-argon-low), el modelo mas debil, sin que nadie lo pidiera asi.
    var callOpts = { engine: engine, model: 'opus' };
    if (ctx) { callOpts.addDir = os.tmpdir(); callOpts.allowedTools = ['Read']; }
    var text = await callAI(prompt, callOpts);
    clearInterval(stageTimer);
    m4Cleanup(tmpList);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ cases: text, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    m4Cleanup(tmpList);
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
  var tmpList = [];
  var ctx = m4Context(req.body, tmpList);
  var prompt = buildCoverageVerificationPrompt(analysisRaw, cases, ctx);

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
    // gemini-4-argon-high para Gemini via GEMINI_MODEL_MAP) -- antes solo
    // Claude recibia ese override; con Gemini caia al default 'sonnet'
    // (gemini-4-argon-low), el modelo mas debil, sin que nadie lo pidiera asi.
    var callOpts = { engine: engine, model: 'opus' };
    if (ctx) { callOpts.addDir = os.tmpdir(); callOpts.allowedTools = ['Read']; }
    var text = await callAI(prompt, callOpts);
    clearInterval(stageTimer);
    m4Cleanup(tmpList);
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ raw: text, engine: engine });
  } catch (err) {
    clearInterval(stageTimer);
    m4Cleanup(tmpList);
    emitDone(reqId);
    console.error('[/api/verify-coverage]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// ── Escenarios y Casos QA: revalidar sin IA ────────────────────────────────────
// Despues de aplicar una consolidacion o agregar casos faltantes el set cambia: se
// vuelve a correr solo el validador deterministico (gratis, sin auditor ni reparacion).
app.post('/api/validate-cases', function(req, res) {
  var b = req.body || {};
  if (!b.inventory) return res.json({ audit: { estado: 'NO_AUDITADO', hallazgos: [], corregidos: [], reparado: false,
    motivo: 'El analisis de M1 no trae inventario.' } });
  if (!b.casesTraced) return res.status(400).json({ error: 'Se requiere casesTraced.' });
  try {
    var v = casesValidator.validateCases({ traced: b.casesTraced, inventory: b.inventory, glossary: b.glossary || [],
      analysisTraced: b.analysisTraced || '', planTraced: b.planTraced || '' });
    return res.json({ audit: { estado: casesValidator.auditEstado(v.hallazgos), hallazgos: v.hallazgos, corregidos: [],
      cobertura: v.cobertura, reparado: false, auditor: 'no', soloValidador: true } });
  } catch (err) {
    console.error('[/api/validate-cases]', err.message);
    return res.status(500).json({ error: err.message });
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
  // Desde M1 (#75): inventario + glosario + analisis con trazas. Sin inventario (analisis
  // viejo, o HU importado sin requerimiento) el plan se genera como antes y no se audita.
  var inventory = req.body.inventory || '';
  var glossary = req.body.glossary || [];
  var analysisTraced = req.body.analysisTraced || '';
  var responsables = req.body.responsables || [];
  var projectName = req.body.projectName ? planValidator.normalizeTitle(req.body.projectName) : '';
  var tmpList = [];
  function cleanup() { tmpList.forEach(function(p){ try { fs.unlink(p, function(){}); } catch(e){} }); }
  var inventoryPath = inventory ? m1TmpFile('plan-inventory-', inventory, tmpList) : null;
  var aiOpts = { engine: engine, model: 'sonnet', effort: 'medium' };
  if (inventoryPath) { aiOpts.addDir = os.tmpdir(); aiOpts.allowedTools = ['Read']; }
  var prompt = buildPlanPruebasPrompt(analysisRaw, m2Context, engine, { inventoryPath: inventoryPath, glossary: glossary, projectName: projectName });

  var t0 = Date.now(), tiempos = {};
  try {
    emitProgress(reqId, 15, 'Redactando el Plan de Pruebas con ' + engineLabel + '...');
    var traced = stripCodeFences(await callAI(prompt, aiOpts));
    tiempos.plan = Math.round((Date.now() - t0) / 100) / 10;
    var result;
    if (inventoryPath) {
      result = await auditAndRepairPlan({
        aiOpts: aiOpts, inventory: inventory, inventoryPath: inventoryPath, glossary: glossary,
        analysis: analysisTraced || analysisRaw, analysisRaw: analysisRaw, responsables: responsables,
        traced: traced, tmpList: tmpList, tiempos: tiempos,
        progress: function(pct, label){ emitProgress(reqId, pct, label); },
      });
    } else {
      result = { traced: traced, audit: { estado: 'NO_AUDITADO', hallazgos: [], corregidos: [], reparado: false,
        motivo: 'El analisis de M1 no trae inventario (analisis anterior a la auditoria de alineacion o HU importado sin requerimiento).' } };
    }
    tiempos.total = Math.round((Date.now() - t0) / 100) / 10;
    result.audit.tiempos = tiempos;
    cleanup();
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    console.log('[/api/generate-plan] ' + engine + ' tiempos(s)=' + JSON.stringify(tiempos) + ' estado=' + result.audit.estado +
      ' hallazgos=' + result.audit.hallazgos.length + ' reparado=' + result.audit.reparado);
    return res.json({ plan: planValidator.stripTraceMarks(result.traced).trim(), engine: engine, planTraced: result.traced, audit: result.audit });
  } catch (err) {
    cleanup();
    emitDone(reqId);
    console.error('[/api/generate-plan]', err.message);
    return res.status(502).json({ error: engineLabel + ': ' + err.message });
  }
});

// Plan: validador -> auditor (siempre) -> una reparacion acotada -> revalidacion. Misma
// forma que auditAndRepairHU (M1); nunca bloquea la entrega del plan.
async function auditAndRepairPlan(o) {
  var tiempos = o.tiempos || {};
  function lap(name, since) { tiempos[name] = Math.round((Date.now() - since) / 100) / 10; }
  function validate(traced) {
    return planValidator.validatePlan({ traced: traced, inventory: o.inventory, glossary: o.glossary, analysis: o.analysis, responsables: o.responsables });
  }
  o.progress(55, 'Validando el plan contra el requerimiento...');
  var v1 = validate(o.traced);

  o.progress(62, 'Auditando modales, premisas e incoherencias...');
  var tAud = Date.now();
  var planPath = m1TmpFile('plan-audit-', o.traced, o.tmpList);
  var analysisPath = m1TmpFile('plan-analysis-', huValidator.stripTraceMarks(o.analysisRaw), o.tmpList);
  var findingsPath = m1TmpFile('plan-findings-', JSON.stringify(v1.hallazgos, null, 1), o.tmpList);
  var auditorOk = true, auditorFindings = [];
  try {
    var arr = parseAuditorJson(await callAI(buildPlanAuditorPrompt(o.inventoryPath, analysisPath, planPath, findingsPath), o.aiOpts));
    if (!arr) auditorOk = false;
    else auditorFindings = arr.filter(function(x){ return x && x.tipo; }).map(function(x){
      return { codigo: String(x.tipo).toUpperCase(), severidad: 'advertencia', ids: x.seccion ? [String(x.seccion)] : [],
               mensaje: (x.frase ? '"' + x.frase + '": ' : '') + (x.motivo || ''), correccion: x.correccion || '', origen: 'auditor' };
    });
  } catch (e) {
    auditorOk = false;
    console.error('[auditor plan]', e.message);
  }
  lap('auditoria', tAud);

  // V8 (Responsables) no lo corrige la IA: los llena el QA en pantalla.
  var toFix = v1.hallazgos.filter(function(h){ return (h.severidad === 'error' || h.severidad === 'advertencia') && h.codigo !== 'V8'; }).concat(auditorFindings);
  var traced = o.traced, reparado = false, repairError = null, final = v1;
  if (toFix.length) {
    o.progress(78, 'Corrigiendo ' + toFix.length + ' hallazgo(s) del plan...');
    var tRep = Date.now();
    var fixPath = m1TmpFile('plan-fix-', JSON.stringify(toFix, null, 1), o.tmpList);
    try {
      var fixed = stripCodeFences(await callAI(buildPlanRepairPrompt(o.inventoryPath, analysisPath, planPath, fixPath), o.aiOpts));
      if (/---ALCANCE_DENTRO---/i.test(fixed) && /---CRITERIOS_SALIDA---/i.test(fixed)) { traced = fixed; reparado = true; }
      else repairError = 'la reparacion no devolvio un plan con todas sus secciones';
    } catch (e) {
      repairError = e.message;
      console.error('[reparacion plan]', e.message);
    }
    lap('reparacion', tRep);
    if (reparado) {
      o.progress(94, 'Revalidando el plan corregido...');
      final = validate(traced);
    }
  }

  var hallazgos = final.hallazgos.map(function(h){
    if (h.severidad === 'juicio' && auditorOk) return Object.assign({}, h, { severidad: 'info' });
    if (h.severidad === 'error' && reparado) return Object.assign({}, h, { severidad: 'advertencia' });
    return h;
  });
  if (!reparado) hallazgos = hallazgos.concat(auditorFindings);
  if (!auditorOk) hallazgos.push({ codigo: 'AUDITOR', severidad: 'advertencia', ids: [], origen: 'sistema',
    mensaje: 'El auditor IA no devolvio un resultado valido; solo se aplico el validador automatico.' });
  if (repairError) hallazgos.push({ codigo: 'REPARACION', severidad: 'advertencia', ids: [], origen: 'sistema',
    mensaje: 'No se pudo aplicar la correccion automatica (' + repairError + '); el plan se muestra tal como se genero.' });

  return {
    traced: traced,
    audit: {
      estado: planValidator.auditEstado(hallazgos), hallazgos: hallazgos, corregidos: reparado ? toFix : [],
      cobertura: final.cobertura, reparado: reparado, auditor: auditorOk ? 'ok' : 'fallo', tiempos: tiempos,
    },
  };
}

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

// ── Gestion de Bugs: redactar el bug como lo escribiria un QA ────────────────────
// Demo 2026-10-08: la descripcion del bug era el veredicto de la IA copiado (hablaba
// de capturas y evidencias, no del defecto). Aca se redacta para el desarrollador.
function buildDraftBugPrompt(c) {
  c = c || {};
  var steps = (c.steps || []).map(function(s, i){
    var v = (c.stepVerdicts && c.stepVerdicts[i] === false) ? 'FALLO' + (c.stepReasons && c.stepReasons[i] ? ' -- ' + c.stepReasons[i] : '') :
            (c.stepVerdicts && c.stepVerdicts[i] === true) ? 'OK' : 'sin verificar';
    return (i+1) + '. Paso: ' + (s.paso || '-') + ' | Resultado esperado: ' + (s.resultado || '-') + ' | Ejecucion: ' + v;
  }).join('\n');
  return [
    'Eres un Analista QA senior redactando el reporte de un bug para el equipo de desarrollo, a partir de un caso de',
    'prueba que fallo durante la ejecucion.',
    '',
    'CASO DE PRUEBA: ' + (c.id || '-') + ' -- ' + (c.caso || '-'),
    'Escenario: ' + (c.escenario || '-'),
    'Objetivo: ' + (c.objetivo || '-'),
    '',
    'PASOS DEL CASO Y RESULTADO DE LA EJECUCION:',
    steps || '(sin pasos)',
    '',
    'OBSERVACION DE LA VERIFICACION: ' + (c.verdictNote || '(ninguna)'),
    '',
    'INSTRUCCIONES CRITICAS:',
    '1. Describe el DEFECTO del sistema (que falla, donde y bajo que condicion), como lo escribiria un QA para un',
    '   desarrollador: claro, concreto y breve. NO hables de capturas, evidencias, veredictos, verificaciones ni de IA.',
    '2. CERO informacion inventada: usa solo lo que dicen los pasos, sus resultados y las razones de falla. Si no se',
    '   sabe con certeza que mostro el sistema, describe lo observable sin inventar datos, mensajes ni valores.',
    '3. Los pasos para reproducir llegan hasta el punto donde se observa la falla, en orden y accionables.',
    '4. Si la falla se debe a que la evidencia estaba incompleta o no correspondia al caso (y no a un defecto del',
    '   sistema), dilo en NOTA_QA para que el QA lo revise antes de reportar. Si no, escribe NINGUNA.',
    '5. ' + ORTOGRAFIA_DOC_CLIENTE,
    '6. Responde UNICAMENTE con las secciones delimitadas. Sin texto adicional.',
    '',
    '---TITULO---',
    'Una sola linea (maximo 100 caracteres) que nombre el defecto, no el caso. MAL: "Falla en CP_3". BIEN: "El reporte no filtra por rango de fechas de vencimiento".',
    '',
    '---DESCRIPCION---',
    '2 a 4 frases: que ocurre, en que funcionalidad, bajo que condicion y que impacto tiene.',
    '',
    '---RESULTADO_ESPERADO---',
    '1 a 3 lineas.',
    '',
    '---RESULTADO_OBTENIDO---',
    '1 a 3 lineas.',
    '',
    '---PASOS---',
    'Un paso por linea, numerados (1. 2. 3.).',
    '',
    '---NOTA_QA---',
    'Una linea, o NINGUNA.',
  ].join('\n');
}
app.post('/api/draft-bug', async function(req, res) {
  var c = req.body.caso;
  var engine = (req.body.engine === 'gemini' || req.body.engine === 'claude') ? req.body.engine : ENGINE_DEFAULT;
  var engineLabel = engine === 'claude' ? 'Claude CLI' : 'Gemini (Antigravity CLI)';
  var reqId = req.body.reqId || '';
  if (!c || !c.id) return res.status(400).json({ error: 'Se requiere el caso de prueba.' });
  emitProgress(reqId, 20, 'Redactando el bug con ' + engineLabel + '...');
  try {
    var text = await callAI(buildDraftBugPrompt(c), { engine: engine, model: 'sonnet', effort: 'medium' });
    emitProgress(reqId, 98, 'Procesando respuesta...');
    emitDone(reqId);
    return res.json({ raw: text, engine: engine });
  } catch (err) {
    emitDone(reqId);
    console.error('[/api/draft-bug]', err.message);
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
      engine: engine, imagePaths: visionPaths, model: 'sonnet', effort: 'medium',
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
  if (!confluenceConfigured()) {
    return res.status(500).json({ error: 'Confluence no esta configurado. Define CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN y CONFLUENCE_FOLDER_ID antes de arrancar el proxy.' });
  }
  try {
    emitProgress(reqId, 8, 'Sincronizando base de conocimiento desde Confluence...');
    // El servidor precarga el modelo de embeddings al arrancar (ver app.listen), pero
    // si esta es la primera pregunta y ese precalentamiento todavia no termino, se
    // avisa explicitamente en vez de dejar "Indexando..." colgado sin explicacion.
    emitProgress(reqId, 15, _embedderPromise ? 'Indexando base de conocimiento (embeddings locales)...' : 'Cargando modelo de embeddings (primera vez en este servidor, puede tardar)...');
    var index = await ensureKnowledgeIndex();
    emitProgress(reqId, 45, 'Buscando fragmentos relevantes...');
    var chunks = await retrieveRelevantChunks(question, index);
    var prompt = buildChatQaPrompt(question, history, chunks);
    emitProgress(reqId, 60, 'Enviando a Claude CLI...');
    var text = await callAI(prompt, {
      engine: 'claude', model: 'sonnet', effort: 'medium',
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
    var text = await callAI(prompt, { engine: engine, model: 'sonnet', effort: 'medium' });
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
