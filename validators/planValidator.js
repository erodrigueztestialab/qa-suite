'use strict';
// Validador deterministico (sin IA) del Plan de Pruebas que genera M3.
//
// Recibe el plan CON marcas [src: N,DEP-XX], el inventario y el glosario que M1 ya
// produjo (mismo formato: ver validators/huValidator.js, de donde se reutilizan los
// parsers), el analisis de M1 (con o sin trazas) y los Responsables. Devuelve
// hallazgos {codigo, severidad, ids, mensaje, origen}; severidades igual que en M1
// (error / advertencia / juicio). Generico: nada de dominio de un cliente.

var H = require('./huValidator.js');
var norm = H.norm;

var PLAN_SECTIONS = ['OBJETIVO', 'ALCANCE_DENTRO', 'ALCANCE_FUERA', 'SUPUESTOS', 'RIESGOS_FUNCIONALES', 'RIESGOS_NEGOCIO',
  'ESTRATEGIA', 'TIPOS_PRUEBA', 'NIVELES_PRUEBA', 'CRITERIOS_ENTRADA', 'CRITERIOS_SALIDA'];
var SECTION_LABEL = {
  OBJETIVO: 'Objetivo', ALCANCE_DENTRO: 'Dentro del Alcance', ALCANCE_FUERA: 'Fuera del Alcance', SUPUESTOS: 'Supuestos',
  RIESGOS_FUNCIONALES: 'Riesgos funcionales', RIESGOS_NEGOCIO: 'Riesgos de negocio', ESTRATEGIA: 'Estrategia',
  TIPOS_PRUEBA: 'Tipos de prueba', NIVELES_PRUEBA: 'Niveles de prueba', CRITERIOS_ENTRADA: 'Criterios de entrada',
  CRITERIOS_SALIDA: 'Criterios de salida',
};
var PARAGRAPH_SECTIONS = ['OBJETIVO', 'ESTRATEGIA'];
// Donde un item que sale de un pendiente debe decir "condicionado a <Ref>" (es el mismo
// alcance, contado en otro apartado) vs. donde basta con citar la Ref (supuestos,
// riesgos y criterios de entrada hablan DEL pendiente, no estan condicionados por el).
var CONDITIONED_SECTIONS = ['OBJETIVO', 'ALCANCE_DENTRO', 'ESTRATEGIA', 'TIPOS_PRUEBA', 'NIVELES_PRUEBA', 'CRITERIOS_SALIDA'];
var TRACE_SECTIONS = ['SUPUESTOS', 'RIESGOS_FUNCIONALES', 'RIESGOS_NEGOCIO', 'CRITERIOS_ENTRADA'];
var RISK_SECTIONS = ['RIESGOS_FUNCIONALES', 'RIESGOS_NEGOCIO'];
var SRC_REQUIRED_SECTIONS = ['ALCANCE_DENTRO', 'ALCANCE_FUERA', 'RIESGOS_FUNCIONALES', 'RIESGOS_NEGOCIO'];

var SRC_RE = /\[\s*src\s*:\s*([^\]]*)\]/gi;
var CODE_RE = /\b[A-Z]{2,6}-\d{1,4}\b/g;
var CONDITIONED_RE = /condicionad[oa]s?\s+a\b/;
var GENERIC_RE = /\b(desarrollo de terceros|terceros|un tercero|de un tercero|el tercero|el proveedor|proveedor externo|proveedor tercero|sistema externo|servicio externo|plataforma externa|herramienta externa)\b/;
var THIRD_GLOSSARY_TYPE_RE = /(proveedor|tercero|sistema|plataforma|servicio|herramienta|aplicacion|integracion)/;
var STRONG_WORDS_RE = /\b(tiempo real|exige|exigen|obligatoriamente|inmediatamente|incumplimiento normativo|sancion|sanciones|multa|multas)\b/g;
var TEAM_NAME = 'TestIAlab';
var TEAM_NAME_RE = /\btest\s?i\s?a\s?lab\b/gi;
var RESP_TEAMS = ['TestIAlab', 'Cliente', 'Proveedor de Desarrollo'];
var FILLER_RE = /^(por definir|sin definir|n\/?a|no aplica|pendiente|tbd|tbc|nombre|rol|cargo|contacto|correo|email|x+|-+|\.+|\(.*\)|\[.*\])$/i;

function uniq(arr) { return arr.filter(function(v, i){ return arr.indexOf(v) === i; }); }

