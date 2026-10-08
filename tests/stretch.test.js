// 늘어나는 손가락 놀이 단위 테스트:  node --test tests/stretch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthHand } from '../src/core/synth.js';
import { HandTracker } from '../src/core/handtracker.js';
import {
  ArcCurve,
  FingerMesh,
  CoverMesh,
  FINGER_TIP,
  FINGER_BASE,
  MESH_COLS,
  fingerAxis,
  handAngle,
  makeLengthMap,
  measureFinger,
  widthProfile,
} from '../src/modes/stretch/geometry.js';
import {
  GRIP,
  PHYS,
  SNAP_COOL,
  Rubber,
  boingPitch,
  forceClosed,
  hintLevel,
  looksHeld,
  clampCtrl,
  clampEnd,
  coverAmount,
  ctrlTarget,
  findTarget,
  followFrame,
  grabFraction,
  newFrame,
  newGrip,
  pullAmount,
  stepGrip,
  toLocal,
  toWorld,
} from '../src/modes/stretch/logic.js';
import stretchMode from '../src/modes/stretch.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≈ ${b} (±${eps})`);
const allFinite = (arr) => Array.prototype.every.call(arr, Number.isFinite);

// ---------------------------------------------------------------- 손가락 축 기억/복원

test('손 기준으로 기억한 손가락은 손이 돌고 움직여도 끝 위치를 다시 만든다', () => {
  for (const side of ['left', 'right']) {
    const lm0 = synthHand({ x: 400, y: 400, size: 150, angle: 0, pose: 'point', side });
    const size0 = 150;
    const mem = measureFinger(lm0, size0, 1);
    assert.ok(mem.lrel > 0.7 && mem.lrel < 1.2, `검지 길이 ${mem.lrel}`);
    for (const angle of [0.5, -0.9, 2.2]) {
      for (const size of [100, 220]) {
        const lm = synthHand({ x: 700, y: 300, size, angle, pose: 'point', side });
        const b = lm[FINGER_BASE[1]];
        const ax = fingerAxis(b.x, b.y, handAngle(lm), size, mem.lrel, mem.phi);
        const tip = lm[FINGER_TIP[1]];
        near(ax.tip.x, tip.x, size * 0.03, `${side} ${angle} ${size} x`);
        near(ax.tip.y, tip.y, size * 0.03, `${side} ${angle} ${size} y`);
        near(Math.hypot(ax.dir.x, ax.dir.y), 1, 1e-9, 'dir 는 단위 벡터');
      }
    }
  }
});

// ---------------------------------------------------------------- 곡선

test('ArcCurve: 길이로 따라가고, 범위 밖은 끝 방향으로 곧게 늘인다', () => {
  const c = new ArcCurve(32).set({ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 });
  near(c.total, 100, 1e-6, '직선 길이');
  const P = { x: 0, y: 0 };
  const T = { x: 0, y: 0 };
  c.at(30, P, T);
  near(P.x, 30, 0.5);
  near(T.x, 1, 1e-6);
  c.at(-10, P, T);
  near(P.x, -10, 1e-6, '시작 전');
  c.at(130, P, T);
  near(P.x, 130, 1e-6, '끝 너머');
  // 조절점이 한쪽에 몰려도 길이 기준으로는 고르게 간다
  const d = new ArcCurve(32).set({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 0 });
  d.at(50, P, T);
  near(P.x, 50, 0.6, '길이 기준 매개변수');
  // 휜 곡선은 직선보다 길다
  const e = new ArcCurve(32).set({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 });
  assert.ok(e.total > Math.hypot(100, 100));
  let prev = -1;
  for (let u = 0; u <= e.total; u += e.total / 20) {
    const t = e.paramAt(u);
    assert.ok(t >= prev, '매개변수는 늘기만 한다');
    prev = t;
  }
  // 조절점이 시작점과 같아도(접선 0) 방향이 나온다
  const f = new ArcCurve(16).set({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 }, { x: 1, y: 0 });
  f.at(0, P, T);
  assert.ok(Number.isFinite(T.x) && Math.hypot(T.x, T.y) > 0.99);
});

test('makeLengthMap: 뿌리·끝은 그대로, 가운데만 늘어나고 이어져 있다', () => {
  const len = 100;
  const m = makeLengthMap(len, len, 400);
  near(m.map(5), 5, 1e-9, '뿌리는 그대로');
  near(m.map(len), 400, 1e-9, '집은 곳 → 곡선 끝');
  near(m.map(len + 10), 410, 1e-9, '끝 너머는 그대로');
  near(m.map(len - 20) - m.map(len - 25), 5, 1e-9, '손톱 쪽은 늘어나지 않음');
  assert.ok(m.stretch > 3, '가운데가 늘어남');
  let prev = -Infinity;
  for (let s = -10; s <= 120; s += 0.5) {
    const u = m.map(s);
    assert.ok(u >= prev - 1e-9, `단조 증가 ${s}`);
    if (prev > -Infinity) assert.ok(u - prev < 0.5 * m.stretch + 1e-6, `끊김 없음 ${s}`);
    prev = u;
  }
  // 눌러서 짧아질 때는 고르게 줄어든다
  const c = makeLengthMap(len, len, 60);
  near(c.map(len), 60, 1e-9);
  near(c.map(50), 30, 1e-9);
});

test('widthProfile: 늘이면 가운데가 가늘어지고 손끝은 통통, 누르면 굵어진다', () => {
  near(widthProfile(1, 0.5), 1, 1e-9);
  near(widthProfile(1, 1), 1, 1e-9);
  assert.equal(widthProfile(4, 0), 1, '뿌리는 원래 굵기');
  const mid = widthProfile(4, 0.5);
  assert.ok(mid < 0.75 && mid >= 0.5, `가운데 ${mid}`);
  assert.ok(widthProfile(4, 1) > mid, '손끝은 가운데보다 굵다');
  assert.ok(widthProfile(20, 0.5) >= 0.5, '너무 가늘어지지 않는다');
  assert.ok(widthProfile(0.6, 0.5) > 1.1, '누르면 통통');
});

// ---------------------------------------------------------------- 그물

const base = { x: 300, y: 500 };
const dir = { x: 0, y: -1 };
const LEN = 140;
const W = 33;
const CAP = 20;

function restBuild(mesh) {
  return mesh.build({ base, dir, len: LEN, grab: LEN, width: W, cap: CAP, ctrl: { x: 300, y: 500 - LEN / 2 }, end: { x: 300, y: 500 - LEN } });
}

