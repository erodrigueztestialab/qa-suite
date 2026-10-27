'use strict';
// Validador deterministico (sin IA) del HU que genera M1.
//
// Recibe el analisis CON marcas de trazabilidad ([src: 1,3] y [cubre: CA_2]) y el
// inventario de la pasada 1 (N | Tipo | Estado | Ref | Condicion + ---GLOSARIO---),
// y devuelve hallazgos {codigo, severidad, ids, mensaje, origen}. Severidades:
//   error       -> defecto objetivo; se manda a reparacion.
//   advertencia -> probable defecto (heuristica); tambien se manda a reparacion.
//   juicio      -> no se puede decidir sin leer el sentido; lo decide el auditor IA.
// Generico a proposito: nada de dominio de un cliente. Pensado para reutilizarse en
// M3/M4 (parseInventory, stripTraceMarks y los helpers de texto no dependen del HU).

var SECTION_PREFIX = {
  CRITERIOS_DE_ACEPTACION: 'CA',
  REGLAS_DE_NEGOCIO: 'RN',
  RIESGOS: 'R',
  ESCENARIOS_QA: 'ESC',
};
var ID_RE = /\b(CA|RN|ESC|R)_(\d+)\b/g;
var SRC_RE = /\[\s*src\s*:\s*([^\]]*)\]/i;
var CUBRE_RE = /\[\s*cubre\s*:\s*([^\]]*)\]/i;
var TRACE_MARK_RE = /[ \t]*\[\s*(?:src|cubre)\s*:[^\]]*\]/gi;
var COND_RE = /condicionad[oa]\s+a\s+([^.;\[\n]+)/i;

var SOFT_MODAL_RE = /\b(puede|pueden|podria|podrian|deberia|deberian|opcional|opcionalmente|eventual|eventualmente|posible|posibles|posiblemente)\b/;
var HARD_MODAL_RE = /\b(debe|deben|se requiere|requiere|requieren|obligatori[oa]s?|siempre|se exige)\b/;
var PREMISE_RE = /(^|[\s,;:(])si\s+\S/;
var ITEM_PREMISE_RE = /(^|[\s,;:(])(si|cuando|en caso de|ante|siempre que|dado que)\s+\S/;
var EXCEPTION_RE = /\b(salvo|excepto|a menos que|con excepcion|aunque|sin perjuicio)\b/;
var ABSOLUTE_RE = /\b(solo|unicamente|siempre|nunca|jamas|ningun|ninguna)\b/;
var MAGNITUDE_RE = /\b(bajo|baja|alto|alta|critic[oa]|masiv[oa]|grave|sever[oa]|significativ[oa]|enorme|minim[oa]|considerable|total|en tiempo real|detenid[oa]|inmediat[oa])\b/g;
var IMPACT_MODAL_RE = /\b(puede|pueden|podria|podrian|posible|posibles|posiblemente|eventual|eventualmente|riesgo de)\b/;
var META_CITE_RES = [
  /\bsegun (el|la|lo) (documento|requerimiento|reunion|transcripcion|acta|correo|conversado|indicado|definido por)\b/,
  /\b(el|la) (documento|requerimiento|transcripcion|reunion) (indica|menciona|senala|establece|dice|define|plantea)\b/,
  /\ben la reunion\b/,
  /\bse acordo\b/,
  /\b(el|la) cliente (menciono|indico|pidio|solicito)\b/,
  /\blo conversado\b/,
  /\.(docx|pdf|txt|xlsx)\b/,
];
var GENERIC_THIRD_RE = /\b(un tercero|de un tercero|el tercero|proveedor externo|proveedor tercero|sistema externo|servicio externo|plataforma externa|herramienta externa)\b/;
var THIRD_GLOSSARY_TYPE_RE = /(proveedor|tercero|sistema|plataforma|servicio|herramienta|aplicacion|integracion)/;

// ── texto ────────────────────────────────────────────────────────────────────
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function uniq(arr) { return arr.filter(function(v, i){ return arr.indexOf(v) === i; }); }

function stripTraceMarks(raw) {
  return String(raw || '').replace(TRACE_MARK_RE, '');
}

// Igual a parseSection del front, pero solo corta en un delimitador real de seccion
// (una linea ---TAG---), no en cualquier "---" dentro del texto.
function parseSection(raw, tag) {
  var re = new RegExp('---' + tag + '---([\\s\\S]*?)(?=\\n\\s*---[A-Z_]+---|$)', 'i');
  var m = String(raw || '').match(re);
  return m ? m[1].trim() : '';
}

// ── inventario ───────────────────────────────────────────────────────────────
// Lineas "N | Tipo | Estado | Ref | Condicion" (Ref puede ir vacia). Acepta tambien
// el formato viejo "N | Tipo | Condicion" (se asume DEFINIDO). El glosario va despues
// de ---GLOSARIO--- como "Termino | Tipo".
// Estado CONTRADICCION (el requerimiento dice dos cosas incompatibles sobre el mismo
// punto) se trata como PENDIENTE en todo el flujo (M1, M3 y M4 lo condicionan igual) y
// queda marcado con contradiccion: true para nombrarlo como tal.
function parseInventory(text) {
  text = String(text || '');
  var glosIdx = text.search(/---\s*GLOSARIO\s*---/i);
  var invPart = glosIdx >= 0 ? text.slice(0, glosIdx) : text;
  var glosPart = glosIdx >= 0 ? text.slice(glosIdx).replace(/---\s*GLOSARIO\s*---/i, '') : '';
  invPart = invPart.replace(/---\s*INVENTARIO\s*---/i, '');

  var items = [];
  invPart.split(/\r?\n/).forEach(function(line){
    var l = line.trim().replace(/^[-*]\s*/, '');
    if (!l || l.indexOf('|') < 0) return;
    var p = l.split('|').map(function(s){ return s.trim(); });
    var nm = /^[A-Za-z]*\s*(\d+)$/.exec(p[0]);
    if (!nm) return; // encabezado u otra cosa
    var it = { n: parseInt(nm[1], 10), tipo: p[1] || '', estado: 'DEFINIDO', ref: '', condicion: '', contradiccion: false };
    if (p.length >= 5) {
      it.estado = /pendiente|contradic/i.test(p[2]) ? 'PENDIENTE' : 'DEFINIDO';
      it.contradiccion = /contradic/i.test(p[2]);
      it.ref = p[3] === '-' ? '' : p[3];
      it.condicion = p.slice(4).join(' | ');
    } else if (p.length === 4 && /^(definido|pendiente|contradiccion|contradicción)$/i.test(p[2])) {
      it.estado = /pendiente|contradic/i.test(p[2]) ? 'PENDIENTE' : 'DEFINIDO';
      it.contradiccion = /contradic/i.test(p[2]);
      it.condicion = p[3];
    } else {
      it.condicion = p.slice(2).join(' | ');
    }
    items.push(it);
  });

  var glossary = [];
  glosPart.split(/\r?\n/).forEach(function(line){
    var l = line.trim().replace(/^[-*]\s*/, '');
    if (!l) return;
    var p = l.split('|').map(function(s){ return s.trim(); });
    if (!p[0] || /^t[eé]rmino$/i.test(p[0])) return;
    glossary.push({ termino: p[0], tipo: p[1] || '' });
  });
  return { items: items, glossary: glossary };
}

function isExclusion(it) { return /exclu/i.test(it.tipo); }
// Items que NO son comportamiento del sistema: objetivo o beneficio, contexto
// (antecedentes, situacion actual, ambiente o despliegue), tareas o compromisos del
// proyecto, decisiones tecnicas del equipo de desarrollo e indicaciones sobre como
// probar. No generan CA, RN ni ESC; si estan pendientes, van en un riesgo.
var CONTEXT_TIPO_RE = /^(objetivo|contexto|tarea|decision|indicacion)/;
function isContext(it) { return !!it && CONTEXT_TIPO_RE.test(norm(it.tipo).trim()); }
function pendingLabel(p) { return p.ref || (p.contradiccion ? 'la contradiccion del item ' + p.n : 'item ' + p.n); }

// RN que repite un CA: la mayoria de las palabras de contenido de la RN (raiz de 5
// letras, sin "Condicionado a ...") estan en el CA. Calibrado con un HU real: las RN
// que repetian un CA daban 0.85-1.0; las reglas propias, 0.75 o menos.
var DUP_STOP_RE = /^(dado|cuando|entonces|sistema|usuario|que|con|para|por|una|uno|del|desde|este|esta|como|minimo|sobre|segun|aplique)$/;
function contentStems(text) {
  return uniq((norm(text).replace(/condicionad[oa] a[^.]*/g, ' ').match(/[a-z]{4,}/g) || [])
    .filter(function(w){ return !DUP_STOP_RE.test(w); }).map(function(w){ return w.slice(0, 5); }));
}
function repeatsText(small, big) {
  var w = contentStems(small);
  if (w.length < 2) return 0;
  var bw = contentStems(big);
  var hit = w.filter(function(x){ return bw.indexOf(x) >= 0; }).length / w.length;
  return (hit >= 0.85 && w.length >= 3) || hit === 1 ? hit : 0;
}

// Criticidad declarada por el documento dentro de la condicion del inventario.
function inventoryCriticality(it) {
  var m = /\b(criticidad|severidad|prioridad)\s*[:=]?\s*(alta|alto|media|medio|baja|bajo|critica|critico)\b/.exec(norm(it.condicion));
  if (!m) return null;
  var v = m[2];
  if (/^(alt|crit)/.test(v)) return 'ALTO';
  if (/^medi/.test(v)) return 'MEDIO';
  return 'BAJO';
}
var LEVEL_RANK = { BAJO: 1, MEDIO: 2, ALTO: 3 };

// ── analisis con trazas ──────────────────────────────────────────────────────
function parseTracedAnalysis(raw) {
  var items = [];
  Object.keys(SECTION_PREFIX).forEach(function(tag){
    var prefix = SECTION_PREFIX[tag];
    parseSection(raw, tag).split(/\r?\n/).forEach(function(line){
      var l = line.trim();
      if (!l || l.indexOf('|') < 0) return;
      var srcM = SRC_RE.exec(l), cubreM = CUBRE_RE.exec(l);
      var clean = stripTraceMarks(l).trim();
      var parts = clean.split('|').map(function(s){ return s.trim(); });
      var idM = new RegExp('^' + prefix + '_(\\d+)$', 'i').exec(parts[0]);
      if (!idM) return;
      var text = parts.slice(1).join(' | ');
      var condM = COND_RE.exec(text);
      items.push({
        id: prefix + '_' + idM[1],
        num: parseInt(idM[1], 10),
        prefix: prefix,
        sec: tag,
        parts: parts,
        text: text,
        src: srcM ? uniq((srcM[1].match(/\d+/g) || []).map(Number)) : [],
        hasSrc: !!srcM,
        cubre: cubreM ? uniq((cubreM[1].match(/\b(CA|RN|ESC|R)_\d+\b/gi) || []).map(function(s){ return s.toUpperCase(); })) : [],
        condicion: condM ? condM[1].trim() : '',
      });
    });
  });
  var impactos = parseSection(raw, 'IMPACTOS').split(/\r?\n/).map(function(l){ return stripTraceMarks(l).trim(); })
    .filter(function(l){ return l && l.indexOf('|') >= 0; })
    .map(function(l){ var p = l.split('|').map(function(s){ return s.trim(); }); return { area: p[0], text: p.slice(1).join(' | ') }; });
  return {
    items: items,
    justificacion: stripTraceMarks(parseSection(raw, 'JUSTIFICACION_RIESGO')),
    hu: stripTraceMarks(parseSection(raw, 'HISTORIA_DE_USUARIO')),
    impactos: impactos,
  };
}

// ── validacion ───────────────────────────────────────────────────────────────
function validateHU(opts) {
  opts = opts || {};
  var conTrazas = opts.conTrazas !== false;
  var inv = parseInventory(opts.inventory || '');
  var glossary = opts.glossary ? (Array.isArray(opts.glossary) ? opts.glossary : parseInventory('---GLOSARIO---\n' + opts.glossary).glossary) : inv.glossary;
  var A = parseTracedAnalysis(opts.traced || '');
  var hallazgos = [];
  function add(codigo, severidad, ids, mensaje) {
    hallazgos.push({ codigo: codigo, severidad: severidad, ids: ids || [], mensaje: mensaje, origen: 'validador' });
  }
  var byId = {};
  A.items.forEach(function(it){ if (!byId[it.id]) byId[it.id] = it; });
  var invByN = {};
  inv.items.forEach(function(it){ invByN[it.n] = it; });
  var invText = norm(inv.items.map(function(it){ return it.condicion + ' ' + it.ref; }).join('\n') + '\n' +
    glossary.map(function(g){ return g.termino; }).join('\n'));
  var allHuText = norm([A.hu, A.justificacion].concat(A.items.map(function(i){ return i.text; }), A.impactos.map(function(i){ return i.area + ' ' + i.text; })).join('\n'));

  // V1: IDs continuos y sin duplicados por seccion
  ['CA', 'RN', 'R', 'ESC'].forEach(function(prefix){
    var nums = A.items.filter(function(i){ return i.prefix === prefix; }).map(function(i){ return i.num; });
    var seen = {}, dups = [];
    nums.forEach(function(n){ if (seen[n]) dups.push(prefix + '_' + n); seen[n] = true; });
    if (dups.length) add('V1', 'error', uniq(dups), 'IDs duplicados en ' + prefix + '_: ' + uniq(dups).join(', ') + '.');
    var max = nums.length ? Math.max.apply(null, nums) : 0, gaps = [];
    for (var k = 1; k <= max; k++) if (!seen[k]) gaps.push(prefix + '_' + k);
    if (gaps.length) add('V1', 'error', gaps, 'Numeracion de ' + prefix + '_ no es continua: falta(n) ' + gaps.join(', ') + '.');
  });

  // V2: referencias internas a IDs inexistentes (en el texto y en [cubre]); [src] a
  // numeros que no existen en el inventario.
  A.items.forEach(function(it){
    var refs = (it.text.match(ID_RE) || []).concat(it.cubre).map(function(s){ return s.toUpperCase(); });
    var missing = uniq(refs.filter(function(r){ return !byId[r]; }));
    if (missing.length) add('V2', 'error', [it.id], it.id + ' referencia ' + missing.join(', ') + ', que no existe.');
    if (conTrazas && inv.items.length) {
      var badSrc = it.src.filter(function(n){ return !invByN[n]; });
      if (badSrc.length) add('V2', 'error', [it.id], it.id + ' cita el/los item(s) ' + badSrc.join(', ') + ' del inventario, que no existe(n).');
    }
  });

  // Cobertura (V3) -- se calcula siempre para el resumen, pero solo genera hallazgos con trazas.
  var cas = A.items.filter(function(i){ return i.prefix === 'CA'; });
  var escs = A.items.filter(function(i){ return i.prefix === 'ESC'; });
  var rs = A.items.filter(function(i){ return i.prefix === 'R'; });
  var pendientes = inv.items.filter(function(it){ return it.estado === 'PENDIENTE'; });
  var exclusiones = inv.items.filter(isExclusion);
  var contexto = inv.items.filter(isContext);
  function itemsCiting(n) { return A.items.filter(function(i){ return i.src.indexOf(n) >= 0; }); }
  var cobertura = {
    conTrazas: conTrazas,
    inventario: { total: inv.items.length, cubiertos: 0, exentos: exclusiones.map(function(e){ return e.n; }),
                  contexto: contexto.map(function(e){ return e.n; }), faltantes: [] },
    criterios: { total: cas.length, conEscenario: 0, sinEscenario: [] },
    pendientes: { total: pendientes.length, sinRiesgo: [], sinEscCondicionado: [] },
    contradicciones: inv.items.filter(function(it){ return it.contradiccion; }).map(function(it){ return { n: it.n, condicion: it.condicion }; }),
    glosario: glossary.length,
  };
  if (conTrazas) {
    inv.items.forEach(function(it){
      var citing = itemsCiting(it.n);
      // El contexto no necesita CA/RN/ESC: se cuenta como cubierto (va en la HU, la
      // justificacion o, si esta pendiente, en un riesgo -- eso lo exige la regla de pendientes).
      if (citing.length || isContext(it)) cobertura.inventario.cubiertos++;
      else cobertura.inventario.faltantes.push(it.n);
      if (isExclusion(it) && citing.some(function(i){ return i.prefix === 'ESC'; })) {
        add('V3', 'advertencia', citing.filter(function(i){ return i.prefix === 'ESC'; }).map(function(i){ return i.id; }),
          'El item ' + it.n + ' es una exclusion de alcance (exento de escenarios) y aun asi tiene escenario.');
      }
    });
    if (cobertura.inventario.faltantes.length) {
      add('V3', 'error', [], 'Item(s) del inventario sin reflejo en ningun CA, RN, R o ESC: ' + cobertura.inventario.faltantes.join(', ') + '.');
    }
    cas.forEach(function(ca){
      var covered = escs.some(function(e){ return e.cubre.indexOf(ca.id) >= 0; });
      if (covered) cobertura.criterios.conEscenario++;
      else cobertura.criterios.sinEscenario.push(ca.id);
    });
    if (cobertura.criterios.sinEscenario.length) {
      add('V3', 'error', cobertura.criterios.sinEscenario, 'Criterio(s) sin escenario que los cubra: ' + cobertura.criterios.sinEscenario.join(', ') + '.');
    }
    pendientes.forEach(function(p){
      var label = pendingLabel(p);
      if (!rs.some(function(r){ return r.src.indexOf(p.n) >= 0; })) {
        cobertura.pendientes.sinRiesgo.push(p.n);
        add('V3', 'error', [], 'El pendiente ' + label + ' no aparece en ningun riesgo (R_N).');
      }
      var condEsc = escs.some(function(e){
        if (!e.condicion) return false;
        if (e.src.indexOf(p.n) >= 0) return true;
        return e.cubre.some(function(id){ return byId[id] && byId[id].src.indexOf(p.n) >= 0; });
      });
      // Solo se exige si el pendiente gobierna comportamiento (lo cita un CA o una RN). Un
      // pendiente que solo vive en un riesgo (accesos, ubicar codigo, una definicion del
      // proyecto) no tiene nada observable que probar: pedirle escenario fabricaba casos.
      var afectaComportamiento = A.items.some(function(i){ return (i.prefix === 'CA' || i.prefix === 'RN') && i.src.indexOf(p.n) >= 0; });
      if (!condEsc && afectaComportamiento && !isExclusion(p) && !isContext(p)) {
        cobertura.pendientes.sinEscCondicionado.push(p.n);
        add('V3', 'advertencia', [], 'El pendiente ' + label + ' no tiene ningun escenario condicionado (si afecta comportamiento observable, debe tenerlo).');
      }
    });
    var sinSrc = A.items.filter(function(i){ return !i.hasSrc; }).map(function(i){ return i.id; });
    if (sinSrc.length) add('V3', 'advertencia', sinSrc, 'Item(s) sin marca de trazabilidad [src]: ' + sinSrc.join(', ') + '.');

    // V4: derivado de un PENDIENTE sin "Condicionado a"
    A.items.forEach(function(it){
      if (it.prefix === 'R') return;
      var pend = it.src.map(function(n){ return invByN[n]; }).filter(function(x){ return x && x.estado === 'PENDIENTE'; });
      if (!pend.length) return;
      if (!it.condicion) {
        add('V4', 'error', [it.id], it.id + ' deriva de un pendiente (' + pend.map(pendingLabel).join(', ') +
          ') y no dice "Condicionado a".');
      } else {
        var missingRef = pend.filter(function(p){ return p.ref && norm(it.condicion).indexOf(norm(p.ref)) < 0; });
        if (missingRef.length) add('V4', 'advertencia', [it.id], it.id + ' esta condicionado pero no cita la referencia del pendiente (' +
          missingRef.map(function(p){ return p.ref; }).join(', ') + ').');
      }
    });

    // V4b: la condicion de un CA/RN se hereda al ESC que lo cubre
    escs.forEach(function(e){
      var conds = e.cubre.map(function(id){ return byId[id]; }).filter(function(x){ return x && x.condicion; });
      conds.forEach(function(c){
        if (!e.condicion) {
          add('V4b', 'error', [e.id, c.id], e.id + ' cubre ' + c.id + ' (condicionado a ' + c.condicion + ') y no lleva la misma condicion.');
        } else if (norm(e.condicion).indexOf(norm(c.condicion)) < 0 && norm(c.condicion).indexOf(norm(e.condicion)) < 0) {
          add('V4b', 'advertencia', [e.id, c.id], e.id + ' esta condicionado a "' + e.condicion + '" pero cubre ' + c.id + ', condicionado a "' + c.condicion + '".');
        }
      });
      if (e.condicion && e.cubre.length && !conds.length) {
        var fromPend = e.src.some(function(n){ return invByN[n] && invByN[n].estado === 'PENDIENTE'; });
        if (!fromPend) add('V4b', 'advertencia', [e.id], e.id + ' esta condicionado pero solo cubre items no condicionados.');
      }
    });

    // V6: nivel del riesgo vs criticidad del elemento fuente
    rs.forEach(function(r){
      var lvl = norm(r.parts[1] || '').trim().toUpperCase();
      if (!LEVEL_RANK[lvl]) return;
      var crits = r.src.map(function(n){ return invByN[n] && inventoryCriticality(invByN[n]); }).filter(Boolean);
      if (!crits.length) return;
      var expected = crits.sort(function(a, b){ return LEVEL_RANK[b] - LEVEL_RANK[a]; })[0];
      if (expected !== lvl) add('V6', 'error', [r.id], r.id + ' tiene nivel ' + lvl + ' pero el elemento fuente tiene criticidad ' + expected + '.');
    });

    // V8: endurecimiento de modales y premisas perdidas
    A.items.forEach(function(it){
      var t = norm(it.text);
      it.src.forEach(function(n){
        var s = invByN[n];
        if (!s) return;
        var c = norm(s.condicion);
        if (SOFT_MODAL_RE.test(c) && !SOFT_MODAL_RE.test(t) && HARD_MODAL_RE.test(t) && !it.condicion) {
          add('V8', 'advertencia', [it.id], it.id + ' endurece el modal: la fuente (item ' + n + ') dice "' + (c.match(SOFT_MODAL_RE) || [])[0] +
            '" y el item lo afirma como obligatorio.');
        }
        if (it.prefix !== 'ESC' && PREMISE_RE.test(c) && !ITEM_PREMISE_RE.test(t) && !it.condicion) {
          add('V8', 'advertencia', [it.id], it.id + ' pierde la premisa condicional de la fuente (item ' + n + ': "si ...") y lo escribe como hecho.');
        }
      });
    });
  }

  // V14: CA, RN o ESC que salen SOLO de items de contexto (objetivo, antecedentes,
  // situacion actual, tareas del proyecto, decisiones tecnicas, indicaciones de prueba):
  // no son comportamiento del sistema y en M4 terminan como casos que no se pueden probar.
  if (conTrazas && inv.items.length) {
    A.items.forEach(function(it){
      if (it.prefix === 'R' || !it.src.length) return;
      var srcItems = it.src.map(function(n){ return invByN[n]; }).filter(Boolean);
      if (srcItems.length && srcItems.every(isContext)) {
        add('V14', 'error', [it.id], it.id + ' sale solo de item(s) de contexto del requerimiento (' +
          uniq(srcItems.map(function(x){ return x.n + ' ' + x.tipo; })).join(', ') + '), que no son comportamiento del sistema: no va como ' +
          it.prefix + '. Si esta pendiente, va en un riesgo (R_N); si no, se elimina.');
      }
    });
  }

  // V15: RN que repite un CA (la regla no agrega nada que el criterio no diga). Infla el
  // HU y, en M4, la cuenta de cosas por cubrir. Las RN de alcance (exclusiones) no cuentan.
  A.items.filter(function(i){ return i.prefix === 'RN'; }).forEach(function(rn){
    if (rn.src.some(function(n){ return invByN[n] && isExclusion(invByN[n]); })) return;
    var best = null;
    cas.forEach(function(ca){
      var h = repeatsText(rn.text, ca.text);
      if (h && (!best || h > best.h)) best = { id: ca.id, h: h };
    });
    if (best) add('V15', 'advertencia', [rn.id, best.id], rn.id + ' repite lo que ya dice ' + best.id +
      ': una RN es una regla o restriccion que el CA no dice. Eliminarla (el item queda cubierto por ' + best.id +
      ') o dejar en ella solo lo que el CA no dice.');
  });

  // V16: RN que solo dice que algo no esta definido o falta definirlo: eso es un riesgo.
  A.items.filter(function(i){ return i.prefix === 'RN'; }).forEach(function(rn){
    var t = norm(rn.text.replace(COND_RE, ''));
    if (/\b(no (esta|estan) definid[oa]s?|esta(n)? por definir|sin definir|no se ha definido|falta definir|no (esta|estan) defin)/.test(t)) {
      add('V16', 'advertencia', [rn.id], rn.id + ' solo dice que algo no esta definido: eso es un riesgo (R_N), no una regla. Moverlo a RIESGOS y condicionar los CA/RN/ESC que dependan de esa definicion.');
    }
  });

  // V5: cifras en escenarios que no estan literalmente en el inventario
  escs.forEach(function(e){
    var t = e.parts.slice(2).join(' ');
    // Los codigos del documento (DEP-01) no son cifras de prueba. Una Ref solo numerica
    // (numeracion de una lista) NO se quita como texto: partiria "500" en "00".
    inv.items.forEach(function(it){ if (it.ref && /[A-Za-z]/.test(it.ref)) t = t.split(it.ref).join(' '); });
    t = t.replace(ID_RE, ' ').replace(/\b[A-Za-z]+[-_]\d+\b/g, ' ');
    var nums = uniq(t.match(/\d+(?:[.,]\d+)?/g) || []);
    var unsupported = nums.filter(function(num){ return !new RegExp('(^|[^\\d])' + num.replace(/[.,]/g, '[.,]') + '($|[^\\d])').test(invText); });
    if (unsupported.length) add('V5', 'advertencia', [e.id], e.id + ' usa cifra(s) fija(s) que el requerimiento no define: ' + unsupported.join(', ') +
      '. Usar marcadores (N, N-1, X, valor dentro/fuera del limite).');
  });

  // V7: absolutos en CA/RN (para el auditor)
  A.items.filter(function(i){ return i.prefix === 'CA' || i.prefix === 'RN'; }).forEach(function(it){
    var t = norm(it.text), m = t.match(ABSOLUTE_RE);
    if (m && !EXCEPTION_RE.test(t)) add('V7', 'juicio', [it.id], it.id + ' usa el absoluto "' + m[1] + '": verificar que ninguna otra regla lo exceptue.');
  });

  // V9: calificativos de magnitud sin respaldo (justificacion y riesgos, sin la columna de nivel)
  function magnitudeCheck(id, text) {
    var words = uniq((norm(text).match(MAGNITUDE_RE) || []));
    var unsupported = words.filter(function(w){ return invText.indexOf(w) < 0; });
    if (unsupported.length) add('V9', 'juicio', [id], id + ' usa calificativo(s) de magnitud sin respaldo aparente en el requerimiento: ' + unsupported.join(', ') + '.');
  }
  magnitudeCheck('JUSTIFICACION_RIESGO', A.justificacion.replace(/\b(riesgo|nivel)\s+(global\s+)?(es\s+)?(alto|medio|bajo)\b/gi, ''));
  rs.forEach(function(r){ magnitudeCheck(r.id, r.parts.slice(2).join(' ')); });

  // V10: meta-citas a la fuente
  var citable = [{ id: 'JUSTIFICACION_RIESGO', text: A.justificacion }, { id: 'HISTORIA_DE_USUARIO', text: A.hu }]
    .concat(A.items.map(function(i){ return { id: i.id, text: i.text }; }))
    .concat(A.impactos.map(function(i){ return { id: 'IMPACTOS:' + i.area, text: i.text }; }));
  citable.forEach(function(c){
    var t = norm(c.text);
    if (META_CITE_RES.some(function(re){ return re.test(t); })) add('V10', 'error', [c.id], c.id + ' cita o atribuye la fuente (meta-cita). Redactar como hecho; los codigos propios del documento si se permiten.');
  });

  // V11: impactos sin modal y sin sustento en el inventario (para el auditor)
  function supported(text) {
    var words = uniq(norm(text).match(/[a-z]{5,}/g) || []);
    if (!words.length) return true;
    var hit = words.filter(function(w){ return invText.indexOf(w) >= 0; }).length;
    return hit / words.length >= 0.6;
  }
  rs.forEach(function(r){
    var impacto = r.parts.slice(3).join(' ');
    if (impacto && !IMPACT_MODAL_RE.test(norm(impacto)) && !supported(impacto)) {
      add('V11', 'juicio', [r.id], r.id + ': el impacto "' + impacto + '" se afirma como hecho sin modal ni respaldo literal.');
    }
  });
  A.impactos.forEach(function(im){
    if (im.text && !IMPACT_MODAL_RE.test(norm(im.text)) && !supported(im.text)) {
      add('V11', 'juicio', ['IMPACTOS:' + im.area], 'Impacto "' + im.area + '" se afirma como hecho sin modal ni respaldo literal.');
    }
  });

  // V12: escenarios con alternativas combinadas
  escs.forEach(function(e){
    var t = ' ' + norm(e.parts.slice(2).join(' ')).replace(/\by\/o\b/g, ' ')
      .replace(/\b(mayor|menor|igual|antes|despues) o (igual|menor|mayor)\b/g, ' ') + ' ';
    if (/\s(o|u)\s/.test(t)) add('V12', 'juicio', [e.id], e.id + ' combina alternativas con "o": cada alternativa de prueba debe ser su propio escenario.');
  });

  // V13: convenciones del equipo
  citable.forEach(function(c){
    var raw = String(c.text || '');
    if (/\bejemplo\b(?!,)/i.test(raw)) add('V13', 'advertencia', [c.id], c.id + ': "ejemplo" sin coma ("Por ejemplo,").');
    if (/\b([Ee]l|[Aa]l|[Dd]el|[Uu]n|[Ll]os|[Pp]ara el) cliente\b/.test(raw)) add('V13', 'advertencia', [c.id], c.id + ': "cliente" en minuscula; cuando es un rol se escribe "Cliente".');
    if (/[—]/.test(raw)) add('V13', 'advertencia', [c.id], c.id + ': usa raya larga (em dash); no se usan en los entregables.');
    // Etiquetas internas del inventario (Estado en mayusculas, 'Version 1:') no van al entregable.
    var tag = raw.match(/\b(PENDIENTE|DEFINIDO|CONTRADICCI[OÓ]N)\b|\bVersi[oó]n [12]\s*:/);
    if (tag) add('V13', 'advertencia', [c.id], c.id + ': usa la etiqueta interna del inventario "' + tag[0] + '"; redactar en lenguaje natural (por ejemplo, "esta por definir").');
  });
  var thirdTerms = glossary.filter(function(g){ return THIRD_GLOSSARY_TYPE_RE.test(norm(g.tipo)); });
  if (thirdTerms.length) {
    citable.forEach(function(c){
      var t = norm(c.text);
      var g = t.match(GENERIC_THIRD_RE);
      if (!g) return;
      var mentioned = thirdTerms.some(function(term){ return t.indexOf(norm(term.termino)) >= 0; });
      if (!mentioned) add('V13', 'advertencia', [c.id], c.id + ': usa el generico "' + g[1] + '" en vez del nombre propio del documento (' +
        thirdTerms.map(function(x){ return x.termino; }).join(', ') + ').');
    });
    thirdTerms.forEach(function(term){
      if (allHuText.indexOf(norm(term.termino)) < 0) add('V13', 'advertencia', [], 'El nombre propio "' + term.termino + '" del glosario no aparece en el HU.');
    });
  }

  return { hallazgos: hallazgos, cobertura: cobertura, inventario: inv.items, glosario: glossary };
}

// Estado global de la auditoria a partir de los hallazgos que quedaron.
function auditEstado(hallazgos) {
  return (hallazgos || []).some(function(h){ return h.severidad !== 'info'; }) ? 'CON_ADVERTENCIAS' : 'OK';
}

module.exports = {
  parseInventory: parseInventory,
  isExclusion: isExclusion,
  isContext: isContext,
  repeatsText: repeatsText,
  parseTracedAnalysis: parseTracedAnalysis,
  parseSection: parseSection,
  stripTraceMarks: stripTraceMarks,
  validateHU: validateHU,
  auditEstado: auditEstado,
  norm: norm,
};