// Marcas: numeros del inventario y/o codigos propios del documento (DEP-01).
function parseSrcTokens(raw) {
  var nums = [], refs = [], bad = [], found = false, m;
  SRC_RE.lastIndex = 0;
  while ((m = SRC_RE.exec(raw))) {
    found = true;
    m[1].split(/[,;]/).map(function(t){ return t.trim(); }).filter(Boolean).forEach(function(t){
      var n = /^[Nn]?\s*(\d+)$/.exec(t);
      if (n) nums.push(parseInt(n[1], 10));
      else if (/[A-Za-z]/.test(t) && /\d/.test(t)) refs.push(t.toUpperCase());
      else bad.push(t);
    });
  }
  return { nums: uniq(nums), refs: uniq(refs), bad: bad, hasSrc: found };
}

function parsePlanTraced(raw) {
  var items = [];
  PLAN_SECTIONS.forEach(function(sec){
    var body = H.parseSection(raw, sec);
    if (!body) return;
    var lines = body.split(/\r?\n/).map(function(l){ return l.trim(); }).filter(Boolean);
    lines.forEach(function(line, i){
      var s = parseSrcTokens(line);
      var text = H.stripTraceMarks(line).replace(/^[-*]\s*/, '').trim();
      if (!text) return;
      items.push({
        sec: sec, idx: i + 1, id: SECTION_LABEL[sec] + ' #' + (i + 1), text: text,
        src: s, codes: uniq(text.match(CODE_RE) || []),
      });
    });
  });
  return items;
}

// Nombre del proyecto con conectores en minuscula ("B2B Y Cadenas" -> "B2B y Cadenas").
// La primera palabra no se toca. Solo cambia conectores; siglas y nombres quedan igual.
var TITLE_CONNECTORS = ['y', 'e', 'o', 'u', 'de', 'del', 'la', 'el', 'los', 'las', 'en', 'con', 'por', 'para', 'a', 'al'];
function normalizeTitle(t) {
  var words = String(t || '').split(/(\s+)/);
  var seen = 0;
  return words.map(function(w){
    if (/^\s+$/.test(w) || !w) return w;
    seen++;
    if (seen > 1 && TITLE_CONNECTORS.indexOf(w.toLowerCase()) >= 0) return w.toLowerCase();
    return w;
  }).join('');
}

