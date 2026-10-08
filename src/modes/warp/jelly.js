// 말랑 화면 놀이의 순수 로직: 잡기 상태 기계, 변형 모양(목표 위치), 젤리 물리.
// DOM 의존성이 없어 node 에서 테스트할 수 있다. 좌표는 모두 화면 CSS px.

import { clamp, wrapAngle } from '../../core/math.js';

// ------------------------------------------------------------------ 잡기 (손 → 잡은 점)

export const GRAB = Object.freeze({
  /** 주먹이 잠깐 풀려 보여도 이만큼(초)은 계속 잡고 있다 (인식 깜빡임 대비) */
  loseGrace: 0.24,
  /** 활짝 편 손이 확실하면 이만큼만 기다렸다 놓는다 */
  openGrace: 0.05,
  /** 손이 화면에서 사라져도 이만큼 기다린다. 그 사이 가까이 다시 나타난 주먹이 이어서 잡는다. */
  orphanGrace: 0.5,
  /** 사라진(또는 놓친) 잡기를 이어받을 수 있는 거리 (손 크기 배수). 빨리 움직이면 인식기가 새 손으로 착각한다. */
  adoptDist: 2.5,
  /** 이미 잡고 있을 때 '아직 주먹'으로 봐 주는 기준: 가장 많이 펴진 손가락(검지~새끼)이 이보다 덜 펴짐 */
  holdMaxExt: 0.45,
  /** 집기를 계속 잡고 있다고 봐 주는 엄지-검지 거리 (손 크기 배수) */
  holdPinchDist: 0.5,
  /** 비틀기 최대 (라디안) — 손목은 이 이상 잘 돌지 않고, 떨림이 쌓여 폭주하지 않게 */
  maxTwist: 2.4,
  maxGrabs: 6,
});

/** 손 모양 → 잡기 종류 (없으면 null) */
export function grabKindOf(pose) {
  return pose === 'fist' ? 'fist' : pose === 'pinch' ? 'pinch' : null;
}

/**
 * 손 → 잡기 종류. 주먹을 대충 쥐면 엄지 끝이 검지 끝에 닿아 '집기'로 읽히기도 하는데,
 * 네 손가락이 다 접혀 있으면 주먹으로 본다.
 */
export function grabKindFor(hand) {
  const kind = grabKindOf(hand.pose);
  if (kind === 'pinch' && hand.ext) {
    const e = hand.ext;
    if (e[1] < 0.35 && e[2] < 0.3 && e[3] < 0.3 && e[4] < 0.3) return 'fist';
  }
  return kind;
}

/** 잡기 종류별로 손이 잡는 지점: 주먹은 손바닥 가운데, 집기는 엄지-검지 사이 */
export function anchorOf(hand, kind) {
  const p = kind === 'pinch' ? hand.pinchPoint : hand.palm;
  return { x: p.x, y: p.y };
}

/** 손목 → 중지 뿌리 방향 (라디안, 화면 기준 시계방향 +) */
export function handAngle(hand) {
  const w = hand.lm[0];
  const m = hand.lm[9];
  return Math.atan2(m.y - w.y, m.x - w.x);
}

/**
 * 비틀기를 재는 두 방향: 손목→중지 뿌리(a1), 검지 뿌리→새끼 뿌리(a2). w1, w2 는 믿을 만한 정도 0..1.
 * 주먹 쥔 손등을 카메라 쪽으로 내밀면 손목→중지 뿌리가 짧아져(원근) 각도가 마구 흔들리고,
 * 손을 옆으로 세우면 손가락 뿌리 줄이 짧아진다. 둘 중 길게 보이는 쪽을 더 믿는다.
 */
export function handAngles(hand, out = {}) {
  const lm = hand.lm;
  const s = Math.max(hand.size, 1e-6);
  const ax = lm[9].x - lm[0].x;
  const ay = lm[9].y - lm[0].y;
  const bx = lm[17].x - lm[5].x;
  const by = lm[17].y - lm[5].y;
  out.a1 = Math.atan2(ay, ax);
  out.a2 = Math.atan2(by, bx);
  out.w1 = clamp((Math.hypot(ax, ay) / s - 0.5) / 0.3);
  out.w2 = clamp((Math.hypot(bx, by) / s - 0.35) / 0.25);
  return out;
}

/** 두 프레임 사이에 손이 화면 안에서 돈 각도. 믿을 만한 방향이 없으면 0 (쌓이지 않는다). */
export function twistDelta(prev, cur) {
  const w1 = Math.min(prev.w1, cur.w1);
  const w2 = Math.min(prev.w2, cur.w2);
  const sw = w1 + w2;
  if (sw < 0.3) return 0;
  return (w1 * wrapAngle(cur.a1 - prev.a1) + w2 * wrapAngle(cur.a2 - prev.a2)) / sw;
}

/** 이미 잡고 있는 손이 그 잡기를 계속 유지하는 모양인지 (시작보다 느슨한 기준 = 히스테리시스) */
export function stillHolding(hand, kind) {
  if (grabKindFor(hand) === kind) return true;
  if (kind === 'fist') {
    if (hand.pose === 'open') return false;
    const e = hand.ext;
    return Math.max(e[1], e[2], e[3], e[4]) < GRAB.holdMaxExt;
  }
  return hand.pinchDist < GRAB.holdPinchDist && hand.pose !== 'open';
}

/** 잡는 범위(가우스 반경 σ, px). 손 크기에 비례하되 화면 크기로 위아래를 막는다. */
export function grabSigma(kind, size, width, height) {
  const m = Math.min(width, height);
  if (kind === 'pinch') return clamp(1.2 * size, 0.08 * m, 0.17 * m);
  return clamp(1.5 * size, 0.15 * m, 0.32 * m);
}

let nextSerial = 1;

/** 손 랜드마크를 잡기에 복사해 둔다 (손을 놓쳐도 마지막 모습으로 손 조각을 그릴 수 있게) */
function copyLandmarks(dst, lm) {
  for (let i = 0; i < 21; i++) {
    dst[i].x = lm[i].x;
    dst[i].y = lm[i].y;
  }
}

/**
 * 손마다 잡기 상태를 관리한다. 손 id 로 붙이고, 깜빡임·잠깐 놓침·손 id 바뀜(다시 인식)을 견딘다.
 * update() 는 이번 프레임에 일어난 사건 목록을 돌려준다:
 *   {type:'grab'} / {type:'adopt'} / {type:'convert'} (꼬집기 → 주먹, 늘어난 모양 그대로) /
 *   {type:'release', reason:'open'|'lost'}
 */
export class Grabber {
  constructor(opts = {}) {
    this.o = { ...GRAB, ...opts };
    /** @type {Map<number, object>} 손 id → 잡기 */
    this.byHand = new Map();
    this.created = 0;
    this.released = 0;
    this.adopted = 0;
    this.converted = 0;
    this.frameNo = 0;
    this._ang = {};
    /** 지난 프레임에 보이던 손 id 들 */
    this.prevIds = new Set();
  }

  /** 지금 잡고 있는 것들 */
  get list() {
    return [...this.byHand.values()];
  }

  get count() {
    return this.byHand.size;
  }

  clear() {
    this.byHand.clear();
    this.prevIds = new Set();
  }

  /** 잡기의 손을 놓친 순간: 그때 이미 보이던 손들은 이 잡기를 이어받을 수 없다 (다른 아이·다른 손이 가로채지 않게) */
  _lost(g) {
    if (!g.knownIds) g.knownIds = new Set(this.prevIds);
  }

