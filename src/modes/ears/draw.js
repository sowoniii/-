// 동물 귀 그리기 (Canvas 2D). 그림 파일 없이 곡선으로만 그린다.
//
// 귀 하나 = 뿌리에서 끝으로 뻗은 중심선(휘어질 수 있음) + 양옆 폭(profile).
// 뿌리 쪽은 살짝 투명해지며 머리카락 속으로 스며들게 해서, 머리 위에 '붙어 있는' 느낌을 준다.

const N = 26; // 중심선 점 개수
const S_START = -0.14; // 뿌리 아래로 조금 더 (머리카락 속에 묻히는 부분)
const FADE_U = (0 - S_START) / (1 - S_START); // 그라데이션에서 뿌리 투명 구간이 끝나는 위치

// 매 프레임 새 배열을 만들지 않도록 재사용하는 작업 공간
const cx = new Float32Array(N + 1);
const cy = new Float32Array(N + 1);
const nx = new Float32Array(N + 1);
const ny = new Float32Array(N + 1);
const sv = new Float32Array(N + 1);
const lx = new Float32Array(N + 1);
const ly = new Float32Array(N + 1);
const rx = new Float32Array(N + 1);
const ry = new Float32Array(N + 1);

const TAU = Math.PI * 2;
export const FONT = "'Jua', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', system-ui, sans-serif";

// '#rrggbb' → 'rgba(r,g,b,a)' (자주 쓰는 값은 저장해 둔다)
const rgbaCache = new Map();
export function rgba(hex, a) {
  const key = hex + a;
  let v = rgbaCache.get(key);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    rgbaCache.set(key, v);
  }
  return v;
}

/**
 * 귀 중심선을 계산한다.
 * @param {number} bx, by 뿌리 위치
 * @param {number} psi 뿌리 방향 각도 (0 = 위, 시계 방향 +)
 * @param {number} bend 끝까지 더 휘는 각도
 * @param {{at:number, angle:number}|null} kink 중간에서 꺾이는 곳 (토끼 한쪽 귀)
 * @param {number} L 길이 px
 */
function centerline(bx, by, psi, bend, kink, L) {
  for (let i = 0; i <= N; i++) sv[i] = S_START + ((1 - S_START) * i) / N;
  // 뿌리(s=0) 위치를 찾고, 그 아래는 곧게, 위는 휘면서 뻗는다
  const angAt = (s) => {
    if (s <= 0) return psi;
    let a = psi + bend * s;
    if (kink) {
      const k = Math.min(1, Math.max(0, (s - kink.at) / 0.14));
      a += kink.angle * k * k * (3 - 2 * k);
    }
    return a;
  };
  let i0 = 0;
  while (i0 < N && sv[i0 + 1] <= 0) i0++;
  // s=0 이 i0 와 i0+1 사이에 있다. 뿌리부터 앞뒤로 적분
  let px = bx;
  let py = by;
  let ps = 0;
  for (let i = i0 + 1; i <= N; i++) {
    const s = sv[i];
    const a = angAt((s + ps) / 2);
    const d = (s - ps) * L;
    px += Math.sin(a) * d;
    py -= Math.cos(a) * d;
    cx[i] = px;
    cy[i] = py;
    ps = s;
  }
  for (let i = i0; i >= 0; i--) {
    const d = sv[i] * L;
    cx[i] = bx + Math.sin(psi) * d;
    cy[i] = by - Math.cos(psi) * d;
  }
  for (let i = 0; i <= N; i++) {
    const a = angAt(sv[i]);
    nx[i] = Math.cos(a);
    ny[i] = Math.sin(a);
  }
}

/** 중심선 양옆으로 폭 w(s) 만큼 벌린 윤곽을 만들고 path 로 그린다. */
function outline(ctx, widthAt) {
  for (let i = 0; i <= N; i++) {
    const w = Math.max(0, widthAt(sv[i]));
    lx[i] = cx[i] - nx[i] * w;
    ly[i] = cy[i] - ny[i] * w;
    rx[i] = cx[i] + nx[i] * w;
    ry[i] = cy[i] + ny[i] * w;
  }
  // 점들 사이를 부드러운 곡선으로 (중간점을 지나는 2차 곡선)
  ctx.beginPath();
  ctx.moveTo(cx[0], cy[0]);
  ctx.lineTo(lx[0], ly[0]);
  for (let i = 1; i <= N; i++) ctx.quadraticCurveTo(lx[i - 1], ly[i - 1], (lx[i - 1] + lx[i]) / 2, (ly[i - 1] + ly[i]) / 2);
  ctx.quadraticCurveTo(lx[N], ly[N], (lx[N] + rx[N]) / 2, (ly[N] + ry[N]) / 2);
  ctx.quadraticCurveTo(rx[N], ry[N], (rx[N] + rx[N - 1]) / 2, (ry[N] + ry[N - 1]) / 2);
  for (let i = N - 1; i >= 1; i--) ctx.quadraticCurveTo(rx[i], ry[i], (rx[i] + rx[i - 1]) / 2, (ry[i] + ry[i - 1]) / 2);
  ctx.lineTo(rx[0], ry[0]);
  ctx.closePath();
}

