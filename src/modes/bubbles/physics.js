// 비눗방울 놀이의 순수 로직 (DOM 없음 → node 에서 테스트할 수 있다)
//
//  - 펼친 손 = 비눗방울 막대: 손바닥에서 방울이 부풀었다가 똑 떨어져 둥실 날아간다.
//  - 펼친 손을 휘두르면 더 크고 많은 방울이 손이 움직이는 쪽으로 날아가고, 근처 방울을 바람으로 민다.
//    아주 세게 휙 휘둘러 방울을 치면 (자기가 막 분 방울이 아니면) 터진다.
//  - 펼치지 않은 손(가리키기/브이/주먹/집기/그 밖)의 손가락 끝에 닿으면 → 뽁! (콕 찌르기)
//  - 손을 꽉 쥐거나(주먹) 집으면 손 안/집은 곳 근처 방울과 손바닥에서 부풀던 방울이 → 잡았다!
//  - 오래된 방울, 화면 위로 나가는 방울은 저절로 터진다 (점수에 안 셈).
//
// 실제 카메라는 흔들리고 가끔 손을 놓치므로: 거리는 손 크기에 비례, 손별 상태는 hand.id 로,
// 잠깐 손 모양이 바뀌어도 부풀던 방울을 바로 놓지 않는 여유 시간, 사라진 손은 정리.
// 카메라가 불던 손을 몇 프레임 주먹·브이 등으로 잘못 보는 일이 잦으므로:
//   방울마다 불어 낸 손(owner)을 기억해 그 손이 막 분 방울은 손가락으로 안 터뜨리고,
//   손끝이 '쓸고 지나간 길'은 손 전체가 움직인 만큼만 본다 (손 모양이 바뀌며 손끝이 휙 옮겨진 건 빼고),
//   내 방울만 손 안에 있을 땐 주먹을 잠깐 유지해야 잡힌다.
// 손 속도는 추적기 값 대신 손바닥 위치로 직접 잰다 (잠깐 놓쳤다 다시 찾은 순간 튀지 않게).

import { clamp, lerp, smoothstep, distToSegment, TAU } from '../../core/math.js';

export const CFG = Object.freeze({
  maxBubbles: 60,
  /** 막 나온 방울은 이 시간(초) 동안 손에 안 터진다 */
  immune: 0.8,
  life: [8, 12],
  ambientLife: [12, 18],
  /** 손 크기 대비 방울 반지름 범위 */
  radiusK: [0.2, 0.7],
  /** 가만히 불 때 반지름 (손 크기 대비) */
  baseRadiusK: [0.26, 0.4],
  /** 세게 흔들 때 더해지는 반지름 */
  waveBonusK: 0.3,
  /** 처음 부풀기 시작할 때 반지름 (손 크기 대비) */
  startRadiusK: 0.1,
  /** 부푸는 시간: [가만히, 세게 흔들 때] */
  growTime: [0.36, 0.22],
  /** 다음 방울까지 쉬는 시간 */
  cooldown: [0.07, 0.03],
  /** 손 속도(손 크기/초) → 흔들기 정도 0..1 */
  waveSpeed: [1.0, 4.5],
  /** 이 속도(손 크기/초)보다 빠르면 덜 부푼 방울도 똑 떨어진다 */
  snapSpeed: 5.5,
  /** 최대로 흔들 때 초당 작은 방울 수 */
  trailRate: 9,
  trailRadiusK: [0.2, 0.3],
  /** 손 모양이 잠깐 바뀌어도(잘못 보인 프레임 포함) 부풀던 방울을 손바닥에 붙잡고 있는 시간 — 주먹/집기는 잡기 판정이 정한다 */
  releaseGrace: 0.25,
  /** 손을 오므렸을 때 이만큼 이상 부푼 방울은 날려 보낸다 (작으면 사르르 사라짐) */
  minReleaseGrow: 0.45,
  /** 주먹/집기를 시작한 뒤 잡기 판정을 하는 시간 */
  catchWindow: 0.3,
  /** 잡기 범위: 방울 반지름 + 손 크기 × 이 값 */
  catchReach: 0.5,
  /** 펼쳤던 손을 오므리는 중(이 시간 안)에 손바닥 근처 방울에 닿으면 '잡기'로 친다 */
  closeWindow: 0.45,
  /** 떨어져 나갈 때 밀어내는 속도 = 화면 높이 × [가만히, 흔들 때] (px/초) */
  launchK: [0.2, 0.28],
  /** 떨어져 나가는 방향을 좌우로 번갈아 벌리는 각도(라디안) [최소, 최대] */
  fan: [0.15, 0.6],
  /** 손가락 끝 두께 (손 크기 비율) */
  tipRadius: 0.1,
  /** 새로 나타난 손은 모양이 정해질 때까지 찌르지 않는다 (시간과 프레임 수 둘 다: 화면이 느려도 안전하게) */
  pokeMinAge: 0.2,
  pokeMinFrames: 5,
  /** 공기 저항 (1/초) */
  drag: 1.3,
  /** 떠오르는 속도 = 화면 높이 × 이 값 (px/초) */
  driftK: 0.05,
  /** 좌우 살랑 속도 = 화면 높이 × 이 값 */
  swayK: 0.035,
  bounce: 0.55,
  /** 방울 중심이 화면 위에서 반지름 × 이 값 안으로 가면 (거의 나가면) 터진다 */
  ceilingK: 0.15,
  /** 바람: 손 속도(손 크기/초) [시작, 최대] */
  windSpeed: [1.5, 4],
  /** 바람이 닿는 거리 (손 크기 비율) */
  windReach: 1.6,
  /** 아무도 없을 때 떠다니는 방울 수 / 손은 있지만 아무도 안 불 때 */
  ambientIdle: 6,
  ambientPlay: 3,
  ambientIdleAfter: 1.0,
  ambientInterval: [0.9, 1.7],
  /** 너무 빠른 속도는 자른다 (추적 튐 방지) — 화면 높이 × 이 값 px/초 */
  maxSpeedK: 3,
  /** 방울을 던지는 데 쓰는 손 속도 상한 (손 크기/초) — 추적이 튀어도 방울이 총알처럼 날아가지 않게 */
  flingMax: 7,
  /** 방울 반지름의 화면 기준 하한·상한 (화면 짧은 변 비율) — 멀리 있는 작은 손도 찌를 만한 크기로, 아주 가까운 손도 화면을 덮지 않게 */
  screenRadiusK: [0.028, 0.22],
  /** 떠다니는 방울 반지름 (화면 짧은 변 비율) */
  ambientRadiusK: [0.045, 0.085],
  // ---- 내 방울 지키기: 카메라가 펼친 손을 잠깐 주먹·브이 등으로 잘못 보면, 그 손이 막 불던 방울을 터뜨려 버린다
  /** 이 시간(초) 안에 펼쳐져 있던 손은 자기가 분 방울을 손가락으로 안 터뜨린다 (방금까지 불던 손) */
  ownerOpenGap: 0.45,
  /** 자기 방울이 이보다 어리고(초) 손바닥에서 손 크기 × ownerClear 안에 있으면 손가락으로 안 터뜨린다 */
  ownerTime: 1.5,
  ownerClear: 1.2,
  /** 자기 방울은 주먹/집기를 이만큼(초) 유지해야 잡힌다 — 몇 프레임 잘못 보인 주먹은 무시 */
  ownCatchHold: 0.18,
  // ---- 손 속도: 추적기가 잠깐 놓쳤다 다시 찾으면 속도가 튀므로, 손바닥 위치를 이 시간 창(초)으로 직접 잰다
  velWindow: 0.1,
  // ---- 손바닥으로 치기: 펼친 손을 휙 휘둘러 방울을 치면 터진다 (천천히 움직이는 펼친 손은 불기만 한다)
  /** 이 속도(손 크기/초)보다 빠른 펼친 손 */
  swatSpeed: 3.5,
  /** 손바닥+손가락 판의 반지름 (손 크기 비율), 판 중심은 손바닥에서 가운뎃손가락 끝 쪽으로 이 비율만큼 */
  swatRadius: 0.5,
  swatCenter: 0.4,
  /** 이보다 크게(손 크기 비율) 튄 이동은 추적이 튄 것 → 쓸고 지나간 걸로 치지 않는다 */
  jumpK: 1.5,
});

