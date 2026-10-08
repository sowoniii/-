// 말랑 화면 놀이 순수 로직 테스트:  node --test tests/warp.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthHand } from '../src/core/synth.js';
import { analyzeHand } from '../src/core/gestures.js';
import { HandTracker } from '../src/core/handtracker.js';
import { WarpGrid } from '../src/core/stage.js';
import {
  GRAB,
  TWIST,
  Grabber,
  Jelly,
  grabField,
  grabSigma,
  computeTargets,
  displaceAt,
  edgeWeights,
  borderOf,
  stillHolding,
  segmentStrain,
  boingPitch,
  softCap,
  applyMasks,
  buildMasks,
  grabKindFor,
  handAngles,
  twistDelta,
  buildHandPatch,
  makePatchBuffer,
  insidePatch,
} from '../src/modes/warp/jelly.js';

const W = 1280;
const H = 720;

/** 놀이가 받는 Hand 와 같은 모양의 가짜 손 (pose 를 직접 정할 수 있다) */
function fakeHand({ id = 1, x = 640, y = 360, size = 140, angle = 0, pose = 'fist', stale = false, shape = pose, age = 1, side = 'right' }) {
  const lm = synthHand({ x, y, size, angle, pose: shape });
  const a = analyzeHand(lm);
  return {
    id,
    lm,
    size: a.size,
    palm: a.palm,
    ext: a.ext,
    openness: a.openness,
    pinchDist: a.pinchDist,
    pinchPoint: { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 },
    pose,
    stale,
    age,
    side,
  };
}

const run = (grabber, frames, dt = 1 / 60) => {
  const events = [];
  for (const hands of frames) events.push(...grabber.update(hands, dt, W, H));
  return events;
};
const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

test('잡는 범위는 손 크기에 비례하고 화면 크기로 막힌다', () => {
  assert.ok(grabSigma('fist', 90, W, H) < grabSigma('fist', 130, W, H));
  assert.equal(grabSigma('fist', 10, W, H), 0.15 * H, '아주 작은 손도 최소 범위');
  assert.equal(grabSigma('fist', 900, W, H), 0.32 * H, '아주 큰 손도 최대 범위');
  assert.ok(grabSigma('pinch', 140, W, H) < grabSigma('fist', 140, W, H), '꼬집기는 좁게');
});

test('주먹을 쥐면 잡고, 따라가고, 손을 펴면 놓는다', () => {
  const gr = new Grabber();
  assert.deepEqual(run(gr, [[fakeHand({ pose: 'open' })]]), []);
  let ev = run(gr, [[fakeHand({ pose: 'fist', x: 600, y: 400 })]]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'grab');
  const g = ev[0].grab;
  assert.equal(g.kind, 'fist');
  assert.ok(Math.abs(g.p0.x - 600) < 1 && Math.abs(g.p0.y - 400) < 1);
  // 당기기
  run(gr, repeat(10, (i) => [fakeHand({ x: 600 + i * 20, y: 400 })]));
  assert.ok(Math.abs(g.pos.x - 780) < 1, `pos ${g.pos.x}`);
  assert.ok(Math.abs(g.p0.x - 600) < 1, '잡은 점은 그대로');
  assert.ok(g.maxDrag > 170);
  // 손을 펴면 openGrace 안에 놓는다
  ev = run(gr, repeat(6, () => [fakeHand({ x: 780, y: 400, pose: 'open' })]));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'release');
  assert.equal(ev[0].reason, 'open');
  assert.equal(gr.count, 0);
});

test('비틀기는 손목 각도 변화로 누적되고 최대값에서 멈춘다', () => {
  const gr = new Grabber();
  run(gr, [[fakeHand({ angle: 0 })]]);
  const g = gr.list[0];
  run(gr, repeat(10, (i) => [fakeHand({ angle: (i + 1) * 0.08 })]));
  assert.ok(Math.abs(g.twist - 0.8) < 0.02, `twist ${g.twist}`);
  // 반대 방향, 그리고 -π 경계를 넘어가도 이어서 누적
  run(gr, repeat(40, (i) => [fakeHand({ angle: 0.8 - (i + 1) * 0.1 })]));
  assert.equal(g.twist, -GRAB.maxTwist);
});

test('인식이 잠깐 흔들려도(다른 모양, stale) 계속 잡고 있다', () => {
  const gr = new Grabber();
  run(gr, [[fakeHand({ x: 500 })]]);
  const g = gr.list[0];
  // 'other' 로 잘못 읽혀도 손가락이 접혀 있으면 계속 잡기 (히스테리시스)
  let ev = run(gr, repeat(30, () => [fakeHand({ x: 520, pose: 'other', shape: 'fist' })]));
  assert.deepEqual(ev, []);
  // 정말 느슨한 손으로 'other' 가 되면 loseGrace 만큼 기다린 뒤 놓는다
  ev = run(gr, repeat(Math.floor(GRAB.loseGrace * 60) - 2, () => [fakeHand({ x: 520, pose: 'other' })]));
  assert.deepEqual(ev, [], 'grace 안에서는 유지');
  ev = run(gr, [[fakeHand({ x: 520, pose: 'fist' })]]);
  assert.deepEqual(ev, []);
  assert.equal(gr.list[0], g);
  // stale: 위치를 바꾸지 않고 그대로 잡고 있다
  ev = run(gr, repeat(10, () => [fakeHand({ x: 900, stale: true, pose: 'other' })]));
  assert.deepEqual(ev, []);
  assert.ok(Math.abs(g.pos.x - 520) < 1);
});

test('손 id 가 바뀌어도(다시 인식) 근처 주먹이 이어서 잡는다', () => {
  const gr = new Grabber();
  run(gr, [[fakeHand({ id: 1, x: 500 })]]);
  run(gr, repeat(5, (i) => [fakeHand({ id: 1, x: 500 + i * 30 })]));
  const g = gr.list[0];
  // 손이 사라짐 → 잠깐 유지
  let ev = run(gr, repeat(6, () => []));
  assert.deepEqual(ev, []);
  assert.equal(gr.count, 1);
  // 근처에 새로 인식된(새 id, 방금 생긴) 주먹 → 이어받기 (새로 잡지 않음)
  ev = run(gr, [[fakeHand({ id: 2, x: 640, age: 0 })]]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'adopt');
  assert.equal(gr.list[0], g);
  assert.equal(g.handId, 2);
  assert.equal(gr.created, 1);
  assert.ok(Math.abs(g.p0.x - 500) < 1, '처음 잡은 점 유지');

  // 멀리서 나타난 주먹은 새 잡기, 사라진 잡기는 시간이 지나면 놓는다
  ev = run(gr, repeat(3, () => []));
  ev = run(gr, [[fakeHand({ id: 3, x: 100, y: 100, age: 0 })]]);
  assert.equal(ev[0].type, 'grab');
  ev = run(gr, repeat(30, () => [fakeHand({ id: 3, x: 100, y: 100 })]));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'release');
  assert.equal(ev[0].reason, 'lost');
  assert.equal(gr.count, 1);
});

