// 입김 그림 놀이의 순수 로직 모음. DOM 의존성이 없어 node 에서 테스트할 수 있다.
//
//   FogField     김 서림 농도 격자 (화면보다 작은 해상도). 김 더하기·닦기·마르기·덮인 정도 계산
//   BlowSensor   마이크 + 얼굴 입 모양을 합쳐 "지금 누가 어디서 불고 있나" 판단 (흔들림 방지 포함)
//   BreathSpread 입김이 입 앞에서 시작해 점점 넓게 퍼지도록 반지름을 키운다
//   TrySensor    '거의 불었어요': 소리는 조금 들리는데 입김으로는 모자랄 때 (멀리서 살살 불기)
//   PenTracker   손별 그리기 상태 (검지 = 펜, 손바닥 = 걸레). 끊김·튐 방지
//   DripSim      물방울이 주르륵 흘러내리며 맑은 자국을 남긴다 (닦으면 같이 닦여 나간다)
//   Coach        덮인 정도에 따라 단계(불기 → 그리기 → 다시 불기)와 안내 문구를 고른다
//   AutoFog      마이크가 없거나 아무도 불지 않으면 잠시 뒤 김을 저절로 서리게 한다
//   Latch        잠깐 켜진 신호를 조금 더 유지 (인식이 화면보다 느리게 들어와서 생기는 깜빡임 방지)

import { clamp, damp, dist } from '../../core/math.js';

// ------------------------------------------------------------------ 도우미

/** 결정적인 의사 난수 (같은 seed 면 같은 결과 → 테스트하기 좋다). 0..1 */
export function mulberry32(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * gw×gh 격자 위의 부드러운 값 잡음 (0..1). scale 칸마다 무작위 값을 두고 부드럽게 잇는다. 두 겹(octave).
 * @returns {Float32Array}
 */
export function valueNoise(gw, gh, scale, rng) {
  const out = new Float32Array(gw * gh);
  const layers = [
    [scale, 0.65],
    [Math.max(2, scale / 2.7), 0.35],
  ];
  for (const [s, weight] of layers) {
    const lw = Math.ceil(gw / s) + 2;
    const lh = Math.ceil(gh / s) + 2;
    const lat = new Float32Array(lw * lh);
    for (let k = 0; k < lat.length; k++) lat[k] = rng();
    for (let j = 0; j < gh; j++) {
      const fy = j / s;
      const y0 = Math.floor(fy);
      const ty = smooth01(fy - y0);
      for (let i = 0; i < gw; i++) {
        const fx = i / s;
        const x0 = Math.floor(fx);
        const tx = smooth01(fx - x0);
        const a = lat[y0 * lw + x0];
        const b = lat[y0 * lw + x0 + 1];
        const c = lat[(y0 + 1) * lw + x0];
        const d = lat[(y0 + 1) * lw + x0 + 1];
        const top = a + (b - a) * tx;
        const bot = c + (d - c) * tx;
        out[j * gw + i] += (top + (bot - top) * ty) * weight;
      }
    }
  }
  // 0..1 로 늘린다
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < out.length; k++) {
    if (out[k] < lo) lo = out[k];
    if (out[k] > hi) hi = out[k];
  }
  const span = hi - lo || 1;
  for (let k = 0; k < out.length; k++) out[k] = (out[k] - lo) / span;
  return out;
}

/** 화면 크기에 맞는 김 격자 한 칸 크기(px). 칸 수가 6만 개 정도를 넘지 않게 한다. */
export function fogCellSize(width, height, maxCells = 60000) {
  return Math.max(4, Math.sqrt((Math.max(1, width) * Math.max(1, height)) / maxCells));
}

/** 점 (x, y) 에서 화면 네 모서리 중 가장 먼 곳까지 거리 */
export function farthestCorner(x, y, width, height) {
  const dx = Math.max(x, width - x);
  const dy = Math.max(y, height - y);
  return Math.hypot(dx, dy);
}

/**
 * 김을 그릴 해상도. 김 층은 화면 전체를 여러 번 겹쳐 그리므로(흐린 영상·결·오려 내기·테두리·젖은 유리),
 * 큰 화면 + 높은 기기 픽셀 비율(4K TV, 레티나)에서는 maxPx 화소짜리 작은 캔버스에서 합친 뒤 한 번만 늘려 그린다.
 * 작은 캔버스가 화면 화소의 60% 를 넘으면 합치는 비용이 더 들므로 화면에 바로 그린다.
 * @returns {{scale:number, comp:boolean}} scale = CSS px 당 김 캔버스 화소, comp = 따로 합쳐서 그릴지
 */
export function fogRenderScale(width, height, dpr = 1, maxPx = 3e6) {
  const d = Math.max(1, Math.min(2, dpr || 1));
  const scale = Math.min(d, Math.sqrt(maxPx / Math.max(1, width * height)));
  return { scale, comp: (scale / d) ** 2 < 0.6 };
}

/**
 * 펜이 이번에 새로 지나간 면적(김 칸 수). 닦인 김의 양을 이것으로 나누면 '김 위를 지나갔나'(평균 농도)를 알 수 있다.
 * @param {{start:boolean, r:number, len:number}} op
 */
export function sweptCells(op, cell) {
  const area = op.start ? Math.PI * op.r * op.r : 2 * op.r * Math.max(op.len, 1);
  return area / (cell * cell);
}

/**
 * 펜이 김 위를 문지르는 중인가? (뽀득 소리는 김이 실제로 닦일 때만 — 맑은 유리 위에서 소리만 나면 헷갈린다)
 * @param {number} removed eraseCapsule 이 돌려준 닦인 양
 * @param {number} [minDensity] 새로 지나간 곳의 평균 김 농도가 이보다 커야 한다
 */
export function penOnFog(removed, op, cell, minDensity = 0.15) {
  return removed > minDensity * sweptCells(op, cell);
}

// ------------------------------------------------------------------ 김 격자

// 김 가장자리 결: 이보다 완만한 변화(0..255 기준)는 무시, 넘는 만큼에 밝은 쪽/어두운 쪽 세기를 곱한다
const EDGE_SOFT = 70;
const EDGE_LIGHT = (255 / (255 - EDGE_SOFT)) * 0.6;
const EDGE_DARK = (255 / (255 - EDGE_SOFT)) * 0.32;