const SCREEN_UP = { x: 0, y: -1 };

/** 흔들기 정도 0..1 (손 속도를 손 크기로 나눠서 아이/어른/거리와 상관없게) */
export function waveAmount(velocity, size) {
  const speed = Math.hypot(velocity.x, velocity.y) / Math.max(size, 1);
  return smoothstep(CFG.waveSpeed[0], CFG.waveSpeed[1], speed);
}

/** 흔들기 정도에 따른 막대 설정: 부푸는 시간, 쉬는 시간, 반지름 범위(손 크기 대비) */
export function wandParams(wave) {
  const w = clamp(wave);
  return {
    growTime: lerp(CFG.growTime[0], CFG.growTime[1], w),
    cooldown: lerp(CFG.cooldown[0], CFG.cooldown[1], w),
    radiusMinK: clamp(CFG.baseRadiusK[0] + CFG.waveBonusK * w, CFG.radiusK[0], CFG.radiusK[1]),
    radiusMaxK: clamp(CFG.baseRadiusK[1] + CFG.waveBonusK * w, CFG.radiusK[0], CFG.radiusK[1]),
    trailRate: w > 0.2 ? CFG.trailRate * w : 0,
  };
}

/** 방울이 나오는 방향: 손가락 쪽과 화면 위쪽의 중간 (단위벡터) */
export function blowDir(hand) {
  const lm = hand.lm;
  let ux = 0;
  let uy = -1;
  if (lm && lm[0] && lm[9]) {
    const dx = lm[9].x - lm[0].x;
    const dy = lm[9].y - lm[0].y;
    const l = Math.hypot(dx, dy);
    if (l > 1e-6) {
      ux = dx / l;
      uy = dy / l;
    }
  }
  const x = ux * 0.5 + SCREEN_UP.x * 0.5;
  const y = uy * 0.5 + SCREEN_UP.y * 0.5;
  const l = Math.hypot(x, y);
  return l > 1e-6 ? { x: x / l, y: y / l } : { x: 0, y: -1 };
}

/** 방울을 던질 때 쓰는 손 속도 (너무 빠르면 손 크기 × flingMax 로 자른다) */
export function flingVelocity(velocity, size) {
  const max = Math.max(size, 1) * CFG.flingMax;
  const sp = Math.hypot(velocity.x, velocity.y);
  return sp > max ? { x: (velocity.x * max) / sp, y: (velocity.y * max) / sp } : { x: velocity.x, y: velocity.y };
}

/** 손 크기에 맞춘 방울 반지름을 화면 기준 하한·상한 안으로 */
export function clampRadius(r, width, height) {
  const m = Math.min(width, height);
  return clamp(r, m * CFG.screenRadiusK[0], m * CFG.screenRadiusK[1]);
}

/** 살짝 넘쳤다가 돌아오는 부풀기 곡선 (0..1 → 0..1, 1 에서 정확히 1) */
export function easeOutBack(p) {
  const c = 1.4;
  const x = clamp(p) - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}

/** 손가락 끝이 지난 위치(prev)에서 지금(cur)까지 쓸고 지나간 길이 방울에 닿았는지 */
export function sweptHit(b, prev, cur, tipR) {
  return distToSegment(b, prev, cur) < b.r * 0.95 + tipR;
}

/** 손의 방향(라디안): 손목 → 가운뎃손가락 뿌리 */
export function handAngle(h) {
  const lm = h.lm;
  if (!lm || !lm[0] || !lm[9]) return -Math.PI / 2;
  return Math.atan2(lm[9].y - lm[0].y, lm[9].x - lm[0].x);
}