  _create(hand, kind, width, height) {
    const p = anchorOf(hand, kind);
    const ang = handAngles(hand, {});
    const g = {
      serial: nextSerial++,
      handId: hand.id,
      kind,
      p0: { x: p.x, y: p.y }, // 잡은 화면 지점 (일그러지기 전 좌표)
      pos: { x: p.x, y: p.y }, // 지금 손이 있는 곳 → 잡은 지점이 여기로 끌려온다
      size0: hand.size,
      size: hand.size,
      sigma: grabSigma(kind, hand.size, width, height),
      ang, // 비틀기 측정용 (지난 프레임)
      angle: ang.a1, // 그리기용 각도 (잡을 때 각도 + 비튼 만큼)
      twist: 0, // 잡은 뒤로 돌린 각도 (누적, 라디안)
      lose: 0, // 주먹이 아닌 것처럼 보인 시간
      orphan: 0, // 손이 사라진 뒤 지난 시간
      age: 0,
      travel: 0, // 잡은 뒤 손이 움직인 거리 (뽀득 소리용)
      maxDrag: 0, // 가장 멀리 당긴 거리 (px)
      maxTwist: 0,
      lm: Array.from({ length: 21 }, () => ({ x: 0, y: 0 })), // 마지막으로 본 손 모습
      openness: hand.openness ?? 0,
    };
    copyLandmarks(g.lm, hand.lm);
    this.created++;
    return g;
  }

  _follow(g, hand) {
    const p = anchorOf(hand, g.kind);
    g.travel += Math.hypot(p.x - g.pos.x, p.y - g.pos.y);
    g.pos.x = p.x;
    g.pos.y = p.y;
    g.size = hand.size;
    g.openness = hand.openness ?? g.openness;
    copyLandmarks(g.lm, hand.lm);
    const cur = handAngles(hand, this._ang);
    const d = twistDelta(g.ang, cur);
    const before = g.twist;
    g.twist = clamp(g.twist + d, -this.o.maxTwist, this.o.maxTwist);
    g.angle += g.twist - before;
    g.ang.a1 = cur.a1;
    g.ang.a2 = cur.a2;
    g.ang.w1 = cur.w1;
    g.ang.w2 = cur.w2;
    const drag = Math.hypot(g.pos.x - g.p0.x, g.pos.y - g.p0.y);
    if (drag > g.maxDrag) g.maxDrag = drag;
    if (Math.abs(g.twist) > g.maxTwist) g.maxTwist = Math.abs(g.twist);
  }

  /** 꼬집던 손이 주먹을 쥐었다: 놓지 않고 그 자리에서 큰 잡기로 바꾼다 (당긴 만큼은 그대로 이어진다) */
  _convert(g, hand, width, height) {
    const to = anchorOf(hand, 'fist');
    // 잡은 점을 손바닥 쪽으로 같이 옮겨서 '당긴 거리·방향'이 끊기지 않게
    g.p0.x += to.x - g.pos.x;
    g.p0.y += to.y - g.pos.y;
    g.pos.x = to.x;
    g.pos.y = to.y;
    g.kind = 'fist';
    g.sigma = grabSigma('fist', hand.size, width, height);
    g.size0 = hand.size;
    g.twist = 0;
    handAngles(hand, g.ang);
    g.angle = g.ang.a1;
    this.converted++;
  }

  /**
   * @param {object[]} hands frame.hands
   * @param {number} dt
   * @param {number} width 화면 크기 (잡기 범위 계산용)
   * @param {number} height
   */
  update(hands, dt, width, height) {
    const o = this.o;
    this.frameNo++;
    const events = [];
    const present = new Set();
    // 이어받을 수 있는 잡기: 손이 사라졌거나, 잠깐 놓친(stale) 손의 잡기.
    // (손이 아주 빨리 움직이면 인식기가 옛 손은 stale 로 두고 새 id 를 붙인다)
    const orphans = [];
    for (const h of hands) {
      present.add(h.id);
      const g = h.stale ? this.byHand.get(h.id) : null;
      if (g) {
        this._lost(g);
        orphans.push(g);
      }
    }

    // 손이 사라진 잡기: 잠깐 기다렸다가 놓는다
    for (const [id, g] of this.byHand) {
      if (present.has(id)) continue;
      this._lost(g);
      g.orphan += dt;
      g.age += dt;
      if (g.orphan > o.orphanGrace) {
        this.byHand.delete(id);
        this.released++;
        events.push({ type: 'release', grab: g, reason: 'lost' });
      } else {
        orphans.push(g);
      }
    }

    for (const h of hands) {
      let g = this.byHand.get(h.id);
      const want = grabKindFor(h);
      if (g) {
        g.age += dt;
        g.orphan = 0;
        if (h.stale) continue; // 잠깐 놓침: 마지막 위치 그대로 계속 잡고 있는다
        g.knownIds = null;
        if (g.kind === 'pinch' && want === 'fist') {
          this._convert(g, h, width, height);
          g.lose = 0;
          this._follow(g, h);
          events.push({ type: 'convert', grab: g });
        } else if (stillHolding(h, g.kind)) {
          g.lose = 0;
          this._follow(g, h);
        } else {
          g.lose += dt;
          const limit = h.pose === 'open' ? o.openGrace : o.loseGrace;
          if (g.lose > limit) {
            this.byHand.delete(h.id);
            this.released++;
            events.push({ type: 'release', grab: g, reason: 'open' });
          } else {
            this._follow(g, h); // 손바닥 위치는 여전히 믿을 만하다
          }
        }
        continue;
      }
      if (!want || h.stale) continue;

      // 방금 사라졌던 잡기를 근처에 새로 나타난 같은 손 모양이 이어받는다 (인식기가 손 id 를 새로 붙인 경우).
      // 손을 놓치기 전부터 보이던 다른 손(다른 아이, 다른 손)은 가로채지 않는다.
      {
        const p = anchorOf(h, want);
        let best = null;
        let bestD = o.adoptDist * h.size;
        for (const og of orphans) {
          if (og.kind !== want || og.takenAt === this.frameNo) continue; // 이번 프레임에 이미 이어받은 것은 제외
          if (og.knownIds && og.knownIds.has(h.id)) continue;
          let d = Math.hypot(og.pos.x - p.x, og.pos.y - p.y);
          if (og.side && h.side && og.side !== h.side) d += 0.5 * h.size; // 같은 쪽 손을 조금 더 믿는다
          if (d < bestD) {
            bestD = d;
            best = og;
          }
        }
        if (best) {
          this.byHand.delete(best.handId);
          this.adopted++;
          best.takenAt = this.frameNo;
          best.handId = h.id;
          best.orphan = 0;
          best.lose = 0;
          best.knownIds = null;
          handAngles(h, best.ang); // 비틀기는 이어서 누적 (손 id 가 바뀐 순간의 각도 차이는 버린다)
          this._follow(best, h);
          best.side = h.side;
          this.byHand.set(h.id, best);
          events.push({ type: 'adopt', grab: best });
          continue;
        }
      }
      if (this.byHand.size >= o.maxGrabs) continue;
      g = this._create(h, want, width, height);
      g.side = h.side;
      this.byHand.set(h.id, g);
      events.push({ type: 'grab', grab: g });
    }
    this.prevIds = present;
    return events;
  }
}

// ------------------------------------------------------------------ 변형 모양
//
// 잡기 하나의 변형은 '당기는 방향(e)' 좌표계에서 생각한다. a = 잡은 점 P0 에서 당기는 방향으로 간 거리,
// b = 옆으로 간 거리. 이동은 늘 e 방향으로만 일어나므로 격자가 뒤집히지 않을 조건은 단 하나:
//   d(이동)/da ≥ -1  (옆쪽 변화는 비스듬히 밀릴 뿐 뒤집지 않는다)
// - 잡은 점 뒤쪽(a < α): 가우스 모양으로 늘어난다 (고무줄처럼 쭉).
// - 잡은 점 → 손 앞쪽(α..β): 그 사이 화면은 주먹 속으로 접혀 들어간다 (기울기 ≥ -1, 손 조각 아래에 숨는다).
// - 손 앞쪽(a > β): 그대로. → 영상 속 아이 손은 거의 제자리에 남고, 손 밖으로 '유령 손'이나 접힘이 생기지 않는다.
// 비틀기와 볼록은 그보다 먼저 손 둘레에 씌운다 (둘 다 원을 원으로 보내는 일대일 변형이라 뒤집히지 않는다).