test('여러 손이 각자 잡고, 꼬집기는 놓지 않고 그 자리에서 주먹 잡기로 바뀐다 (당긴 만큼 그대로)', () => {
  const gr = new Grabber();
  run(gr, [[fakeHand({ id: 1, x: 300 }), fakeHand({ id: 2, x: 900, pose: 'pinch' })]]);
  assert.equal(gr.count, 2);
  assert.deepEqual(gr.list.map((g) => g.kind).sort(), ['fist', 'pinch']);
  const pinch = gr.list.find((g) => g.kind === 'pinch');
  assert.ok(pinch.sigma < gr.list.find((g) => g.kind === 'fist').sigma);
  // 꼬집어서 148px 끌어 온 뒤 주먹
  run(gr, repeat(10, (i) => [fakeHand({ id: 1, x: 300 }), fakeHand({ id: 2, x: 900 + (i + 1) * 14.8, pose: 'pinch' })]));
  const before = { x: pinch.pos.x - pinch.p0.x, y: pinch.pos.y - pinch.p0.y };
  assert.ok(Math.hypot(before.x, before.y) > 140);
  const ev = run(gr, [[fakeHand({ id: 1, x: 300 }), fakeHand({ id: 2, x: 1048, pose: 'fist' })]]);
  assert.deepEqual(ev.map((e) => e.type), ['convert'], '놓았다 다시 잡지 않는다 (띠용 없이 이어진다)');
  assert.equal(gr.list.find((g) => g.handId === 2), pinch, '같은 잡기');
  assert.equal(pinch.kind, 'fist');
  assert.equal(pinch.sigma, grabSigma('fist', pinch.size, W, H));
  const after = { x: pinch.pos.x - pinch.p0.x, y: pinch.pos.y - pinch.p0.y };
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 2, `당긴 거리·방향 유지 ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  assert.equal(gr.released, 0);
  assert.equal(gr.converted, 1);
  assert.deepEqual(gr.list.map((g) => g.kind), ['fist', 'fist']);
});

test('stillHolding: 주먹 히스테리시스와 집기 히스테리시스', () => {
  assert.equal(stillHolding(fakeHand({ pose: 'other', shape: 'fist' }), 'fist'), true);
  assert.equal(stillHolding(fakeHand({ pose: 'point', shape: 'point' }), 'fist'), false, '검지를 펴면 놓기');
  assert.equal(stillHolding(fakeHand({ pose: 'open', shape: 'fist' }), 'fist'), false);
  assert.equal(stillHolding(fakeHand({ pose: 'other', shape: 'pinch' }), 'pinch'), true);
  assert.equal(stillHolding(fakeHand({ pose: 'other', shape: 'open' }), 'pinch'), false);
});

test('HandTracker 와 함께: 합성 손으로 주먹 → 당기기 → 펴기', () => {
  const tr = new HandTracker();
  const gr = new Grabber();
  let t = 0;
  const events = [];
  const step = (h) => {
    t += 1 / 30;
    const hands = tr.update([{ lm: synthHand(h), side: 'right' }], t);
    events.push(...gr.update(hands, 1 / 30, W, H));
  };
  for (let i = 0; i < 6; i++) step({ x: 600, y: 400, size: 140, pose: 'open' });
  for (let i = 0; i < 6; i++) step({ x: 600, y: 400, size: 140, pose: 'fist' });
  assert.equal(events.filter((e) => e.type === 'grab').length, 1);
  for (let i = 0; i < 10; i++) step({ x: 600 + i * 25, y: 400, size: 140, pose: 'fist' });
  const g = gr.list[0];
  assert.ok(g.pos.x - g.p0.x > 180, `drag ${g.pos.x - g.p0.x}`);
  for (let i = 0; i < 8; i++) step({ x: 825, y: 400, size: 140, pose: 'open' });
  assert.equal(events.filter((e) => e.type === 'release').length, 1);
  assert.equal(gr.count, 0);
});

// ------------------------------------------------------------------ 변형 모양

const baseGrab = (o = {}) => ({ p0: { x: 640, y: 360 }, pos: { x: 640, y: 360 }, sigma: 150, twist: 0, size0: 140, size: 140, ...o });

test('grabField: 범위는 그대로(화면 전체가 미끄러지지 않게), 너무 멀리 당기면 잡은 점이 뒤처진다, 작은 비틀기·크기 떨림은 무시', () => {
  let F = grabField(baseGrab({ pos: { x: 740, y: 360 } }));
  assert.equal(F.dx, 100);
  assert.equal(F.sigma, 150);
  assert.equal(F.dc, 100);
  F = grabField(baseGrab({ pos: { x: 1240, y: 360 } }), {}, 432);
  assert.equal(F.sigma, 150, '멀리 당겨도 범위를 넓히지 않는다');
  assert.ok(F.dc < 600 && F.dc <= 432 && F.dc > 380, `잡은 점은 cap 아래에서 뒤처진다 ${F.dc}`);
  assert.ok(F.h < 1);
  assert.equal(grabField(baseGrab({ twist: 0.15 })).theta, 0, '팔을 휘두를 때 손이 조금 기우는 것은 무시');
  assert.ok(grabField(baseGrab({ twist: 1 })).theta > 0.7);
  assert.ok(grabField(baseGrab({ twist: -1 })).theta < -0.7);
  assert.ok(Math.abs(grabField(baseGrab({ twist: 5 })).theta) <= TWIST.max);
  assert.equal(grabField(baseGrab({ kind: 'pinch', twist: 2 })).theta, 0, '꼬집기는 비틀지 않는다');
  assert.equal(grabField(baseGrab({ size: 145 })).bulge, 0);
  assert.ok(grabField(baseGrab({ size: 200 })).bulge > 0, '주먹을 앞으로 내밀면 볼록');
  assert.ok(grabField(baseGrab({ size: 100 })).bulge < 0, '뒤로 당기면 오목');
});

function setup() {
  const grid = new WarpGrid(W, H);
  const edge = edgeWeights(grid);
  const target = new Float32Array(grid.count * 2);
  const weight = new Float32Array(grid.count);
  return { grid, edge, target, weight };
}
const nearest = (grid, x, y) => {
  let best = 0;
  let bd = Infinity;
  for (let k = 0; k < grid.count; k++) {
    const d = Math.hypot(grid.rest[k * 2] - x, grid.rest[k * 2 + 1] - y);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
};

/**
 * 화면 안에서 뒤집혀(접혀) 보이는 격자 넓이 px². 손 조각(bufs) 아래는 손이 덮으므로 세지 않는다.
 * (화면 밖 여백이 접히는 것은 보이지 않는다)
 */
function visibleFlipArea(grid, bufs, width = W, height = H) {
  const st = grid.cols + 1;
  const P = (k) => [grid.rest[k * 2] + grid.offset[k * 2], grid.rest[k * 2 + 1] + grid.offset[k * 2 + 1]];
  let area = 0;
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      const a = j * st + i;
      for (const [x, y, z] of [[a, a + 1, a + st], [a + 1, a + st + 1, a + st]]) {
        const A = P(x);
        const B = P(y);
        const C = P(z);
        const s2 = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
        if (s2 >= 0) continue;
        const mx = (A[0] + B[0] + C[0]) / 3;
        const my = (A[1] + B[1] + C[1]) / 3;
        if (mx < 0 || my < 0 || mx > width || my > height) continue;
        if (bufs.some((b) => insidePatch(b, mx, my, 0))) continue;
        area -= s2 / 2;
      }
    }
  }
  return area;
}

test('edgeWeights: 격자 테두리는 고정, 화면 안쪽은 자유', () => {
  const { grid, edge } = setup();
  assert.equal(edge[0], 0);
  assert.equal(edge[grid.count - 1], 0);
  assert.equal(edge[nearest(grid, 640, 360)], 1);
  assert.equal(edge[nearest(grid, 0, 360)], 1, '화면 가장자리는 아직 자유');
});

test('computeTargets: 잡은 점은 손을 따라가고 먼 곳은 그대로', () => {
  const { grid, edge, target, weight } = setup();
  const k0 = nearest(grid, 640, 360);
  const cx = grid.rest[k0 * 2];
  const cy = grid.rest[k0 * 2 + 1];
  const F = grabField(baseGrab({ p0: { x: cx, y: cy }, pos: { x: cx + 120, y: cy - 40 } }));
  computeTargets(grid, edge, [F], target, weight, 432);
  assert.ok(Math.abs(target[k0 * 2] - 120) < 0.5, `tx ${target[k0 * 2]}`);
  assert.ok(Math.abs(target[k0 * 2 + 1] + 40) < 2);
  assert.ok(weight[k0] > 0.99);
  const far = nearest(grid, 50, 50);
  assert.ok(Math.hypot(target[far * 2], target[far * 2 + 1]) < 1);
  assert.equal(target[0], 0, '테두리 고정');
});

test('softCap: 작은 변위는 그대로, 큰 변위는 cap 아래로 부드럽게', () => {
  assert.equal(softCap(100, 400), 100);
  assert.equal(softCap(220, 400), 220);
  assert.ok(softCap(300, 400) < 300 && softCap(300, 400) > 280);
  assert.ok(softCap(5000, 400) <= 400);
  // 단조 증가
  let prev = 0;
  for (let m = 0; m < 2000; m += 7) {
    const v = softCap(m, 400);
    assert.ok(v >= prev);
    prev = v;
  }
});

test('computeTargets: 두 손이 반대로 당기면 화면이 양쪽으로 늘어난다', () => {
  const { grid, edge, target, weight } = setup();
  const a = grabField(baseGrab({ p0: { x: 450, y: 360 }, pos: { x: 300, y: 360 } }));
  const b = grabField(baseGrab({ p0: { x: 830, y: 360 }, pos: { x: 980, y: 360 } }));
  computeTargets(grid, edge, [a, b], target, weight, 432);
  const ka = nearest(grid, 450, 360);
  const kb = nearest(grid, 830, 360);
  // 잡은 점은 저마다 자기 손을 거의 그대로 따라간다 (서로 상쇄되지 않음)
  assert.ok(target[ka * 2] < -140, `left ${target[ka * 2]}`);
  assert.ok(target[kb * 2] > 140, `right ${target[kb * 2]}`);
  // 가운데는 양쪽 몫이 반반이라 거의 제자리
  const kc = nearest(grid, 640, 360);
  assert.ok(Math.abs(target[kc * 2]) < 15, `center ${target[kc * 2]}`);
  // 가운데 줄이 늘어났다
  const L0 = grid.rest[kb * 2] - grid.rest[ka * 2];
  const L1 = L0 + target[kb * 2] - target[ka * 2];
  assert.ok(L1 > L0 * 1.6);
  // 같은 방향으로 두 손이 당기면 두 배가 되지 않고 손을 따라간다
  const c = grabField(baseGrab({ p0: { x: 600, y: 360 }, pos: { x: 600, y: 200 } }));
  const d = grabField(baseGrab({ p0: { x: 680, y: 360 }, pos: { x: 680, y: 200 } }));
  computeTargets(grid, edge, [c, d], target, weight, 432);
  const km = nearest(grid, 640, 360);
  assert.ok(Math.abs(target[km * 2 + 1] + 160) < 12, `same dir ${target[km * 2 + 1]}`);
});

test('잡기 하나의 모양: 잡은 점 뒤는 늘어나고, 잡은 점~손 사이는 주먹 속으로 접히고, 손 앞쪽은 그대로', () => {
  const F = grabField(baseGrab({ p0: { x: 400, y: 360 }, pos: { x: 700, y: 360 } }));
  const o = new Float64Array(5);
  const along = (x) => (displaceAt([F], 1, x, 360, o), o[0]);
  // 잡은 점은 손(주먹 가운데 바로 앞)으로
  assert.ok(Math.abs(400 + along(400) - 700) < 0.1 * 140, `잡은 점 → ${400 + along(400)}`);
  // 손 앞쪽(앞 끝 0.3×크기 너머)은 그대로 → 영상 속 손가락 마디가 앞으로 밀려 나오지 않는다
  for (const x of [700 + 0.3 * 140, 760, 900, 1100]) assert.ok(Math.abs(along(x)) < 1e-6, `앞쪽 ${x}: ${along(x)}`);
  // 뒤쪽은 늘어난다 (밀도 > 1), 사이는 눌린다 (밀도 0..1), 어디서도 뒤집히지 않는다 (위치가 늘 증가)
  let prev = -Infinity;
  for (let x = -100; x <= 1300; x += 2) {
    const X = x + along(x);
    assert.ok(X >= prev - 1e-6, `뒤집힘 at ${x}: ${X} < ${prev}`);
    prev = X;
  }
  const stretch = (along(300) - along(250)) / 50 + 1;
  assert.ok(stretch > 1.3, `뒤쪽은 늘어남 ${stretch}`);
  // 사이(손 뒤쪽 영상 포함)는 모두 주먹 자리로 모인다: 손바닥 ± 0.37×크기 (손 조각이 늘 덮는 곳)
  for (let x = 410; x <= 700; x += 10) {
    const X = x + along(x);
    assert.ok(X > 700 - 0.37 * 140 && X < 700 + 0.37 * 140, `사이 ${x} → ${X}`);
  }
  // 옆으로 갈수록 약해진다
  displaceAt([F], 1, 400, 360 + 300, o);
  assert.ok(o[0] < 0.5 * 300);
});

test('computeTargets: 아무리 세게 당겨도 최대 변위를 넘지 않고 격자가 뒤집히지 않는다', () => {
  const { grid, edge, target, weight } = setup();
  const cap = 0.6 * H;
  const fields = [
    grabField(baseGrab({ p0: { x: 640, y: 360 }, pos: { x: 1600, y: -300 }, twist: 2.4 }), {}, cap),
    grabField(baseGrab({ p0: { x: 400, y: 400 }, pos: { x: 200, y: 600 }, twist: -2.4, size: 260 }), {}, cap),
  ];
  computeTargets(grid, edge, fields, target, weight, H);
  let maxM = 0;
  for (let k = 0; k < grid.count; k++) maxM = Math.max(maxM, Math.hypot(target[k * 2], target[k * 2 + 1]));
  assert.ok(maxM <= H + 1e-3, `max ${maxM}`);
  assert.ok(fields[0].dc <= cap, '잡은 점 이동은 cap 까지');
  assert.ok(maxM > cap * 0.6);
  // 한 손 당기기는 모든 칸이 같은 방향(뒤집히지 않음)을 유지한다
  const single = [grabField(baseGrab({ p0: { x: 640, y: 360 }, pos: { x: 1000, y: 200 } }), {}, cap)];
  computeTargets(grid, edge, single, target, weight, H);
  let flipped = 0;
  const P = (k) => [grid.rest[k * 2] + target[k * 2], grid.rest[k * 2 + 1] + target[k * 2 + 1]];
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      const a = P(grid.index(i, j));
      const b = P(grid.index(i + 1, j));
      const c = P(grid.index(i, j + 1));
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= 0) flipped++;
    }
  }
  assert.equal(flipped, 0);
});

test('computeTargets: 비틀면 잡은 점 둘레가 소용돌이친다', () => {
  const { grid, edge, target, weight } = setup();
  const k0 = nearest(grid, 640, 360);
  const cx = grid.rest[k0 * 2];
  const cy = grid.rest[k0 * 2 + 1];
  const F = grabField(baseGrab({ p0: { x: cx, y: cy }, pos: { x: cx, y: cy }, twist: 1.3 }));
  computeTargets(grid, edge, [F], target, weight, H);
  assert.ok(Math.hypot(target[k0 * 2], target[k0 * 2 + 1]) < 1e-3, '가운데는 제자리');
  // 손 자리(0.75×크기 안)는 돌지 않는다 → 영상 속 주먹이 두 번 돌아 보이지 않는다
  const kin = nearest(grid, cx + 60, cy);
  assert.ok(Math.hypot(target[kin * 2], target[kin * 2 + 1]) < 1e-3, '주먹 자리는 그대로');
  const kr = nearest(grid, cx + 300, cy); // 오른쪽 점은 시계방향(화면 아래쪽)으로 돈다
  assert.ok(target[kr * 2 + 1] > 80, `ty ${target[kr * 2 + 1]}`);
  // 격자 한 칸 사이 소용돌이 각도 차이가 작아서 화면 안의 칸이 뒤집히지 않는다
  grid.offset.set(target);
  assert.equal(visibleFlipArea(grid, []), 0);
});

// ------------------------------------------------------------------ 젤리 물리

function jellyWith(grid, fields) {
  const j = new Jelly();
  j.bind(grid);
  j.setFields(fields, 432);
  return j;
}

test('Jelly: 잡으면 목표로 빠르게 따라가고, 놓으면 출렁이다가 제자리에서 멈춘다', () => {
  const grid = new WarpGrid(W, H);
  const k0 = nearest(grid, 640, 360);
  const cx = grid.rest[k0 * 2];
  const cy = grid.rest[k0 * 2 + 1];
  const F = grabField(baseGrab({ p0: { x: cx, y: cy }, pos: { x: cx + 150, y: cy } }));
  const j = jellyWith(grid, [F]);
  for (let i = 0; i < 18; i++) j.step(1 / 60); // 0.3초
  assert.ok(grid.offset[k0 * 2] > 130, `따라감 ${grid.offset[k0 * 2]}`);
  assert.ok(j.maxOffset > 130);
  // 놓기
  j.setFields([], 432);
  let minX = Infinity;
  for (let i = 0; i < 60; i++) {
    j.step(1 / 60);
    minX = Math.min(minX, grid.offset[k0 * 2]);
  }
  assert.ok(minX < -30, `반대로 출렁 ${minX}`);
  for (let i = 0; i < 400 && !j.sleeping; i++) j.step(1 / 60);
  assert.equal(j.sleeping, true);
  assert.equal(grid.isDeformed(), false);
  assert.equal(j.maxOffset, 0);
});

test('Jelly: 프레임레이트가 달라도 결과가 비슷하고 큰 dt 에도 터지지 않는다', () => {
  const sim = (fps, seconds) => {
    const grid = new WarpGrid(W, H);
    const F = grabField(baseGrab({ pos: { x: 900, y: 200 }, twist: 1.5 }));
    const j = jellyWith(grid, [F]);
    for (let i = 0; i < fps * seconds; i++) j.step(1 / fps);
    j.setFields([], 432);
    for (let i = 0; i < fps * 0.4; i++) j.step(1 / fps);
    return grid;
  };
  const a = sim(30, 0.6);
  const b = sim(120, 0.6);
  let diff = 0;
  for (let k = 0; k < a.offset.length; k++) diff = Math.max(diff, Math.abs(a.offset[k] - b.offset[k]));
  assert.ok(diff < 6, `diff ${diff}`);
  // 아주 큰 dt (탭 전환 후 복귀 등)
  const grid = new WarpGrid(W, H);
  const j = jellyWith(grid, [grabField(baseGrab({ pos: { x: 1100, y: 600 } }))]);
  for (let i = 0; i < 50; i++) j.step(0.25);
  for (const v of grid.offset) assert.ok(Number.isFinite(v) && Math.abs(v) < 1000);
});

test('Jelly: 이웃끼리 연결되어 물결이 퍼진다', () => {
  const ripple = (kappa) => {
    const grid = new WarpGrid(W, H);
    const j = new Jelly({ kappa });
    j.bind(grid);
    j.kick(640, 360, 15, 0, 2000);
    const far = nearest(grid, 640, 360 + 150);
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      j.step(1 / 60);
      peak = Math.max(peak, Math.abs(grid.offset[far * 2 + 1]));
    }
    return peak;
  };
  assert.ok(ripple(0) < 0.01);
  assert.ok(ripple(520) > 1, `ripple ${ripple(520)}`);
});

test('Jelly: 창 크기가 바뀌어 격자가 새로 생기면 버퍼를 다시 맞춘다', () => {
  const j = new Jelly();
  const g1 = new WarpGrid(W, H);
  assert.equal(j.bind(g1), true);
  assert.equal(j.bind(g1), false);
  const g2 = new WarpGrid(800, 1000);
  assert.equal(j.bind(g2), true);
  assert.equal(j.vel.length, g2.count * 2);
  j.setFields([grabField(baseGrab({ p0: { x: 400, y: 500 }, pos: { x: 500, y: 500 } }))], 400);
  j.step(1 / 60);
  assert.ok(g2.isDeformed());
});

test('그리기 도우미: 선분 늘어남, 띠용 소리 높이', () => {
  const grid = new WarpGrid(W, H);
  const a = grid.index(10, 10);
  const b = grid.index(11, 10);
  assert.equal(segmentStrain(grid, a, b), 0);
  grid.offset[b * 2] = grid.cellW; // 두 배로 늘림
  assert.ok(Math.abs(segmentStrain(grid, a, b) - 1) < 1e-6);
  assert.ok(boingPitch(0, 150) > boingPitch(300, 150));
  assert.ok(boingPitch(1e6, 150) >= 0.6);
});

test('buildHandPatch: 손 전체를 감싸고 가장자리는 투명하게', async () => {
  const { buildHandPatch, makePatchBuffer } = await import('../src/modes/warp/jelly.js');
  const buf = makePatchBuffer();
  for (const pose of ['open', 'fist', 'pinch', 'v']) {
    for (const angle of [0, 1.2, -2.5]) {
      const lm = synthHand({ x: 500, y: 400, size: 140, angle, pose });
      const n = buildHandPatch(lm, 140, buf);
      assert.ok(n >= 7, `${pose} n=${n}`);
      assert.equal(buf.alpha[0], 1);
      const m = (n - 1) / 2;
      for (let i = 0; i < m; i++) {
        assert.equal(buf.alpha[1 + i], 1);
        assert.equal(buf.alpha[1 + m + i], 0);
      }
      for (let q = 0; q < buf.ni; q++) assert.ok(buf.indices[q] < n);
      // 모든 손가락 끝이 불투명한 안쪽 껍질 안에 있다 (점-다각형 판정)
      const inside = (px, py) => {
        let c = false;
        for (let i = 0, j = m - 1; i < m; j = i++) {
          const xi = buf.pos[(1 + i) * 2];
          const yi = buf.pos[(1 + i) * 2 + 1];
          const xj = buf.pos[(1 + j) * 2];
          const yj = buf.pos[(1 + j) * 2 + 1];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
        }
        return c;
      };
      for (const t of [4, 8, 12, 16, 20, 0]) assert.ok(inside(lm[t].x, lm[t].y), `${pose} ${angle} lm${t}`);
      // 너무 크지 않다 (손 크기의 2배 반경 안)
      for (let i = 0; i < n; i++) assert.ok(Math.hypot(buf.pos[i * 2] - 500, buf.pos[i * 2 + 1] - 400) < 140 * 2.4);
    }
  }
});

test('잡지 않은 손 가리개: 약하게 밀리는 곳에서는 손 아래를 붙잡고, 세게 밀리는 곳에서는 넓게 풀어서 접히지 않게', () => {
  const { grid, edge, target, weight } = setup();
  // 640,360 에서 잡아 오른쪽으로 120 → 왼쪽 뒤 300px 쯤에 다른 아이의 펼친 손
  const F = grabField(baseGrab({ p0: { x: 640, y: 360 }, pos: { x: 760, y: 360 } }));
  const open = fakeHand({ id: 9, x: 380, y: 360, pose: 'open' });
  const masks = buildMasks([open], () => false, [], []);
  assert.equal(masks.length, 1);
  computeTargets(grid, edge, [F], target, weight, H, masks);
  const M = masks[0];
  assert.ok(M.kmin < 0.2, `가리개가 손을 붙잡음 kmin=${M.kmin}`);
  const kh = nearest(grid, open.palm.x, open.palm.y);
  const t2 = new Float32Array(grid.count * 2);
  computeTargets(grid, edge, [F], t2, new Float32Array(grid.count), H);
  const without = Math.hypot(t2[kh * 2], t2[kh * 2 + 1]);
  const withM = Math.hypot(target[kh * 2], target[kh * 2 + 1]);
  assert.ok(without > 5, `가리개가 없으면 손 자리도 밀린다 ${without}`);
  assert.ok(withM < 0.25 * without, `손 아래는 거의 그대로 ${withM} vs ${without}`);
  assert.ok(weight[kh] > 0.7, '손 아래는 단단히');
  // 잡고 있는 손은 가리지 않는다 (그 손은 자기 모양이 지킨다)
  assert.equal(buildMasks([fakeHand({ id: 3 })], (id) => id === 3, [], []).length, 0);
  // 잡기가 없어도(출렁이는 중) 지금 변위로 가리개를 만든다
  target.fill(0);
  weight.fill(0);
  grid.offset.fill(0);
  applyMasks(grid, edge, masks, target, weight);
  assert.equal(masks[0].kmin, 1, '움직임이 없으면 가릴 필요 없음');
});

test('Jelly: 출렁이는 동안 손 자리는 거의 흔들리지 않는다', () => {
  const grid = new WarpGrid(W, H);
  const j = new Jelly();
  j.bind(grid);
  // 잡았던 손이 펼쳐진 채 그 자리에 있다 (놓은 직후)
  const open = fakeHand({ id: 1, x: 900, y: 300, pose: 'open' });
  const kh = nearest(grid, open.palm.x, open.palm.y);
  const F = grabField(baseGrab({ p0: { x: 640, y: 430 }, pos: { x: open.palm.x, y: open.palm.y } }));
  for (let i = 0; i < 30; i++) {
    j.setFields([F], H, null);
    j.step(1 / 60);
  }
  const masks = [];
  const pool = [];
  let handMax = 0;
  let worldMax = 0;
  for (let i = 0; i < 90; i++) {
    j.setFields([], H, buildMasks([open], () => false, masks, pool));
    j.step(1 / 60);
    if (i > 10) handMax = Math.max(handMax, Math.hypot(grid.offset[kh * 2], grid.offset[kh * 2 + 1]));
    worldMax = Math.max(worldMax, j.maxOffset);
  }
  assert.ok(worldMax > 100, `world wobbles ${worldMax}`);
  assert.ok(handMax < worldMax * 0.35, `hand ${handMax} vs world ${worldMax}`);
  for (let i = 0; i < 600 && !j.sleeping; i++) {
    j.setFields([], H, buildMasks([open], () => false, masks, pool));
    j.step(1 / 60);
  }
  assert.equal(j.sleeping, true, '가리개가 있어도 결국 쉰다');
});

test('grabKindFor: 대충 쥔 주먹이 집기로 읽혀도 주먹으로 잡는다', () => {
  assert.equal(grabKindFor(fakeHand({ pose: 'pinch', shape: 'pinch' })), 'pinch');
  assert.equal(grabKindFor(fakeHand({ pose: 'pinch', shape: 'fist' })), 'fist');
  assert.equal(grabKindFor(fakeHand({ pose: 'fist' })), 'fist');
  assert.equal(grabKindFor(fakeHand({ pose: 'open', shape: 'open' })), null);
  // 집기로 잘못 읽힌 주먹은 주먹 잡기로 시작
  const gr = new Grabber();
  const ev = run(gr, [[fakeHand({ pose: 'pinch', shape: 'fist' })]]);
  assert.equal(ev[0].grab.kind, 'fist');
});

test('같은 프레임에 두 손이 같은 잡기를 이어받지 않는다', () => {
  const gr = new Grabber();
  run(gr, [[fakeHand({ id: 1, x: 500 })]]);
  run(gr, repeat(3, () => []));
  const ev = run(gr, [[fakeHand({ id: 2, x: 510, age: 0 }), fakeHand({ id: 3, x: 520, age: 0 })]]);
  assert.deepEqual(ev.map((e) => e.type).sort(), ['adopt', 'grab']);
  assert.equal(gr.count, 2);
  assert.equal(new Set(gr.list).size, 2);
});

test('손이 너무 빨리 움직여 인식기가 새 id 를 붙여도(옛 손은 stale) 잡기를 이어받는다', () => {
  const tr = new HandTracker();
  const gr = new Grabber();
  let t = 0;
  const events = [];
  const step = (h) => {
    t += 1 / 30;
    const hands = tr.update(h ? [{ lm: synthHand(h), side: 'right' }] : [], t);
    events.push(...gr.update(hands, 1 / 30, W, H));
    return hands;
  };
  for (let i = 0; i < 6; i++) step({ x: 770, y: 400, size: 140, pose: 'fist' });
  const g = gr.list[0];
  // 한 프레임에 240px 순간이동 → 새 추적 id (옛 손은 stale 로 남음)
  let hs;
  for (let i = 0; i < 6; i++) hs = step({ x: 530, y: 360, size: 140, pose: 'fist' });
  assert.ok(events.some((e) => e.type === 'adopt'), JSON.stringify(events.map((e) => e.type)));
  assert.equal(gr.created, 1, '새로 잡지 않음');
  assert.equal(gr.count, 1);
  assert.equal(gr.list[0], g);
  assert.ok(Math.abs(g.p0.x - 770) < 5, '처음 잡은 점 유지');
  assert.ok(g.pos.x < 560, `손을 따라감 ${g.pos.x}`);
  for (let i = 0; i < 10; i++) hs = step({ x: 530, y: 360, size: 140, pose: 'fist' });
  assert.equal(hs.length, 1);
  assert.equal(gr.count, 1);
});

// ------------------------------------------------------------------ 놀이 전체 (가짜 app 으로)

function mockApp(width, height) {
  const calls = { loop: 0, stopLoop: 0, sounds: 0, toasts: [], hints: [], patches: 0, badPatch: 0 };
  const sound = new Proxy(
    {},
    {
      get: (_, name) => (...args) => {
        if (name === 'loop') calls.loop++;
        else if (name === 'stopLoop') calls.stopLoop++;
        else calls.sounds++;
        for (const a of args) if (typeof a === 'number') assert.ok(Number.isFinite(a), `${String(name)} ${a}`);
      },
    },
  );
  const app = {
    width,
    height,
    isSim: true,
    sound,
    ui: { hint: (t) => calls.hints.push(t), toast: (t) => calls.toasts.push(t) },
    stage: {
      grid: new WarpGrid(width, height),
      drawPatch(p) {
        calls.patches++;
        const n = p.pos.length / 2;
        if (p.src !== p.pos || p.alpha.length !== n || [...p.indices].some((i) => i >= n) || [...p.pos].some((v) => !Number.isFinite(v))) calls.badPatch++;
      },
    },
  };
  return { app, calls };
}

/** 2D 캔버스 흉내: 모든 메서드는 아무것도 안 하고, 숫자 인자가 정상인지만 본다 */
function mockCtx() {
  let bad = 0;
  const fn = (...args) => {
    for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) bad++;
    return { addColorStop: () => {} };
  };
  const ctx = new Proxy({}, { get: (t, k) => (k === 'bad' ? bad : k in t ? t[k] : fn), set: (t, k, v) => ((t[k] = v), true) });
  return ctx;
}

test('놀이 전체: 여러 아이 손이 마구 움직이고 사라지고 창 크기가 바뀌어도 오류 없이, 빠르게', async (tc) => {
  globalThis.Path2D ??= class {
    moveTo() {}
    lineTo() {}
  };
  const { default: warp } = await import('../src/modes/warp.js');
  const { app, calls } = mockApp(1280, 720);
  const mode = warp.create(app);
  mode.enter();
  const tr = new HandTracker();
  const ctx = mockCtx();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const kids = [
    { x: 400, y: 400, pose: 'open', vis: true, angle: 0 },
    { x: 850, y: 380, pose: 'open', vis: true, angle: 0 },
    { x: 640, y: 250, pose: 'open', vis: false, angle: 0 },
  ];
  const poses = ['fist', 'fist', 'fist', 'open', 'pinch', 'other', 'v'];
  let t = 0;
  let maxSeen = 0;
  let work = 0;
  const frames = 900;
  for (let f = 0; f < frames; f++) {
    const dt = f % 97 === 0 ? 0.05 : 1 / 60;
    t += dt;
    for (const k of kids) {
      if (rnd() < 0.02) k.pose = poses[Math.floor(rnd() * poses.length)];
      if (rnd() < 0.01) k.vis = !k.vis;
      k.x = Math.min(app.width + 50, Math.max(-50, k.x + (rnd() - 0.5) * 40));
      k.y = Math.min(app.height + 50, Math.max(-50, k.y + (rnd() - 0.5) * 30));
      k.angle += (rnd() - 0.5) * 0.15;
    }
    if (f === 450) {
      app.width = 900;
      app.height = 1000;
      app.stage.grid = new WarpGrid(900, 1000);
      mode.resize(900, 1000);
    }
    const dets = kids.filter((k) => k.vis && rnd() > 0.05).map((k) => ({ lm: synthHand({ ...k, size: 130 }), side: 'right' }));
    const hands = tr.update(dets, t);
    const frame = { t, dt, width: app.width, height: app.height, hands, faces: [], mic: { enabled: false, level: 0, blowing: false, strength: 0 } };
    const t0 = performance.now();
    mode.update(frame);
    mode.drawGL(app.stage, frame);
    mode.draw(ctx, frame);
    work += performance.now() - t0;
    for (const h of hands) h.started = h.ended = null;
    for (const v of app.stage.grid.offset) {
      assert.ok(Number.isFinite(v));
      maxSeen = Math.max(maxSeen, Math.abs(v));
    }
    const s = mode.state();
    JSON.stringify(s);
  }
  const s = mode.state();
  assert.ok(s.created > 3, `잡기가 여러 번 일어남 ${s.created}`);
  assert.ok(maxSeen > 50, `화면이 실제로 늘어남 ${maxSeen}`);
  assert.ok(maxSeen < 0.6 * 1000 * 1.6, `폭주하지 않음 ${maxSeen}`);
  assert.equal(calls.badPatch, 0);
  assert.ok(calls.patches > 0);
  assert.equal(ctx.bad, 0, '그리기에 NaN 없음');
  assert.ok(calls.toasts.length <= Math.ceil((frames / 60) / 4) + 1, `칭찬이 너무 잦지 않음 ${calls.toasts.length}`);
  const perFrame = work / frames;
  tc.diagnostic(`update+drawGL+draw ${perFrame.toFixed(3)}ms/frame, 잡기 ${s.created}회, 최대 변위 ${maxSeen.toFixed(0)}px, 칭찬 ${calls.toasts.length}회`);
  assert.ok(perFrame < 4, `한 프레임 ${perFrame.toFixed(2)}ms`);
  // 나갈 때 이어지는 소리를 끈다
  mode.exit();
  if (calls.loop > 0) assert.ok(calls.stopLoop >= 1);
  assert.equal(mode.state().grabs, 0);
});

// ------------------------------------------------------------------ 접힘·유령 손 없음 (리뷰에서 찾은 문제들)

/** 손 조각 (drawGL 이 그리는 것과 같은 모양) */
function patchOf(hand, opts) {
  const b = makePatchBuffer();
  buildHandPatch(hand.lm, hand.size, b, opts);
  return b;
}

/** 손 영상(손 볼록 껍질 안의 원래 자리)이 젤리 뒤 손 조각 밖으로 얼마나 밀려 나왔나 (손 크기 배수, 0 = 유령 손 없음) */
function ghostOf(grid, hand) {
  const raw = patchOf(hand, { pad: 0, feather: 0.01 });
  const buf = patchOf(hand);
  let worst = 0;
  for (let k = 0; k < grid.count; k++) {
    const rx = grid.rest[k * 2];
    const ry = grid.rest[k * 2 + 1];
    if (!insidePatch(raw, rx, ry, 0)) continue;
    const x = rx + grid.offset[k * 2];
    const y = ry + grid.offset[k * 2 + 1];
    if (insidePatch(buf, x, y, 0)) continue;
    let lo = 0;
    let hi = 3 * hand.size;
    for (let it = 0; it < 18; it++) {
      const m = (lo + hi) / 2;
      if (insidePatch(buf, x, y, m)) hi = m;
      else lo = m;
    }
    worst = Math.max(worst, hi / hand.size);
  }
  return worst;
}

/** 놀이(drawGL)와 똑같이: 잡은 손 → grabField, 잡지 않은 손 → buildMasks, 젤리를 끝까지 흔든 뒤의 모습 */
function steady(grabs, others = [], { twist = 0, frames = 240 } = {}) {
  const grid = new WarpGrid(W, H);
  const j = new Jelly();
  j.bind(grid);
  const cell = Math.max(grid.cellW, grid.cellH);
  const fields = grabs.map(({ p0, hand, kind = 'fist' }) => {
    const pos = kind === 'pinch' ? hand.pinchPoint : hand.palm;
    return grabField({ kind, p0, pos, size0: hand.size, size: hand.size, sigma: grabSigma(kind, hand.size, W, H), twist }, {}, 0.6 * H, cell);
  });
  const masks = [];
  const pool = [];
  for (let i = 0; i < frames; i++) {
    j.setFields(fields, H, buildMasks(others, () => false, masks, pool));
    j.step(1 / 60);
  }
  const all = [...grabs.map((g) => g.hand), ...others];
  return { grid, j, masks, flip: visibleFlipArea(grid, all.map((h) => patchOf(h))) };
}

test('주먹으로 어느 쪽으로 얼마나 당겨도: 손 밖에서 화면이 접히지 않고, 영상 속 주먹이 손 조각 밖으로 밀려 나오지 않는다', () => {
  for (const D of [80, 150, 300, 450]) {
    for (let d = 0; d < 8; d++) {
      const ang = (d * Math.PI) / 4;
      const p0 = { x: 640 - (D / 2) * Math.cos(ang), y: 360 - (D / 2) * Math.sin(ang) };
      // (합성 손의 x, y 는 손바닥 가운데) 손 방향도 여러 가지로
      const hand = fakeHand({ x: p0.x + D * Math.cos(ang), y: p0.y + D * Math.sin(ang), angle: d * 0.7 });
      const r = steady([{ p0, hand }]);
      assert.ok(r.flip < 40, `D ${D} dir ${d}: 접힌 넓이 ${r.flip.toFixed(0)}px²`);
      const g = ghostOf(r.grid, hand);
      assert.ok(g < 0.2, `D ${D} dir ${d}: 유령 손 ${g.toFixed(2)}`);
    }
  }
});

test('리뷰 장면 그대로 (e2e 크기·위치): 당기기, 비틀며 당기기, 두 손으로 늘리기, 다른 아이의 펼친 손 → 손 밖 접힘 없음', () => {
  const cases = [
    ['e2e 당기기 318px', [{ p0: { x: 640, y: 430 }, hand: fakeHand({ x: 930, y: 300 }) }], []],
    ['e2e 두 손', [{ p0: { x: 480, y: 400 }, hand: fakeHand({ id: 1, x: 288, y: 400 }) }, { p0: { x: 800, y: 400 }, hand: fakeHand({ id: 2, x: 992, y: 400 }) }], []],
    ['두 손 모으기', [{ p0: { x: 380, y: 380 }, hand: fakeHand({ id: 1, x: 560, y: 380 }) }, { p0: { x: 900, y: 380 }, hand: fakeHand({ id: 2, x: 720, y: 380 }) }], []],
    ['엇갈려 당기기', [{ p0: { x: 450, y: 300 }, hand: fakeHand({ id: 1, x: 750, y: 450 }) }, { p0: { x: 800, y: 300 }, hand: fakeHand({ id: 2, x: 520, y: 470 }) }], []],
    ['펼친 손이 뒤에', [{ p0: { x: 560, y: 380 }, hand: fakeHand({ x: 860, y: 380 }) }], [fakeHand({ id: 5, x: 380, y: 380, pose: 'open' })]],
    ['펼친 손이 앞에', [{ p0: { x: 560, y: 380 }, hand: fakeHand({ x: 860, y: 380 }) }], [fakeHand({ id: 5, x: 1100, y: 380, pose: 'open' })]],
    ['검지 편 손이 옆에', [{ p0: { x: 560, y: 380 }, hand: fakeHand({ x: 860, y: 380 }) }], [fakeHand({ id: 5, x: 860, y: 160, pose: 'point' })]],
  ];
  for (const [name, grabs, others] of cases) {
    for (const twist of [0, 1.3]) {
      const r = steady(grabs, others, { twist });
      assert.ok(r.flip < 150, `${name} (비틀기 ${twist}): 접힌 넓이 ${r.flip.toFixed(0)}px²`);
      for (const g of grabs) assert.ok(ghostOf(r.grid, g.hand) < 0.2, `${name}: 잡은 손 유령`);
    }
  }
});

test('꼬집기: 어느 쪽으로 당겨도 손 밖에서 접히지 않는다', () => {
  for (const D of [100, 250]) {
    for (let d = 0; d < 8; d++) {
      const ang = (d * Math.PI) / 4;
      const probe = fakeHand({ x: 0, y: 0, pose: 'pinch' });
      const tx = 640 + (D / 2) * Math.cos(ang);
      const ty = 360 + (D / 2) * Math.sin(ang);
      const hand = fakeHand({ x: tx - probe.pinchPoint.x, y: ty - probe.pinchPoint.y, pose: 'pinch' });
      const r = steady([{ p0: { x: tx - D * Math.cos(ang), y: ty - D * Math.sin(ang) }, hand, kind: 'pinch' }]);
      assert.ok(r.flip < 150, `pinch D ${D} dir ${d}: ${r.flip.toFixed(0)}px²`);
    }
  }
});

test('화면 가장자리에서 잡아 안쪽으로 당겨도 화면 밖 여백(줄무늬)이 끌려 들어오지 않고, 화면 전체가 미끄러지지 않는다', () => {
  // 오른쪽 끝 근처(1200)에서 잡아 왼쪽으로 420px (리뷰 장면)
  const hand = fakeHand({ x: 780, y: 360 });
  const p0 = { x: hand.palm.x + 420, y: hand.palm.y };
  const r = steady([{ p0, hand }]);
  const B = borderOf(r.grid);
  let inward = 0;
  for (const k of B.list) {
    if (B.fxn[k] === 0) inward = Math.max(inward, -r.grid.offset[k * 2]);
    if (B.fxp[k] === 0) inward = Math.max(inward, r.grid.offset[k * 2]);
    if (B.fyp[k] === 0) inward = Math.max(inward, r.grid.offset[k * 2 + 1]);
    if (B.fyn[k] === 0) inward = Math.max(inward, -r.grid.offset[k * 2 + 1]);
  }
  assert.ok(inward < 0.5, `테두리가 안쪽으로 ${inward.toFixed(1)}px 끌려옴`);
  assert.ok(r.flip < 40, `접힘 ${r.flip}`);
  // 멀리 떨어진 왼쪽 화면은 그대로 (화면 전체가 미끄러지지 않음)
  for (const x of [50, 200]) {
    const k = nearest(r.grid, x, 360);
    assert.ok(Math.hypot(r.grid.offset[k * 2], r.grid.offset[k * 2 + 1]) < 5, `x=${x} 가 밀림`);
  }
  // 아주 길게(576px) 당겨도 잡은 점 뒤쪽 멀리(3σ 너머)는 그대로
  const far = fakeHand({ x: 1176 - 30, y: 330 });
  const r2 = steady([{ p0: { x: 600, y: 330 }, hand: far }]);
  const k2 = nearest(r2.grid, 600 - 3 * grabSigma('fist', far.size, W, H), 330);
  assert.ok(Math.hypot(r2.grid.offset[k2 * 2], r2.grid.offset[k2 * 2 + 1]) < 25, '잡은 점 뒤쪽 멀리는 거의 그대로');
  assert.ok(r2.j.maxOffset <= 0.6 * H + 5, `잡은 점 이동은 cap 까지 ${r2.j.maxOffset}`);
  // 젤리가 출렁여도 테두리는 안쪽으로 넘어오지 않는다
  for (let i = 0; i < 60; i++) {
    r.j.setFields([], H, null);
    r.j.step(1 / 60);
    for (const k of B.list) if (B.fxn[k] === 0) assert.ok(r.grid.offset[k * 2] >= 0);
  }
});

test('비틀기 측정: 손등을 카메라 쪽으로 내밀어 손목→중지 뿌리가 짧아져 떨려도 소용돌이가 쌓이지 않는다', () => {
  const base = fakeHand({ angle: 0 });
  // 원근으로 손목→중지 뿌리가 손 크기의 15% 로 짧아진 손: 중지 뿌리가 손목 둘레를 마구 떨린다
  const foreshortened = (jit) => {
    const lm = base.lm.map((p) => ({ ...p }));
    lm[9] = { x: lm[0].x + 0.15 * base.size * Math.cos(jit), y: lm[0].y + 0.15 * base.size * Math.sin(jit), z: 0 };
    return { ...base, lm };
  };
  let prev = handAngles(foreshortened(0), {});
  let total = 0;
  for (let i = 1; i < 120; i++) {
    const cur = handAngles(foreshortened(Math.sin(i * 1.7) * 1.2), {});
    total += twistDelta(prev, cur);
    prev = cur;
  }
  assert.ok(Math.abs(total) < 0.05, `떨림이 쌓임 ${total}`);
  // 진짜로 손을 돌리면 (손가락 뿌리 줄도 같이 돈다) 그대로 잰다
  prev = handAngles(fakeHand({ angle: 0 }), {});
  total = 0;
  for (let i = 1; i <= 10; i++) {
    const cur = handAngles(fakeHand({ angle: i * 0.1 }), {});
    total += twistDelta(prev, cur);
    prev = cur;
  }
  assert.ok(Math.abs(total - 1) < 0.05, `돌린 만큼 ${total}`);
});

test('이미 오래 보이던 다른 손은 잠깐 놓친 손의 잡기를 가로채지 않는다 (두 손 늘리기 중)', () => {
  const gr = new Grabber();
  // 손 1: 500 에서 잡아 350 까지 당김. 손 2: 800 에서 오래 보이던 펼친 손
  run(gr, [[fakeHand({ id: 1, x: 500 }), fakeHand({ id: 2, x: 800, pose: 'open' })]]);
  run(gr, repeat(5, (i) => [fakeHand({ id: 1, x: 500 - (i + 1) * 30 }), fakeHand({ id: 2, x: 800, pose: 'open' })]));
  const g1 = gr.byHand.get(1);
  // 손 1 이 한 프레임 stale, 같은 프레임에 손 2 가 주먹을 쥔다 (300px 떨어져 있음)
  const ev = run(gr, [[fakeHand({ id: 1, x: 350, stale: true, pose: 'other' }), fakeHand({ id: 2, x: 650, pose: 'fist', age: 2 })]]);
  assert.deepEqual(ev.map((e) => e.type), ['grab'], '손 2 는 자기 잡기를 새로 만든다');
  assert.equal(gr.byHand.get(1), g1, '손 1 의 잡기는 그대로');
  assert.ok(Math.abs(g1.pos.x - 350) < 2);
  // 방금 새로 생긴 추적(다시 인식된 손)은 이어받는다
  run(gr, repeat(4, () => [fakeHand({ id: 2, x: 650, pose: 'fist', age: 2 })]));
  const ev2 = run(gr, [[fakeHand({ id: 7, x: 360, age: 0.05 }), fakeHand({ id: 2, x: 650, pose: 'fist', age: 2 })]]);
  assert.deepEqual(ev2.map((e) => e.type), ['adopt']);
  assert.equal(gr.byHand.get(7), g1);
});

test('손을 놓친 잡기는 마지막으로 본 손 모습을 기억한다 (손 조각을 계속 그릴 수 있게)', () => {
  const gr = new Grabber();
  run(gr, [[fakeHand({ id: 1, x: 500 })]]);
  run(gr, repeat(4, (i) => [fakeHand({ id: 1, x: 500 + (i + 1) * 40 })]));
  const g = gr.list[0];
  const last = fakeHand({ id: 1, x: 660 });
  run(gr, repeat(8, () => []));
  assert.equal(gr.count, 1);
  assert.ok(g.orphan > 0);
  for (let i = 0; i < 21; i++) assert.ok(Math.hypot(g.lm[i].x - last.lm[i].x, g.lm[i].y - last.lm[i].y) < 1e-6);
});

// ------------------------------------------------------------------ 놀이 (안내·칭찬)

function frameOf(t, dt, app, hands) {
  return { t, dt, width: app.width, height: app.height, hands, faces: [], mic: { enabled: false, level: 0, blowing: false, strength: 0 } };
}

test('놀이: 손을 놓친 잡기도 손 조각을 마지막 모습으로 그리고, 점점 흐려진다', async () => {
  globalThis.Path2D ??= class {
    moveTo() {}
    lineTo() {}
  };
  const { default: warp } = await import('../src/modes/warp.js');
  const { app } = mockApp(1280, 720);
  const opacities = [];
  const draw = app.stage.drawPatch.bind(app.stage);
  app.stage.drawPatch = (p) => {
    opacities.push(p.opacity ?? 1);
    draw(p);
  };
  const mode = warp.create(app);
  mode.enter();
  const tr = new HandTracker();
  let t = 0;
  const step = (dets) => {
    t += 1 / 60;
    const hands = tr.update(dets, t);
    const f = frameOf(t, 1 / 60, app, hands);
    mode.update(f);
    mode.drawGL(app.stage, f);
    for (const h of hands) h.started = h.ended = null;
  };
  for (let i = 0; i < 10; i++) step([{ lm: synthHand({ x: 600, y: 400, size: 130, pose: 'fist' }), side: 'right' }]);
  for (let i = 0; i < 20; i++) step([{ lm: synthHand({ x: 600 + i * 12, y: 400, size: 130, pose: 'fist' }), side: 'right' }]);
  // 손이 사라짐 (추적이 끊긴 뒤에도 잠깐 잡고 있다)
  opacities.length = 0;
  for (let i = 0; i < 24; i++) step([]);
  assert.equal(mode.state().orphans, 1);
  assert.ok(opacities.length > 0, '놓친 손도 조각을 그린다');
  assert.ok(opacities.some((o) => o < 1), '점점 흐려진다');
  mode.exit();
});

test('놀이: 손이 한참 안 보이면 다음 아이를 위해 안내를 처음부터, 큰 칭찬은 손이 가운데 있으면 띄우지 않는다', async () => {
  globalThis.Path2D ??= class {
    moveTo() {}
    lineTo() {}
  };
  const { default: warp, inToastBox, praiseSpot } = await import('../src/modes/warp.js');
  const { app, calls } = mockApp(1280, 720);
  const mode = warp.create(app);
  mode.enter();
  const tr = new HandTracker();
  let t = 0;
  const step = (dets, dt = 1 / 60) => {
    t += dt;
    const hands = tr.update(dets, t);
    const f = frameOf(t, dt, app, hands);
    mode.update(f);
    mode.drawGL(app.stage, f);
    for (const h of hands) h.started = h.ended = null;
  };
  const fist = (x, y, angle = 0) => [{ lm: synthHand({ x, y, size: 130, pose: 'fist', angle }), side: 'right' }];
  // 첫 아이: 가운데서 잡고 당기고 비틀고 놓기
  for (let i = 0; i < 10; i++) step(fist(640, 360));
  for (let i = 0; i < 30; i++) step(fist(640 + i * 8, 360 - i * 2));
  for (let i = 0; i < 40; i++) step(fist(880, 300, Math.min(1.3, i * 0.05)));
  for (let i = 0; i < 10; i++) step([{ lm: synthHand({ x: 880, y: 300, size: 130, pose: 'open' }), side: 'right' }]);
  let s = mode.state();
  assert.ok(s.coach.pulled && s.coach.twisted && s.coach.released, JSON.stringify(s.coach));
  assert.equal(calls.toasts.length, 0, '당기기·비틀기 칭찬은 손 옆 글자로 (가운데 큰 글씨 아님)');
  // 아무도 없이 10초
  for (let i = 0; i < 200; i++) step([], 0.05);
  s = mode.state();
  assert.equal(s.coachResets, 1);
  assert.deepEqual(Object.values(s.coach), [false, false, false, false, false]);
  // 다음 아이가 잡으면 다시 '당겨 보세요'
  for (let i = 0; i < 10; i++) step(fist(500, 400));
  assert.ok(mode.state().hint.includes('당겨'), mode.state().hint);
  mode.exit();
  // 도우미
  assert.equal(inToastBox(640, 300, 1280, 720), true);
  assert.equal(inToastBox(100, 600, 1280, 720), false);
  const p = praiseSpot(640, 200, 100, 1280, 720, 60, 700);
  assert.ok(p.x < 640 - 100 && Math.abs(p.y - 200) < 60, `위쪽 말풍선과 겹치면 손(오른쪽)을 피해 고리 옆으로 ${JSON.stringify(p)}`);
  const edge = praiseSpot(1200, 200, 100, 1280, 720, 60);
  assert.ok(edge.x < 1200, '화면 끝이면 안쪽 옆으로');
  const above = praiseSpot(640, 500, 100, 1280, 720, 60);
  assert.ok(above.y < 500 - 100, '보통은 고리 위');
  const q = praiseSpot(5, 400, 100, 1280, 720, 60);
  assert.ok(q.x > 60, '화면 밖으로 나가지 않게');
});

