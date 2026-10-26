'use strict';
// Tests del validador deterministico del HU (M1). Correr con: npm test
// Cada defecto D1-D9 del brief se siembra sobre un HU limpio (fixtures/hu-ok.txt)
// y se verifica que el validador lo detecta con el codigo esperado.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var V = require('../validators/huValidator.js');

var FIX = path.join(__dirname, 'fixtures');
var INVENTORY = fs.readFileSync(path.join(FIX, 'inventario.txt'), 'utf8');
var HU_OK = fs.readFileSync(path.join(FIX, 'hu-ok.txt'), 'utf8');

function validate(traced, extra) {
  return V.validateHU(Object.assign({ traced: traced, inventory: INVENTORY }, extra || {}));
}
function codes(res, severidades) {
  return res.hallazgos.filter(function(h){ return !severidades || severidades.indexOf(h.severidad) >= 0; })
    .map(function(h){ return h.codigo; });
}
function seed(find, replace) {
  assert.ok(HU_OK.indexOf(find) >= 0, 'la fixture no contiene: ' + find);
  return HU_OK.split(find).join(replace);
}
function hasFinding(res, codigo, id) {
  return res.hallazgos.some(function(h){ return h.codigo === codigo && (!id || h.ids.indexOf(id) >= 0); });
}

test('inventario: estado, ref, exclusion y glosario', function(){
  var inv = V.parseInventory(INVENTORY);
  assert.strictEqual(inv.items.length, 8);
  var dep = inv.items.find(function(i){ return i.n === 5; });
  assert.strictEqual(dep.estado, 'PENDIENTE');
  assert.strictEqual(dep.ref, 'DEP-01');
  assert.ok(/exclu/i.test(inv.items.find(function(i){ return i.n === 7; }).tipo));
  assert.ok(inv.glossary.some(function(g){ return g.termino === 'NotiPlus'; }));
});

test('inventario: acepta el formato viejo "N | Tipo | Condicion"', function(){
  var inv = V.parseInventory('1 | Regla | El campo es obligatorio\n2 | Limite | Maximo 10');
  assert.strictEqual(inv.items.length, 2);
  assert.strictEqual(inv.items[0].estado, 'DEFINIDO');
  assert.strictEqual(inv.items[1].condicion, 'Maximo 10');
});

