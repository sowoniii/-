// 핵심 모듈 단위 테스트:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthHand, synthFace, synthBlendshapes, SYNTH_POSES, FACE } from '../src/core/synth.js';
import { analyzeHand, classifyPose, PoseStabilizer, jointBend } from '../src/core/gestures.js';
import { HandTracker } from '../src/core/handtracker.js';
import { FaceTracker } from '../src/core/facetracker.js';
import { analyzeSpectrum } from '../src/core/mic.js';
import { Viewport } from '../src/core/viewport.js';
import { WarpGrid } from '../src/core/stage.js';
import { OneEuroFilter } from '../src/core/filters.js';
import { Spring, wrapAngle, distToSegment } from '../src/core/math.js';

test('합성 손 모양을 모든 방향·양손에서 올바르게 판별한다', () => {
  for (const pose of SYNTH_POSES) {
    for (const side of ['left', 'right']) {
      for (const angle of [0, 0.6, -0.8, 1.5, Math.PI]) {
        for (const size of [80, 220]) {
          const lm = synthHand({ x: 400, y: 300, size, angle, pose, side });
          assert.equal(classifyPose(analyzeHand(lm)), pose, `${pose} ${side} ${angle} ${size}`);
        }
      }
    }
  }
});

test('손 크기와 손바닥 중심이 합리적이다', () => {
  const lm = synthHand({ x: 500, y: 400, size: 150, pose: 'open' });
  const a = analyzeHand(lm);
  assert.ok(a.size > 130 && a.size < 190, `size ${a.size}`);
  assert.ok(Math.abs(a.palm.x - 500) < 1 && Math.abs(a.palm.y - 400) < 1);
  assert.ok(a.openness > 0.9);
  assert.ok(analyzeHand(synthHand({ x: 0, y: 0, pose: 'fist' })).openness < 0.1);
});

test('jointBend: 일직선 0도, 직각 90도', () => {
  assert.equal(Math.round(jointBend({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })), 0);
  assert.equal(Math.round(jointBend({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })), 90);
});

test('집기는 히스테리시스가 있다', () => {
  const a = analyzeHand(synthHand({ x: 0, y: 0, pose: 'pinch' }));
  assert.equal(classifyPose({ ...a, pinchDist: 0.4 }, 'pinch'), 'pinch');
  assert.notEqual(classifyPose({ ...a, pinchDist: 0.4 }, 'other'), 'pinch');
});

test('PoseStabilizer 는 몇 프레임 연속이어야 바뀐다', () => {
  const s = new PoseStabilizer({ holdFrames: 3, otherHoldFrames: 5 });
  assert.equal(s.push('fist').changed, false);
  assert.equal(s.push('fist').changed, false);
  const r = s.push('fist');
  assert.equal(r.changed, true);
  assert.equal(r.pose, 'fist');
  assert.equal(r.prev, 'other');
  // 한 프레임 깜빡임은 무시
  s.push('open');
  s.push('fist');
  assert.equal(s.pose, 'fist');
  for (let i = 0; i < 4; i++) assert.equal(s.push('other').changed, false);
  assert.equal(s.push('other').changed, true);
});

test('HandTracker: id 유지, 손 모양 사건, 잠깐 놓쳐도 유지 후 삭제', () => {
  const tr = new HandTracker({ grace: 0.2 });
  let t = 0;
  const step = (hands) => {
    t += 1 / 30;
    return tr.update(hands.map((h) => ({ lm: synthHand(h), side: h.side || 'right' })), t);
  };
  let hs = step([{ x: 300, y: 300, pose: 'open' }]);
  const id = hs[0].id;
  let started = null;
  for (let i = 0; i < 5; i++) {
    hs = step([{ x: 300 + i * 10, y: 300, pose: 'open' }]);
    if (hs[0].started) started = hs[0].started;
  }
  assert.equal(hs.length, 1);
  assert.equal(hs[0].id, id);
  assert.equal(started, 'open');
  assert.equal(hs[0].pose, 'open');
  assert.ok(hs[0].velocity.x > 0, '오른쪽으로 움직이는 속도');

  // 두 번째 손 등장 → 새 id
  hs = step([{ x: 340, y: 300, pose: 'open' }, { x: 900, y: 300, pose: 'fist', side: 'left' }]);
  assert.equal(hs.length, 2);
  assert.ok(hs.some((h) => h.id === id));

  // 주먹으로 바뀌는 사건
  let ended = null;
  for (let i = 0; i < 5; i++) {
    hs = step([{ x: 340, y: 300, pose: 'fist' }, { x: 900, y: 300, pose: 'fist', side: 'left' }]);
    const h = hs.find((x) => x.id === id);
    if (h.ended) ended = h.ended;
  }
  assert.equal(ended, 'open');
  assert.equal(hs.find((x) => x.id === id).pose, 'fist');

  // 놓침: grace 안에서는 stale 로 남아 있다
  hs = step([]);
  assert.equal(hs.length, 2);
  assert.ok(hs.every((h) => h.stale));
  for (let i = 0; i < 8; i++) hs = step([]);
  assert.equal(hs.length, 0);
});

