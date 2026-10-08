// 동물 귀 놀이의 순수 로직 (DOM 의존성 없음, node 에서 테스트).
//   - 얼굴에서 머리 틀(위치·각도·크기) 구하기, 귀가 붙을 자리 계산
//   - 브이(✌️) 감지: 손마다 '한 번 브이 = 한 번 변신', 잠깐 깜빡여도 두 번 세지 않기
//   - 브이한 손과 가장 어울리는 얼굴 고르기 (너무 먼 손, 잠깐 안 보이는 아이의 손은 남에게 주지 않기)
//   - 잠깐 사라졌다 다시 나타난 얼굴에게 귀 돌려주기
//   - 안내 문구 고르기, 반짝이 입자 풀

import { dist } from '../../core/math.js';
import { FACE } from '../../core/synth.js';

// ------------------------------------------------------------------ 머리 틀

/**
 * 머리 모양 (길이는 얼굴 크기 S 배수).
 *   hair : 이마 위 점(랜드마크 10)에서 머리 꼭대기(머리카락 포함)까지
 *   half : 머리 반폭 (머리카락 포함)
 *   round: 머리 윗부분 모양 (2 = 타원, 클수록 위쪽 모서리가 덜 깎인 둥근 사각형)
 *   sink : 귀 뿌리를 머리 윤곽에서 안쪽으로 넣는 깊이 (뿌리는 투명하게 스며들어 작은 틈을 가린다)
 *
 * camera: 실제 사진에 얼굴 인식기(vendor 모델)를 돌려 잰 값. 머리가 아주 짧은 어른도
 *         랜드마크 10(이마 가운데쯤) → 정수리가 0.41S, 머리 반폭이 0.58S 였다.
 *         아이는 얼굴에 비해 머리가 더 크고 머리카락도 있으니, 귀 뿌리는 머리카락 속에 살짝 묻히는 쪽으로 잡는다
 *         (둥둥 뜬 귀보다 머리카락에서 돋아난 귀가 훨씬 자연스럽다).
 * sim   : 연습 모드 만화 얼굴 (core/sim.js 가 그리는 머리카락 = 눈 사이가 중심이고 반지름이 얼굴 높이의 0.5 인 원).
 */
export const HEAD = Object.freeze({
  camera: Object.freeze({ hair: 0.46, half: 0.6, round: 2.6, sink: 0.05 }),
  sim: Object.freeze({ hair: 0.143, half: 0.595, round: 2, sink: 0.05 }),
});

/**
 * 얼굴 크기 S = 양쪽 볼(234, 454) 사이 3D 거리.
 *  - 깊이(z)까지 재므로 고개를 좌우로 돌려 화면에서 볼 사이가 좁아져도 거의 그대로다.
 *  - 이마~턱 높이와 달리 말하거나 입을 크게 벌려도 변하지 않는다 (귀가 커졌다 작아졌다 하지 않게).
 * @param {object} face Face
 */
export function faceSize(face) {
  const w2 = face.width || 0;
  const a = face.key?.[FACE.RIGHT_CHEEK];
  const b = face.key?.[FACE.LEFT_CHEEK];
  let s = w2;
  // 깊이 값이 튀어도 화면 너비의 1.8배(고개를 57° 돌린 정도)까지만 되돌린다
  if (a && b) s = Math.min(Math.max(Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)), w2), w2 / 0.55);
  // 볼 점이 엉뚱할 때만 받쳐 주는 아래 한계 (입을 크게 벌려도 보통은 S 가 이 값보다 크다)
  return Math.max(s, (face.height || 0) * 0.62, 1);
}

