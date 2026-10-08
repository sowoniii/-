// 늘어나는 손가락 놀이의 상태·물리 계산 (순수 함수, DOM 없음 → node 에서 테스트).
//
// 좌표 약속: '손가락 좌표'는 손가락 뿌리가 원점, x 축이 원래 손가락 방향, 단위가 손 크기(hand.size)다.
// 손이 움직이거나 돌아가도 늘어난 손가락이 손에 붙어서 같이 움직이게 하려고 이 좌표에서 물리를 계산한다.

import { clamp, distToSegment, smoothstep, wrapAngle } from '../../core/math.js';
import { TIP_CAP } from './geometry.js';

// ---------------------------------------------------------------- 집기(잡기) 상태

/** 집기 판정 값. pinchDist(엄지-검지 거리 / 손 크기)에 여유(히스테리시스)를 둔다. */
export const GRIP = Object.freeze({ enter: 0.3, exit: 0.5, openDelay: 0.1 });
/** 뿅! 한 뒤 그 손이 잠깐 쉬는 시간(초). 뿅! 하는 순간 집은 점이 손가락 끝 바로 위라서, 쉬지 않으면 곧바로 다시 잡혀 버린다. */
export const SNAP_COOL = 0.7;

export function newGrip() {
  return { closed: false, justClosed: false, justOpened: false, openT: 0, closedT: 0, cool: 0 };
}

/**
 * 손 하나의 '꼭 집고 있는지' 상태를 한 프레임 진행한다.
 * - 엄지·검지가 가까워지는 순간 바로 닫힌다 (반응이 빨라야 아이가 알아챈다).
 * - 손 모양이 한두 프레임 흔들려도 openDelay 동안은 놓지 않는다.
 * - 주먹으로 꽉 쥐어도 잡은 것으로 본다 (아이들은 주먹으로 잡기도 한다).
 * - 잠깐 놓친(stale) 손은 상태를 그대로 둔다.
 * - cool(뿅! 뒤 쉬는 시간)은 시간이 지나거나 손을 펴면 끝난다. 손을 꼭 펴야 하는 숨은 규칙은 두지 않는다.
 */
export function stepGrip(g, hand, dt) {
  g.justClosed = false;
  g.justOpened = false;
  if (g.cool > 0) g.cool = Math.max(0, g.cool - dt);
  if (hand.stale) return g;
  const holdPose = hand.pose === 'pinch' || hand.pose === 'fist';
  if (!g.closed) {
    if (hand.pinchDist < GRIP.enter || holdPose) {
      g.closed = true;
      g.justClosed = true;
      g.openT = 0;
      g.closedT = 0;
    }
    return g;
  }
  g.closedT += dt;
  if (hand.pinchDist < GRIP.exit || holdPose) {
    g.openT = 0;
  } else {
    g.openT += dt;
    if (g.openT >= GRIP.openDelay) {
      g.closed = false;
      g.justOpened = true;
      g.cool = 0;
      g.openT = 0;
      g.closedT = 0;
    }
  }
  return g;
}

/**
 * 새로 잡힌 손(인식기가 id 를 새로 붙인 손)이 이미 '집고 있는' 손으로 볼 만한지.
 * 막 나타난 손은 집기 상태가 처음부터 시작이라 느슨하게 집은 손(0.3..0.5)을 놓치기 쉬워서, 놓기 기준(exit)으로 본다.
 */
export function looksHeld(hand) {
  return hand.pinchDist < GRIP.exit || hand.pose === 'pinch' || hand.pose === 'fist';
}

/** 이미 집고 있는 것으로 보고 집기 상태를 닫힌 채로 맞춘다 (손을 이어 붙일 때) */
export function forceClosed(g) {
  if (g.closed) return g;
  g.closed = true;
  g.justClosed = false;
  g.openT = 0;
  g.closedT = Math.max(g.closedT, 0.5);
  return g;
}

// ---------------------------------------------------------------- 손가락 끝 찾기

