// 비눗방울 그리기: 진짜 비눗방울처럼 거의 투명하고, 가장자리에 무지개빛 얇은 막이 빙글빙글 돌고,
// 왼쪽 위에서 빛이 비친 반짝임이 있다.
//
// 성능: 크기별(기기 px 반지름 버킷) 스프라이트를 처음 한 번만 그려 두고, 매 프레임엔 drawImage 만 한다.
//   - films: 무늬가 다른 무지개 막 두 겹을 한 장으로 합친 것 (방울마다 무늬 종류와 도는 속도가 달라
//            색이 테두리를 따라 흐르듯 바뀐다)
//   - gloss: 몸통의 은은한 빛 + 테두리 + 반짝임 (빛 방향은 고정이라 돌리지 않는다 → 빠르게 그려진다)

import { TAU, clamp } from '../../core/math.js';

/** 스프라이트 반지름 버킷 (기기 px) */
export const BUCKETS = Object.freeze([20, 40, 80, 150, 260]);

/** 기기 px 반지름에 맞는 버킷 번호: 조금 큰 쪽을 골라 줄여 그린다 (흐려지지 않게) */
export function pickBucket(rDevice) {
  for (let i = 0; i < BUCKETS.length; i++) if (BUCKETS[i] >= rDevice * 0.85) return i;
  return BUCKETS.length - 1;
}

// 얇은 비누막 간섭색 (두께 순서: 은빛 → 노랑 → 주황 → 자홍 → 파랑 → 하늘 → 초록 → 연두 → 분홍)
const FILM_A = ['#ffffff', '#fff0a6', '#ffc25e', '#ff6fae', '#b06cff', '#5a7dff', '#4fd2ff', '#5affc0', '#d9ff6e', '#ff9bd6'];
const FILM_B = ['#ffe3f6', '#ff8ad0', '#9f7bff', '#58b8ff', '#63ffd9', '#f6ff8a', '#ffb36b', '#ff7aa8'];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function paletteAt(pal, u) {
  const n = pal.length;
  const x = (((u % 1) + 1) % 1) * n;
  const i = Math.floor(x);
  const f = x - i;
  const a = hexToRgb(pal[i % n]);
  const b = hexToRgb(pal[(i + 1) % n]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** 무지개 막 스프라이트: 각도에 따라 색이 바뀌는 고리 (가운데는 아주 옅게) */
function makeFilm(R, S, pal, cycles, seed, strength) {
  const c = makeCanvas(S);
  const g = c.getContext('2d');
  const cx = S / 2;
  const steps = 72;
  const fillAngular = () => {
    if (typeof g.createConicGradient === 'function') {
      const grad = g.createConicGradient(seed, cx, cx);
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const th = u * TAU;
        // 띠 너비가 고르지 않게 살짝 일그러뜨린다 (진짜 비누막처럼)
        const w = u * cycles + 0.12 * Math.sin(th * 3 + seed * 5) + 0.06 * Math.sin(th * 7 + seed);
        const [r, gg, b] = paletteAt(pal, w);
        const a = strength * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(th * 2 + seed * 3)));
        grad.addColorStop(u, `rgba(${r | 0},${gg | 0},${b | 0},${a.toFixed(3)})`);
      }
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
    } else {
      // 오래된 브라우저: 부채꼴을 겹쳐 그린다
      const n = 96;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        const th = u * TAU + seed;
        const [r, gg, b] = paletteAt(pal, u * cycles);
        g.fillStyle = `rgba(${r | 0},${gg | 0},${b | 0},${strength.toFixed(3)})`;
        g.beginPath();
        g.moveTo(cx, cx);
        g.arc(cx, cx, R * 1.05, th, th + TAU / n + 0.02);
        g.closePath();
        g.fill();
      }
    }
  };
  fillAngular();
  // 가장자리 띠만 남기는 마스크 (얇은 막은 가장자리에서 빛을 더 많이 반사한다)
  g.globalCompositeOperation = 'destination-in';
  const m = g.createRadialGradient(cx, cx, 0, cx, cx, R);
  // 가운데는 거의 투명하게 (색 띠가 가운데로 모이면 부채꼴 줄무늬처럼 보인다)
  m.addColorStop(0, 'rgba(0,0,0,0)');
  m.addColorStop(0.55, 'rgba(0,0,0,0)');
  m.addColorStop(0.74, 'rgba(0,0,0,0.12)');
  m.addColorStop(0.86, 'rgba(0,0,0,0.5)');
  m.addColorStop(0.95, 'rgba(0,0,0,0.95)');
  m.addColorStop(0.985, 'rgba(0,0,0,0.85)');
  m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m;
  g.fillRect(0, 0, S, S);
  return c;
}