test('FingerMesh: 쉬고 있을 때는 영상과 정확히 겹친다 (붙였다 떼도 티가 안 남)', () => {
  const m = new FingerMesh();
  const ratio = restBuild(m);
  near(ratio, 1, 1e-3, 'ratio');
  for (let i = 0; i < m.pos.length; i++) near(m.pos[i], m.src[i], 0.05, `정점 ${i}`);
  assert.equal(m.indices.length, (m.rows - 1) * (m.cols - 1) * 6);
  assert.ok(Math.max(...m.indices) < m.rows * m.cols);
  near(m.deviation(base, dir, LEN), 0, 0.05, '어긋남 없음');
});

test('FingerMesh: 당기면 곡선을 따라 늘어나고, 가장자리는 투명, 손끝은 집은 점에', () => {
  const m = new FingerMesh();
  const end = { x: 300 + 360, y: 500 - 300 };
  const ratio = m.build({ base, dir, len: LEN, grab: LEN, width: W, cap: CAP, ctrl: { x: 300, y: 500 - 200 }, end });
  assert.ok(ratio > 3, `ratio ${ratio}`);
  assert.ok(allFinite(m.pos) && allFinite(m.src) && allFinite(m.alpha));
  for (let r = 0; r < m.rows; r++) {
    assert.equal(m.alpha[r * m.cols], 0, '왼쪽 가장자리 투명');
    assert.equal(m.alpha[r * m.cols + m.cols - 1], 0, '오른쪽 가장자리 투명');
  }
  // 손가락 끝 랜드마크(s = LEN) 는 집은 점에 온다 (앞뒤 줄 사이를 보간)
  let found = false;
  for (let r = 1; r < m.rows; r++) {
    if (m.rowS[r - 1] <= LEN && m.rowS[r] >= LEN) {
      const k = (LEN - m.rowS[r - 1]) / (m.rowS[r] - m.rowS[r - 1]);
      near(m.cx[r - 1] + (m.cx[r] - m.cx[r - 1]) * k, end.x, 1);
      near(m.cy[r - 1] + (m.cy[r] - m.cy[r - 1]) * k, end.y, 1);
      found = true;
    }
  }
  assert.ok(found, '손끝 줄이 있어야 함');
  // 가운데는 가늘고, 손끝은 그보다 굵다
  const midRow = m.nb + (m.nm >> 1);
  assert.ok(m.hw[midRow] < 0.5 * W * 0.8, `가운데 반폭 ${m.hw[midRow]}`);
  assert.ok(m.hw[m.rows - 2] > m.hw[midRow], '손끝이 더 굵다');
  // 영상은 원래 손가락 축에서 가져온다
  for (let r = 0; r < m.rows; r++) {
    const c = r * m.cols + (m.cols >> 1);
    near(m.src[c * 2], base.x, 1e-3, 'src x 는 축 위');
  }
  assert.ok(m.deviation(base, dir, LEN) > W, '옆으로 휘었다');
});

test('FingerMesh: 눌러서 짧아지면 통통해지고 뒤집히지 않는다', () => {
  const m = new FingerMesh();
  const ratio = m.build({ base, dir, len: LEN, grab: LEN, width: W, cap: CAP, ctrl: { x: 300, y: 500 - 35 }, end: { x: 300, y: 500 - 70 } });
  near(ratio, 0.5, 0.01);
  const midRow = m.nb + (m.nm >> 1);
  assert.ok(m.hw[midRow] > 0.5 * W, '통통');
  for (let r = 1; r < m.rows; r++) assert.ok(m.cy[r] <= m.cy[r - 1] + 1e-6, '줄 순서가 뒤집히지 않음');
});

test('CoverMesh: 원래 손가락 자리를 덮고, 양옆 바깥 배경을 가져와 섞는다', () => {
  const c = new CoverMesh().build({ base, dir, len: LEN, width: W, cap: CAP, size: 150 });
  const mid = (c.cols - 1) / 2;
  for (let r = 0; r < c.rows; r++) {
    const v = r * c.cols + mid;
    near(c.pos[v * 2], base.x, 1e-3, '가운데 줄은 손가락 축 위');
    const l = r * c.cols;
    // 가져오는 곳은 손가락 반폭보다 바깥
    assert.ok(Math.abs(c.srcL[l * 2] - base.x) > 0.5 * W, '왼쪽 배경');
    assert.ok(Math.abs(c.srcR[l * 2] - base.x) > 0.5 * W, '오른쪽 배경');
    assert.ok(Math.sign(c.srcL[l * 2] - base.x) !== Math.sign(c.srcR[l * 2] - base.x), '양쪽');
    assert.equal(c.alphaR[l], 0, '오른쪽 층은 왼쪽 끝에서 투명');
    near(c.alphaR[l + c.cols - 1], c.alphaL[l + c.cols - 1], 1e-6, '오른쪽 끝에서 불투명');
  }
  assert.equal(c.alphaL[0], 0, '뿌리 쪽은 서서히');
  near(c.alphaL[(c.rows - 1) * c.cols + mid], 0, 1e-6, '끝 너머도 서서히');
  // 손가락 끝 너머까지 덮는다
  const topY = c.pos[((c.rows - 1) * c.cols + mid) * 2 + 1];
  assert.ok(topY < base.y - LEN - CAP, '손끝 너머까지');
  assert.equal(MESH_COLS.length, c.cols);
});

// ---------------------------------------------------------------- 집기 상태

const hand = (pinchDist, pose = 'other', stale = false) => ({ pinchDist, pose, stale });

