// Integra lo APROBADO del rediseño en la app real: aplica la capa actual sobre
// C:\qa-suite\qa-suite.html y copia los logos a assets/. Se puede correr las veces
// que haga falta (reemplaza la capa anterior, no la duplica).
const fs = require('fs'), path = require('path');
const { aplicarCapa } = require('./rediseno');
const raiz = path.join(__dirname, '..', '..');
const app = path.join(raiz, 'qa-suite.html');
['logo-light.png', 'logo-dark.png'].forEach(f =>
  fs.copyFileSync(path.join(__dirname, 'preview', f), path.join(raiz, 'assets', f)));
const html = aplicarCapa(fs.readFileSync(app, 'utf8'), 'assets/');
fs.writeFileSync(app, html);
console.log('ok', html.length);
