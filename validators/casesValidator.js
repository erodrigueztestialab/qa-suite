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
  var seen = {};
  cases.forEach(function(c){
    var key = c.cubre.slice().sort().join(',') + '|' + norm(c.steps.map(function(s){ return s.paso; }).join(' ')).replace(/\s+/g, ' ');
    if (seen[key]) add('V10', 'advertencia', [seen[key], c.id], c.id + ' duplica ' + seen[key] + ' (mismo requisito y mismos pasos).');
    else seen[key] = c.id;
  });

  return { hallazgos: hallazgos, cobertura: cobertura, cases: cases };
}

module.exports = {
  parseCasesTraced: parseCasesTraced,
  validateCases: validateCases,
  stripTraceMarks: H.stripTraceMarks,
  auditEstado: H.auditEstado,
};
