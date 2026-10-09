// Arma preview/app-preview.html = copia EXACTA de C:\qa-suite\qa-suite.html + capa de estilos nueva.
// No toca el HTML de la app (salvo tildes en textos visibles del marcado) ni su JavaScript.
const fs = require('fs'), path = require('path');
const dir = __dirname;
let html = fs.readFileSync(path.join(__dirname, '..', '..', 'qa-suite.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'nuevo-diseno.css'), 'utf8');
const bg = fs.readFileSync(path.join(dir, 'nuevo-fondo.js'), 'utf8');

// Tildes: solo en el texto visible del marcado estático (entre <body> y el primer <script> del body)
const b0 = html.indexOf('<body>'), s0 = html.indexOf('<script>', b0);
const fixes = [['Dia a Dia','Día a Día'],['Estimacion','Estimación'],['Ejecucion','Ejecución'],['ejecucion','ejecución'],['Gestion','Gestión'],
  ['Certificacion','Certificación'],['Historico','Histórico'],['actua','actúa'],['Aceptacion','Aceptación'],['Areas','Áreas'],['areas','áreas'],
  ['vision','visión'],['transcripcion','transcripción'],['reunion','reunión'],['Todavia','Todavía']];
const L = 'A-Za-zÁÉÍÓÚáéíóúñ';
let body = html.slice(b0, s0).replace(/>([^<]+)</g, (m, t) => {
  fixes.forEach(([a, b]) => { t = t.replace(new RegExp('(^|[^' + L + '])' + a + '(?![' + L + '])', 'g'), '$1' + b); });
  return '>' + t + '<';
});
html = html.slice(0, b0) + body + html.slice(s0);

const head = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">\n<style id="nuevo-diseno">\n' + css + '\n</style>\n';
html = html.replace('</head>', head + '</head>');
html = html.replace('<body>', '<body>\n<canvas id="nd-bg"></canvas>');
const end = html.lastIndexOf('</body>');
html = html.slice(0, end) + '<script>\n' + bg + '\n</script>\n' + html.slice(end);
fs.writeFileSync(path.join(dir, 'preview', 'app-preview.html'), html);
console.log('ok', html.length);