/**
 * 귀 하나 그리기.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./animals.js').Animal} A
 * @param {{x:number,y:number,side:number,angle:number,widthMul:number,depth:number}} anchor
 * @param {number} S 얼굴 크기 px
 * @param {number} theta 흔들림 각도
 * @param {number} scale 크기 (뾱 애니메이션, 0..1.2)
 * @param {number} stretch 늘어남 (1 = 그대로)
 */
export function drawEar(ctx, A, anchor, S, theta, scale, stretch = 1) {
  if (scale <= 0.01) return;
  const p = A.phys;
  const L = A.length * S * scale * anchor.depth * stretch;
  const hw = A.halfWidth * S * scale * anchor.depth * anchor.widthMul / Math.sqrt(stretch);
  const kink = A.kink && A.kink.side === anchor.side ? { at: A.kink.at, angle: A.kink.angle * anchor.side } : null;
  centerline(anchor.x, anchor.y, anchor.angle + theta * p.rigid, theta * p.bend + anchor.side * (A.curl || 0), kink, L);
  const prof = A.profile;
  const base = prof(0);
  const outerW = (s) => (s >= 0 ? hw * prof(s) : hw * base * Math.sqrt(Math.max(0, 1 - (s / S_START) ** 2)));
  const inn = A.inner;
  const shift = inn.shift || 0;
  const innerW = (s) => {
    if (s >= shift) return s > inn.end ? 0 : inn.k * hw * prof((s - shift) / (inn.end - shift));
    return inn.k * hw * base * Math.sqrt(Math.max(0, 1 - ((s - shift) / (S_START - shift)) ** 2));
  };
  const C = A.colors;
  const x0 = cx[0];
  const y0 = cy[0];
  const x1 = cx[N];
  const y1 = cy[N];

  // 바깥 털 (뿌리 쪽은 투명 → 머리카락 속으로 스며듦)
  const fur = ctx.createLinearGradient(x0, y0, x1, y1);
  fur.addColorStop(0, rgba(C.fur[0], 0));
  fur.addColorStop(FADE_U * 0.9, rgba(C.fur[0], 1));
  fur.addColorStop(0.55, C.fur[1]);
  if (C.tip) {
    fur.addColorStop(0.7, C.fur[2]);
    fur.addColorStop(0.8, C.tip);
    fur.addColorStop(1, C.tip);
  } else {
    fur.addColorStop(1, C.fur[2]);
  }
  outline(ctx, outerW);
  ctx.save();
  ctx.shadowColor = 'rgba(25, 15, 40, 0.3)';
  ctx.shadowBlur = Math.max(2, S * 0.035);
  ctx.shadowOffsetY = S * 0.012;
  ctx.fillStyle = fur;
  ctx.fill();
  ctx.restore();
  const edge = ctx.createLinearGradient(x0, y0, x1, y1);
  edge.addColorStop(0, rgba(C.outline, 0));
  edge.addColorStop(FADE_U * 1.2, rgba(C.outline, 0.75));
  edge.addColorStop(1, rgba(C.outline, 0.85));
  if (C.rim) {
    // 검은 귀는 검은 머리카락 위에서도 보이도록 밝은 테두리
    const rim = ctx.createLinearGradient(x0, y0, x1, y1);
    rim.addColorStop(0, 'rgba(255,255,255,0)');
    rim.addColorStop(FADE_U * 1.4, C.rim);
    rim.addColorStop(1, C.rim);
    ctx.strokeStyle = rim;
    ctx.lineWidth = Math.max(2, S * 0.022 * scale);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.strokeStyle = edge;
  ctx.lineWidth = Math.max(1.2, S * 0.011 * scale);
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 안쪽 귀
  outline(ctx, innerW);
  const ig = ctx.createLinearGradient(x0, y0, x1, y1);
  ig.addColorStop(0, rgba(C.inner[1], 0));
  ig.addColorStop(FADE_U * 1.3, rgba(C.inner[1], 1));
  ig.addColorStop(0.75, C.inner[0]);
  ig.addColorStop(1, C.inner[0]);
  ctx.fillStyle = ig;
  ctx.fill();

  // 안쪽 털 뭉치 (고양이·여우·곰·판다·강아지: 뿌리 쪽에 하얀/밝은 털)
  if (A.tufts) drawTufts(ctx, A, hw, S * scale);

  // 윤기 (왼쪽 위에서 빛이 온다고 보고 왼쪽 가장자리 안쪽에 하얀 줄)
  ctx.beginPath();
  let started = false;
  for (let i = 0; i <= N; i++) {
    const s = sv[i];
    if (s < 0.14 || s > 0.62) continue;
    const w = outerW(s) * 0.72;
    const px = cx[i] - nx[i] * w;
    const py = cy[i] - ny[i] * w;
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = A.id === 'panda' ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.42)';
  ctx.lineWidth = Math.max(1.5, S * 0.016 * scale);
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** 안쪽 귀 뿌리 쪽의 털 몇 가닥 */
function drawTufts(ctx, A, hw, s) {
  const pick = [0.04, 0.15];
  ctx.strokeStyle = rgba(A.colors.tuft, 0.65);
  ctx.lineWidth = Math.max(1.2, s * 0.011);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const side of [-1, 1]) {
    for (let j = 0; j < pick.length; j++) {
      const i = indexAt(pick[j]);
      const k = indexAt(pick[j] + 0.1);
      const w0 = hw * 0.4 * side;
      const w1 = hw * 0.16 * side;
      ctx.moveTo(cx[i] + nx[i] * w0, cy[i] + ny[i] * w0);
      ctx.quadraticCurveTo(cx[k] + nx[k] * w0 * 0.7, cy[k] + ny[k] * w0 * 0.7, cx[k] + nx[k] * w1, cy[k] + ny[k] * w1);
    }
  }
  ctx.stroke();
}

function indexAt(s) {
  const i = Math.round(((s - S_START) / (1 - S_START)) * N);
  return Math.max(0, Math.min(N, i));
}

// ------------------------------------------------------------------ 얼굴 장식

/**
 * 동물 코·수염·이빨·혀. 얼굴 기울기에 맞춰 코 위치에 그린다. 눈은 가리지 않는다.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./animals.js').Animal} A
 * @param {object} face Face
 * @param {number} ang 머리 기울기
 * @param {number} S 얼굴 크기
 * @param {number} k 크기 (뾱 애니메이션)
 * @param {number} t 시각 (혀 흔들기)
 */
export function drawExtras(ctx, A, face, ang, S, k, t) {
  if (k <= 0.02 || !face?.nose) return;
  const nose = face.nose;
  const c = Math.cos(-ang);
  const s = Math.sin(-ang);
  // 화면 점 → 코 기준 머리 좌표
  const local = (p) => ({ x: (p.x - nose.x) * c - (p.y - nose.y) * s, y: (p.x - nose.x) * s + (p.y - nose.y) * c });
  ctx.save();
  ctx.translate(nose.x, nose.y);
  ctx.rotate(ang);
  const u = S * Math.min(1.1, k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (A.extras) {
    case 'cat':
      whiskers(ctx, u, 3, 0.1, 0.42, '#4b3a36');
      catMouth(ctx, u, '#7a4a52');
      blobNose(ctx, u, 0.1, 0.07, ['#ffb0c8', '#ff7aa2'], '#b8506f', true);
      break;
    case 'rabbit': {
      whiskers(ctx, u, 2, 0.09, 0.32, '#8a7480');
      if (face.key?.[13]) teeth(ctx, u, local(face.key[13]));
      blobNose(ctx, u, 0.07, 0.052, ['#ffc2d6', '#ff8fb1'], '#c0607f', true);
      break;
    }
    case 'bear':
      roundNose(ctx, u, 0.16, 0.11, ['#6a4128', '#3a2214']);
      break;
    case 'fox':
      whiskers(ctx, u, 2, 0.08, 0.36, '#3d2418');
      blobNose(ctx, u, 0.085, 0.06, ['#4a4a4a', '#111111'], '#000000', true);
      break;
    case 'dog': {
      const open = face.mouthOpen || 0;
      if (open > 0.18 && face.key?.[14]) tongue(ctx, u, local(face.key[14]), Math.min(1, (open - 0.18) / 0.32), t);
      roundNose(ctx, u, 0.17, 0.115, ['#4a4a4a', '#0d0d0d']);
      break;
    }
    case 'panda':
      roundNose(ctx, u, 0.14, 0.095, ['#3a3a3a', '#050505']);
      break;
    default:
  }
  ctx.restore();
}

function whiskers(ctx, u, count, start, end, color) {
  const ys0 = count === 3 ? [-0.03, 0.005, 0.04] : [-0.012, 0.03];
  const ys1 = count === 3 ? [-0.1, -0.005, 0.09] : [-0.06, 0.06];
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? color : 'rgba(255,255,255,0.8)';
    ctx.lineWidth = Math.max(1, u * (pass ? 0.008 : 0.016));
    ctx.beginPath();
    for (const side of [-1, 1]) {
      for (let j = 0; j < count; j++) {
        const x0 = side * start * u;
        const y0 = ys0[j] * u;
        const x1 = side * end * u;
        const y1 = ys1[j] * u;
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 - 0.025 * u, x1, y1);
      }
    }
    ctx.stroke();
  }
}