/**
 * 김 서림 농도 격자. 칸 (i, j) 의 중심은 화면 ((i+0.5)·cell, (j+0.5)·cell).
 * 농도 d 는 0..max. 1 보다 크게 쌓일 수 있어서 진하게 분 김은 오래 간다 (보이는 진하기는 alphaLUT 로 바꾼다).
 */
export class FogField {
  constructor(width, height, { cell = fogCellSize(width, height), max = 1.3, seed = 7 } = {}) {
    this.width = width;
    this.height = height;
    this.cell = cell;
    this.max = max;
    this.gw = Math.max(2, Math.ceil(width / cell));
    this.gh = Math.max(2, Math.ceil(height / cell));
    this.n = this.gw * this.gh;
    this.d = new Float32Array(this.n);
    const rng = mulberry32(seed);
    // 마르는 속도를 곳곳마다 조금씩 다르게 → 얼룩덜룩 자연스럽게 마른다
    const evap = valueNoise(this.gw, this.gh, Math.max(6, 90 / cell), rng);
    for (let k = 0; k < this.n; k++) evap[k] = 0.6 + evap[k] * 0.8;
    this.evap = evap;
    // 입김이 퍼지는 가장자리를 울퉁불퉁하게
    this.grow = valueNoise(this.gw, this.gh, Math.max(4, 40 / cell), rng);
    // 저절로 서릴 때 순서: 창 가장자리부터 안쪽으로 + 잡음
    const order = valueNoise(this.gw, this.gh, Math.max(5, 60 / cell), rng);
    const half = Math.min(this.gw, this.gh) / 2;
    for (let j = 0; j < this.gh; j++) {
      for (let i = 0; i < this.gw; i++) {
        const k = j * this.gw + i;
        const e = Math.min(i, this.gw - 1 - i, j, this.gh - 1 - j) / half;
        order[k] = clamp(0.62 * Math.min(1, e) + 0.38 * order[k]);
      }
    }
    this.order = order;
    // 농도 → 보이는 진하기(0..255) 표. visible 농도에서 완전히 불투명해진다.
    this.visible = 0.8;
    this.lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const dd = (v / 255) * max;
      this.lut[v] = Math.round(smooth01((dd - 0.02) / (this.visible - 0.02)) * 255);
    }
    this.dirty = true;
    this.empty = true; // 김이 하나도 없으면 그리기를 건너뛴다
  }

  /** (x, y) 화면 위치의 농도 (가장 가까운 칸) */
  sample(x, y) {
    const i = Math.floor(x / this.cell);
    const j = Math.floor(y / this.cell);
    if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return 0;
    return this.d[j * this.gw + i];
  }

  /**
   * (x, y) 를 중심으로 반지름 R 안에 김을 더한다. 가운데는 amount 만큼, 가장자리로 갈수록 적게.
   * @returns {number} 더해진 양 (칸 단위 합)
   */
  addBlob(x, y, R, amount) {
    if (R <= 0 || amount <= 0) return 0;
    const c = this.cell;
    const { gw, d, grow, max } = this;
    const i0 = Math.max(0, Math.floor((x - R) / c));
    const i1 = Math.min(gw - 1, Math.ceil((x + R) / c));
    const j0 = Math.max(0, Math.floor((y - R) / c));
    const j1 = Math.min(this.gh - 1, Math.ceil((y + R) / c));
    const R2 = R * R;
    const inv = 1 / R;
    let added = 0;
    for (let j = j0; j <= j1; j++) {
      const dy = (j + 0.5) * c - y;
      const dy2 = dy * dy;
      if (dy2 >= R2) continue;
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5) * c - x;
        const d2 = dx * dx + dy2;
        if (d2 >= R2) continue;
        const k = j * gw + i;
        // 잡음으로 반지름을 0.8R..R 사이에서 흔들어 가장자리를 구름처럼
        const q = Math.sqrt(d2) * inv * (0.8 + 0.45 * grow[k]);
        if (q >= 1) continue;
        const w = q < 0.45 ? 1 : 1 - smooth01((q - 0.45) / 0.55);
        const old = d[k];
        if (old >= max) continue;
        const nv = Math.min(max, old + amount * w);
        d[k] = nv;
        added += nv - old;
      }
    }
    if (added > 0) {
      this.dirty = true;
      this.empty = false;
    }
    return added;
  }

  /**
   * 선분 a→b 를 따라 반지름 r 로 김을 닦는다 (둥근 끝). 가장자리는 한 칸 정도 부드럽게.
   * @returns {number} 닦여 나간 김의 양 (칸 단위 합) — 물방울을 만들 때 쓴다
   */
  eraseCapsule(ax, ay, bx, by, r) {
    const c = this.cell;
    const { gw, d } = this;
    // 가장자리를 1.6칸 폭으로 부드럽게 (계단 무늬 방지)
    const outer = r + c * 0.8;
    const inner = r - c * 0.8;
    const vis = this.visible;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - outer) / c));
    const i1 = Math.min(gw - 1, Math.ceil((Math.max(ax, bx) + outer) / c));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - outer) / c));
    const j1 = Math.min(this.gh - 1, Math.ceil((Math.max(ay, by) + outer) / c));
    if (i0 > i1 || j0 > j1) return 0;
    const abx = bx - ax;
    const aby = by - ay;
    const l2 = abx * abx + aby * aby;
    const outer2 = outer * outer;
    const band = outer - inner;
    let removed = 0;
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * c;
      for (let i = i0; i <= i1; i++) {
        const k = j * gw + i;
        const old = d[k];
        if (old <= 0) continue;
        const px = (i + 0.5) * c;
        let t = l2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + abx * t - px;
        const ey = ay + aby * t - py;
        const e2 = ex * ex + ey * ey;
        if (e2 >= outer2) continue;
        const e = Math.sqrt(e2);
        // 경계에서 0→1 로 곧게 올라가는 값. 보이는 진하기 표(lut)가 한 번 부드럽게 해 주므로 여기서는 직선으로 둔다
        // (두 번 부드럽게 하면 경계가 오히려 날카로워져 계단 무늬가 보인다)
        const f = e <= inner ? 0 : (e - inner) / band;
        // 곱하지 않고 '보이는 진하기'로 상한을 둔다: 진한 김(1.3)을 반만 닦아도 불투명하게 남아 계단이 생기는 것을 막는다
        const cap = f * vis;
        if (cap >= old) continue;
        d[k] = cap;
        removed += old - cap;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** 시간이 지나면 김이 마른다. rate = 1초에 줄어드는 농도(평균). */
  evaporate(dt, rate) {
    const k = rate * dt;
    if (k <= 0) return;
    if (this.empty) return;
    const { d, evap } = this;
    let any = false;
    let left = false;
    for (let i = 0; i < this.n; i++) {
      const v = d[i];
      if (v > 0) {
        const nv = v - k * evap[i];
        if (nv > 0) {
          d[i] = nv;
          left = true;
        } else d[i] = 0;
        any = true;
      }
    }
    if (any) this.dirty = true;
    this.empty = !left;
  }

  /** 저절로 서리기: p 가 0→1 로 가는 동안 창 가장자리부터 안쪽으로 김이 찬다. 이미 있는 김은 줄이지 않는다. */
  fogIn(p, level = this.max) {
    const { d, order } = this;
    const front = p * 1.45;
    let changed = false;
    for (let k = 0; k < this.n; k++) {
      const target = level * smooth01((front - order[k]) / 0.45);
      if (target > d[k]) {
        d[k] = target;
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.empty = false;
    }
  }

  /** 전체를 같은 농도로 (테스트·디버그용) */
  fill(v) {
    this.d.fill(clamp(v, 0, this.max));
    this.dirty = true;
    this.empty = !(v > 0);
  }

  /**
   * 김이 덮은 비율 0..1. threshold 보다 진한 칸의 비율. stride 칸씩 건너뛰며 대충 센다.
   */
  coverage(threshold = 0.4, stride = 2) {
    const { d, gw, gh } = this;
    let hit = 0;
    let all = 0;
    for (let j = 0; j < gh; j += stride) {
      const row = j * gw;
      for (let i = 0; i < gw; i += stride) {
        all++;
        if (d[row + i] > threshold) hit++;
      }
    }
    return all ? hit / all : 0;
  }

  /**
   * 보이는 진하기를 ImageData 의 알파 채널에 쓴다 (RGB 는 건드리지 않는다).
   * edgeData 를 주면 김 가장자리의 '도톰한 결'(왼쪽 위에서 빛이 오는 양각 효과)도 함께 쓴다:
   * 빛을 받는 가장자리는 흰색, 반대쪽은 어두운 색 → 그린 선의 테두리가 또렷해진다.
   */
  writeAlpha(data, edgeData = null) {
    const { d, lut, gw, gh } = this;
    const k = 255 / this.max;
    const a = this.alphaBuf || (this.alphaBuf = new Uint8Array(this.n));
    for (let i = 0, p = 3; i < this.n; i++, p += 4) {
      const v = (d[i] * k) | 0;
      const al = lut[v > 255 ? 255 : v];
      a[i] = al;
      data[p] = al;
    }
    if (edgeData) {
      for (let j = 0; j < gh; j++) {
        const up = j > 0 ? -gw : 0;
        const down = j < gh - 1 ? gw : 0;
        for (let i = 0; i < gw; i++) {
          const k2 = j * gw + i;
          const left = i > 0 ? -1 : 0;
          const right = i < gw - 1 ? 1 : 0;
          // 오른쪽 아래 - 왼쪽 위: 양수면 빛을 받는 쪽(김이 오른쪽 아래에 있음).
          // 완만하게 옅어지는 입김 구름 가장자리는 무시하고, 손가락으로 닦은 또렷한 경계에만 결을 넣는다.
          const raw = a[k2 + down + right] - a[k2 + up + left];
          const e = raw > EDGE_SOFT ? raw - EDGE_SOFT : raw < -EDGE_SOFT ? raw + EDGE_SOFT : 0;
          const p = k2 * 4;
          if (e > 0) {
            edgeData[p] = 255;
            edgeData[p + 1] = 255;
            edgeData[p + 2] = 255;
            edgeData[p + 3] = e * EDGE_LIGHT;
          } else {
            edgeData[p] = 18;
            edgeData[p + 1] = 42;
            edgeData[p + 2] = 64;
            edgeData[p + 3] = -e * EDGE_DARK;
          }
        }
      }
    }
    this.dirty = false;
  }

  /** 다른 크기의 격자에서 김을 옮겨 온다 (창 크기가 바뀌었을 때) */
  resampleFrom(other) {
    const sx = other.width / this.width;
    const sy = other.height / this.height;
    for (let j = 0; j < this.gh; j++) {
      for (let i = 0; i < this.gw; i++) {
        this.d[j * this.gw + i] = Math.min(this.max, other.sample((i + 0.5) * this.cell * sx, (j + 0.5) * this.cell * sy));
      }
    }
    this.dirty = true;
    this.empty = other.empty;
  }

  /** 진한 김이 있는 아무 곳 하나 (없으면 null). 물방울이 저절로 맺힐 자리 찾기. */
  randomDenseSpot(rng, minDensity = 0.9, tries = 12) {
    for (let t = 0; t < tries; t++) {
      const i = Math.floor(rng() * this.gw);
      const j = Math.floor(rng() * this.gh * 0.8); // 아래쪽 끝보다는 위에서 맺힌다
      if (this.d[j * this.gw + i] >= minDensity) return { x: (i + 0.5) * this.cell, y: (j + 0.5) * this.cell };
    }
    return null;
  }
}

// ------------------------------------------------------------------ 입김 감지

/**
 * 마이크와 얼굴(입 오므리기/볼 부풀리기)을 합쳐서 입김을 판단한다.
 * 얼굴마다 히스테리시스(켜질 때 on, 꺼질 때 off)와 짧은 유지 시간을 둬서 깜빡이지 않게 한다.
 * 마이크가 켜져 있는데 아무 소리도 안 들리면 입 모양만으로는 더 또렷하고 오래 오므려야 하고(strict), 세기도 약하다:
 * 집중해서 입을 오므리거나 사진용 뽀뽀 얼굴을 할 때 그림 위로 김이 퍼지지 않게.
 */
export class BlowSensor {
  constructor(o = {}) {
    this.o = {
      on: 0.5, off: 0.32, hold: 0.1, memory: 2.5,
      strictOn: 0.68, strictOff: 0.5, strictHold: 0.35, quietScale: 0.55, quietLevel: 0.08,
      ...o,
    };
    this.faces = new Map();
    this.lastMouth = null;
    this.lastMouthAge = Infinity;
    this.blowing = false;
    this.strength = 0;
    this.time = 0; // 이번에 쉬지 않고 분 시간
    this.sources = [];
    this.micFace = null; // 소리만 들릴 때 고른 얼굴 id (여러 아이 사이에서 왔다 갔다 하지 않게 유지)
    this.strict = false;
  }

  /** 창 크기가 바뀌면 기억해 둔 입 위치도 같은 비율로 옮긴다 */
  rescale(sx, sy) {
    if (this.lastMouth) {
      this.lastMouth.x *= sx;
      this.lastMouth.y *= sy;
      this.lastMouth.w *= Math.sqrt(sx * sy);
    }
  }

  /**
   * @param {number} dt
   * @param {{enabled?:boolean, level?:number, blowing?:boolean, strength?:number}|null} mic
   * @param {object[]} faces Face 목록 (id, blow, mouth, width, stale)
   * @returns {{blowing:boolean, strength:number, sources:{key:string,x:number,y:number,scale:number,s:number}[]}}
   */
  update(dt, mic, faces, width, height) {
    const { on, off, hold, memory, strictOn, strictOff, strictHold, quietScale, quietLevel } = this.o;
    // 마이크가 있는데 조용하다 = 입 모양만으로는 확실하지 않다
    const strict = !!mic?.enabled && !mic.blowing && !((mic.level || 0) > quietLevel);
    this.strict = strict;
    const onAt = strict ? strictOn : on;
    const offAt = strict ? strictOff : off;
    const onHold = strict ? strictHold : hold;
    const seen = new Set();
    const blowers = [];
    let best = null;
    let bestScore = -Infinity;
    let kept = null;
    let keptScore = -Infinity;
    let maxW = 1;
    for (const f of faces) maxW = Math.max(maxW, f.width || 0);
    this.lastMouthAge += dt;
    for (const f of faces) {
      seen.add(f.id);
      let st = this.faces.get(f.id);
      if (!st) {
        st = { on: false, t: 0 };
        this.faces.set(f.id, st);
      }
      const b = f.blow || 0;
      if (!f.stale) {
        const crossing = st.on ? b < offAt : b > onAt;
        st.t = crossing ? st.t + dt : 0;
        if (st.t >= (st.on ? hold : onHold) - 1e-9) {
          st.on = !st.on;
          st.t = 0;
        }
        if (f.mouth) {
          this.lastMouth = { x: f.mouth.x, y: f.mouth.y, w: f.width || 0 };
          this.lastMouthAge = 0;
        }
        const score = b * 1.5 + (f.width || 0) / maxW;
        if (score > bestScore && f.mouth) {
          best = f;
          bestScore = score;
        }
        if (f.id === this.micFace && f.mouth) {
          kept = f;
          keptScore = score;
        }
      }
      if (st.on && f.mouth) blowers.push({ f, s: clamp((b - 0.3) / 0.5, 0.4, 1) * (strict ? quietScale : 1) });
    }
    for (const id of [...this.faces.keys()]) if (!seen.has(id)) this.faces.delete(id);

    const micOn = !!mic?.blowing;
    const micS = micOn ? clamp(Math.max(mic.strength || 0, 0.3)) : 0;
    const fallbackScale = Math.min(width, height) * 0.3;
    const sources = [];
    for (const { f, s } of blowers) {
      sources.push({ key: `f${f.id}`, x: f.mouth.x, y: f.mouth.y, scale: f.width || fallbackScale, s: Math.max(s, micS) });
    }
    if (micOn && !blowers.length) {
      // 소리만 들릴 때: 가장 입김 모양에 가깝고 가까운(큰) 얼굴 → 방금 본 입 → 화면 가운데.
      // 한 번 고른 얼굴은 다른 얼굴이 확실히 더 나을 때만 바꾼다.
      if (kept && keptScore >= bestScore - 0.3) best = kept;
      this.micFace = best ? best.id : null;
      if (best) sources.push({ key: `f${best.id}`, x: best.mouth.x, y: best.mouth.y, scale: best.width || fallbackScale, s: micS });
      else if (this.lastMouth && this.lastMouthAge < memory) {
        sources.push({ key: 'mic', x: this.lastMouth.x, y: this.lastMouth.y, scale: this.lastMouth.w || fallbackScale, s: micS });
      } else sources.push({ key: 'mic', x: width / 2, y: height * 0.5, scale: fallbackScale, s: micS });
    }
    this.blowing = sources.length > 0;
    this.strength = sources.reduce((m, s) => Math.max(m, s.s), 0);
    this.time = this.blowing ? this.time + dt : 0;
    this.sources = sources;
    return { blowing: this.blowing, strength: this.strength, sources };
  }
}

/**
 * '거의 불었어요' 감지: 마이크가 켜져 있고 소리가 조금 들리는데 입김으로 판정되지는 않을 때
 * (멀리서 살살 불기, 너무 가까워서 얼굴이 안 잡히기). 놀이는 희미한 입김 알갱이와 "조금 더 세게" 안내로 답한다.
 * 말소리와 헷갈리지 않게: 입을 오므린 얼굴이 있으면 0.15초, 없으면 끊기지 않고 0.4초 넘게 이어질 때만 켠다.
 */
export class TrySensor {
  constructor(o = {}) {
    this.o = { shape: 0.22, faceLevel: 0.1, level: 0.16, faceHold: 0.15, hold: 0.4, gap: 0.1, release: 0.25, forget: 6, ...o };
    this.cand = 0; // 조건이 이어진 시간
    this.miss = 0; // 조건이 끊긴 시간
    this.trying = false;
    this.time = 0; // 지금까지 '시도'한 시간의 합 (진짜로 불거나 한참 조용하면 0)
    this.idle = 0;
    this.source = null;
  }

  /**
   * @param {number} dt
   * @param {{enabled?:boolean, level?:number}|null} mic
   * @param {object[]} faces
   * @param {boolean} blowing 지금 입김으로 판정되었는지 (BlowSensor)
   * @param {{x:number, y:number, scale:number}} fallback 오므린 입이 안 보일 때 쓸 위치
   * @returns {TrySensor}
   */
  update(dt, mic, faces, blowing, fallback) {
    const o = this.o;
    if (!mic?.enabled || blowing) {
      this.cand = this.miss = 0;
      this.trying = false;
      this.source = null;
      if (blowing) this.time = this.idle = 0;
      return this;
    }
    let best = null;
    for (const f of faces) if (!f.stale && f.mouth && (f.blow || 0) >= o.shape && (!best || f.blow > best.blow)) best = f;
    const level = mic.level || 0;
    const ok = best ? level > o.faceLevel : level > o.level;
    if (ok) {
      this.cand += dt;
      this.miss = 0;
    } else {
      this.miss += dt;
      if (this.miss > o.gap) this.cand = 0;
    }
    if (!this.trying && ok && this.cand >= (best ? o.faceHold : o.hold) - 1e-9) this.trying = true;
    else if (this.trying && this.miss > o.release) this.trying = false;
    if (this.trying) {
      this.time += dt;
      this.idle = 0;
      if (best) this.source = { x: best.mouth.x, y: best.mouth.y, scale: best.width || fallback.scale };
      else if (!this.source) this.source = { ...fallback };
    } else {
      this.source = null;
      this.idle += dt;
      if (this.idle > o.forget) this.time = 0;
    }
    return this;
  }
}

// ------------------------------------------------------------------ 입김 퍼지기

/**
 * 부는 곳마다 '입김 구름'의 반지름을 관리한다. 불수록 입 앞에서부터 넓게 퍼지고, 멈추면 천천히 줄어든다.
 * 몇 초 동안 후~ 불면 화면 대부분이 덮이도록 맞춰 두었다.
 */
export class BreathSpread {
  constructor(o = {}) {
    // reach > 1: 가장 먼 모서리보다 더 크게 퍼져야 모서리까지 김이 꽉 찬다
    this.o = { tau: 1.8, shrink: 1.4, forget: 4, rate: 1.7, r0K: 0.85, reach: 1.5, ...o };
    this.items = new Map();
  }

  /** 창 크기가 바뀌면 구름 위치·크기도 같은 비율로 */
  rescale(sx, sy) {
    const k = Math.sqrt(sx * sy);
    for (const it of this.items.values()) {
      it.x *= sx;
      it.y *= sy;
      it.R *= k;
      it.R0 *= k;
    }
  }

  /** @returns {{key:string, x:number, y:number, R:number, amount:number, s:number}[]} 이번 프레임에 더할 김 */
  update(dt, sources, width, height) {
    const { tau, shrink, forget, rate, r0K, reach } = this.o;
    const out = [];
    const active = new Set();
    for (const s of sources) {
      active.add(s.key);
      const R0 = Math.max(40, s.scale * r0K);
      let it = this.items.get(s.key);
      if (!it) {
        it = { x: s.x, y: s.y, R: R0, R0, idle: 0 };
        this.items.set(s.key, it);
      }
      it.R0 = R0;
      it.x = damp(it.x, s.x, 6, dt);
      it.y = damp(it.y, s.y, 6, dt);
      it.idle = 0;
      const far = Math.max(R0, farthestCorner(it.x, it.y, width, height) * reach);
      const t = tau / (0.55 + 0.45 * s.s);
      it.R += (far - it.R) * (1 - Math.exp(-dt / t));
      out.push({ key: s.key, x: it.x, y: it.y, R: it.R, amount: rate * (0.35 + 0.65 * s.s) * dt, s: s.s });
    }
    for (const [k, it] of this.items) {
      if (active.has(k)) continue;
      it.idle += dt;
      it.R += (it.R0 - it.R) * (1 - Math.exp(-dt / shrink));
      if (it.idle > forget) this.items.delete(k);
    }
    return out;
  }
}

// ------------------------------------------------------------------ 손가락으로 그리기 / 손바닥으로 닦기

/**
 * 손마다 그리기 상태를 기억한다 (hand.id 기준).
 * - 'point' 손: 검지 끝이 펜. 지난 프레임 위치에서 지금 위치까지 선분으로 이어 그린다 (빠르게 움직여도 끊기지 않게).
 * - 'open' 손: 손바닥과 다섯 손가락으로 쓱쓱 닦는다 (손바닥 자국).
 * - 인식이 잠깐 끊기거나(stale) 손 모양이 바뀌면 선을 끊어서 엉뚱한 곳까지 선이 이어지지 않게 한다.
 * - 'point' 가 잠깐 'other' 로 흔들려도 grace 초 동안은 계속 그린다 (검지가 펴져 있을 때만).
 */
export class PenTracker {
  constructor(o = {}) {
    this.o = {
      widthK: 0.18, // 선 굵기 = 손 크기 × widthK
      minWidth: 14,
      maxWidth: 70,
      jumpK: 2.2, // 한 프레임에 손 크기 × jumpK 보다 많이 튀면 새 선
      resumeK: 0.9, // 잠깐 놓쳤다 돌아왔을 때는 더 엄격하게
      grace: 0.3,
      liftExt: 0.35, // 검지 펴짐이 이보다 작으면 펜을 뗀다
      wipeDelay: 0.18, // 손바닥을 이만큼 펴고 있어야 닦기 시작 (지나가는 모양 무시)
      palmK: 0.58,
      fingerK: 0.12,
      ...o,
    };
    this.states = new Map();
    this.pause = 0;
  }

  /**
   * 지금 그리던 선을 모두 끊고 seconds 동안 그리지 않는다. 창 크기가 바뀌면 같은 손도 화면 좌표가 훌쩍 옮겨지고
   * 손 떨림 필터가 그 사이를 몇 프레임에 걸쳐 미끄러지듯 따라가는데, 그대로 이으면 가만히 있는 손가락이 줄을 긋는다.
   */
  suspend(seconds) {
    this.states.clear();
    this.pause = Math.max(this.pause, seconds);
  }

  _state(id) {
    let st = this.states.get(id);
    if (!st) {
      st = { mode: 'none', last: null, lastPalm: null, lastTips: null, r: 0, notPoint: 0, wasStale: false, speed: 0 };
      this.states.set(id, st);
    }
    return st;
  }

  _wanted(h, st, dt) {
    const { grace, wipeDelay, liftExt } = this.o;
    // 검지를 접는 중이면 (손 모양 판별이 바뀌기 몇 프레임 전) 바로 펜을 뗀다 → 선 끝에 꼬리가 덜 생긴다
    const indexExt = h.ext?.[1] ?? 1;
    if (h.pose === 'point' && indexExt < liftExt) {
      st.notPoint = grace;
      return 'none';
    }
    if (h.pose === 'point') {
      st.notPoint = 0;
      return 'pen';
    }
    if (st.mode === 'pen') {
      st.notPoint += dt;
      const indexUp = (h.ext?.[1] ?? 0) > 0.55;
      if (st.notPoint < grace && indexUp && h.pose !== 'fist' && h.pose !== 'open') return 'pen';
    }
    if (h.pose === 'open' && (st.mode === 'wipe' || (h.poseTime ?? 1) >= wipeDelay)) return 'wipe';
    return 'none';
  }

  /**
   * @param {object[]} hands Hand 목록
   * @param {number} dt
   * @returns {object[]} 이번 프레임에 할 일. {type:'pen', id, ax, ay, bx, by, r, len, speed, start, size}
   *   또는 {type:'wipe', id, palm, fromPalm, r, fingers:[[ax,ay,bx,by]...], trails:[[ax,ay,bx,by]...], fr, len, speed, size}
   */
  update(hands, dt) {
    const o = this.o;
    const ops = [];
    if (this.pause > 0) {
      this.pause -= dt;
      this.states.clear();
      return ops;
    }
    const seen = new Set();
    for (const h of hands) {
      seen.add(h.id);
      const st = this._state(h.id);
      if (h.stale) {
        st.wasStale = true;
        st.speed = 0;
        continue;
      }
      const mode = this._wanted(h, st, dt);
      const size = h.size;
      const limit = (st.wasStale ? o.resumeK : o.jumpK) * size;
      if (mode === 'pen') {
        const tip = h.lm[8];
        const rTarget = clamp(size * o.widthK, o.minWidth, o.maxWidth) / 2;
        st.r = st.mode === 'pen' && st.r > 0 ? damp(st.r, rTarget, 4, dt) : rTarget;
        const from = st.mode === 'pen' && st.last && dist(st.last, tip) <= limit ? st.last : null;
        const a = from || tip;
        const len = from ? dist(a, tip) : 0;
        st.speed = from ? damp(st.speed, len / Math.max(dt, 1e-3), 10, dt) : 0;
        ops.push({ type: 'pen', id: h.id, ax: a.x, ay: a.y, bx: tip.x, by: tip.y, r: st.r, len, speed: st.speed, start: !from, size });
        st.last = { x: tip.x, y: tip.y };
        st.lastPalm = null;
        st.lastTips = null;
      } else if (mode === 'wipe') {
        const palm = h.palm;
        const cont = st.mode === 'wipe' && st.lastPalm && dist(st.lastPalm, palm) <= limit;
        const fromPalm = cont ? st.lastPalm : palm;
        const len = cont ? dist(fromPalm, palm) : 0;
        st.speed = cont ? damp(st.speed, len / Math.max(dt, 1e-3), 10, dt) : 0;
        const bases = [2, 5, 9, 13, 17];
        const tips = [4, 8, 12, 16, 20];
        const fingers = [];
        const trails = [];
        for (let f = 0; f < 5; f++) {
          const b = h.lm[bases[f]];
          const t = h.lm[tips[f]];
          fingers.push([b.x, b.y, t.x, t.y]);
          if (cont && st.lastTips) trails.push([st.lastTips[f].x, st.lastTips[f].y, t.x, t.y]);
        }
        ops.push({
          type: 'wipe', id: h.id, palm: { x: palm.x, y: palm.y }, fromPalm: { x: fromPalm.x, y: fromPalm.y },
          r: size * o.palmK, fingers, trails, fr: Math.max(o.minWidth / 2, size * o.fingerK), len, speed: st.speed, start: !cont, size,
        });
        st.lastPalm = { x: palm.x, y: palm.y };
        st.lastTips = tips.map((i) => ({ x: h.lm[i].x, y: h.lm[i].y }));
        st.last = null;
      } else {
        st.last = null;
        st.lastPalm = null;
        st.lastTips = null;
        st.speed = 0;
      }
      st.mode = mode;
      st.wasStale = false;
    }
    for (const id of [...this.states.keys()]) if (!seen.has(id)) this.states.delete(id);
    return ops;
  }

  /** 지금 펜 상태인 손 id 목록 */
  modeOf(id) {
    return this.states.get(id)?.mode ?? 'none';
  }
}

// ------------------------------------------------------------------ 물방울

/** 물방울 머리 반지름 (px). unit = 화면 높이 / 720 */
export const dripRadius = (m, unit) => unit * (2.6 + 2.6 * Math.sqrt(Math.max(0, m)));

/**
 * 흘러내리는 물방울. 김 속을 지나면 물을 모아 커지고 빨라지며, 맑은 곳에서는 금방 멈춘다.
 * 멈칫멈칫 내려가는 진짜 물방울처럼 가끔 멈춘다. 지나간 자리는 김이 닦인 가는 줄이 남는다.
 */
export class DripSim {
  constructor(o = {}) {
    this.o = { max: 30, gain: 0.007, loss: 0.16, dryLoss: 0.3, minMass: 0.25, ...o };
    this.drips = [];
    this.spawned = 0;
    this.wiped = 0;
  }

  get count() {
    return this.drips.length;
  }

  /**
   * @param {number} [stick] 유리에 달라붙는 정도 (클수록 빨리 멈춤). 없으면 무작위 0.6..2.2 → 끝까지 흐르는 것도, 중간에 멈추는 것도 있다
   * @returns {object|null}
   */
  spawn(x, y, mass = 0.8, rng = Math.random, wait = 0.35, stick = 0.6 + rng() * 1.6) {
    if (this.drips.length >= this.o.max) return null;
    const d = { x, y, m: mass, v: 0, pause: wait + rng() * 0.5, age: 0, phase: rng() * Math.PI * 2, dead: false, fade: 1, fadeRate: 0.7, started: false, stick };
    this.drips.push(d);
    this.spawned++;
    return d;
  }

  /**
   * @param {number} dt
   * @param {FogField} field
   * @param {number} height 화면 높이
   * @param {() => number} rng
   * @returns {number} 이번 프레임에 흐르기 시작한 물방울 수 (소리용)
   */
  step(dt, field, height, rng = Math.random) {
    const o = this.o;
    const unit = height / 720;
    let started = 0;
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const d = this.drips[i];
      d.age += dt;
      if (d.dead) {
        d.fade -= dt * d.fadeRate;
        if (d.fade <= 0) this.drips.splice(i, 1);
        continue;
      }
      if (d.pause > 0) {
        d.pause -= dt;
        d.v *= Math.exp(-dt * 12);
      } else {
        if (!d.started) {
          d.started = true;
          started++;
        }
        const target = unit * (35 + 75 * Math.min(d.m, 2));
        d.v += (target - d.v) * Math.min(1, dt * 3);
        if (rng() < dt * 0.8) d.pause = 0.06 + rng() * 0.3; // 멈칫
      }
      const ny = d.y + d.v * dt;
      const nx = d.x + Math.sin(d.age * 2.1 + d.phase) * dt * unit * 5 * Math.min(1, d.v / (unit * 40));
      const r = dripRadius(d.m, unit);
      const fogHere = Math.min(1, field.sample(nx, ny + r));
      const removed = d.v > 0.5 ? field.eraseCapsule(d.x, d.y, nx, ny, r * 0.5) : 0;
      d.m += removed * o.gain;
      d.m -= dt * (d.v > 0.5 ? o.loss * d.stick + o.dryLoss * (1 - fogHere) : 0.02);
      d.m = Math.min(d.m, 2.5);
      d.x = nx;
      d.y = ny;
      if (d.y - r > height) this.drips.splice(i, 1);
      else if (d.m < o.minMass) {
        d.dead = true;
        d.m = o.minMass;
      }
    }
    return started;
  }

  /**
   * 손가락/손바닥이 선분 a→b (반지름 r) 를 지나가면 거기 있던 물방울도 같이 닦여 나간다 (진짜 창문처럼).
   * 바로 사라지면 깜빡이는 것처럼 보이므로 아주 빠르게 옅어지게 한다.
   * @returns {number} 닦인 물방울 수
   */
  wipe(ax, ay, bx, by, r) {
    const abx = bx - ax;
    const aby = by - ay;
    const l2 = abx * abx + aby * aby;
    const r2 = r * r;
    let n = 0;
    for (const d of this.drips) {
      if (d.dead && d.fadeRate > 1) continue; // 이미 닦이는 중
      let t = l2 > 0 ? ((d.x - ax) * abx + (d.y - ay) * aby) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + abx * t - d.x;
      const ey = ay + aby * t - d.y;
      if (ex * ex + ey * ey > r2) continue;
      if (!d.dead) d.fade = Math.min(1, d.age / 0.25); // 지금 보이는 진하기에서부터 옅어진다
      d.dead = true;
      d.fadeRate = 7;
      n++;
    }
    this.wiped += n;
    return n;
  }

  /** 창 크기가 바뀌면 물방울도 같은 비율로 옮긴다 */
  rescale(sx, sy) {
    for (const d of this.drips) {
      d.x *= sx;
      d.y *= sy;
    }
  }

  clear() {
    this.drips.length = 0;
  }
}

