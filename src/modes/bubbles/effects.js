// 터질 때 효과: 퍼지는 고리, 튀는 물방울, 둥실 떠오르는 글자("뽁!"), 반짝 별.
// 입자 수에 상한이 있어 아무리 많이 터뜨려도 느려지지 않는다. update 는 DOM 없이 테스트할 수 있다.

import { TAU, clamp } from '../../core/math.js';

export const FX_CAP = Object.freeze({ rings: 40, drops: 360, words: 14, stars: 160 });
export const POP_WORDS = Object.freeze(['뽁!', '팡!', '톡!', '퐁!']);
export const FONT = 'Jua, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';
/** 글자가 올라가도 가리지 않을 화면 위쪽 여백 */
const WORD_TOP = 104;
const WORD_COLORS = ['#ff5fa2', '#29b6f6', '#ffa000', '#8e5bff', '#00bfa5', '#ff7043'];
const STAR_COLORS = ['#fff176', '#ffd54f', '#ff8ac0', '#80deea', '#ffffff', '#b39ddb'];

// 별 모양 꼭짓점 (단위 크기, 한 번만 계산)
const STAR = [];
for (let i = 0; i < 10; i++) {
  const a = -Math.PI / 2 + (i * Math.PI) / 5;
  const rr = i % 2 ? 0.45 : 1;
  STAR.push(Math.cos(a) * rr, Math.sin(a) * rr);
}

const easeOutCubic = (p) => 1 - (1 - p) ** 3;
/** 톡 튀어나왔다 자리 잡는 크기 (0→1.25→1) */
const popIn = (p) => (p < 0.18 ? (p / 0.18) * 1.25 : p < 0.32 ? 1.25 - ((p - 0.18) / 0.14) * 0.25 : 1);

