// 늘어나는 손가락 놀이의 기하 계산 (순수 함수, DOM 없음 → node 에서 테스트).
//
// 핵심 아이디어
//   - 손가락 '원래 모양'(src)은 손가락 뿌리 → 끝을 잇는 곧은 띠.
//   - '늘어난 모양'(pos)은 뿌리 → 집은 점을 잇는 2차 베지에 곡선을 따라 놓인 띠.
//   - 같은 정점의 src/pos 를 짝지어 WebGL 무대에 그리면 손가락 영상이 곡선을 따라 늘어나 보인다.
//   - 손가락 뿌리 쪽과 끝(손톱) 쪽은 거의 그대로 두고 가운데만 늘려서 '긴 손가락'처럼 보이게 한다.

import { clamp, lerp, smoothstep, wrapAngle } from '../../core/math.js';

/** 손가락별 뿌리 / 끝 마디 / 끝 랜드마크 번호 (엄지는 MCP 를 뿌리로 쓴다) */
export const FINGER_BASE = Object.freeze([2, 5, 9, 13, 17]);
export const FINGER_DIP = Object.freeze([3, 7, 11, 15, 19]);
export const FINGER_TIP = Object.freeze([4, 8, 12, 16, 20]);
/** 손가락 굵기 (× hand.size) */
export const FINGER_WIDTH = Object.freeze([0.25, 0.22, 0.22, 0.21, 0.19]);
/** 손가락 끝 랜드마크 너머로 살이 이어지는 길이 (× hand.size) */
export const TIP_CAP = 0.13;
/** 영상에서 가져오는 띠 너비 = 손가락 굵기 × 이 값 (가장자리를 부드럽게 지울 여유) */
export const SRC_MARGIN = 1.3;
/** 원래 손가락 자리 덮기: 손가락 굵기 대비 덮는 너비, 끝 살 너머로 더 덮는 길이·사라지는 길이 (× hand.size) */
export const COVER_SPAN = 1.3;
export const COVER_TAIL = 0.04;
export const COVER_FADE = 0.1;

/** 손의 방향(라디안): 손목 → 중지 뿌리 */
export function handAngle(lm) {
  return Math.atan2(lm[9].y - lm[0].y, lm[9].x - lm[0].x);
}

/**
 * 손가락의 지금 모양을 '손 기준' 값으로 잰다. 손이 움직이고 돌아가도 같은 값이 나온다.
 * @returns {{lrel:number, phi:number}} lrel = 뿌리→끝 길이 / 손 크기, phi = 손 방향 대비 손가락 각도
 */
export function measureFinger(lm, size, f) {
  const b = lm[FINGER_BASE[f]];
  const t = lm[FINGER_TIP[f]];
  const dx = t.x - b.x;
  const dy = t.y - b.y;
  return { lrel: Math.hypot(dx, dy) / Math.max(size, 1e-6), phi: wrapAngle(Math.atan2(dy, dx) - handAngle(lm)) };
}

/**
 * 손 기준 값(lrel, phi)과 지금 손의 뿌리 위치·방향·크기로 원래 손가락 축을 다시 만든다.
 * (다른 손이 손가락 끝을 가려서 끝 랜드마크를 믿을 수 없을 때 사용)
 */
export function fingerAxis(bx, by, theta, size, lrel, phi) {
  const a = theta + phi;
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  const len = lrel * size;
  return { base: { x: bx, y: by }, dir, len, angle: a, tip: { x: bx + dir.x * len, y: by + dir.y * len } };
}

// ---------------------------------------------------------------- 베지에 곡선 (길이 기준 매개변수)

/**
 * 2차 베지에 곡선을 '길이'로 따라갈 수 있게 해 주는 도우미. 배열은 한 번만 만들고 재사용한다.
 * at(u) 는 곡선 시작에서 길이 u 만큼 간 점과 접선을 준다. u 가 범위를 벗어나면 끝 접선 방향으로 곧게 늘인다.
 */
export class ArcCurve {
  constructor(n = 32) {
    this.n = n;
    this.lens = new Float64Array(n + 1);
    this.p0x = 0;
    this.p0y = 0;
    this.cx = 0;
    this.cy = 0;
    this.p2x = 0;
    this.p2y = 0;
    this.total = 0;
    this.fallback = { x: 1, y: 0 };
  }