// ------------------------------------------------------------------ 안내

export const HINTS = Object.freeze({
  blow: '화면에 대고 후~ 입김을 불어 보세요 🌬️',
  blowNoMic: '입을 동그랗게 오므리고 후~ 불어 보세요 😗',
  blowing: '좋아요! 후~~ 계속 불어요 🌬️',
  harder: '조금 더 세게 후~ 불어 보세요 💨',
  // 창문처럼 화면을 만지려는 아이가 많다: 카메라는 화면 위에 있어서 화면에 붙인 손은 안 보인다 → '공중에'
  draw: '손가락 하나를 펴서 공중에 그려요 👆',
  handAway: '손이 안 보여요! 뒤로 한 걸음 ✋', // 물러나서 손이 보이면 곧바로 '손가락 하나를 펴서…' 로 바뀐다
  tooClose: '너무 가까워요! 한 걸음 뒤로 가요 👣',
  wipe: '손바닥으로 쓱쓱 닦을 수도 있어요 🖐️',
  again: '김이 사라졌어요! 다시 후~ 불어 보세요 🌬️',
});

/**
 * 단계: 'blow'(처음) → 'draw'(김이 충분히 서림) → 'again'(거의 다 닦이거나 마름) → 'draw' …
 * 덮인 정도에 히스테리시스를 둬서 단계가 깜빡이지 않는다. 축하 알림(toast)은 간격을 두고 가끔만.
 * 그리기 단계에서 얼굴은 보이는데 손이 한동안 안 보이면(화면을 만지러 다가온 아이) 뒤로 물러나 손을 들라고 안내한다.
 */
