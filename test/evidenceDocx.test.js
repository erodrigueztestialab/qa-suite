'use strict';
// Tests de "Verificar con IA" sobre un Word con capturas (M5): extractDocx debe devolver las
// imagenes en orden con marcadores [IMAGEN N], y el prompt debe referenciarlas y pedir contrastar
// leyenda con captura. Correr con: npm test
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var docx = require('docx');
var proxy = require('../proxy.js');

// PNG solido de 4x4 de un color; se generan 3 distintos para comprobar que el orden de
// las rutas devueltas coincide con el orden del documento (no solo la cantidad).
function solidPng(r, g, b) {
  function chunk(type, data) {
    var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    var td = Buffer.concat([Buffer.from(type), data]);
    var crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  }
  var ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  var row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(4).fill([r, g, b]).flat())]);
  var raw = Buffer.concat(Array(4).fill(row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
var COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
var LEYENDAS = ['Paso 1: se muestra el formulario de login', 'Paso 2: el check queda marcado', 'Paso 3: mensaje Exitoso'];

async function buildDocx(file) {
  var children = [];
  LEYENDAS.forEach(function(txt, i) {
    children.push(new docx.Paragraph({ children: [new docx.TextRun(txt)] }));
    children.push(new docx.Paragraph({ children: [new docx.ImageRun({
      type: 'png', data: solidPng.apply(null, COLORS[i]), transformation: { width: 40, height: 40 },
    })] }));
  });
  var doc = new docx.Document({ sections: [{ children: children }] });
  fs.writeFileSync(file, await docx.Packer.toBuffer(doc));
}

test('extractDocx con imageMarkers devuelve las imagenes en orden y los marcadores [IMAGEN 1..3]', async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtest-'));
  try {
    var f = path.join(dir, 'caso.docx');
    await buildDocx(f);
    var r = await proxy.extractDocx(f, { imageMarkers: true, imgDir: dir });
    assert.strictEqual(r.imagePaths.length, 3);
    // mismo orden que el documento: el color de cada PNG extraido coincide con el insertado
    r.imagePaths.forEach(function(p, i) {
      var png = fs.readFileSync(p);
      assert.ok(png.equals(solidPng.apply(null, COLORS[i])), 'la imagen ' + (i + 1) + ' no es la del documento');
    });
    var pos = [1, 2, 3].map(function(n) { return r.text.indexOf('[IMAGEN ' + n + ']'); });
    assert.ok(pos.every(function(p) { return p >= 0; }), 'faltan marcadores en: ' + r.text);
    assert.ok(pos[0] < pos[1] && pos[1] < pos[2]);
    // cada marcador aparece despues de su leyenda y antes de la siguiente
    LEYENDAS.forEach(function(l, i) {
      var li = r.text.indexOf(l);
      assert.ok(li >= 0 && li < pos[i], 'la leyenda ' + (i + 1) + ' debe preceder a [IMAGEN ' + (i + 1) + ']');
      if (i < 2) assert.ok(pos[i] < r.text.indexOf(LEYENDAS[i + 1]));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractDocx con markerOffset numera a partir del offset (varios Word en un caso)', async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtest-'));
  try {
    var f = path.join(dir, 'caso.docx');
    await buildDocx(f);
    var r = await proxy.extractDocx(f, { imageMarkers: true, markerOffset: 3, imgDir: dir });
    assert.ok(r.text.indexOf('[IMAGEN 4]') >= 0 && r.text.indexOf('[IMAGEN 6]') >= 0);
    assert.strictEqual(r.text.indexOf('[IMAGEN 1]'), -1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractDocx sin opciones NO agrega marcadores (comportamiento de M1/M3/M4)', async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtest-'));
  try {
    var f = path.join(dir, 'caso.docx');
    await buildDocx(f);
    var r = await proxy.extractDocx(f);
    try {
      assert.strictEqual(r.imagePaths.length, 3);
      assert.ok(r.text.indexOf('[IMAGEN') === -1);
      assert.ok(r.text.indexOf(LEYENDAS[0]) >= 0);
    } finally { if (r.imgDir) fs.rmSync(r.imgDir, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

var CASE = { objetivo: 'Login exitoso', steps: [{ paso: 'Abrir login', resultado: 'Se ve el formulario' }, { paso: 'Marcar check', resultado: 'Check marcado' }] };

test('el prompt con 3 imagenes de Word lista las 3 rutas numeradas y pide contrastar leyenda con captura', function() {
  var images = [1, 2, 3].map(function(n) { return { n: n, path: 'C:\\tmp\\evidence-x\\img_00' + n + '.png' }; });
  var p = proxy.buildEvidenceVerdictPrompt(CASE, [], 'claude', [{ filename: 'caso.docx', text: 'Paso 1 [IMAGEN 1]\nPaso 2 [IMAGEN 2]\nPaso 3 [IMAGEN 3]', images: images }]);
  images.forEach(function(im) { assert.ok(p.indexOf('IMAGEN ' + im.n + ': ' + im.path) >= 0, 'falta la ruta de la imagen ' + im.n); });
  assert.ok(/herramienta de lectura de archivos, en paralelo/.test(p));
  assert.ok(/Contrasta la leyenda de cada paso con la captura/.test(p));
  assert.ok(/NO se puede ver lo que la leyenda afirma/.test(p));
  assert.ok(/numero de IMAGEN y el dato visible/.test(p));
  assert.ok(/Leyendas sin respaldo visual/.test(p));
  // sigue el formato binario y de secciones
  ['---EVIDENCIA_VALIDA---', '---VEREDICTO---', '---PASOS_VERDICTO---', '---OBSERVACIONES---'].forEach(function(t) { assert.ok(p.indexOf(t) >= 0, t); });
  assert.ok(/BINARIO: PASS solo si TODOS/.test(p));
});

test('el prompt sin imagenes de Word no cambia: sin bloque de IMAGEN ni instrucciones de contraste', function() {
  var p = proxy.buildEvidenceVerdictPrompt(CASE, ['C:\\tmp\\a.png'], 'claude', [{ filename: 'n.txt', text: 'nota' }]);
  assert.ok(p.indexOf('C:\\tmp\\a.png') >= 0);
  assert.strictEqual(p.indexOf('IMAGEN 1'), -1);
  assert.strictEqual(p.indexOf('Leyendas sin respaldo visual'), -1);
  assert.strictEqual(p.indexOf('Contrasta la leyenda'), -1);
});