/**
 * 집은 점에서 가장 가까운 손가락 끝을 고른다.
 * 손가락 끝 마디(DIP→끝 너머 살까지) 선분까지의 거리로 재서, 끝을 조금 빗겨 집어도 잡히게 한다.
 * @param {{x:number,y:number}} p 집은 점
 * @param {{tip:{x,y}, dip:{x,y}, size:number, handId?:number}[]} candidates
 * @param {number} maxRel 손 크기 대비 최대 거리
 * @param {number} [excludeHandId] 이 손의 손가락은 빼고 (자기 손가락은 못 집는다)
 * @returns {{target:object, d:number}|null} d = 손 크기 대비 거리
 */
export function findTarget(p, candidates, maxRel, excludeHandId = null) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (excludeHandId !== null && c.handId === excludeHandId) continue;
    const ex = c.tip.x - c.dip.x;
    const ey = c.tip.y - c.dip.y;
    const l = Math.hypot(ex, ey) || 1;
    const cap = TIP_CAP * c.size;
    const far = { x: c.tip.x + (ex / l) * cap, y: c.tip.y + (ey / l) * cap };
    const d = distToSegment(p, c.dip, far) / c.size;
    if (d < maxRel && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best ? { target: best, d: bestD } : null;
}

/** 집은 점을 손가락 축에 비춰 '어디를 집었는지'(뿌리→끝 길이 대비 0.6..1)를 구한다. */
export function grabFraction(p, base, dir, len) {
  const s = (p.x - base.x) * dir.x + (p.y - base.y) * dir.y;
  return clamp(s / Math.max(len, 1e-6), 0.6, 1);
}

// ---------------------------------------------------------------- 손 기준 좌표

export function newFrame() {
  return { init: false, bx: 0, by: 0, theta: 0, size: 1, glitch: 0 };
}

/**
 * 손가락 뿌리 위치·손 방향·손 크기를 부드럽게 따라간다.
 * 인식이 한두 프레임 엉뚱한 곳으로 튀면(다른 손에 가려졌을 때 흔함) 그 프레임은 무시한다.
 */
export function followFrame(fr, base, theta, size, dt, lambda = 28) {
  if (!fr.init) {
    fr.bx = base.x;
    fr.by = base.y;
    fr.theta = theta;
    fr.size = size;
    fr.init = true;
    fr.glitch = 0;
    return fr;
  }
  const jump = Math.hypot(base.x - fr.bx, base.y - fr.by) / fr.size;
  const turn = Math.abs(wrapAngle(theta - fr.theta));
  if ((jump > 0.6 || turn > 0.9 || Math.abs(size / fr.size - 1) > 0.5) && fr.glitch < 3) {
    fr.glitch++;
    return fr;
  }
  fr.glitch = 0;
  const k = 1 - Math.exp(-lambda * dt);
  fr.bx += (base.x - fr.bx) * k;
  fr.by += (base.y - fr.by) * k;
  fr.theta = wrapAngle(fr.theta + wrapAngle(theta - fr.theta) * k);
  fr.size += (size - fr.size) * k;
  return fr;
}

/** 화면 px → 손가락 좌표 */
export function toLocal(fr, phi, p, out) {
  const a = fr.theta + phi;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = p.x - fr.bx;
  const dy = p.y - fr.by;
  out.x = (dx * c + dy * s) / fr.size;
  out.y = (-dx * s + dy * c) / fr.size;
  return out;
}

/** 손가락 좌표 → 화면 px */
export function toWorld(fr, phi, p, out) {
  const a = fr.theta + phi;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = p.x * fr.size;
  const y = p.y * fr.size;
  out.x = fr.bx + x * c - y * s;
  out.y = fr.by + x * s + y * c;
  return out;
}

// ---------------------------------------------------------------- 고무 물리

export const PHYS = Object.freeze({
  endK: 170, // 놓았을 때 손가락 끝 스프링 세기
  endC: 7.6, // 감쇠 (작을수록 오래 출렁임: 띠요옹~)
  ctrlK: 160, // 가운데(휘어짐) 스프링
  ctrlC: 11,
  follow: 35, // 잡고 있을 때 손가락 끝이 집은 점을 따라가는 빠르기
  minR: 0.45, // 아무리 눌러도 원래 길이의 이 비율보다 짧아지지 않음
  snapRatio: 6, // 이보다 길게 늘이면 '뿅!' 하고 저절로 돌아간다
  warnRatio: 4.4, // 이때부터 빨개지고 떨린다
  maxRelease: 2.6,
});

