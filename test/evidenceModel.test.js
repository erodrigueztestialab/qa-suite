'use strict';
// Modelo paso-imagen de la evidencia (M5): una imagen respalda varios pasos y un paso tiene varias imagenes.
var test = require('node:test');
var assert = require('node:assert');
var M = require('../validators/evidenceModel.js');

var RAW = [
  { n: 1, pasos: [1, 2, 5], rol: 'prueba', leyenda: 'Pantalla inicial' },
  { n: 2, pasos: [4], rol: 'preparacion', leyenda: 'Paso previo' },
  { n: 3, pasos: [4], rol: 'preparacion', leyenda: 'Otro paso previo' },
  { n: 4, pasos: [4, 5], rol: 'prueba', leyenda: 'Resultado final' },
  { n: 5, pasos: [], rol: 'contexto', leyenda: 'Pantalla de apoyo' },
];

test('normalizeItems: limpia pasos fuera de rango, repetidos y roles invalidos', function() {
  var out = M.normalizeItems([
    { n: '2', pasos: [3, 3, 9, 'x', 1], rol: 'otro', leyenda: '  hola ' },
    { n: 2, pasos: [1] },                       // numero repetido: se ignora
    { n: 1, pasos: [], leyenda: 'sin paso' },
    { n: 0, pasos: [1] },                       // numero invalido
  ], 5);
  assert.deepStrictEqual(out.map(function(i) { return i.n; }), [1, 2]);
  assert.deepStrictEqual(out[1].pasos, [1, 3]);
  assert.strictEqual(out[1].rol, 'prueba');     // rol invalido con pasos -> prueba
  assert.strictEqual(out[1].leyenda, 'hola');
  assert.strictEqual(out[0].rol, 'contexto');   // sin pasos -> contexto
});

test('coverage: muchas imagenes por paso, una imagen en varios pasos, pasos sin captura de prueba', function() {
  var items = M.normalizeItems(RAW, 5);
  var c = M.coverage(items, 5);
  assert.deepStrictEqual(c.porPaso[4].preparacion, [2, 3]);
  assert.deepStrictEqual(c.porPaso[4].prueba, [4]);
  assert.deepStrictEqual(c.porPaso[5].prueba, [1, 4]);   // la imagen 1 respalda los pasos 1, 2 y 5
  assert.deepStrictEqual(c.sinCaptura, [3]);              // el paso 3 no tiene captura de prueba
  assert.deepStrictEqual(c.sinPaso, [5]);
});

test('groupByStep: agrupa consecutivas con los mismos pasos, como los bloques del Word', function() {
  var g = M.groupByStep(M.normalizeItems(RAW, 5));
  assert.deepStrictEqual(g.map(function(x) { return x.items.map(function(i) { return i.n; }); }), [[1], [2, 3], [4], [5]]);
  assert.deepStrictEqual(g[1].pasos, [4]);
});