/** 손 전체의 자리(손바닥 위치·방향·크기)를 out 에 적는다 — 프레임 사이 손이 어떻게 옮겨졌는지 비교용 */
export function handFrame(h, out = { x: 0, y: 0, ang: 0, size: 1 }) {
  out.x = h.palm.x;
  out.y = h.palm.y;
  out.ang = handAngle(h);
  out.size = Math.max(h.size, 1);
  return out;
}

/**
 * 손가락 끝이 '손 전체가 움직여서' 쓸고 지나온 길의 시작점 (끝점은 지금 손끝 cur).
 * 손바닥이 옮겨지고·돌아가고·커진 만큼만 손끝을 따라 옮겨 보고, 그 이동만큼 cur 에서 거슬러 올라간다.
 * 손 모양이 바뀌며(펼침↔오므림, 카메라가 잠깐 잘못 본 프레임) 손끝이 휙 옮겨진 것은 진짜로 쓸고 간 게
 * 아니므로 빠진다 — 그런 프레임엔 지금 손끝 자리만 본다. 추적이 크게 튀었으면 역시 지금 자리만.
 */
export function carriedStart(prevTip, prevFrame, curFrame, cur, out = { x: 0, y: 0 }) {
  const s = curFrame.size / Math.max(prevFrame.size, 1e-6);
  let da = curFrame.ang - prevFrame.ang;
  if (da > Math.PI) da -= TAU;
  else if (da < -Math.PI) da += TAU;
  const c = Math.cos(da);
  const sn = Math.sin(da);
  const rx = (prevTip.x - prevFrame.x) * s;
  const ry = (prevTip.y - prevFrame.y) * s;
  // 손이 손끝을 데려다 놓았을 자리 - 지난 손끝 = 손이 옮겨 준 만큼
  const dx = curFrame.x + rx * c - ry * sn - prevTip.x;
  const dy = curFrame.y + rx * sn + ry * c - prevTip.y;
  if (Math.hypot(dx, dy) > curFrame.size * CFG.jumpK) {
    out.x = cur.x;
    out.y = cur.y;
  } else {
    out.x = cur.x - dx;
    out.y = cur.y - dy;
  }
  return out;
}

/**
 * 손이 이 방울을 손가락으로 터뜨리면 안 되는지: 자기가 분 방울인데
 *  - 방금까지 펼쳐서 불던 손이거나 (잘못 보인 손 모양 / 막 오므리는 중),
 *  - 방울이 아직 어리고 손바닥 가까이 떠 있을 때.
 * @param {number} lastOpen 그 손이 마지막으로 펼쳐져 있던 시각
 */
export function ownGuard(b, h, lastOpen, t) {
  if (b.owner !== h.id) return false;
  if (t - lastOpen < CFG.ownerOpenGap) return true;
  return t - b.born < CFG.ownerTime && Math.hypot(b.x - h.palm.x, b.y - h.palm.y) < CFG.ownerClear * h.size;
}

/** 펼친 손으로 휙 쳐서 터뜨릴 수 있는 방울인지 (자기가 막 분 방울은 빼고) */
export function swatTarget(b, handId, t) {
  return !(b.owner === handId && t - b.born < CFG.ownerTime);
}

/** 손바닥+손가락 판의 중심 (펼친 손으로 칠 때 닿는 곳) */
export function swatCenter(h, out = { x: 0, y: 0 }) {
  const tip = h.tips && h.tips[2];
  const k = tip ? CFG.swatCenter : 0;
  out.x = h.palm.x + ((tip ? tip.x : h.palm.x) - h.palm.x) * k;
  out.y = h.palm.y + ((tip ? tip.y : h.palm.y) - h.palm.y) * k;
  return out;
}

/**
 * 손바닥 속도를 직접 잰다: 지금 위치와 velWindow 초 전 위치의 차이 ÷ 실제로 지난 시간.
 * 추적기가 몇 프레임 놓쳤다 다시 찾아도 '여러 프레임 동안의 이동 ÷ 실제 시간'이라 튀지 않는다.
 * 고정 크기 고리 버퍼라 매 프레임 메모리를 새로 잡지 않는다. (x, y) 가 속도 px/초.
 */
export class PalmVelocity {
  constructor(window = CFG.velWindow, n = 16) {
    this.window = window;
    this.n = n;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.ts = new Float64Array(n);
    this.head = 0;
    this.count = 0;
    this.x = 0;
    this.y = 0;
  }

  push(x, y, t) {
    const n = this.n;
    // 같은 시각이 또 들어오면 덮어쓴다
    const last = (this.head - 1 + n) % n;
    if (this.count && this.ts[last] >= t) {
      this.xs[last] = x;
      this.ys[last] = y;
    } else {
      this.xs[this.head] = x;
      this.ys[this.head] = y;
      this.ts[this.head] = t;
      this.head = (this.head + 1) % n;
      this.count = Math.min(this.count + 1, n);
    }
    // 창 길이 이상 지난 가장 최근 표본 (아직 없으면 가장 오래된 표본)
    let j = -1;
    for (let k = 1; k < this.count; k++) {
      j = (this.head - 1 - k + n * 2) % n;
      if (t - this.ts[j] >= this.window) break;
    }
    if (j < 0 || t - this.ts[j] < 1e-4) {
      this.x = 0;
      this.y = 0;
    } else {
      this.x = (x - this.xs[j]) / (t - this.ts[j]);
      this.y = (y - this.ys[j]) / (t - this.ts[j]);
    }
    return this;
  }
}

/** 잡기 범위 안에 있는지 */
export function inCatchReach(b, point, handSize) {
  return Math.hypot(b.x - point.x, b.y - point.y) < b.r + CFG.catchReach * handSize;
}

/** 지금 떠다녀야 할 방울 수 */
export function ambientTarget(idleTime, liveHands, anyOpen) {
  if (!liveHands) return idleTime > CFG.ambientIdleAfter ? CFG.ambientIdle : 0;
  return anyOpen ? 0 : CFG.ambientPlay;
}