/**
 * 비틀기 감도와 데드존 (작은 떨림, 팔을 휘두를 때 손이 조금 기우는 것은 무시).
 * max: 소용돌이 최대 각도. 격자 한 칸(약 30px) 사이 각도 차이가 0.25 라디안을 넘으면 칸이 뒤집혀 보여서
 * 소용돌이가 커질수록 더 넓게 퍼져야 한다 (grabField 의 ramp).
 */
export const TWIST = Object.freeze({ gain: 1, dead: 0.2, max: 1.1 });
/** 격자 한 칸 사이 소용돌이 각도 차이 한도 (라디안) */
const TWIST_PER_CELL = 0.25;
/** 앞뒤로 밀고 당기기(손 크기 변화) → 볼록/오목 */
export const BULGE = Object.freeze({ dead: 0.08, gain: 0.9, min: -0.35, max: 0.6 });

/**
 * 잡기 종류별 모양 (손 크기 배수).
 * front: 손 앞쪽 이만큼부터는 움직이지 않는다 / edge: 접히는 구간 가장자리 폭 /
 * dead0: 비틀기·볼록이 시작되는 거리 (그 안쪽 주먹 자리는 돌리지 않는다) / dead1: 소용돌이가 다 커지기까지 가장 짧은 폭 /
 * screen: 비틀기·볼록을 쓰는지
 * (꼬집기는 잡는 점이 손 가장자리라 손 둘레를 돌리면 손 모습이 함께 돌아가 버린다 → 끈다)
 */
export const SHAPE = Object.freeze({
  fist: Object.freeze({ front: 0.3, edge: 0.25, dead0: 0.75, dead1: 1.2, screen: true }),
  pinch: Object.freeze({ front: 0.05, edge: 0.1, dead0: 0, dead1: 0, screen: false }),
});

const softDead = (v, dead) => (Math.abs(v) <= dead ? 0 : v - Math.sign(v) * dead);
const sstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** ∫₀ᵗ smoothstep */
const sstepInt = (t) => (t <= 0 ? 0 : t >= 1 ? t - 0.5 : t * t * t - 0.5 * t * t * t * t);

/** 최대 변위 누르기: knee 까지는 그대로(잡은 점이 손에 딱 붙어 있게), 그 위로는 부드럽게 cap 에 다가간다 */
export function softCap(m, cap, kneeRatio = 0.55) {
  if (!(cap < Infinity)) return m;
  const knee = cap * kneeRatio;
  if (m <= knee) return m;
  const room = cap - knee;
  return knee + room * Math.tanh((m - knee) / room);
}

/**
 * 잡기 하나가 화면을 어떻게 미는지 정리한다 (매 프레임 다시 계산, out 을 재사용).
 * @param {object} g 잡기 (Grabber)
 * @param {object} [out]
 * @param {number} [capD] 잡은 점을 끌고 갈 수 있는 최대 거리 (px). 더 당기면 잡은 점이 손보다 조금씩 뒤처지고
 *   그 사이가 눌려 보인다 (화면 전체가 미끄러지지 않게).
 * @param {number} [cell] 격자 한 칸 크기 (px). 소용돌이가 칸을 뒤집지 않을 만큼 넓게 퍼지게 하는 데 쓴다.
 */
export function grabField(g, out = {}, capD = Infinity, cell = 30) {
  const dx = g.pos.x - g.p0.x;
  const dy = g.pos.y - g.p0.y;
  const drag = Math.hypot(dx, dy);
  const sh = SHAPE[g.kind] || SHAPE.fist;
  const s = g.size;
  out.kind = g.kind || 'fist';
  out.x = g.p0.x;
  out.y = g.p0.y;
  out.ax = g.pos.x;
  out.ay = g.pos.y;
  out.dx = dx;
  out.dy = dy;
  out.drag = drag;
  out.ex = drag > 1e-3 ? dx / drag : 1;
  out.ey = drag > 1e-3 ? dy / drag : 0;
  const dc = softCap(drag, capD, 0.7);
  out.dc = dc;
  out.h = drag > 1e-3 ? dc / drag : 0; // 접히는 정도 (1 = 사이가 모두 주먹 속으로)
  out.w = Math.max(1, sh.edge * s);
  out.alpha = sh.front * s - out.w; // 늘어나는 곳 / 접히는 곳 경계
  out.beta = drag + sh.front * s; // 접히는 곳 끝 (손 앞쪽) — 여기부터 그대로
  out.sigma = g.sigma;
  out.inv2s2 = 1 / (2 * g.sigma * g.sigma);
  // 비틀기: 멀리 당긴 채로 돌리면 눌린 사이 화면까지 돌아가 칸이 뒤집히므로 당긴 만큼 줄인다
  // (일부러 비트는 아이는 보통 주먹을 제자리에 두고 돌린다)
  const twistRoom = clamp((2.2 * g.sigma - drag) / (1.2 * g.sigma), 0.3, 1);
  out.theta = sh.screen ? clamp(softDead(g.twist, TWIST.dead) * TWIST.gain, -TWIST.max, TWIST.max) * twistRoom : 0;
  out.th = out.theta; // 실제로 쓰는 비틀기 (다른 손도 근처에서 비틀면 computeTargets 가 줄인다)
  const ratio = g.size0 > 0 ? g.size / g.size0 : 1;
  out.bulge = sh.screen ? clamp(softDead(ratio - 1, BULGE.dead) * BULGE.gain, BULGE.min, BULGE.max) : 0;
  out.size = s;
  out.rd0 = sh.dead0 * s;
  // 소용돌이가 0 → 최대로 커지는 폭: 손 크기에 비례하되, 칸 사이 각도 차이가 한도를 넘지 않게
  out.ramp = Math.max(sh.dead1 * s, (1.5 * TWIST.max * cell) / TWIST_PER_CELL);
  // 잦아드는 폭: 짧을수록 손 가까이에 모이지만, 칸 사이 각도 차이 한도(가우스 최대 기울기 0.61/σ)는 지킨다
  out.sigT = Math.max(0.9 * s, (0.61 * TWIST.max * cell) / TWIST_PER_CELL);
  out.inv2t2 = 1 / (2 * out.sigT * out.sigT);
  out.soft = Math.max(1, 0.1 * s);
  out.reachT = out.rd0 + out.ramp + 4 * Math.max(out.sigT, g.sigma);
  // 영향이 닿는 원래 좌표 상자 (가우스 4σ 밖은 1px 미만)
  const R = sh.screen ? out.reachT : 4 * g.sigma;
  const xa = out.x + out.ex * Math.min(0, out.alpha);
  const ya = out.y + out.ey * Math.min(0, out.alpha);
  const xb = out.x + out.ex * out.beta;
  const yb = out.y + out.ey * out.beta;
  out.bx0 = Math.min(xa, xb) - R;
  out.bx1 = Math.max(xa, xb) + R;
  out.by0 = Math.min(ya, yb) - R;
  out.by1 = Math.max(ya, yb) + R;
  return out;
}

/** 여러 잡기가 겹친 곳에서 '누구 몫인지' 나누는 날카로움. 클수록 잡은 점이 자기 손에 딱 붙는다. */
export const SHARE_Q = 4;
const MAX_FIELDS = 16;
const _L = new Float64Array(MAX_FIELDS);
const _A = new Float64Array(MAX_FIELDS);
const _D = new Float64Array(MAX_FIELDS);
const LOG_MIN = -9; // exp(-9) ≈ 1e-4: 이보다 멀면 영향 없음