/** 몸통 빛 + 테두리 + 반짝임 (빛은 왼쪽 위에서) */
function makeGloss(R, S) {
  const c = makeCanvas(S);
  const g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  // 몸통: 가운데는 투명, 가장자리로 갈수록 은은하게 (프레넬 반사)
  const body = g.createRadialGradient(-R * 0.15, -R * 0.15, R * 0.1, 0, 0, R);
  body.addColorStop(0, 'rgba(255,255,255,0)');
  body.addColorStop(0.6, 'rgba(235,248,255,0.03)');
  body.addColorStop(0.86, 'rgba(210,235,255,0.1)');
  body.addColorStop(1, 'rgba(255,255,255,0.28)');
  g.fillStyle = body;
  g.beginPath();
  g.arc(0, 0, R, 0, TAU);
  g.fill();
  // 아래쪽에 비친 바닥 빛 (희미한 반사)
  const low = g.createRadialGradient(R * 0.1, R * 0.75, 0, R * 0.1, R * 0.75, R * 0.6);
  low.addColorStop(0, 'rgba(255,255,255,0.12)');
  low.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = low;
  g.beginPath();
  g.arc(0, 0, R * 0.98, 0, TAU);
  g.fill();
  // 테두리: 밝은 선 + 어떤 배경에서도 보이게 아주 옅은 남색 선
  g.lineWidth = Math.max(1, R * 0.022);
  g.strokeStyle = 'rgba(40,70,130,0.22)';
  g.beginPath();
  g.arc(0, 0, R * 0.995, 0, TAU);
  g.stroke();
  g.lineWidth = Math.max(0.8, R * 0.018);
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.beginPath();
  g.arc(0, 0, R * 0.975, 0, TAU);
  g.stroke();
  g.lineCap = 'round';
  // 왼쪽 위 가장자리를 따라 휘어진 창문 반사
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = R * 0.075;
  g.beginPath();
  g.arc(0, 0, R * 0.8, Math.PI * 1.08, Math.PI * 1.36);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.45)';
  g.lineWidth = R * 0.05;
  g.beginPath();
  g.arc(0, 0, R * 0.8, Math.PI * 1.42, Math.PI * 1.5);
  g.stroke();
  // 큰 반짝임 (부드러운 타원)
  g.save();
  g.translate(-R * 0.4, -R * 0.42);
  g.rotate(-Math.PI / 4);
  g.scale(1, 0.5);
  const hl = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.28);
  hl.addColorStop(0, 'rgba(255,255,255,0.95)');
  hl.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hl;
  g.beginPath();
  g.arc(0, 0, R * 0.28, 0, TAU);
  g.fill();
  g.restore();
  // 작고 또렷한 점 반짝임
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath();
  g.arc(-R * 0.16, -R * 0.62, Math.max(0.8, R * 0.05), 0, TAU);
  g.fill();
  // 오른쪽 아래 작은 두 번째 반짝임 + 가장자리 반사
  g.save();
  g.translate(R * 0.45, R * 0.5);
  g.rotate(-Math.PI / 4);
  g.scale(1, 0.55);
  const h2 = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.14);
  h2.addColorStop(0, 'rgba(255,255,255,0.65)');
  h2.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = h2;
  g.beginPath();
  g.arc(0, 0, R * 0.14, 0, TAU);
  g.fill();
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = R * 0.035;
  g.beginPath();
  g.arc(0, 0, R * 0.84, Math.PI * 0.12, Math.PI * 0.38);
  g.stroke();
  return c;
}

