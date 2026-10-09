/* Fondo animado "Panal luminoso azul" (versión lenta aprobada). Solo dibuja; no toca la app. */
(function(){
  var cv=document.getElementById('nd-bg');if(!cv)return;var ctx=cv.getContext('2d'),W,H,cells=[],raf;
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  function rnd(a,b){return a+Math.random()*(b-a)}
  function hex(cx,cy,r){ctx.beginPath();for(var k=0;k<6;k++){var a=Math.PI/3*k+Math.PI/6,x=cx+r*Math.cos(a),y=cy+r*Math.sin(a);k?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath()}
  function init(){cells=[];var r=36,hw=r*Math.sqrt(3),hh=r*1.5;
    for(var row=0,y=-r;y<H+r;row++,y+=hh)for(var x=(row%2?hw/2:0)-hw;x<W+hw;x+=hw){var w=x/W*1.2-.15+(y/H)*.15+rnd(-.08,.08);
      if(w>.12)cells.push({x:x,y:y,r:r,w:Math.min(1,w),fl:rnd(0,16),fs:rnd(9,16)})}}
  function size(){var d=Math.min(devicePixelRatio||1,2);W=innerWidth;H=innerHeight;cv.width=W*d;cv.height=H*d;ctx.setTransform(d,0,0,d,0,0);init()}
  function draw(){var g=ctx.createLinearGradient(0,0,W,H*.3);g.addColorStop(0,'#020D1E');g.addColorStop(.5,'#072745');g.addColorStop(1,'#0E5888');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
    var t=performance.now()/1000,cyc=20,ph=(t%cyc)/cyc,front=W*(1.15-ph*1.6);
    for(var i=0;i<cells.length;i++){var c=cells[i],form=Math.max(0,Math.min(1,(c.x-front)/220)),wave=.5+.5*Math.sin(t*.55-c.x*.012+c.y*.006),
      fl=Math.max(0,1-Math.abs(((t+c.fl)%c.fs)-.9)/.9),a=c.w*(.18+.5*wave)*Math.max(form,.25)+fl*.8,sc=.82+.18*Math.max(form,.4);
      hex(c.x,c.y,(c.r-3)*sc);var rg=ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,c.r);rg.addColorStop(0,'rgba(120,215,255,'+a*.14+')');rg.addColorStop(1,'rgba(120,215,255,'+a*.4+')');
      ctx.fillStyle=rg;ctx.fill();ctx.strokeStyle='rgba(175,232,255,'+Math.min(1,a)+')';ctx.lineWidth=1.5;if(fl>.3||(wave>.88&&c.w>.6)){ctx.shadowBlur=18;ctx.shadowColor='rgba(120,225,255,1)'}ctx.stroke();ctx.shadowBlur=0}
    if(!reduce)raf=requestAnimationFrame(draw)}
  addEventListener('resize',size);size();draw();
})();