/** 2D 감쇠 스프링 한 단계 (작게 쪼개서 적분 → 큰 dt 에도 안정) */
export function springStep(p, v, tx, ty, k, c, dt) {
  const n = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const ax = -k * (p.x - tx) - c * v.x;
    const ay = -k * (p.y - ty) - c * v.y;
    v.x += ax * h;
    v.y += ay * h;
    p.x += v.x * h;
    p.y += v.y * h;
  }
}

/** 손가락 끝이 뿌리에 너무 가까워지지 않게 막는다. v 를 주면 안쪽으로 가던 속도를 통! 튕겨 낸다. */
export function clampEnd(e, v, minR) {
  const r = Math.hypot(e.x, e.y);
  if (r >= minR) return false;
  if (r < 1e-6) {
    e.x = minR;
    e.y = 0;
  } else {
    e.x *= minR / r;
    e.y *= minR / r;
  }
  if (v) {
    const nx = e.x / minR;
    const ny = e.y / minR;
    const vr = v.x * nx + v.y * ny;
    if (vr < 0) {
      v.x -= 1.4 * vr * nx;
      v.y -= 1.4 * vr * ny;
    }
  }
  return true;
}

/**
 * 베지에 조절점의 목표. 원래 손가락 방향(x 축) 위에 두어서, 옆으로 당기면 뿌리에서부터 고무처럼 휘게 한다.
 * 뒤로 당길수록(손바닥 쪽) 조절점을 뿌리 가까이 당겨 이상하게 꼬이지 않게 한다.
 */
export function ctrlTarget(ex, ey, out) {
  const D = Math.hypot(ex, ey);
  if (D < 1e-6) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const g = 0.3 + 0.7 * smoothstep(-1, 0.2, ex / D);
  out.x = 0.5 * D * g;
  out.y = 0;
  return out;
}

/**
 * 조절점이 곡선을 접히게(끝을 지나쳤다 돌아오게) 만들지 않도록, 뿌리→끝 방향 성분을 0.1..0.8 사이로,
 * 옆으로 벗어난 정도도 적당히 제한한다.
 */
export function clampCtrl(c, ex, ey, gs) {
  const D = Math.hypot(ex, ey);
  if (D < 1e-6) return;
  const ux = ex / D;
  const uy = ey / D;
  const along = c.x * ux + c.y * uy;
  const side = -c.x * uy + c.y * ux;
  const a = clamp(along, 0.1 * D, 0.8 * D);
  const lim = 0.8 * D + 0.5 * gs;
  const s = clamp(side, -lim, lim);
  c.x = a * ux - s * uy;
  c.y = a * uy + s * ux;
}

/**
 * 늘어나는 손가락 하나의 고무 상태 (손가락 좌표).
 *  - held: 끝이 집은 점을 따라간다. 가운데(조절점)는 스프링으로 살짝 늦게 따라와 고무처럼 출렁인다.
 *  - release: 끝이 원래 자리로 스프링처럼 돌아가며 띠요옹~ 출렁이다 멈춘다.
 */
export class Rubber {
  constructor(lrel, phi, gfrac = 1) {
    this.lrel = lrel;
    this.phi = phi;
    this.gfrac = gfrac;
    const gs = this.gs;
    this.end = { x: gs, y: 0 };
    this.endV = { x: 0, y: 0 };
    this.ctrl = ctrlTarget(gs, 0, { x: 0, y: 0 });
    this.ctrlV = { x: 0, y: 0 };
    this.phase = 'held';
    this.t = 0;
    this._tmp = { x: 0, y: 0 };
  }

  /** 원래 손가락에서 집은 곳까지 길이 (손 크기 단위) */
  get gs() {
    return this.lrel * this.gfrac;
  }