/**
 * 얼굴 정보에서 머리 틀을 만든다.
 *   x, y : 두 눈 사이 (머리 윤곽의 중심으로 쓴다)
 *   ang  : 머리 기울기 (0 = 똑바로, 양수 = 시계 방향) — 턱→이마 방향에서 구해 눈 사이 벡터보다 덜 떨린다
 *   size : 얼굴 크기 S (faceSize)
 *   crown: 눈 사이 → 머리 꼭대기 거리 = 눈 → 이마 위 점(턱과 상관없음) + 그 위 머리 높이
 *   yaw  : 좌우로 돌린 각도 (라디안 추정)
 * @param {object} face Face (facetracker.js)
 * @param {{hair:number}} [profile] HEAD.camera | HEAD.sim
 */
export function headTarget(face, profile = HEAD.camera) {
  const eyes = { x: (face.leftEye.x + face.rightEye.x) / 2, y: (face.leftEye.y + face.rightEye.y) / 2 };
  const up = face.up && (face.up.x || face.up.y) ? face.up : { x: Math.sin(face.roll || 0), y: -Math.cos(face.roll || 0) };
  const ang = Math.atan2(up.x, -up.y);
  const size = faceSize(face);
  const top = face.forehead || face.headTop;
  const brow = (top.x - eyes.x) * up.x + (top.y - eyes.y) * up.y;
  const crown = Math.min(size * 1.15, Math.max(size * 0.55, brow + profile.hair * size));
  const yaw = Math.asin(Math.max(-0.9, Math.min(0.9, (face.yaw || 0) * 0.85)));
  return { x: eyes.x, y: eyes.y, ang, size, crown, yaw };
}

/** 머리 윤곽 위의 점 (머리 좌표: lat = 옆, upv = 위). place 0 = 꼭대기, π/2 = 옆 (눈높이) */
export function headOutline(place, half, crown, round = 2, out = { lat: 0, upv: 0 }) {
  const e = 2 / round;
  const s = Math.sin(place);
  const c = Math.cos(place);
  out.lat = half * Math.sign(s) * Math.pow(Math.abs(s), e);
  out.upv = crown * Math.sign(c) * Math.pow(Math.abs(c), e);
  return out;
}

const _pt = { lat: 0, upv: 0 };

/**
 * 귀 두 개가 붙을 자리와 쉬는 각도.
 * 머리를 '눈 사이를 중심으로 한 둥근 윤곽'으로 보고, 동물마다 정한 각도(place)의 윤곽 위 점에서 살짝 안쪽(머리카락 속)에 붙인다.
 * 고개를 돌리면(yaw) 두 귀 사이가 좁아지고, 머리 중심(얼굴보다 뒤)에 맞춰 반대쪽으로 조금 밀린다.
 * @param {{x:number,y:number,ang:number,size:number,crown:number,yaw:number}} head
 * @param {import('./animals.js').Animal} animal
 * @param {object[]} [out] 재사용할 결과 배열 (길이 2)
 * @param {{half:number, round:number, sink:number}} [profile] HEAD.camera | HEAD.sim
 * @returns {{x:number,y:number,side:number,rest:number,angle:number,widthMul:number,depth:number,near:boolean}[]}
 */
export function earAnchors(head, animal, out = [{}, {}], profile = HEAD.camera) {
  const { x, y, ang, size: S, crown } = head;
  const yaw = head.yaw || 0;
  const ux = Math.sin(ang);
  const uy = -Math.cos(ang);
  const rx = Math.cos(ang);
  const ry = Math.sin(ang);
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  const shift = -sinY * 0.28 * S;
  const sink = profile.sink * S;
  headOutline(animal.place, profile.half * S, crown, profile.round, _pt);
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    let lat = side * _pt.lat;
    let upv = _pt.upv;
    const n = Math.hypot(lat, upv) || 1;
    lat -= (lat / n) * sink;
    upv -= (upv / n) * sink;
    lat = lat * cosY + shift;
    const o = out[i];
    o.x = x + rx * lat + ux * upv;
    o.y = y + ry * lat + uy * upv;
    o.side = side;
    // 옆으로 기운 정도는 고개를 돌린 만큼 납작해 보인다
    const t = animal.tilt;
    o.rest = side * Math.atan2(Math.sin(t) * (0.55 + 0.45 * cosY), Math.cos(t));
    o.angle = ang + o.rest;
    o.widthMul = 1 - 0.3 * Math.abs(sinY);
    o.depth = 1 - side * sinY * 0.08; // 가까운 귀는 조금 크게
    o.near = side * sinY < 0;
  }
  return out;
}