export class PopEffects {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.rings = [];
    this.drops = [];
    this.words = [];
    this.stars = [];
    this._lastWord = -1;
    this._color = 0;
    /** 화면 크기 (글자가 화면 밖으로 잘리지 않게) */
    this.width = Infinity;
  }

  _rand(a, b) {
    return a + this.rng() * (b - a);
  }

  _push(arr, cap, o) {
    if (arr.length >= cap) arr.shift();
    arr.push(o);
  }

  get count() {
    return this.rings.length + this.drops.length + this.words.length + this.stars.length;
  }

  /**
   * 방울이 터지는 효과.
   * @param {'poke'|'catch'|'natural'|'fizzle'} kind  poke/catch 는 크게, natural 은 작게, fizzle 은 아주 작게
   */
  pop(x, y, r, kind = 'poke', hue = 0) {
    const big = kind === 'poke' || kind === 'catch';
    if (kind !== 'fizzle') {
      this._push(this.rings, FX_CAP.rings, {
        x,
        y,
        r,
        t: 0,
        dur: big ? 0.36 : 0.26,
        hue,
        alpha: big ? 1 : 0.55,
        flash: big,
        rot: this.rng() * TAU,
        pieces: big ? 7 : 5,
      });
    }
    const n = kind === 'fizzle' ? 4 : big ? clamp(Math.round(r / 4), 10, 22) : 6;
    for (let i = 0; i < n; i++) {
      const a = this.rng() * TAU;
      const sp = r * this._rand(2.2, 5) + 50;
      this._push(this.drops, FX_CAP.drops, {
        x: x + Math.cos(a) * r * 0.85,
        y: y + Math.sin(a) * r * 0.85,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40,
        t: 0,
        life: this._rand(0.35, 0.7),
        size: this._rand(2, 4.2) * (r > 60 ? 1.3 : 1) * (big ? 1 : 0.7),
        hue: (hue + this._rand(-0.08, 0.08) + 1) % 1,
      });
    }
    if (kind === 'poke') {
      let k = Math.floor(this.rng() * POP_WORDS.length);
      if (k === this._lastWord) k = (k + 1) % POP_WORDS.length;
      this._lastWord = k;
      this._word(POP_WORDS[k], x, y - r * 0.35 - 12, clamp(r * 0.75, 36, 68), WORD_COLORS[this._color++ % WORD_COLORS.length], 0.85);
    }
  }

  _word(text, x, y, size, color, dur) {
    // 위쪽 안내 말풍선(약 100px)에 가리지 않게 조금 아래로
    const yy = Math.max(y, WORD_TOP + size * 1.2);
    const half = size * text.length * 0.42;
    const xx = this.width > half * 2 ? clamp(x, half, this.width - half) : x;
    this._push(this.words, FX_CAP.words, { text, x: xx, y: yy, size, color, t: 0, dur, tilt: this._rand(-0.18, 0.18) });
  }

  /** "잡았다!" + 별이 팡 */
  caught(x, y, handSize, n = 1) {
    const text = n > 1 ? `${n}개 잡았다!` : '잡았다!';
    this._word(text, x, y - handSize * 0.55, clamp(handSize * 0.34, 34, 66), '#ffb300', 1.05);
    this.sparkle(x, y, 12, handSize * 0.5);
  }

  /** 반짝 별 퍼지기 */
  sparkle(x, y, n, spread) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + this._rand(-0.2, 0.2);
      const sp = spread * this._rand(2.2, 4.2);
      this._push(this.stars, FX_CAP.stars, {
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        t: 0,
        life: this._rand(0.55, 0.9),
        size: clamp(spread * this._rand(0.12, 0.2), 6, 22),
        rot: this.rng() * TAU,
        spin: this._rand(-6, 6),
        color: STAR_COLORS[i % STAR_COLORS.length],
      });
    }
  }

  update(dt) {
    const step = (arr, fn) => {
      let j = 0;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (fn(o)) arr[j++] = o;
      }
      arr.length = j;
    };
    step(this.rings, (o) => (o.t += dt) < o.dur);
    const drag = Math.exp(-3 * dt);
    step(this.drops, (o) => {
      o.t += dt;
      o.vx *= drag;
      o.vy = o.vy * drag + 700 * dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      return o.t < o.life;
    });
    step(this.words, (o) => (o.t += dt) < o.dur);
    const sdrag = Math.exp(-4 * dt);
    step(this.stars, (o) => {
      o.t += dt;
      o.vx *= sdrag;
      o.vy = o.vy * sdrag + 120 * dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      o.rot += o.spin * dt;
      return o.t < o.life;
    });
  }

  /** @param {CanvasRenderingContext2D} ctx */
  draw(ctx) {
    ctx.save();
    // 번쩍 + 찢어진 비누막 조각이 바깥으로 퍼지는 고리
    for (const o of this.rings) {
      const p = o.t / o.dur;
      const e = easeOutCubic(p);
      if (o.flash && p < 0.35) {
        ctx.globalAlpha = 0.45 * (1 - p / 0.35);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.r * (0.8 + 0.3 * e), 0, TAU);
        ctx.fill();
      }
      const rr = o.r * (1 + 0.5 * e);
      const a = (1 - p) * o.alpha;
      const seg = TAU / o.pieces;
      const arc = seg * (0.72 - 0.35 * e);
      const rot = o.rot + e * 0.5;
      ctx.lineCap = 'round';
      ctx.globalAlpha = a;
      ctx.lineWidth = Math.max(1.5, o.r * 0.12 * (1 - p));
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      for (let i = 0; i < o.pieces; i++) {
        const a0 = rot + i * seg;
        ctx.moveTo(o.x + Math.cos(a0) * rr, o.y + Math.sin(a0) * rr);
        ctx.arc(o.x, o.y, rr, a0, a0 + arc);
      }
      ctx.stroke();
      ctx.lineWidth = Math.max(1, o.r * 0.06 * (1 - p));
      ctx.strokeStyle = `hsl(${Math.round(o.hue * 360)},95%,70%)`;
      ctx.beginPath();
      for (let i = 0; i < o.pieces; i++) {
        const a0 = rot + i * seg + arc * 0.15;
        ctx.moveTo(o.x + Math.cos(a0) * rr * 0.88, o.y + Math.sin(a0) * rr * 0.88);
        ctx.arc(o.x, o.y, rr * 0.88, a0, a0 + arc * 0.7);
      }
      ctx.stroke();
    }
    // 물방울
    for (const o of this.drops) {
      const p = o.t / o.life;
      ctx.globalAlpha = 1 - p * p;
      ctx.fillStyle = `hsl(${Math.round(o.hue * 360)},90%,88%)`;
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.size * (1 - 0.4 * p), 0, TAU);
      ctx.fill();
    }
    // 별
    for (const o of this.stars) {
      const p = o.t / o.life;
      ctx.globalAlpha = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
      const s = o.size * (p < 0.15 ? p / 0.15 : 1);
      const c = Math.cos(o.rot) * s;
      const sn = Math.sin(o.rot) * s;
      ctx.fillStyle = o.color;
      ctx.beginPath();
      for (let i = 0; i < 20; i += 2) {
        const px = o.x + STAR[i] * c - STAR[i + 1] * sn;
        const py = o.y + STAR[i] * sn + STAR[i + 1] * c;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    // 글자: 톡 튀어나와서 둥실 떠오르며 사라진다
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const o of this.words) {
      const p = o.t / o.dur;
      const s = popIn(p);
      ctx.globalAlpha = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
      ctx.save();
      ctx.translate(o.x, o.y - easeOutCubic(p) * o.size * 1.1);
      ctx.rotate(o.tilt);
      ctx.scale(s, s);
      ctx.font = `${Math.round(o.size)}px ${FONT}`;
      ctx.lineWidth = Math.max(4, o.size * 0.16);
      ctx.strokeStyle = 'rgba(42,35,80,0.35)';
      ctx.strokeText(o.text, 0, o.size * 0.06);
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(o.text, 0, 0);
      ctx.fillStyle = o.color;
      ctx.fillText(o.text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }
}
