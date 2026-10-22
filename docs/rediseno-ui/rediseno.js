// Aplica la capa del rediseño (nuevo-diseno.css + nuevo-fondo.js + tildes en el texto
// visible del marcado estático) sobre el HTML de la app. Es idempotente: si el HTML ya
// trae la capa, la reemplaza por la versión actual en vez de duplicarla, así se puede
// volver a correr cada vez que se aprueba algo nuevo.
const fs = require('fs'), path = require('path');
const dir = __dirname;

const FONTS = '<link id="nd-fonts" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">';

// logoDir: carpeta de los logos relativa al HTML de salida ('' para preview/, 'assets/' para la app)
function aplicarCapa(html, logoDir) {
  const css = fs.readFileSync(path.join(dir, 'nuevo-diseno.css'), 'utf8')
    .replace(/url\("(logo-(?:light|dark)\.png)"\)/g, 'url("' + logoDir + '$1")');
  const bg = fs.readFileSync(path.join(dir, 'nuevo-fondo.js'), 'utf8');

  // Quita la capa anterior (si ya estaba aplicada)
  html = html
    .replace(/<link id="nd-fonts"[^>]*>\r?\n?/, '')
    .replace(/<style id="nuevo-diseno">[\s\S]*?<\/style>\r?\n?/, '')
    .replace(/\r?\n?<canvas id="nd-bg"><\/canvas>/, '')
    .replace(/<script id="nd-fondo">[\s\S]*?<\/script>\r?\n?/, '');

  // Tildes: solo en el texto visible del marcado estático (entre <body> y el primer <script> del body)
  const b0 = html.indexOf('<body>'), s0 = html.indexOf('<script>', b0);
  const fixes = [['Dia a Dia','Día a Día'],['Estimacion','Estimación'],['Ejecucion','Ejecución'],['ejecucion','ejecución'],['Gestion','Gestión'],
    ['Certificacion','Certificación'],['Historico','Histórico'],['actua','actúa'],['Aceptacion','Aceptación'],['Areas','Áreas'],['areas','áreas'],
    ['vision','visión'],['transcripcion','transcripción'],['reunion','reunión'],['Todavia','Todavía']];
  const L = 'A-Za-zÁÉÍÓÚáéíóúñ';
  const body = html.slice(b0, s0).replace(/>([^<]+)</g, (m, t) => {
    fixes.forEach(([a, b]) => { t = t.replace(new RegExp('(^|[^' + L + '])' + a + '(?![' + L + '])', 'g'), '$1' + b); });
    return '>' + t + '<';
  });
  html = html.slice(0, b0) + body + html.slice(s0);

  html = html.replace('</head>', FONTS + '\n<style id="nuevo-diseno">\n' + css + '\n</style>\n</head>');
  html = html.replace('<body>', '<body>\n<canvas id="nd-bg"></canvas>');
  const end = html.lastIndexOf('</body>');
  return html.slice(0, end) + '<script id="nd-fondo">\n' + bg + '\n</script>\n' + html.slice(end);
}

module.exports = { aplicarCapa };