// ------------------------------------------------------------------ 얼굴 고르기

/**
 * 손(브이한 곳)과 얼굴의 어울림 점수. 작을수록 그 아이의 손일 가능성이 크다.
 *  - 얼굴 크기로 나눈 거리 (아래쪽 — 가슴 앞 — 은 덜 멀게 친다)
 *  - 손 크기와 얼굴 크기가 비슷한 비율인지 (같은 거리에 서 있는 아이)
 * @param {number} px, py 손 위치
 * @param {number} handSize 손 크기 px (없으면 0)
 * @param {{x:number,y:number,size:number}} f 얼굴 (머리 틀)
 */
export function faceCost(px, py, handSize, f) {
  const s = Math.max(1, f.size);
  const dx = (px - f.x) / s;
  let dy = (py - f.y) / s;
  if (dy > 0) dy *= 0.6;
  const d = Math.hypot(dx, dy);
  const ratio = handSize > 0 ? handSize / (s * 0.62) : 1;
  return d + Math.abs(Math.log(Math.max(0.05, ratio))) * 0.6;
}

/** 브이한 손이 이보다 멀면(faceCost) 그 얼굴의 아이가 한 브이로 보지 않는다 */
export const MAX_V_COST = 2.8;
/** 잠깐 전에 사라진 얼굴은 비슷한 거리면 지금 보이는 얼굴에게 진다 */
const GHOST_PENALTY = 0.2;

/**
 * 브이한 손에게 가장 어울리는 얼굴 번호 (-1 = 없음).
 * 얼굴이 하나뿐이어도 너무 먼 손은 고르지 않는다 — 얼굴이 잠깐 안 보이는 다른 아이(옆을 봄, 손이 얼굴을 가림,
 * 화면 가장자리)의 브이일 수 있어서, 엉뚱한 아이의 귀가 바뀌지 않게 한다.
 * faces 에 잠깐 전에 사라진 얼굴({ghost:true})을 섞어 두면, 그 얼굴이 뽑혔을 때 브이를 남에게 주지 않고 기다릴 수 있다.
 * @param {{x:number,y:number,size:number,ghost?:boolean}[]} faces
 */
export function pickFace(px, py, handSize, faces, maxCost = MAX_V_COST) {
  let best = -1;
  let bestCost = Infinity;
  for (let i = 0; i < faces.length; i++) {
    const c = faceCost(px, py, handSize, faces[i]) + (faces[i].ghost ? GHOST_PENALTY : 0);
    if (c < bestCost) {
      bestCost = c;
      best = i;
    }
  }
  return bestCost <= maxCost ? best : -1;
}

/**
 * 사라진 얼굴 자리 기억(ghost) 정리: window 초가 지났거나, 그 자리에 얼굴이 다시 보이면 지운다.
 * 귀가 있든 없든 모든 얼굴을 기억해 두고, 그 아이의 브이를 다른 아이에게 주지 않는 데 쓴다.
 * @param {{x:number,y:number,size:number,lostAt:number}[]} ghosts (그 자리에서 고친다)
 * @param {{x:number,y:number,size:number}[]} live 지금 보이는 얼굴들
 */
export function pruneGhosts(ghosts, live, t, window = 1.5) {
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i];
    let gone = t - g.lostAt > window;
    for (let k = 0; k < live.length && !gone; k++) {
      const f = live[k];
      if (Math.hypot(f.x - g.x, f.y - g.y) < Math.max(f.size, g.size) * 0.9) gone = true;
    }
    if (gone) ghosts.splice(i, 1);
  }
  return ghosts;
}

// ------------------------------------------------------------------ 브이 감지