/**
 * 원래 좌표 (x, y) 의 화면 조각이 어디로 가는지: out[0], out[1] = 변위(px), out[2] = 잡힘 정도 0..1,
 * out[3], out[4] = 그중 비틀기·볼록 몫 (화면 테두리 처리에 쓴다).
 * 1) 손 둘레(아직 일그러지지 않은 격자 위)를 볼록·비틀기 → 2) 당기기(이동)를 잡기별 몫으로 섞는다.
 * 잡기가 여럿이면 단순히 더하지 않고 '가까운 잡기 몫'을 부드럽게 나눠(softmax) 섞는다.
 * → 잡은 점은 저마다 자기 손에 딱 붙어 있고, 두 손이 반대로 당기면 그 사이가 쭉 늘어난다.
 * (비틀기를 먼저 하는 까닭: 당기기가 주먹 옆에 눌러 놓은 아주 얇은 칸을 다시 돌리면 칸이 뒤집혀 보인다)
 * @returns {boolean} 조금이라도 영향이 있으면 true
 */
export function displaceAt(fields, n, x, y, out) {
  // 1) 손 둘레: 볼록·비틀기
  const r = handMaps(fields, n, x, y);
  const px = r[0];
  const py = r[1];
  out[3] = px - x;
  out[4] = py - y;
  // 2) 당기기
  let m = -Infinity;
  for (let q = 0; q < n; q++) {
    const F = fields[q];
    const rx = px - F.x;
    const ry = py - F.y;
    const a = rx * F.ex + ry * F.ey;
    const b = ry * F.ex - rx * F.ey;
    const da = a < F.alpha ? a - F.alpha : a > F.beta ? a - F.beta : 0;
    const L = -(b * b + da * da) * F.inv2s2; // log(잡힘 정도): 잡은 점~손 앞쪽 캡슐에서 멀어질수록 작아짐
    _L[q] = L;
    _A[q] = a;
    if (L > m) m = L;
  }
  let sw = 0;
  let tx = 0;
  let ty = 0;
  let amp = 0;
  if (m >= LOG_MIN) {
    // 잡기별 이동 (e 방향)
    let q0 = -1;
    for (let q = 0; q < n; q++) {
      const L = _L[q];
      if (L < LOG_MIN) {
        _D[q] = 0;
        continue;
      }
      const F = fields[q];
      const a = _A[q];
      let along;
      if (a <= F.alpha) along = F.dc;
      else if (a >= F.beta) along = 0;
      else along = F.dc - F.h * F.w * (sstepInt((a - F.alpha) / F.w) - sstepInt((a - F.alpha - F.drag) / F.w));
      _D[q] = along * Math.exp(L);
      if (L === m) q0 = q;
    }
    // 몫 나누기 날카로움: 두 잡기가 서로 다른 쪽으로 크게 미는 곳(길이 엇갈림)에서는 부드럽게 섞어야
    // 몫이 바뀌는 경계에서 화면이 접히지 않는다. 같은 쪽으로 밀거나 한쪽만 크게 밀면 그대로 날카롭게.
    let Q = SHARE_Q;
    if (n > 1) {
      const F0 = fields[q0];
      const x0 = _D[q0] * F0.ex;
      const y0 = _D[q0] * F0.ey;
      let dis = 0;
      for (let q = 0; q < n; q++) {
        if (q === q0 || _L[q] < LOG_MIN) continue;
        const F = fields[q];
        const d = Math.hypot(_D[q] * F.ex - x0, _D[q] * F.ey - y0) / (F.sigma + F0.sigma);
        // 이 잡기의 몫이 의미 있을 때만 (멀리 있는 잡기는 상관없음)
        const near = Math.exp(2 * (_L[q] - m)); // 몫이 비슷한 곳(엇갈리는 한가운데)에서만 크게
        if (d * near > dis) dis = d * near;
      }
      Q = SHARE_Q / (1 + 64 * dis * dis);
    }
    for (let q = 0; q < n; q++) {
      const L = _L[q];
      if (L < LOG_MIN) continue;
      const F = fields[q];
      const w = n === 1 ? 1 : Math.exp(Q * (L - m));
      tx += w * _D[q] * F.ex;
      ty += w * _D[q] * F.ey;
      amp += w * Math.exp(L);
      sw += w;
    }
    tx /= sw;
    ty /= sw;
    amp /= sw;
  }
  const fx = px + tx;
  const fy = py + ty;
  out[0] = fx - x;
  out[1] = fy - y;
  out[2] = Math.min(1, amp);
  return amp > 0 || fx !== x || fy !== y;
}

const _sm = [0, 0];
/** 손 둘레 볼록(앞으로 밀기) → 비틀기. 둘 다 원을 원으로 보내는 일대일 변형이고, 손 자리(rd0 안)는 그대로. */
function handMaps(fields, n, px, py) {
  for (let q = 0; q < n; q++) {
    const F = fields[q];
    if (F.th === 0 && F.bulge === 0) continue;
    let ux = px - F.ax;
    let uy = py - F.ay;
    let rho = Math.hypot(ux, uy);
    if (rho < 1e-6 || rho > F.reachT) continue;
    if (F.bulge !== 0) {
      // ρ → ρ + β·u·exp(-u²/2σ²), u = softplus(ρ - rd0): 늘 단조 증가 (β > -1) → 접히지 않는다
      const z = (rho - F.rd0) / F.soft;
      const u = z > 30 ? rho - F.rd0 : F.soft * Math.log1p(Math.exp(z));
      const r2 = rho + F.bulge * u * Math.exp(-u * u * F.inv2s2);
      const k = r2 / rho;
      ux *= k;
      uy *= k;
      rho = r2;
    }
    if (F.th !== 0 && rho > F.rd0) {
      // 손 둘레 rd0 안쪽은 그대로, ramp 동안 천천히 커졌다가 바깥으로 가우스처럼 잦아든다
      const u = rho - F.rd0;
      const v = u > F.ramp ? u - F.ramp : 0;
      const ang = F.th * sstep(u / F.ramp) * Math.exp(-v * v * F.inv2t2);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const nx = ux * c - uy * s;
      uy = ux * s + uy * c;
      ux = nx;
    }
    px = F.ax + ux;
    py = F.ay + uy;
  }
  _sm[0] = px;
  _sm[1] = py;
  return _sm;
}

/**
 * 격자 가장자리(화면 바깥 여백)는 움직이지 않도록 붙잡는 가중치. 0 = 고정, 1 = 자유.
 * @param {{count:number, rest:Float32Array, x0:number, y0:number, cols:number, rows:number, cellW:number, cellH:number, margin:number}} grid
 */
export function edgeWeights(grid, out = new Float32Array(grid.count)) {
  const x1 = grid.x0 + grid.cols * grid.cellW;
  const y1 = grid.y0 + grid.rows * grid.cellH;
  const ramp = Math.max(1, grid.margin * 0.75);
  for (let k = 0; k < grid.count; k++) {
    const x = grid.rest[k * 2];
    const y = grid.rest[k * 2 + 1];
    const d = Math.min(x - grid.x0, x1 - x, y - grid.y0, y1 - y);
    const t = clamp(d / ramp);
    out[k] = t * t * (3 - 2 * t);
  }
  return out;
}

const _borders = new WeakMap();
const _twists = new WeakMap();
/** 정점별 비틀기 몫 (computeTargets 안에서만 쓰는 임시 버퍼, 격자마다 하나) */
function twistBuf(grid) {
  let b = _twists.get(grid);
  if (!b) _twists.set(grid, (b = new Float32Array(grid.count * 2)));
  return b;
}

