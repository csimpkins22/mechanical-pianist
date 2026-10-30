// Sheet music: an open score on the music desk and loose pages fallen on the
// floor. The pages are drawn procedurally (aged paper, grand staves, notes,
// beams and bar lines) from a seeded random stream, so every run draws the
// same pages and nothing has to be downloaded.
import * as THREE from 'three';
import { FLOOR_Y } from './Environment';

const PAGE_W = 0.21;
const PAGE_H = 0.297;
const TEX_W = 768;
const TEX_H = Math.round((TEX_W * PAGE_H) / PAGE_W);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function drawPage(seed: number, title: string | null, pageNo: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TEX_W;
  c.height = TEX_H;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  const W = TEX_W;
  const H = TEX_H;

  // paper: warm, uneven, foxed, darker toward the edges
  g.fillStyle = '#e6dbc2';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) {
    const x = r() * W;
    const y = r() * H;
    const rad = 40 + r() * 220;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.03 + r() * 0.05;
    grd.addColorStop(0, `rgba(${150 + r() * 40}, ${115 + r() * 30}, ${70 + r() * 20}, ${a})`);
    grd.addColorStop(1, 'rgba(150, 115, 70, 0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(140, 95, 50, ${0.08 + r() * 0.14})`;
    g.beginPath();
    g.arc(r() * W, r() * H, 1 + r() * 3.5, 0, Math.PI * 2);
    g.fill();
  }
  const edge = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
  edge.addColorStop(0, 'rgba(120, 85, 45, 0)');
  edge.addColorStop(1, 'rgba(120, 85, 45, 0.28)');
  g.fillStyle = edge;
  g.fillRect(0, 0, W, H);

  // engraving
  const ink = 'rgba(28, 22, 17, 0.9)';
  g.strokeStyle = ink;
  g.fillStyle = ink;
  const left = W * 0.09;
  const right = W * 0.93;
  const gap = H * 0.0072; // staff line spacing
  let y = title ? H * 0.15 : H * 0.075;
  if (title) {
    g.textAlign = 'center';
    g.font = `italic ${Math.round(H * 0.03)}px Georgia, 'Times New Roman', serif`;
    g.fillText(title, W / 2, H * 0.075);
    g.font = `${Math.round(H * 0.012)}px Georgia, 'Times New Roman', serif`;
    g.fillText('for piano', W / 2, H * 0.1);
  }
  const systems = title ? 5 : 6;
  const stepY = (H * 0.92 - y) / systems;
  for (let sys = 0; sys < systems; sys++) {
    const top = y + sys * stepY;
    const staves = [top, top + gap * 10];
    g.lineWidth = Math.max(1, gap * 0.13);
    for (const st of staves) {
      for (let l = 0; l < 5; l++) {
        g.beginPath();
        g.moveTo(left, st + l * gap);
        g.lineTo(right, st + l * gap);
        g.stroke();
      }
    }
    // brace and system line
    g.lineWidth = gap * 0.25;
    g.beginPath();
    g.moveTo(left, staves[0]);
    g.lineTo(left, staves[1] + 4 * gap);
    g.stroke();
    g.lineWidth = gap * 0.45;
    g.beginPath();
    g.moveTo(left - gap * 0.9, staves[0]);
    g.quadraticCurveTo(left - gap * 0.2, (staves[0] + staves[1] + 4 * gap) / 2, left - gap * 1.4, (staves[0] + staves[1] + 4 * gap) / 2);
    g.quadraticCurveTo(left - gap * 0.2, (staves[0] + staves[1] + 4 * gap) / 2, left - gap * 0.9, staves[1] + 4 * gap);
    g.stroke();
    // clefs, simplified: a looped stroke for treble, a hook and two dots for bass
    g.lineWidth = gap * 0.28;
    const cx = left + gap * 1.6;
    g.beginPath();
    g.moveTo(cx + gap * 0.3, staves[0] - gap * 1.2);
    g.bezierCurveTo(cx - gap * 1.2, staves[0] + gap, cx + gap * 1.4, staves[0] + gap * 2.6, cx, staves[0] + gap * 3.3);
    g.bezierCurveTo(cx - gap * 1.0, staves[0] + gap * 2.6, cx + gap * 0.3, staves[0] + gap * 1.6, cx + gap * 0.3, staves[0] + gap * 5);
    g.stroke();
    g.beginPath();
    g.arc(cx - gap * 0.1, staves[1] + gap * 1.1, gap * 0.8, Math.PI * 1.1, Math.PI * 0.35, false);
    g.stroke();
    g.beginPath();
    g.arc(cx + gap * 1.3, staves[1] + gap * 0.6, gap * 0.15, 0, Math.PI * 2);
    g.arc(cx + gap * 1.3, staves[1] + gap * 1.6, gap * 0.15, 0, Math.PI * 2);
    g.fill();

    // measures
    const measures = 3 + Math.floor(r() * 2);
    const x0 = left + gap * 4.5;
    const mw = (right - x0) / measures;
    for (let m = 0; m < measures; m++) {
      const mx = x0 + m * mw;
      g.lineWidth = Math.max(1, gap * 0.16);
      g.beginPath();
      g.moveTo(mx + mw, staves[0]);
      g.lineTo(mx + mw, staves[1] + 4 * gap);
      g.stroke();
      for (let s = 0; s < 2; s++) {
        const st = staves[s];
        const n = s === 0 ? 4 + Math.floor(r() * 5) : 2 + Math.floor(r() * 4);
        const xs: number[] = [];
        const ys: number[] = [];
        for (let k = 0; k < n; k++) {
          const nx = mx + mw * (0.12 + (0.78 * k) / Math.max(1, n - 1));
          const pos = Math.floor(r() * 13) - 2; // staff position in half-gaps from the top line
          const ny = st + pos * gap * 0.5;
          xs.push(nx);
          ys.push(ny);
          const chord = s === 1 && r() < 0.5 ? 1 + Math.floor(r() * 2) : 0;
          for (let h = 0; h <= chord; h++) {
            g.save();
            g.translate(nx, ny + h * gap);
            g.rotate(-0.35);
            g.beginPath();
            g.ellipse(0, 0, gap * 0.62, gap * 0.44, 0, 0, Math.PI * 2);
            if (r() < 0.15) {
              g.lineWidth = gap * 0.16;
              g.stroke();
            } else g.fill();
            g.restore();
          }
          // ledger lines
          g.lineWidth = Math.max(1, gap * 0.13);
          for (let p = -2; p >= pos; p -= 2) {
            g.beginPath();
            g.moveTo(nx - gap, st + (p / 2) * gap);
            g.lineTo(nx + gap, st + (p / 2) * gap);
            g.stroke();
          }
          for (let p = 10; p <= pos; p += 2) {
            g.beginPath();
            g.moveTo(nx - gap, st + (p / 2) * gap);
            g.lineTo(nx + gap, st + (p / 2) * gap);
            g.stroke();
          }
        }
        // stems, beamed in pairs or fours
        const up = s === 1;
        g.lineWidth = Math.max(1, gap * 0.12);
        for (let k = 0; k < n; k += 2) {
          const group = Math.min(2 + (r() < 0.3 ? 2 : 0), n - k);
          const ends: [number, number][] = [];
          for (let q = 0; q < group; q++) {
            const sx = xs[k + q] + (up ? gap * 0.55 : -gap * 0.55);
            const sy = ys[k + q];
            const ey = up ? Math.min(...ys.slice(k, k + group)) - gap * 3.3 : Math.max(...ys.slice(k, k + group)) + gap * 3.3;
            g.beginPath();
            g.moveTo(sx, sy);
            g.lineTo(sx, ey);
            g.stroke();
            ends.push([sx, ey]);
          }
          if (group > 1) {
            g.lineWidth = gap * 0.5;
            g.beginPath();
            g.moveTo(ends[0][0], ends[0][1]);
            g.lineTo(ends[ends.length - 1][0], ends[ends.length - 1][1]);
            g.stroke();
            g.lineWidth = Math.max(1, gap * 0.12);
          }
        }
      }
      // dynamics and slurs, now and then
      if (r() < 0.35) {
        g.font = `italic bold ${Math.round(gap * 1.9)}px Georgia, serif`;
        g.textAlign = 'left';
        g.fillText(['p', 'pp', 'mp', 'f'][Math.floor(r() * 4)], mx + mw * 0.15, staves[0] + gap * 7.6);
      }
      if (r() < 0.4) {
        g.lineWidth = gap * 0.18;
        g.beginPath();
        g.moveTo(mx + mw * 0.1, staves[0] - gap * 1.5);
        g.quadraticCurveTo(mx + mw * 0.5, staves[0] - gap * 3.5, mx + mw * 0.9, staves[0] - gap * 1.5);
        g.stroke();
      }
    }
  }
  g.font = `${Math.round(H * 0.012)}px Georgia, serif`;
  g.textAlign = 'center';
  g.fillStyle = 'rgba(28, 22, 17, 0.75)';
  g.fillText(String(pageNo), W / 2, H * 0.965);
  return c;
}

