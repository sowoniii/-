// 손 랜드마크(21개)로 손 모양을 판별하는 순수 함수 모음. DOM 의존성이 없어 node 에서 테스트할 수 있다.
//
// 랜드마크 번호 (MediaPipe Hands):
//   0 손목
//   엄지 1 CMC, 2 MCP, 3 IP, 4 끝
//   검지 5 MCP, 6 PIP, 7 DIP, 8 끝
//   중지 9..12, 약지 13..16, 새끼 17..20
//
// 입력 좌표는 화면 px 기준 {x, y, z}. z 도 px 단위(영상 너비 기준)로 맞춰서 3D 각도가 의미 있게 한다.

import { DEG, centroid, clamp, dist3, invLerp } from './math.js';

export const LM = Object.freeze({
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
});

export const FINGER_NAMES = Object.freeze(['thumb', 'index', 'middle', 'ring', 'pinky']);
/** 손가락별 [뿌리, 둘째, 셋째, 끝] 랜드마크 번호 */
export const FINGER_JOINTS = Object.freeze([
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
]);
export const TIP_IDS = Object.freeze([4, 8, 12, 16, 20]);

/** 뼈대 연결 (그리기용) */
export const HAND_CONNECTIONS = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
]);

export const POSES = Object.freeze(['open', 'fist', 'v', 'point', 'pinch', 'other']);

/** b 에서 꺾인 정도(도). 0 이면 a-b-c 가 일직선. */
export function jointBend(a, b, c) {
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v1z = (b.z || 0) - (a.z || 0);
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const v2z = (c.z || 0) - (b.z || 0);
  const l1 = Math.hypot(v1x, v1y, v1z);
  const l2 = Math.hypot(v2x, v2y, v2z);
  if (l1 < 1e-6 || l2 < 1e-6) return 0;
  const cos = clamp((v1x * v2x + v1y * v2y + v1z * v2z) / (l1 * l2), -1, 1);
  return Math.acos(cos) * DEG;
}

/**
 * 손 크기(px). 손목→중지 뿌리 길이와 손바닥 너비 중 큰 쪽을 쓴다.
 * 손이 앞뒤로 기울거나 옆으로 돌아가도 크기가 갑자기 줄어들지 않게 하기 위함.
 */
export function handSize(lm) {
  const length = dist3(lm[LM.WRIST], lm[LM.MIDDLE_MCP]);
  const width = dist3(lm[LM.INDEX_MCP], lm[LM.PINKY_MCP]) * 1.3;
  return Math.max(length, width, 1e-6);
}

/** 손바닥 중심 (손목 + 네 손가락 뿌리 평균) */
export function palmCenter(lm) {
  return centroid([lm[0], lm[5], lm[9], lm[13], lm[17]]);
}

/** 검지~새끼 손가락이 얼마나 펴졌는지 0(접힘)..1(쭉 폄) */
export function fingerExtension(lm, finger) {
  const [m, p, d, t] = FINGER_JOINTS[finger];
  const w = lm[LM.WRIST];
  const bend = jointBend(w, lm[m], lm[p]) + jointBend(lm[m], lm[p], lm[d]) + jointBend(lm[p], lm[d], lm[t]);
  const ratio = dist3(w, lm[t]) / Math.max(dist3(w, lm[p]), 1e-6);
  const angleScore = invLerp(160, 50, bend);
  const reachScore = invLerp(0.95, 1.3, ratio);
  return 0.5 * angleScore + 0.5 * reachScore;
}

/** 엄지가 얼마나 바깥으로 펴졌는지 0..1 */
export function thumbExtension(lm, size = handSize(lm)) {
  const tip = lm[LM.THUMB_TIP];
  const away = invLerp(0.3, 0.6, dist3(tip, lm[LM.INDEX_MCP]) / size);
  const pinkyBase = lm[LM.PINKY_MCP];
  const outward = invLerp(0.95, 1.15, dist3(tip, pinkyBase) / Math.max(dist3(lm[LM.THUMB_IP], pinkyBase), 1e-6));
  return 0.5 * away + 0.5 * outward;
}