test('stepGrip: 바로 잡히고, 한두 프레임 흔들려도 놓지 않고, 손을 펴면 놓는다', () => {
  const g = newGrip();
  const dt = 1 / 30;
  stepGrip(g, hand(0.8), dt);
  assert.equal(g.closed, false);
  stepGrip(g, hand(0.2), dt);
  assert.equal(g.closed, true);
  assert.equal(g.justClosed, true, '닫히는 순간 표시');
  stepGrip(g, hand(0.4), dt);
  assert.equal(g.closed, true, '히스테리시스 안');
  assert.equal(g.justClosed, false);
  stepGrip(g, hand(0.9), dt);
  assert.equal(g.closed, true, '한 프레임 벌어진 건 무시');
  stepGrip(g, hand(0.2), dt);
  stepGrip(g, hand(0.9, 'other', true), 0.15);
  assert.equal(g.closed, true, '잠깐 놓친 손은 그대로');
  let opened = false;
  for (let i = 0; i < 6; i++) {
    stepGrip(g, hand(0.9, 'open'), dt);
    if (g.justOpened) opened = true;
  }
  assert.equal(g.closed, false);
  assert.ok(opened, '펴는 순간 표시');
  // 주먹으로 쥐어도 잡은 것
  const f = newGrip();
  stepGrip(f, hand(0.7, 'fist'), dt);
  assert.equal(f.closed, true);
  // 뿅! 뒤 쉬는 시간: 집은 채로 있어도 잠깐 뒤 저절로 끝난다 (손을 꼭 펴야 하는 숨은 규칙 없음)
  f.cool = SNAP_COOL;
  stepGrip(f, hand(0.2), 0.3);
  assert.ok(f.cool > 0 && f.closed, '아직 쉬는 중');
  stepGrip(f, hand(0.2, 'other', true), 0.2);
  stepGrip(f, hand(0.2), SNAP_COOL);
  assert.equal(f.cool, 0, '시간이 지나면 끝');
  // 손을 펴도 끝난다
  f.cool = SNAP_COOL;
  for (let i = 0; i < 6; i++) stepGrip(f, hand(0.9, 'open'), dt);
  assert.equal(f.cool, 0);
  assert.ok(GRIP.enter < GRIP.exit);
});

test('looksHeld / forceClosed: 새로 잡힌 손은 느슨하게 집어도 집은 손으로 이어 받는다', () => {
  assert.ok(looksHeld(hand(0.42)), '느슨한 집기(놓기 기준 안쪽)');
  assert.ok(looksHeld(hand(0.9, 'fist')), '주먹');
  assert.ok(!looksHeld(hand(0.7, 'open')), '편 손은 아님');
  const g = newGrip();
  stepGrip(g, hand(0.42), 1 / 30);
  assert.equal(g.closed, false, '새 손은 0.42 로는 닫히지 않는다');
  forceClosed(g);
  assert.equal(g.closed, true);
  assert.equal(g.justClosed, false, '새로 집은 것은 아님 (다른 손가락을 잡지 않게)');
  stepGrip(g, hand(0.42), 1 / 30);
  assert.equal(g.closed, true, '히스테리시스로 유지');
});

test('hintLevel: 경계에서 흔들려도 안내가 깜빡이지 않게 여유를 둔다', () => {
  assert.equal(hintLevel(0, 1.5, 1.5), 0);
  assert.equal(hintLevel(0, 2.35, 2.35), 0);
  assert.equal(hintLevel(0, 2.45, 2.45), 1, '길다');
  assert.equal(hintLevel(1, 2.3, 2.3), 1, '조금 줄어도 그대로');
  assert.equal(hintLevel(1, 2.0, 2.0), 0, '많이 줄면 돌아감');
  assert.equal(hintLevel(1, 4.5, 4.5), 2, '조심');
  assert.equal(hintLevel(2, 4.3, 4.3), 2, '조심 유지');
  assert.equal(hintLevel(2, 4.0, 4.0), 1, '조심 → 길다');
  let prev = 0;
  let changes = 0;
  for (let i = 0; i < 200; i++) {
    const r = 2.4 + Math.sin(i * 1.7) * 0.08;
    const lv = hintLevel(prev, r, r);
    if (lv !== prev) changes++;
    prev = lv;
  }
  assert.ok(changes <= 1, `흔들려도 한 번만 바뀜 ${changes}`);
});

// ---------------------------------------------------------------- 손가락 끝 찾기

test('findTarget: 가장 가까운 손가락 끝, 손 크기 비례 거리, 자기 손은 제외', () => {
  const cands = [
    { handId: 1, f: 1, tip: { x: 100, y: 100 }, dip: { x: 100, y: 130 }, size: 150 },
    { handId: 1, f: 2, tip: { x: 140, y: 95 }, dip: { x: 140, y: 125 }, size: 150 },
    { handId: 2, f: 1, tip: { x: 500, y: 100 }, dip: { x: 500, y: 130 }, size: 60 },
  ];
  assert.equal(findTarget({ x: 105, y: 102 }, cands, 0.5).target.f, 1);
  assert.equal(findTarget({ x: 136, y: 98 }, cands, 0.5).target.f, 2);
  // 끝 마디 중간을 집어도 잡힌다
  assert.equal(findTarget({ x: 102, y: 120 }, cands, 0.5).target.f, 1);
  // 손 끝 너머 살까지도
  assert.ok(findTarget({ x: 100, y: 85 }, cands, 0.5));
  // 작은 손은 허용 거리도 작다
  assert.equal(findTarget({ x: 545, y: 100 }, cands, 0.5), null);
  assert.ok(findTarget({ x: 520, y: 100 }, cands, 0.5));
  assert.equal(findTarget({ x: 100, y: 100 }, cands, 0.5, 1)?.target.handId ?? null, null, '자기 손 제외');
  assert.equal(findTarget({ x: 300, y: 300 }, cands, 0.5), null);
});

test('grabFraction: 집은 곳을 손가락 축에 비춰 0.6..1 로', () => {
  near(grabFraction({ x: 0, y: -100 }, { x: 0, y: 0 }, { x: 0, y: -1 }, 100), 1, 1e-9);
  near(grabFraction({ x: 5, y: -80 }, { x: 0, y: 0 }, { x: 0, y: -1 }, 100), 0.8, 1e-9);
  near(grabFraction({ x: 0, y: -10 }, { x: 0, y: 0 }, { x: 0, y: -1 }, 100), 0.6, 1e-9);
  near(grabFraction({ x: 0, y: -160 }, { x: 0, y: 0 }, { x: 0, y: -1 }, 100), 1, 1e-9);
});

// ---------------------------------------------------------------- 손 기준 좌표

test('followFrame: 부드럽게 따라가고, 한 프레임 튀는 값은 무시한다', () => {
  const fr = newFrame();
  followFrame(fr, { x: 100, y: 100 }, 0, 150, 0);
  assert.equal(fr.bx, 100);
  followFrame(fr, { x: 110, y: 100 }, 0.05, 150, 1 / 30);
  assert.ok(fr.bx > 105 && fr.bx < 110, `따라감 ${fr.bx}`);
  const before = fr.bx;
  followFrame(fr, { x: 400, y: 100 }, 0, 150, 1 / 30);
  assert.equal(fr.bx, before, '튄 값 무시');
  followFrame(fr, { x: 110, y: 100 }, 0, 150, 1 / 30);
  assert.ok(fr.bx > before, '돌아오면 다시 따라감');
  // 정말로 옮겨 간 거라면 몇 프레임 뒤엔 따라간다
  for (let i = 0; i < 5; i++) followFrame(fr, { x: 400, y: 100 }, 0, 150, 1 / 30);
  assert.ok(fr.bx > 200, `결국 따라감 ${fr.bx}`);
});