  set(p0, c, p2, fallbackDir = null) {
    this.p0x = p0.x;
    this.p0y = p0.y;
    this.cx = c.x;
    this.cy = c.y;
    this.p2x = p2.x;
    this.p2y = p2.y;
    if (fallbackDir) {
      this.fallback.x = fallbackDir.x;
      this.fallback.y = fallbackDir.y;
    }
    let px = p0.x;
    let py = p0.y;
    let acc = 0;
    this.lens[0] = 0;
    for (let i = 1; i <= this.n; i++) {
      const t = i / this.n;
      const m = 1 - t;
      const x = m * m * p0.x + 2 * m * t * c.x + t * t * p2.x;
      const y = m * m * p0.y + 2 * m * t * c.y + t * t * p2.y;
      acc += Math.hypot(x - px, y - py);
      this.lens[i] = acc;
      px = x;
      py = y;
    }
    this.total = acc;
    return this;
  }

  /** 매개변수 t 에서의 점 */
  point(t, out) {
    const m = 1 - t;
    out.x = m * m * this.p0x + 2 * m * t * this.cx + t * t * this.p2x;
    out.y = m * m * this.p0y + 2 * m * t * this.cy + t * t * this.p2y;
    return out;
  }

  /** 매개변수 t 에서의 단위 접선 (길이 0 이면 이웃 방향 → 기본 방향) */
  tangent(t, out) {
    let x = 2 * (1 - t) * (this.cx - this.p0x) + 2 * t * (this.p2x - this.cx);
    let y = 2 * (1 - t) * (this.cy - this.p0y) + 2 * t * (this.p2y - this.cy);
    let l = Math.hypot(x, y);
    if (l < 1e-6) {
      x = this.p2x - this.p0x;
      y = this.p2y - this.p0y;
      l = Math.hypot(x, y);
      if (l < 1e-6) {
        x = this.fallback.x;
        y = this.fallback.y;
        l = Math.hypot(x, y) || 1;
      }
    }
    out.x = x / l;
    out.y = y / l;
    return out;
  }

  /** 길이 u → 매개변수 t (0..1) */
  paramAt(u) {
    if (u <= 0) return 0;
    if (u >= this.total) return 1;
    // 이분 탐색
    let lo = 0;
    let hi = this.n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.lens[mid] < u) lo = mid;
      else hi = mid;
    }
    const seg = this.lens[hi] - this.lens[lo];
    const k = seg > 1e-9 ? (u - this.lens[lo]) / seg : 0;
    return (lo + k) / this.n;
  }

  /** 길이 u 만큼 간 점(outP)과 단위 접선(outT). 범위 밖은 곧게 늘인다. */
  at(u, outP, outT) {
    if (u <= 0) {
      this.tangent(0, outT);
      outP.x = this.p0x + outT.x * u;
      outP.y = this.p0y + outT.y * u;
    } else if (u >= this.total) {
      this.tangent(1, outT);
      const e = u - this.total;
      outP.x = this.p2x + outT.x * e;
      outP.y = this.p2y + outT.y * e;
    } else {
      const t = this.paramAt(u);
      this.point(t, outP);
      this.tangent(t, outT);
    }
  }
}

// ---------------------------------------------------------------- 늘어난 손가락 그물(mesh)

const DEV_SAMPLES = [0.45, 0.7, 1];

/** 가로 방향 정점 위치(-1 왼쪽 가장자리 … 1 오른쪽)와 투명도. 바깥 줄은 투명해서 가장자리가 부드럽다. */
export const MESH_COLS = Object.freeze([-1, -0.6, 0, 0.6, 1]);
export const MESH_COL_ALPHA = Object.freeze([0, 1, 1, 1, 0]);

/** rows × cols 격자의 삼각형 번호 */
export function gridIndices(rows, cols) {
  const idx = new Uint16Array((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = d;
      idx[k++] = b;
      idx[k++] = e;
      idx[k++] = d;
    }
  }
  return idx;
}

/**
 * 원래 길이 s(뿌리에서 손가락 축을 따라 잰 px)를 늘어난 곡선 위 길이 u 로 바꾸는 규칙.
 *   - 뿌리 [.., sb] : 그대로 (손바닥과 자연스럽게 이어지게)
 *   - 가운데 [sb, sg-th] : 늘어나는 부분
 *   - 끝 [sg-th, ..] : 그대로 (손톱이 늘어나지 않게). sg(집은 곳)가 곡선 끝(=집은 점)에 온다.
 *   곡선이 원래보다 짧으면(눌러서 찌그러뜨림) 전체를 고르게 줄인다.
 */
export function makeLengthMap(len, sg, Lc) {
  const sb = 0.12 * len;
  const th = Math.max(0.05 * len, Math.min(0.3 * len, sg - sb - 0.08 * len));
  const mid0 = sb;
  const mid1 = sg - th;
  if (Lc >= sg) {
    const m = (Lc - th - sb) / Math.max(mid1 - mid0, 1e-6);
    return { sb, th, mid0, mid1, stretch: m, map: (s) => (s <= sb ? s : s <= mid1 ? sb + (s - sb) * m : Lc + (s - sg)) };
  }
  const c = Lc / Math.max(sg, 1e-6);
  return { sb, th, mid0, mid1, stretch: c, map: (s) => (s <= 0 ? s : s * c) };
}

