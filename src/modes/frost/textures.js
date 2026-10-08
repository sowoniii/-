// 입김 그림에 쓰는 그림 재료를 코드로 그려 만든다 (파일 없음). 창 크기가 바뀔 때만 다시 만든다.

import { mulberry32 } from './logic.js';

const TAU = Math.PI * 2;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/**
 * 김 서린 유리의 결: (base 안개색) + 고르지 않은 뿌연 얼룩 + 아주 작은 물방울 수천 개 + 조금 큰 물방울.
 * 화면 CSS px 크기(w×h)로 그리되, 선명하도록 scale 배(기기 픽셀 비율) 크기의 캔버스에 만든다.
 * base 를 주면 바탕을 그 색으로 미리 칠해 둔다 — 매 프레임 화면 전체에 안개색을 한 번 더 칠하지 않아도 된다.
 */
export function makeFrostTexture(w, h, scale = 1, seed = 3, base = null) {
  const cv = canvas(w * scale, h * scale);
  const g = cv.getContext('2d');
  g.scale(cv.width / w, cv.height / h);
  const rng = mulberry32(seed);
  const m = Math.min(w, h);
  if (base) {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
  }

  // 1) 큰 얼룩: 김이 진한 곳, 옅은 곳
  for (let i = 0; i < 28; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = m * (0.12 + rng() * 0.32);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + rng() * 0.1;
    grad.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // 2) 아주 작은 물방울: 그림자 → 몸통 → 반짝임 순서로, 같은 색끼리 한 번에 칠한다 (빠르게)
  const count = Math.round((w * h) / 240);
  const drops = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    drops[i * 3] = rng() * w;
    drops[i * 3 + 1] = rng() * h;
    drops[i * 3 + 2] = 0.45 + Math.pow(rng(), 3) * 2.3;
  }
  const pass = (style, fn) => {
    g.fillStyle = style;
    g.beginPath();
    for (let i = 0; i < count; i++) fn(drops[i * 3], drops[i * 3 + 1], drops[i * 3 + 2]);
    g.fill();
  };
  const dot = (x, y, r) => {
    g.moveTo(x + r, y);
    g.arc(x, y, r, 0, TAU);
  };
  pass('rgba(30,60,85,0.2)', (x, y, r) => dot(x + r * 0.3, y + r * 0.45, r));
  pass('rgba(255,255,255,0.34)', (x, y, r) => dot(x, y, r * 0.92));
  pass('rgba(255,255,255,0.9)', (x, y, r) => {
    if (r > 1.05) dot(x - r * 0.35, y - r * 0.35, r * 0.3);
  });

  // 3) 조금 큰 물방울 (볼록 렌즈처럼 가장자리가 어둡고 반짝임이 있다)
  const big = Math.round(count / 28);
  for (let i = 0; i < big; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 2.2 + Math.pow(rng(), 2) * 3.8;
    const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(0.7, 'rgba(235,245,255,0.16)');
    grad.addColorStop(1, 'rgba(25,55,85,0.38)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath();
    g.arc(x - r * 0.35, y - r * 0.38, r * 0.28, 0, TAU);
    g.fill();
  }
  return cv;
}

/** 입김 알갱이: 가운데가 하얗고 가장자리로 사라지는 동그라미 */
export function makePuffSprite(size = 96) {
  const cv = canvas(size, size);
  const g = cv.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.35, 'rgba(240,248,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return cv;
}

/**
 * 흘러내리는 물방울 모양 (아래가 둥글고 위로 꼬리). 머리 반지름 R 기준으로 그린다.
 * @returns {{canvas:HTMLCanvasElement, R:number, cx:number, cy:number}} cx, cy = 머리 중심
 */
export function makeDripSprite(R = 24) {
  const w = Math.ceil(R * 2 + 6);
  const h = Math.ceil(R * 3.3 + 6);
  const cv = canvas(w, h);
  const g = cv.getContext('2d');
  const cx = w / 2;
  const cy = h - R - 3;
  const shape = () => {
    g.beginPath();
    g.moveTo(cx + R, cy);
    g.arc(cx, cy, R, 0, Math.PI, false);
    g.quadraticCurveTo(cx - R * 0.95, cy - R * 1.15, cx, cy - R * 2.2);
    g.quadraticCurveTo(cx + R * 0.95, cy - R * 1.15, cx + R, cy);
    g.closePath();
  };
  // 몸통: 가운데는 맑고 가장자리는 어둡게 (빛이 굴절되는 느낌)
  const grad = g.createRadialGradient(cx - R * 0.25, cy - R * 0.3, 0, cx, cy - R * 0.2, R * 1.35);
  grad.addColorStop(0, 'rgba(255,255,255,0.38)');
  grad.addColorStop(0.5, 'rgba(215,238,252,0.2)');
  grad.addColorStop(0.82, 'rgba(40,75,105,0.38)');
  grad.addColorStop(1, 'rgba(15,35,55,0.6)');
  shape();
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = R * 0.09;
  g.strokeStyle = 'rgba(15,35,55,0.35)';
  g.stroke();
  // 반짝임
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath();
  g.ellipse(cx - R * 0.38, cy - R * 0.32, R * 0.26, R * 0.18, -0.6, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.beginPath();
  g.arc(cx + R * 0.42, cy + R * 0.45, R * 0.13, 0, TAU);
  g.fill();
  return { canvas: cv, R, cx, cy };
}