export class Coach {
  constructor(o = {}) {
    this.o = {
      fogOn: 0.3, fogOff: 0.1, full: 0.85, toastGap: 8, artLen: 7,
      wipeHintAfter: 5, wipeHintFor: 4, // 그리기만 5초 하면 손바닥 닦기 안내를 4초 동안 한 번만
      noHandAfter: 3, closeK: 0.45, // 손이 3초 안 보이면 안내, 얼굴 너비가 화면의 45% 를 넘으면 '너무 가까워요'
      harderAfter: 1, harderFor: 2.5, // '거의 불었어요' 가 1초 넘게 쌓이면 "조금 더 세게" (멈춘 뒤에도 잠깐 유지)
      ...o,
    };
    this.phase = 'blow';
    this.t = 0;
    this.lastToast = -Infinity;
    this.drawTime = 0;
    this.wipeTime = 0;
    this.drawnLen = 0; // 이번 김에서 그린 길이 (손 크기 단위)
    this.celebrated = false;
    this.pendingFogged = false;
    this.skipFogged = false;
    this.cycles = 0;
    this.noHandT = 0;
    this.wipeHinted = false;
    this.wipeHintLeft = 0;
    this.harderLeft = 0;
  }

  /** 다른 곳에서 알림을 띄웠을 때 알려 주면 그 뒤 toastGap 동안은 알림을 쉬고, 이번 김의 '서렸어요' 알림은 건너뛴다 */
  markToast() {
    this.lastToast = this.t;
    this.pendingFogged = false;
    this.skipFogged = this.phase !== 'draw';
  }