/**
 * 손마다 브이를 지켜본다.
 *  - 'fresh': 새로 한 브이 (한 번 쓰면 브이를 풀었다가 다시 해야 또 나온다)
 *  - 'held' : 브이를 계속 하고 있음 (귀가 아직 없는 얼굴에게만 쓴다)
 *  - since  : 그 브이를 시작한 시각, key: 그 손의 변하지 않는 번호 (둘이 같으면 같은 브이)
 * 브이가 아닌 자세가 rearm 초 이상 이어져야 다시 준비된다 (인식이 잠깐 깜빡여도 두 번 세지 않게).
 *
 * 브이를 하던 손을 인식기가 잠깐 놓쳐 새 id 로 다시 잡으면, 그 자리 근처일 때 새 브이로 치지 않는다.
 * 다만 이 기억은 아주 짧게만 (손 추적 유예 0.2초 + inheritWindow): 아이들은 손을 등 뒤로 숨겼다가
 * "짠!" 하고 브이를 다시 내밀곤 하는데, 그건 새 브이여야 한다. 빠르게 움직이다 사라진 손이나
 * 화면 가장자리로 나간 손은 일부러 치운 손이라 거의 기억하지 않는다.
 */
export class VWatcher {
  constructor({ rearm = 0.2, inheritWindow = 0.25, inheritFast = 0.06, inheritDist = 1.6, leaveSpeed = 2.5, edge = 0.6 } = {}) {
    this.rearm = rearm;
    this.inheritWindow = inheritWindow;
    this.inheritFast = inheritFast;
    this.inheritDist = inheritDist;
    this.leaveSpeed = leaveSpeed; // 손 크기/초: 이보다 빨리 움직이다 사라지면 치운 손
    this.edge = edge; // 손 크기 배수: 화면 가장자리에서 이만큼 안쪽까지는 '밖으로 나감'
    /** @type {Map<number, {key:number, armed:boolean, offSince:number|null, wasV:boolean, vSince:number|null, x:number, y:number, size:number, speed:number}>} */
    this.hands = new Map();
    /** 브이를 한 채로 사라진 손들 */
    this.lost = [];
    this._seen = new Set();
  }

  /**
   * @param {object[]} hands Hand[]
   * @param {number} t 초 (실제 시각 — 프레임이 느려도 '0.25초 동안 브이가 아님'을 정확히 잰다)
   * @param {{width:number, height:number}} [bounds] 화면 크기 (가장자리로 나간 손 알아보기)
   * @returns {{type:'fresh'|'held', hand:object, key:number, x:number, y:number, since:number}[]}
   */
  update(hands, t, bounds = null) {
    const events = [];
    for (let i = this.lost.length - 1; i >= 0; i--) {
      if (t - this.lost[i].t > this.inheritWindow) this.lost.splice(i, 1);
    }
    const seen = this._seen;
    seen.clear();
    for (const h of hands) {
      seen.add(h.id);
      let rec = this.hands.get(h.id);
      if (!rec) {
        rec = { key: h.id, armed: true, offSince: null, wasV: false, vSince: null, x: h.palm.x, y: h.palm.y, size: h.size, speed: 0 };
        const from = this._inherits(h, t);
        if (from) {
          // 같은 브이가 이어진다: 번호와 시작 시각을 물려받는다
          rec.armed = false;
          rec.key = from.key;
          rec.vSince = from.vSince;
        }
        this.hands.set(h.id, rec);
      }
      if (h.stale) continue;
      rec.x = h.palm.x;
      rec.y = h.palm.y;
      rec.size = h.size;
      rec.speed = h.velocity ? Math.hypot(h.velocity.x, h.velocity.y) / Math.max(1, h.size) : 0;
      if (h.pose === 'v') {
        rec.offSince = null;
        rec.wasV = true;
        if (rec.vSince === null) rec.vSince = t;
        const p = vPoint(h);
        if (rec.armed) {
          rec.armed = false;
          events.push({ type: 'fresh', hand: h, key: rec.key, x: p.x, y: p.y, since: rec.vSince });
        } else {
          events.push({ type: 'held', hand: h, key: rec.key, x: p.x, y: p.y, since: rec.vSince });
        }
      } else {
        if (rec.offSince === null) rec.offSince = t;
        if (t - rec.offSince >= this.rearm) {
          rec.armed = true;
          rec.wasV = false;
          rec.vSince = null;
        }
      }
    }
    for (const [id, rec] of this.hands) {
      if (seen.has(id)) continue;
      if (rec.wasV && !this._atEdge(rec, bounds)) {
        this.lost.push({ key: rec.key, vSince: rec.vSince, x: rec.x, y: rec.y, size: rec.size, t, fast: rec.speed > this.leaveSpeed });
      }
      this.hands.delete(id);
    }
    return events;
  }

