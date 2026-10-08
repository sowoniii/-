// 프레임마다 들어오는 손 검출 결과에 고정 id 를 붙이고, 떨림을 줄이고, 손 모양을 안정적으로 판별한다.
// 입력/출력 모두 화면 px 좌표. DOM 의존성이 없다.

import { PointsFilter } from './filters.js';
import { analyzeHand, classifyPose, PoseStabilizer, TIP_IDS, LM, FINGER_NAMES, THRESHOLDS } from './gestures.js';
import { dist, mid } from './math.js';

let nextHandId = 1;

/**
 * @typedef {{x:number, y:number, z:number}} Point
 *
 * @typedef {object} Hand  모드에 전달되는 손 정보. 같은 손이면 프레임이 바뀌어도 같은 객체다.
 * @property {number} id          추적 id (손이 화면에서 사라졌다 다시 나오면 새 id)
 * @property {'left'|'right'} side 사용자 기준 왼손/오른손 (추정치, 틀릴 수 있음)
 * @property {Point[]} lm          부드럽게 만든 21개 랜드마크 (화면 px)
 * @property {Point[]} rawLm       원본 랜드마크
 * @property {number} size         손 크기 px (손목→중지 뿌리 정도)
 * @property {Point} palm          손바닥 중심
 * @property {Point[]} tips        [엄지, 검지, 중지, 약지, 새끼] 끝 위치
 * @property {number[]} ext        손가락별 펴짐 정도 0..1
 * @property {boolean[]} extended  손가락별 펴짐 여부
 * @property {number} openness     네 손가락 평균 펴짐 0(주먹)..1(활짝)
 * @property {'open'|'fist'|'v'|'point'|'pinch'|'other'} pose  안정화된 손 모양
 * @property {string} prevPose     직전 손 모양
 * @property {string|null} started 이번 프레임에 새로 시작된 손 모양 (없으면 null)
 * @property {string|null} ended   이번 프레임에 끝난 손 모양 (없으면 null)
 * @property {number} poseTime     현재 손 모양을 유지한 시간(초)
 * @property {number} pinchDist    엄지-검지 끝 거리 / 손 크기
 * @property {Point} pinchPoint    엄지와 검지 끝의 중간점
 * @property {{x:number,y:number}} velocity 손바닥 속도 (px/초)
 * @property {number} age          추적된 시간(초)
 * @property {boolean} stale       잠깐 놓친 상태 (마지막 위치 유지 중)
 */

export class HandTracker {
  constructor({ grace = 0.2, filter = { minCutoff: 1.2, beta: 0.012, dCutoff: 1.0 } } = {}) {
    this.grace = grace;
    this.filterOpts = filter;
    /** @type {Map<number, {hand:Hand, filter:PointsFilter, stab:PoseStabilizer, lastSeen:number}>} */
    this.tracks = new Map();
    this.lastT = null;
  }

  /**
   * @param {{lm:Point[], side?:'left'|'right', score?:number}[]} detections 화면 px 좌표
   * @param {number} t 초 단위 시각
   * @returns {Hand[]}
   */
  update(detections, t) {
    const dt = this.lastT === null ? 1 / 30 : Math.max(1e-3, Math.min(0.1, t - this.lastT));
    this.lastT = t;

    const dets = detections.map((d) => {
      const a = analyzeHand(d.lm);
      return { ...d, palm: a.palm, size: a.size };
    });

    // 가까운 순서대로 기존 추적과 짝짓기 (손이 많지 않으니 탐욕 매칭으로 충분)
    const pairs = [];
    for (const [id, tr] of this.tracks) {
      for (let i = 0; i < dets.length; i++) {
        const d = dist(tr.hand.palm, dets[i].palm);
        const limit = Math.max(tr.hand.size, dets[i].size) * 1.6;
        if (d < limit) {
          const sidePenalty = dets[i].side && tr.hand.side !== dets[i].side ? 0.35 * limit : 0;
          pairs.push({ id, i, cost: d + sidePenalty });
        }
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
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
      const track = this._create(dets[i], t);
      this._apply(track, dets[i], t, dt);
    }
    for (const [id, tr] of this.tracks) {
      if (usedTracks.has(id) || tr.lastSeen === t) continue;
      if (t - tr.lastSeen > this.grace) {
        this.tracks.delete(id);
      } else {
        const h = tr.hand;
        h.stale = true;
        h.started = null;
        h.ended = null;
        h.velocity = { x: 0, y: 0 };
      }
    }
    return [...this.tracks.values()].map((tr) => tr.hand);
  }

  reset() {
    this.tracks.clear();
    this.lastT = null;
  }

  _create(det, t) {
    const id = nextHandId++;
    const hand = {
      id,
      side: det.side || 'right',
      score: det.score ?? 1,
      lm: det.lm,
      rawLm: det.lm,
      size: det.size,
      palm: det.palm,
      tips: TIP_IDS.map((i) => det.lm[i]),
      ext: [0, 0, 0, 0, 0],
      extended: [false, false, false, false, false],
      openness: 0,
      pose: 'other',
      prevPose: 'other',
      started: null,
      ended: null,
      poseTime: 0,
      poseSince: t,
      pinchDist: 1,
      pinchPoint: mid(det.lm[LM.THUMB_TIP], det.lm[LM.INDEX_TIP]),
      velocity: { x: 0, y: 0 },
      born: t,
      age: 0,
      stale: false,
    };
    const track = {
      hand,
      filter: new PointsFilter(21, this.filterOpts),
      stab: new PoseStabilizer(),
      lastSeen: t,
    };
    this.tracks.set(id, track);
    return track;
  }

  _apply(track, det, t, dt) {
    const h = track.hand;
    const lm = track.filter.filter(det.lm, dt);
    const a = analyzeHand(lm);
    const prevPalm = h.palm;
    const raw = classifyPose(a, h.pose);
    const st = track.stab.push(raw);

    h.rawLm = det.lm;
    h.lm = lm;
    h.side = det.side || h.side;
    h.score = det.score ?? h.score;
    h.size = a.size;
    h.palm = a.palm;
    h.tips = TIP_IDS.map((i) => lm[i]);
    h.ext = a.ext;
    h.extended = a.ext.map((v) => v > THRESHOLDS.extended);
    h.openness = a.openness;
    h.pinchDist = a.pinchDist;
    h.pinchPoint = mid(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]);
    const vx = (a.palm.x - prevPalm.x) / dt;
    const vy = (a.palm.y - prevPalm.y) / dt;
    const k = h.stale || track.lastSeen === h.born ? 1 : 0.35;
    h.velocity = { x: h.velocity.x + (vx - h.velocity.x) * k, y: h.velocity.y + (vy - h.velocity.y) * k };
    h.started = st.changed ? st.pose : null;
    h.ended = st.changed ? st.prev : null;
    if (st.changed) {
      h.prevPose = st.prev;
      h.poseSince = t;
    }
    h.pose = st.pose;
    h.poseTime = t - h.poseSince;
    h.age = t - h.born;
    h.stale = false;
    track.lastSeen = t;
  }
}

export { FINGER_NAMES };
