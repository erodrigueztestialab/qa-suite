'use strict';
// Validador deterministico (sin IA) de los casos de prueba que genera M4.
//
// Recibe los casos CON marcas en la linea del ID ("### CP_3 [src: CA_2,DEP-01]
// [cubre: CA_2,ESC_3]"), el inventario y el glosario de M1, el analisis de M1 con sus
// trazas (de donde sale de que items del inventario viene cada CA/RN/ESC y si esta
// condicionado) y el plan de M3 con las suyas. Reutiliza los parsers de huValidator y
// planValidator. Devuelve hallazgos {codigo, severidad, ids, mensaje, origen} igual
// que M1/M3. Generico: nada de dominio de un cliente.

var H = require('./huValidator.js');
var P = require('./planValidator.js');
var norm = H.norm;

var VALID_TIPOS = ['smoke', 'func', 'funcional', 'ui', 'ux'];
var ID_RE = /\b(CA|RN|ESC|R)_\d+\b/gi;
var CODE_RE = /\b[A-Z]{2,6}-\d{1,4}\b/g;
var SRC_RE = /\[\s*src\s*:\s*([^\]]*)\]/i;
var CUBRE_RE = /\[\s*cubre\s*:\s*([^\]]*)\]/i;
var CONDITIONED_RE = /condicionad[oa]s?\s+a\b/;
// Un caso que cubre una exclusion solo puede verificar que la capacidad NO ocurre.
var NEGATIVE_RE = /\b(no se|no permite|no ejecuta|no muestra|no existe|no esta disponible|no ocurre|no realiza|no genera|no envia|no integra|no hay|no aparece|no ofrece|no habilita|no inicia|no dispara|no registra|ninguna|ningun|queda fuera|fuera del alcance|no forma parte)\b/;
var GENERIC_RE = /\b(desarrollo de terceros|terceros|un tercero|de un tercero|el tercero|el proveedor|proveedor externo|proveedor tercero|sistema externo|servicio externo|plataforma externa|herramienta externa)\b/;
var THIRD_GLOSSARY_TYPE_RE = /(proveedor|tercero|sistema|plataforma|servicio|herramienta|aplicacion|integracion)/;
var STRONG_WORDS_RE = /\b(tiempo real|exige|exigen|obligatoriamente|inmediatamente|incumplimiento normativo|sancion|sanciones|multa|multas)\b/g;

function uniq(arr) { return arr.filter(function(v, i){ return arr.indexOf(v) === i; }); }
function ids(text) { return uniq((String(text || '').match(ID_RE) || []).map(function(s){ return s.toUpperCase(); })); }

// Mismo formato que parseCasesBlock() del front (### CP_N + campos + "Pasos:" con
// "N. paso >> resultado"), mas las marcas de la linea del ID.
function parseCasesTraced(raw) {
  raw = String(raw || '');
  var block = H.parseSection(raw, 'CASOS_DE_PRUEBA') || (raw.indexOf('###') !== -1 ? raw.trim() : '');
  var chunks = block.split(/\n(?=\s*###\s*CP_\d+)/).map(function(s){ return s.trim(); }).filter(function(s){ return /^###\s*CP_\d+/.test(s); });
  return chunks.map(function(chunk){
    var headLine = chunk.split(/\r?\n/)[0];
    var id = /^###\s*(CP_\d+)/.exec(headLine)[1];
    var srcM = SRC_RE.exec(headLine), cubreM = CUBRE_RE.exec(headLine);
    var body = H.stripTraceMarks(chunk);
    function field(label) {
      var m = new RegExp('^[ \\t]*' + label + '[ \\t]*:[ \\t]*(.+)$', 'im').exec(body);
      return m ? m[1].trim() : '';
    }
    var pasosM = /^\s*Pasos\s*:\s*\n([\s\S]*)$/im.exec(body);
    var steps = (pasosM ? pasosM[1] : '').split(/\r?\n/).map(function(l){ return l.trim(); })
      .filter(function(l){ return /^\d+[.)]/.test(l); })
      .map(function(l){
        var t = l.replace(/^\d+[.)]\s*/, '');
        var i = t.indexOf('>>');
        return i >= 0 ? { paso: t.slice(0, i).trim(), resultado: t.slice(i + 2).trim() } : { paso: t.trim(), resultado: '' };
      });
    var srcTokens = srcM ? srcM[1].split(/[,;]/).map(function(s){ return s.trim(); }).filter(Boolean) : [];
    var requisito = field('Requisito');
    return {
      id: id, requisito: requisito, tipo: field('Tipo'), escenario: field('Escenario'), caso: field('Caso'),
      objetivo: field('Objetivo'), steps: steps, hasSrc: !!srcM, srcTokens: srcTokens,
      src: ids(srcTokens.join(' ')), srcCodes: uniq((srcTokens.join(' ').match(CODE_RE) || [])),
      srcNums: srcTokens.filter(function(t){ return /^\d+$/.test(t); }).map(Number),
      cubre: uniq((cubreM ? ids(cubreM[1]) : []).concat(ids(requisito))),
      cubreMarked: cubreM ? ids(cubreM[1]) : [],
    };
  });
}

