// Uso: node capturar.js <salida.png> <ancho>x<alto> [url]
// Abre Edge sin ventana con un perfil propio, espera la captura y lo cierra pase lo que pase (máx. 45 s).
const { spawn } = require('child_process'), fs = require('fs'), path = require('path');
const [out, size, url0] = process.argv.slice(2);
const url = url0 || 'file:///' + path.join(__dirname, 'preview', 'app-preview.html').replace(/\\/g, '/').replace(/ /g, '%20');
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const prof = path.join(__dirname, 'edge-prof-' + process.pid);
try { fs.unlinkSync(out); } catch (e) {}
const p = spawn(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--no-first-run',
  '--user-data-dir=' + prof, '--window-size=' + size.replace('x', ','), '--virtual-time-budget=6000', '--screenshot=' + out, url], { stdio: 'ignore' });
const t0 = Date.now();
const iv = setInterval(() => {
  const ok = fs.existsSync(out) && fs.statSync(out).size > 0;
  if (ok || Date.now() - t0 > 45000) {
    clearInterval(iv);
    setTimeout(() => { try { process.kill(p.pid); } catch (e) {} spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' });
      console.log(ok ? 'ok ' + out : 'sin captura'); setTimeout(() => process.exit(0), 500); }, 1200);
  }
}, 500);