function pageMaterial(canvas: HTMLCanvasElement) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  // old paper reflects well under half the light; the texture carries the colour
  return new THREE.MeshStandardMaterial({ map: tex, color: 0x8a8278, roughness: 0.88, side: THREE.DoubleSide });
}

/** A page as a gently curved sheet: `bend(u, v)` gives the offset along the normal. */
function pageGeometry(bend: (u: number, v: number) => number, segU = 12, segV = 12) {
  const geo = new THREE.PlaneGeometry(PAGE_W, PAGE_H, segU, segV);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / PAGE_W + 0.5;
    const v = p.getY(i) / PAGE_H + 0.5;
    p.setZ(i, bend(u, v));
  }
  geo.computeVertexNormals();
  return geo;
}

export function createSheetMusic(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'SheetMusic';
  const pages = [drawPage(11, 'Nocturne', 1), drawPage(23, null, 2), drawPage(37, null, 3), drawPage(53, null, 4)];
  const mats = pages.map(pageMaterial);

  // the open score on the music desk, leaning back against the upper panel;
  // each page bows away from the spine
  const desk = new THREE.Group();
  desk.position.set(0.02, 0.147, -0.168);
  desk.rotation.x = -0.13;
  for (const side of [-1, 1]) {
    const geo = pageGeometry((u) => {
      const fromSpine = side < 0 ? 1 - u : u;
      return 0.009 * Math.sin(Math.PI * Math.min(1, fromSpine * 1.15)) * (1 - 0.35 * fromSpine);
    });
    const m = new THREE.Mesh(geo, mats[side < 0 ? 0 : 1]);
    m.position.set(side * (PAGE_W / 2 + 0.001), PAGE_H / 2, 0);
    m.rotation.y = -side * 0.05;
    m.castShadow = true;
    m.receiveShadow = true;
    desk.add(m);
  }
  root.add(desk);

  // loose pages on the floor in front of the piano, toward the window
  const r = rng(99);
  const spots: [number, number, number][] = [
    [-0.95, 0.55, 0.4],
    [-0.7, 0.85, -0.6],
    [-1.25, 0.95, 1.2],
    [-0.45, 0.42, 2.6],
    [-1.05, 0.25, -1.3],
    [-0.25, 1.05, 0.9],
    [-1.5, 0.6, 2.1],
  ];
  spots.forEach(([x, z, rot], i) => {
    const curl = 0.004 + r() * 0.01;
    const corner = Math.floor(r() * 4);
    const geo = pageGeometry((u, v) => {
      const cu = corner & 1 ? u : 1 - u;
      const cv = corner & 2 ? v : 1 - v;
      return curl * Math.pow(Math.max(0, cu + cv - 1.1), 2) * 3 + 0.0015 * Math.sin(u * 7 + i) * Math.sin(v * 5);
    }, 8, 10);
    const m = new THREE.Mesh(geo, mats[(i + 2) % mats.length]);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = rot;
    m.position.set(x, FLOOR_Y + 0.0015 + i * 0.0007, z);
    m.receiveShadow = true;
    root.add(m);
  });
  return root;
}
