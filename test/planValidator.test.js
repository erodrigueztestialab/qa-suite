'use strict';
// Tests del validador deterministico del Plan de Pruebas (M3). Correr con: npm test
// Cada problema P1-P8 del brief se siembra sobre un plan limpio (fixtures/plan-ok.txt),
// generado sobre el mismo requerimiento, inventario y HU de las fixtures de M1.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var P = require('../validators/planValidator.js');

var FIX = path.join(__dirname, 'fixtures');
// Git puede dejar las fixtures en CRLF (Windows); los tests siembran defectos con "\n".
function readFixture(name) { return fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n'); }
var INVENTORY = readFixture('inventario.txt');
var HU = readFixture('hu-ok.txt');
var PLAN_OK = readFixture('plan-ok.txt');
var RESP_OK = [{ equipo: 'TestIAlab', cargo: '', contacto: '' }, { equipo: 'Cliente', cargo: '', contacto: '' }, { equipo: 'Proveedor de Desarrollo', cargo: '', contacto: '' }];

function validate(traced, extra) {
  return P.validatePlan(Object.assign({ traced: traced, inventory: INVENTORY, analysis: HU, responsables: RESP_OK }, extra || {}));
}
function seed(find, replace) {
  assert.ok(PLAN_OK.indexOf(find) >= 0, 'la fixture no contiene: ' + find);
  return PLAN_OK.split(find).join(replace);
}
function has(res, codigo, idPart) {
  return res.hallazgos.some(function(h){ return h.codigo === codigo && (!idPart || h.ids.join(' ').indexOf(idPart) >= 0 || h.mensaje.indexOf(idPart) >= 0); });
}
function blocking(res) { return res.hallazgos.filter(function(h){ return h.severidad === 'error' || h.severidad === 'advertencia'; }); }

test('plan limpio: sin errores ni advertencias y cobertura completa', function(){
  var res = validate(PLAN_OK);
  assert.deepStrictEqual(blocking(res), [], JSON.stringify(res.hallazgos, null, 1));
  assert.strictEqual(res.cobertura.pendientes.enDentroCondicionados, 1);
  assert.strictEqual(res.cobertura.pendientes.trazados, 1);
  assert.strictEqual(res.cobertura.riesgosAnalisis.reflejados, res.cobertura.riesgosAnalisis.total);
});

test('marcas: numeros y codigos; se quitan del texto', function(){
  var items = P.parsePlanTraced(PLAN_OK);
  var sup = items.find(function(i){ return i.sec === 'SUPUESTOS' && /DEP-01/.test(i.text); });
  assert.deepStrictEqual(sup.src.refs, ['DEP-01']);
  var tipos = items.find(function(i){ return i.sec === 'TIPOS_PRUEBA'; });
  assert.deepStrictEqual(tipos.src.nums, [1, 2, 3, 5]);
  assert.ok(!/\[src/i.test(P.stripTraceMarks(PLAN_OK)));
});

test('P1 pendiente en Fuera del Alcance -> V1', function(){
  var moved = seed('- Notificación al Aprobador por el canal móvil de NotiPlus (condicionado a DEP-01). [src: 5]\n', '')
    .replace('---SUPUESTOS---', '- Notificación al Aprobador por el canal móvil de NotiPlus. [src: 5]\n---SUPUESTOS---');
  var res = validate(moved);
  assert.ok(has(res, 'V1', 'Fuera del Alcance #2'));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V1' && /no aparece en Dentro/.test(h.mensaje); }));
  // en Dentro pero sin la condicion
  assert.ok(has(validate(seed('NotiPlus (condicionado a DEP-01). [src: 5]', 'NotiPlus. [src: 5]')), 'V1', 'Dentro del Alcance #5'));
});

test('P1 item que depende de varias DEP debe nombrarlas todas -> V2', function(){
  var inv2 = INVENTORY.replace('---GLOSARIO---', '9 | Dependencia | PENDIENTE | DEP-02 | El formato del aviso móvil está por definir.\n---GLOSARIO---');
  var plan = PLAN_OK.replace('NotiPlus (condicionado a DEP-01). [src: 5]', 'NotiPlus (condicionado a DEP-01). [src: 5,9]');
  var res = validate(plan, { inventory: inv2 });
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V2' && /DEP-02/.test(h.mensaje); }));
});

test('P2 afirmacion mas fuerte que la fuente -> V7', function(){
  var res = validate(seed('- Adjuntar soportes hasta el máximo permitido por solicitud. [src: 4]', '- El sistema exige adjuntar soportes en tiempo real. [src: 4]'));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V7' && /tiempo real/.test(h.mensaje) && /exige/.test(h.mensaje); }));
});

test('P3 nombre propio reemplazado por generico -> V5', function(){
  var res = validate(PLAN_OK.split('NotiPlus').join('desarrollo de terceros'));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V5' && h.severidad === 'error'; }));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V5' && /NotiPlus/.test(h.mensaje); }));
  // "Proveedor de Desarrollo" (equipo de la plantilla) no cuenta como generico
  assert.ok(!has(validate(seed('Desarrollo entrega el desarrollo', 'El Proveedor de Desarrollo entrega el desarrollo')), 'V5'));
});