/** 장난감 비눗방울 막대 고리: 파스텔 무지개 테 (가운데는 비어 있다) */
function makeRing(R, S) {
  const c = makeCanvas(S);
  const g = c.getContext('2d');
  const cx = S / 2;
  const lw = R * 0.1;
  const rr = R - lw / 2 - 1;
  let stroke = 'rgba(255,255,255,0.9)';
  if (typeof g.createConicGradient === 'function') {
    const grad = g.createConicGradient(0, cx, cx);
    const ring = ['#ff8fc8', '#ffd36e', '#a8f07a', '#6fd8ff', '#b68cff', '#ff8fc8'];
    ring.forEach((col, i) => grad.addColorStop(i / (ring.length - 1), col));
    stroke = grad;
  }
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(42,35,80,0.18)';
  g.lineWidth = lw + 3;
  g.beginPath();
  g.arc(cx, cx, rr, 0, TAU);
  g.stroke();
  g.strokeStyle = stroke;
  g.lineWidth = lw;
  g.beginPath();
  g.arc(cx, cx, rr, 0, TAU);
  g.stroke();
  // 위쪽에 반짝이는 하이라이트
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = lw * 0.35;
  g.beginPath();
  g.arc(cx, cx, rr - lw * 0.15, Math.PI * 1.1, Math.PI * 1.45);
  g.stroke();
  return c;
}

/** 무지개 막 두 겹(서로 다른 무늬)을 한 장으로 합친다. 변형마다 두 겹의 엇갈린 각도가 달라 방울마다 무늬가 다르다. */
function makeFilm2(R, S, variant) {
  const a = makeFilm(R, S, FILM_A, 2, 0.7 + variant * 1.9, 1);
  const b = makeFilm(R, S, FILM_B, 3, 2.3 + variant * 0.8, 0.7);
  const c = makeCanvas(S);
  const g = c.getContext('2d');
  g.drawImage(a, 0, 0);
  g.translate(S / 2, S / 2);
  g.rotate(variant * 2.1 + 0.9);
  g.globalAlpha = 0.85;
  g.drawImage(b, -S / 2, -S / 2);
  return c;
}

/** 무지개 막 무늬 종류 수 */
export const FILM_VARIANTS = 3;

function buildSet(R) {
  const pad = Math.ceil(R * 0.06) + 2;
  const S = 2 * (R + pad);
  return { R, S, films: new Array(FILM_VARIANTS).fill(null), gloss: makeGloss(R, S), ring: null };
}

/**
 * 말랑 찌그러짐을 가로·세로 배율로 (돌리지 않은 그림은 훨씬 빨리 그려진다).
 * 부딪힌 방향(axis)이 가로에 가까우면 가로로, 세로에 가까우면 세로로 늘어난다. 넓이는 그대로.
 * @returns {number} 가로 배율 (세로는 1/가로)
 */
export function squashX(stretch, axis) {
  const c = Math.cos(axis);
  const s = Math.sin(axis);
  return 1 + (stretch - 1) * (c * c - s * s);
}

/**
 * 손바닥 막대 고리가 보이는 정도를 손마다 갱신한다 (그리기와 따로 떼어 둔 순수 로직).
 *  - 펼친 손이면 1 로, 아니면 0 으로 부드럽게.
 *  - 잠깐 놓친(stale) 손은 그대로 둔다 — 한두 프레임 놓칠 때마다 고리가 움찔 작아지지 않게.
 *  - 손이 사라지면 마지막 자리에서 스르르 사라진 뒤 지운다.
 * @param {Map<number, {v:number, x:number, y:number, size:number, gone:boolean}>} rings hand.id → 고리 상태
 */
export function stepWandRings(rings, hands, dt, rate = 10) {
  const k = 1 - Math.exp(-rate * dt);
  for (const r of rings.values()) r.gone = true;
  for (const h of hands) {
    let r = rings.get(h.id);
    if (!r) {
      r = { v: 0, x: h.palm.x, y: h.palm.y, size: h.size, gone: false };
      rings.set(h.id, r);
    }
    r.gone = false;
    if (h.stale) continue;
    r.x = h.palm.x;
    r.y = h.palm.y;
    r.size = h.size;
    r.v += ((h.pose === 'open' ? 1 : 0) - r.v) * k;
  }
  for (const [id, r] of rings) {
    if (!r.gone) continue;
    r.v -= r.v * k;
    if (r.v < 0.01) rings.delete(id);
  }
  return rings;
}