  /**
   * 새 브이를 쓸 곳이 없었을 때(그 아이 얼굴이 안 보임 — 브이한 손이 얼굴을 가려 인식이 잠깐 끊기는 일이 흔하다)
   * 브이를 시작한 지 window 초 안이면 다음 프레임에 다시 'fresh' 가 나오도록 되돌린다.
   */
  restore(handId, t, window = 1.5) {
    const rec = this.hands.get(handId);
    if (rec && rec.vSince !== null && t - rec.vSince <= window) rec.armed = true;
  }

  _atEdge(rec, bounds) {
    if (!bounds || !(bounds.width > 0)) return false;
    const m = rec.size * this.edge;
    return rec.x < m || rec.y < m || rec.x > bounds.width - m || rec.y > bounds.height - m;
  }

  /** 지금 보이거나 잠깐 놓친(이어질 수 있는) 손의 key 인지 */
  isKnown(key) {
    for (const rec of this.hands.values()) if (rec.key === key) return true;
    for (const l of this.lost) if (l.key === key) return true;
    return false;
  }

  /** @returns {{key:number, vSince:number|null}|null} 이어 받을 사라진 브이 손 */
  _inherits(h, t) {
    for (let i = 0; i < this.lost.length; i++) {
      const l = this.lost[i];
      const window = l.fast ? this.inheritFast : this.inheritWindow;
      if (t - l.t <= window && dist(l, h.palm) < Math.max(l.size, h.size) * this.inheritDist) {
        this.lost.splice(i, 1); // 한 손에게만 이어 준다
        return l;
      }
    }
    return null;
  }
}

/** 브이 손가락 두 끝의 가운데 (반짝이가 날아갈 출발점) */
export function vPoint(h) {
  const a = h.tips?.[1];
  const b = h.tips?.[2];
  if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { x: h.palm.x, y: h.palm.y };
}

// ------------------------------------------------------------------ 얼굴 이어 주기

/**
 * 새로 나타난 얼굴이, 잠깐 전에 사라진 얼굴(귀를 달고 있던)과 같은 아이인지 찾는다.
 * @param {{x:number,y:number,size:number}} head 새 얼굴
 * @param {{x:number,y:number,size:number,lostAt:number}[]} lost 사라진 얼굴들
 * @returns {number} lost 안의 번호, 없으면 -1
 */
