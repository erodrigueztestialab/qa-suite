'use strict';
// Tests del validador deterministico de los casos de prueba (M4). Correr con: npm test
// Cada problema Q1-Q9 del brief se siembra sobre un set limpio (fixtures/casos-ok.txt),
// sobre el mismo requerimiento, inventario, HU y plan de las fixtures de M1/M3.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var C = require('../validators/casesValidator.js');

var FIX = path.join(__dirname, 'fixtures');
// Git puede dejar las fixtures en CRLF (Windows); los tests siembran defectos con "\n".
function readFixture(name) { return fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n'); }
var INVENTORY = readFixture('inventario.txt');
var HU = readFixture('hu-ok.txt');
var PLAN = readFixture('plan-ok.txt');
var CASES_OK = readFixture('casos-ok.txt');

function validate(traced, extra) {
  return C.validateCases(Object.assign({ traced: traced, inventory: INVENTORY, analysisTraced: HU, planTraced: PLAN }, extra || {}));
}
function seed(find, replace) {
  assert.ok(CASES_OK.indexOf(find) >= 0, 'la fixture no contiene: ' + find);
  return CASES_OK.split(find).join(replace);
}
function has(res, codigo, id) {
  return res.hallazgos.some(function(h){ return h.codigo === codigo && (!id || h.ids.indexOf(id) >= 0); });
}
function blocking(res) { return res.hallazgos.filter(function(h){ return h.severidad === 'error' || h.severidad === 'advertencia'; }); }

test('set limpio: sin errores ni advertencias y cobertura completa de HU y plan', function(){
  var res = validate(CASES_OK);
  assert.deepStrictEqual(blocking(res), [], JSON.stringify(res.hallazgos, null, 1));
  assert.strictEqual(res.cobertura.hu.cubiertos, res.cobertura.hu.total);
  assert.strictEqual(res.cobertura.plan.cubiertos, res.cobertura.plan.total);
  assert.ok(res.cobertura.plan.total >= 5);
});

test('marcas: src, codigos y cubre; se quitan del texto', function(){
  var cp4 = C.parseCasesTraced(CASES_OK).find(function(c){ return c.id === 'CP_4'; });
  assert.deepStrictEqual(cp4.srcCodes, ['DEP-01']);
  assert.deepStrictEqual(cp4.cubre, ['CA_4', 'ESC_4']);
  assert.strictEqual(cp4.steps.length, 2);
  assert.ok(!/\[\s*(src|cubre)\s*:/i.test(C.stripTraceMarks(CASES_OK)));
});

test('Q1/Q2 caso de un pendiente sin "Condicionado a DEP-01" -> V2', function(){
  var res = validate(seed('Caso: Notificación al Aprobador por el canal móvil de NotiPlus. Condicionado a DEP-01', 'Caso: Notificación al Aprobador por el canal móvil de NotiPlus')
    .replace('cuando DEP-01 esté definida. Condicionado a DEP-01', '').replace('según lo que defina DEP-01', ''));
  assert.ok(has(res, 'V2', 'CP_4'));
});

test('Q3 resultado esperado con alternativas -> V4', function(){
  var res = validate(seed('>> La solicitud se aprueba automáticamente\n### CP_2', '>> La solicitud se aprueba automáticamente o queda en revisión\n### CP_2'));
  assert.ok(has(res, 'V4', 'CP_1'));
  assert.ok(!has(validate(CASES_OK), 'V4'), '"menor o igual" no es una alternativa');
});

test('Q4 exclusion cubierta ejecutando la funcionalidad -> V3', function(){
  var res = validate(seed('Caso: La solicitud aprobada no se envía al sistema contable', 'Caso: Envío de la solicitud aprobada al sistema contable')
    .replace('Verificar que la aprobación de una solicitud no genera ninguna integración con el sistema contable.', 'Verificar la integración con el sistema contable.')
    .replace('>> No se genera ninguna integración con el sistema contable', '>> La solicitud aparece en el sistema contable'));
  assert.ok(has(res, 'V3', 'CP_6'));
});

test('Q5 cobertura incompleta (HU y plan) -> V1', function(){
  var cut = CASES_OK.slice(0, CASES_OK.indexOf('### CP_5'));
  var res = validate(cut);
  assert.ok(has(res, 'V1', 'RN_4'));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V1' && /alcance del plan/.test(h.mensaje); }));
});

test('Q6 mas fuerte que la fuente -> V7', function(){
  var res = validate(seed('>> Los soportes quedan adjuntos a la solicitud', '>> El sistema exige adjuntar los soportes en tiempo real'));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V7' && /tiempo real/.test(h.mensaje); }));
});

test('Q7 nombre propio reemplazado por generico -> V5', function(){
  var res = validate(CASES_OK.split('NotiPlus').join('el proveedor externo'));
  assert.ok(has(res, 'V5', 'CP_4'));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V5' && /NotiPlus/.test(h.mensaje); }));
});

test('Q8 escenario que no existe en la HU -> V6', function(){
  assert.ok(has(validate(seed('Escenario: Máximo de soportes', 'Escenario: Carga de archivos')), 'V6', 'CP_5'));
  assert.ok(!has(validate(CASES_OK), 'V6'), 'el caso de exclusion no necesita escenario de la HU');
});

test('Q9 convenciones, Tipo invalido, cifras inventadas, pasos sin resultado -> V7, V8', function(){
  var res = validate(seed('Tipo: UI', 'Tipo: Negativo').replace('Adjuntar X soportes con X igual al máximo permitido >> Los soportes quedan adjuntos a la solicitud',
    'Adjuntar 7 soportes, por ejemplo los del cliente\n3. Guardar >> Se guarda'));
  var cods = res.hallazgos.map(function(h){ return h.codigo + ':' + h.mensaje; }).join('\n');
  assert.ok(/V7:.*Tipo "Negativo"/.test(cods), cods);
  assert.ok(/V7:.*: 7\./.test(cods), cods);
  assert.ok(/V7:.*minuscula/.test(cods), cods);
  assert.ok(/V7:.*sin coma despues/.test(cods), cods);
  assert.ok(has(res, 'V8', 'CP_5'));
  assert.ok(!has(validate(seed('Tipo: UI', 'Tipo: Func')), 'V7'), '"Func" es valido');
});

test('V9 referencia inexistente y V10 duplicado', function(){
  assert.ok(has(validate(seed('[cubre: RN_4, ESC_5]', '[cubre: RN_4, ESC_5, CA_9]')), 'V9', 'CP_5'));
  assert.ok(has(validate(seed('[src: RN_4]', '[src: RN_4, DEP-07]')), 'V9', 'CP_5'));
  var dup = CASES_OK + '\n' + CASES_OK.slice(CASES_OK.indexOf('### CP_6')).replace('### CP_6', '### CP_7');
  assert.ok(has(validate(dup), 'V10', 'CP_7'));
});

test('mergeRepairedCases: reemplaza solo los devueltos, elimina relleno y renumera', function(){
  var dup = CASES_OK + '\n' + CASES_OK.slice(CASES_OK.indexOf('### CP_1'), CASES_OK.indexOf('### CP_2')).replace('### CP_1', '### CP_7').trim();
  var fixed = '---CASOS_DE_PRUEBA---\n### CP_3 [src: CA_3] [cubre: CA_3, ESC_3]\nRequisito: CA_3\nTipo: Funcional\nComplejidad: Bajo\n' +
    'Escenario: Monto fuera del límite\nCaso: Corregido\nObjetivo: Corregido.\nPasos:\n1. Paso >> Resultado\n### CP_7\nEliminar: SI';
  var m = C.mergeRepairedCases(dup, fixed);
  assert.ok(m.ok);
  var ids = C.caseBlocks(m.traced).map(function(b){ return b.id; });
  assert.deepStrictEqual(ids, ['CP_1', 'CP_2', 'CP_3', 'CP_4', 'CP_5', 'CP_6']);
  assert.ok(/Caso: Corregido/.test(m.traced));
  assert.strictEqual(m.conservados.length, 0);
  assert.ok(!has(validate(m.traced), 'V10'));
});

test('mergeRepairedCases: no elimina el unico caso que cubre un item (caso negativo de la exclusion)', function(){
  var m = C.mergeRepairedCases(CASES_OK, '---CASOS_DE_PRUEBA---\n### CP_6\nEliminar: SI');
  assert.ok(m.ok);
  assert.strictEqual(C.caseBlocks(m.traced).length, 6);
  assert.ok(/no se elimino/.test(m.conservados[0].mensaje) && /RN_5/.test(m.conservados[0].mensaje));
  assert.ok(!has(validate(m.traced), 'V1'));
  assert.strictEqual(C.mergeRepairedCases(CASES_OK, 'texto sin casos').ok, false);
  assert.ok(C.mergeRepairedCases(CASES_OK, '---CASOS_DE_PRUEBA---\nSIN_CAMBIOS').ok);
});