/** 말랑 흔들림 스프링 + 무지개 막 회전 (모든 방울 공통) */
export function stepJiggle(b, dt) {
  b.jigV += (-170 * b.jig - 5 * b.jigV) * dt;
  b.jig = clamp(b.jig + b.jigV * dt, -0.22, 0.22);
  b.film += b.spin * dt;
}

/**
 * 떠다니는 방울 하나를 움직인다 (떠오름, 살랑, 공기 저항, 벽 튕김).
 * @returns {'age'|'ceiling'|null} 저절로 터져야 하면 그 이유
 */
export function stepFree(b, dt, t, W, H, rng = Math.random) {
  const drift = -H * CFG.driftK * (0.65 + 0.7 * b.lift) * (b.kind === 'ambient' ? 0.75 : 1);
  const sway = Math.sin(t * b.swayF * TAU + b.phase) * H * CFG.swayK;
  const k = 1 - Math.exp(-CFG.drag * dt);
  b.vx += (sway - b.vx) * k;
  b.vy += (drift - b.vy) * k;
  const vmax = H * CFG.maxSpeedK;
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > vmax) {
    b.vx *= vmax / sp;
    b.vy *= vmax / sp;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  // 벽에 닿으면 통 튕기며 말랑
  if (b.x < b.r) {
    b.x = b.r;
    if (b.vx < 0) {
      kick(b, Math.min(0.9, -b.vx / (H * 0.6)), 0);
      b.vx = -b.vx * CFG.bounce;
    }
  } else if (b.x > W - b.r) {
    b.x = W - b.r;
    if (b.vx > 0) {
      kick(b, Math.min(0.9, b.vx / (H * 0.6)), 0);
      b.vx = -b.vx * CFG.bounce;
    }
  }
  // 아래쪽은 내려올 때만 튕긴다 (아래에서 올라오는 방울은 통과)
  if (b.y > H - b.r && b.vy > 0) {
    b.y = H - b.r;
    kick(b, Math.min(0.9, b.vy / (H * 0.6)), Math.PI / 2);
    b.vy = -b.vy * CFG.bounce;
  }
  const age = t - b.born;
  // 터지기 직전엔 파르르 떤다
  if (age > b.life - 0.5) b.jigV += (rng() - 0.5) * 18 * dt;
  if (age > b.life) return 'age';
  if (b.y < b.r * CFG.ceilingK && t >= b.immuneUntil) return 'ceiling';
  return null;
}

/** 말랑 흔들기: 방향(angle)으로 찌그러졌다 돌아온다 */
export function kick(b, amount, angle) {
  b.jigV += amount * 2.2;
  b.axis = angle;
}

/**
 * 펼친 손이 움직이면 근처 방울이 손이 움직이는 쪽으로 밀려간다 (바람).
 * @param {{x:number,y:number}} [velocity] 믿을 만한 손 속도 (놀이에서는 PalmVelocity 로 잰 값을 넘긴다)
 * @returns {number} 바람 세기 0..1
 */
export function applyWind(bubbles, hand, dt, velocity = hand.velocity) {
  const v = flingVelocity(velocity, hand.size);
  const s = smoothstep(CFG.windSpeed[0], CFG.windSpeed[1], Math.hypot(v.x, v.y) / Math.max(hand.size, 1));
  if (s <= 0) return 0;
  const reach = hand.size * CFG.windReach;
  for (const b of bubbles) {
    if (b.dead || b.attached !== null) continue;
    const d = Math.hypot(b.x - hand.palm.x, b.y - hand.palm.y) - b.r * 0.5;
    if (d > reach) continue;
    const f = (1 - Math.max(0, d) / reach) ** 2 * s;
    const k = 1 - Math.exp(-7 * f * dt);
    b.vx += (v.x * 0.8 - b.vx) * k;
    b.vy += (v.y * 0.8 - b.vy) * k;
    b.jigV += f * dt * 4;
  }
  return s;
}

/**
 * 방울끼리 살짝 밀어내서 겹치지 않게 한다 (큰 방울은 덜 밀린다).
 * 손에서 부푸는 방울은 움직이지 않고, 갓 나온 방울(t < immuneUntil)만 옆으로 밀어낸다 —
 * 손바닥에 방울이 쌓이지 않게 하면서도, 잡으려는 방울을 밀어내지는 않게.
 */
export function separate(bubbles, dt, t = Infinity) {
  const k = Math.min(1, 10 * dt);
  const n = bubbles.length;
  for (let i = 0; i < n; i++) {
    const a = bubbles[i];
    if (a.dead) continue;
    for (let j = i + 1; j < n; j++) {
      const b = bubbles[j];
      if (b.dead) continue;
      const aFixed = a.attached !== null;
      const bFixed = b.attached !== null;
      if (aFixed && bFixed) continue;
      if ((aFixed && t >= b.immuneUntil) || (bFixed && t >= a.immuneUntil)) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const minD = (a.r + b.r) * 0.92;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-3) {
        // 정확히 겹치면 id 로 정한 방향으로 민다
        const ang = (a.id * 2.399 + b.id * 1.13) % TAU;
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        d = 1;
      }
      const nx = dx / d;
      const ny = dy / d;
      const push = (minD - Math.min(d, minD)) * k;
      const ma = a.r * a.r;
      const mb = b.r * b.r;
      const wa = aFixed ? 0 : bFixed ? 1 : mb / (ma + mb);
      const wb = bFixed ? 0 : aFixed ? 1 : ma / (ma + mb);
      a.x -= nx * push * wa;
      a.y -= ny * push * wa;
      b.x += nx * push * wb;
      b.y += ny * push * wb;
      // 서로 다가오는 속도를 줄여 통통 튕기듯
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel < 0) {
        const imp = -rel * 0.6;
        a.vx -= nx * imp * wa;
        a.vy -= ny * imp * wa;
        b.vx += nx * imp * wb;
        b.vy += ny * imp * wb;
        const ang = Math.atan2(ny, nx);
        if (!aFixed) {
          a.jigV += imp * 0.004 * wa;
          a.axis = ang;
        }
        if (!bFixed) {
          b.jigV += imp * 0.004 * wb;
          b.axis = ang;
        }
      }
    }
  }
}