function validatePlan(opts) {
  opts = opts || {};
  var inv = H.parseInventory(opts.inventory || '');
  var glossary = opts.glossary && opts.glossary.length ? opts.glossary : inv.glossary;
  var items = parsePlanTraced(opts.traced || '');
  var hallazgos = [];
  function add(codigo, severidad, ids, mensaje) {
    hallazgos.push({ codigo: codigo, severidad: severidad, ids: ids || [], mensaje: mensaje, origen: 'validador' });
  }
  var invByN = {};
  inv.items.forEach(function(it){ invByN[it.n] = it; });
  var isExcl = function(it){ return /exclu/i.test(it.tipo); };
  // Solo son alcance los pendientes que gobiernan comportamiento: no son de contexto (tareas,
  // decisiones...) y, si el analisis trae trazas, algun CA o RN los cita. Los demas (accesos,
  // ubicar codigo, definiciones del proyecto que solo viven en un riesgo) van en supuestos,
  // riesgos o criterios de entrada: meterlos al alcance fabricaba 'funcionalidades' a probar.
  var tracedItems = opts.analysis && /\[\s*src\s*:/i.test(opts.analysis) ? H.parseTracedAnalysis(opts.analysis).items : null;
  function governsBehavior(it) {
    return !tracedItems || tracedItems.some(function(i){ return (i.prefix === 'CA' || i.prefix === 'RN') && i.src.indexOf(it.n) >= 0; });
  }
  var pend = inv.items.filter(function(it){ return it.estado === 'PENDIENTE' && !isExcl(it) && !H.isContext(it) && governsBehavior(it); });
  var pendOtros = inv.items.filter(function(it){ return it.estado === 'PENDIENTE' && !isExcl(it) && pend.indexOf(it) < 0; });
  var refsAll = uniq(inv.items.map(function(it){ return (it.ref || '').toUpperCase(); }).filter(function(r){ return /[A-Z]/.test(r); }));
  var pendRefs = uniq(pend.map(function(it){ return (it.ref || '').toUpperCase(); }).filter(function(r){ return /[A-Z]/.test(r); }));
  var analysisClean = H.stripTraceMarks(opts.analysis || '');
  var sourceText = norm(analysisClean + '\n' + inv.items.map(function(it){ return it.condicion + ' ' + it.ref; }).join('\n') + '\n' +
    glossary.map(function(g){ return g.termino; }).join('\n'));
  function bySec(secs) { return items.filter(function(i){ return secs.indexOf(i.sec) >= 0; }); }
  function mentionsRef(it, ref) { return it.src.refs.indexOf(ref) >= 0 || norm(it.text).indexOf(norm(ref)) >= 0; }
  // Pendientes de los que sale un item (por numero o por Ref) -> Refs que debe nombrar.
  function pendingOf(it) {
    var out = [];
    it.src.nums.forEach(function(n){ var p = invByN[n]; if (p && p.estado === 'PENDIENTE' && !isExcl(p) && !H.isContext(p)) out.push(p); });
    it.src.refs.concat(it.codes.map(function(c){ return c.toUpperCase(); })).forEach(function(r){
      pend.forEach(function(p){ if ((p.ref || '').toUpperCase() === r && out.indexOf(p) < 0) out.push(p); });
    });
    return out;
  }
  function labelOf(p) { return p.ref || ((p.contradiccion ? 'la contradiccion del item ' : 'item ') + p.n + ' del inventario'); }

  var cobertura = {
    conInventario: inv.items.length > 0,
    pendientes: { total: pend.length, refs: pendRefs, enDentroCondicionados: 0, trazados: 0 },
    riesgosAnalisis: { total: 0, reflejados: 0, sinReflejo: [] },
    exclusiones: inv.items.filter(isExcl).map(function(e){ return e.n; }),
    glosario: glossary.length,
  };

  // V1: pendientes nunca en Fuera del Alcance; todo pendiente en Dentro, condicionado.
  var fuera = bySec(['ALCANCE_FUERA']), dentro = bySec(['ALCANCE_DENTRO']);
  fuera.forEach(function(it){
    var p = pendingOf(it);
    if (p.length) add('V1', 'error', [it.id], it.id + ' esta en Fuera del Alcance pero depende de un pendiente (' + p.map(labelOf).join(', ') +
      '): va en Dentro del Alcance marcado "(condicionado a ...)".');
    else if (it.src.nums.length && !it.src.nums.some(function(n){ return invByN[n] && isExcl(invByN[n]); })) {
      add('V1', 'advertencia', [it.id], it.id + ' esta en Fuera del Alcance sin salir de una exclusion explicita del requerimiento.');
    }
  });
  pend.forEach(function(p){
    var inDentro = dentro.filter(function(it){ return it.src.nums.indexOf(p.n) >= 0 || (p.ref && mentionsRef(it, p.ref.toUpperCase())); });
    var ok = inDentro.some(function(it){ return CONDITIONED_RE.test(norm(it.text)) && (!p.ref || norm(it.text).indexOf(norm(p.ref)) >= 0); });
    if (ok) cobertura.pendientes.enDentroCondicionados++;
    else add('V1', 'error', inDentro.map(function(i){ return i.id; }), 'El pendiente ' + labelOf(p) +
      (inDentro.length ? ' esta en Dentro del Alcance sin "(condicionado a ' + (p.ref || '...') + ')".' : ' no aparece en Dentro del Alcance condicionado.'));
  });

  // V2: el mismo item condicionado en todos los apartados donde aparece, con TODAS sus Ref.
  bySec(CONDITIONED_SECTIONS).forEach(function(it){
    if (it.sec === 'ALCANCE_DENTRO' && !it.src.hasSrc) return;
    var p = pendingOf(it);
    if (!p.length) return;
    var t = norm(it.text);
    var missingRefs = p.filter(function(x){ return x.ref && t.indexOf(norm(x.ref)) < 0; }).map(labelOf);
    if (!CONDITIONED_RE.test(t)) add('V2', 'error', [it.id], it.id + ' depende de ' + p.map(labelOf).join(', ') + ' y no lo dice condicionado (en otros apartados si lo esta).');
    else if (missingRefs.length) add('V2', 'error', [it.id], it.id + ' esta condicionado pero no nombra ' + missingRefs.join(', ') + '.');
  });

  // V3: codigos citados que no existen en el inventario.
  items.forEach(function(it){
    var bad = it.codes.filter(function(c){ return refsAll.indexOf(c.toUpperCase()) < 0; });
    if (bad.length && inv.items.length) add('V3', 'error', [it.id], it.id + ' cita ' + bad.join(', ') + ', que no existe(n) en el requerimiento.');
  });

  // V4: trazabilidad de pendientes en supuestos/riesgos/criterios y de cada riesgo del analisis.
  var traceItems = bySec(TRACE_SECTIONS);
  pend.forEach(function(p){
    // Con codigo propio (DEP-XX) tiene que aparecer escrito; sin codigo basta la marca.
    var hit = traceItems.some(function(it){
      return p.ref ? norm(it.text).indexOf(norm(p.ref)) >= 0 : it.src.nums.indexOf(p.n) >= 0;
    });
    if (hit) cobertura.pendientes.trazados++;
    else add('V4', 'error', [], 'El pendiente ' + labelOf(p) + ' no aparece en Supuestos, Riesgos ni Criterios de entrada.');
  });
  // Pendientes que no son alcance (contexto o que solo viven en un riesgo): tampoco se pierden.
  pendOtros.forEach(function(p){
    var hit = traceItems.some(function(it){ return p.ref ? norm(it.text).indexOf(norm(p.ref)) >= 0 : it.src.nums.indexOf(p.n) >= 0; });
    if (!hit) add('V4', 'error', [], 'El pendiente ' + labelOf(p) + ' (' + p.tipo + ') no aparece en Supuestos, Riesgos ni Criterios de entrada.');
  });
  traceItems.forEach(function(it){
    var p = pendingOf(it);
    var missing = p.filter(function(x){ return x.ref && !mentionsRef(it, x.ref.toUpperCase()); });
    if (missing.length && p.some(function(x){ return it.src.nums.indexOf(x.n) >= 0; })) {
      add('V4', 'advertencia', [it.id], it.id + ' sale de ' + missing.map(labelOf).join(', ') + ' y no cita el codigo.');
    }
  });
  if (opts.analysis && /\[\s*src\s*:/i.test(opts.analysis)) {
    var riskSrc = [];
    bySec(RISK_SECTIONS).forEach(function(it){ riskSrc = riskSrc.concat(it.src.nums); });
    H.parseTracedAnalysis(opts.analysis).items.filter(function(i){ return i.prefix === 'R'; }).forEach(function(r){
      cobertura.riesgosAnalisis.total++;
      if (!r.src.length || r.src.some(function(n){ return riskSrc.indexOf(n) >= 0; })) cobertura.riesgosAnalisis.reflejados++;
      else {
        cobertura.riesgosAnalisis.sinReflejo.push(r.id);
        add('V4', 'error', [r.id], 'El riesgo ' + r.id + ' del analisis ("' + r.parts.slice(2, 3).join('') + '") no aparece en 4.1 ni 4.2.');
      }
    });
  }

  // V5: nombres propios del glosario conservados; genericos prohibidos.
  var planText = norm(items.map(function(i){ return i.text; }).join('\n'));
  var thirdTerms = glossary.filter(function(g){ return THIRD_GLOSSARY_TYPE_RE.test(norm(g.tipo)); });
  thirdTerms.forEach(function(g){
    var t = norm(g.termino);
    if (norm(analysisClean).indexOf(t) >= 0 && planText.indexOf(t) < 0) {
      add('V5', 'advertencia', [], 'El nombre propio "' + g.termino + '" esta en el analisis pero no en el plan.');
    }
  });
  if (thirdTerms.length) {
    items.forEach(function(it){
      var m = norm(it.text).replace(/proveedor de desarrollo/g, ' ').match(GENERIC_RE);
      if (m) add('V5', 'error', [it.id], it.id + ' usa el generico "' + m[1] + '" en vez del nombre propio del requerimiento (' +
        thirdTerms.map(function(x){ return x.termino; }).join(', ') + ').');
    });
  }

  // V6: cifras y fechas que no estan en la fuente.
  items.forEach(function(it){
    var t = it.text.replace(CODE_RE, ' ').replace(/^\s*\d+(\.\d+)*[.)]\s+/, '').replace(/\b100\s?%/g, ' ').replace(/\bN\s*[-+]\s*\d+\b/g, ' ');
    var nums = uniq(t.match(/\d+(?:[.,:\/]\d+)*/g) || []);
    var bad = nums.filter(function(n){ return sourceText.indexOf(norm(n)) < 0; });
    if (bad.length) add('V6', 'advertencia', [it.id], it.id + ' usa cifra(s) o fecha(s) que el requerimiento no define: ' + bad.join(', ') +
      '. Usar N, N-1 o X.');
  });

  // V7: convenciones + palabras mas fuertes que la fuente.
  items.forEach(function(it){
    var raw = it.text;
    if (/\b([Ee]l|[Aa]l|[Dd]el|[Uu]n|[Ll]os|[Pp]ara el|[Pp]or el|[Cc]on el) cliente\b/.test(raw)) add('V7', 'advertencia', [it.id], it.id + ': "cliente" en minuscula; cuando es un rol se escribe "Cliente".');
    if (/,\s*por ejemplo/i.test(raw)) add('V7', 'advertencia', [it.id], it.id + ': coma antes de "por ejemplo".');
    if (/\bpor ejemplo\b(?!,)/i.test(raw)) add('V7', 'advertencia', [it.id], it.id + ': "por ejemplo" sin coma despues ("por ejemplo,").');
    var names = raw.match(TEAM_NAME_RE) || [];
    if (names.some(function(n){ return n !== TEAM_NAME; })) add('V7', 'error', [it.id], it.id + ': el nombre del equipo se escribe "' + TEAM_NAME + '".');
    if (/[—]/.test(raw)) add('V7', 'advertencia', [it.id], it.id + ': usa raya larga (em dash).');
    if (/\([^()]*\(/.test(raw)) add('V7', 'advertencia', [it.id], it.id + ': parentesis anidados; reescribir como una frase simple.');
    var strong = uniq(norm(raw).match(STRONG_WORDS_RE) || []).filter(function(w){ return sourceText.indexOf(w) < 0; });
    if (strong.length) add('V7', 'advertencia', [it.id], it.id + ': "' + strong.join('", "') + '" no esta en el requerimiento (afirmacion mas fuerte que la fuente).');
  });

  // V8: Responsables sin relleno por defecto ni datos inventados.
  (opts.responsables || []).forEach(function(r, i){
    var id = 'Responsables #' + (i + 1);
    if (r.equipo && /\btest\s?i\s?a\s?lab\b/i.test(r.equipo) && r.equipo.trim() !== TEAM_NAME) add('V8', 'error', [id], id + ': el equipo se escribe "' + TEAM_NAME + '".');
    ['cargo', 'contacto'].forEach(function(k){
      var v = String(r[k] || '').trim();
      if (v && FILLER_RE.test(v)) add('V8', 'error', [id], id + ': "' + v + '" es un valor de relleno; si el QA no lo tiene, se deja en blanco.');
    });
  });

  // V9: toda marca apunta a un item o codigo del inventario; items de alcance/riesgo sin marca.
  if (inv.items.length) {
    items.forEach(function(it){
      var bad = it.src.nums.filter(function(n){ return !invByN[n]; }).map(String)
        .concat(it.src.refs.filter(function(r){ return refsAll.indexOf(r) < 0; })).concat(it.src.bad);
      if (bad.length) add('V9', 'error', [it.id], it.id + ': [src] apunta a ' + bad.join(', ') + ', que no existe en el inventario.');
      if (!it.src.hasSrc && SRC_REQUIRED_SECTIONS.indexOf(it.sec) >= 0) add('V9', 'advertencia', [it.id], it.id + ' no tiene marca de trazabilidad [src].');
    });
  }

  // V10: alcance que sale solo de items de contexto (objetivo, tareas, decisiones...): no es algo a probar.
  if (inv.items.length) {
    bySec(['ALCANCE_DENTRO', 'ALCANCE_FUERA']).forEach(function(it){
      var srcItems = it.src.nums.map(function(n){ return invByN[n]; }).filter(Boolean);
      if (srcItems.length && srcItems.every(H.isContext)) add('V10', 'advertencia', [it.id], it.id + ' sale solo de item(s) de contexto (' +
        uniq(srcItems.map(function(x){ return x.n + ' ' + x.tipo; })).join(', ') + '): no es una funcionalidad a probar. Va en Objetivo, Estrategia, Supuestos, Riesgos o Criterios de entrada.');
    });
  }

  return { hallazgos: hallazgos, cobertura: cobertura, items: items };
}

module.exports = {
  PLAN_SECTIONS: PLAN_SECTIONS,
  RESP_TEAMS: RESP_TEAMS,
  TEAM_NAME: TEAM_NAME,
  parsePlanTraced: parsePlanTraced,
  normalizeTitle: normalizeTitle,
  validatePlan: validatePlan,
  stripTraceMarks: H.stripTraceMarks,
  auditEstado: H.auditEstado,
};