/**
 * 화면 테두리에 '못 박힌' 고무판: 테두리 가까운 곳은 화면 안쪽으로 끌려 들어오지 않는다.
 * (화면 밖 여백은 영상 끝 한 줄이 늘어난 줄무늬라 화면 안에 보이면 안 된다.)
 * 바깥쪽으로 밀려 나가는 것은 괜찮다. 테두리를 걸친 칸의 두 정점이 모두 안쪽으로 움직이지 않으면
 * 그 칸 안의 테두리 지점도 화면 밖에 머문다.
 * 당기기(e 방향으로만 미는 이동)는 테두리 쪽으로 갈수록 부드럽게 줄여도 접히지 않는다 (늘어날 뿐).
 * 비틀기(회전)는 그렇게 줄이면 칸이 뒤집히므로, 테두리를 걸친 줄(fx*=0 인 정점)에서만 안쪽 성분을 딱 막는다.
 * @returns {{fxp:Float32Array, fxn:Float32Array, fyp:Float32Array, fyn:Float32Array, list:Int32Array}}
 *   fxp: +x 방향(왼쪽 테두리에서 안쪽) 이동에 곱할 값, fxn: -x (오른쪽 테두리에서 안쪽) …, list: 완전히 묶인 정점들
 */
export function borderOf(grid) {
  let B = _borders.get(grid);
  if (B) return B;
  const n = grid.count;
  const W = grid.cols * grid.cellW + 2 * grid.x0;
  const H = grid.rows * grid.cellH + 2 * grid.y0;
  const rampX = Math.max(3 * grid.cellW, 0.15 * Math.min(W, H));
  const rampY = Math.max(3 * grid.cellH, 0.15 * Math.min(W, H));
  B = { fxp: new Float32Array(n), fxn: new Float32Array(n), fyp: new Float32Array(n), fyn: new Float32Array(n), list: null, W, H };
  const list = [];
  for (let k = 0; k < n; k++) {
    const x = grid.rest[k * 2];
    const y = grid.rest[k * 2 + 1];
    B.fxp[k] = sstep((x - grid.cellW) / rampX);
    B.fxn[k] = sstep((W - grid.cellW - x) / rampX);
    B.fyp[k] = sstep((y - grid.cellH) / rampY);
    B.fyn[k] = sstep((H - grid.cellH - y) / rampY);
    if (B.fxp[k] === 0 || B.fxn[k] === 0 || B.fyp[k] === 0 || B.fyn[k] === 0) list.push(k);
  }
  B.list = Int32Array.from(list);
  _borders.set(grid, B);
  return B;
}

const _o = new Float64Array(5);
const DIRS = Array.from({ length: 16 }, (_, i) => [Math.cos((i * Math.PI) / 8), Math.sin((i * Math.PI) / 8)]);
const RING = [0.5, 1, 1.25, 1.5, 1.75, 2];

/**
 * 잡지 않은 손 자리 가리개 만들기 (손은 젤리 위에 올려진 것처럼 제자리에 또렷하게).
 * 잡고 있는 손은 자기 변형 모양(앞쪽은 그대로, 사이는 주먹 속으로)이 이미 손을 지키므로 가리지 않는다.
 * @param {object[]} hands frame.hands
 * @param {(id:number) => boolean} isGrabbing
 * @param {object[]} out 결과 (재사용)
 * @param {object[]} pool 객체 재사용 풀
 */
export function buildMasks(hands, isGrabbing, out = [], pool = []) {
  out.length = 0;
  for (const h of hands) {
    if (isGrabbing(h.id)) continue;
    const s = h.size;
    const e = h.ext || [0, 0, 0, 0, 0];
    const reach = clamp(Math.max(e[1], e[2], e[3], e[4], 0.6 * (h.openness ?? 0)));
    const M = pool[out.length] || (pool[out.length] = { x: 0, y: 0, r0: 0, wBase: 0, wMax: 0, r: 0, w: 0, kmin: 0 });
    M.x = h.palm.x;
    M.y = h.palm.y;
    M.r0 = s * (0.95 + 0.42 * reach); // 손 조각(볼록 껍질)이 다 들어가는 반경
    M.wBase = 0.45 * s;
    M.wMax = 2.5 * s;
    out.push(M);
  }
  return out;
}

/** 격자 위 임의 점 (원래 좌표) 의 지금 변위 (이웃 네 정점 보간) */
export function sampleOffset(grid, x, y, out = _o) {
  const fx = clamp((x - grid.x0) / grid.cellW, 0, grid.cols - 1e-6);
  const fy = clamp((y - grid.y0) / grid.cellH, 0, grid.rows - 1e-6);
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  const s = grid.cols + 1;
  const k00 = (j * s + i) * 2;
  const k10 = k00 + 2;
  const k01 = k00 + s * 2;
  const k11 = k01 + 2;
  const o = grid.offset;
  out[0] = (o[k00] * (1 - u) + o[k10] * u) * (1 - v) + (o[k01] * (1 - u) + o[k11] * u) * v;
  out[1] = (o[k00 + 1] * (1 - u) + o[k10 + 1] * u) * (1 - v) + (o[k01 + 1] * (1 - u) + o[k11 + 1] * u) * v;
  return out;
}

/**
 * 가리개 모양 정하기: 손 둘레가 크게 밀리는 중이면 풀리는 폭(w)을 넓혀서 접히지 않게 한다
 * (가리개 경계의 기울기 × 변위 < 1). 그래도 모자라면 손도 조금(kmin) 따라 움직이게 한다.
 * 잡고 있는 주먹 자리까지는 넓히지 않는다 (그 손의 모양을 망가뜨리면 오히려 접힌다).
 * @param {(x:number, y:number) => number} mag 그 점의 변위 크기
 */
function shapeMask(M, mag, fields, n) {
  // 1) 손 자리가 거의 안 움직이면 가릴 필요가 없다 (예: 주먹 앞쪽은 원래 그대로)
  let need = mag(M.x, M.y);
  for (const f of [0.5, 1]) for (const [cx, cy] of DIRS) need = Math.max(need, mag(M.x + cx * f * M.r0, M.y + cy * f * M.r0));
  // 2) 가리개 안쪽(단단한 곳)이 잡고 있는 주먹 자리를 덮지 않게
  let lim = Infinity;
  for (let q = 0; q < n; q++) {
    const F = fields[q];
    lim = Math.min(lim, Math.hypot(M.x - F.ax, M.y - F.ay) - 1.0 * F.size);
  }
  const r0 = Math.min(M.r0, lim);
  if (need < 0.08 * M.wBase / 0.45 || r0 < 0.6 * M.r0) {
    M.r = 0;
    M.w = 0;
    M.kmin = 1; // 가리지 않음
    return;
  }
  M.r = r0;
  let w = M.wBase;
  let tmax = need;
  for (let it = 0; it < 3; it++) {
    // 손 안쪽부터 풀리는 고리 바깥까지 촘촘히
    for (const f of RING) {
      if (f <= 1) continue; // 안쪽은 need 에서 이미 봤다
      const r = r0 + (f - 1) * w;
      for (const [cx, cy] of DIRS) tmax = Math.max(tmax, mag(M.x + cx * r, M.y + cy * r));
    }
    // 잡은 점~손 사이(가장 크게 밀리는 곳)도 가리개 범위 안이면 살핀다
    const R = r0 + w;
    for (let q = 0; q < n; q++) {
      const F = fields[q];
      const a0 = Math.min(0, F.alpha);
      for (let i = 0; i <= 12; i++) {
        const t = a0 + ((F.beta - a0) * i) / 12;
        const x = F.x + F.ex * t;
        const y = F.y + F.ey * t;
        if (Math.hypot(x - M.x, y - M.y) < R) tmax = Math.max(tmax, mag(x, y));
      }
    }
    w = clamp(2.2 * tmax, M.wBase, M.wMax);
  }
  M.w = w;
  M.kmin = clamp(1 - w / (2.2 * tmax));
}

/**
 * 손 자리 가리개: 목표 변위를 줄이고(안쪽은 kmin 배) 그만큼 단단하게 붙잡는다.
 * @param {object[]} [fields] 잡기 모양들 (있으면 그 변위로, 없으면 지금 격자 변위로 가리개 폭을 정한다)
 * @param {Float32Array} [twist] 정점별 비틀기 몫 (target 과 같은 비율로 줄인다)
 */
