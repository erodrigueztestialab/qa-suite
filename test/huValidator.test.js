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
// Git puede dejar las fixtures en CRLF (Windows); los tests siembran defectos con "\n".
function readFixture(name) { return fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n'); }
var INVENTORY = readFixture('inventario.txt');
var HU_OK = readFixture('hu-ok.txt');

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

// Inventario con items de contexto y una contradiccion (patrones vistos en un HU real:
// objetivo, tarea del proyecto, decision tecnica y dos versiones incompatibles).
var INVENTORY_CTX = INVENTORY.replace('---GLOSARIO---',
  '9 | Objetivo | DEFINIDO | | Reducir el tiempo de registro de las solicitudes.\n' +
  '10 | Tarea | PENDIENTE | | Se requiere la estimación de horas del desarrollo.\n' +
  '11 | Decision | DEFINIDO | | El equipo técnico decide si extiende la pantalla actual o crea una nueva.\n' +
  '12 | Regla | CONTRADICCION | | Versión 1: los soportes se pueden eliminar después de enviar; Versión 2: no se pueden eliminar.\n' +
  '---GLOSARIO---');
var R_CTX = 'R_3 | Medio | La estimación de horas del desarrollo está pendiente | Puede retrasar el inicio de las pruebas [src: 10]\n' +
  'R_4 | Medio | No está definido si los soportes se pueden eliminar después de enviar (dos versiones) | Puede cambiar el resultado esperado [src: 12]\n';
function withCtx(hu) { return hu.replace('---IMPACTOS---', R_CTX + '---IMPACTOS---'); }

test('inventario: estado CONTRADICCION se trata como pendiente y tipos de contexto', function(){
  var inv = V.parseInventory(INVENTORY_CTX);
  var c = inv.items.find(function(i){ return i.n === 12; });
  assert.strictEqual(c.estado, 'PENDIENTE');
  assert.strictEqual(c.contradiccion, true);
  assert.ok(V.isContext(inv.items.find(function(i){ return i.n === 9; })));
  assert.ok(V.isContext(inv.items.find(function(i){ return i.n === 10; })));
  assert.ok(V.isContext(inv.items.find(function(i){ return i.n === 11; })));
  assert.ok(!V.isContext(inv.items.find(function(i){ return i.n === 1; })));
});

test('contexto sin CA/RN/ESC no es faltante; pendiente de contexto exige riesgo pero no escenario', function(){
  var res = validate(withCtx(HU_OK), { inventory: INVENTORY_CTX });
  assert.ok(res.cobertura.inventario.faltantes.indexOf(9) < 0 && res.cobertura.inventario.faltantes.indexOf(11) < 0);
  assert.deepStrictEqual(res.cobertura.inventario.contexto, [9, 10, 11]);
  assert.ok(res.cobertura.pendientes.sinEscCondicionado.indexOf(10) < 0, 'una tarea no lleva escenario');
  assert.ok(res.hallazgos.every(function(h){ return h.mensaje.indexOf('item 10') < 0; }));
  var sinRiesgo = validate(HU_OK, { inventory: INVENTORY_CTX });
  assert.ok(sinRiesgo.cobertura.pendientes.sinRiesgo.indexOf(10) >= 0, 'la tarea pendiente sin riesgo se reporta');
});

test('V14: CA/RN/ESC que sale solo de contexto (objetivo, tarea, decision)', function(){
  var hu = withCtx(HU_OK).replace('---RIESGOS---',
    'RN_6 | Se requiere la estimación de horas del desarrollo. Condicionado a la estimación de horas [src: 10]\n' +
    'RN_7 | La solución reduce el tiempo de registro de las solicitudes. [src: 9, 1]\n---RIESGOS---');
  var res = validate(hu, { inventory: INVENTORY_CTX });
  assert.ok(hasFinding(res, 'V14', 'RN_6'));
  assert.ok(!hasFinding(res, 'V14', 'RN_7'), 'si tambien sale de una regla del sistema, no es solo contexto');
  var esc = withCtx(HU_OK).replace('[src: 4] [cubre: RN_4]', '[src: 11] [cubre: RN_4]');
  assert.ok(hasFinding(validate(esc, { inventory: INVENTORY_CTX }), 'V14', 'ESC_5'));
  assert.ok(!hasFinding(validate(withCtx(HU_OK), { inventory: INVENTORY_CTX }), 'V14'), 'los R_N si pueden citar contexto');
});

test('V15: RN que repite un CA', function(){
  var hu = seed('RN_4 | El Solicitante puede adjuntar hasta 3 soportes por solicitud. [src: 4]',
    'RN_4 | El Solicitante puede adjuntar hasta 3 soportes por solicitud. [src: 4]\n' +
    'RN_5 | Si el monto supera el máximo sin factura electrónica validada, el sistema muestra "El monto supera el máximo permitido". [src: 8]')
    .replace('RN_5 | La integración con el sistema contable', 'RN_6 | La integración con el sistema contable');
  var res = validate(hu);
  assert.ok(hasFinding(res, 'V15', 'RN_5') && hasFinding(res, 'V15', 'CA_3'));
  assert.ok(!hasFinding(res, 'V15', 'RN_6'), 'la RN de exclusion no se compara');
  assert.ok(!hasFinding(validate(HU_OK), 'V15'), 'reglas propias (maximo, excepcion, soportes) no repiten un CA');
});

test('V4/V3 nombran la contradiccion como tal', function(){
  var hu = HU_OK.replace('RN_4 | El Solicitante puede adjuntar hasta 3 soportes por solicitud. [src: 4]',
    'RN_4 | El Solicitante puede adjuntar hasta 3 soportes por solicitud y eliminarlos después de enviar. [src: 4, 12]');
  var res = validate(hu, { inventory: INVENTORY_CTX });
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V4' && /contradiccion del item 12/.test(h.mensaje); }));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V3' && /contradiccion del item 12 no aparece en ningun riesgo/.test(h.mensaje); }));
  assert.deepStrictEqual(res.cobertura.contradicciones.map(function(c){ return c.n; }), [12]);
});