export function findCarry(head, lost, t, { window = 1.5, reach = 1.3 } = {}) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < lost.length; i++) {
    const l = lost[i];
    if (t - l.lostAt > window) continue;
    const d = Math.hypot(head.x - l.x, head.y - l.y);
    if (d > Math.max(head.size, l.size) * reach) continue;
    if (Math.abs(Math.log(Math.max(1, head.size) / Math.max(1, l.size))) > 0.7) continue;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ------------------------------------------------------------------ 안내 문구

export const HINTS = Object.freeze({
  noFace: '얼굴이 화면에 보이게 서 주세요 🙂',
  makeV: '브이 ✌️ 를 해 보세요!',
  friend: '친구도 브이 ✌️ 하면 동물 귀가 생겨요!',
  again: '한 번 더 브이 ✌️ 하면 다른 동물로 바뀌어요',
  shake: '고개를 갸웃갸웃 흔들어 봐요 🎵',
  tongue: '입을 크게 아~ 벌려 봐요! 👅',
});

/**
 * @param {{faces:number, withEars:number, animal?:string|null, idle?:number, mouthOpen?:number}} s
 *   idle: 마지막 변신 뒤 지난 시간(초) — 한동안 그대로면 다른 놀이 방법을 알려 준다
 *   mouthOpen: 가장 가까운 아이의 입 벌림 (강아지 혀가 이미 나와 있으면 '입 벌려 봐요'는 안 한다)
 */
export function chooseHint({ faces, withEars, animal = null, idle = 0, mouthOpen = 0 }) {
  if (faces <= 0) return HINTS.noFace;
  if (withEars <= 0) return HINTS.makeV;
  if (withEars < faces) return HINTS.friend;
  if (idle > 5 && Math.floor((idle - 5) / 5) % 2 === 0) return animal === 'dog' && mouthOpen < 0.3 ? HINTS.tongue : HINTS.shake;
  return HINTS.again;
}

/** 안내 문구가 인식 흔들림 때문에 깜빡이지 않도록, 바뀐 문구가 hold 초 동안 그대로일 때만 바꾼다. */
export class StableText {
  constructor(hold = 0.4) {
    this.hold = hold;
    this.value = null;
    this._cand = null;
    this._since = 0;
  }
  /**
   * @param {string} text 지금 보여 주고 싶은 문구
   * @param {number} t 초 (실제 시각)
   * @returns {boolean} 값이 바뀌었으면 true
   */
  push(text, t) {
    if (this.value === null) {
      this.value = text;
      return true;
    }
    if (text === this.value) {
      this._cand = null;
      return false;
    }
    if (text !== this._cand) {
      this._cand = text;
      this._since = t;
    }
    if (t - this._since >= this.hold) {
      this.value = text;
      this._cand = null;
      return true;
    }
    return false;
  }
}

// ------------------------------------------------------------------ 반짝이 입자

/** 정해진 개수만 쓰는 입자 풀. 꽉 차면 가장 오래된 것부터 다시 쓴다 (매 프레임 새 객체를 만들지 않는다). */
export class ParticlePool {
  constructor(capacity = 160) {
    this.capacity = capacity;
    this.items = Array.from({ length: capacity }, () => ({
      alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, age: 0, size: 0, rot: 0, spin: 0, color: '#fff', kind: 'dot', gravity: 0, drag: 0,
    }));
    this.count = 0;
    this._cursor = 0;
  }

  /** @param {{x:number,y:number,vx?:number,vy?:number,life?:number,size?:number,rot?:number,spin?:number,color?:string,kind?:string,gravity?:number,drag?:number}} o */
  emit(o) {
    let p = null;
    for (let k = 0; k < this.capacity; k++) {
      const i = (this._cursor + k) % this.capacity;
      if (!this.items[i].alive) {
        p = this.items[i];
        this._cursor = (i + 1) % this.capacity;
        break;
      }
    }
    if (!p) {
      p = this.items[this._cursor];
      this._cursor = (this._cursor + 1) % this.capacity;
      this.count--;
    }
    p.alive = true;
    p.x = o.x;
    p.y = o.y;
    p.vx = o.vx || 0;
    p.vy = o.vy || 0;
    p.life = o.life || 0.8;
    p.age = 0;
    p.size = o.size || 6;
    p.rot = o.rot || 0;
    p.spin = o.spin || 0;
    p.color = o.color || '#fff';
    p.kind = o.kind || 'dot';
    p.gravity = o.gravity || 0;
    p.drag = o.drag || 0;
    this.count++;
    return p;
  }

  update(dt) {
    for (const p of this.items) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        this.count--;
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
  }

  clear() {
    for (const p of this.items) p.alive = false;
    this.count = 0;
  }
}