test('HandTracker: 손이 엇갈려도 가까운 손끼리 짝짓는다', () => {
  const tr = new HandTracker();
  let t = 0;
  const det = (x) => ({ lm: synthHand({ x, y: 300, pose: 'open' }), side: 'right' });
  let hs = tr.update([det(200), det(800)], (t += 0.033));
  const left = hs.find((h) => h.palm.x < 500).id;
  hs = tr.update([det(820), det(220)], (t += 0.033));
  assert.equal(hs.find((h) => h.palm.x < 500).id, left);
});

test('FaceTracker: 머리 위치·기울기·입김', () => {
  const tr = new FaceTracker();
  const roll = 0.3;
  let faces;
  for (let i = 0; i < 3; i++) {
    faces = tr.update([{ lm: synthFace({ x: 600, y: 400, size: 300, roll }), blend: synthBlendshapes({ blow: 1 }) }], i / 30);
  }
  const f = faces[0];
  assert.ok(Math.abs(f.roll - roll) < 0.02, `roll ${f.roll}`);
  assert.ok(Math.abs(f.height - 300) < 15, `height ${f.height}`);
  assert.ok(f.headTop.y < f.forehead.y, '정수리는 이마보다 위');
  assert.ok(f.up.y < 0);
  assert.ok(f.blow > 0.8);
  assert.ok(f.rightEye.x > f.leftEye.x, '거울 화면에서 본인 오른눈은 화면 오른쪽');
  const quiet = tr.update([{ lm: synthFace({ x: 600, y: 400, size: 300 }), blend: synthBlendshapes({ blow: 0 }) }], 0.2)[0];
  assert.ok(quiet.blow < 0.1);
  assert.equal(quiet.id, f.id);
  assert.ok(quiet.lm[FACE.CHIN]);
});

test('입김 스펙트럼 판별: 조용함/바람소리/고음', () => {
  const sr = 48000;
  const bins = 512;
  const make = (fn) => Float32Array.from({ length: bins }, (_, i) => fn((i * sr) / 2 / bins));
  const quiet = make(() => -100);
  const wind = make((hz) => (hz < 600 ? -40 : -60));
  const whistle = make((hz) => (Math.abs(hz - 3000) < 100 ? -40 : -100));
  const floor = analyzeSpectrum(quiet, sr, 0).levelDb;
  assert.equal(analyzeSpectrum(quiet, sr, floor).candidate, false);
  const w = analyzeSpectrum(wind, sr, floor);
  assert.equal(w.candidate, true);
  assert.ok(w.strength > 0.5);
  assert.equal(analyzeSpectrum(whistle, sr, floor).candidate, false);
});

test('Viewport: 거울 + 꽉 채우기 변환이 서로 역함수다', () => {
  const v = new Viewport();
  v.resize(1000, 1000);
  v.setSource(1280, 720, true);
  const p = v.toScreen(0.25, 0.5);
  assert.ok(p.x > 500, '거울이라 원본 왼쪽이 화면 오른쪽');
  const back = v.toTexture(p.x, p.y);
  assert.ok(Math.abs(back.u - 0.25) < 1e-9 && Math.abs(back.v - 0.5) < 1e-9);
  // 세로 화면: 영상 높이가 화면을 꽉 채운다
  assert.equal(v.drawHeight, 1000);
});

test('WarpGrid: 화면보다 넓게 덮고 변형 여부를 안다', () => {
  const g = new WarpGrid(1280, 720);
  assert.ok(g.rest[0] < 0 && g.rest[1] < 0);
  const last = g.count - 1;
  assert.ok(g.rest[last * 2] > 1280 && g.rest[last * 2 + 1] > 720);
  assert.equal(g.indices.length, g.cols * g.rows * 6);
  assert.equal(g.isDeformed(), false);
  g.offset[10] = 5;
  assert.equal(g.isDeformed(), true);
  g.reset();
  assert.equal(g.isDeformed(), false);
});

test('OneEuroFilter: 정지 신호는 그대로, 떨림은 줄인다', () => {
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
  let out = 0;
  for (let i = 0; i < 100; i++) out = f.filter(10 + (i % 2 ? 1 : -1), 1 / 60);
  assert.ok(Math.abs(out - 10) < 0.3);
});

test('수학 도우미', () => {
  const s = new Spring(0, { stiffness: 200, damping: 20 });
  for (let i = 0; i < 120; i++) s.step(1 / 60, 1);
  assert.ok(Math.abs(s.value - 1) < 0.01);
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9 || Math.abs(wrapAngle(3 * Math.PI) + Math.PI) < 1e-9);
  assert.equal(distToSegment({ x: 0, y: 5 }, { x: -10, y: 0 }, { x: 10, y: 0 }), 5);
});