/**
 * 비눗방울 세상. update() 가 손 정보를 받아 상태를 바꾸고 일어난 사건 목록을 돌려준다.
 * 사건: {type:'grow'|'detach'|'trail'|'ambient', b, handId?} / {type:'pop', b, cause, handId, counted, x, y, r}
 *       / {type:'catch', handId, x, y, n, pose}
 *   pop cause: 'poke' 콕 | 'swat' 펼친 손으로 휙 | 'catch' 잡기 (이 셋만 점수)
 *              | 'age' 오래됨 | 'ceiling' 위로 나감 | 'crowd' 너무 많음 | 'fizzle' 덜 부푼 방울 사라짐
 * 방울마다 owner(불어 낸 손 id)를 붙여서, 카메라가 손 모양을 잠깐 잘못 봐도 그 손이 막 분 방울을 터뜨리지 않게 한다.
 */
export class BubbleWorld {
  constructor({ width = 1280, height = 720, rng = Math.random } = {}) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.rng = rng;
    /** @type {object[]} */
    this.bubbles = [];
    /** hand.id → 막대 상태 */
    this.wands = new Map();
    this.stats = { emitted: 0, trail: 0, popped: 0, poked: 0, swatted: 0, caught: 0, natural: 0, ambient: 0, released: 0, waveTime: 0 };
    /** 잡기 판정용 (매 프레임 새로 만들지 않게) */
    this._catchList = [];
    this._tmp = { x: 0, y: 0 };
    /** 가장 세게 흔드는 손의 흔들기 정도 (바람 소리용) */
    this.wave = 0;
    this._nextId = 1;
    this._now = 0;
    this._idleT = 0;
    this._ambientT = 0;
    this._seen = new Set();
  }

  _rand(a, b) {
    return a + this.rng() * (b - a);
  }

  resize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    for (const b of this.bubbles) {
      b.x = clamp(b.x, b.r, Math.max(b.r, this.width - b.r));
      if (b.y > this.height - b.r && b.kind !== 'ambient') b.y = Math.max(b.r, this.height - b.r);
    }
  }

  /** 점수·통계를 처음으로 (새 친구가 왔을 때) */
  resetStats() {
    for (const k of Object.keys(this.stats)) this.stats[k] = 0;
  }

  /** 살아 있는(아직 안 터진) 방울 수 */
  get count() {
    let n = 0;
    for (const b of this.bubbles) if (!b.dead) n++;
    return n;
  }

  _newBubble(x, y, r, kind, t) {
    const L = kind === 'ambient' ? CFG.ambientLife : CFG.life;
    return {
      id: this._nextId++,
      kind,
      x,
      y,
      vx: 0,
      vy: 0,
      r,
      rTarget: r,
      born: t,
      life: this._rand(L[0], L[1]),
      immuneUntil: kind === 'ambient' ? t : t + CFG.immune,
      attached: null,
      /** 불어 낸 손 id (떠다니는 방울은 null) */
      owner: null,
      /** 손바닥을 떠난 시각 (아니면 -1) — 막 떨어져 나간 방울도 그 손이 곧바로 주먹을 쥐면 잡을 수 있게 */
      letGoAt: -1,
      grow: 1,
      growTime: 0.4,
      startR: r,
      lift: this.rng(),
      phase: this.rng() * TAU,
      swayF: this._rand(0.12, 0.3),
      breathF: this._rand(1.4, 2.4),
      film: this.rng() * TAU,
      spin: this._rand(0.25, 0.6) * (this.rng() < 0.5 ? -1 : 1),
      hue: this.rng(),
      jig: 0,
      jigV: 0,
      axis: this.rng() * TAU,
      dead: false,
    };
  }

  _compact() {
    let j = 0;
    for (let i = 0; i < this.bubbles.length; i++) {
      const b = this.bubbles[i];
      if (!b.dead) this.bubbles[j++] = b;
    }
    this.bubbles.length = j;
  }

  _add(b, events) {
    if (this.bubbles.length >= CFG.maxBubbles) this._compact();
    if (this.bubbles.length >= CFG.maxBubbles) {
      // 가장 오래된 떠다니는 방울을 터뜨려 자리를 만든다
      let oldest = null;
      for (const o of this.bubbles) if (!o.dead && o.attached === null && (!oldest || o.born < oldest.born)) oldest = o;
      if (!oldest) return false;
      this._pop(oldest, 'crowd', null, events);
      this._compact();
    }
    this.bubbles.push(b);
    return true;
  }

  _pop(b, cause, handId, events) {
    if (b.dead) return;
    b.dead = true;
    const counted = cause === 'poke' || cause === 'catch' || cause === 'swat';
    if (counted) {
      this.stats.popped++;
      if (cause === 'catch') this.stats.caught++;
      else if (cause === 'swat') this.stats.swatted++;
      else this.stats.poked++;
    } else if (cause !== 'fizzle') {
      this.stats.natural++;
    }
    events.push({ type: 'pop', b, cause, handId, counted, x: b.x, y: b.y, r: b.r });
  }

  _canPop(b, t) {
    return !b.dead && b.attached === null && t >= b.immuneUntil;
  }

  /** 화면 아래(또는 화면 안)에서 떠오르는 방울 하나 */
  spawnAmbient(t, events = [], onScreen = false) {
    const m = Math.min(this.width, this.height);
    const r = m * this._rand(CFG.ambientRadiusK[0], CFG.ambientRadiusK[1]);
    const x = this._rand(0.08, 0.92) * this.width;
    const y = onScreen ? this._rand(0.25, 0.8) * this.height : this.height + r;
    const b = this._newBubble(x, y, r, 'ambient', t);
    b.vy = -this.height * CFG.driftK * 0.75;
    if (this._add(b, events)) {
      this.stats.ambient++;
      events.push({ type: 'ambient', b });
    }
    return b;
  }

  _wand(h) {
    let w = this.wands.get(h.id);
    if (!w) {
      w = {
        id: h.id,
        growing: null,
        cooldown: 0,
        nonOpen: 0,
        trailAcc: 0,
        /** 주먹/집기를 막 시작해서 잡기 판정 중인지, 그 손 모양 */
        catching: false,
        catchPose: null,
        wave: 0,
        prevTips: [0, 1, 2, 3, 4].map(() => ({ x: 0, y: 0 })),
        /** 지난 프레임 손의 자리 (손바닥·방향·크기) / 손바닥 판 중심 */
        prevFrame: { x: 0, y: 0, ang: 0, size: 1 },
        curFrame: { x: 0, y: 0, ang: 0, size: 1 },
        prevDisc: { x: 0, y: 0 },
        disc: { x: 0, y: 0 },
        hasPrev: false,
        made: 0,
        lastOpen: -Infinity,
        /** 놓치지 않고 본 프레임 수 (손 모양 안정화는 프레임 단위라서) */
        frames: 0,
        /** 직접 잰 손바닥 속도 / 그걸 너무 빠르지 않게 자른 값 (px/초) */
        vel: new PalmVelocity(),
        v: { x: 0, y: 0 },
      };
      this.wands.set(h.id, w);
    }
    return w;
  }

  /**
   * 부풀던 방울 놓기 (손을 오므렸거나 손이 사라짐).
   * @param {boolean} [letGo] 손은 그대로 있는데 오므려서 놓친 것 → 곧바로 주먹을 쥐면 잡을 수 있다
   */
  _release(w, t, events, letGo = false) {
    const b = w.growing;
    w.growing = null;
    if (!b || b.dead) return;
    if (b.grow >= CFG.minReleaseGrow) {
      b.attached = null;
      b.rTarget = b.r;
      b.born = t;
      b.immuneUntil = t + CFG.immune;
      b.vx *= 0.3;
      b.vy = b.vy * 0.3 - this.height * 0.03;
      b.letGoAt = t;
      kick(b, 0.15, Math.PI / 2);
      this.stats.emitted++;
      if (letGo) this.stats.released++;
      events.push({ type: 'detach', b, handId: w.id, wave: 0 });
    } else {
      this._pop(b, 'fizzle', w.id, events);
    }
  }

  /** 손바닥에서 방울 쪽으로 밀려 나온 자리에 부푸는 방울을 둔다 */
  _placeOnPalm(b, h, dir, size) {
    const off = b.r * 0.55 + size * 0.04;
    b.x = h.palm.x + dir.x * off;
    b.y = h.palm.y + dir.y * off;
    b.vx = 0;
    b.vy = 0;
    b.axis = Math.atan2(dir.y, dir.x);
  }

  _updateWand(w, h, dt, t, events) {
    const size = Math.max(h.size, 1);
    // 잠깐 놓친 손: 마지막 모습 그대로 멈춰 둔다
    if (h.stale) {
      w.wave = 0;
      return;
    }
    // 손 속도는 추적기 값 대신 직접 잰 값 (잠깐 놓쳤다 다시 찾은 순간에도 튀지 않게), 너무 빠르면 자른다
    const fv = flingVelocity(w.vel.push(h.palm.x, h.palm.y, this._now), size);
    w.v.x = fv.x;
    w.v.y = fv.y;
    const wave = waveAmount(w.v, size);
    const open = h.pose === 'open';
    w.wave = open ? wave : 0;
    w.frames++;
    if (!open) {
      w.nonOpen += dt;
      w.trailAcc = 0;
      const g = w.growing;
      if (g && !g.dead) {
        // 손을 잠깐 오므려도 부풀던 방울은 손바닥을 따라다닌다 (그 자리에 멈춰 있다가 혼자 날아가지 않게).
        // 주먹/집기면 잡기 판정이 방울을 정한다 (잡았다! 또는 사르르), 그 밖의 모양이 오래가면 날려 보낸다.
        this._placeOnPalm(g, h, blowDir(h), size);
        g.immuneUntil = t + CFG.immune;
        g.born = t;
        const catching = w.catching && h.pose === w.catchPose;
        if (!catching && w.nonOpen > CFG.releaseGrace) this._release(w, t, events, true);
      } else {
        w.growing = null;
      }
      return;
    }
    w.nonOpen = 0;
    w.cooldown -= dt;
    if (wave > 0.5) this.stats.waveTime += dt;
    const P = wandParams(wave);
    const dir = blowDir(h);
    if (w.growing && w.growing.dead) w.growing = null;
    if (!w.growing && w.cooldown <= 0) {
      const b = this._newBubble(h.palm.x, h.palm.y, size * CFG.startRadiusK, 'hand', t);
      b.rTarget = clampRadius(size * this._rand(P.radiusMinK, P.radiusMaxK), this.width, this.height);
      b.r = Math.min(b.r, b.rTarget * 0.5);
      b.startR = b.r;
      b.attached = h.id;
      b.owner = h.id;
      b.grow = 0;
      b.growTime = P.growTime * this._rand(0.9, 1.15);
      if (this._add(b, events)) {
        w.growing = b;
        events.push({ type: 'grow', b, handId: h.id });
      }
    }
    const b = w.growing;
    if (b) {
      b.grow = Math.min(1, b.grow + dt / b.growTime);
      b.r = lerp(b.startR, b.rTarget, easeOutBack(b.grow));
      this._placeOnPalm(b, h, dir, size);
      b.vx = w.v.x;
      b.vy = w.v.y;
      b.immuneUntil = t + CFG.immune;
      b.born = t;
      const speed = Math.hypot(w.v.x, w.v.y) / size;
      if (b.grow >= 1 || (speed > CFG.snapSpeed && b.grow > 0.5)) {
        w.growing = null;
        b.attached = null;
        b.rTarget = b.r;
        // 좌우로 번갈아 벌어지며 힘차게 날아간다 (손바닥 위에 쌓이지 않게)
        const push = this.height * lerp(CFG.launchK[0], CFG.launchK[1], wave) * this._rand(0.85, 1.15);
        const fan = (w.made % 2 ? 1 : -1) * this._rand(CFG.fan[0], CFG.fan[1]);
        const c = Math.cos(fan);
        const sn = Math.sin(fan);
        const lx = dir.x * c - dir.y * sn;
        const ly = dir.x * sn + dir.y * c;
        b.vx = w.v.x * 0.55 + lx * push;
        b.vy = w.v.y * 0.55 + ly * push;
        b.immuneUntil = t + CFG.immune;
        b.letGoAt = t;
        kick(b, 0.22, Math.atan2(ly, lx));
        w.cooldown = P.cooldown;
        w.made++;
        this.stats.emitted++;
        events.push({ type: 'detach', b, handId: h.id, wave });
      }
    }
    // 휘두르면 작은 방울이 우르르
    if (P.trailRate > 0) {
      w.trailAcc += dt * P.trailRate;
      while (w.trailAcc >= 1) {
        w.trailAcc -= 1;
        const ang = this.rng() * TAU;
        const rr = this.rng() * size * 0.35;
        const tr = clampRadius(size * this._rand(CFG.trailRadiusK[0], CFG.trailRadiusK[1]), this.width, this.height);
        const tb = this._newBubble(h.palm.x + Math.cos(ang) * rr, h.palm.y + Math.sin(ang) * rr, tr, 'trail', t);
        tb.owner = h.id;
        const k = this._rand(0.35, 0.7);
        tb.vx = w.v.x * k + this._rand(-40, 40);
        tb.vy = w.v.y * k + this._rand(-40, 40) - this.height * 0.03;
        kick(tb, 0.15, this.rng() * TAU);
        if (this._add(tb, events)) {
          this.stats.emitted++;
          this.stats.trail++;
          events.push({ type: 'trail', b: tb, handId: h.id });
        }
      }
    }
    // (흔들기가 한두 프레임 약해져도 모아 둔 몫은 남겨 둔다 — 1 보다 작아서 한꺼번에 쏟아지지 않는다)
  }

  _interact(hands, t, events) {
    for (const h of hands) {
      if (h.stale) continue;
      const w = this.wands.get(h.id);
      if (!w) continue;
      const frame = handFrame(h, w.curFrame);
      // 잡기: 손을 꽉 쥐거나(주먹) 집는 순간부터 잠깐 동안
      if (h.started === 'fist' || h.started === 'pinch') {
        w.catching = true;
        w.catchPose = h.started;
        // 손 안에서 부풀던 방울이 바로 꾹 눌리는 것처럼 보이게
        if (w.growing && !w.growing.dead) kick(w.growing, 0.35, handAngle(h) + Math.PI / 2);
      }
      if (w.catching) {
        // 주먹/집기를 시작하고 catchWindow 초 동안만 (손 모양 유지 시간 기준이라 화면이 느려도 같다)
        if (h.pose !== w.catchPose) w.catching = false;
        else if (this._tryCatch(w, h, t, events) || h.poseTime > CFG.catchWindow) w.catching = false;
      }
      if (h.pose === 'open') {
        // 펼친 손은 방울을 부는 중이라 콕 찌르지 않는다. 대신 휙 휘둘러 치면 (자기가 막 분 방울이 아니면) 터진다.
        w.lastOpen = t;
        this._swat(w, h, t, events);
      } else if (h.age >= CFG.pokeMinAge && w.frames >= CFG.pokeMinFrames) {
        // 콕 찌르기. 펼쳤던 손을 막 오므리는 중이면(주먹·집기·그 밖) 손바닥 근처에서 닿은 방울은 '잡기'로 친다
        // (천천히 쥐면 손 모양이 잠깐 'other' 로 보여서 주먹 판정보다 손가락이 먼저 닿기 때문).
        const closing = h.pose !== 'point' && h.pose !== 'v' && t - w.lastOpen < CFG.closeWindow;
        const tipR = CFG.tipRadius * h.size;
        const start = this._tmp;
        let grabbed = 0;
        for (let f = 0; f < 5; f++) {
          const cur = h.tips[f];
          // 손 전체가 움직여서 지나온 길만 쓸어 본다 (손 모양이 바뀌며 손끝이 휙 옮겨진 건 빼고)
          if (w.hasPrev) carriedStart(w.prevTips[f], w.prevFrame, frame, cur, start);
          else {
            start.x = cur.x;
            start.y = cur.y;
          }
          for (const b of this.bubbles) {
            if (!this._canPop(b, t) || ownGuard(b, h, w.lastOpen, t) || !sweptHit(b, start, cur, tipR)) continue;
            if (closing && inCatchReach(b, h.palm, h.size)) {
              this._pop(b, 'catch', h.id, events);
              grabbed++;
            } else {
              this._pop(b, 'poke', h.id, events);
            }
          }
        }
        if (grabbed) events.push({ type: 'catch', handId: h.id, x: h.palm.x, y: h.palm.y, n: grabbed, pose: h.pose, size: h.size });
      }
    }
    for (const h of hands) {
      const w = this.wands.get(h.id);
      if (!w) continue;
      for (let f = 0; f < 5; f++) {
        w.prevTips[f].x = h.tips[f].x;
        w.prevTips[f].y = h.tips[f].y;
      }
      handFrame(h, w.prevFrame);
      swatCenter(h, w.prevDisc);
      w.hasPrev = true;
    }
  }

  /**
   * 주먹/집기로 잡기. 손 안(손바닥 또는 집은 곳 근처)의 방울과 손바닥에서 부풀던 방울을 한꺼번에 잡는다.
   * 손 안에 '내가 분 방울만' 있으면 주먹을 ownCatchHold 초 유지할 때까지 기다린다 — 카메라가 불던 손을
   * 몇 프레임 주먹으로 잘못 봐도 '잡았다!' 가 나오지 않게. 남의 방울(떠다니는 방울, 친구 방울)이 손 안에
   * 있으면 바로 잡는다 (손을 뻗어 방울에 대고 꽉 쥐는 가장 흔한 잡기가 늦지 않게).
   * @returns {boolean} 판정이 끝났는지 (잡았거나 부풀던 방울을 정리함)
   */
  _tryCatch(w, h, t, events) {
    const p = h.pose === 'pinch' ? h.pinchPoint : h.palm;
    const list = this._catchList;
    list.length = 0;
    let others = false;
    for (const b of this.bubbles) {
      if (b.dead || b.attached !== null) continue;
      const own = b.owner === h.id;
      // 내 손바닥을 막 떠난 방울은 아직 안 터지는 시간(immune)이어도 내 주먹으로는 잡을 수 있다
      // (손을 오므리는 사이 다 부풀어 똑 떨어지거나, 천천히 오므리다 놓친 방울이 주먹 밖으로 도망가 보이지 않게)
      const ok = t >= b.immuneUntil || (own && b.letGoAt >= 0);
      if (!ok || !inCatchReach(b, p, h.size)) continue;
      if (!own) others = true;
      list.push(b);
    }
    const g = w.growing && !w.growing.dead ? w.growing : null;
    if (!list.length && !g) return false;
    if (!others && h.poseTime < CFG.ownCatchHold) return false;
    let n = 0;
    for (const b of list) {
      this._pop(b, 'catch', h.id, events);
      n++;
    }
    if (g) {
      // 손바닥에서 부풀던 방울: 충분히 부풀었으면 잡았다!, 아주 작으면 사르르
      w.growing = null;
      if (g.grow >= CFG.minReleaseGrow) {
        this._pop(g, 'catch', h.id, events);
        n++;
      } else {
        this._pop(g, 'fizzle', h.id, events);
      }
    }
    list.length = 0;
    if (n) events.push({ type: 'catch', handId: h.id, x: p.x, y: p.y, n, pose: h.pose, size: h.size });
    return true;
  }

  /** 펼친 손을 휙 휘둘러 손바닥(+손가락 뿌리) 판이 쓸고 지나간 방울을 터뜨린다 */
  _swat(w, h, t, events) {
    if (!w.hasPrev || h.age < CFG.pokeMinAge || w.frames < CFG.pokeMinFrames) return;
    const size = Math.max(h.size, 1);
    if (Math.hypot(w.v.x, w.v.y) < CFG.swatSpeed * size) return;
    const cur = swatCenter(h, w.disc);
    const prev = w.prevDisc;
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > size * CFG.jumpK) return;
    const R = CFG.swatRadius * size;
    for (const b of this.bubbles) {
      if (!this._canPop(b, t) || !swatTarget(b, h.id, t)) continue;
      if (distToSegment(b, prev, cur) < b.r * 0.9 + R) this._pop(b, 'swat', h.id, events);
    }
  }

  _ambient(hands, dt, t, events) {
    let live = 0;
    let anyOpen = false;
    for (const h of hands) {
      if (h.stale) continue;
      live++;
      if (h.pose === 'open') anyOpen = true;
    }
    this._idleT = live ? 0 : this._idleT + dt;
    const target = ambientTarget(this._idleT, live, anyOpen);
    let free = 0;
    for (const b of this.bubbles) if (!b.dead && b.attached === null) free++;
    if (free >= target) {
      this._ambientT = Math.min(this._ambientT, CFG.ambientInterval[0] * 0.5);
      return;
    }
    this._ambientT -= dt;
    if (this._ambientT <= 0) {
      this._ambientT = this._rand(CFG.ambientInterval[0], CFG.ambientInterval[1]);
      this.spawnAmbient(t, events);
    }
  }

  /**
   * @param {{hands: object[], dt: number, t: number, now?: number}} input
   *   t: 놀이 시계(초, dt 를 더한 값 — 화면이 아주 느리면 dt 가 잘려 실제보다 천천히 간다)
   *   now: 실제 시각(초, frame.t). 손 위치는 실제 시간으로 움직이므로 손 속도는 이것으로 잰다.
   * @returns {object[]} 이번 프레임에 일어난 사건들
   */
  update({ hands, dt, t, now = t }) {
    this._now = now;
    const events = [];
    const W = this.width;
    const H = this.height;
    // 1) 손별 비눗방울 막대
    const seen = this._seen;
    seen.clear();
    let wave = 0;
    for (const h of hands) {
      seen.add(h.id);
      const w = this._wand(h);
      this._updateWand(w, h, dt, t, events);
      wave = Math.max(wave, w.wave);
    }
    this.wave = wave;
    for (const [id, w] of this.wands) {
      if (seen.has(id)) continue;
      this._release(w, t, events);
      this.wands.delete(id);
    }
    // 2) 바람 (움직이는 펼친 손)
    for (const h of hands) {
      if (h.stale || h.pose !== 'open') continue;
      const w = this.wands.get(h.id);
      applyWind(this.bubbles, h, dt, w ? w.v : h.velocity);
    }
    // 3) 떠다니기
    for (const b of this.bubbles) {
      if (b.dead) continue;
      stepJiggle(b, dt);
      if (b.attached !== null) continue;
      const why = stepFree(b, dt, t, W, H, this.rng);
      if (why) this._pop(b, why, null, events);
    }
    separate(this.bubbles, dt, t);
    // 밀어내다가 벽 밖으로 나간 방울은 다시 안으로
    for (const b of this.bubbles) {
      if (b.dead || b.attached !== null) continue;
      if (b.x < b.r) b.x = b.r;
      else if (b.x > W - b.r) b.x = Math.max(b.r, W - b.r);
    }
    // 4) 콕 찌르기 / 잡기
    this._interact(hands, t, events);
    // 5) 아무도 안 놀 때 떠다니는 방울
    this._ambient(hands, dt, t, events);
    this._compact();
    return events;
  }
}