/**
 * 늘어난 정도에 따른 굵기 비율. 늘어나면 가늘어지고(부피 보존 느낌) 눌리면 통통해진다.
 * q: 가운데 구간 안의 위치 0..1 (구간 밖은 음수/1 이상), 반환: 원래 굵기 대비 비율
 */
export function widthProfile(ratio, q) {
  // 완전한 부피 보존(1/√비율)은 너무 가늘어서 '줄'처럼 보이므로 조금 덜 가늘어지게 한다
  const wm = clamp(Math.pow(Math.max(ratio, 1e-3), -0.35), 0.5, 1.3);
  const wt = ratio >= 1 ? lerp(wm, 1, 0.72) : wm; // 손끝은 통통하게 남긴다
  if (q <= 0) return 1;
  if (q >= 1) return wt;
  if (q < 0.5) return lerp(1, wm, smoothstep(0, 0.4, q));
  return lerp(wm, wt, smoothstep(0.62, 1, q));
}

/**
 * 손가락 하나의 늘어난 그물. 배열은 미리 만들어 매 프레임 재사용한다.
 */
export class FingerMesh {
  constructor({ base = 3, mid = 18, tip = 8 } = {}) {
    this.nb = base;
    this.nm = mid;
    this.nt = tip;
    this.rows = base + mid + tip + 1;
    this.cols = MESH_COLS.length;
    const n = this.rows * this.cols;
    this.pos = new Float32Array(n * 2);
    this.src = new Float32Array(n * 2);
    this.alpha = new Float32Array(n);
    this.indices = gridIndices(this.rows, this.cols);
    /** 2D 덧그리기용: 줄마다 곡선 위 중심점, 보이는 손가락 반폭, 법선 */
    this.cx = new Float32Array(this.rows);
    this.cy = new Float32Array(this.rows);
    this.nx = new Float32Array(this.rows);
    this.ny = new Float32Array(this.rows);
    this.hw = new Float32Array(this.rows);
    this.rowS = new Float32Array(this.rows);
    this.curve = new ArcCurve(32);
    this.ratio = 1;
    this.length = 0;
    this._p = { x: 0, y: 0 };
    this._t = { x: 0, y: 0 };
  }

  /**
   * @param {object} o
   * @param {{x,y}} o.base  손가락 뿌리 (화면 px)
   * @param {{x,y}} o.dir   원래 손가락 방향 (단위 벡터)
   * @param {number} o.len  원래 뿌리→끝 길이 px
   * @param {number} o.grab 원래 손가락에서 집은 곳까지 길이 px (보통 len)
   * @param {number} o.width 손가락 굵기 px
   * @param {number} o.cap  끝 랜드마크 너머 살 길이 px
   * @param {{x,y}} o.ctrl  베지에 조절점
   * @param {{x,y}} o.end   곡선 끝 (집은 점)
   * @returns {number} 늘어난 비율 (곡선 길이 / 원래 길이)
   */
  build({ base, dir, len, grab, width, cap, ctrl, end }) {
    const curve = this.curve.set(base, ctrl, end, dir);
    const Lc = curve.total;
    const sg = Math.max(grab, 1e-3);
    const ratio = Lc / sg;
    const lm = makeLengthMap(len, sg, Lc);
    const sStart = -0.16 * len;
    const sEnd = Math.max(len, sg) + cap;
    const hwSrc = 0.5 * width * SRC_MARGIN;
    const nx0 = -dir.y;
    const ny0 = dir.x;
    const P = this._p;
    const T = this._t;
    const cols = this.cols;
    const midLen = Math.max(lm.mid1 - lm.mid0, 1e-6);
    let r = 0;
    const emit = (s) => {
      const u = lm.map(s);
      curve.at(u, P, T);
      const nx = -T.y;
      const ny = T.x;
      const q = s <= lm.mid0 ? 0 : (s - lm.mid0) / midLen;
      const k = widthProfile(ratio, q);
      const hwPos = hwSrc * k;
      const sx = base.x + dir.x * s;
      const sy = base.y + dir.y * s;
      const ra = smoothstep(sStart, sStart + 0.2 * len, s) * (1 - smoothstep(Math.max(len, sg) + cap * 0.3, sEnd, s));
      for (let c = 0; c < cols; c++) {
        const lat = MESH_COLS[c];
        const v = r * cols + c;
        this.pos[v * 2] = P.x + nx * lat * hwPos;
        this.pos[v * 2 + 1] = P.y + ny * lat * hwPos;
        this.src[v * 2] = sx + nx0 * lat * hwSrc;
        this.src[v * 2 + 1] = sy + ny0 * lat * hwSrc;
        this.alpha[v] = MESH_COL_ALPHA[c] * ra;
      }
      this.cx[r] = P.x;
      this.cy[r] = P.y;
      this.nx[r] = nx;
      this.ny[r] = ny;
      this.hw[r] = 0.5 * width * k;
      this.rowS[r] = s;
      r++;
    };
    for (let i = 0; i < this.nb; i++) emit(lerp(sStart, lm.sb, i / this.nb));
    for (let i = 0; i < this.nm; i++) emit(lerp(lm.mid0, lm.mid1, i / this.nm));
    for (let i = 0; i <= this.nt; i++) emit(lerp(lm.mid1, sEnd, i / this.nt));
    this.ratio = ratio;
    this.length = Lc;
    return ratio;
  }