  /** 끝을 (tx, ty) 쪽으로 끌어당긴다. jitter: 너무 늘였을 때 부들부들 떨림 */
  hold(tx, ty, dt, jitter = 0) {
    this.t += dt;
    const k = 1 - Math.exp(-PHYS.follow * dt);
    const px = this.end.x;
    const py = this.end.y;
    this.end.x += (tx - this.end.x) * k;
    this.end.y += (ty - this.end.y) * k;
    clampEnd(this.end, null, PHYS.minR * this.gs);
    if (dt > 0) {
      this.endV.x += ((this.end.x - px) / dt - this.endV.x) * 0.4;
      this.endV.y += ((this.end.y - py) / dt - this.endV.y) * 0.4;
    }
    this._stepCtrl(dt, jitter);
  }

  release() {
    this.phase = 'release';
    this.t = 0;
    // 당기던 기세를 조금 남겨서 자연스럽게 이어지게
    this.endV.x *= 0.5;
    this.endV.y *= 0.5;
  }

  regrab() {
    this.phase = 'held';
    this.t = 0;
  }

  /** 놓은 뒤 한 단계. 다 멈췄으면 true */
  step(dt) {
    this.t += dt;
    const gs = this.gs;
    springStep(this.end, this.endV, gs, 0, PHYS.endK, PHYS.endC, dt);
    clampEnd(this.end, this.endV, PHYS.minR * gs);
    this._stepCtrl(dt, 0);
    const d = Math.hypot(this.end.x - gs, this.end.y);
    const v = Math.hypot(this.endV.x, this.endV.y);
    const ct = ctrlTarget(this.end.x, this.end.y, this._tmp);
    const cd = Math.hypot(this.ctrl.x - ct.x, this.ctrl.y - ct.y);
    return (d < 0.012 && v < 0.08 && cd < 0.03) || this.t > PHYS.maxRelease;
  }

  /** 지금 끝이 원래 자리에서 얼마나 멀리 있는지 (손 크기 단위) */
  get displacement() {
    return Math.hypot(this.end.x - this.gs, this.end.y);
  }

  _stepCtrl(dt, jitter) {
    const t = ctrlTarget(this.end.x, this.end.y, this._tmp);
    springStep(this.ctrl, this.ctrlV, t.x, t.y + jitter, PHYS.ctrlK, PHYS.ctrlC, dt);
    clampCtrl(this.ctrl, this.end.x, this.end.y, this.gs);
  }
}

/**
 * '얼마나 세게 당겼는지' (뿅! 판정용). 곡선 길이 비율을 쓰되, 빠르게 휘두를 때 가운데가 잠깐 출렁여서
 * 곡선이 길어진 것만으로는 뿅! 하지 않도록 뿌리→끝 직선 거리 비율로 상한을 둔다.
 */
export function pullAmount(ratio, end, gs) {
  return Math.min(ratio, (1.15 * Math.hypot(end.x, end.y)) / Math.max(gs, 1e-6));
}

/** 잡고 있을 때 안내 단계: 0 당겨 봐요, 1 우와 길다, 2 조심! 경계에서 흔들려도 안내가 깜빡이지 않게 여유를 둔다. */
export const HINT_LEVELS = Object.freeze({ long: 2.4, longExit: 2.1, warnExit: 4.1 });

export function hintLevel(prev, ratio, pull) {
  if (pull > (prev >= 2 ? HINT_LEVELS.warnExit : PHYS.warnRatio)) return 2;
  if (ratio > (prev >= 1 ? HINT_LEVELS.longExit : HINT_LEVELS.long)) return 1;
  return 0;
}

/** 놓았을 때 '띠용' 소리 높이: 길게 늘였을수록 낮고 굵게 */
export function boingPitch(ratio) {
  return clamp(1.45 - 0.13 * ratio, 0.65, 1.3);
}

/** 원래 손가락 자리를 배경으로 덮을 정도 0..1 (옆으로 휘었거나, 가늘어졌거나, 짧아졌을 때) */
export function coverAmount(deviationPx, widthPx, ratio) {
  return Math.max(
    smoothstep(0.22, 0.75, deviationPx / Math.max(widthPx, 1e-6)),
    smoothstep(1.15, 1.7, ratio),
    smoothstep(0.96, 0.8, ratio),
  );
}