function catMouth(ctx, u, color) {
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = Math.max(1.5, u * 0.016);
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(0, 0.025 * u);
    ctx.lineTo(0, 0.05 * u);
    ctx.quadraticCurveTo(-0.012 * u, 0.075 * u, -0.04 * u, 0.068 * u);
    ctx.moveTo(0, 0.05 * u);
    ctx.quadraticCurveTo(0.012 * u, 0.075 * u, 0.04 * u, 0.068 * u);
  };
  path();
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, u * 0.008);
  path();
  ctx.stroke();
}

/** 역삼각형에 가까운 동글동글 코 */
function blobNose(ctx, u, w, h, [c0, c1], line, shine) {
  const W = w * u;
  const H = h * u;
  ctx.beginPath();
  ctx.moveTo(-W / 2, -H * 0.35);
  ctx.bezierCurveTo(-W / 2, -H * 0.75, W / 2, -H * 0.75, W / 2, -H * 0.35);
  ctx.bezierCurveTo(W / 2, H * 0.05, W * 0.15, H * 0.5, 0, H * 0.5);
  ctx.bezierCurveTo(-W * 0.15, H * 0.5, -W / 2, H * 0.05, -W / 2, -H * 0.35);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, -H * 0.6, 0, H * 0.5);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  ctx.fillStyle = g;
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = u * 0.02;
  ctx.shadowOffsetY = u * 0.006;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = line;
  ctx.lineWidth = Math.max(1, u * 0.007);
  ctx.stroke();
  if (shine) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.ellipse(-W * 0.16, -H * 0.3, W * 0.13, H * 0.12, -0.4, 0, TAU);
    ctx.fill();
  }
}

