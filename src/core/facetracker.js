// 얼굴 검출 결과에 고정 id 를 붙이고, 머리 위치·기울기·크기·입 모양 등 쓰기 좋은 값으로 정리한다.
// 입력/출력 모두 화면 px 좌표. DOM 의존성이 없다.

import { PointsFilter } from './filters.js';
import { FACE } from './synth.js';
import { dist, dist3, mid, norm, sub, centroid } from './math.js';

let nextFaceId = 1;

/** 부드럽게 만들 주요 점 목록 */
const KEY_IDS = [
  FACE.FOREHEAD, FACE.CHIN, FACE.NOSE_TIP, FACE.BETWEEN_EYES, FACE.UPPER_LIP, FACE.LOWER_LIP,
  FACE.MOUTH_RIGHT, FACE.MOUTH_LEFT, FACE.RIGHT_EYE_OUTER, FACE.LEFT_EYE_OUTER,
  FACE.RIGHT_EYE_INNER, FACE.LEFT_EYE_INNER, FACE.RIGHT_CHEEK, FACE.LEFT_CHEEK,
  FACE.RIGHT_BROW, FACE.LEFT_BROW, FACE.RIGHT_EYE_TOP, FACE.RIGHT_EYE_BOTTOM,
  FACE.LEFT_EYE_TOP, FACE.LEFT_EYE_BOTTOM,
];

/**
 * @typedef {{x:number, y:number, z?:number}} Point
 *
 * @typedef {object} Face  모드에 전달되는 얼굴 정보. 같은 얼굴이면 프레임이 바뀌어도 같은 객체다.
 * @property {number} id
 * @property {Point[]} lm       478개 원본 랜드마크 (화면 px)
 * @property {Object<number, Point>} key  부드럽게 만든 주요 점 (FACE 상수 번호로 접근)
 * @property {Point} center     얼굴 중심 (눈과 입 사이)
 * @property {Point} forehead   이마 위쪽 (헤어라인 근처)
 * @property {Point} headTop    추정한 정수리 위치 (이마 위로 0.41×size, 턱 움직임과 무관)
 * @property {Point} chin
 * @property {Point} nose
 * @property {Point} mouth      입 중심
 * @property {Point} leftEye    본인 왼쪽 눈 중심 (거울 화면에서는 화면 왼쪽)
 * @property {Point} rightEye   본인 오른쪽 눈 중심 (거울 화면에서는 화면 오른쪽)
 * @property {number} roll      머리 기울기 (라디안, 0 = 똑바로, 양수 = 화면에서 시계 방향)
 * @property {number} yaw       좌우로 돌린 정도 대략 -1..1
 * @property {{x:number,y:number}} up  턱→이마 방향 단위 벡터
 * @property {number} width     얼굴 너비 px (양쪽 볼 사이)
 * @property {number} height    얼굴 높이 px (이마~턱, 입을 벌리면 커진다)
 * @property {number} size      안정된 얼굴 크기 px = 양쪽 볼 사이 3D 거리 (말하거나 고개를 돌려도 거의 그대로). 크기 기준으로 쓰기 좋다.
 * @property {number} mouthOpen 0..1
 * @property {Object<string, number>} blend  블렌드셰이프 점수 (mouthPucker, jawOpen, cheekPuff ...)
 * @property {number} blow      입김 부는 입 모양 정도 0..1 (오므린 입/볼 부풀림)
 * @property {number} age
 * @property {boolean} stale
 */

export class FaceTracker {
  constructor({ grace = 0.3 } = {}) {
    this.grace = grace;
    this.tracks = new Map();
    this.lastT = null;
  }