export class BubbleArt {
  constructor() {
    this.sets = new Array(BUCKETS.length).fill(null);
  }

  _set(i) {
    if (!this.sets[i]) this.sets[i] = buildSet(BUCKETS[i]);
    return this.sets[i];
  }

  _film(set, v) {
    if (!set.films[v]) set.films[v] = makeFilm2(set.R, set.S, v);
    return set.films[v];
  }

  /** 자주 쓰는 크기는 미리 만들어 둔다 (첫 방울이 나올 때 멈칫하지 않게) */
  warm(dpr = 1) {
    for (const r of [30, 60, 110]) {
      const set = this._set(pickBucket(r * dpr));
      for (let v = 0; v < FILM_VARIANTS; v++) this._film(set, v);
    }
  }

  /**
   * 방울 하나 그리기: 빙글 도는 무지개 막 한 장 + 돌리지 않는 반짝임 한 장.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} b 방울 (x, y, r, film, hue, phase, breathF, jig, axis, grow?)
   * @param {number} t 시각(초)
   * @param {number} dpr 기기 픽셀 비율
   * @param {number} [alpha=1]
   */
  drawBubble(ctx, b, t, dpr, alpha = 1) {
    if (b.r < 0.5) return;
    const set = this._set(pickBucket(b.r * dpr));
    const film = this._film(set, Math.min(FILM_VARIANTS - 1, Math.floor(b.hue * FILM_VARIANTS)));
    const half = (set.S / 2) * (b.r / set.R);
    const size = half * 2;
    // 숨 쉬듯 살짝 타원(가로↔세로 번갈아) + 부딪히면 말랑, 부푸는 중엔 나오는 쪽으로 길쭉
    const breath = Math.sin(t * b.breathF * TAU * 0.5 + b.phase) * 0.03;
    let sx = 1 + breath + (squashX(1 + b.jig, b.axis) - 1);
    if (b.grow !== undefined && b.grow < 1) sx += squashX(1 + 0.14 * (1 - b.grow), b.axis) - 1;
    sx = clamp(sx, 0.75, 1.33);
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.scale(sx, 1 / sx);
    ctx.globalAlpha = alpha;
    ctx.rotate(b.film);
    ctx.drawImage(film, -half, -half, size, size);
    ctx.rotate(-b.film);
    ctx.drawImage(set.gloss, -half, -half, size, size);
    ctx.restore();
  }

  /** 펼친 손바닥의 비눗방울 막대 고리 (무지개 테에 비누막이 얇게 걸려 있고, 별빛이 고리를 따라 돈다) */
  drawWand(ctx, x, y, r, t, dpr, alpha) {
    if (alpha <= 0.01 || r < 1) return;
    const set = this._set(pickBucket(r * dpr));
    if (!set.ring) set.ring = makeRing(set.R, set.S);
    const half = (set.S / 2) * (r / set.R);
    // 나타날 때 톡 커진다
    const k = 0.6 + 0.4 * alpha;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.globalAlpha = alpha * 0.45;
    ctx.rotate(t * 0.9);
    ctx.drawImage(this._film(set, 0), -half, -half, half * 2, half * 2);
    ctx.rotate(t * 0.4);
    ctx.globalAlpha = alpha * 0.85;
    ctx.drawImage(set.ring, -half, -half, half * 2, half * 2);
    ctx.rotate(-t * 1.3);
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 3; i++) {
      const a = t * 2.2 + (i * TAU) / 3;
      const tw = 0.55 + 0.45 * Math.sin(t * 7 + i * 2);
      ctx.globalAlpha = alpha * tw;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95, Math.max(2, r * 0.08) * tw, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  dispose() {
    this.sets.fill(null);
  }
}
