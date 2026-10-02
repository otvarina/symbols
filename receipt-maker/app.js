/* =========================================================
   ЧЕК_MAKER — логика генерации термочека
   Canvas-рендер: бумага, текст, фото (ч/б растр), QR, края, FX
   ========================================================= */

const SCALE = 2; // множитель разрешения для чёткости экспорта

const state = {
  width: 680,
  height: 1500,
  lines: [
    { type: 'normal', text: 'ПЯТНИЦА, 16/10/26 | 19:30' },
    { type: 'spacer', text: '' },
    { type: 'title',  text: 'ГРУППА «БЮРО»' },
    { type: 'spacer', text: '' },
    { type: 'normal', text: 'МОСКВА, ЗОТОВ' },
    { type: 'divider', text: '' },
    { type: 'normal', text: 'АКУСТИЧЕСКИЙ КОНЦЕРТ   90 МИН' },
    { type: 'small',  text: 'ПОЛНЫМ СОСТАВОМ' },
    { type: 'divider', text: '' },
  ],
  photo: {
    img: null,
    contrast: 120,
    brightness: 105,
    grain: 55,
    scale: 78,
    dither: true,
  },
  qr: {
    enabled: true,
    text: 'https://t.me/',
    size: 220,
    caption: 'СКАНИРУЙ',
  },
  edges: {
    top: 'zigzag',
    bottom: 'zigzag',
    size: 14,
  },
  fx: {
    paperGrain: 30,
    paperTint: 12,
    inkBleed: 0,
    inkFade: 15,
    thermalBurn: 0,
    crumple: 20,
  },
  seed: 1337,
};

const canvas = document.getElementById('receiptCanvas');
const ctx = canvas.getContext('2d');

// объявляем заранее, чтобы избежать temporal dead zone при раннем вызове scheduleRender()
let renderQueued = false;
function scheduleRender(){
  if(renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(()=>{ renderQueued = false; render(); });
}

/* ---------- seeded random (стабильные "случайные" эффекты) ---------- */
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ========================================================
   UI BINDING
   ======================================================== */

// tabs
document.querySelectorAll('.tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tabpanel').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.tabpanel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
  });
});

function bindRange(id, onChange, showVal=true){
  const el = document.getElementById(id);
  const valEl = document.getElementById('val-'+id);
  const update = ()=>{
    if(valEl) valEl.textContent = el.value;
    onChange(Number(el.value));
    scheduleRender();
  };
  el.addEventListener('input', update);
  update();
}

bindRange('receiptWidth', v=> state.width = v);
bindRange('receiptHeight', v=> state.height = v);

bindRange('photoContrast', v=> state.photo.contrast = v);
bindRange('photoBrightness', v=> state.photo.brightness = v);
bindRange('photoGrain', v=> state.photo.grain = v);
bindRange('photoScale', v=> state.photo.scale = v);

bindRange('qrSize', v=> state.qr.size = v);
bindRange('edgeSize', v=> state.edges.size = v);

bindRange('paperGrain', v=> state.fx.paperGrain = v);
bindRange('paperTint', v=> state.fx.paperTint = v);
bindRange('inkBleed', v=> state.fx.inkBleed = v);
bindRange('inkFade', v=> state.fx.inkFade = v);
bindRange('thermalBurn', v=> state.fx.thermalBurn = v);
bindRange('crumple', v=> state.fx.crumple = v);

document.getElementById('photoDither').addEventListener('change', e=>{
  state.photo.dither = e.target.checked;
  scheduleRender();
});

document.getElementById('qrEnabled').addEventListener('change', e=>{
  state.qr.enabled = e.target.checked;
  scheduleRender();
});
document.getElementById('qrText').addEventListener('input', e=>{
  state.qr.text = e.target.value;
  scheduleRender();
});
document.getElementById('qrCaption').addEventListener('input', e=>{
  state.qr.caption = e.target.value;
  scheduleRender();
});

document.getElementById('edgeTop').addEventListener('change', e=>{
  state.edges.top = e.target.value;
  scheduleRender();
});
document.getElementById('edgeBottom').addEventListener('change', e=>{
  state.edges.bottom = e.target.value;
  scheduleRender();
});

document.getElementById('reshuffle').addEventListener('click', ()=>{
  state.seed = Math.floor(Math.random()*1000000);
  scheduleRender();
});

document.getElementById('photoInput').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ev=>{
    const img = new Image();
    img.onload = ()=>{
      state.photo.img = img;
      scheduleRender();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});
document.getElementById('removePhoto').addEventListener('click', ()=>{
  state.photo.img = null;
  document.getElementById('photoInput').value = '';
  scheduleRender();
});