test('marcas de trazabilidad: se parsean y se quitan', function(){
  var A = V.parseTracedAnalysis(HU_OK);
  var esc4 = A.items.find(function(i){ return i.id === 'ESC_4'; });
  assert.deepStrictEqual(esc4.src, [5]);
  assert.deepStrictEqual(esc4.cubre, ['CA_4']);
  assert.strictEqual(esc4.condicion, 'DEP-01');
  var clean = V.stripTraceMarks(HU_OK);
  assert.ok(!/\[\s*(src|cubre)\s*:/i.test(clean));
  assert.ok(/CA_1 \| Dado que/.test(clean));
  // tambien acepta [src: N1,N3]
  assert.deepStrictEqual(V.parseTracedAnalysis('---CRITERIOS_DE_ACEPTACION---\nCA_1 | x [src: N1,N3]').items[0].src, [1, 3]);
});

test('AC1 (deterministico): el HU limpio no tiene errores ni advertencias', function(){
  var res = validate(HU_OK);
  assert.deepStrictEqual(codes(res, ['error', 'advertencia']), [], JSON.stringify(res.hallazgos, null, 1));
  assert.strictEqual(res.cobertura.inventario.faltantes.length, 0);
  assert.deepStrictEqual(res.cobertura.inventario.exentos, [7]); // AC8
  assert.strictEqual(res.cobertura.criterios.sinEscenario.length, 0);
});

// ── AC2: un defecto sembrado por clase ──────────────────────────────────────
test('D1 contradiccion por absoluto sin excepcion -> V7', function(){
  var res = validate(seed(', salvo las solicitudes con factura electrónica validada (RN_3)', ''));
  assert.ok(hasFinding(res, 'V7', 'RN_2'));
});

test('D2 calificativo sin sustento -> V9; generico en vez de nombre propio -> V13', function(){
  var res = validate(seed('está por definir (DEP-01)', 'está por definir (DEP-01), con impacto financiero bajo'));
  assert.ok(hasFinding(res, 'V9', 'R_1'));
  var res2 = validate(seed('La integración con NotiPlus para el canal móvil', 'El desarrollo de un tercero para el canal móvil'));
  assert.ok(hasFinding(res2, 'V13', 'R_1'));
});

test('D2 meta-cita a la fuente -> V10 (los codigos del documento no cuentan)', function(){
  var res = validate(seed('RN_1 | El monto máximo', 'RN_1 | Según el documento, el monto máximo'));
  assert.ok(hasFinding(res, 'V10', 'RN_1'));
  assert.ok(!hasFinding(validate(HU_OK), 'V10'), 'DEP-01 no debe marcarse como meta-cita');
});

test('D3 pendiente tratado como definitivo -> V4', function(){
  var res = validate(seed('canal móvil de NotiPlus. Condicionado a DEP-01 [src: 5]\n---REGLAS', 'canal móvil de NotiPlus. [src: 5]\n---REGLAS'));
  assert.ok(hasFinding(res, 'V4', 'CA_4'));
});

test('D4 cobertura incompleta -> V3', function(){
  var lines = HU_OK.split('\n').filter(function(l){ return l.indexOf('ESC_4 |') !== 0; });
  var res = validate(lines.join('\n'));
  assert.ok(hasFinding(res, 'V3', 'CA_4'), 'CA_4 sin escenario');
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V3' && /DEP-01/.test(h.mensaje) && /escenario condicionado/.test(h.mensaje); }));
  var res2 = validate(seed('RN_5 | La integración con el sistema contable queda fuera del alcance. [src: 7]\n', ''));
  assert.ok(res2.hallazgos.some(function(h){ return h.codigo === 'V3' && /inventario sin reflejo/.test(h.mensaje) && /7/.test(h.mensaje); }));
});

test('D5 cifra fija -> V5; nivel sin heredar criticidad -> V6; "ejemplo" sin coma -> V13', function(){
  assert.ok(hasFinding(validate(seed('con monto N menor', 'con monto 350 menor')), 'V5', 'ESC_1'));
  assert.ok(!hasFinding(validate(HU_OK), 'V5'), 'el 500 literal del requerimiento si se permite');
  // una Ref solo numerica (numeracion de lista) no debe partir "500" en "00"
  var invNumRef = INVENTORY.replace('1 | Regla | DEFINIDO | |', '1 | Regla | DEFINIDO | 5 |');
  assert.ok(!hasFinding(validate(HU_OK, { inventory: invNumRef }), 'V5'));
  assert.ok(hasFinding(validate(seed('R_1 | Alto |', 'R_1 | Bajo |')), 'V6', 'R_1'));
  assert.ok(hasFinding(validate(seed('RN_4 | El Solicitante puede', 'RN_4 | Por ejemplo el Solicitante puede')), 'V13', 'RN_4'));
  assert.ok(hasFinding(validate(seed('RN_4 | El Solicitante puede', 'RN_4 | El cliente puede')), 'V13', 'RN_4'));
});

test('D6 termino del documento sustituido -> V13', function(){
  var res = validate(seed('Entonces la notificación llega por el canal móvil de NotiPlus.', 'Entonces la notificación llega por el canal móvil del proveedor externo.'));
  assert.ok(hasFinding(res, 'V13', 'CA_4'));
});

test('D7 condicion no propagada al escenario -> V4b (AC7)', function(){
  var res = validate(seed('canal móvil de NotiPlus. Condicionado a DEP-01 [src: 5] [cubre: CA_4]', 'canal móvil de NotiPlus. [src: 5] [cubre: CA_4]'));
  assert.ok(hasFinding(res, 'V4b', 'ESC_4'));
  // inverso: escenario condicionado que solo cubre items no condicionados
  var res2 = validate(seed('verificar que se aceptan. [src: 4] [cubre: RN_4]', 'verificar que se aceptan. Condicionado a DEP-01 [src: 4] [cubre: RN_4]'));
  assert.ok(res2.hallazgos.some(function(h){ return h.codigo === 'V4b' && h.severidad === 'advertencia' && h.ids.indexOf('ESC_5') >= 0; }));
});

test('D8 premisa escrita como hecho -> V8; impacto inferido sin modal -> V11 (AC7)', function(){
  var res = validate(seed('R_2 | Medio | Si NotiPlus no responde, podría retrasarse la notificación al Aprobador | Posible retraso en la gestión de la solicitud',
    'R_2 | Medio | NotiPlus no responde y la notificación al Aprobador se retrasa | Retraso en la gestión de la solicitud con incumplimiento'));
  assert.ok(hasFinding(res, 'V8', 'R_2'));
  assert.ok(hasFinding(res, 'V11', 'R_2'));
  var res2 = validate(seed('RN_4 | El Solicitante puede adjuntar', 'RN_4 | El Solicitante debe adjuntar'));
  assert.ok(hasFinding(res2, 'V8', 'RN_4'), 'puede -> debe');
});

test('D9 escenario con alternativas combinadas -> V12 (AC7)', function(){
  var res = validate(seed('Adjuntar X soportes con X igual al máximo permitido', 'Adjuntar X soportes o un archivo sin formato'));
  assert.ok(hasFinding(res, 'V12', 'ESC_5'));
  assert.ok(!hasFinding(validate(HU_OK), 'V12'), '"menor o igual" no es una alternativa');
});

test('V1 IDs continuos y sin duplicados; V2 referencias inexistentes', function(){
  var res = validate(seed('RN_3 | Las solicitudes', 'RN_7 | Las solicitudes'));
  assert.ok(hasFinding(res, 'V1', 'RN_3'));
  assert.ok(hasFinding(res, 'V2', 'RN_2'), 'RN_2 cita RN_3, que ya no existe');
  var res2 = validate(seed('CA_2 | Dado que el monto supera el máximo y', 'CA_1 | Dado que el monto supera el máximo y'));
  assert.ok(hasFinding(res2, 'V1', 'CA_1'));
  assert.ok(hasFinding(validate(seed('[cubre: CA_1]', '[cubre: CA_9]')), 'V2', 'ESC_1'));
});

test('sin trazas (HU importado): no exige [src] ni cobertura por marcas', function(){
  var res = validate(V.stripTraceMarks(HU_OK), { conTrazas: false });
  assert.ok(!res.hallazgos.some(function(h){ return ['V3', 'V4', 'V4b', 'V6', 'V8'].indexOf(h.codigo) >= 0; }));
  assert.strictEqual(res.cobertura.conTrazas, false);
});

test('auditEstado', function(){
  assert.strictEqual(V.auditEstado([]), 'OK');
  assert.strictEqual(V.auditEstado([{ severidad: 'advertencia' }]), 'CON_ADVERTENCIAS');
});