test('toLocal ↔ toWorld 는 서로 되돌린다', () => {
  const fr = { bx: 320, by: 240, theta: 0.7, size: 130 };
  const p = { x: 500, y: 100 };
  const l = toLocal(fr, -0.3, p, { x: 0, y: 0 });
  const w = toWorld(fr, -0.3, l, { x: 0, y: 0 });
  near(w.x, p.x, 1e-9);
  near(w.y, p.y, 1e-9);
  // 손가락 방향 위의 점은 y=0
  const a = fr.theta - 0.3;
  const q = toLocal(fr, -0.3, { x: 320 + Math.cos(a) * 260, y: 240 + Math.sin(a) * 260 }, { x: 0, y: 0 });
  near(q.x, 2, 1e-9);
  near(q.y, 0, 1e-9);
});

// ---------------------------------------------------------------- 고무 물리

function pullAndRelease(tx, ty) {
  const r = new Rubber(1, 0, 1);
  for (let i = 0; i < 60; i++) r.hold(tx, ty, 1 / 60);
  r.release();
  let t = 0;
  let minR = Infinity;
  let minX = Infinity;
  let crossed = false;
  let done = false;
  while (!done && t < 5) {
    done = r.step(1 / 60);
    t += 1 / 60;
    minR = Math.min(minR, Math.hypot(r.end.x, r.end.y));
    minX = Math.min(minX, r.end.x);
    if (Math.sign(r.end.y) !== Math.sign(ty) && Math.abs(r.end.y) > 0.05) crossed = true;
  }
  return { r, t, minR, minX, crossed, done };
}

test('Rubber: 잡으면 끝이 집은 점을 따라간다', () => {
  const r = new Rubber(1, 0, 1);
  for (let i = 0; i < 30; i++) r.hold(3, 1, 1 / 60);
  near(r.end.x, 3, 1e-3);
  near(r.end.y, 1, 1e-3);
  // 뿌리 쪽으로 밀어도 최소 길이는 남는다
  for (let i = 0; i < 30; i++) r.hold(0.05, 0, 1 / 60);
  near(Math.hypot(r.end.x, r.end.y), PHYS.minR, 1e-6);
});

test('Rubber: 놓으면 출렁이며(띠요옹) 돌아와 멈춘다', () => {
  const straight = pullAndRelease(5, 0);
  assert.ok(straight.done, '멈춘다');
  assert.ok(straight.t > 0.5 && straight.t < PHYS.maxRelease, `걸린 시간 ${straight.t}`);
  assert.ok(straight.minX < 0.9, `원래 자리를 지나쳐 출렁인다 ${straight.minX}`);
  assert.ok(straight.minR >= PHYS.minR - 1e-6, '뿌리를 뚫고 지나가지 않는다');
  near(straight.r.end.x, 1, 0.02);
  const side = pullAndRelease(1, 3);
  assert.ok(side.done);
  assert.ok(side.crossed, '옆으로 당겼다 놓으면 반대쪽까지 휙 넘어갔다 온다');
});

test('ctrlTarget / clampCtrl: 곡선이 접히지 않게 조절점을 둔다', () => {
  const c = ctrlTarget(4, 0, { x: 0, y: 0 });
  near(c.x, 2, 1e-9, '곧게 당기면 가운데');
  near(c.y, 0, 1e-9);
  const back = ctrlTarget(-3, 0, { x: 0, y: 0 });
  assert.ok(back.x < 0.6, '뒤로 당기면 조절점이 뿌리 가까이');
  const p = { x: 10, y: 0 };
  clampCtrl(p, 4, 0, 1);
  assert.ok(p.x <= 0.8 * 4 + 1e-9, '끝을 지나치지 않음');
  const q = { x: 0, y: 50 };
  clampCtrl(q, 4, 0, 1);
  assert.ok(Math.abs(q.y) <= 0.8 * 4 + 0.5 + 1e-9, '옆으로 너무 멀리 가지 않음');
  const e = { x: 0.1, y: 0 };
  const v = { x: -3, y: 0 };
  assert.equal(clampEnd(e, v, 0.45), true);
  near(e.x, 0.45, 1e-9);
  assert.ok(v.x > 0, '안쪽 속도는 튕겨 나간다');
});

test('pullAmount / coverAmount / boingPitch', () => {
  near(pullAmount(3, { x: 3, y: 0 }, 1), 3, 1e-9);
  near(pullAmount(9, { x: 3, y: 0 }, 1), 3.45, 1e-9, '출렁여서 길어진 곡선만으로는 뿅! 하지 않음');
  near(coverAmount(0, 30, 1), 0, 1e-9, '쉬고 있을 땐 덮지 않음');
  near(coverAmount(40, 30, 1.2), 1, 1e-9, '옆으로 휘면 덮음');
  near(coverAmount(0, 30, 2.5), 1, 1e-9, '길게 늘이면 덮음');
  near(coverAmount(0, 30, 0.6), 1, 1e-9, '짧게 누르면 덮음');
  assert.ok(boingPitch(1) > boingPitch(5), '길게 늘였을수록 낮은 띠용');
});

// ---------------------------------------------------------------- 놀이 전체 흐름 (가짜 손 + 실제 손 추적기)

function fakeApp() {
  const log = { hints: [], toasts: [], sounds: [], loops: new Set() };
  const sound = new Proxy(
    {},
    {
      get: (_, k) => {
        if (k === 'loop') return (id) => log.loops.add(id);
        if (k === 'stopLoop') return (id) => log.loops.delete(id);
        return (...a) => log.sounds.push([k, ...a]);
      },
    },
  );
  return {
    log,
    width: 1280,
    height: 720,
    sound,
    ui: { hint: (t) => log.hints.push(t), toast: (t) => log.toasts.push(t) },
  };
}