document.getElementById('btnReset').addEventListener('click', ()=>{
  if(confirm('Сбросить все настройки?')) location.reload();
});

document.getElementById('btnExport').addEventListener('click', exportPNG);

/* ---------- text lines editor ---------- */
const textLinesEl = document.getElementById('textLines');
const TYPE_LABELS = {
  title: 'Заголовок', bold: 'Жирный', normal: 'Обычный',
  small: 'Мелкий', divider: 'Линия', spacer: 'Отступ'
};

function renderLinesEditor(){
  textLinesEl.innerHTML = '';
  state.lines.forEach((line, idx)=>{
    const row = document.createElement('div');
    row.className = 'text-line-item';

    const select = document.createElement('select');
    Object.keys(TYPE_LABELS).forEach(key=>{
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = TYPE_LABELS[key];
      if(key === line.type) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', ()=>{
      state.lines[idx].type = select.value;
      scheduleRender();
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.value = line.text;
    input.placeholder = 'текст строки...';
    input.disabled = (line.type === 'divider' || line.type === 'spacer');
    input.addEventListener('input', ()=>{
      state.lines[idx].text = input.value;
      scheduleRender();
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'text-line-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', ()=>{
      state.lines.splice(idx,1);
      renderLinesEditor();
      scheduleRender();
    });

    row.appendChild(select);
    row.appendChild(input);
    row.appendChild(removeBtn);
    textLinesEl.appendChild(row);
  });
}

document.getElementById('addLine').addEventListener('click', ()=>{
  state.lines.push({ type:'normal', text:'НОВАЯ СТРОКА' });
  renderLinesEditor();
  scheduleRender();
});

renderLinesEditor();

/* ========================================================
   RENDER PIPELINE
   ======================================================== */

function buildEdgePath(w, h, topType, bottomType, edgeSize, rand){
  const path = new Path2D();
  const teeth = Math.max(4, Math.round(w / (edgeSize*2.2)));
  const step = w / teeth;

  // --- top edge ---
  path.moveTo(0, topType==='straight' ? 0 : edgeSize);
  if(topType === 'zigzag'){
    for(let i=0;i<=teeth;i++){
      const x = i*step;
      const y = (i % 2 === 0) ? 0 : edgeSize;
      path.lineTo(x, y);
    }
  } else if(topType === 'perforated'){
    path.lineTo(0,0); path.lineTo(w,0); path.lineTo(w, edgeSize*0.3);
  } else if(topType === 'torn'){
    const segs = Math.max(10, Math.round(w/18));
    for(let i=0;i<=segs;i++){
      const x = (w/segs)*i;
      const y = rand()*edgeSize*0.9;
      path.lineTo(x, y);
    }
  } else {
    path.lineTo(0,0); path.lineTo(w,0);
  }

  path.lineTo(w, topType==='straight' ? 0 : (topType==='perforated' ? edgeSize*0.3 : edgeSize));

  // right side straight down
  path.lineTo(w, h - (bottomType==='straight'?0:edgeSize));

  // --- bottom edge (right to left) ---
  if(bottomType === 'zigzag'){
    for(let i=teeth;i>=0;i--){
      const x = i*step;
      const y = h - ((i % 2 === 0) ? 0 : edgeSize);
      path.lineTo(x, y);
    }
  } else if(bottomType === 'perforated'){
    path.lineTo(w, h); path.lineTo(0, h); path.lineTo(0, h-edgeSize*0.3);
  } else if(bottomType === 'torn'){
    const segs = Math.max(10, Math.round(w/18));
    for(let i=0;i<=segs;i++){
      const x = w - (w/segs)*i;
      const y = h - rand()*edgeSize*0.9;
      path.lineTo(x, y);
    }
  } else {
    path.lineTo(w,h); path.lineTo(0,h);
  }

  path.closePath();
  return path;
}

function drawPerforationDots(c, w, h, topType, bottomType, edgeSize, rand){
  if(topType !== 'perforated' && bottomType !== 'perforated') return;
  c.save();
  c.fillStyle = state_bg();
  const n = Math.max(6, Math.round(w / (edgeSize*1.6)));
  const r = edgeSize*0.22;
  for(let i=0;i<n;i++){
    const x = (w/n)*(i+0.5);
    if(topType==='perforated'){
      c.beginPath(); c.arc(x, edgeSize*0.5, r, 0, Math.PI*2); c.fill();
    }
    if(bottomType==='perforated'){
      c.beginPath(); c.arc(x, h-edgeSize*0.5, r, 0, Math.PI*2); c.fill();
    }
  }
  c.restore();
}
function state_bg(){ return 'rgba(0,0,0,0)'; }

/* ---------- процедурная ч/б обработка фотографии ---------- */
function processPhotoToCanvas(img, targetW, targetH, opts, rand){
  const off = document.createElement('canvas');
  off.width = targetW;
  off.height = targetH;
  const octx = off.getContext('2d');

  // cover-fit
  const ir = img.width / img.height;
  const tr = targetW / targetH;
  let sw, sh, sx, sy;
  if(ir > tr){ sh = img.height; sw = sh*tr; sx = (img.width-sw)/2; sy=0; }
  else { sw = img.width; sh = sw/tr; sx=0; sy = (img.height-sh)/2; }
  octx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);

  const imgData = octx.getImageData(0,0,targetW,targetH);
  const d = imgData.data;
  const contrast = opts.contrast/100;
  const brightness = (opts.brightness-100)*1.4;
  const grain = opts.grain/100;
  const dither = opts.dither;

  for(let i=0;i<d.length;i+=4){
    let lum = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    lum = (lum-128)*contrast + 128 + brightness;
    // noise / grain
    const noise = (rand()-0.5) * 255 * grain * 0.9;
    lum += noise;
    if(dither){
      const threshold = 128 + (rand()-0.5)*90;
      lum = lum > threshold ? 255 : 0;
    }
    lum = Math.max(0, Math.min(255, lum));
    d[i]=d[i+1]=d[i+2]=lum;
  }
  octx.putImageData(imgData,0,0);
  return off;
}

/* ---------- QR matrix via qrcode-generator lib ---------- */
function drawQR(c, text, x, y, size){
  if(!text || !text.trim()) return;
  let qr;
  try{
    qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
  }catch(e){
    // fallback lower error correction / retry typeNumber auto
    try{
      qr = qrcode(4, 'L');
      qr.addData(text);
      qr.make();
    }catch(e2){ return; }
  }
  const count = qr.getModuleCount();
  const cell = size / count;
  c.save();
  c.fillStyle = '#000';
  for(let r=0;r<count;r++){
    for(let col=0; col<count; col++){
      if(qr.isDark(r,col)){
        c.fillRect(x+col*cell, y+r*cell, cell+0.5, cell+0.5);
      }
    }
  }
  c.restore();
}

/* ---------- основной рендер ---------- */
function render(){
  const rand = mulberry32(state.seed);

  const W = state.width;
  const H = state.height;
  canvas.width = W*SCALE;
  canvas.height = H*SCALE;
  canvas.style.width = Math.min(W, 760) + 'px';
  canvas.style.height = (Math.min(W,760) * (H/W)) + 'px';

  ctx.save();
  ctx.scale(SCALE, SCALE);
  ctx.clearRect(0,0,W,H);

  const edgeSize = state.edges.size;
  const path = buildEdgePath(W, H, state.edges.top, state.edges.bottom, edgeSize, rand);

  ctx.save();
  ctx.clip(path);

  // --- paper base ---
  const tint = state.fx.paperTint/100;
  const baseGray = 245 - tint*25;
  const baseR = baseGray, baseG = baseGray - tint*8, baseB = baseGray - tint*20;
  ctx.fillStyle = `rgb(${baseR},${baseG},${baseB})`;
  ctx.fillRect(0,0,W,H);

  // --- content layer (separate canvas so we can apply ink fx only to ink, not paper) ---
  const inkCanvas = document.createElement('canvas');
  inkCanvas.width = W; inkCanvas.height = H;
  const ictx = inkCanvas.getContext('2d');
  ictx.fillStyle = '#111';

  let cursorY = edgeSize + 46;
  const marginX = Math.round(W*0.11);
  const contentW = W - marginX*2;

  // photo block
  if(state.photo.img){
    const photoW = contentW * (state.photo.scale/100);
    const photoH = photoW * 0.78;
    const px = marginX + (contentW-photoW)/2;
    const processed = processPhotoToCanvas(state.photo.img, Math.round(photoW), Math.round(photoH), state.photo, rand);
    ictx.drawImage(processed, px, cursorY);
    cursorY += photoH + 40;
  }

  // text lines
  state.lines.forEach(line=>{
    cursorY = drawTextLine(ictx, line, marginX, contentW, cursorY, rand);
  });

  // QR block
  if(state.qr.enabled){
    cursorY += 10;
    const qrSize = state.qr.size;
    const qx = marginX;
    drawQR(ictx, state.qr.text, qx, cursorY, qrSize);
    cursorY += qrSize + 14;
    if(state.qr.caption){
      ictx.font = `13px 'Courier New', monospace`;
      ictx.textBaseline = 'alphabetic';
      ictx.fillStyle = '#111';
      try{ ictx.letterSpacing = '3px'; }catch(e){}
      ictx.fillText(state.qr.caption.toUpperCase(), qx, cursorY);
      try{ ictx.letterSpacing = '0px'; }catch(e){}
      cursorY += 20;
    }
  }

  cursorY += edgeSize + 30;
  // if content overflows receipt, that's fine — user controls height slider

  // --- apply ink effects to ink layer ---
  applyInkEffects(ictx, inkCanvas, W, H, state.fx, rand);

  // composite ink onto paper
  ctx.drawImage(inkCanvas, 0, 0);

  // --- paper fx on top (grain, thermal burn, crumple, tint vignette) ---
  applyPaperEffects(ctx, W, H, state.fx, rand);

  ctx.restore(); // remove clip

  // perforation dots (need to be outside clip visually at the notch, draw as white punch using destination-out within clip region border)
  ctx.save();
  ctx.clip(path);
  drawPerforationPunches(ctx, W, H, state.edges, rand);
  ctx.restore();

  // subtle edge outline for readability on dark bg (very light, stays 2-tone overall)
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke(path);
  ctx.restore();

  ctx.restore();
}

function drawTextLine(c, line, marginX, contentW, y, rand){
  const centered = line.type === 'title';
  let font, color='#111', letterSpacing='1px', sizeStep;
  switch(line.type){
    case 'title':   font = `bold 30px 'Courier New', monospace`; sizeStep=42; letterSpacing='1px'; break;
    case 'bold':    font = `bold 20px 'Courier New', monospace`; sizeStep=30; letterSpacing='1px'; break;
    case 'normal':  font = `20px 'Courier New', monospace`; sizeStep=30; letterSpacing='2px'; break;
    case 'small':   font = `15px 'Courier New', monospace`; sizeStep=24; color='#333'; letterSpacing='1.5px'; break;
    case 'divider': {
      c.save();
      c.strokeStyle = '#111';
      c.lineWidth = 1.6;
      c.setLineDash([6,6]);
      c.beginPath();
      c.moveTo(marginX, y);
      c.lineTo(marginX+contentW, y);
      c.stroke();
      c.restore();
      return y + 26;
    }
    case 'spacer': return y + 18;
    default: font = `20px monospace`; sizeStep=30;
  }

  c.font = font;
  c.fillStyle = color;
  c.textBaseline = 'alphabetic';
  try{ c.letterSpacing = letterSpacing; }catch(e){}

  const text = (line.text||'').toUpperCase();
  // word-wrap
  const words = text.split(' ');
  let lineBuf = '';
  const wrapped = [];
  words.forEach(w=>{
    const test = lineBuf ? lineBuf+' '+w : w;
    if(c.measureText(test).width > contentW && lineBuf){
      wrapped.push(lineBuf);
      lineBuf = w;
    } else {
      lineBuf = test;
    }
  });
  if(lineBuf) wrapped.push(lineBuf);

  wrapped.forEach(wline=>{
    if(centered){
      const tw = c.measureText(wline).width;
      c.fillText(wline, marginX + (contentW-tw)/2, y);
    } else {
      c.fillText(wline, marginX, y);
    }
    y += sizeStep;
  });

  try{ c.letterSpacing = '0px'; }catch(e){}
  return y + 6;
}

/* ---------- ink-only effects: bleed, fade, (applied to ink layer before compositing) ---------- */
function applyInkEffects(ictx, inkCanvas, W, H, fx, rand){
  // BLEED: blur + slight downward smear
  if(fx.inkBleed > 0){
    const amt = fx.inkBleed/100;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const tctx = tmp.getContext('2d');
    tctx.filter = `blur(${(amt*3.2).toFixed(2)}px)`;
    tctx.drawImage(inkCanvas, 0, 0);
    tctx.filter = 'none';
    tctx.globalAlpha = amt*0.55;
    tctx.drawImage(inkCanvas, 0, amt*9);
    tctx.globalAlpha = 1;
    ictx.clearRect(0,0,W,H);
    ictx.drawImage(tmp,0,0);
  }

  // FADE: erase random patches (more toward edges)
  if(fx.inkFade > 0){
    const amt = fx.inkFade/100;
    ictx.save();
    ictx.globalCompositeOperation = 'destination-out';
    const blobs = Math.round(amt*40);
    for(let i=0;i<blobs;i++){
      const edgeBias = rand() < 0.6;
      const x = edgeBias ? (rand()<0.5 ? rand()*W*0.25 : W - rand()*W*0.25) : rand()*W;
      const y = rand()*H;
      const r = 20 + rand()*90*amt + 20;
      const grad = ictx.createRadialGradient(x,y,0,x,y,r);
      grad.addColorStop(0, `rgba(255,255,255,${0.5*amt+0.15})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ictx.fillStyle = grad;
      ictx.beginPath();
      ictx.arc(x,y,r,0,Math.PI*2);
      ictx.fill();
    }
    ictx.restore();
  }
}

/* ---------- paper-level effects: grain, tint vignette, thermal burn, crumple ---------- */
function applyPaperEffects(ctx, W, H, fx, rand){

  // THERMAL BURN — dark heat blotches (multiply)
  if(fx.thermalBurn > 0){
    const amt = fx.thermalBurn/100;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    const blobs = Math.round(4 + amt*14);
    for(let i=0;i<blobs;i++){
      const x = rand()*W, y = rand()*H;
      const r = 40 + rand()*160*amt + 30;
      const grad = ctx.createRadialGradient(x,y,0,x,y,r);
      const dark = 40 + rand()*60;
      grad.addColorStop(0, `rgba(${dark},${dark-10},${dark-18},${0.55*amt+0.1})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x,y,r,0,Math.PI*2);
      ctx.fill();
    }
    ctx.restore();
  }

  // CRUMPLE — crease highlight/shadow pairs
  if(fx.crumple > 0){
    const amt = fx.crumple/100;
    ctx.save();
    const creases = Math.round(3 + amt*14);
    for(let i=0;i<creases;i++){
      const horizontal = rand() < 0.5;
      const pos = rand();
      const thickness = 2 + rand()*3;
      ctx.save();
      ctx.translate(W/2, H/2);
      ctx.rotate((rand()-0.5)*0.5);
      ctx.translate(-W/2,-H/2);

      const x1 = horizontal ? 0 : W*pos + (rand()-0.5)*60;
      const y1 = horizontal ? H*pos + (rand()-0.5)*60 : 0;
      const x2 = horizontal ? W : x1 + (rand()-0.5)*80;
      const y2 = horizontal ? y1 + (rand()-0.5)*80 : H;

      ctx.strokeStyle = `rgba(0,0,0,${0.10*amt+0.03})`;
      ctx.lineWidth = thickness;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();

      ctx.strokeStyle = `rgba(255,255,255,${0.22*amt+0.05})`;
      ctx.lineWidth = thickness*0.6;
      ctx.beginPath();
      ctx.moveTo(x1 + (horizontal?0:2), y1 + (horizontal?2:0));
      ctx.lineTo(x2 + (horizontal?0:2), y2 + (horizontal?2:0));
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // PAPER GRAIN — fine noise speckle
  if(fx.paperGrain > 0){
    const amt = fx.paperGrain/100;
    const density = Math.round(W*H*0.09*amt);
    ctx.save();
    ctx.globalAlpha = 1;
    for(let i=0;i<density;i++){
      const x = rand()*W, y = rand()*H;
      const v = rand();
      ctx.fillStyle = v>0.5 ? `rgba(0,0,0,${0.10*amt})` : `rgba(255,255,255,${0.10*amt})`;
      ctx.fillRect(x,y,1,1);
    }
    ctx.restore();
  }

  // subtle vignette for tint ageing
  if(fx.paperTint > 0){
    const amt = fx.paperTint/100;
    const grad = ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.2, W/2,H/2, Math.max(W,H)*0.75);
    grad.addColorStop(0,'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(90,70,50,${0.18*amt})`);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,W,H);
    ctx.restore();
  }
}

function drawPerforationPunches(ctx, W, H, edges, rand){
  const { top, bottom, size } = edges;
  if(top !== 'perforated' && bottom !== 'perforated') return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const n = Math.max(6, Math.round(W / (size*1.6)));
  const r = size*0.22;
  for(let i=0;i<n;i++){
    const x = (W/n)*(i+0.5);
    if(top==='perforated'){
      ctx.beginPath(); ctx.arc(x, size*0.5, r, 0, Math.PI*2); ctx.fill();
    }
    if(bottom==='perforated'){
      ctx.beginPath(); ctx.arc(x, H-size*0.5, r, 0, Math.PI*2); ctx.fill();
    }
  }
  ctx.restore();
}

/* ---------- export ---------- */
function exportPNG(){
  canvas.toBlob(blob=>{
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chek.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }, 'image/png');
}

/* ---------- init ---------- */
render();
window.addEventListener('resize', scheduleRender);
