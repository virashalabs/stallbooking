// Finds stall boxes drawn on a layout image (light, boxed-in rectangles of a common size),
// numbers them left→right, top→bottom, and marks the two ends of every block as corners.
// Pure function over RGBA pixels so it runs in the browser (canvas) and in Node (tests).

/**
 * @param {Uint8ClampedArray|Uint8Array} px RGBA pixels
 * @param {number} W width
 * @param {number} H height
 * @returns {{x:number,y:number,w:number,h:number,row:number,block:number,is_corner:boolean}[]} boxes in % of the image
 */
export function detectStalls(px, W, H) {
  // 1. light, unsaturated pixels = possible stall interior; everything else is a wall
  const light = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = px[p], g = px[p + 1], b = px[p + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    light[i] = mn > 205 && mx - mn < 28 ? 1 : 0;
  }

  // 2. connected regions of light pixels
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const comps = [];
  for (let s = 0; s < W * H; s++) {
    if (!light[s] || seen[s]) continue;
    let top = 0, n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top], x = i % W, y = (i - x) / W;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && light[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < W - 1 && light[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && light[i - W] && !seen[i - W]) { seen[i - W] = 1; stack[top++] = i - W; }
      if (y < H - 1 && light[i + W] && !seen[i + W]) { seen[i + W] = 1; stack[top++] = i + W; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    comps.push({ x: x0, y: y0, w, h, n });
  }

  // 3. keep box-like regions: not tiny, not huge, mostly filled, sensible shape
  const minSide = Math.max(8, Math.min(W, H) * 0.04);
  const cand = comps.filter(c =>
    c.w >= minSide && c.h >= minSide && c.w * c.h < W * H * 0.12 &&
    c.n / (c.w * c.h) > 0.55 && c.w / c.h < 4 && c.h / c.w < 4);
  if (!cand.length) return [];

  // 4. stalls share one size: take the largest group of similar-sized boxes
  const similar = (a, b) => Math.abs(a.w - b.w) <= 0.25 * Math.max(a.w, b.w) && Math.abs(a.h - b.h) <= 0.25 * Math.max(a.h, b.h);
  let best = [];
  for (const c of cand) {
    const g = cand.filter(o => similar(c, o));
    if (g.length > best.length || (g.length === best.length && g.reduce((t, o) => t + o.n, 0) > best.reduce((t, o) => t + o.n, 0))) best = g;
  }
  if (best.length < 2) return [];

  // 5. rows (top→bottom), then left→right; a wide gap starts a new block
  const medW = median(best.map(b => b.w)), medH = median(best.map(b => b.h));
  best.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const rows = [];
  for (const b of best) {
    const cy = b.y + b.h / 2;
    const row = rows.find(r => Math.abs(r.cy - cy) < medH * 0.5);
    if (row) row.items.push(b); else rows.push({ cy, items: [b] });
  }
  const out = [];
  let block = -1;
  rows.forEach((r, ri) => {
    r.items.sort((a, b) => a.x - b.x);
    r.items.forEach((b, i) => {
      const prev = r.items[i - 1], next = r.items[i + 1];
      const gapBefore = prev ? b.x - (prev.x + prev.w) : Infinity;
      const gapAfter = next ? next.x - (b.x + b.w) : Infinity;
      const brk = medW * 0.35;
      if (gapBefore > brk) block++;
      // grow a little so the box covers the stall's drawn border too
      const pad = Math.max(1, Math.round(Math.min(medW, medH) * 0.02));
      const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
      out.push({
        x: x / W * 100, y: y / H * 100,
        w: Math.min(W - x, b.w + pad * 2) / W * 100, h: Math.min(H - y, b.h + pad * 2) / H * 100,
        row: ri, block, is_corner: gapBefore > brk || gapAfter > brk,
      });
    });
  });
  return out;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Browser helper: load an image URL and detect stalls on it. */
export async function detectStallsFromUrl(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.min(1, 1400 / img.naturalWidth);
  const W = Math.max(1, Math.round(img.naturalWidth * scale)), H = Math.max(1, Math.round(img.naturalHeight * scale));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  return detectStalls(ctx.getImageData(0, 0, W, H).data, W, H);
}