export function applyMasks(grid, edge, masks, target, weight, fields = null, n = 0, twist = null) {
  const { rest, cols, rows } = grid;
  const stride = cols + 1;
  const mag = n
    ? (x, y) => (displaceAt(fields, n, x, y, _o), Math.hypot(_o[0], _o[1]))
    : (x, y) => (sampleOffset(grid, x, y, _o), Math.hypot(_o[0], _o[1]));
  for (const M of masks) shapeMask(M, mag, fields, n);
  for (const M of masks) {
    if (M.kmin >= 1) continue;
    const r1 = M.r + M.w;
    const i0 = Math.max(1, Math.floor((M.x - r1 - grid.x0) / grid.cellW));
    const i1 = Math.min(cols - 1, Math.ceil((M.x + r1 - grid.x0) / grid.cellW));
    const j0 = Math.max(1, Math.floor((M.y - r1 - grid.y0) / grid.cellH));
    const j1 = Math.min(rows - 1, Math.ceil((M.y + r1 - grid.y0) / grid.cellH));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * stride + i;
        const d = Math.hypot(rest[k * 2] - M.x, rest[k * 2 + 1] - M.y);
        if (d >= r1) continue;
        const keep = M.kmin + (1 - M.kmin) * sstep((d - M.r) / M.w); // kmin = 손 안쪽 .. 1 = 바깥(자유)
        target[k * 2] *= keep;
        target[k * 2 + 1] *= keep;
        if (twist) {
          twist[k * 2] *= keep;
          twist[k * 2 + 1] *= keep;
        }
        const hold = (1 - keep) * edge[k];
        if (hold > weight[k]) weight[k] = hold;
      }
    }
  }
}

/**
 * 소용돌이는 손 둘레를 통째로 돌리므로, 그 안에 다른 손(다른 주먹이나 다른 아이 손)이 있으면
 * 그 손 영상까지 돌아가 '유령 손'이 생긴다 → 다른 손까지 남은 거리만큼만 비튼다.
 * 두 손이 조금 떨어져서 함께 비틀어도 각도 차이가 더해져 칸이 뒤집히므로 겹치는 만큼 나눠 갖는다.
 */
function relaxTwists(fields, n, masks) {
  for (let q = 0; q < n; q++) {
    const F = fields[q];
    F.th = F.theta;
    if (F.theta === 0) continue;
    const zone = F.ramp + 1.5 * F.sigT;
    let room = 1;
    for (let p = 0; p < n; p++) {
      if (p === q) continue;
      const G = fields[p];
      room = Math.min(room, clamp((Math.hypot(F.ax - G.ax, F.ay - G.ay) - 1.0 * G.size - F.rd0) / zone));
    }
    if (masks) for (const M of masks) room = Math.min(room, clamp((Math.hypot(F.ax - M.x, F.ay - M.y) - M.r0 - F.rd0) / zone));
    const Rq = F.rd0 + F.ramp + 2 * F.sigT;
    let share = 1;
    for (let p = 0; p < n; p++) {
      const G = fields[p];
      if (p === q || G.theta === 0) continue;
      const Rp = G.rd0 + G.ramp + 2 * G.sigT;
      share += clamp((Rq + Rp - Math.hypot(F.ax - G.ax, F.ay - G.ay)) / (0.5 * (Rq + Rp)));
    }
    F.th = (F.theta * room) / share;
  }
}

/**
 * 모든 잡기를 합쳐서 격자 정점마다 목표 변위(target, px)와 잡힘 정도(weight 0..1)를 만든다.
 * @param {object} grid WarpGrid
 * @param {Float32Array} edge edgeWeights 결과
 * @param {object[]} fields grabField 결과들 (최대 16개)
 * @param {Float32Array} target 길이 count*2 (덮어씀)
 * @param {Float32Array} weight 길이 count (덮어씀)
 * @param {number} cap 안전용 최대 변위 px (거의 닿지 않는다; 잡은 점 거리는 grabField 의 capD 가 막는다)
 * @param {object[]} [masks] 잡지 않은 손 자리 (buildMasks)
 */
export function computeTargets(grid, edge, fields, target, weight, cap, masks = null) {
  target.fill(0);
  weight.fill(0);
  const twist = twistBuf(grid);
  twist.fill(0);
  const n = Math.min(fields.length, MAX_FIELDS);
  const { rest, cols, rows } = grid;
  const stride = cols + 1;
  relaxTwists(fields, n, masks);
  if (n) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let q = 0; q < n; q++) {
      const F = fields[q];
      if (F.bx0 < x0) x0 = F.bx0;
      if (F.bx1 > x1) x1 = F.bx1;
      if (F.by0 < y0) y0 = F.by0;
      if (F.by1 > y1) y1 = F.by1;
    }
    const i0 = Math.max(1, Math.floor((x0 - grid.x0) / grid.cellW));
    const i1 = Math.min(cols - 1, Math.ceil((x1 - grid.x0) / grid.cellW));
    const j0 = Math.max(1, Math.floor((y0 - grid.y0) / grid.cellH));
    const j1 = Math.min(rows - 1, Math.ceil((y1 - grid.y0) / grid.cellH));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * stride + i;
        if (!displaceAt(fields, n, rest[k * 2], rest[k * 2 + 1], _o)) continue;
        target[k * 2] = _o[0];
        target[k * 2 + 1] = _o[1];
        weight[k] = _o[2];
        twist[k * 2] = _o[3];
        twist[k * 2 + 1] = _o[4];
      }
    }
  }
  if (masks && masks.length) applyMasks(grid, edge, masks, target, weight, fields, n, twist);
  const B = borderOf(grid);
  for (let k = 0; k < grid.count; k++) {
    let tx = target[k * 2];
    let ty = target[k * 2 + 1];
    const w = weight[k];
    if (tx === 0 && ty === 0 && w === 0) continue;
    // 화면 테두리 쪽은 안쪽으로 끌려 들어오지 않게: 당기기 몫은 부드럽게, 비틀기 몫은 테두리 줄에서만 딱
    const wx = twist[k * 2];
    const wy = twist[k * 2 + 1];
    let ux = tx - wx;
    let uy = ty - wy;
    ux *= ux > 0 ? B.fxp[k] : B.fxn[k];
    uy *= uy > 0 ? B.fyp[k] : B.fyn[k];
    tx = ux + ((wx > 0 && B.fxp[k] === 0) || (wx < 0 && B.fxn[k] === 0) ? 0 : wx);
    ty = uy + ((wy > 0 && B.fyp[k] === 0) || (wy < 0 && B.fyn[k] === 0) ? 0 : wy);
    const mag = Math.hypot(tx, ty);
    const s = mag > 1e-6 ? softCap(mag, cap, 0.95) / mag : 1;
    const e = edge[k];
    target[k * 2] = tx * s * e;
    target[k * 2 + 1] = ty * s * e;
    weight[k] = Math.min(1, w) * e;
  }
}

// ------------------------------------------------------------------ 젤리 물리

export const JELLY = Object.freeze({
  /** 놓았을 때 제자리로 돌아가는 용수철 (ω≈12 rad/s ≈ 2번/초 출렁) */
  k0: 150,
  /** 잡힌 곳은 훨씬 단단하게 손을 따라간다 */
  k1: 760,
  /** 놓았을 때 감쇠 — 작게 해야 젤리처럼 여러 번 출렁인다 (ζ≈0.19: 1.5초쯤 서너 번 띠용) */
  c0: 4.6,
  /** 잡힌 곳 감쇠 (손을 따라갈 때 덜 흔들리게) */
  c1: 30,
  /** 이웃 정점끼리 끌어당김 → 물결이 퍼진다 */
  kappa: 520,
  /** 고정 적분 간격 (초) */
  h: 1 / 240,
  maxSteps: 16,
});