/**
 * 손 하나를 분석한다.
 * @returns {{size:number, palm:{x,y,z}, ext:number[], pinchDist:number, openness:number,
 *            tipToPalm:number, spread:number}}
 */
export function analyzeHand(lm) {
  const size = handSize(lm);
  const palm = palmCenter(lm);
  const ext = [thumbExtension(lm, size)];
  for (let f = 1; f < 5; f++) ext.push(fingerExtension(lm, f));
  const pinchDist = dist3(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]) / size;
  const openness = (ext[1] + ext[2] + ext[3] + ext[4]) / 4;
  let tipSum = 0;
  for (let f = 1; f < 5; f++) tipSum += dist3(lm[TIP_IDS[f]], palm);
  const tipToPalm = tipSum / 4 / size;
  // 검지와 중지 사이 벌어진 각도(도) — 브이 판별에 사용
  const spread = vectorAngle(lm[LM.INDEX_MCP], lm[LM.INDEX_TIP], lm[LM.MIDDLE_MCP], lm[LM.MIDDLE_TIP]);
  return { size, palm, ext, pinchDist, openness, tipToPalm, spread };
}

/** 두 벡터 (a→b), (c→d) 사이 각도(도) */
function vectorAngle(a, b, c, d) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = (b.z || 0) - (a.z || 0);
  const vx = d.x - c.x;
  const vy = d.y - c.y;
  const vz = (d.z || 0) - (c.z || 0);
  const l = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
  if (l < 1e-9) return 0;
  return Math.acos(clamp((ux * vx + uy * vy + uz * vz) / l, -1, 1)) * DEG;
}

export const THRESHOLDS = Object.freeze({
  extended: 0.6,
  curled: 0.4,
  pinchEnter: 0.3,
  pinchExit: 0.45,
  fistTipToPalm: 0.95,
  vSpread: 8,
});

/**
 * 한 프레임의 손 모양을 판별한다. prevPose 를 넘기면 집기(pinch)에 히스테리시스를 준다.
 * @returns {'open'|'fist'|'v'|'point'|'pinch'|'other'}
 */
export function classifyPose(a, prevPose = 'other') {
  const T = THRESHOLDS;
  const [, ix, md, rg, pk] = a.ext;
  const fourCurled = ix < T.curled && md < T.curled && rg < T.curled && pk < T.curled;
  if (fourCurled && a.tipToPalm < T.fistTipToPalm) return 'fist';

  const pinchLimit = prevPose === 'pinch' ? T.pinchExit : T.pinchEnter;
  if (a.pinchDist < pinchLimit && ix > 0.2) return 'pinch';

  const ext = (v) => v > T.extended;
  const curl = (v) => v < T.curled + 0.1;
  if (ext(ix) && ext(md) && ext(rg) && ext(pk)) return 'open';
  if (ext(ix) && ext(md) && curl(rg) && curl(pk) && a.spread > T.vSpread) return 'v';
  if (ext(ix) && curl(md) && curl(rg) && curl(pk)) return 'point';
  return 'other';
}

/**
 * 손 모양이 몇 프레임 연속으로 같아야 바뀌도록 해서 깜빡임을 없앤다.
 */
export class PoseStabilizer {
  constructor({ holdFrames = 3, otherHoldFrames = 5 } = {}) {
    this.holdFrames = holdFrames;
    this.otherHoldFrames = otherHoldFrames;
    this.pose = 'other';
    this.candidate = null;
    this.count = 0;
  }
  /** @returns {{pose:string, prev:string, changed:boolean}} */
  push(raw) {
    const prev = this.pose;
    if (raw === this.pose) {
      this.candidate = null;
      this.count = 0;
      return { pose: this.pose, prev, changed: false };
    }
    if (raw === this.candidate) this.count++;
    else {
      this.candidate = raw;
      this.count = 1;
    }
    const need = raw === 'other' ? this.otherHoldFrames : this.holdFrames;
    if (this.count >= need) {
      this.pose = raw;
      this.candidate = null;
      this.count = 0;
      return { pose: this.pose, prev, changed: true };
    }
    return { pose: this.pose, prev, changed: false };
  }
  reset(pose = 'other') {
    this.pose = pose;
    this.candidate = null;
    this.count = 0;
  }
}