/** 어떤 메서드든 받아 주는 가짜 2D 캔버스 */
function fakeCtx() {
  const gradient = () => ({ addColorStop() {} });
  const target = {
    measureText: (s) => ({ width: String(s).length * 10 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
  };
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
}

function makeRunner() {
  const app = fakeApp();
  const mode = stretchMode.create(app);
  const tracker = new HandTracker();
  const patches = [];
  const stage = { drawPatch: (p) => patches.push(p) };
  const ctx = fakeCtx();
  let t = 0;
  mode.enter();
  return {
    app,
    mode,
    patches,
    step(hands, dt = 1 / 30) {
      t += dt;
      const det = hands.map((h) => {
        const lm = synthHand(h);
        if (h.mutate) h.mutate(lm);
        return { lm, side: h.side };
      });
      const tracked = tracker.update(det, t);
      const frame = { t, dt, width: 1280, height: 720, hands: tracked, faces: [], mic: { enabled: false, level: 0, blowing: false, strength: 0 } };
      mode.update(frame);
      patches.length = 0;
      mode.drawGL(stage, frame);
      mode.draw(ctx, frame);
      for (const h of tracked) {
        h.started = null;
        h.ended = null;
      }
      return tracked;
    },
    run(hands, seconds, dt = 1 / 30) {
      let out;
      for (let i = 0; i < Math.round(seconds / dt); i++) out = this.step(typeof hands === 'function' ? hands(i) : hands, dt);
      return out;
    },
  };
}

const A0 = { x: 400, y: 520, size: 150, angle: 0, pose: 'point', side: 'left' };
const B0 = { size: 150, angle: -Math.PI / 2, side: 'right' };
/** B 가 다가오면 A 의 검지 끝·끝마디가 손바닥 쪽으로 말린 것처럼 잘못 인식된다 (가려짐 흉내) */
const occludedA = {
  ...A0,
  mutate(lm) {
    for (const i of [7, 8]) {
      lm[i].x = lm[6].x + (lm[0].x - lm[6].x) * 0.35;
      lm[i].y = lm[6].y + (lm[0].y - lm[6].y) * 0.35;
    }
  },
};
function bPinchingAt(p, pose = 'pinch', b = B0) {
  const lm = synthHand({ ...b, x: 0, y: 0, pose: 'pinch' });
  return { ...b, x: p.x - (lm[4].x + lm[8].x) / 2, y: p.y - (lm[4].y + lm[8].y) / 2, pose };
}

test('놀이 흐름: 다가가 집기 → 당기기 → 놓으면 띠용 → 사라짐 (패치 값은 모두 유한)', () => {
  const R = makeRunner();
  let hands = R.run([A0], 0.6);
  let s = R.mode.state();
  assert.equal(s.hands, 1);
  assert.ok(s.targets >= 1, '과녁');
  assert.match(s.hint, /다른 손으로/);
  const tip = hands[0].lm[8];
  const nearB = bPinchingAt(tip, 'other');
  R.run([A0, { ...nearB, x: nearB.x + 300 }], 0.3);
  R.run((i) => [A0, { ...nearB, x: nearB.x + 300 - i * 30 }], 0.34);
  s = R.mode.state();
  assert.ok(s.aim, '가까우면 꼬옥 집어요');
  R.run([A0, { ...nearB, pose: 'pinch' }], 0.2);
  s = R.mode.state();
  assert.equal(s.stretches.length, 1);
  assert.equal(s.stretches[0].phase, 'held');
  assert.ok(R.app.log.sounds.some(([k]) => k === 'squeak'), '잡을 때 소리');
  // 당기기
  const steps = 20;
  const pinched = { ...nearB, pose: 'pinch' };
  R.run((i) => [A0, { ...pinched, x: pinched.x + ((i + 1) * 380) / steps, y: pinched.y - ((i + 1) * 60) / steps }], steps / 30);
  R.run([A0, { ...pinched, x: pinched.x + 380, y: pinched.y - 60 }], 0.3);
  s = R.mode.state();
  assert.ok(s.stretches[0].ratio > 2.5, `ratio ${s.stretches[0].ratio}`);
  assert.ok(s.stretches[0].cover > 0.5);
  assert.ok(R.app.log.loops.size > 0, '늘이는 동안 고무 소리');
  assert.equal(R.patches.length, 3, '덮기 2장 + 손가락 1장');
  for (const p of R.patches) {
    assert.ok(allFinite(p.pos) && allFinite(p.src) && allFinite(p.alpha), '패치 값이 유한');
    assert.ok(Math.max(...p.indices) < p.pos.length / 2);
  }
  // 놓기
  const bId = s.stretches[0].handB;
  R.run([A0, { ...pinched, x: pinched.x + 380, y: pinched.y - 60, pose: 'open' }], 0.3);
  s = R.mode.state();
  assert.equal(s.stretches[0]?.phase, 'release');
  assert.equal(s.ghost, null, '띠요옹 하는 동안 따라 하기 안내는 쉰다');
  assert.ok(!s.targetKeys.some((k) => k.startsWith(`${bId}:`)), `방금 놓은 손(편 손)에는 과녁을 띄우지 않음 ${JSON.stringify(s.targetKeys)}`);
  assert.equal(R.app.log.loops.size, 0, '놓으면 고무 소리 끔');
  assert.ok(R.app.log.sounds.some(([k]) => k === 'boing'), '띠용 소리');
  R.run([A0, { ...pinched, x: pinched.x + 380, y: pinched.y - 60, pose: 'open' }], 2.5);
  s = R.mode.state();
  assert.equal(s.stretches.length, 0, '다 돌아가면 사라짐');
  assert.equal(R.patches.length, 0);
});

test('놀이 흐름: 집던 손을 잠깐 놓쳐도 이어지고, 오래 놓치면 놓는다', () => {
  const R = makeRunner();
  const hands = R.run([A0], 0.5);
  const tip = hands[0].lm[8];
  const p = bPinchingAt({ x: tip.x + 2, y: tip.y }, 'pinch');
  // 집은 채로 손가락 끝에 갖다 대면 잡힌다
  R.run([A0, { ...p, x: p.x + 200 }], 0.3);
  R.run((i) => [A0, { ...p, x: p.x + 200 - i * 20 }], 11 / 30);
  let s = R.mode.state();
  assert.equal(s.stretches.length, 1, `갖다 대면 잡힘 ${JSON.stringify(s)}`);
  const far = { ...p, x: p.x + 300, y: p.y - 50 };
  R.run((i) => [A0, { ...p, x: p.x + i * 15, y: p.y - i * 2.5 }], 20 / 30);
  R.run([A0, far], 0.2);
  // 0.1초 사라짐 → 그대로
  R.run([A0], 0.1);
  R.run([A0, far], 0.2);
  s = R.mode.state();
  assert.equal(s.stretches[0]?.phase, 'held', `잠깐 놓친 건 괜찮음 ${JSON.stringify(s)}`);
  // 1초 사라짐 → 놓는다
  R.run([A0], 1);
  s = R.mode.state();
  assert.ok(!s.stretches.some((x) => x.phase === 'held'), '오래 놓치면 놓기');
});

test('놀이 흐름: 너무 늘이면 뿅! → 바로 다시 잡히지 않고, 잠깐 뒤엔 집은 채로 갖다 대도 다시 잡힌다', () => {
  const R = makeRunner();
  const As = { x: 230, y: 560, size: 100, angle: 0.35, pose: 'point', side: 'left' };
  const Bs = { size: 110, angle: -Math.PI / 2, side: 'right' };
  const hands = R.run([As], 0.5);
  const tip = hands[0].lm[8];
  const b = hands[0].lm[5];
  const len = Math.hypot(tip.x - b.x, tip.y - b.y);
  const touch = bPinchingAt(tip, 'pinch', Bs);
  R.run([As, { ...touch, pose: 'other' }], 0.2);
  R.run([As, touch], 0.2);
  assert.equal(R.mode.state().stretches[0]?.phase, 'held');
  const ux = Math.cos(-0.42);
  const uy = Math.sin(-0.42);
  const to = bPinchingAt({ x: b.x + ux * len * 7.5, y: b.y + uy * len * 7.5 }, 'pinch', Bs);
  let cur = touch;
  for (let i = 1; i <= 30 && R.mode.state().snaps === 0; i++) {
    cur = { ...touch, x: touch.x + ((to.x - touch.x) * i) / 30, y: touch.y + ((to.y - touch.y) * i) / 30 };
    R.step([As, cur]);
  }
  let s = R.mode.state();
  assert.equal(s.snaps, 1, `뿅! ${JSON.stringify(s)}`);
  assert.ok(R.app.log.toasts.length >= 1, '뿅! 알림');
  // 뿅! 한 자리에서 집은 채로 있어도 곧바로 다시 잡혀 또 뿅! 하지 않는다
  R.run([As, cur], 0.2);
  s = R.mode.state();
  assert.ok(!s.stretches.some((x) => x.phase === 'held'), `곧바로 다시 잡히지 않음 ${JSON.stringify(s)}`);
  assert.equal(s.grabs, 1);
  // 쉬는 동안 손가락 끝에 와도 '꼬옥 집어요' 라고 하지 않는다 (안 잡히니까)
  R.run((i) => [As, { ...cur, x: cur.x + ((touch.x - cur.x) * (i + 1)) / 6, y: cur.y + ((touch.y - cur.y) * (i + 1)) / 6 }], 6 / 30);
  s = R.mode.state();
  assert.ok(!s.stretches.some((x) => x.phase === 'held'), `쉬는 중 ${JSON.stringify(s)}`);
  assert.equal(s.aim, false, '쉬는 손은 겨냥 안내를 띄우지 않음');
  assert.doesNotMatch(s.hint ?? '', /꼬옥/);
  // 손을 펴지 않고 집은 채로 기다리면 잠깐 뒤 다시 잡힌다 (숨은 규칙 없음)
  R.run([As, touch], SNAP_COOL);
  s = R.mode.state();
  assert.ok(s.stretches.some((x) => x.phase === 'held'), `집은 채로 다시 잡힘 ${JSON.stringify(s)}`);
  assert.equal(s.grabs, 2);
  assert.equal(s.stretches.length, 1, '같은 손가락을 다시 잡음 (두 개로 늘어나지 않음)');
});

test('놀이 흐름: 손가락 끝을 가린 채 3초 넘게 망설여도 과녁·안내가 남고, 집으면 원래 길이로 잡힌다', () => {
  for (const hover of [0.5, 3, 4.5]) {
    const R = makeRunner();
    const hands = R.run([A0], 0.6);
    const tip = { x: hands[0].lm[8].x, y: hands[0].lm[8].y };
    const nearB = bPinchingAt(tip, 'other');
    R.run((i) => [i < 4 ? A0 : occludedA, { ...nearB, x: nearB.x + 240 - i * 30 }], 9 / 30);
    R.run([occludedA, nearB], hover);
    let s = R.mode.state();
    assert.ok(s.targets >= 1 && s.aim, `${hover}초: 과녁 유지 ${JSON.stringify(s)}`);
    assert.match(s.hint, /꼬옥/, `${hover}초: 안내 유지`);
    R.run([occludedA, { ...nearB, pose: 'pinch' }], 0.2);
    s = R.mode.state();
    assert.equal(s.stretches.length, 1, `${hover}초: 잡혀야 함 ${JSON.stringify(s)}`);
    assert.ok(s.stretches[0].ratio > 0.8 && s.stretches[0].ratio < 1.25, `원래 길이 ${s.stretches[0].ratio}`);
  }
});

test('놀이 흐름: 이미 굽혀 둔 손가락은 다른 손이 가까이 와도 기억으로 과녁을 만들지 않는다', () => {
  const R = makeRunner();
  // 활짝 폈다가 → 검지만 펴기 (중지는 굽힘). 중지 모양 기억이 아직 남아 있을 때 다른 손이 중지 쪽에서 다가와 덮는다
  R.run([{ ...A0, pose: 'open' }], 0.5);
  const hands = R.run([A0], 0.5);
  const id = hands[0].id;
  const tip = { x: hands[0].lm[8].x, y: hands[0].lm[8].y };
  const fromLeft = { size: 150, angle: Math.PI / 2, side: 'left' };
  const nearB = bPinchingAt(tip, 'other', fromLeft);
  R.run((i) => [A0, { ...nearB, x: nearB.x - 240 + i * 30 }], 9 / 30);
  let s = R.mode.state();
  assert.ok(s.targetKeys.includes(`${id}:2`), `막 굽힌 중지는 잠깐(1.5초) 기억으로 남는다 ${JSON.stringify(s.targetKeys)}`);
  R.run([A0, nearB], 2);
  s = R.mode.state();
  assert.ok(s.targetKeys.includes(`${id}:1`), `검지 과녁 ${JSON.stringify(s.targetKeys)}`);
  assert.ok(!s.targetKeys.includes(`${id}:2`), `굽혀 있다 가려진 중지는 기억을 이어 주지 않음 ${JSON.stringify(s.targetKeys)}`);
});

test('놀이 흐름: 활짝 편 손에도 검지에 과녁 하나 + 따라 하기 안내가 나온다', () => {
  const R = makeRunner();
  const open = { ...A0, pose: 'open' };
  const hands = R.run([open], 0.8);
  let s = R.mode.state();
  assert.equal(s.targets, 1, `과녁은 하나만 ${JSON.stringify(s)}`);
  assert.equal(s.targetKeys[0], `${hands[0].id}:1`, '검지에');
  assert.ok(s.ghost !== null, '따라 하기 유령 손');
  assert.match(s.hint, /다른 손으로/);
  // 두 아이가 각자 손을 활짝 펴도 손마다 과녁 하나
  const R2 = makeRunner();
  R2.run([open, { ...open, x: 950, side: 'right' }], 0.8);
  s = R2.mode.state();
  assert.equal(s.targets, 2, JSON.stringify(s));
  assert.match(s.hint, /반짝이는/);
  // 활짝 편 손으로 다가가면, 다가가는 손의 과녁은 치우고 집을 곳만 남긴다
  const R3 = makeRunner();
  const h3 = R3.run([open], 0.6);
  const a = h3[0];
  const tip = { x: a.lm[8].x, y: a.lm[8].y };
  const nb = bPinchingAt(tip, 'open');
  R3.run([open, { ...nb, x: nb.x + 300 }], 0.4);
  R3.run((i) => [open, { ...nb, x: nb.x + 300 - i * 30 }], 11 / 30);
  s = R3.mode.state();
  assert.ok(s.aim, `가까우면 겨냥 ${JSON.stringify(s)}`);
  assert.ok(s.targetKeys.every((k) => k.startsWith(`${a.id}:`)), `다가가는 손 과녁 없음 ${JSON.stringify(s.targetKeys)}`);
  R3.run([open, { ...nb, pose: 'pinch' }], 0.2);
  s = R3.mode.state();
  assert.equal(s.stretches.length, 1, `편 손 검지도 잡힌다 ${JSON.stringify(s)}`);
  assert.equal(s.stretches[0].finger, 1);
});

/** A 의 검지를 잡아서 오른쪽으로 당긴 상태까지 만든다 */
function grabAndPull(R, dx = 300) {
  const hands = R.run([A0], 0.6);
  const tip = { x: hands[0].lm[8].x, y: hands[0].lm[8].y };
  const nearB = bPinchingAt(tip, 'other');
  R.run([A0, { ...nearB, x: nearB.x + 300 }], 0.3);
  R.run((i) => [A0, { ...nearB, x: nearB.x + 300 - i * 30 }], 0.34);
  const p = { ...nearB, pose: 'pinch' };
  R.run([A0, p], 0.2);
  const steps = Math.round(dx / 15);
  R.run((i) => [A0, { ...p, x: p.x + (i + 1) * 15 }], steps / 30);
  const far = { ...p, x: p.x + steps * 15 };
  R.run([A0, far], 0.2);
  return { tip, nearB, p, far };
}

test('놀이 흐름: 손가락 주인 손을 잠깐 놓쳤다 새 id 로 돌아와도, 같은 손가락이 두 번 잡히지 않는다', () => {
  const R = makeRunner();
  const { tip, far } = grabAndPull(R);
  let s = R.mode.state();
  assert.equal(s.stretches[0]?.phase, 'held');
  const firstA = s.stretches[0].handA;
  R.run([far], 0.35); // 주인 손이 0.35초 사라짐 → 인식기가 새 id 를 붙인다
  R.run([A0, far], 0.4);
  s = R.mode.state();
  assert.equal(s.stretches.length, 1);
  assert.equal(s.stretches[0].phase, 'held', '계속 잡혀 있음');
  assert.notEqual(s.stretches[0].handA, firstA, '새 id 로 이어 붙음');
  assert.equal(s.targets, 0, `가려진 원래 손가락 끝에 과녁이 다시 생기지 않음 ${JSON.stringify(s)}`);
  // 세 번째 손이 원래 손가락 끝을 집어도 두 번째 늘어난 손가락이 생기지 않는다
  const C = bPinchingAt(tip, 'other', { size: 150, angle: Math.PI / 2, side: 'left' });
  R.run([A0, far, { ...C, y: C.y + 200 }], 0.3);
  R.run((i) => [A0, far, { ...C, y: C.y + 200 - i * 20 }], 0.34);
  R.run([A0, far, { ...C, pose: 'pinch' }], 0.3);
  s = R.mode.state();
  assert.equal(s.stretches.length, 1, `한 손가락은 한 번만 ${JSON.stringify(s.stretches)}`);
  // 놓았다가 돌아가는 중에 다시 집으면 그 손가락을 다시 잡는다 (겹친 손가락 두 개가 생기지 않음)
  R.run([A0, { ...far, pose: 'open' }], 0.2);
  assert.equal(R.mode.state().stretches[0]?.phase, 'release');
  R.run([A0, { ...far, pose: 'pinch' }], 0.05);
  R.run([A0, { ...far, pose: 'pinch' }], 0.3);
  s = R.mode.state();
  assert.ok(s.stretches.length <= 1, `겹치지 않음 ${JSON.stringify(s.stretches)}`);
});

test('놀이 흐름: 느슨하게 집은 손을 잠깐 놓쳤다 새 id 로 잡혀도 계속 잡고 있다', () => {
  const R = makeRunner();
  const { far } = grabAndPull(R);
  // 엄지를 살짝 벌려 느슨하게 집기 (엄지-검지 거리 ≈ 0.4 × 손 크기)
  const loose = {
    ...far,
    pose: 'pinch',
    mutate(lm) {
      lm[4].x = lm[8].x;
      lm[4].y = lm[8].y + 0.4 * 150;
      lm[4].z = lm[8].z;
    },
  };
  R.run([A0, loose], 0.4);
  let s = R.mode.state();
  assert.equal(s.stretches[0]?.phase, 'held', `느슨해도 잡고 있음 ${JSON.stringify(s)}`);
  const firstB = s.stretches[0].handB;
  R.run([A0], 0.27);
  R.run([A0, loose], 0.6);
  s = R.mode.state();
  assert.equal(s.stretches[0]?.phase, 'held', `다시 잡힌 손으로 이어짐 ${JSON.stringify(s)}`);
  assert.notEqual(s.stretches[0].handB, firstB);
});

test('놀이 흐름: 휙 당기다 집는 손 id 가 바뀌어도 이어 잡는다', () => {
  const R = makeRunner();
  const { far } = grabAndPull(R, 150);
  // 빠르게 움직이다가 한 번에 손 크기 2배 넘게 튐 → 인식기는 새 손으로 본다
  R.run((i) => [A0, { ...far, x: far.x + (i + 1) * 40 }], 4 / 30);
  const firstB = R.mode.state().stretches[0].handB;
  const yank = { ...far, x: far.x + 160 + 280, y: far.y - 40 };
  R.run([A0, yank], 0.6);
  const s = R.mode.state();
  assert.equal(s.stretches[0]?.phase, 'held', `이어 잡음 ${JSON.stringify(s)}`);
  assert.notEqual(s.stretches[0].handB, firstB, '새 id 로 이어짐');
  assert.ok(s.stretches[0].ratio > 3, `멀리까지 늘어남 ${s.stretches[0].ratio}`);
});

test('놀이 흐름: 잡고 있는 길이가 경계에서 흔들려도 위쪽 안내가 왔다 갔다 하지 않는다', () => {
  const R = makeRunner();
  const { p } = grabAndPull(R, 150);
  // 'long' 안내 경계(2.4배)를 천천히 찾아서 그 자리에서 손을 떤다 (실제 카메라의 몇 px 떨림)
  let x = p.x + 150;
  for (let i = 0; i < 80 && R.mode.state().stretches[0].ratio < 2.4; i++) {
    x += 2;
    R.run([A0, { ...p, x }], 0.2);
  }
  x -= 1;
  R.run([A0, { ...p, x }], 0.3);
  const before = R.app.log.hints.length;
  let crossings = 0;
  let above = R.mode.state().stretches[0].ratio > 2.4;
  R.run((i) => {
    const r = R.mode.state().stretches[0]?.ratio ?? 0;
    if (r > 2.4 !== above) crossings++;
    above = r > 2.4;
    return [A0, { ...p, x: x + Math.sin(i * 1.1) * 6 + (i % 2 ? 1.5 : -1.5), y: p.y + (i % 3) - 1 }];
  }, 3);
  const changes = R.app.log.hints.length - before;
  assert.equal(R.mode.state().stretches[0].phase, 'held');
  assert.ok(crossings >= 4, `경계를 여러 번 넘나들어야 의미 있는 점검 ${crossings}`);
  assert.ok(changes <= 1, `안내가 ${changes}번 바뀜`);
});

test('놀이 흐름: 손가락 주인 손이 나가 버리면 서서히 사라지고 띠용 소리와 함께 놓는다', () => {
  const R = makeRunner();
  const { far } = grabAndPull(R);
  assert.equal(R.mode.state().stretches[0]?.phase, 'held');
  assert.ok(R.app.log.loops.size > 0);
  const boings = R.app.log.sounds.filter(([k]) => k === 'boing').length;
  R.run([far], 0.4); // 인식기 유예 0.2초 + 0.2초
  const finger = R.patches.find((p) => p.tint);
  assert.ok(finger && finger.opacity < 0.8, `서서히 사라짐 ${finger?.opacity}`);
  R.run([far], 0.5);
  const s = R.mode.state();
  assert.equal(s.stretches.length, 0, '사라짐');
  assert.equal(R.app.log.loops.size, 0, '고무 소리 끔');
  assert.ok(R.app.log.sounds.filter(([k]) => k === 'boing').length > boings, '띠용 소리');
});

test('놀이 흐름: 손 네 개로 두 손가락을 동시에, 나가면 소리·상태 정리', () => {
  const R = makeRunner();
  const A1 = { x: 330, y: 540, size: 130, angle: 0.25, pose: 'point', side: 'left' };
  const A2 = { x: 930, y: 540, size: 130, angle: -0.2, pose: 'v', side: 'right' };
  const B1 = { size: 130, angle: Math.PI / 2, side: 'left' };
  const B2 = { size: 130, angle: -Math.PI / 2, side: 'right' };
  const hands = R.run([A1, A2], 0.5);
  const t1 = hands.find((h) => h.palm.x < 640).lm[8];
  const t2 = hands.find((h) => h.palm.x > 640).lm[8];
  assert.ok(R.mode.state().targets >= 3);
  const n1 = bPinchingAt(t1, 'other', B1);
  const n2 = bPinchingAt(t2, 'other', B2);
  R.run([A1, A2, n1, n2], 0.2);
  R.run([A1, A2, { ...n1, pose: 'pinch' }, { ...n2, pose: 'pinch' }], 0.2);
  R.run(
    (i) => [A1, A2, { ...n1, pose: 'pinch', x: n1.x - i * 12, y: n1.y - i * 6 }, { ...n2, pose: 'pinch', x: n2.x + i * 12, y: n2.y - i * 5 }],
    20 / 30,
  );
  const s = R.mode.state();
  const held = s.stretches.filter((x) => x.phase === 'held');
  assert.equal(held.length, 2, JSON.stringify(s));
  assert.equal(new Set(held.map((x) => x.handA)).size, 2);
  assert.equal(R.patches.filter((p) => p.tint).length, 2, '손가락 패치 2장');
  R.mode.exit();
  assert.equal(R.app.log.loops.size, 0, 'exit 하면 소리 끔');
  assert.equal(R.mode.state().stretches.length, 0);
});

test('놀이 흐름: 집는 손에 가려 손가락 끝 인식이 엉뚱해져도, 기억해 둔 손가락 모양으로 잡고 늘인다', () => {
  const R = makeRunner();
  const hands = R.run([A0], 0.6);
  const tip = { x: hands[0].lm[8].x, y: hands[0].lm[8].y };
  const nearB = bPinchingAt(tip, 'other');
  R.run((i) => [i < 4 ? A0 : occludedA, { ...nearB, x: nearB.x + 240 - i * 30 }], 9 / 30);
  R.run([occludedA, nearB], 0.15);
  let s = R.mode.state();
  assert.ok(s.targets >= 1 && s.aim, `가려져도 과녁·안내 유지 ${JSON.stringify(s)}`);
  R.run([occludedA, { ...nearB, pose: 'pinch' }], 0.2);
  s = R.mode.state();
  assert.equal(s.stretches.length, 1, `잡혀야 함 ${JSON.stringify(s)}`);
  assert.equal(s.stretches[0].finger, 1);
  assert.ok(s.stretches[0].ratio > 0.8 && s.stretches[0].ratio < 1.25, `원래 길이로 기억 ${s.stretches[0].ratio}`);
  const p = { ...nearB, pose: 'pinch' };
  R.run((i) => [occludedA, { ...p, x: p.x + (i + 1) * 15 }], 20 / 30);
  s = R.mode.state();
  assert.ok(s.stretches[0].ratio > 2, `늘어남 ${s.stretches[0].ratio}`);
});