  /** 원래 손가락 축(곧은 선)과 늘어난 곡선이 얼마나 어긋났는지 (px). 원래 손가락이 드러나는 정도 판단용. */
  deviation(base, dir, len) {
    const P = this._p;
    const T = this._t;
    let worst = 0;
    for (const f of DEV_SAMPLES) {
      const u = len * f;
      this.curve.at(u, P, T);
      const d = Math.hypot(P.x - (base.x + dir.x * u), P.y - (base.y + dir.y * u));
      if (d > worst) worst = d;
    }
    return worst;
  }
}

/**
 * 원래 손가락 자리 덮기 그물. 손가락이 옆으로 당겨지거나 가늘어지면 원래 손가락이 그대로 남아 '손가락 두 개'처럼
 * 보이므로, 원래 손가락 자리를 양옆 배경으로 메운다.
 *   - 왼쪽 층: 손가락 바로 왼쪽 바깥 배경을 가로로 늘여 덮는다 (불투명)
 *   - 오른쪽 층: 바로 오른쪽 바깥 배경을 왼→오로 점점 진하게 덮는다
 *   → 줄마다 왼쪽 배경에서 오른쪽 배경으로 부드럽게 이어지는 색이 되어 손가락이 지워진 것처럼 보인다.
 *   가장자리는 원래 영상과 같은 색이라 이음매가 보이지 않는다.
 */
export class CoverMesh {
  constructor(rows = 12) {
    this.rows = rows;
    this.cols = MESH_COLS.length;
    const n = this.rows * this.cols;
    this.pos = new Float32Array(n * 2);
    this.srcL = new Float32Array(n * 2);
    this.srcR = new Float32Array(n * 2);
    this.alphaL = new Float32Array(n);
    this.alphaR = new Float32Array(n);
    this.indices = gridIndices(this.rows, this.cols);
  }

  /** @returns {CoverMesh} */
  build({ base, dir, len, width, cap, size }) {
    // 덮는 범위는 '원래 손가락이 있던 곳'만: 손가락 끝 살(cap)이 끝나면 곧바로 사라지고, 옆으로도 조금만 넉넉하게.
    // (넓게 덮으면 손가락이 아니던 배경까지 양옆 색이 섞여 뿌옇게 번진다)
    const s0 = 0.06 * len; // 손가락 뿌리 가까이부터 (휘어 나간 자리에 원래 손가락 토막이 남지 않게)
    const s1 = len + cap + COVER_TAIL * size; // 끝 살 바로 너머에서 다 사라진다
    const hw = 0.5 * width * COVER_SPAN; // 덮는 반폭
    const probe = hw + 0.06 * width; // 배경을 가져오는 곳 (덮는 곳 바로 바깥)
    const nx = -dir.y;
    const ny = dir.x;
    const cols = this.cols;
    const fadeEnd = COVER_FADE * size;
    for (let r = 0; r < this.rows; r++) {
      const s = lerp(s0, s1, r / (this.rows - 1));
      const cx = base.x + dir.x * s;
      const cy = base.y + dir.y * s;
      const ra = smoothstep(s0, s0 + 0.16 * len, s) * (1 - smoothstep(s1 - fadeEnd, s1, s));
      for (let c = 0; c < cols; c++) {
        const f = MESH_COLS[c];
        const v = r * cols + c;
        this.pos[v * 2] = cx + nx * f * hw;
        this.pos[v * 2 + 1] = cy + ny * f * hw;
        this.srcL[v * 2] = cx - nx * probe;
        this.srcL[v * 2 + 1] = cy - ny * probe;
        this.srcR[v * 2] = cx + nx * probe;
        this.srcR[v * 2 + 1] = cy + ny * probe;
        this.alphaL[v] = ra;
        this.alphaR[v] = ra * (f + 1) * 0.5;
      }
    }
    return this;
  }
}