/** 곰·강아지·판다의 동그란 코 */
function roundNose(ctx, u, w, h, [c0, c1]) {
  const W = w * u;
  const H = h * u;
  ctx.beginPath();
  ctx.moveTo(-W / 2, -H * 0.15);
  ctx.bezierCurveTo(-W / 2, -H * 0.62, W / 2, -H * 0.62, W / 2, -H * 0.15);
  ctx.bezierCurveTo(W / 2, H * 0.35, W * 0.2, H * 0.5, 0, H * 0.5);
  ctx.bezierCurveTo(-W * 0.2, H * 0.5, -W / 2, H * 0.35, -W / 2, -H * 0.15);
  ctx.closePath();
  const g = ctx.createRadialGradient(-W * 0.12, -H * 0.25, W * 0.05, 0, 0, W * 0.65);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  ctx.fillStyle = g;
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = u * 0.025;
  ctx.shadowOffsetY = u * 0.008;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath();
  ctx.ellipse(-W * 0.18, -H * 0.22, W * 0.14, H * 0.11, -0.35, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.arc(W * 0.12, -H * 0.3, W * 0.05, 0, TAU);
  ctx.fill();
}

/** 토끼 앞니 두 개: 윗입술 바로 아래 */
function teeth(ctx, u, lip) {
  const w = 0.043 * u;
  const h = 0.062 * u;
  const gap = 0.004 * u;
  const top = lip.y - 0.006 * u;
  for (const side of [-1, 1]) {
    const x = side > 0 ? gap / 2 : -gap / 2 - w;
    const r = w * 0.35;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + w, top);
    ctx.lineTo(x + w, top + h - r);
    ctx.quadraticCurveTo(x + w, top + h, x + w - r, top + h);
    ctx.lineTo(x + r, top + h);
    ctx.quadraticCurveTo(x, top + h, x, top + h - r);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#b9a3a8';
    ctx.lineWidth = Math.max(1, u * 0.006);
    ctx.stroke();
  }
}