test('P4 supuestos/riesgos/criterios sin el codigo DEP -> V4', function(){
  var plan = seed('- La integración con NotiPlus para el canal móvil estará definida antes de ejecutar sus casos (DEP-01). [src: DEP-01]\n', '- Las definiciones del Cliente estarán disponibles.\n')
    .replace('- Si DEP-01 no se define antes de la ejecución, la notificación', '- Si la integración no se define antes de la ejecución, la notificación')
    .replace('- Definición de DEP-01 disponible para ejecutar los casos de la notificación por el canal móvil. [src: DEP-01]\n', '');
  var res = validate(plan);
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V4' && h.severidad === 'error' && /DEP-01/.test(h.mensaje); }));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V4' && /no cita el codigo/.test(h.mensaje); }));
});

test('P5 riesgo del analisis sin reflejo en 4.1/4.2 -> V4', function(){
  var res = validate(seed('- Si NotiPlus no responde, podría retrasarse la notificación al Aprobador. [src: 6]\n', ''));
  assert.ok(has(res, 'V4', 'R_2'));
});

test('P6 convenciones, nombre del equipo y cifras inventadas -> V7, V6', function(){
  var res = validate(seed('- Casos de prueba aprobados y datos de prueba disponibles.', '- Casos aprobados por el cliente, por ejemplo los de TestiAlab, en 48 horas.'));
  var cods = res.hallazgos.map(function(h){ return h.codigo + ':' + h.mensaje; }).join('\n');
  assert.ok(/V7:.*minuscula/.test(cods), cods);
  assert.ok(/V7:.*sin coma despues/.test(cods), cods);
  assert.ok(/V7:.*TestIAlab/.test(cods), cods);
  assert.ok(/V6:.*48/.test(cods), cods);
  assert.ok(has(validate(seed('- Casos de prueba aprobados y datos de prueba disponibles.', '- Casos aprobados, por ejemplo, los críticos.')), 'V7'));
  assert.ok(!has(validate(PLAN_OK), 'V6'));
});

test('P7 incoherencia: condicionado en un apartado y no en otro; parentesis anidados -> V2, V7', function(){
  assert.ok(has(validate(seed('incluida la notificación por el canal móvil de NotiPlus, condicionada a DEP-01. [src: 5]', 'incluida la notificación por el canal móvil de NotiPlus. [src: 5]')), 'V2', 'Estrategia'));
  assert.ok(has(validate(seed('- Integración con el sistema contable. [src: 7]', '- Integración con el sistema contable (fuera de este alcance (por ahora)). [src: 7]')), 'V7'));
});

test('P8 Responsables con relleno o equipo mal escrito -> V8', function(){
  var res = validate(PLAN_OK, { responsables: [{ equipo: 'TestiAlab', cargo: 'Por definir', contacto: '' }, { equipo: 'Cliente', cargo: '', contacto: 'N/A' }] });
  assert.strictEqual(res.hallazgos.filter(function(h){ return h.codigo === 'V8'; }).length, 3);
  assert.ok(!has(validate(PLAN_OK), 'V8'));
});

test('V3 codigo inexistente y V9 marca invalida', function(){
  assert.ok(has(validate(seed('(condicionado a DEP-01). [src: 5]', '(condicionado a DEP-01 y DEP-09). [src: 5]')), 'V3'));
  assert.ok(has(validate(seed('- Integración con el sistema contable. [src: 7]', '- Integración con el sistema contable. [src: 99]')), 'V9'));
  assert.ok(has(validate(seed('- Integración con el sistema contable. [src: 7]', '- Integración con el sistema contable.')), 'V9'));
});

test('Fuera del Alcance que no sale de una exclusion -> V1 advertencia', function(){
  var res = validate(seed('- Integración con el sistema contable. [src: 7]', '- Integración con el sistema contable. [src: 4]'));
  assert.ok(res.hallazgos.some(function(h){ return h.codigo === 'V1' && h.severidad === 'advertencia'; }));
});

test('normalizeTitle: conectores en minuscula, siglas intactas', function(){
  assert.strictEqual(P.normalizeTitle('B2B Y Cadenas'), 'B2B y Cadenas');
  assert.strictEqual(P.normalizeTitle('5765 - Control De Stock Por Canal'), '5765 - Control de Stock por Canal');
  assert.strictEqual(P.normalizeTitle('El Portal De Reembolsos'), 'El Portal de Reembolsos');
});

// Items de contexto (tarea pendiente, decision) y contradiccion: patrones de un HU real.
var INVENTORY_CTX = INVENTORY.replace('---GLOSARIO---',
  '9 | Tarea | PENDIENTE | | Se requiere la estimación de horas del desarrollo.\n' +
  '10 | Decision | DEFINIDO | | El equipo técnico decide si extiende la pantalla actual o crea una nueva.\n---GLOSARIO---');