// Raices de contenido (5 letras, sin palabras vacias) para comparar pasos y resultados.
var STEM_STOP_RE = /^(dado|cuando|entonces|sistema|usuario|que|con|para|por|una|uno|del|desde|este|esta|como|sobre|segun|verificar|validar|ingresar|seleccionar|dar|clic)$/;
function stems(text) {
  return uniq((norm(text).match(/[a-z]{4,}/g) || []).filter(function(w){ return !STEM_STOP_RE.test(w); }).map(function(w){ return w.slice(0, 5); }));
}
function containment(small, big) {
  if (!small.length) return 0;
  return small.filter(function(x){ return big.indexOf(x) >= 0; }).length / small.length;
}
function jaccard(a, b) {
  var inter = a.filter(function(x){ return b.indexOf(x) >= 0; }).length;
  var union = uniq(a.concat(b)).length;
  return union ? inter / union : 0;
}
// Un caso de "conjunto exacto" o "auditoria campo por campo" solo se justifica si algun
// CA/RN que cubre (o su fuente en el inventario) lo exige con palabras de exactitud.
var EXACT_CASE_RE = /\b(campo por campo|conjunto exacto|ni de mas ni de menos|ni mas ni menos|exactamente (las|los) (opciones|campos|columnas|elementos))\b/;
var EXACT_DEMAND_RE = /\b(exactamente|solo|solamente|unicamente)\b(\s+[a-z]+){0,3}\s+(columnas|campos|opciones|elementos|valores|siguientes)\b|\bni (de )?mas ni (de )?menos\b|\btodos los campos\b|\btodas las columnas\b|\bcampo a campo\b|\buno a uno\b|\bcada campo\b/;

function caseText(c) {
  return [c.escenario, c.caso, c.objetivo].concat(c.steps.map(function(s){ return s.paso + ' ' + s.resultado; })).join('\n');
}