  /**
   * @param {{lm:Point[], blend?:Object<string,number>}[]} detections
   * @param {number} t 초
   * @returns {Face[]}
   */
  update(detections, t) {
    const dt = this.lastT === null ? 1 / 30 : Math.max(1e-3, Math.min(0.1, t - this.lastT));
    this.lastT = t;
    const dets = detections.map((d) => ({
      ...d,
      c: centroid([d.lm[FACE.FOREHEAD], d.lm[FACE.CHIN], d.lm[FACE.RIGHT_CHEEK], d.lm[FACE.LEFT_CHEEK]]),
      h: dist(d.lm[FACE.FOREHEAD], d.lm[FACE.CHIN]),
    }));

    const pairs = [];
    for (const [id, tr] of this.tracks) {
      for (let i = 0; i < dets.length; i++) {
        const d = dist(tr.face.center, dets[i].c);
        if (d < Math.max(tr.face.height, dets[i].h) * 0.9) pairs.push({ id, i, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const usedTracks = new Set();
    const usedDets = new Set();
    for (const p of pairs) {
      if (usedTracks.has(p.id) || usedDets.has(p.i)) continue;
      usedTracks.add(p.id);
      usedDets.add(p.i);
      this._apply(this.tracks.get(p.id), dets[p.i], t, dt);
    }
    for (let i = 0; i < dets.length; i++) {
      if (usedDets.has(i)) continue;
      const id = nextFaceId++;
      const track = { face: { id, born: t, height: dets[i].h, center: dets[i].c }, filter: new PointsFilter(KEY_IDS.length), lastSeen: t };
      this.tracks.set(id, track);
      this._apply(track, dets[i], t, dt);
    }
    for (const [id, tr] of this.tracks) {
      if (usedTracks.has(id) || tr.lastSeen === t) continue;
      if (t - tr.lastSeen > this.grace) this.tracks.delete(id);
      else tr.face.stale = true;
    }
    return [...this.tracks.values()].map((tr) => tr.face);
  }

  reset() {
    this.tracks.clear();
    this.lastT = null;
  }

  _apply(track, det, t, dt) {
    const f = track.face;
    const smooth = track.filter.filter(KEY_IDS.map((i) => det.lm[i]), dt);
    const key = {};
    KEY_IDS.forEach((id, i) => {
      key[id] = smooth[i];
    });
    const forehead = key[FACE.FOREHEAD];
    const chin = key[FACE.CHIN];
    const rightEye = mid(key[FACE.RIGHT_EYE_OUTER], key[FACE.RIGHT_EYE_INNER]);
    const leftEye = mid(key[FACE.LEFT_EYE_OUTER], key[FACE.LEFT_EYE_INNER]);
    const eyeVec = sub(rightEye, leftEye);
    const up = norm(sub(forehead, chin));
    const height = dist3(forehead, chin);
    const width = dist(key[FACE.RIGHT_CHEEK], key[FACE.LEFT_CHEEK]);
    const cheekMid = mid(key[FACE.RIGHT_CHEEK], key[FACE.LEFT_CHEEK]);
    const mouth = mid(key[FACE.UPPER_LIP], key[FACE.LOWER_LIP]);
    const blend = det.blend || {};
    const mouthOpen = blend.jawOpen ?? Math.min(1, dist(key[FACE.UPPER_LIP], key[FACE.LOWER_LIP]) / (height * 0.15));
    const pucker = Math.max(blend.mouthPucker || 0, (blend.mouthFunnel || 0) * 1.3);
    const blow = Math.min(1, Math.max(pucker * (1 - Math.max(0, mouthOpen - 0.35)), (blend.cheekPuff || 0) * 1.4));

    f.lm = det.lm;
    f.key = key;
    f.forehead = forehead;
    f.chin = chin;
    f.nose = key[FACE.NOSE_TIP];
    f.mouth = mouth;
    f.leftEye = leftEye;
    f.rightEye = rightEye;
    f.center = mid(mid(leftEye, rightEye), mouth);
    f.up = up;
    f.roll = Math.atan2(eyeVec.y, eyeVec.x);
    f.yaw = width > 1 ? Math.max(-1, Math.min(1, ((f.nose.x - cheekMid.x) / width) * 2.5)) : 0;
    f.height = height;
    f.width = width;
    // 실제 얼굴로 재 보면 랜드마크 10 에서 정수리까지는 볼 사이 거리의 약 0.41 배 (머리카락이 없을 때)
    const cheek3 = dist3(key[FACE.RIGHT_CHEEK], key[FACE.LEFT_CHEEK]);
    const size = Math.max(Math.min(Math.max(cheek3, width), width / 0.55), height * 0.62, 1);
    f.size = size;
    f.headTop = { x: forehead.x + up.x * size * 0.41, y: forehead.y + up.y * size * 0.41 };
    f.mouthOpen = mouthOpen;
    f.blend = blend;
    f.blow = blow;
    f.age = t - f.born;
    f.stale = false;
    track.lastSeen = t;
  }
}
