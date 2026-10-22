// Arma preview/app-preview.html = copia EXACTA de C:\qa-suite\qa-suite.html + la capa de estilos
// en su versión actual (sirve para mostrar cambios aún no aprobados sin tocar la app).
// No toca el HTML de la app (salvo tildes en textos visibles del marcado) ni su JavaScript.
const fs = require('fs'), path = require('path');
const { aplicarCapa } = require('./rediseno');
const html = aplicarCapa(fs.readFileSync(path.join(__dirname, '..', '..', 'qa-suite.html'), 'utf8'), '');
fs.writeFileSync(path.join(__dirname, 'preview', 'app-preview.html'), html);
console.log('ok', html.length);