  /**
   * @param {{coverage:number, blowing:boolean, drawing:boolean, wiping:boolean, drawn:number, micEnabled:boolean,
   *   liveHands?:number, faces?:number, faceK?:number, trying?:boolean, tryTime?:number}} s
   *   drawn = 이번 프레임에 그린 길이 (손 크기 단위), liveHands = 지금 보이는 손 수 (모르면 생략),
   *   faces = 보이는 얼굴 수, faceK = 가장 큰 얼굴 너비 / 화면 너비, trying/tryTime = TrySensor
   * @returns {{hint:string, events:string[]}} events: 'fogged' | 'cleared' | 'art'
   */
  update(dt, s) {
    const o = this.o;
    this.t += dt;
    const events = [];
    const canToast = () => this.t - this.lastToast >= o.toastGap;
    if (this.phase !== 'draw') {
      if (s.coverage >= o.fogOn) {
        this.phase = 'draw';
        this.cycles++;
        this.drawTime = 0;
        this.wipeTime = 0;
        this.drawnLen = 0;
        this.celebrated = false;
        this.wipeHinted = false;
        this.wipeHintLeft = 0;
        this.noHandT = 0;
        this.pendingFogged = !this.skipFogged;
        this.skipFogged = false;
      }
    } else if (s.coverage < o.fogOff && !s.blowing) {
      this.phase = 'again';
      this.pendingFogged = false;
      events.push('cleared');
    }
    if (this.phase === 'draw') {
      // "김이 서렸어요!" 는 다 불고 난 뒤에 (또는 거의 다 덮였을 때) 한 번
      if (this.pendingFogged && (!s.blowing || s.coverage >= o.full)) {
        this.pendingFogged = false;
        if (canToast()) {
          events.push('fogged');
          this.lastToast = this.t;
        }
      }
      if (s.drawing) this.drawTime += dt;
      if (s.wiping) this.wipeTime += dt;
      this.drawnLen += s.drawn || 0;
      if (!this.celebrated && this.drawnLen >= o.artLen && canToast()) {
        this.celebrated = true;
        this.lastToast = this.t;
        events.push('art');
      }
      // 손바닥 안내는 한 번만 잠깐: 계속 띄우면 새로 온 아이가 이것만 보고 친구 그림을 닦아 버린다
      if (!this.wipeHinted && this.drawTime > o.wipeHintAfter && this.wipeTime < 0.5) {
        this.wipeHinted = true;
        this.wipeHintLeft = o.wipeHintFor;
      }
      if (this.wipeTime >= 0.5) this.wipeHintLeft = 0;
      this.wipeHintLeft = Math.max(0, this.wipeHintLeft - dt);
      // 얼굴은 보이는데 손이 안 보인다 = 화면을 만지고 있거나 너무 가까이 있다
      if (s.liveHands === 0 && (s.faces || 0) > 0 && !s.blowing) this.noHandT += dt;
      else this.noHandT = 0;
    } else this.noHandT = 0;
    if (s.trying && (s.tryTime || 0) > o.harderAfter) this.harderLeft = o.harderFor;
    else this.harderLeft = Math.max(0, this.harderLeft - dt);

    let hint;
    if (s.blowing && s.coverage < o.full) hint = HINTS.blowing;
    else if (this.phase === 'draw') {
      if (this.noHandT > o.noHandAfter) hint = (s.faceK || 0) > o.closeK ? HINTS.tooClose : HINTS.handAway;
      else hint = this.wipeHintLeft > 0 ? HINTS.wipe : HINTS.draw;
    } else if (this.harderLeft > 0) hint = HINTS.harder;
    else if (this.phase === 'again') hint = HINTS.again;
    else hint = s.micEnabled ? HINTS.blow : HINTS.blowNoMic;
    return { hint, events };
  }
}