test('V13: etiquetas internas del inventario en el texto', function(){
  var res = validate(seed('La notificación por el canal móvil sigue sin definirse', 'La notificación por el canal móvil sigue PENDIENTE'));
  assert.ok(hasFinding(res, 'V13', 'JUSTIFICACION_RIESGO'));
  assert.ok(hasFinding(validate(seed('RN_4 | El Solicitante puede', 'RN_4 | Versión 1: el Solicitante puede')), 'V13', 'RN_4'));
  assert.ok(!hasFinding(validate(HU_OK), 'V13'));
});

test('V16: RN que solo dice que algo no esta definido; V3 no pide escenario a un pendiente que solo vive en un riesgo', function(){
  var hu = seed('RN_4 | El Solicitante puede adjuntar hasta 3 soportes por solicitud. [src: 4]', 'RN_4 | El formato de los soportes no está definido. Condicionado a DEP-01 [src: 4, 5]');
  assert.ok(hasFinding(validate(hu), 'V16', 'RN_4'));
  assert.ok(!hasFinding(validate(HU_OK), 'V16'));
  // DEP-01 deja de estar en CA/RN (solo en R_1): ya no se le exige escenario condicionado.
  var soloRiesgo = HU_OK.split('\n').filter(function(l){ return !/^(CA_4|ESC_4) /.test(l); }).join('\n');
  var res = validate(soloRiesgo);
  assert.ok(res.cobertura.pendientes.sinEscCondicionado.indexOf(5) < 0, 'pendiente solo en riesgo: sin escenario exigido');
  assert.ok(validate(HU_OK.replace('Condicionado a DEP-01 [src: 5] [cubre: CA_4]', '[src: 1] [cubre: CA_4]')).cobertura.pendientes.sinEscCondicionado.indexOf(5) >= 0, 'si lo cita un CA, se exige');
});

test('applyContradictions: marca la contradiccion citada y condiciona los demas items', function(){
  var fuentes = ['El Solicitante puede adjuntar hasta 3 soportes por solicitud.',
    'En la reunion: no, soportes no se adjuntan desde el canal movil.'];
  var r = V.applyContradictions(INVENTORY, [{ items: [4, 8], tema: 'Soportes', version1: 'se adjuntan hasta 3 soportes',
    version2: 'no se adjuntan soportes desde el canal movil', cita1: 'puede adjuntar hasta 3 soportes',
    cita2: 'soportes no se adjuntan desde el canal móvil' }], fuentes);
  assert.deepStrictEqual(r.aplicadas.map(function(a){ return a.n; }), [4]);
  var inv = V.parseInventory(r.inventory);
  var it4 = inv.items.filter(function(i){ return i.n === 4; })[0], it8 = inv.items.filter(function(i){ return i.n === 8; })[0];
  assert.ok(it4.contradiccion && /Version 1: .*; Version 2: /.test(it4.condicion));
  assert.ok(!it8.contradiccion && it8.estado === 'PENDIENTE' && /contradiccion del item 4/.test(it8.condicion));
  assert.strictEqual(inv.items.length, 8, 'no se pierden ni se agregan items');
  assert.strictEqual(inv.glossary.length, 4, 'el glosario queda igual');
  // La contradiccion queda en la cobertura que muestra el recuadro de M1.
  assert.deepStrictEqual(validate(HU_OK, { inventory: r.inventory }).cobertura.contradicciones.map(function(c){ return c.n; }), [4]);
});

test('applyContradictions: descarta citas inventadas, items inexistentes y lo que ya era contradiccion', function(){
  var fuentes = ['El Solicitante puede adjuntar hasta 3 soportes por solicitud.'];
  var base = { tema: 'Soportes', version1: 'a', version2: 'b', cita1: 'puede adjuntar hasta 3 soportes' };
  var r = V.applyContradictions(INVENTORY, [
    Object.assign({ items: [4], cita2: 'esta frase no esta en ninguna fuente' }, base),
    Object.assign({ items: [99], cita2: 'puede adjuntar hasta 3 soportes' }, base),
  ], fuentes);
  assert.strictEqual(r.aplicadas.length, 0);
  assert.strictEqual(r.inventory, INVENTORY, 'sin contradicciones validas el inventario no cambia');
  assert.strictEqual(r.descartadas.length, 2);
  // Sin texto de las fuentes (PDF nativo) no se verifican las citas.
  assert.strictEqual(V.applyContradictions(INVENTORY, [Object.assign({ items: [4], cita2: 'otra frase cualquiera' }, base)], null).aplicadas.length, 1);
  // Lo que el inventario ya trae como contradiccion no se duplica.
  var ya = V.applyContradictions(INVENTORY, [Object.assign({ items: [4], cita2: 'otra frase cualquiera' }, base)], null).inventory;
  assert.strictEqual(V.applyContradictions(ya, [Object.assign({ items: [4], cita2: 'otra frase cualquiera' }, base)], null).aplicadas.length, 0);
});