function validateCases(opts) {
  opts = opts || {};
  var inv = H.parseInventory(opts.inventory || '');
  var glossary = opts.glossary && opts.glossary.length ? opts.glossary : inv.glossary;
  var cases = parseCasesTraced(opts.traced || '');
  var A = H.parseTracedAnalysis(opts.analysisTraced || '');
  var planItems = opts.planTraced ? P.parsePlanTraced(opts.planTraced) : [];
  var hallazgos = [];
  function add(codigo, severidad, idsArr, mensaje) {
    hallazgos.push({ codigo: codigo, severidad: severidad, ids: idsArr || [], mensaje: mensaje, origen: 'validador' });
  }
  var invByN = {};
  inv.items.forEach(function(it){ invByN[it.n] = it; });
  var isExcl = function(it){ return it && /exclu/i.test(it.tipo); };
  var refsAll = uniq(inv.items.map(function(it){ return (it.ref || '').toUpperCase(); }).filter(function(r){ return /[A-Z]/.test(r); }));
  var huById = {};
  A.items.forEach(function(it){ if (!huById[it.id]) huById[it.id] = it; });
  var required = A.items.filter(function(it){ return it.prefix === 'CA' || it.prefix === 'RN' || it.prefix === 'ESC'; });
  // Items de la HU que salen de una exclusion (la RN de alcance): solo caso negativo.
  var exclHu = A.items.filter(function(it){ return it.src.some(function(n){ return isExcl(invByN[n]); }); }).map(function(it){ return it.id; });
  var escTitles = A.items.filter(function(it){ return it.prefix === 'ESC'; }).map(function(it){ return norm(it.parts[2] || '').trim(); }).filter(Boolean);
  var sourceText = norm(H.stripTraceMarks(opts.analysisTraced || opts.analysis || '') + '\n' + H.stripTraceMarks(opts.planTraced || '') + '\n' +
    inv.items.map(function(it){ return it.condicion + ' ' + it.ref; }).join('\n') + '\n' + glossary.map(function(g){ return g.termino; }).join('\n'));
  function invNumsOfCase(c) {
    var nums = c.srcNums.slice();
    c.cubre.concat(c.src).forEach(function(id){ if (huById[id]) nums = nums.concat(huById[id].src); });
    return uniq(nums);
  }

  // V1: cobertura de la HU y del alcance del plan, por trazabilidad.
  var cobertura = { conInventario: inv.items.length > 0, hu: { total: required.length, cubiertos: 0, faltantes: [] },
    plan: { total: 0, cubiertos: 0, faltantes: [] }, condicionados: 0, exclusiones: exclHu.length };
  required.forEach(function(it){
    var hit = cases.some(function(c){ return c.cubre.indexOf(it.id) >= 0; });
    if (hit) cobertura.hu.cubiertos++; else cobertura.hu.faltantes.push(it.id);
  });
  if (cobertura.hu.faltantes.length) add('V1', 'error', cobertura.hu.faltantes, 'Sin caso que los cubra: ' + cobertura.hu.faltantes.join(', ') + '.');
  var caseNums = cases.map(invNumsOfCase);
  planItems.filter(function(p){ return p.sec === 'ALCANCE_DENTRO' && (p.src.nums.length || p.src.refs.length); }).forEach(function(p){
    cobertura.plan.total++;
    var hit = caseNums.some(function(nums, i){
      return p.src.nums.some(function(n){ return nums.indexOf(n) >= 0; }) ||
        p.src.refs.some(function(r){ return cases[i].srcCodes.indexOf(r) >= 0; });
    });
    if (hit) cobertura.plan.cubiertos++;
    else {
      cobertura.plan.faltantes.push(p.text);
      add('V1', 'error', [p.id], 'El alcance del plan "' + p.text + '" no tiene ningun caso.');
    }
  });

  cases.forEach(function(c){
    var text = caseText(c), t = norm(text);

    // V2: la condicion viaja CA/ESC -> caso con todos sus codigos.
    var condSrc = c.cubre.concat(c.src).map(function(id){ return huById[id]; }).filter(function(it){ return it && it.condicion; });
    var needRefs = uniq([].concat.apply([], condSrc.map(function(it){ return (it.condicion.match(CODE_RE) || []); }))
      .concat(c.srcCodes.filter(function(r){ return inv.items.some(function(it){ return (it.ref || '').toUpperCase() === r && it.estado === 'PENDIENTE'; }); })));
    if (condSrc.length || needRefs.length) {
      cobertura.condicionados++;
      var missing = needRefs.filter(function(r){ return t.indexOf(norm(r)) < 0; });
      if (!CONDITIONED_RE.test(t)) add('V2', 'error', [c.id], c.id + ' cubre ' + (condSrc.map(function(x){ return x.id; }).join(', ') || needRefs.join(', ')) +
        ', condicionado(s) a ' + (needRefs.join(', ') || 'un pendiente') + ', y el caso no dice "Condicionado a".');
      else if (missing.length) add('V2', 'error', [c.id], c.id + ' esta condicionado pero no nombra ' + missing.join(', ') + '.');
    }

    // V3: exclusiones solo con caso negativo.
    var touchesExcl = c.cubre.concat(c.src).some(function(id){ return exclHu.indexOf(id) >= 0; }) ||
      c.srcNums.some(function(n){ return isExcl(invByN[n]); });
    // Se mira lo que el caso verifica (caso, objetivo, resultados), no el nombre del
    // escenario: "X fuera del alcance" como escenario no hace negativo al caso.
    var verifies = norm([c.caso, c.objetivo].concat(c.steps.map(function(s){ return s.resultado; })).join('\n'));
    if (touchesExcl && !NEGATIVE_RE.test(verifies)) add('V3', 'error', [c.id], c.id + ' cubre una exclusion del alcance y no verifica que la capacidad NO ocurra (solo se admite el caso negativo).');

    // V4: resultados con alternativas combinadas.
    c.steps.forEach(function(s, i){
      var r = ' ' + norm(s.resultado).replace(/\by\/o\b/g, ' ').replace(/\b(mayor|menor|igual|antes|despues) o (igual|menor|mayor)\b/g, ' ') + ' ';
      if (/\s(o|u)\s/.test(r)) add('V4', 'advertencia', [c.id], c.id + ' paso ' + (i + 1) + ': el resultado esperado combina alternativas con "o" (un caso por alternativa).');
    });

    // V6: el escenario es uno de la HU (los de exclusion no tienen ESC por diseno).
    var onlyExcl = c.cubre.length && c.cubre.every(function(id){ return exclHu.indexOf(id) >= 0; });
    if (escTitles.length && c.escenario && !onlyExcl) {
      var e = norm(c.escenario).trim();
      if (!escTitles.some(function(x){ return x === e || x.indexOf(e) >= 0 || e.indexOf(x) >= 0; })) {
        add('V6', 'advertencia', [c.id], c.id + ': el escenario "' + c.escenario + '" no coincide con ningun escenario de la HU.');
      }
    }

    // V7: convenciones, Tipo, cifras inventadas y palabras mas fuertes que la fuente.
    if (/\b([Ee]l|[Aa]l|[Dd]el|[Uu]n|[Ll]os|[Pp]ara el|[Pp]or el|[Cc]on el) cliente\b/.test(text)) add('V7', 'advertencia', [c.id], c.id + ': "cliente" en minuscula; cuando es un rol se escribe "Cliente".');
    if (/,\s*por ejemplo/i.test(text)) add('V7', 'advertencia', [c.id], c.id + ': coma antes de "por ejemplo".');
    if (/\bpor ejemplo\b(?!,)/i.test(text)) add('V7', 'advertencia', [c.id], c.id + ': "por ejemplo" sin coma despues ("por ejemplo,").');
    if (VALID_TIPOS.indexOf(norm(c.tipo).trim()) < 0) add('V7', 'error', [c.id], c.id + ': Tipo "' + c.tipo + '" no es valido (solo Smoke, Func, UI o UX).');
    var numsText = text.replace(CODE_RE, ' ').replace(/\b(CA|RN|ESC|R|CP)_\d+\b/gi, ' ').replace(/\bN\s*[-+]\s*\d+\b/g, ' ');
    var bad = uniq(numsText.match(/\d+(?:[.,:\/]\d+)*/g) || []).filter(function(n){ return sourceText.indexOf(norm(n)) < 0; });
    if (bad.length) add('V7', 'advertencia', [c.id], c.id + ': cifra(s) o fecha(s) que el requerimiento no define: ' + bad.join(', ') + '. Usar N, N-1 o X.');
    var strong = uniq(t.match(STRONG_WORDS_RE) || []).filter(function(w){ return sourceText.indexOf(w) < 0; });
    if (strong.length) add('V7', 'advertencia', [c.id], c.id + ': "' + strong.join('", "') + '" no esta en el requerimiento (mas fuerte que la fuente).');

    // V8: cada paso con su resultado esperado.
    var sinRes = c.steps.map(function(s, i){ return s.resultado ? null : i + 1; }).filter(Boolean);
    if (!c.steps.length) add('V8', 'error', [c.id], c.id + ' no tiene pasos.');
    else if (sinRes.length) add('V8', 'error', [c.id], c.id + ': paso(s) ' + sinRes.join(', ') + ' sin resultado esperado (pasos y resultados deben ser iguales en cantidad).');

    // V9: marcas e IDs que existen.
    if (A.items.length) {
      var badIds = c.cubre.concat(c.src).filter(function(id){ return !huById[id]; });
      var badCodes = c.srcCodes.filter(function(r){ return refsAll.indexOf(r) < 0; });
      var badNums = c.srcNums.filter(function(n){ return !invByN[n]; }).map(String);
      var badAll = uniq(badIds.concat(badCodes, badNums));
      if (badAll.length) add('V9', 'error', [c.id], c.id + ' referencia ' + badAll.join(', ') + ', que no existe(n).');
      if (!c.hasSrc && inv.items.length) add('V9', 'advertencia', [c.id], c.id + ' no tiene marca de trazabilidad [src].');
    }
  });

  // V5: nombres propios del glosario y genericos prohibidos.
  var allCases = norm(cases.map(caseText).join('\n'));
  var thirdTerms = glossary.filter(function(g){ return THIRD_GLOSSARY_TYPE_RE.test(norm(g.tipo)); });
  var analysisClean = norm(H.stripTraceMarks(opts.analysisTraced || opts.analysis || ''));
  thirdTerms.forEach(function(g){
    var term = norm(g.termino);
    if (analysisClean.indexOf(term) >= 0 && allCases.indexOf(term) < 0) add('V5', 'advertencia', [], 'El nombre propio "' + g.termino + '" esta en el analisis pero en ningun caso.');
  });
  if (thirdTerms.length) {
    cases.forEach(function(c){
      var m = norm(caseText(c)).replace(/proveedor de desarrollo/g, ' ').match(GENERIC_RE);
      if (m) add('V5', 'error', [c.id], c.id + ' usa el generico "' + m[1] + '" en vez del nombre propio (' + thirdTerms.map(function(x){ return x.termino; }).join(', ') + ').');
    });
  }

  // V10: casos duplicados (mismo cubrimiento y mismos pasos).
  var seen = {}, dupIds = {};
  cases.forEach(function(c){
    var key = c.cubre.slice().sort().join(',') + '|' + norm(c.steps.map(function(s){ return s.paso; }).join(' ')).replace(/\s+/g, ' ');
    if (seen[key]) { add('V10', 'advertencia', [seen[key], c.id], c.id + ' duplica ' + seen[key] + ' (mismo requisito y mismos pasos).'); dupIds[c.id] = true; }
    else seen[key] = c.id;
  });
  // V10 por cobertura: todo lo que cubre el caso ya lo cubre otro caso del mismo escenario,
  // y lo que verifica (sus resultados esperados) ya esta en ese otro caso. Es el caso que
  // repite a otros "como unidad" o un Smoke que repite un Funcional.
  var isExclCase = function(c){ return c.cubre.concat(c.src).some(function(id){ return exclHu.indexOf(id) >= 0; }); };
  cases.forEach(function(c){
    if (dupIds[c.id] || !c.cubre.length || isExclCase(c)) return;
    var res = stems(c.steps.map(function(s){ return s.resultado; }).join(' '));
    var acts = stems(c.steps.map(function(s){ return s.paso; }).join(' '));
    var other = cases.find(function(o){
      if (o === c || norm(o.escenario).trim() !== norm(c.escenario).trim()) return false;
      if (!c.cubre.every(function(id){ return o.cubre.indexOf(id) >= 0; })) return false;
      if (o.cubre.length === c.cubre.length && o.steps.length < c.steps.length) return false; // el mas completo se queda
      // Lo que hace (pasos) y lo que verifica (resultados) ya esta en el otro: una variante
      // con otros datos ("inexistente" frente a "sin inventario", otra configuracion) no lo es.
      return containment(res, stems(o.steps.map(function(s){ return s.resultado; }).join(' '))) === 1 &&
        containment(acts, stems(o.steps.map(function(s){ return s.paso; }).join(' '))) >= 0.9;
    });
    if (other) add('V10', 'advertencia', [c.id, other.id], c.id + ' no aporta cobertura: todo lo que cubre y verifica ya esta en ' + other.id +
      ' (mismo escenario). Eliminarlo o dejar en ' + other.id + ' lo que le falte.');
  });

  // V11: casos fragmentados. Dos o mas casos con la MISMA preparacion (todos los pasos
  // menos el ultimo) que solo cambian la verificacion final son un solo caso con un paso
  // de verificacion por cada uno (las precargas de una pantalla, los valores invalidos de
  // un mismo dato). Infla el set sin agregar cobertura. Se exigen al menos 2 pasos de
  // preparacion: un solo paso comun (entrar a la pantalla) no hace hermanos a dos variantes.
  // Dos criterios (calibrados con un set real): (a) toda la preparacion casi igual, o
  // (b) mismo escenario y misma accion justo antes de la verificacion final (cada caso
  // redacta distinto como llega al registro, pero todos "presionan X" y "verifican Y").
  var prep = cases.map(function(c){ return c.steps.length >= 3 && !isExclCase(c) ? stems(c.steps.slice(0, -1).map(function(s){ return s.paso + ' ' + s.resultado; }).join(' ')) : null; });
  var penult = cases.map(function(c){ return c.steps.length >= 2 && !isExclCase(c) ? stems(c.steps[c.steps.length - 2].paso + ' ' + c.steps[c.steps.length - 2].resultado) : null; });
  var parent = cases.map(function(c, i){ return i; });
  function root(i) { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; }
  cases.forEach(function(c, i){
    cases.forEach(function(o, j){
      if (j <= i) return;
      var a = prep[i] && prep[j] && prep[i].length >= 3 && o.steps.length === c.steps.length && jaccard(prep[i], prep[j]) >= 0.8;
      var b = penult[i] && penult[j] && penult[i].length >= 2 && norm(c.escenario).trim() && norm(c.escenario).trim() === norm(o.escenario).trim() &&
        jaccard(penult[i], penult[j]) >= 0.8;
      if (a || b) parent[root(j)] = root(i);
    });
  });
  var groups = {};
  cases.forEach(function(c, i){ var r = root(i); (groups[r] = groups[r] || []).push(c); });
  Object.keys(groups).forEach(function(r){
    var group = groups[r];
    if (group.length < 2) return;
    var gIds = group.map(function(g){ return g.id; });
    add('V11', 'advertencia', gIds, gIds.join(', ') + ' repiten la misma preparacion y solo cambian la verificacion final: unirlos en ' + gIds[0] +
      ' con un paso de verificacion por cada uno (y la union de lo que cubren).');
  });

  // V12: caso de "conjunto exacto" o "auditoria campo por campo" que ningun CA/RN exige.
  cases.forEach(function(c){
    var title = norm(c.caso + ' ' + c.objetivo);
    if (!EXACT_CASE_RE.test(title)) return;
    var sources = c.cubre.concat(c.src).map(function(id){ return huById[id]; }).filter(Boolean);
    var srcText = norm(sources.map(function(it){ return it.text; }).join(' ') + ' ' +
      invNumsOfCase(c).map(function(n){ return invByN[n] ? invByN[n].condicion : ''; }).join(' '));
    if (!EXACT_DEMAND_RE.test(srcText)) add('V12', 'error', [c.id], c.id + ' es de "conjunto exacto" o "auditoria campo por campo" y ningun CA/RN que cubre lo exige (' +
      (c.cubre.join(', ') || 'sin requisito') + '): esos casos solo van si el requisito pide exactitud. Eliminarlo (lo que cubre ya lo cubren los demas casos).');
  });

  return { hallazgos: hallazgos, cobertura: cobertura, cases: cases };
}