test('contexto: una tarea pendiente no se exige en Alcance pero si en Supuestos/Riesgos (V4); V10 si va en Alcance', function(){
  var res = validate(PLAN_OK, { inventory: INVENTORY_CTX });
  assert.ok(!has(res, 'V1', 'item 9'), 'la tarea pendiente no tiene que ir en Alcance dentro');
  assert.ok(has(res, 'V4', 'item 9'), 'pero si tiene que aparecer en Supuestos, Riesgos o Criterios de entrada');
  var conSupuesto = seed('---RIESGOS_FUNCIONALES---', '- La estimación de horas del desarrollo estará disponible antes de iniciar. [src: 9]\n---RIESGOS_FUNCIONALES---');
  assert.ok(!has(validate(conSupuesto, { inventory: INVENTORY_CTX }), 'V4', 'item 9'));
  var enAlcance = seed('---ALCANCE_FUERA---', '- Evaluación de extender la pantalla actual o crear una nueva. [src: 10]\n---ALCANCE_FUERA---');
  assert.ok(has(validate(enAlcance, { inventory: INVENTORY_CTX }), 'V10', 'Dentro del Alcance'));
  assert.ok(!has(validate(PLAN_OK), 'V10'));
});

test('pendiente que el analisis solo tiene en un riesgo: no se exige en Alcance, si en Supuestos/Riesgos', function(){
  var inv = INVENTORY.replace('---GLOSARIO---', '9 | Dependencia | PENDIENTE | | El acceso al ambiente de pruebas está por definir.\n---GLOSARIO---');
  var hu = HU.replace('---IMPACTOS---', 'R_3 | Medio | El acceso al ambiente de pruebas está por definir | Puede retrasar las pruebas [src: 9]\n---IMPACTOS---');
  var res = validate(PLAN_OK, { inventory: inv, analysis: hu });
  assert.ok(!has(res, 'V1', 'item 9'), 'solo vive en un riesgo: no es alcance');
  assert.ok(has(res, 'V4', 'item 9'), 'pero si se traza en Supuestos, Riesgos o Criterios de entrada');
  var huCa = hu.replace('CA_3 | Dado que', 'CA_3 | Dado que el ambiente está disponible y').replace('permitido". [src: 8]', 'permitido". [src: 8, 9]');
  assert.ok(has(validate(PLAN_OK, { inventory: inv, analysis: huCa }), 'V1', 'item 9'), 'si lo cita un CA, si es alcance');
});

test('fixPorEjemploComma: ", por ejemplo, X" -> " (por ejemplo, X)" sin cambiar el sentido', function(){
  function fx(t) { return P.fixPorEjemploComma(t); }
  assert.strictEqual(fx('Validar las cantidades, por ejemplo, 3 unidades.').text, 'Validar las cantidades (por ejemplo, 3 unidades).');
  assert.strictEqual(fx('- Datos del registro, por ejemplo ubicación y artículo [src: 2]').text, '- Datos del registro (por ejemplo, ubicación y artículo) [src: 2]');
  assert.strictEqual(fx('Campos precargados, por ejemplo, ubicación, artículo y lote.').text, 'Campos precargados (por ejemplo, ubicación, artículo y lote).');
  assert.strictEqual(fx('Pruebas negativas | Cantidad superior al disponible, por ejemplo, N+1 unidades / Destino inexistente').text,
    'Pruebas negativas | Cantidad superior al disponible (por ejemplo, N+1 unidades) / Destino inexistente');
  assert.strictEqual(fx('1. Ingresar una cantidad inválida, por ejemplo, cero >> El sistema no permite continuar').text,
    '1. Ingresar una cantidad inválida (por ejemplo, cero) >> El sistema no permite continuar');
  var ambiguo = 'Límite por reserva, por ejemplo, con N unidades y X reservadas, se mueven N-X.';
  assert.strictEqual(fx(ambiguo).text, ambiguo, 'si no se sabe donde termina el ejemplo, no se toca');
  var intacto = 'Por ejemplo, el Solicitante adjunta X soportes. Campos (nombre, por ejemplo, el del soporte).';
  var r = fx(intacto);
  assert.strictEqual(r.text, intacto, 'no toca el inicio de oracion ni lo que ya esta entre parentesis');
  assert.strictEqual(r.count, 0);
  var plan = PLAN_OK.replace('Adjuntar soportes hasta el máximo permitido por solicitud.', 'Adjuntar soportes hasta el máximo permitido, por ejemplo, facturas.');
  assert.ok(has(validate(plan), 'V7'), 'el validador lo detecta');
  var fixed = fx(plan);
  assert.strictEqual(fixed.count, 1);
  assert.ok(!has(validate(fixed.text), 'V7'), 'y despues de la correccion ya no');
});
