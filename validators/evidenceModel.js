'use strict';
// Modelo de datos paso-imagen de la evidencia de un caso (M5). Una imagen puede respaldar varios
// pasos y un paso puede tener varias imagenes (relacion de muchos a muchos). Cada imagen lleva:
//   n       numero de la imagen en el orden de la evidencia (1, 2, 3...)
//   pasos   numeros de los pasos del caso que respalda (1-based); [] si no encaja con ninguno
//   rol     'prueba' (muestra el resultado esperado), 'preparacion' (el camino para llegar) o 'contexto'
//   leyenda texto que describe lo que se ve
// Generico: no depende de ningun caso, cliente o documento.
var ROLES = ['prueba', 'preparacion', 'contexto'];

function toInt(x) { var v = parseInt(x, 10); return isNaN(v) ? null : v; }

// Limpia lo que llegue (de la IA o del QA): numeros enteros, pasos dentro de 1..numSteps sin repetir,
// rol valido (por defecto 'prueba' si hay pasos y 'contexto' si no), leyenda en texto.
function normalizeItems(items, numSteps) {
  var seen = {};
  return (Array.isArray(items) ? items : []).map(function(it) {
    var n = toInt(it && it.n);
    if (n === null || n < 1 || seen[n]) return null;
    seen[n] = true;
    var pasos = [];
    (Array.isArray(it.pasos) ? it.pasos : [it.pasos]).forEach(function(p) {
      var v = toInt(p);
      if (v !== null && v >= 1 && v <= numSteps && pasos.indexOf(v) < 0) pasos.push(v);
    });
    pasos.sort(function(a, b) { return a - b; });
    var rol = ROLES.indexOf(it.rol) >= 0 ? it.rol : (pasos.length ? 'prueba' : 'contexto');
    return { n: n, pasos: pasos, rol: rol, leyenda: String(it.leyenda || '').trim() };
  }).filter(Boolean).sort(function(a, b) { return a.n - b.n; });
}

// Cobertura: imagenes por paso (por rol), pasos sin ninguna captura de prueba, imagenes que no respaldan ningun paso.
function coverage(items, numSteps) {
  var porPaso = {}, i;
  for (i = 1; i <= numSteps; i++) porPaso[i] = { prueba: [], preparacion: [], contexto: [] };
  var sinPaso = [];
  items.forEach(function(it) {
    if (!it.pasos.length) sinPaso.push(it.n);
    it.pasos.forEach(function(p) { if (porPaso[p]) porPaso[p][it.rol].push(it.n); });
  });
  var sinCaptura = [];
  for (i = 1; i <= numSteps; i++) if (!porPaso[i].prueba.length) sinCaptura.push(i);
  return { porPaso: porPaso, sinCaptura: sinCaptura, sinPaso: sinPaso };
}

// Agrupa las imagenes consecutivas que comparten los mismos pasos (como los bloques "Pasos 1 y 2",
// "Paso 3" del Word de evidencias). Las que no respaldan ningun paso forman su propio grupo.
function groupByStep(items) {
  var groups = [];
  items.forEach(function(it) {
    var key = it.pasos.join(',');
    var last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(it);
    else groups.push({ key: key, pasos: it.pasos.slice(), items: [it] });
  });
  return groups;
}

module.exports = { ROLES: ROLES, normalizeItems: normalizeItems, coverage: coverage, groupByStep: groupByStep };