/**
 * 격자 정점마다 (변위, 속도) 를 가진 젤리. 변위는 grid.offset 에 직접 쓴다.
 * 창 크기가 바뀌어 격자가 새로 만들어지면 bind() 가 버퍼를 다시 맞춘다.
 */
export class Jelly {
  constructor(params = {}) {
    this.p = { ...JELLY, ...params };
    this.grid = null;
    this.vel = null;
    this.target = null;
    this.weight = null;
    this.edge = null;
    this.border = null;
    this.acc = 0;
    this.maxOffset = 0;
    this.maxSpeed = 0;
    this.sleeping = true;
    this.fieldsActive = false;
    this.masked = false;
  }

  /** 격자에 맞춰 버퍼 준비. 격자가 바뀌었으면 true. */
  bind(grid) {
    if (this.grid === grid && this.vel && this.vel.length === grid.count * 2) return false;
    this.grid = grid;
    this.vel = new Float32Array(grid.count * 2);
    this.target = new Float32Array(grid.count * 2);
    this.weight = new Float32Array(grid.count);
    this.edge = edgeWeights(grid);
    this.border = borderOf(grid);
    this.acc = 0;
    this.maxOffset = 0;
    this.sleeping = true;
    this.fieldsActive = false;
    this.masked = false;
    return true;
  }

  /**
   * 잡기 모양들로 목표를 정한다. fields 가 비면 모두 제자리(0)가 목표.
   * masks(잡지 않은 손 자리)는 출렁이는 동안에도 손 아래를 붙잡아 손이 흔들려 보이지 않게 한다.
   */
  setFields(fields, cap, masks = null) {
    if (fields.length) {
      computeTargets(this.grid, this.edge, fields, this.target, this.weight, cap, masks);
      this.fieldsActive = true;
      this.sleeping = false;
      this.masked = !!(masks && masks.length);
    } else if (this.fieldsActive || this.masked || (!this.sleeping && masks && masks.length)) {
      this.target.fill(0);
      this.weight.fill(0);
      this.fieldsActive = false;
      this.masked = false;
      if (!this.sleeping && masks && masks.length) {
        applyMasks(this.grid, this.edge, masks, this.target, this.weight);
        this.masked = true;
      }
    }
  }

  /** 한 번 젖히기 (테스트·효과용): 정점들에 속도를 더한다 */
  kick(x, y, radius, vx, vy) {
    const g = this.grid;
    const inv = 1 / (2 * radius * radius);
    for (let k = 0; k < g.count; k++) {
      const dx = g.rest[k * 2] - x;
      const dy = g.rest[k * 2 + 1] - y;
      const f = Math.exp(-(dx * dx + dy * dy) * inv) * this.edge[k];
      if (f < 1e-3) continue;
      this.vel[k * 2] += vx * f;
      this.vel[k * 2 + 1] += vy * f;
    }
    this.sleeping = false;
  }

  /** 화면 테두리 정점은 안쪽으로 들어오지 못하게 (출렁여 넘어와도 막는다) */
  _holdBorder() {
    const B = this.border;
    const off = this.grid.offset;
    const vel = this.vel;
    const L = B.list;
    for (let q = 0; q < L.length; q++) {
      const k = L[q];
      const ix = k * 2;
      if (B.fxp[k] === 0 && off[ix] > 0) {
        off[ix] = 0;
        if (vel[ix] > 0) vel[ix] = 0;
      }
      if (B.fxn[k] === 0 && off[ix] < 0) {
        off[ix] = 0;
        if (vel[ix] < 0) vel[ix] = 0;
      }
      if (B.fyp[k] === 0 && off[ix + 1] > 0) {
        off[ix + 1] = 0;
        if (vel[ix + 1] > 0) vel[ix + 1] = 0;
      }
      if (B.fyn[k] === 0 && off[ix + 1] < 0) {
        off[ix + 1] = 0;
        if (vel[ix + 1] < 0) vel[ix + 1] = 0;
      }
    }
  }

  /**
   * dt 초만큼 진행. 고정 간격(h)으로 잘게 나눠 적분해서 어떤 프레임레이트에서도 안정적이다.
   * @returns {number} 지금 가장 크게 밀려난 정점의 변위(px)
   */
  step(dt) {
    if (this.sleeping) return 0;
    const p = this.p;
    this.acc += dt;
    let steps = Math.floor(this.acc / p.h);
    if (steps > p.maxSteps) {
      steps = p.maxSteps;
      this.acc = 0;
    } else {
      this.acc -= steps * p.h;
    }
    const g = this.grid;
    const off = g.offset;
    const vel = this.vel;
    const tgt = this.target;
    const wt = this.weight;
    const cols = g.cols;
    const rows = g.rows;
    const rowStride = (cols + 1) * 2;
    const h = p.h;
    for (let s = 0; s < steps; s++) {
      // 1) 가속도 → 속도 (변위는 아직 그대로라 이웃 계산이 한쪽으로 치우치지 않는다)
      for (let j = 1; j < rows; j++) {
        let k = j * (cols + 1) + 1;
        for (let i = 1; i < cols; i++, k++) {
          const w = wt[k];
          const kk = p.k0 + p.k1 * w;
          const cc = p.c0 + p.c1 * w;
          const ix = k * 2;
          const ox = off[ix];
          const oy = off[ix + 1];
          const lapX = off[ix - 2] + off[ix + 2] + off[ix - rowStride] + off[ix + rowStride] - 4 * ox;
          const lapY = off[ix - 1] + off[ix + 3] + off[ix + 1 - rowStride] + off[ix + 1 + rowStride] - 4 * oy;
          vel[ix] += (kk * (tgt[ix] - ox) - cc * vel[ix] + p.kappa * lapX) * h;
          vel[ix + 1] += (kk * (tgt[ix + 1] - oy) - cc * vel[ix + 1] + p.kappa * lapY) * h;
        }
      }
      // 2) 속도 → 변위
      for (let j = 1; j < rows; j++) {
        let ix = (j * (cols + 1) + 1) * 2;
        for (let i = 1; i < cols; i++, ix += 2) {
          off[ix] += vel[ix] * h;
          off[ix + 1] += vel[ix + 1] * h;
        }
      }
      this._holdBorder();
    }
    let m2 = 0;
    let v2 = 0;
    for (let ix = 0; ix < off.length; ix += 2) {
      const a = off[ix] * off[ix] + off[ix + 1] * off[ix + 1];
      if (a > m2) m2 = a;
      const b = vel[ix] * vel[ix] + vel[ix + 1] * vel[ix + 1];
      if (b > v2) v2 = b;
    }
    this.maxOffset = Math.sqrt(m2);
    this.maxSpeed = Math.sqrt(v2);
    // 다 멈췄으면 깨끗이 0 으로 맞추고 쉰다 (계산 절약)
    if (!this.fieldsActive && this.maxOffset < 0.3 && this.maxSpeed < 3) {
      off.fill(0);
      vel.fill(0);
      this.maxOffset = 0;
      this.maxSpeed = 0;
      this.sleeping = true;
    }
    return this.maxOffset;
  }
}

// ------------------------------------------------------------------ 그리기 도우미

/**
 * 격자 선분이 얼마나 늘어났는지(+) / 줄었는지(-). 늘어남 표시선 그리기에 쓴다.
 * @returns {number} (지금 길이 - 원래 길이) / 원래 길이
 */
export function segmentStrain(grid, a, b) {
  const r = grid.rest;
  const o = grid.offset;
  const rx = r[b * 2] - r[a * 2];
  const ry = r[b * 2 + 1] - r[a * 2 + 1];
  const cx = rx + o[b * 2] - o[a * 2];
  const cy = ry + o[b * 2 + 1] - o[a * 2 + 1];
  const l0 = Math.hypot(rx, ry);
  return l0 > 0 ? Math.hypot(cx, cy) / l0 - 1 : 0;
}

