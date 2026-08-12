export function paintClipWave(ctx, displayList) {
  // displayList contains rendering context metrics and peak data
  const { Hpx, cvw, res, n, pk, startIn, startOffset, x0abs, dpr, timeToXMap } = displayList;
  
  ctx.save();
  ctx.scale(dpr, dpr);
  const mid = Hpx / 2;
  const amp = Hpx * 1.2;
  
  ctx.strokeStyle = 'rgba(190,230,255,.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  
  for (let cx = 0; cx < cvw; cx++) {
    const t1 = timeToXMap[cx]; // precalculated source time
    const b = Math.floor(t1 * res);
    if (b < 0 || b >= n) continue;
    
    let mn = pk[b * 2];
    let mx = pk[b * 2 + 1];
    
    const t2 = timeToXMap[cx + 1] || t1; // Precalculated source time for next pixel
    const b2 = Math.min(n - 1, Math.floor(t2 * res));
    
    for (let k = b + 1; k <= b2; k++) {
      if (pk[k * 2] < mn) mn = pk[k * 2];
      if (pk[k * 2 + 1] > mx) mx = pk[k * 2 + 1];
    }
    
    ctx.moveTo(cx + 0.5, mid - mx * amp);
    ctx.lineTo(cx + 0.5, mid - mn * amp);
  }
  
  ctx.stroke();
  ctx.restore();
}