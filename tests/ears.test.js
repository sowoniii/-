// 동물 귀 놀이 단위 테스트:  node --test tests/ears.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ANIMALS, ANIMAL_IDS, nextAnimal, firstAnimal, earReach } from '../src/modes/ears/animals.js';
import { HeadMotion, EarSpring, PopSpring, dirOf } from '../src/modes/ears/physics.js';
import {
  HEAD, faceSize, headTarget, earAnchors, faceCost, pickFace, pruneGhosts, MAX_V_COST, VWatcher, vPoint, findCarry, chooseHint, HINTS, StableText,
  ParticlePool,
} from '../src/modes/ears/logic.js';
import { FaceTracker } from '../src/core/facetracker.js';
import { HandTracker } from '../src/core/handtracker.js';
import { synthFace, synthHand, synthBlendshapes } from '../src/core/synth.js';
import ears from '../src/modes/ears.js';

/** 합성 얼굴을 FaceTracker 에 몇 번 넣어 Face 객체를 만든다 */
function makeFace(o) {
  const tr = new FaceTracker();
  let f;
  for (let i = 0; i < 3; i++) f = tr.update([{ lm: synthFace(o), blend: synthBlendshapes({}) }], i / 30)[0];
  return f;
}

// 실제 사람 얼굴: vendor 의 face_landmarker.task 를 IMAGE 모드로 실제 인물 사진(820×1024, 머리가 아주 짧은 어른,
// 정면)에 돌려 얻은 주요 랜드마크 (거울 화면 px, z 도 같은 px 단위). [번호, x, y, z]
const REAL_KEY = [
  [10, 414.3, 102.2, -4.3], [152, 412.7, 347.8, -0.3], [1, 412.8, 231.4, -52.4], [168, 413.5, 170.8, -17.3],
  [13, 412.9, 263.2, -20.7], [14, 413.2, 280.7, -12.4], [61, 463, 262.8, 9.1], [291, 362.7, 258.9, 12],
  [33, 472, 177.6, 14.1], [133, 437.2, 178.4, 8.3], [263, 355.4, 176, 18.4], [362, 390.4, 177.8, 10.2],
  [159, 457.4, 171.1, 3.4], [145, 455.3, 179.2, 4.6], [386, 370, 170.4, 6.6], [374, 372.2, 177.8, 7.8],
  [234, 511.6, 206, 86.3], [454, 322.3, 204.3, 93.1], [105, 467.7, 150.9, -5.2], [334, 360.1, 149.5, -1.4],
];
// 같은 사진에서 눈으로 잰 머리(머리카락 포함) 윤곽 [x, y]. 랜드마크 10(y=102)은 이마 가운데쯤이고, 정수리는 y≈24.
const REAL_OUTLINE = [[308, 140], [310, 100], [320, 78], [340, 53], [360, 42], [400, 27], [425, 24], [450, 28], [480, 43], [500, 63], [520, 97], [528, 140]];
function outlineY(x) {
  for (let i = 0; i < REAL_OUTLINE.length - 1; i++) {
    const [x0, y0] = REAL_OUTLINE[i];
    const [x1, y1] = REAL_OUTLINE[i + 1];
    if (x >= x0 && x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return NaN;
}

/**
 * 실제 얼굴 Face. jaw: 입을 벌린 만큼 턱·아랫입술을 얼굴 높이 비율로 내린다.
 * yaw: 머리 중심(깊이 z0)을 지나는 세로축으로 돌린다 (라디안).
 */
function realFace({ jaw = 0, yaw = 0 } = {}) {
  const h = Math.hypot(REAL_KEY[0][1] - REAL_KEY[1][1], REAL_KEY[0][2] - REAL_KEY[1][2]);
  const cx = 413;
  const z0 = 90;
  const lm = [];
  for (const [i, x, y0, z] of REAL_KEY) {
    const y = y0 + (i === 152 ? 1 : i === 14 ? 0.8 : 0) * jaw * h;
    const dx = x - cx;
    const dz = z - z0;
    lm[i] = { x: cx + dx * Math.cos(yaw) + dz * Math.sin(yaw), y, z: z0 - dx * Math.sin(yaw) + dz * Math.cos(yaw) };
  }
  const tr = new FaceTracker();
  let f;
  for (let i = 0; i < 3; i++) f = tr.update([{ lm, blend: { jawOpen: jaw } }], i / 30)[0];
  return f;
}

// ------------------------------------------------------------------ 동물

test('동물 6마리: 이름·모양·흔들림 값이 올바르다', () => {
  assert.equal(ANIMALS.length, 6);
  assert.deepEqual(ANIMAL_IDS, ['cat', 'rabbit', 'bear', 'fox', 'dog', 'panda']);
  assert.equal(new Set(ANIMALS.map((a) => a.name)).size, 6);
  for (const A of ANIMALS) {
    for (let s = 0; s <= 1.0001; s += 0.05) {
      const w = A.profile(Math.min(1, s));
      assert.ok(Number.isFinite(w) && w >= 0 && w <= 1.3, `${A.id} profile(${s}) = ${w}`);
    }
    assert.ok(A.profile(1) < 0.05, `${A.id} 귀 끝은 닫혀야 함`);
    assert.ok(A.profile(0) > 0.3, `${A.id} 뿌리는 넓어야 함`);
    assert.ok(A.inner.k > 0 && A.inner.k < 1 && A.inner.end <= 1);
    for (const k of ['stiffness', 'damping', 'drive', 'couple', 'gravity', 'rigid', 'bend']) {
      assert.ok(Number.isFinite(A.phys[k]), `${A.id}.phys.${k}`);
    }
    assert.ok(A.voice.length > 0);
    assert.ok(earReach(A) > 0);
  }
});

test('nextAnimal 은 한 바퀴 돌고, firstAnimal 은 친구가 안 쓰는 동물을 준다', () => {
  let i = 0;
  const seen = [ANIMALS[i].id];
  for (let k = 0; k < 5; k++) seen.push(ANIMALS[(i = nextAnimal(i))].id);
  assert.deepEqual(seen, ANIMAL_IDS);
  assert.equal(nextAnimal(5), 0);
  assert.equal(nextAnimal(-1), 0);
  assert.equal(firstAnimal([]), 0);
  assert.equal(firstAnimal([0]), 1);
  assert.equal(firstAnimal([0, 1, 3]), 2);
  assert.equal(firstAnimal([0, 1, 2, 3, 4, 5]), 0);
});

// ------------------------------------------------------------------ 머리 틀, 귀 자리

test('headTarget: 똑바른 얼굴과 기울인 얼굴', () => {
  const f = makeFace({ x: 600, y: 400, size: 300 });
  const h = headTarget(f);
  assert.ok(Math.abs(h.ang) < 0.02, `ang ${h.ang}`);
  assert.ok(Math.abs(h.x - 600) < 3);
  assert.ok(h.y < 400, '눈 사이는 얼굴 가운데보다 위');
  assert.ok(h.size > 230 && h.size < 300, `size ${h.size}`);
  assert.ok(h.crown >= h.size * 0.55 && h.crown <= h.size * 1.15, `crown ${h.crown}`);
  const r = headTarget(makeFace({ x: 600, y: 400, size: 300, roll: 0.4 }));
  assert.ok(Math.abs(r.ang - 0.4) < 0.03, `roll ang ${r.ang}`);
  // 화면에서 볼 사이 너비가 줄어도(고개 돌림) 3D 거리로 크기를 지킨다
  const narrow = headTarget({ ...f, width: f.width * 0.6 });
  assert.ok(narrow.size > h.size * 0.95, `yaw 에도 크기 유지 ${narrow.size}`);
});

test('faceSize: 실제 얼굴에서 말하거나 입을 크게 벌려도, 고개를 돌려도 귀 크기가 그대로', () => {
  const f = realFace();
  const h = headTarget(f);
  assert.ok(Math.abs(h.size - 189.4) < 2, `볼 사이 3D 거리 ${h.size}`);
  for (const jaw of [0.05, 0.1, 0.15, 0.2]) {
    const g = headTarget(realFace({ jaw }));
    assert.ok(Math.abs(g.size / h.size - 1) < 0.01, `입 벌림 ${jaw}: 크기 ${g.size / h.size}`);
    assert.ok(Math.abs(g.crown / h.crown - 1) < 0.01, `입 벌림 ${jaw}: 정수리 ${g.crown / h.crown}`);
    // 예전 방식(max(너비, 0.84·높이))은 입을 벌리면 귀가 커졌다
    const old = (x) => Math.max(x.width, x.height * 0.84);
    if (jaw >= 0.15) assert.ok(old(realFace({ jaw })) / old(f) > 1.1);
  }
  for (const yaw of [0.3, 0.6]) {
    const g = realFace({ yaw });
    assert.ok(g.width < f.width * 0.97, '화면에서는 좁아진다');
    assert.ok(Math.abs(faceSize(g) / faceSize(f) - 1) < 0.03, `고개 ${yaw}: 크기 ${faceSize(g) / faceSize(f)}`);
  }
});

test('earAnchors: 실제 얼굴에서 귀가 이마가 아니라 머리 위 윤곽(머리카락)에 붙는다', () => {
  const f = realFace();
  const h = headTarget(f);
  const S = h.size;
  const lm10 = f.forehead;
  for (const A of ANIMALS) {
    const [l, r] = earAnchors(h, A);
    assert.equal(l.side, -1);
    assert.equal(r.side, 1);
    assert.ok(l.x < h.x && r.x > h.x);
    assert.ok(Math.abs(l.y - r.y) < 2, `${A.id} 좌우 높이 같음`);
    for (const an of [l, r]) {
      // 잰 머리 윤곽에서 위로 0.06S, 안쪽으로 0.1S 안 (짧은 머리 어른 기준 — 아이는 머리카락 속으로 조금 더 들어간다)
      const d = (an.y - outlineY(an.x)) / S;
      assert.ok(d > -0.06 && d < 0.1, `${A.id} 귀 뿌리가 머리 윤곽 위 (${an.x.toFixed(0)}, ${an.y.toFixed(0)}) d=${d.toFixed(3)}`);
      assert.ok(an.y < lm10.y - 0.05 * S, `${A.id} 이마(랜드마크 10)보다 확실히 위`);
    }
    // 사진 속 얼굴은 아주 조금 돌아가 있어서(yaw ≈ -0.05) 기운 정도가 살짝만 다르다
    assert.ok(Math.abs(r.rest - A.tilt) < 0.03 && Math.abs(l.rest + A.tilt) < 0.03);
  }
});

test('earAnchors: 강아지 귀는 머리 옆에서 볼 옆으로 축 늘어진다 (날개처럼 옆으로 뻗지 않음)', () => {
  const f = realFace();
  const h = headTarget(f);
  const dog = ANIMALS.find((a) => a.id === 'dog');
  const [l, r] = earAnchors(h, dog);
  for (const an of [l, r]) {
    // 귀 전체 방향 = 뿌리 방향 + 끝으로 갈수록 휘는 만큼의 절반
    const dir = an.angle + an.side * (dog.curl || 0) * 0.5;
    const tipX = an.x + Math.sin(dir) * dog.length * h.size;
    const tipY = an.y - Math.cos(dir) * dog.length * h.size;
    assert.ok(Math.abs(dir) > 2.5 && Math.abs(dir) < 3.1, `아래로 늘어짐 ${dir}`);
    assert.ok(tipY - an.y > dog.length * h.size * 0.75, '귀 끝이 뿌리보다 한참 아래');
    assert.ok(tipY > f.leftEye.y - 0.1 * h.size, '귀 끝이 눈높이 근처까지 내려온다');
    assert.ok(Math.abs(tipX - h.x) > h.size * 0.55, `귀 끝은 얼굴 바깥 (${Math.abs(tipX - h.x) / h.size})`);
    assert.ok(Math.abs(tipX - h.x) < h.size * 1.0, `옆으로 멀리 뻗지 않음 (${Math.abs(tipX - h.x) / h.size})`);
    assert.ok(Math.abs(an.x - h.x) > h.size * 0.4, '머리 옆에 붙는다');
  }
});

test('earAnchors: 연습 모드 만화 머리(core/sim.js, 실제 비율)의 머리카락 윤곽 바로 안쪽에 붙는다', () => {
  // sim.js 만화 머리카락: 눈 사이 중심, 옆 반폭 0.53h, 위 0.8h, 아래 0.32h, 둥글기 2.6 (h = 이마~턱)
  const f = makeFace({ x: 600, y: 400, size: 300 });
  const h = headTarget(f);
  const H = 300;
  for (const A of ANIMALS) {
    const [l, r] = earAnchors(h, A, [{}, {}]);
    assert.ok(Math.abs(l.x - 600 + (r.x - 600)) < 1, `${A.id} 좌우 대칭`);
    const lat = Math.abs(r.x - h.x) / (0.53 * H);
    const upv = (h.y - r.y) / ((h.y - r.y > 0 ? 0.8 : 0.32) * H);
    const rad = Math.pow(lat, 2.6) + Math.pow(Math.abs(upv), 2.6);
    assert.ok(rad < 1 && rad > 0.6, `${A.id} 머리카락 윤곽 바로 안쪽 (${rad.toFixed(2)})`);
  }
});

test('earAnchors: 머리를 기울이면 귀도 같이 돌고, 고개를 돌리면 좁아지며 반대로 밀린다', () => {
  const A = ANIMALS[0];
  const h = headTarget(makeFace({ x: 600, y: 400, size: 300 }));
  const [l0, r0] = earAnchors(h, A).map((o) => ({ ...o }));
  const [l1, r1] = earAnchors({ ...h, ang: 0.5 }, A).map((o) => ({ ...o }));
  assert.ok(Math.abs(Math.atan2(r1.y - l1.y, r1.x - l1.x) - 0.5) < 1e-6, '두 귀를 잇는 선이 머리 기울기와 같다');
  assert.ok(Math.abs(r1.angle - (0.5 + A.tilt)) < 1e-9);
  const [l2, r2] = earAnchors({ ...h, yaw: 0.5 }, A).map((o) => ({ ...o }));
  assert.ok(r2.x - l2.x < r0.x - l0.x, '돌리면 두 귀 사이가 좁아진다');
  assert.ok((l2.x + r2.x) / 2 < (l0.x + r0.x) / 2, '머리 중심(얼굴보다 뒤)은 코와 반대쪽으로');
  assert.equal(l2.near, true);
  assert.equal(r2.near, false);
  assert.ok(l2.depth > r2.depth);
  assert.ok(l2.widthMul < 1);
});

// ------------------------------------------------------------------ 얼굴 고르기

test('pickFace: 브이한 손과 가장 어울리는 얼굴', () => {
  const left = { x: 300, y: 300, size: 200 };
  const right = { x: 900, y: 300, size: 200 };
  assert.equal(pickFace(850, 420, 120, [left, right]), 1, '오른쪽 얼굴 옆의 손');
  assert.equal(pickFace(350, 600, 120, [left, right]), 0, '가슴 앞(아래쪽) 손은 그 아이');
  assert.equal(pickFace(5000, 300, 120, [left, right]), -1, '너무 멀면 아무도 아님');
  assert.equal(pickFace(420, 330, 120, [left]), 0, '얼굴이 하나: 그 아이 옆의 손');
  assert.equal(pickFace(940, 330, 120, [left]), -1, '얼굴이 하나여도 멀리 있는 손(얼굴이 안 보이는 다른 아이)은 아님');
  assert.ok(faceCost(300 + 2.5 * 200, 300, 124, left) < MAX_V_COST, '팔을 쭉 뻗은 브이 (얼굴 2.5개 옆) 까지는 그 아이');
  assert.equal(pickFace(500, 300, 120, []), -1);
  // 거리가 비슷하면 손 크기가 어울리는(같은 거리에 선) 얼굴
  const near = { x: 400, y: 300, size: 300 };
  const far = { x: 800, y: 300, size: 120 };
  assert.equal(pickFace(600, 380, 190, [near, far]), 0, '큰 손 → 가까이 선 아이');
  assert.equal(pickFace(690, 330, 75, [near, far]), 1, '작은 손 → 멀리 선 아이');
  assert.equal(pickFace(690, 330, 190, [near, far]), 0, '같은 자리라도 큰 손 → 가까이 선 아이');
  assert.ok(faceCost(300, 300, 124, left) < faceCost(300, 300, 400, left));
  // 잠깐 사라진 얼굴(ghost)이 더 가까우면 그 자리를 고른다 (놀이는 브이를 남에게 주지 않고 기다린다)
  const ghost = { x: 900, y: 300, size: 200, ghost: true };
  assert.equal(pickFace(880, 400, 120, [left, ghost]), 1);
  // 비슷한 거리면 지금 보이는 얼굴이 이긴다
  assert.equal(pickFace(600, 300, 124, [left, { ...ghost, x: 900 }]), 0);
});

test('pruneGhosts: 시간이 지나거나 그 자리에 얼굴이 다시 보이면 잊는다', () => {
  const g = [{ x: 300, y: 300, size: 200, lostAt: 10 }, { x: 900, y: 300, size: 200, lostAt: 10 }];
  pruneGhosts(g, [{ x: 320, y: 310, size: 200 }], 10.5, 1.5);
  assert.deepEqual(g.map((x) => x.x), [900], '돌아온 얼굴 자리는 지운다');
  pruneGhosts(g, [], 11.4, 1.5);
  assert.equal(g.length, 1);
  pruneGhosts(g, [], 11.6, 1.5);
  assert.equal(g.length, 0);
});

// ------------------------------------------------------------------ 브이 감지

function fakeHand(id, pose, x = 500, y = 500, extra = {}) {
  return { id, pose, stale: false, size: 120, palm: { x, y }, tips: [null, { x: x - 20, y: y - 150 }, { x: x + 20, y: y - 150 }], ...extra };
}

test('VWatcher: 한 번 브이 = 한 번, 깜빡임은 무시, 손을 폈다 다시 하면 또', () => {
  const w = new VWatcher({ rearm: 0.2 });
  let t = 0;
  const step = (pose, extra) => {
    t += 1 / 30;
    return w.update([fakeHand(1, pose, 500, 500, extra)], t);
  };
  assert.deepEqual(step('open'), []);
  const e1 = step('v');
  assert.equal(e1.length, 1);
  assert.equal(e1[0].type, 'fresh');
  assert.deepEqual({ x: e1[0].x, y: e1[0].y }, { x: 500, y: 350 }, '브이 손가락 끝 가운데');
  for (let i = 0; i < 10; i++) assert.equal(step('v')[0].type, 'held', '계속 브이: 새 브이 아님');
  // 0.1초 동안 다른 모양으로 잘못 인식 → 다시 브이: 새 브이로 세지 않는다
  for (let i = 0; i < 3; i++) assert.deepEqual(step('other'), []);
  assert.equal(step('v')[0].type, 'held');
  // 잠깐 놓침(stale)은 아무 일도 없다
  assert.deepEqual(step('v', { stale: true }), []);
  // 0.3초 동안 손을 폈다가 브이 → 새 브이
  for (let i = 0; i < 9; i++) step('open');
  assert.equal(step('v')[0].type, 'fresh');
});

test('VWatcher: 브이하던 손을 놓쳐 새 id 로 잡혀도 근처면 새 브이가 아니다, 손이 사라지면 정리', () => {
  const w = new VWatcher();
  let t = 0;
  const step = (hands) => w.update(hands, (t += 1 / 30));
  step([fakeHand(1, 'open')]);
  const first = step([fakeHand(1, 'v')])[0];
  assert.equal(first.type, 'fresh');
  assert.equal(first.key, 1);
  step([fakeHand(1, 'v')]);
  step([]); // 놓침
  assert.equal(w.hands.size, 0, '사라진 손 정리');
  assert.equal(w.lost.length, 1);
  assert.equal(w.isKnown(1), true, '잠깐 놓친 손은 아직 기억');
  const again = step([fakeHand(2, 'v', 530, 510)])[0];
  assert.equal(again.type, 'held', '같은 자리에서 다시 잡힌 브이');
  assert.deepEqual([again.key, again.since], [1, first.since], '같은 브이: 번호와 시작 시각을 물려받는다');
  // 멀리서 새로 나타난 다른 아이의 브이는 새 브이
  assert.equal(step([fakeHand(2, 'v', 530, 510), fakeHand(3, 'v', 1200, 500)])[1].type, 'fresh');
  // 오래 지나면 기억도 지운다
  for (let i = 0; i < 40; i++) step([]);
  assert.equal(w.lost.length, 0);
  assert.equal(step([fakeHand(4, 'v', 530, 510)])[0].type, 'fresh');
});

test('VWatcher.restore: 얼굴이 안 보일 때 한 새 브이는 1.5초 동안 다시 시도된다', () => {
  const w = new VWatcher();
  let t = 0;
  const step = (pose) => w.update([fakeHand(1, pose)], (t += 1 / 30));
  step('open');
  assert.equal(step('v')[0].type, 'fresh');
  w.restore(1, t);
  assert.equal(step('v')[0].type, 'fresh', '되돌리면 다음 프레임에 다시 새 브이');
  assert.equal(step('v')[0].type, 'held', '되돌리지 않으면 계속 브이');
  for (let i = 0; i < 46; i++) step('v');
  w.restore(1, t);
  assert.equal(step('v')[0].type, 'held', '1.5초가 지나면 되돌리지 않는다');
});

test('VWatcher: 숨겼다가 "짠!" 하고 다시 내민 브이는 새 브이 (인식이 잠깐 끊긴 것과 구별)', () => {
  const frame = { width: 1280, height: 720 };
  const scenario = (gapFrames, { x = 500, y = 500, vx = 0, vy = 0 } = {}) => {
    const w = new VWatcher();
    let t = 0;
    const step = (hands) => w.update(hands, (t += 1 / 30), frame);
    step([fakeHand(1, 'open', x, y)]);
    step([fakeHand(1, 'v', x, y)]);
    step([fakeHand(1, 'v', x, y, { velocity: { x: vx, y: vy } })]);
    // 손 추적은 0.2초 유예 뒤에 손을 지운다 (그동안 HandTracker 가 같은 손으로 이어 준다)
    t += 0.2;
    step([]);
    for (let i = 0; i < gapFrames; i++) step([]);
    return step([fakeHand(2, 'v', x + 20, y + 10)])[0].type;
  };
  assert.equal(scenario(2), 'held', '가만히 있던 손을 아주 잠깐 놓침 → 이어서 같은 브이');
  assert.equal(scenario(12), 'fresh', '0.6초 넘게 안 보였다가 다시 나온 브이 → 새 브이');
  assert.equal(scenario(3, { vy: 600 }), 'fresh', '빠르게 치웠다가 다시 내민 브이 → 새 브이');
  assert.equal(scenario(1, { y: 690 }), 'fresh', '화면 아래로 나갔다 들어온 브이 → 새 브이');
});

test('vPoint: 손가락 끝이 없으면 손바닥', () => {
  assert.deepEqual(vPoint({ palm: { x: 1, y: 2 } }), { x: 1, y: 2 });
});

// ------------------------------------------------------------------ 얼굴 이어 주기, 안내 문구

test('findCarry: 잠깐 사라졌던 같은 자리의 얼굴에게만 귀를 돌려준다', () => {
  const lost = [{ x: 500, y: 300, size: 200, lostAt: 10 }, { x: 1000, y: 300, size: 200, lostAt: 10 }];
  assert.equal(findCarry({ x: 520, y: 310, size: 210 }, lost, 11), 0);
  assert.equal(findCarry({ x: 980, y: 300, size: 190 }, lost, 11.4), 1);
  assert.equal(findCarry({ x: 520, y: 310, size: 210 }, lost, 12), -1, '1.5초가 지나면 새 아이');
  assert.equal(findCarry({ x: 820, y: 300, size: 200 }, lost.slice(0, 1), 11), -1, '멀리 나타나면 새 아이');
  assert.equal(findCarry({ x: 500, y: 300, size: 80 }, lost, 11), -1, '크기가 너무 다르면 다른 아이');
});

test('chooseHint: 상황에 맞는 안내', () => {
  assert.equal(chooseHint({ faces: 0, withEars: 0 }), HINTS.noFace);
  assert.equal(chooseHint({ faces: 1, withEars: 0 }), HINTS.makeV);
  assert.equal(chooseHint({ faces: 2, withEars: 1 }), HINTS.friend);
  assert.equal(chooseHint({ faces: 1, withEars: 1, animal: 'cat', idle: 1 }), HINTS.again);
  assert.equal(chooseHint({ faces: 1, withEars: 1, animal: 'cat', idle: 6 }), HINTS.shake);
  assert.equal(chooseHint({ faces: 1, withEars: 1, animal: 'dog', idle: 6 }), HINTS.tongue);
  assert.equal(chooseHint({ faces: 1, withEars: 1, animal: 'dog', idle: 6, mouthOpen: 0.8 }), HINTS.shake);
  assert.equal(chooseHint({ faces: 1, withEars: 1, animal: 'cat', idle: 11 }), HINTS.again, '번갈아 보여 준다');
});

test('StableText: 인식이 흔들려도 안내가 깜빡이지 않는다', () => {
  const s = new StableText(0.4);
  assert.equal(s.push('a', 0), true);
  assert.equal(s.push('b', 0.1), false);
  assert.equal(s.push('a', 0.2), false);
  assert.equal(s.push('b', 0.3), false);
  assert.equal(s.push('b', 0.6), false);
  assert.equal(s.push('b', 0.71), true);
  assert.equal(s.value, 'b');
});

// ------------------------------------------------------------------ 물리

test('EarSpring: 가만히 있으면 쉬는 자세, 머리가 움직이면 귀 끝이 뒤처진다', () => {
  const cat = ANIMALS[0];
  const still = { ax: 0, ay: 0, aa: 0, ang: 0 };
  const sp = new EarSpring(cat.phys);
  sp.impulse(5);
  for (let i = 0; i < 120; i++) sp.step(1 / 60, still, 0, cat.length);
  assert.ok(Math.abs(sp.theta) < 0.01, `출렁임이 멈춘다 ${sp.theta}`);
  // 머리가 오른쪽으로 가속 → 위로 선 귀는 왼쪽(반시계, -)으로 기운다
  const a = new EarSpring(cat.phys);
  for (let i = 0; i < 6; i++) a.step(1 / 60, { ax: 20, ay: 0, aa: 0, ang: 0 }, 0, cat.length);
  assert.ok(a.theta < -0.01, `오른쪽 가속 → 왼쪽으로 ${a.theta}`);
  // 머리가 시계 방향으로 돌기 시작 → 귀는 관성으로 반시계
  const b = new EarSpring(cat.phys);
  for (let i = 0; i < 6; i++) b.step(1 / 60, { ax: 0, ay: 0, aa: 30, ang: 0 }, 0, cat.length);
  assert.ok(b.theta < 0);
  // 큰 dt, 큰 입력에도 터지지 않는다
  const c = new EarSpring(ANIMALS[4].phys);
  for (let i = 0; i < 50; i++) c.step(0.05, { ax: 1e6, ay: -1e6, aa: 1e6, ang: 3 }, 2, 0.6);
  assert.ok(Number.isFinite(c.theta) && Math.abs(c.theta) <= 1.3);
});

test('EarSpring: 고개를 기울이면 처진 귀는 땅 쪽으로 늘어지고, 토끼 귀는 낮은 쪽으로 넘어간다', () => {
  const dog = ANIMALS.find((a) => a.id === 'dog');
  const tilt = { ax: 0, ay: 0, aa: 0, ang: 0.4 };
  const settle = (A, rest) => {
    const sp = new EarSpring(A.phys);
    for (let i = 0; i < 400; i++) sp.step(1 / 60, tilt, rest, A.length);
    return sp.theta;
  };
  // 강아지 귀는 매달린 채로 남으려 해서 머리와 반대로 돈다 (두 귀 모두 반시계)
  assert.ok(settle(dog, dog.tilt) < -0.02);
  assert.ok(settle(dog, -dog.tilt) < -0.02);
  // 토끼 귀는 둘 다 낮은 쪽(시계 방향)으로 넘어간다
  const rabbit = ANIMALS.find((a) => a.id === 'rabbit');
  assert.ok(settle(rabbit, rabbit.tilt) > 0.02);
  assert.ok(settle(rabbit, -rabbit.tilt) > 0.02);
  // 똑바로 서 있으면 처음 모양 그대로
  const sp = new EarSpring(dog.phys);
  for (let i = 0; i < 200; i++) sp.step(1 / 60, { ax: 0, ay: 0, aa: 0, ang: 0 }, dog.tilt, dog.length);
  assert.ok(Math.abs(sp.theta) < 1e-3);
});

test('HeadMotion: 떨림은 줄이고, 갑자기 튀면 바로 옮기고, 가속도는 얼굴 크기 단위', () => {
  const m = new HeadMotion();
  const base = { x: 500, y: 300, ang: 0, size: 200, crown: 120, yaw: 0 };
  m.update(base, 1 / 60);
  assert.equal(m.x, 500);
  let maxDev = 0;
  for (let i = 0; i < 60; i++) {
    m.update({ ...base, x: 500 + (i % 2 ? 4 : -4) }, 1 / 60);
    maxDev = Math.max(maxDev, Math.abs(m.x - 500));
  }
  assert.ok(maxDev < 3, `떨림 줄이기 ${maxDev}`);
  m.update({ ...base, x: 900 }, 1 / 60);
  assert.equal(m.x, 900, '크게 튀면 바로 옮긴다');
  assert.equal(m.ax, 0);
  for (let i = 0; i < 5; i++) m.update({ ...base, x: 900 + (i + 1) * 10 }, 1 / 60);
  assert.ok(m.ax > 0, '오른쪽으로 빨라지면 가속도 +');
  assert.equal(dirOf(0).y, -1);
  // 같은 시각에 두 번 불려도(dt = 0) 그대로
  const x = m.x;
  m.update({ ...base, x: 1000 }, 0);
  assert.equal(m.x, x);
});

test('PopSpring: 0 → 1 로 넘쳤다가 돌아온다', () => {
  const p = new PopSpring(0, { stiffness: 320, damping: 13 });
  p.target = 1;
  let max = 0;
  for (let i = 0; i < 120; i++) max = Math.max(max, p.step(1 / 60));
  assert.ok(max > 1.1 && max < 1.4, `넘침 ${max}`);
  assert.ok(Math.abs(p.value - 1) < 0.02);
});

test('ParticlePool: 개수 상한을 넘지 않고 오래된 것부터 다시 쓴다', () => {
  const pool = new ParticlePool(10);
  for (let i = 0; i < 25; i++) pool.emit({ x: i, y: 0, life: 1 });
  assert.equal(pool.count, 10);
  assert.equal(pool.items.filter((p) => p.alive).length, 10);
  pool.update(0.5);
  assert.equal(pool.count, 10);
  pool.update(0.6);
  assert.equal(pool.count, 0);
  pool.emit({ x: 0, y: 0, vx: 100, life: 1, gravity: 0 });
  pool.update(0.1);
  assert.ok(pool.items.some((p) => p.alive && Math.abs(p.x - 10) < 1e-6));
  pool.clear();
  assert.equal(pool.count, 0);
});

// ------------------------------------------------------------------ 놀이 전체 (가짜 app, 그리기 없이)

function fakeApp() {
  const calls = { hint: [], toast: [], sound: [] };
  const sound = new Proxy({}, { get: (_, k) => (...a) => calls.sound.push([k, ...a]) });
  return { calls, app: { width: 1280, height: 720, sound, ui: { hint: (t) => calls.hint.push(t), toast: (t) => calls.toast.push(t) } } };
}

/** 합성 손·얼굴 → 실제 트래커 → 놀이 update. 30fps 로 sec 초 동안 */
function runner(mode) {
  const ht = new HandTracker();
  const ft = new FaceTracker();
  let t = 0;
  return (sec, { hands = [], faces = [] }) => {
    const n = Math.round(sec * 30);
    for (let i = 0; i < n; i++) {
      t += 1 / 30;
      const hs = ht.update(hands.map((h) => ({ lm: synthHand(h), side: h.side || 'right' })), t);
      const fs = ft.update(faces.map((f) => ({ lm: synthFace(f), blend: synthBlendshapes(f) })), t);
      mode.update({ t, dt: 1 / 30, width: 1280, height: 720, hands: hs, faces: fs, mic: {} });
      for (const h of hs) {
        h.started = null;
        h.ended = null;
      }
    }
    return mode.state();
  };
}

test('놀이 전체: 브이 → 고양이 → 다시 브이 → 토끼, 두 아이, 얼굴 놓쳤다 돌아오기', () => {
  const { app, calls } = fakeApp();
  const mode = ears.create(app);
  mode.enter();
  const run = runner(mode);
  const face = { x: 560, y: 360, size: 240 };
  const hand = (pose, x = 840, y = 520) => ({ x, y, size: 135, pose });

  let s = run(0.5, { faces: [face], hands: [hand('open')] });
  assert.equal(s.faces, 1);
  assert.equal(s.withEars, 0);
  assert.ok(calls.hint.includes(HINTS.makeV) || calls.hint.includes(null));

  s = run(1.2, { faces: [face], hands: [hand('v')] });
  assert.equal(s.ears[0].animal, 'cat');
  assert.ok(s.ears[0].scale > 0.9);
  assert.ok(calls.sound.some(([k]) => k === 'chime'), '처음 귀가 생기면 종소리');
  // 계속 브이 → 그대로
  s = run(1, { faces: [face], hands: [hand('v')] });
  assert.equal(s.switches, 1);
  // 폈다가 브이 → 토끼
  run(0.5, { faces: [face], hands: [hand('open')] });
  s = run(1.2, { faces: [face], hands: [hand('v')] });
  assert.equal(s.ears[0].animal, 'rabbit');
  assert.equal(s.switches, 2);
  assert.equal(calls.hint.at(-1) === HINTS.again || calls.hint.at(-1) === '', true, `안내: ${calls.hint.at(-1)}`);

  // 브이한 손이 얼굴을 가려 얼굴 인식이 0.5초 끊겨도, 얼굴이 돌아오면 그 브이로 바뀐다 (토끼 → 곰)
  run(0.5, { faces: [face], hands: [hand('open')] });
  s = run(0.5, { faces: [], hands: [hand('v', 600, 380)] });
  assert.equal(s.faces, 0);
  s = run(1.2, { faces: [face], hands: [hand('v', 600, 380)] });
  assert.equal(s.ears[0].animal, 'bear', `얼굴이 돌아오면 바뀜: ${JSON.stringify(s.ears)}`);
  for (const want of ['fox', 'dog', 'panda', 'cat', 'rabbit']) {
    run(0.5, { faces: [face], hands: [hand('open')] });
    s = run(1.2, { faces: [face], hands: [hand('v')] });
    assert.equal(s.ears[0].animal, want);
  }
  assert.equal(calls.toast.length, 1, '여섯 동물을 다 해 보면 축하 한 번 (다시 돌아도 또 하지 않음)');

  // 두 번째 아이 옆에서 브이 → 그 아이만 (친구가 안 쓰는 첫 동물 = 고양이)
  const friend = { x: 1080, y: 360, size: 200 };
  run(0.5, { faces: [face, friend], hands: [hand('open', 1000, 560)] });
  s = run(1.2, { faces: [face, friend], hands: [hand('v', 1000, 560)] });
  const byX = s.ears.map((e) => e.animal);
  assert.deepEqual(byX.sort(), ['cat', 'rabbit']);

  // 첫 아이를 0.6초 놓쳤다가 돌아오면 토끼 귀 그대로
  run(0.6, { faces: [friend], hands: [] });
  s = run(0.5, { faces: [face, friend], hands: [] });
  assert.deepEqual(s.ears.map((e) => e.animal).sort(), ['cat', 'rabbit']);
  // 오래(2초) 사라지면 새로 시작
  run(2, { faces: [friend], hands: [] });
  s = run(0.7, { faces: [face, friend], hands: [] });
  assert.deepEqual(s.ears.map((e) => e.animal).sort((a, b) => String(a).localeCompare(String(b))), ['cat', null]);
  assert.equal(calls.hint.at(-1), HINTS.friend);

  // 아무도 없으면 안내
  s = run(1, { faces: [], hands: [] });
  assert.equal(s.faces, 0);
  assert.equal(calls.hint.at(-1), HINTS.noFace);
  mode.exit();
  assert.equal(mode.state().faces, 0);
});

test('놀이 전체: 두 손으로 동시에 브이해도 한 번만 바뀌고, 여섯 번 바꾸면 축하', () => {
  const { app, calls } = fakeApp();
  const mode = ears.create(app);
  const run = runner(mode);
  const face = { x: 640, y: 360, size: 240 };
  const both = (pose) => [
    { x: 900, y: 520, size: 135, pose, side: 'right' },
    { x: 380, y: 520, size: 135, pose, side: 'left' },
  ];
  run(0.5, { faces: [face], hands: both('open') });
  let s = run(1.2, { faces: [face], hands: both('v') });
  assert.equal(s.ears[0].animal, 'cat');
  assert.equal(s.switches, 1, '두 손 브이 = 한 번');
  for (let i = 0; i < 5; i++) {
    run(0.5, { faces: [face], hands: both('open') });
    s = run(1.2, { faces: [face], hands: both('v') });
  }
  assert.equal(s.ears[0].animal, 'panda');
  assert.equal(s.switches, 6);
  s = run(1.5, { faces: [face], hands: both('v') });
  assert.equal(calls.toast.length, 1, `축하 한 번: ${calls.toast}`);
});

test('놀이 전체: 얼굴이 안 보이는 다른 아이의 브이는 보이는 아이의 귀를 바꾸지 않는다', () => {
  const { app } = fakeApp();
  const mode = ears.create(app);
  const run = runner(mode);
  const A = { x: 320, y: 360, size: 220 };
  const B = { x: 960, y: 360, size: 220 };
  const handA = (pose) => ({ x: 520, y: 520, size: 125, pose });
  const handB = (pose) => ({ x: 960, y: 520, size: 125, pose });
  run(0.4, { faces: [A], hands: [handA('open')] });
  let s = run(1.2, { faces: [A], hands: [handA('v')] });
  assert.equal(s.ears[0].animal, 'cat');
  run(0.5, { faces: [A], hands: [handA('open')] });
  // 1) B 의 얼굴은 처음부터 안 보이고(옆을 봄), B 가 자기 앞에서 브이 → 아무 일도 없다
  s = run(1.6, { faces: [A], hands: [handB('open')] });
  s = run(1.6, { faces: [A], hands: [handB('v')] });
  assert.equal(s.ears[0].animal, 'cat', `A 는 그대로: ${JSON.stringify(s.ears)}`);
  assert.equal(s.switches, 1);
  // 2) B 얼굴이 보였다가(귀 없음) 손이 얼굴을 가려 사라진 사이에 한 브이 → A 가 아니라, B 얼굴이 돌아오면 B 에게
  run(0.6, { faces: [A], hands: [handB('open')] });
  s = run(0.5, { faces: [A, B], hands: [handB('open')] });
  assert.equal(s.withEars, 1, 'B 는 아직 귀가 없다');
  run(0.4, { faces: [A], hands: [handB('open')] }); // B 얼굴이 사라진다 (인식 유예 0.3초가 지나면 자리만 기억)
  s = run(0.5, { faces: [A], hands: [handB('v')] });
  assert.equal(s.ghosts, 1, '사라진 B 얼굴 자리를 기억');
  assert.equal(s.ears.find((e) => e.animal)?.animal, 'cat');
  assert.equal(s.switches, 1, 'A 는 그대로');
  s = run(1.0, { faces: [A, B], hands: [handB('v')] });
  assert.deepEqual(s.ears.map((e) => e.animal).sort(), ['cat', 'rabbit'], `B 에게 귀: ${JSON.stringify(s.ears)}`);
  assert.equal(s.switches, 2);
});

test('놀이 전체: 브이를 빠르게 여러 번 해도 한 번 한 번 다 바뀌고, 브이마다 삑 소리가 한 번', () => {
  const { app, calls } = fakeApp();
  const mode = ears.create(app);
  const run = runner(mode);
  const face = { x: 560, y: 360, size: 240 };
  const hand = (pose) => ({ x: 840, y: 520, size: 135, pose });
  run(0.5, { faces: [face], hands: [hand('open')] });
  let s;
  for (let i = 0; i < 6; i++) {
    run(0.35, { faces: [face], hands: [hand('v')] });
    s = run(0.4, { faces: [face], hands: [hand('open')] });
  }
  s = run(1.2, { faces: [face], hands: [hand('open')] });
  assert.equal(s.switches, 6, `브이 6번 = 변신 6번 (${s.switches})`);
  assert.equal(s.ears[0].animal, 'panda');
  assert.equal(calls.sound.filter(([k]) => k === 'pip').length, 6, '브이마다 알아들었다는 삑');
  // 아주 짧은 브이(별이 날아가는 중)라도 버리지 않고 이어서 바꾼다
  run(0.15, { faces: [face], hands: [hand('v')] });
  run(0.3, { faces: [face], hands: [hand('open')] });
  run(0.15, { faces: [face], hands: [hand('v')] });
  s = run(1.5, { faces: [face], hands: [hand('open')] });
  assert.equal(s.switches, 8, `짧은 브이 두 번도 두 번 (${s.switches})`);
  assert.equal(s.queued, 0);
});

test('놀이 전체: 손을 숨겼다가 "짠!" 하고 브이를 다시 내밀면 바뀐다', () => {
  const { app } = fakeApp();
  const mode = ears.create(app);
  const run = runner(mode);
  const face = { x: 560, y: 360, size: 240 };
  const hand = (pose) => ({ x: 840, y: 520, size: 135, pose });
  run(0.5, { faces: [face], hands: [hand('open')] });
  let s = run(1.2, { faces: [face], hands: [hand('v')] });
  assert.equal(s.ears[0].animal, 'cat');
  run(0.5, { faces: [face], hands: [] });
  s = run(1.2, { faces: [face], hands: [{ ...hand('v'), x: 880, y: 540 }] });
  assert.equal(s.ears[0].animal, 'rabbit', `짠! 브이 → 토끼 (${s.ears[0].animal})`);
  assert.equal(s.switches, 2);
});

test('놀이 전체: 이미 쓴 브이를 들고 있으면 옆에 온 친구에게 공짜로 귀를 주지 않는다', () => {
  const { app } = fakeApp();
  const mode = ears.create(app);
  const run = runner(mode);
  const A = { x: 400, y: 360, size: 220 };
  const B = { x: 900, y: 360, size: 220 };
  const hand = (pose) => ({ x: 650, y: 480, size: 125, pose });
  run(0.4, { faces: [A], hands: [hand('open')] });
  let s = run(1.2, { faces: [A], hands: [hand('v')] });
  assert.equal(s.withEars, 1);
  s = run(1.5, { faces: [A, B], hands: [hand('v')] });
  assert.equal(s.withEars, 1, `B 는 아직 귀가 없다: ${JSON.stringify(s.ears)}`);
  // B 가 자기 브이를 하면 생긴다
  s = run(1.2, { faces: [A, B], hands: [hand('v'), { x: 1080, y: 520, size: 125, pose: 'v' }] });
  assert.equal(s.withEars, 2);
});