/** 강아지 혀: 입을 벌리면 아래로 쏙, 살랑살랑 */
function tongue(ctx, u, lip, k, t) {
  const w = 0.11 * u;
  const L = (0.07 + 0.15 * k) * u;
  ctx.save();
  ctx.translate(lip.x, lip.y - 0.02 * u);
  ctx.rotate(Math.sin(t * 9) * 0.1 * k);
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.lineTo(-w / 2, L - w / 2);
  ctx.arc(0, L - w / 2, w / 2, Math.PI, 0, true);
  ctx.lineTo(w / 2, 0);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, L);
  g.addColorStop(0, '#e2456c');
  g.addColorStop(0.35, '#ff6f91');
  g.addColorStop(1, '#ff8faa');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = '#c23a5e';
  ctx.lineWidth = Math.max(1, u * 0.007);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, 0.02 * u);
  ctx.lineTo(0, L * 0.72);
  ctx.strokeStyle = 'rgba(194,58,94,0.8)';
  ctx.lineWidth = Math.max(1, u * 0.008);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.ellipse(-w * 0.22, L * 0.55, w * 0.08, L * 0.14, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------ 이름표, 별, 입자

/**
 * 동물 이름표 (머리 위에서 뾱 나타났다가 사라진다)
 */
export function drawNameTag(ctx, x, y, text, color, k, alpha, fontPx) {
  if (alpha <= 0.01 || k <= 0.01) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.font = `${Math.round(fontPx)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const w = tw + fontPx * 1.2;
  const h = fontPx * 1.65;
  roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
  ctx.fillStyle = 'rgba(42,35,80,0.18)';
  ctx.save();
  ctx.translate(0, fontPx * 0.18);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#fffdf7';
  ctx.fill();
  ctx.lineWidth = Math.max(3, fontPx * 0.14);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = '#2a2350';
  ctx.fillText(text, 0, fontPx * 0.06);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.closePath();
}

export function starPath(ctx, x, y, r, rot, points = 5, inner = 0.46) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = rot + (i * Math.PI) / points - Math.PI / 2;
    const rr = i % 2 ? r * inner : r;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function heartPath(ctx, x, y, r, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const P = (px, py) => [x + (px * c - py * s) * r, y + (px * s + py * c) * r];
  ctx.beginPath();
  ctx.moveTo(...P(0, 0.9));
  ctx.bezierCurveTo(...P(-1.2, 0.1), ...P(-0.6, -0.9), ...P(0, -0.35));
  ctx.bezierCurveTo(...P(0.6, -0.9), ...P(1.2, 0.1), ...P(0, 0.9));
  ctx.closePath();
}

/** 날아가는 마법 별 (브이한 손 → 머리) */
export function drawMagicStar(ctx, x, y, r, rot) {
  ctx.save();
  ctx.shadowColor = 'rgba(255, 214, 90, 0.9)';
  ctx.shadowBlur = r * 1.2;
  starPath(ctx, x, y, r, rot);
  ctx.fillStyle = '#ffd54f';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(1.5, r * 0.14);
  ctx.strokeStyle = '#fff6c9';
  ctx.stroke();
  starPath(ctx, x, y, r * 0.45, rot);
  ctx.fillStyle = '#fffbe6';
  ctx.fill();
  ctx.restore();
}

/** @param {import('./logic.js').ParticlePool} pool */
export function drawParticles(ctx, pool) {
  if (!pool.count) return;
  ctx.save();
  for (const p of pool.items) {
    if (!p.alive) continue;
    const u = p.age / p.life;
    const fade = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
    ctx.globalAlpha = Math.max(0, fade);
    ctx.fillStyle = p.color;
    switch (p.kind) {
      case 'star':
        starPath(ctx, p.x, p.y, p.size * (1 - 0.3 * u), p.rot);
        ctx.fill();
        break;
      case 'heart':
        heartPath(ctx, p.x, p.y, p.size, p.rot);
        ctx.fill();
        break;
      case 'ring': {
        // 브이를 알아들었을 때 손끝에서 퍼지는 빛 고리
        ctx.globalAlpha = 1 - u;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1.5, p.size * 0.22 * (1 - u));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.25 + u), 0, TAU);
        ctx.stroke();
        break;
      }
      case 'puff': {
        // 변신할 때 '펑' 하는 하얀 연기
        ctx.globalAlpha = 0.6 * (1 - u) * (1 - u);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.5 + u * 0.9), 0, TAU);
        ctx.fill();
        break;
      }
      default:
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - 0.5 * u), 0, TAU);
        ctx.fill();
    }
  }
  ctx.restore();
}