/**
 * 아무도 불지 않고 화면이 맑은 채로 시간이 지나면 김을 저절로 서리게 한다.
 * 마이크가 없으면 짧게(기본 8초), 있으면 조금 길게(기본 14초) 기다린다. 불어 보려고 애쓰는 중(trying)이면
 * 기다림이 tryBoost 배 빨리 흘러서, 입김이 약한 아이도 몇 초 안에 그리기를 시작할 수 있다.
 */
export class AutoFog {
  constructor(o = {}) {
    this.o = { noMicDelay: 8, micDelay: 14, tryBoost: 4, clearBelow: 0.15, ...o };
    this.idle = 0;
    this.tried = 0; // 이번 기다림 동안 애쓴 시간
    this.lastTried = false; // 마지막으로 저절로 서리게 했을 때 누군가 불어 보려고 했었나 (알림 문구용)
  }
  /** @returns {boolean} 지금 저절로 서리게 해야 하면 true */
  update(dt, { micEnabled, blowing, coverage, trying = false }) {
    if (blowing || coverage >= this.o.clearBelow) {
      this.idle = 0;
      this.tried = 0;
      return false;
    }
    this.idle += dt * (trying ? this.o.tryBoost : 1);
    if (trying) this.tried += dt;
    if (this.idle >= (micEnabled ? this.o.micDelay : this.o.noMicDelay)) {
      this.idle = 0;
      this.lastTried = this.tried > 0;
      this.tried = 0;
      return true;
    }
    return false;
  }
}