/** 놓을 때 띠용 소리 높이: 많이 늘였을수록 낮고 굵게 */
export function boingPitch(drag, sigma) {
  return clamp(1.35 - 0.45 * (drag / Math.max(1, sigma)), 0.6, 1.35);
}

/**
 * 격자 칸 (i, j) 가 뒤집혔는지(접혔는지): 변형된 사각형의 두 삼각형 중 하나라도 방향이 바뀌면 true.
 * (테스트·문제 찾기용)
 */
export function cellInverted(grid, i, j) {
  const s = grid.cols + 1;
  const a = j * s + i;
  const b = a + 1;
  const c = a + s;
  const d = c + 1;
  const P = (k) => [grid.rest[k * 2] + grid.offset[k * 2], grid.rest[k * 2 + 1] + grid.offset[k * 2 + 1]];
  const A = P(a);
  const B = P(b);
  const C = P(c);
  const D = P(d);
  const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  return cr(A, B, C) <= 0 || cr(B, D, C) <= 0;
}

// ------------------------------------------------------------------ 손은 일그러지지 않게

/** 손 조각 버퍼 (손마다 하나, 매 프레임 재사용) */
export function makePatchBuffer() {
  const maxHull = 24;
  return {
    pos: new Float32Array((1 + maxHull * 2) * 2),
    alpha: new Float32Array(1 + maxHull * 2),
    indices: new Uint16Array(maxHull * 9),
    pts: new Float32Array(maxHull * 2 + 8),
    hull: new Int16Array(maxHull * 2 + 4),
    n: 0,
    ni: 0,
  };
}

/**
 * 손(+팔목 조금)을 감싸는 볼록 껍질에 부드러운 가장자리를 붙인 조각을 만든다.
 * stage.drawPatch({pos, src: pos, alpha, indices}) 로 그리면 '일그러지기 전 영상'의 손이 그 자리에 다시 그려져서
 * 화면은 젤리처럼 늘어나도 아이 손은 제 자리에 또렷하게 보인다 (손잡이 고리와 손이 어긋나지 않음).
 * @returns {number} 정점 수 (0 이면 그릴 것 없음). buf.n, buf.ni 에도 기록.
 */
export function buildHandPatch(lm, size, buf, { pad = 0.08, feather = 0.16, arm = 0.1 } = {}) {
  const P = buf.pts;
  let np = 0;
  for (let i = 0; i < 21; i++) {
    P[np * 2] = lm[i].x;
    P[np * 2 + 1] = lm[i].y;
    np++;
  }
  // 팔목 쪽으로 조금 (손목 아래가 갑자기 끊겨 보이지 않게)
  const wx = lm[0].x;
  const wy = lm[0].y;
  let ax = wx - lm[9].x;
  let ay = wy - lm[9].y;
  const al = Math.hypot(ax, ay) || 1;
  ax /= al;
  ay /= al;
  for (const side of [-1, 1]) {
    P[np * 2] = wx + ax * arm * size - ay * side * 0.32 * size;
    P[np * 2 + 1] = wy + ay * arm * size + ax * side * 0.32 * size;
    np++;
  }
  // 볼록 껍질 (monotone chain) — 점이 23개뿐이라 단순 정렬로 충분
  const order = buf._order || (buf._order = new Int16Array(32));
  for (let i = 0; i < np; i++) order[i] = i;
  const ord = order.subarray(0, np);
  ord.sort((a, b) => P[a * 2] - P[b * 2] || P[a * 2 + 1] - P[b * 2 + 1]);
  const H = buf.hull;
  let m = 0;
  const cross = (o, a, b) => (P[a * 2] - P[o * 2]) * (P[b * 2 + 1] - P[o * 2 + 1]) - (P[a * 2 + 1] - P[o * 2 + 1]) * (P[b * 2] - P[o * 2]);
  for (let i = 0; i < np; i++) {
    while (m >= 2 && cross(H[m - 2], H[m - 1], ord[i]) <= 0) m--;
    H[m++] = ord[i];
  }
  for (let i = np - 2, lo = m + 1; i >= 0; i--) {
    while (m >= lo && cross(H[m - 2], H[m - 1], ord[i]) <= 0) m--;
    H[m++] = ord[i];
  }
  m--; // 마지막 점 = 첫 점
  const maxHull = (buf.alpha.length - 1) / 2;
  if (m < 3 || m > maxHull) {
    buf.n = 0;
    buf.ni = 0;
    return 0;
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < m; i++) {
    cx += P[H[i] * 2];
    cy += P[H[i] * 2 + 1];
  }
  cx /= m;
  cy /= m;
  const pos = buf.pos;
  const alpha = buf.alpha;
  pos[0] = cx;
  pos[1] = cy;
  alpha[0] = 1;
  const inner = pad * size;
  const outer = (pad + feather) * size;
  for (let i = 0; i < m; i++) {
    const a = H[(i + m - 1) % m];
    const b = H[i];
    const c = H[(i + 1) % m];
    // 바깥쪽 법선 = 이웃 두 변의 법선 평균 (껍질은 반시계 방향 → 오른쪽 법선 (dy, -dx) 가 바깥)
    const n1x = P[b * 2 + 1] - P[a * 2 + 1];
    const n1y = -(P[b * 2] - P[a * 2]);
    const n2x = P[c * 2 + 1] - P[b * 2 + 1];
    const n2y = -(P[c * 2] - P[b * 2]);
    const l1 = Math.hypot(n1x, n1y) || 1;
    const l2 = Math.hypot(n2x, n2y) || 1;
    let nx = n1x / l1 + n2x / l2;
    let ny = n1y / l1 + n2y / l2;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    // 방향 확인: 가운데에서 멀어지는 쪽
    if ((P[b * 2] - cx) * nx + (P[b * 2 + 1] - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const x = P[b * 2];
    const y = P[b * 2 + 1];
    pos[(1 + i) * 2] = x + nx * inner;
    pos[(1 + i) * 2 + 1] = y + ny * inner;
    alpha[1 + i] = 1;
    pos[(1 + m + i) * 2] = x + nx * outer;
    pos[(1 + m + i) * 2 + 1] = y + ny * outer;
    alpha[1 + m + i] = 0;
  }
  const idx = buf.indices;
  let q = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const in0 = 1 + i;
    const in1 = 1 + j;
    const out0 = 1 + m + i;
    const out1 = 1 + m + j;
    idx[q++] = 0;
    idx[q++] = in0;
    idx[q++] = in1;
    idx[q++] = in0;
    idx[q++] = out0;
    idx[q++] = out1;
    idx[q++] = in0;
    idx[q++] = out1;
    idx[q++] = in1;
  }
  buf.n = 1 + 2 * m;
  buf.ni = q;
  return buf.n;
}

/** 점 (x, y) 가 손 조각의 불투명한 안쪽 껍질 안에 있는지 (pad px 만큼 여유) */
export function insidePatch(buf, x, y, pad = 0) {
  const m = (buf.n - 1) / 2;
  if (m < 3) return false;
  // 볼록 다각형: 모든 변의 같은 쪽에 있으면 안쪽. 여유는 변까지의 거리로 판단.
  const cx = buf.pos[0];
  const cy = buf.pos[1];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const x1 = buf.pos[(1 + i) * 2];
    const y1 = buf.pos[(1 + i) * 2 + 1];
    const x2 = buf.pos[(1 + j) * 2];
    const y2 = buf.pos[(1 + j) * 2 + 1];
    const ex = x2 - x1;
    const ey = y2 - y1;
    const l = Math.hypot(ex, ey) || 1;
    // 가운데가 있는 쪽을 안쪽으로
    const sc = ((cx - x1) * ey - (cy - y1) * ex) / l;
    const sp = ((x - x1) * ey - (y - y1) * ex) / l;
    if (sc * sp < 0 && Math.abs(sp) > pad) return false;
  }
  return true;
}