// Bloques "### CP_N ..." de un texto de casos, por ID (conserva las marcas).
function caseBlocks(text) {
  var body = String(text || '');
  var i = body.search(/---\s*CASOS_DE_PRUEBA\s*---/i);
  if (i >= 0) body = body.slice(i).replace(/---\s*CASOS_DE_PRUEBA\s*---/i, '');
  var j = body.search(/\n---\s*[A-Z_]+\s*---/);
  if (j >= 0) body = body.slice(0, j);
  return body.split(/\n(?=\s*###\s*CP_\d+)/).map(function(s){ return s.trim(); })
    .filter(function(s){ return /^###\s*CP_\d+/.test(s); })
    .map(function(s){ return { id: /^###\s*(CP_\d+)/.exec(s)[1], text: s }; });
}
function joinCases(blocks) {
  return '---CASOS_DE_PRUEBA---\n' + blocks.map(function(b){ return b.text; }).join('\n');
}
function renumber(blocks) {
  return blocks.map(function(b, k){ return { id: 'CP_' + (k + 1), text: b.text.replace(/^###\s*CP_\d+/, '### CP_' + (k + 1)) }; });
}

// Aplica la respuesta de la reparacion (solo los casos corregidos, o "Eliminar: SI") sobre
// los casos actuales. Una eliminacion que dejaria sin caso un CA/RN/ESC no se aplica: se
// conserva el caso original y se reporta (p. ej. el caso negativo de una exclusion que el
// auditor tomo por "prueba algo excluido"). Devuelve { ok, traced, conservados }.
function mergeRepairedCases(traced, fixedText) {
  var fixed = caseBlocks(fixedText);
  if (!fixed.length && !/SIN_CAMBIOS/.test(String(fixedText || ''))) return { ok: false, traced: traced, conservados: [] };
  var byId = {};
  fixed.forEach(function(b){ byId[b.id] = b; });
  var isDel = function(b){ return /^\s*Eliminar\s*:\s*S[IÍ]/im.test(b.text); };
  var cubreOf = function(b){ var p = parseCasesTraced('---CASOS_DE_PRUEBA---\n' + b.text)[0]; return p ? p.cubre : []; };
  var current = caseBlocks(traced);
  var proposed = current.map(function(b){ return byId[b.id] || b; });
  var kept = [];
  proposed.forEach(function(b){ if (!isDel(b)) kept = kept.concat(cubreOf(b)); });
  var merged = proposed.map(function(b, k){
    if (!isDel(b)) return b;
    var lost = uniq(cubreOf(current[k]).filter(function(id){ return kept.indexOf(id) < 0; }));
    if (!lost.length) return null;
    kept = kept.concat(lost);
    return { id: current[k].id, text: current[k].text, lost: lost };
  }).filter(Boolean);
  var out = renumber(merged);
  // El mensaje usa el ID final (despues de renumerar), que es el que ve el QA.
  var conservados = merged.map(function(b, k){ return b.lost ? { codigo: 'REPARACION', severidad: 'advertencia', ids: [out[k].id], origen: 'sistema',
    mensaje: out[k].id + ' no se elimino: es el unico caso que cubre ' + b.lost.join(', ') + '. Revisalo a mano.' } : null; }).filter(Boolean);
  return { ok: true, traced: joinCases(out), conservados: conservados };
}

module.exports = {
  parseCasesTraced: parseCasesTraced,
  caseBlocks: caseBlocks,
  joinCases: joinCases,
  mergeRepairedCases: mergeRepairedCases,
  validateCases: validateCases,
  stripTraceMarks: H.stripTraceMarks,
  auditEstado: H.auditEstado,
  fixPorEjemploComma: H.fixPorEjemploComma,
};