/**
 * 마지막으로 켠 뒤 hold 초 동안 true 를 유지한다.
 * 손 인식은 카메라 속도(보통 30fps)로 들어오고 화면은 60fps 이상이라, 새 인식이 없는 프레임에는 손이 그대로라서
 * '움직이는 중' 같은 값이 한 프레임 걸러 꺼진다. 그 깜빡임을 없앤다.
 */
export class Latch {
  constructor(hold = 0.15) {
    this.hold = hold;
    this.left = 0;
  }
  /** @returns {boolean} */
  update(dt, on) {
    this.left = on ? this.hold : Math.max(0, this.left - dt);
    return this.value;
  }
  get value() {
    return this.left > 0;
  }
  reset() {
    this.left = 0;
  }
}

/**
 * 안내 문구가 깜빡이지 않게: 새 문구가 hold 초 동안 계속 요청될 때만 바꾼다 (처음 한 번은 바로).
 */
export class SteadyText {
  constructor(hold = 0.3) {
    this.hold = hold;
    this.value = null;
    this.cand = null;
    this.t = 0;
  }
  /** @returns {boolean} 이번에 value 가 바뀌었으면 true */
  update(dt, text) {
    if (text === this.value) {
      this.cand = null;
      return false;
    }
    if (text !== this.cand) {
      this.cand = text;
      this.t = 0;
    }
    this.t += dt;
    if (this.value === null || this.t >= this.hold) {
      this.value = text;
      this.cand = null;
      return true;
    }
    return false;
  }
}
