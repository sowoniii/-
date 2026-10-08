// 입김 그림 놀이의 순수 로직 테스트:  node --test tests/frost.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
  mulberry32, valueNoise, fogCellSize, farthestCorner, FogField, BlowSensor, TrySensor, BreathSpread, PenTracker, DripSim,
  Coach, AutoFog, SteadyText, Latch, HINTS, dripRadius, fogRenderScale, sweptCells, penOnFog,
} from '../src/modes/frost/logic.js';
import { HandTracker } from '../src/core/handtracker.js';
import { Viewport } from '../src/core/viewport.js';
import { analyzeSpectrum } from '../src/core/mic.js';
import { synthHand } from '../src/core/synth.js';

const W = 1280;
const H = 720;
const DT = 1 / 60;

/** 시간을 흘리며 입김 구름을 김 격자에 더한다 */
function blowFor(field, spread, seconds, src) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) for (const b of spread.update(DT, [src], W, H)) field.addBlob(b.x, b.y, b.R, b.amount);
}

/** 테스트용 가짜 손 (필요한 필드만) */
function fakeHand(id, x, y, { pose = 'point', size = 140, stale = false, poseTime = 1, ext = null } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  lm[8] = { x, y, z: 0 };
  for (const [i, dx, dy] of [[0, 0, 1.2], [2, -0.4, 0.6], [4, -0.7, 0.2], [5, -0.3, 0.3], [9, 0, 0.3], [12, 0, -0.6], [13, 0.25, 0.3], [16, 0.25, -0.5], [17, 0.45, 0.35], [20, 0.5, -0.3]]) {
    lm[i] = { x: x + dx * size, y: y + dy * size, z: 0 };
  }
  return {
    id, pose, size, stale, poseTime, lm,
    palm: { x, y: y + 0.6 * size },
    tips: [4, 8, 12, 16, 20].map((i) => lm[i]),
    ext: ext || (pose === 'point' ? [0.2, 1, 0.1, 0.1, 0.1] : pose === 'open' ? [1, 1, 1, 1, 1] : [0, 0, 0, 0, 0]),
  };
}

// ------------------------------------------------------------------ 도우미

test('mulberry32 는 같은 seed 면 같은 수열, valueNoise 는 0..1', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const n = valueNoise(50, 30, 8, mulberry32(1));
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of n) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  assert.equal(lo, 0);
  assert.equal(hi, 1);
  // 부드럽다: 이웃 칸끼리 크게 튀지 않는다
  let maxStep = 0;
  for (let j = 0; j < 30; j++) for (let i = 1; i < 50; i++) maxStep = Math.max(maxStep, Math.abs(n[j * 50 + i] - n[j * 50 + i - 1]));
  assert.ok(maxStep < 0.35, `maxStep ${maxStep}`);
});

test('fogCellSize: 칸 수는 6만 개 안팎, 최소 4px', () => {
  assert.equal(fogCellSize(1280, 720), 4);
  const c = fogCellSize(3840, 2160);
  assert.ok(c > 8 && (3840 / c) * (2160 / c) <= 60001);
  assert.equal(fogCellSize(300, 200), 4);
  assert.equal(Math.round(farthestCorner(100, 100, 1000, 500)), Math.round(Math.hypot(900, 400)));
});

// ------------------------------------------------------------------ 김 격자

test('FogField.addBlob: 가운데는 진하고 멀리는 김이 없다, 최대치를 넘지 않는다', () => {
  const f = new FogField(W, H);
  assert.equal(f.empty, true);
  for (let i = 0; i < 120; i++) f.addBlob(640, 360, 200, 0.05);
  assert.equal(f.empty, false);
  assert.ok(f.sample(640, 360) > 1.2, `가운데 ${f.sample(640, 360)}`);
  assert.ok(f.sample(640, 360) <= f.max);
  assert.equal(f.sample(640, 600), 0);
  assert.equal(f.sample(100, 100), 0);
  // 가장자리는 가운데보다 옅다
  assert.ok(f.sample(640 + 175, 360) < f.sample(640 + 50, 360));
});

test('FogField.eraseCapsule: 선을 따라 닦이고 바깥은 그대로, 닦인 양을 돌려준다', () => {
  const f = new FogField(W, H);
  f.fill(1);
  const removed = f.eraseCapsule(300, 300, 700, 300, 12);
  assert.ok(removed > 0);
  for (let x = 300; x <= 700; x += 10) assert.ok(f.sample(x, 300) < 0.05, `선 위 ${x}: ${f.sample(x, 300)}`);
  assert.equal(f.sample(500, 340), 1, '선에서 먼 곳은 그대로');
  assert.equal(f.sample(760, 300), 1, '끝을 넘어서는 그대로');
  // 넓이 ≈ (길이 × 2r + 원) / 칸 넓이 만큼 닦였다
  const expected = (400 * 24 + Math.PI * 144) / (f.cell * f.cell);
  assert.ok(Math.abs(removed - expected) / expected < 0.25, `removed ${removed} vs ${expected}`);
  // 이미 닦인 곳을 다시 닦으면 거의 없음
  assert.ok(f.eraseCapsule(300, 300, 700, 300, 12) < removed * 0.1);
});

test('FogField: 점 사이를 선분으로 이으면 빠르게 움직여도 끊김이 없다', () => {
  const f = new FogField(W, H);
  f.fill(1);
  // 프레임마다 60px 씩 건너뛰는 빠른 손가락
  const pts = Array.from({ length: 12 }, (_, i) => ({ x: 100 + i * 60, y: 200 + Math.sin(i) * 40 }));
  for (let i = 1; i < pts.length; i++) f.eraseCapsule(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, 10);
  for (let i = 1; i < pts.length; i++) {
    for (let k = 0; k <= 10; k++) {
      const x = pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * k) / 10;
      const y = pts[i - 1].y + ((pts[i].y - pts[i - 1].y) * k) / 10;
      assert.ok(f.sample(x, y) < 0.1, `구간 ${i} ${k}: ${f.sample(x, y)}`);
    }
  }
});

test('FogField.evaporate: 진한 김은 40~60초쯤 걸려 마른다 (곳곳이 다르게)', () => {
  const f = new FogField(W, H);
  f.fill(f.max);
  const rate = 1.3 / 50;
  let t = 0;
  let firstClear = null;
  let mostlyClear = null;
  while (t < 120 && !f.empty) {
    f.evaporate(0.1, rate);
    t += 0.1;
    const c = f.coverage(0.4, 4);
    if (firstClear === null && c < 0.98) firstClear = t;
    if (mostlyClear === null && c < 0.1) mostlyClear = t;
  }
  assert.ok(firstClear > 18, `너무 빨리 마르기 시작 ${firstClear}`);
  assert.ok(mostlyClear > 30 && mostlyClear < 60, `거의 다 마르는 시간 ${mostlyClear}`);
  assert.ok(mostlyClear - firstClear > 8, '얼룩덜룩 천천히 마른다');
  assert.ok(f.empty && t < 90, `완전히 마름 ${t}`);
});

test('FogField.fogIn: 창 가장자리부터 안쪽으로 서리고 끝나면 꽉 찬다', () => {
  const f = new FogField(W, H);
  f.fogIn(0.35);
  assert.ok(f.sample(8, 8) > f.sample(640, 360), '가장자리가 먼저');
  assert.ok(f.coverage() < 0.8);
  f.fogIn(1);
  assert.equal(f.coverage(0.4, 1), 1);
  // 이미 있던 김은 줄이지 않는다
  f.eraseCapsule(600, 300, 700, 300, 20);
  f.fogIn(0.2);
  assert.ok(f.sample(10, 10) > 1);
});

test('FogField.coverage / writeAlpha / 가장자리 결', () => {
  const f = new FogField(400, 200, { cell: 4 });
  assert.equal(f.coverage(), 0);
  // 위쪽 절반만 김
  for (let j = 0; j < f.gh / 2; j++) for (let i = 0; i < f.gw; i++) f.d[j * f.gw + i] = 1.3;
  f.empty = false;
  assert.ok(Math.abs(f.coverage(0.4, 1) - 0.5) < 0.02);
  const data = new Uint8ClampedArray(f.n * 4);
  const edge = new Uint8ClampedArray(f.n * 4);
  f.writeAlpha(data, edge);
  assert.equal(data[3], 255, '김 = 불투명');
  assert.equal(data[(f.n - 1) * 4 + 3], 0, '맑은 곳 = 투명');
  assert.equal(f.dirty, false);
  // 김(위)과 맑은 곳(아래) 경계: 김의 아래쪽 가장자리 = 빛 반대쪽 → 어두운 그림자
  const k = (f.gh / 2 - 1) * f.gw + 10;
  assert.ok(edge[k * 4 + 3] > 40 && edge[k * 4] < 100, `경계 그림자 ${edge[k * 4]} ${edge[k * 4 + 3]}`);
  assert.equal(edge[(5 * f.gw + 10) * 4 + 3], 0, '김 한가운데는 결이 없다');
  // 반대로 맑은 곳 아래에 김이 있으면 빛을 받는 흰 테두리
  const g = new FogField(400, 200, { cell: 4 });
  for (let j = g.gh / 2; j < g.gh; j++) for (let i = 0; i < g.gw; i++) g.d[j * g.gw + i] = 1.3;
  const e2 = new Uint8ClampedArray(g.n * 4);
  g.writeAlpha(new Uint8ClampedArray(g.n * 4), e2);
  const k2 = (g.gh / 2) * g.gw + 10;
  assert.ok(e2[k2 * 4] === 255 && e2[k2 * 4 + 3] > 100, '빛 받는 흰 테두리');
});

test('FogField.resampleFrom: 창 크기가 바뀌어도 김 모양이 남는다', () => {
  const a = new FogField(W, H);
  for (let i = 0; i < 100; i++) a.addBlob(300, 300, 250, 0.05);
  const b = new FogField(900, 700);
  b.resampleFrom(a);
  assert.equal(b.empty, false);
  assert.ok(Math.abs(a.coverage(0.4, 1) - b.coverage(0.4, 1)) < 0.03);
  assert.ok(b.sample((300 * 900) / W, (300 * 700) / H) > 1);
});

// ------------------------------------------------------------------ 입김

test('BreathSpread: 입 앞에서 시작해 몇 초면 화면 대부분을 덮는다', () => {
  const src = { key: 'f1', x: 576, y: 339, scale: 218, s: 0.8 };
  const f = new FogField(W, H);
  const sp = new BreathSpread();
  blowFor(f, sp, 0.5, src);
  const c05 = f.coverage(0.4, 1);
  assert.ok(c05 > 0.03 && c05 < 0.35, `0.5초: ${c05}`);
  assert.ok(f.sample(576, 339) > 0.4, '입 앞이 먼저 서린다');
  assert.equal(f.sample(10, 710), 0, '먼 모서리는 아직');
  blowFor(f, sp, 2.5, src);
  const c3 = f.coverage(0.4, 1);
  assert.ok(c3 > 0.85, `3초: ${c3}`);
  // 살살 불어도 4초면 대부분
  const g = new FogField(W, H);
  blowFor(g, new BreathSpread(), 4, { ...src, s: 0.3 });
  assert.ok(g.coverage(0.4, 1) > 0.75, `약하게 4초: ${g.coverage(0.4, 1)}`);
});

test('BreathSpread: 멈추면 구름이 줄어들고 한참 뒤 잊는다', () => {
  const sp = new BreathSpread();
  const src = { key: 'mic', x: 640, y: 360, scale: 200, s: 1 };
  let out;
  for (let i = 0; i < 120; i++) out = sp.update(DT, [src], W, H);
  const big = out[0].R;
  assert.ok(big > 600);
  assert.equal(sp.update(DT, [], W, H).length, 0, '안 불면 김을 더하지 않는다');
  for (let i = 0; i < 90; i++) sp.update(DT, [], W, H);
  assert.ok(sp.items.get('mic').R < big * 0.6, '줄어든다');
  for (let i = 0; i < 300; i++) sp.update(DT, [], W, H);
  assert.equal(sp.items.size, 0, '잊는다');
});

test('BlowSensor: 마이크만 있으면 화면 가운데에서, 얼굴이 있으면 그 입에서', () => {
  const s = new BlowSensor();
  let r = s.update(DT, { blowing: true, strength: 0.6 }, [], W, H);
  assert.equal(r.blowing, true);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].x, W / 2);
  assert.ok(Math.abs(r.strength - 0.6) < 1e-9);
  const face = { id: 7, blow: 0.1, mouth: { x: 300, y: 400 }, width: 200, stale: false };
  r = s.update(DT, { blowing: true, strength: 0.6 }, [face], W, H);
  assert.equal(r.sources[0].key, 'f7');
  assert.equal(r.sources[0].x, 300);
  r = s.update(DT, { blowing: false, strength: 0 }, [face], W, H);
  assert.equal(r.blowing, false);
  // 얼굴이 잠깐 안 보여도 방금 본 입 위치를 쓴다
  r = s.update(DT, { blowing: true, strength: 0.5 }, [], W, H);
  assert.equal(r.sources[0].x, 300);
  for (let i = 0; i < 200; i++) s.update(DT, { blowing: false }, [], W, H);
  r = s.update(DT, { blowing: true, strength: 0.5 }, [], W, H);
  assert.equal(r.sources[0].x, W / 2, '오래 지나면 가운데');
  // 마이크 세기가 아주 작아도 최소 세기는 보장
  assert.ok(r.strength >= 0.3);
});

test('BlowSensor: 입 모양 히스테리시스와 깜빡임 무시, 여러 얼굴', () => {
  const s = new BlowSensor({ on: 0.5, off: 0.32, hold: 0.1 });
  const face = (id, blow, x = 300, stale = false) => ({ id, blow, mouth: { x, y: 400 }, width: 200, stale });
  // 한 프레임 튀는 값은 무시
  assert.equal(s.update(DT, null, [face(1, 0.9)], W, H).blowing, false);
  assert.equal(s.update(DT, null, [face(1, 0.1)], W, H).blowing, false);
  // 0.1초 넘게 오므리면 켜짐
  let r;
  for (let i = 0; i < 8; i++) r = s.update(DT, null, [face(1, 0.7)], W, H);
  assert.equal(r.blowing, true);
  // on 과 off 사이 값은 유지
  for (let i = 0; i < 30; i++) r = s.update(DT, null, [face(1, 0.4)], W, H);
  assert.equal(r.blowing, true);
  // 잠깐(<0.1초) 떨어져도 유지
  for (let i = 0; i < 3; i++) r = s.update(DT, null, [face(1, 0.1)], W, H);
  assert.equal(r.blowing, true);
  // 인식이 잠깐 끊긴(stale) 얼굴은 상태 유지
  for (let i = 0; i < 10; i++) r = s.update(DT, null, [face(1, 0, 300, true)], W, H);
  assert.equal(r.blowing, true);
  for (let i = 0; i < 10; i++) r = s.update(DT, null, [face(1, 0.1)], W, H);
  assert.equal(r.blowing, false);
  // 두 아이가 동시에 불면 두 곳에서
  for (let i = 0; i < 10; i++) r = s.update(DT, null, [face(1, 0.8), face(2, 0.9, 900)], W, H);
  assert.equal(r.sources.length, 2);
  assert.deepEqual(r.sources.map((x) => x.key).sort(), ['f1', 'f2']);
  // 사라진 얼굴 상태는 지운다
  s.update(DT, null, [], W, H);
  assert.equal(s.faces.size, 0);
});

test('BlowSensor: 소리만 들릴 때 고른 얼굴은 비슷한 얼굴 사이에서 왔다 갔다 하지 않는다', () => {
  const s = new BlowSensor();
  const mic = { blowing: true, strength: 0.7 };
  const face = (id, width, x) => ({ id, blow: 0.1, mouth: { x, y: 400 }, width, stale: false });
  assert.equal(s.update(DT, mic, [face(1, 200, 300), face(2, 190, 900)], W, H).sources[0].key, 'f1');
  // 2번 얼굴이 아주 조금 커져도 그대로
  assert.equal(s.update(DT, mic, [face(1, 200, 300), face(2, 205, 900)], W, H).sources[0].key, 'f1');
  // 확실히 크면(가까이 오면) 바꾼다
  assert.equal(s.update(DT, mic, [face(1, 120, 300), face(2, 260, 900)], W, H).sources[0].key, 'f2');
});

// ------------------------------------------------------------------ 그리기

test('PenTracker: 검지 끝을 이어 그리고, 굵기는 손 크기에 비례', () => {
  const p = new PenTracker();
  let ops = p.update([fakeHand(1, 100, 100)], DT);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, 'pen');
  assert.equal(ops[0].start, true);
  assert.equal(ops[0].len, 0);
  ops = p.update([fakeHand(1, 130, 110)], DT);
  assert.equal(ops[0].start, false);
  assert.deepEqual([ops[0].ax, ops[0].ay, ops[0].bx, ops[0].by], [100, 100, 130, 110]);
  assert.ok(Math.abs(ops[0].r - (140 * 0.18) / 2) < 1e-9);
  assert.ok(ops[0].speed > 0);
  // 아주 작은 손/큰 손은 최소/최대 굵기
  const q = new PenTracker();
  assert.equal(q.update([fakeHand(2, 0, 0, { size: 30 })], DT)[0].r, 7);
  assert.equal(q.update([fakeHand(3, 500, 0, { size: 900 })], DT)[0].r, 35);
});

test('PenTracker: 튐·놓침·손 모양 바뀜에서 선을 끊는다', () => {
  const p = new PenTracker();
  p.update([fakeHand(1, 100, 100)], DT);
  // 한 프레임에 손 크기의 2.2배보다 멀리 튀면 새 선
  let ops = p.update([fakeHand(1, 100 + 140 * 2.5, 100)], DT);
  assert.equal(ops[0].start, true);
  // 잠깐 놓침(stale): 아무것도 안 그림
  ops = p.update([fakeHand(1, 400, 100, { stale: true })], DT);
  assert.equal(ops.length, 0);
  // 가까이에서 돌아오면 이어서
  ops = p.update([fakeHand(1, 470, 100)], DT);
  assert.equal(ops[0].start, false);
  // 놓쳤다가 손 크기의 0.9배보다 멀리서 돌아오면 새 선
  p.update([fakeHand(1, 470, 100, { stale: true })], DT);
  ops = p.update([fakeHand(1, 470 + 140, 100)], DT);
  assert.equal(ops[0].start, true);
  // 주먹이 되면 바로 멈춤
  ops = p.update([fakeHand(1, 620, 100, { pose: 'fist' })], DT);
  assert.equal(ops.length, 0);
  ops = p.update([fakeHand(1, 630, 100)], DT);
  assert.equal(ops[0].start, true, '다시 검지를 펴면 새 선');
});

test('PenTracker: 손 모양이 바뀌기 전이라도 검지를 접기 시작하면 바로 펜을 뗀다', () => {
  const p = new PenTracker({ liftExt: 0.35 });
  p.update([fakeHand(1, 100, 100)], DT);
  assert.equal(p.update([fakeHand(1, 110, 100)], DT)[0].start, false);
  // pose 는 아직 'point' 지만 검지가 접히는 중
  assert.equal(p.update([fakeHand(1, 115, 120, { ext: [0.2, 0.25, 0.1, 0.1, 0.1] })], DT).length, 0);
  // 다시 펴면 새 선 (접히는 동안 움직인 길은 잇지 않는다)
  assert.equal(p.update([fakeHand(1, 140, 100)], DT)[0].start, true);
});

test('PenTracker: point 가 잠깐 other 로 흔들려도 검지가 펴져 있으면 계속 그린다', () => {
  const p = new PenTracker({ grace: 0.3 });
  p.update([fakeHand(1, 100, 100)], DT);
  const wobble = (x) => fakeHand(1, x, 100, { pose: 'other', ext: [0.3, 0.9, 0.5, 0.2, 0.2] });
  let ops = p.update([wobble(110)], DT);
  assert.equal(ops[0]?.type, 'pen');
  assert.equal(ops[0].start, false);
  for (let i = 0; i < 25; i++) ops = p.update([wobble(110 + i)], DT);
  assert.equal(ops.length, 0, 'grace 가 지나면 멈춤');
  // 검지가 접힌 other 는 바로 멈춤
  const q = new PenTracker();
  q.update([fakeHand(1, 100, 100)], DT);
  assert.equal(q.update([fakeHand(1, 100, 100, { pose: 'other', ext: [0, 0.2, 0.2, 0, 0] })], DT).length, 0);
});

test('PenTracker: 손바닥은 잠깐 편 뒤부터 닦기, 손가락 자국과 지나간 길', () => {
  const p = new PenTracker({ wipeDelay: 0.18 });
  assert.equal(p.update([fakeHand(1, 300, 300, { pose: 'open', poseTime: 0.05 })], DT).length, 0, '지나가는 펼친 손은 무시');
  let ops = p.update([fakeHand(1, 300, 300, { pose: 'open', poseTime: 0.2 })], DT);
  assert.equal(ops[0].type, 'wipe');
  assert.equal(ops[0].fingers.length, 5);
  assert.equal(ops[0].trails.length, 0);
  assert.ok(Math.abs(ops[0].r - 140 * 0.58) < 1e-9);
  ops = p.update([fakeHand(1, 360, 300, { pose: 'open', poseTime: 0.25 })], DT);
  assert.equal(ops[0].trails.length, 5, '손가락이 지나간 길도 닦는다');
  assert.equal(ops[0].fromPalm.x, 300);
  assert.equal(p.modeOf(1), 'wipe');
});

test('PenTracker: 여러 손은 따로, 사라진 손 상태는 지운다', () => {
  const p = new PenTracker();
  p.update([fakeHand(1, 100, 100), fakeHand(2, 800, 100)], DT);
  const ops = p.update([fakeHand(1, 110, 100), fakeHand(2, 790, 100)], DT);
  assert.equal(ops.length, 2);
  assert.ok(ops.every((o) => !o.start));
  assert.equal(ops.find((o) => o.id === 2).ax, 800);
  p.update([fakeHand(1, 120, 100)], DT);
  assert.equal(p.states.has(2), false);
  assert.equal(p.modeOf(2), 'none');
});

test('실제 손 추적기 + PenTracker + FogField: 가리키는 손으로 그은 선이 끊김 없이 닦인다', () => {
  const tracker = new HandTracker();
  const pens = new PenTracker();
  const f = new FogField(W, H);
  f.fill(1.3);
  let t = 0;
  const tips = [];
  for (let i = 0; i < 50; i++) {
    t += 1 / 30;
    const x = 300 + i * 12;
    const hands = tracker.update([{ lm: synthHand({ x, y: 450, size: 140, pose: 'point' }), side: 'right' }], t);
    for (const op of pens.update(hands, 1 / 30)) {
      if (op.type !== 'pen') continue;
      f.eraseCapsule(op.ax, op.ay, op.bx, op.by, op.r);
      tips.push({ x: op.bx, y: op.by });
    }
  }
  assert.ok(tips.length > 40, `펜이 켜져야 함 ${tips.length}`);
  for (let i = 1; i < tips.length; i++) {
    const m = { x: (tips[i].x + tips[i - 1].x) / 2, y: (tips[i].y + tips[i - 1].y) / 2 };
    assert.ok(f.sample(m.x, m.y) < 0.1, `선 중간 ${i}`);
  }
  assert.ok(f.sample(640, 150) > 1.2, '선에서 먼 곳은 그대로');
});

// ------------------------------------------------------------------ 물방울

test('DripSim: 김 속에서는 주르륵 끝까지 흐르며 맑은 자국을 남긴다', () => {
  const f = new FogField(W, H);
  f.fill(1.3);
  const d = new DripSim();
  const rng = mulberry32(5);
  d.spawn(400, 100, 0.9, rng, 0.2, 0.6);
  let started = 0;
  let t = 0;
  while (d.count && t < 30) {
    started += d.step(DT, f, H, rng);
    t += DT;
  }
  assert.equal(started, 1);
  assert.equal(d.count, 0, '화면 아래로 빠져나감');
  assert.ok(t > 3 && t < 25, `흐른 시간 ${t}`);
  // 흐른 자리는 맑아졌다 (좌우로 조금 흔들리므로 근처 최소값)
  let cleared = 0;
  for (let y = 150; y < 700; y += 25) {
    let min = Infinity;
    for (let x = 385; x <= 415; x += 2) min = Math.min(min, f.sample(x, y));
    if (min < 0.5) cleared++;
  }
  assert.ok(cleared >= 18, `자국 ${cleared}/22`);
  assert.ok(f.sample(600, 400) > 1.2, '옆은 그대로');
});

test('DripSim: 진한 김에서도 어떤 물방울은 끝까지, 어떤 것은 중간에 멈춘다', () => {
  const rng = mulberry32(11);
  let reached = 0;
  let stopped = 0;
  for (let n = 0; n < 24; n++) {
    const f = new FogField(W, H);
    f.fill(1.3);
    const d = new DripSim();
    const drop = d.spawn(640, 80, 0.8, rng, 0);
    for (let i = 0; i < 60 * 30 && d.count; i++) {
      d.step(DT, f, H, rng);
      if (drop.dead) break;
    }
    if (drop.dead) stopped++;
    else if (!d.count) reached++;
  }
  assert.ok(reached >= 4, `끝까지 ${reached}`);
  assert.ok(stopped >= 4, `중간에 멈춤 ${stopped}`);
});

test('DripSim: 맑은 곳에서는 금방 멈추고 사라진다, 개수 상한', () => {
  const f = new FogField(W, H);
  const d = new DripSim({ max: 3 });
  const rng = mulberry32(9);
  const drop = d.spawn(400, 100, 0.6, rng, 0);
  let t = 0;
  while (!drop.dead && t < 5) {
    d.step(DT, f, H, rng);
    t += DT;
  }
  assert.equal(drop.dead, true);
  assert.ok(t < 2, `금방 멈춤 ${t}`);
  assert.ok(drop.y < 300, `멀리 못 감 ${drop.y}`);
  for (let i = 0; i < 60 * 3; i++) d.step(DT, f, H, rng);
  assert.equal(d.count, 0, '서서히 사라짐');
  d.spawn(1, 1);
  d.spawn(2, 2);
  d.spawn(3, 3);
  assert.equal(d.spawn(4, 4), null);
  assert.equal(d.count, 3);
  assert.ok(dripRadius(2, 1) > dripRadius(0.5, 1));
});

// ------------------------------------------------------------------ 안내

test('Coach: 불기 → (다 불고 나면) 김이 서렸어요 → 그리기 → 다시 불기', () => {
  const c = new Coach({ toastGap: 8 });
  const base = { coverage: 0, blowing: false, drawing: false, wiping: false, drawn: 0, micEnabled: true };
  let r = c.update(DT, base);
  assert.equal(r.hint, HINTS.blow);
  assert.equal(c.update(DT, { ...base, micEnabled: false }).hint, HINTS.blowNoMic);
  r = c.update(DT, { ...base, blowing: true, coverage: 0.1 });
  assert.equal(r.hint, HINTS.blowing);
  // 부는 동안에는 단계만 바뀌고 안내/축하는 기다린다
  r = c.update(DT, { ...base, blowing: true, coverage: 0.5 });
  assert.equal(c.phase, 'draw');
  assert.equal(r.hint, HINTS.blowing);
  assert.deepEqual(r.events, []);
  r = c.update(DT, { ...base, coverage: 0.6 });
  assert.deepEqual(r.events, ['fogged']);
  assert.equal(r.hint, HINTS.draw);
  // 덮인 정도가 조금 흔들려도 단계 유지 (히스테리시스)
  r = c.update(DT, { ...base, coverage: 0.2 });
  assert.equal(c.phase, 'draw');
  r = c.update(DT, { ...base, coverage: 0.05 });
  assert.equal(c.phase, 'again');
  assert.deepEqual(r.events, ['cleared']);
  assert.equal(r.hint, HINTS.again);
  // 곧바로 다시 서려도 축하는 간격을 둔다
  c.update(DT, { ...base, coverage: 0.7 });
  r = c.update(DT, { ...base, coverage: 0.7 });
  assert.equal(c.phase, 'draw');
  assert.ok(!r.events.includes('fogged'), '알림이 너무 잦지 않게');
  assert.equal(c.cycles, 2);
});

test('Coach: 저절로 서리기 알림 뒤에는 "김이 서렸어요" 를 겹쳐 띄우지 않는다', () => {
  const c = new Coach({ toastGap: 8 });
  const base = { coverage: 0, blowing: false, drawing: false, wiping: false, drawn: 0, micEnabled: false };
  c.update(DT, base);
  c.markToast();
  let events = [];
  for (const cov of [0.2, 0.5, 0.9, 0.9]) events.push(...c.update(DT, { ...base, coverage: cov }).events);
  assert.equal(c.phase, 'draw');
  assert.deepEqual(events, []);
  // 다음 김에서는 다시 알림
  c.update(DT, { ...base, coverage: 0.02 });
  for (let i = 0; i < 60 * 9; i++) c.update(DT, { ...base, coverage: 0.02 });
  events = [];
  for (const cov of [0.5, 0.6]) events.push(...c.update(DT, { ...base, coverage: cov }).events);
  assert.deepEqual(events, ['fogged']);
});

test('Coach: 충분히 그리면 칭찬 한 번, 오래 그리기만 하면 손바닥 닦기 안내', () => {
  const c = new Coach({ toastGap: 0, artLen: 7, wipeHintAfter: 5 });
  const base = { coverage: 0.8, blowing: false, drawing: true, wiping: false, drawn: 0.1, micEnabled: true };
  let arts = 0;
  let hint = null;
  for (let i = 0; i < 60 * 6; i++) {
    const r = c.update(DT, base);
    arts += r.events.filter((e) => e === 'art').length;
    hint = r.hint;
  }
  assert.equal(arts, 1);
  assert.equal(hint, HINTS.wipe);
  for (let i = 0; i < 40; i++) hint = c.update(DT, { ...base, wiping: true }).hint;
  assert.equal(hint, HINTS.draw, '닦아 봤으면 다시 그리기 안내');
});

test('AutoFog: 마이크가 없으면 8초, 있으면 14초 동안 아무도 안 불면 저절로 서린다', () => {
  const a = new AutoFog();
  const run = (sec, s) => {
    let fired = 0;
    for (let i = 0; i < Math.round(sec / DT); i++) if (a.update(DT, s)) fired++;
    return fired;
  };
  assert.equal(run(7.5, { micEnabled: false, blowing: false, coverage: 0 }), 0);
  assert.equal(run(1, { micEnabled: false, blowing: false, coverage: 0 }), 1);
  assert.equal(a.lastTried, false);
  // 부는 중이거나 김이 있으면 기다림을 처음부터
  run(5, { micEnabled: false, blowing: false, coverage: 0 });
  run(0.1, { micEnabled: false, blowing: true, coverage: 0 });
  assert.equal(run(7, { micEnabled: false, blowing: false, coverage: 0 }), 0);
  run(0.1, { micEnabled: false, blowing: false, coverage: 0.5 });
  assert.equal(run(7, { micEnabled: false, blowing: false, coverage: 0 }), 0);
  const b = new AutoFog();
  let fired = 0;
  for (let i = 0; i < Math.round(13.5 / DT); i++) if (b.update(DT, { micEnabled: true, blowing: false, coverage: 0 })) fired++;
  assert.equal(fired, 0);
  for (let i = 0; i < Math.round(1 / DT); i++) if (b.update(DT, { micEnabled: true, blowing: false, coverage: 0 })) fired++;
  assert.equal(fired, 1);
});

test('AutoFog: 불어 보려고 애쓰는 아이가 있으면 몇 초 만에 도와준다', () => {
  const a = new AutoFog();
  const s = { micEnabled: true, blowing: false, coverage: 0 };
  let t = 0;
  let fired = false;
  // 2초 조용 → 그 뒤로 계속 살살 불기 (입김으로는 모자람)
  for (; t < 2; t += DT) fired ||= a.update(DT, s);
  for (; t < 20 && !fired; t += DT) fired = a.update(DT, { ...s, trying: true });
  assert.equal(fired, true);
  assert.ok(t < 6, `애쓰면 금방 (${t.toFixed(1)}초)`);
  assert.equal(a.lastTried, true, '알림 문구를 "잘했어요" 로');
});

test('SteadyText: 처음엔 바로, 그 뒤로는 잠깐 바뀐 문구는 무시', () => {
  const h = new SteadyText(0.3);
  assert.equal(h.update(DT, 'a'), true);
  assert.equal(h.value, 'a');
  // 몇 프레임만 'b' 였다가 돌아오면 그대로
  for (let i = 0; i < 5; i++) h.update(DT, 'b');
  h.update(DT, 'a');
  assert.equal(h.value, 'a');
  // 계속 'b' 면 바뀐다
  let changed = 0;
  for (let i = 0; i < 30; i++) if (h.update(DT, 'b')) changed++;
  assert.equal(h.value, 'b');
  assert.equal(changed, 1);
});

// ------------------------------------------------------------------ 리뷰에서 나온 실제 카메라 문제들

/** 마이크 스펙트럼 흉내 (AnalyserNode 처럼 Blackman 창 + FFT 1024 + dB) */
function micSpectrum(gen, sampleRate = 48000, n = 1024, frames = 12) {
  const out = new Float32Array(n / 2);
  const acc = new Float64Array(n / 2);
  let t = 0;
  for (let fr = 0; fr < frames; fr++) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = gen(t++) * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n));
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = (-2 * Math.PI) / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const c = Math.cos(a * k);
          const s = Math.sin(a * k);
          const p = i + k + len / 2;
          const xr = re[p] * c - im[p] * s;
          const xi = re[p] * s + im[p] * c;
          re[p] = re[i + k] - xr;
          im[p] = im[i + k] - xi;
          re[i + k] += xr;
          im[i + k] += xi;
        }
      }
    }
    for (let k = 0; k < n / 2; k++) acc[k] += Math.hypot(re[k], im[k]) / n / frames;
  }
  for (let k = 0; k < n / 2; k++) out[k] = 20 * Math.log10(acc[k] + 1e-12);
  return out;
}

test('소리: 놀이의 음(사인/삼각파)은 스피커에서 마이크로 다시 들어가도 입김으로 판정되지 않는다 (잡음은 판정됨)', () => {
  const SR = 48000;
  const rng = mulberry32(3);
  const white = () => rng() * 2 - 1;
  const floor = () => white() * 0.001;
  const floorDb = analyzeSpectrum(micSpectrum(floor), SR, 0).levelDb;
  // 방 소음보다 35dB 큰 소리가 다시 들어왔을 때
  const loud = (gen) => {
    const lvl = analyzeSpectrum(micSpectrum(gen), SR, 0).levelDb;
    const g = Math.pow(10, (floorDb + 35 - lvl) / 20);
    return analyzeSpectrum(micSpectrum((i) => floor() + gen(i) * g), SR, floorDb);
  };
  const sine = (f) => (i) => Math.sin((2 * Math.PI * f * i) / SR);
  const tri = (f) => (i) => 4 * Math.abs(((f * i) / SR) % 1 - 0.5) - 1;
  for (const [name, gen] of [['후~ 시작음', sine(900)], ['서리 반짝', sine(3136)], ['뽀득', tri(800)], ['쓱 닦기', sine(1200)]]) {
    const a = loud(gen);
    assert.equal(a.candidate, false, `${name}: flatness ${a.flatness.toFixed(2)}, low ${a.lowRatio.toFixed(2)}`);
  }
  // 예전처럼 대역을 거른 잡음은 입김 후보가 된다 → 이 놀이에서는 쓰지 않는다
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const w = (2 * Math.PI * 2300) / SR;
  const al = Math.sin(w) / (2 * 2.2);
  const bandNoise = () => {
    const x = white();
    const y = (al * x - al * x2 + 2 * Math.cos(w) * y1 - (1 - al) * y2) / (1 + al);
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
  assert.equal(loud(bandNoise).candidate, true, '대역 잡음은 입김으로 착각된다');
  // 그래서 놀이 코드에는 잡음 소리를 쓰지 않는다 (이어지는 소리도 없다: 긴 음은 진짜 입김 소리를 가린다)
  const src = readFileSync(new URL('../src/modes/frost.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /type:\s*'noise'|\.noise\(|\.whoosh\(|\.pop\(|\.loop\(/);
});

test('BlowSensor: 마이크가 켜져 있는데 조용하면 입 모양만으로는 더 확실해야 하고 약하게 분다', () => {
  const face = (blow) => ({ id: 1, blow, mouth: { x: 300, y: 400 }, width: 200, stale: false });
  const quiet = { enabled: true, level: 0.02, blowing: false, strength: 0 };
  const run = (s, sec, mic, blow) => {
    let r;
    for (let i = 0; i < Math.round(sec / DT); i++) r = s.update(DT, mic, [face(blow)], W, H);
    return r;
  };
  // 집중해서 입을 오므린 정도(0.6)는 조용하면 김이 안 나온다
  let s = new BlowSensor();
  assert.equal(run(s, 2, quiet, 0.6).blowing, false);
  assert.equal(s.strict, true);
  // 뽀뽀 얼굴을 잠깐(0.2초) 해도 안 나온다
  s = new BlowSensor();
  assert.equal(run(s, 0.2, quiet, 0.9).blowing, false);
  // 또렷하게 오래 오므리면 나오지만, 소리가 들릴 때보다 약하다
  let r = run(s, 0.3, quiet, 0.9);
  assert.equal(r.blowing, true);
  const weak = r.strength;
  // 소리가 조금이라도 들리면 너그러운 기준 (0.1초, 0.5)
  s = new BlowSensor();
  r = run(s, 0.12, { enabled: true, level: 0.2, blowing: false, strength: 0 }, 0.6);
  assert.equal(r.blowing, true);
  assert.equal(s.strict, false);
  assert.ok(r.strength > weak, `${r.strength} > ${weak}`);
  // 조용해지면 0.5 아래로 내려가는 즉시 멈춘다 (그림 그리며 입을 살짝 오므린 채로 계속 김이 나오지 않게)
  r = run(s, 0.2, quiet, 0.45);
  assert.equal(r.blowing, false);
  // 마이크가 없으면 예전처럼 너그럽게
  s = new BlowSensor();
  assert.equal(run(s, 0.12, { enabled: false, level: 0, blowing: false }, 0.6).blowing, true);
});

test('TrySensor: 오므린 입 + 작은 소리 = 거의 불었어요, 말소리처럼 끊기는 소리는 무시', () => {
  const fb = { x: 640, y: 360, scale: 200 };
  const face = (blow) => ({ id: 1, blow, mouth: { x: 300, y: 400 }, width: 220, stale: false });
  const mic = (level) => ({ enabled: true, level, blowing: false, strength: 0 });
  let t = new TrySensor();
  for (let i = 0; i < 6; i++) t.update(DT, mic(0.3), [face(0.35)], false, fb);
  assert.equal(t.trying, false, '아주 짧으면 아직');
  for (let i = 0; i < 6; i++) t.update(DT, mic(0.3), [face(0.35)], false, fb);
  assert.equal(t.trying, true);
  assert.deepEqual([t.source.x, t.source.y, t.source.scale], [300, 400, 220], '그 아이의 입에서');
  // 조용해지면 잠깐 뒤 꺼진다
  for (let i = 0; i < 20; i++) t.update(DT, mic(0), [face(0.35)], false, fb);
  assert.equal(t.trying, false);
  assert.ok(t.time > 0.1);
  // 진짜로 불면 처음부터
  t.update(DT, mic(0.6), [face(0.9)], true, fb);
  assert.equal(t.time, 0);
  // 오므린 입이 안 보이면: 0.4초 넘게 끊기지 않는 소리만
  t = new TrySensor();
  for (let k = 0; k < 10; k++) {
    for (let i = 0; i < 12; i++) t.update(DT, mic(0.4), [], false, fb); // 0.2초 소리
    for (let i = 0; i < 9; i++) t.update(DT, mic(0.02), [], false, fb); // 0.15초 쉼 (말소리)
  }
  assert.equal(t.time, 0, '말소리는 무시');
  for (let i = 0; i < 30; i++) t.update(DT, mic(0.4), [], false, fb);
  assert.equal(t.trying, true);
  assert.equal(t.source.x, 640, '얼굴이 없으면 받은 위치에서');
  // 마이크가 없으면 판단하지 않는다
  t = new TrySensor();
  for (let i = 0; i < 60; i++) t.update(DT, { enabled: false, level: 0.5 }, [face(0.4)], false, fb);
  assert.equal(t.trying, false);
});

test('PenTracker.suspend: 창 크기가 바뀌어도 가만히 있는 손가락은 줄을 긋지 않는다 (실제 손 추적기)', () => {
  const run = (useSuspend) => {
    const vp = new Viewport();
    vp.setSource(1280, 720, true);
    vp.resize(1000, 562);
    const norm = synthHand({ x: 800, y: 400, size: 150, pose: 'point' }).map((p) => ({ x: p.x / 1280, y: p.y / 720, z: 0 }));
    const tracker = new HandTracker();
    const pens = new PenTracker();
    let t = 0;
    let streak = 0;
    let pen = false;
    for (let i = 0; i < 90; i++) {
      t += 1 / 30;
      if (i === 30) {
        vp.resize(1280, 720); // 노트북 창 → 전체 화면
        if (useSuspend) pens.suspend(0.25);
      }
      const hands = tracker.update([{ lm: norm.map((p) => vp.toScreen(p.x, p.y, p.z)), side: 'right' }], t);
      const ops = pens.update(hands, 1 / 30);
      pen = ops.some((o) => o.type === 'pen');
      if (i >= 30) for (const op of ops) streak += op.len;
    }
    return { streak, pen };
  };
  const before = run(false);
  assert.ok(before.streak > 60, `예전에는 줄이 그어졌다 (${before.streak.toFixed(0)}px)`);
  const after = run(true);
  assert.ok(after.streak < 3, `줄이 없어야 함 (${after.streak.toFixed(1)}px)`);
  assert.equal(after.pen, true, '잠깐 뒤 다시 그릴 수 있다');
});

test('Latch: 화면 60fps · 인식 30fps 에서도 그리는 중(drawing)이 깜빡이지 않는다', () => {
  const tracker = new HandTracker();
  const pens = new PenTracker();
  const latch = new Latch(0.15);
  let hands = [];
  let raw = '';
  let held = '';
  for (let i = 0; i < 120; i++) {
    const t = i / 60;
    if (i % 2 === 0) hands = tracker.update([{ lm: synthHand({ x: 300 + i * 4, y: 400, size: 140, pose: 'point' }), side: 'right' }], t);
    const moved = pens.update(hands, 1 / 60).some((o) => o.type === 'pen' && o.len > 0.5);
    if (i < 30) continue; // 손 모양이 안정될 때까지
    raw += moved ? 'D' : '.';
    held += latch.update(1 / 60, moved) ? 'D' : '.';
  }
  assert.match(raw, /D\.D\./, '새 인식이 없는 프레임에는 손이 제자리라 깜빡인다');
  assert.ok(!held.slice(1).includes('.'), `유지하면 계속 그리는 중: ${held}`);
  // 손을 멈추면 곧 꺼진다
  for (let i = 0; i < 12; i++) latch.update(1 / 60, false);
  assert.equal(latch.value, false);
});

test('penOnFog: 김 위를 문지를 때만 true (맑은 유리, 이미 그린 선 위에서는 false)', () => {
  const f = new FogField(W, H);
  f.fill(1.3);
  const p = new PenTracker();
  const cell = f.cell;
  const opAt = (x) => p.update([fakeHand(1, x, 300)], DT)[0];
  let op = opAt(200);
  assert.equal(penOnFog(f.eraseCapsule(op.ax, op.ay, op.bx, op.by, op.r), op, cell), true, '김 위에 처음 닿음');
  for (let x = 210; x <= 400; x += 10) {
    op = opAt(x);
    assert.equal(penOnFog(f.eraseCapsule(op.ax, op.ay, op.bx, op.by, op.r), op, cell), true, `김 위로 ${x}`);
  }
  // 같은 선을 되돌아가며 (손 떨림처럼 조금 비껴서) 문지르면 닦을 김이 없다
  for (let x = 390; x >= 220; x -= 10) {
    op = p.update([fakeHand(1, x, 300 + (x % 20 ? 2 : -2))], DT)[0];
    assert.equal(penOnFog(f.eraseCapsule(op.ax, op.ay, op.bx, op.by, op.r), op, cell), false, `이미 닦인 선 ${x}`);
  }
  // 김이 전혀 없는 유리
  const g = new FogField(W, H);
  const q = new PenTracker();
  for (let x = 200; x <= 300; x += 10) {
    op = q.update([fakeHand(1, x, 300)], DT)[0];
    assert.equal(penOnFog(g.eraseCapsule(op.ax, op.ay, op.bx, op.by, op.r), op, g.cell), false);
  }
  assert.ok(Math.abs(sweptCells({ start: true, r: 8, len: 0 }, 4) - (Math.PI * 64) / 16) < 1e-9);
});

test('DripSim.wipe: 손가락·손바닥이 지나가면 물방울도 닦여 빠르게 사라진다', () => {
  const f = new FogField(W, H);
  f.fill(1.3);
  const d = new DripSim();
  const rng = mulberry32(2);
  const a = d.spawn(400, 300, 0.8, rng, 5);
  const b = d.spawn(700, 300, 0.8, rng, 5);
  for (let i = 0; i < 30; i++) d.step(DT, f, H, rng);
  // 400 근처를 가로로 쓱
  assert.equal(d.wipe(300, 305, 500, 305, 30), 1);
  assert.equal(a.dead, true);
  assert.equal(b.dead, false, '멀리 있는 물방울은 그대로');
  assert.equal(d.wiped, 1);
  assert.equal(d.wipe(300, 305, 500, 305, 30), 0, '한 번만 센다');
  let t = 0;
  while (d.drips.includes(a) && t < 2) {
    d.step(DT, f, H, rng);
    t += DT;
  }
  assert.ok(t < 0.3, `금방 사라짐 (${t.toFixed(2)}초)`);
  assert.ok(d.drips.includes(b));
  // 창 크기 비율대로 옮기기
  d.rescale(2, 0.5);
  assert.equal(b.x, 1400);
});

test('Coach: 얼굴은 보이는데 손이 3초 넘게 안 보이면 뒤로 물러나 손을 들라고 (너무 가까우면 그렇게)', () => {
  const c = new Coach();
  const base = { coverage: 0.8, blowing: false, drawing: false, wiping: false, drawn: 0, micEnabled: true, liveHands: 0, faces: 1, faceK: 0.25 };
  c.update(DT, base);
  assert.equal(c.phase, 'draw');
  let hint;
  for (let i = 0; i < 60 * 2.5; i++) hint = c.update(DT, base).hint;
  assert.equal(hint, HINTS.draw, '잠깐은 기다린다');
  for (let i = 0; i < 60; i++) hint = c.update(DT, base).hint;
  assert.equal(hint, HINTS.handAway);
  assert.match(HINTS.handAway, /한 걸음/);
  // 얼굴이 화면을 꽉 채울 만큼 가까우면
  assert.equal(c.update(DT, { ...base, faceK: 0.55 }).hint, HINTS.tooClose);
  // 손이 보이면 바로 그리기 안내
  assert.equal(c.update(DT, { ...base, liveHands: 1 }).hint, HINTS.draw);
  assert.match(HINTS.draw, /공중에/, '화면을 만지지 않고 공중에 그린다고 알려 준다');
  // 아무도 없으면(얼굴도 손도 없음) 엔진의 '손을 보여 주세요' 에 맡긴다
  for (let i = 0; i < 60 * 5; i++) hint = c.update(DT, { ...base, faces: 0 }).hint;
  assert.equal(hint, HINTS.draw);
  // 손 정보를 안 주면(예전 호출) 이 안내는 없다
  const d = new Coach();
  for (let i = 0; i < 60 * 5; i++) hint = d.update(DT, { ...base, liveHands: undefined }).hint;
  assert.equal(hint, HINTS.draw);
});

test('Coach: 손바닥 닦기 안내는 한 번 4초만, 그 뒤로는 다시 그리기 안내', () => {
  const c = new Coach({ toastGap: 0 });
  const base = { coverage: 0.8, blowing: false, drawing: true, wiping: false, drawn: 0.01, micEnabled: true, liveHands: 1, faces: 1 };
  const seen = [];
  for (let i = 0; i < 60 * 20; i++) {
    const h = c.update(DT, base).hint;
    if (seen[seen.length - 1]?.h !== h) seen.push({ h, t: i * DT });
  }
  assert.deepEqual(seen.map((x) => x.h), [HINTS.draw, HINTS.wipe, HINTS.draw]);
  const shown = seen[2].t - seen[1].t;
  assert.ok(shown > 3.8 && shown < 4.2, `${shown.toFixed(2)}초`);
  // 다음 김에서는 다시 한 번
  c.update(DT, { ...base, coverage: 0.02, drawing: false });
  c.update(DT, { ...base, coverage: 0.7 });
  let wipe = 0;
  for (let i = 0; i < 60 * 8; i++) if (c.update(DT, base).hint === HINTS.wipe) wipe++;
  assert.ok(wipe > 0);
});

test('Coach: 불기 단계에서 거의 불었으면 "조금 더 세게"', () => {
  const c = new Coach();
  const base = { coverage: 0, blowing: false, drawing: false, wiping: false, drawn: 0, micEnabled: true };
  assert.equal(c.update(DT, { ...base, trying: true, tryTime: 0.5 }).hint, HINTS.blow);
  assert.equal(c.update(DT, { ...base, trying: true, tryTime: 1.2 }).hint, HINTS.harder);
  // 잠깐 멈춰도 안내는 조금 더 남아 있다가 돌아간다
  let hint;
  for (let i = 0; i < 60; i++) hint = c.update(DT, base).hint;
  assert.equal(hint, HINTS.harder);
  for (let i = 0; i < 60 * 2; i++) hint = c.update(DT, base).hint;
  assert.equal(hint, HINTS.blow);
});

test('fogRenderScale: 큰 화면·레티나에서만 작은 캔버스에서 합친다', () => {
  // 보통 노트북·전시용 1080p 화면: 화면에 바로
  assert.deepEqual(fogRenderScale(1280, 720, 1), { scale: 1, comp: false });
  assert.equal(fogRenderScale(1920, 1080, 1).comp, false);
  assert.equal(fogRenderScale(1280, 720, 2).comp, false);
  // 1080p 레티나(4K 화소), 4K TV: 300만 화소 캔버스에서 합친 뒤 한 번 늘린다
  for (const [w, h, d] of [[1920, 1080, 2], [3840, 2160, 1], [1440, 900, 2]]) {
    const r = fogRenderScale(w, h, d);
    assert.equal(r.comp, true, `${w}x${h}@${d}`);
    assert.ok(w * h * r.scale * r.scale <= 3e6 + 1);
  }
  assert.equal(fogRenderScale(800, 600, 3).scale, 2, '기기 픽셀 비율은 2까지만');
});

test('창 크기가 바뀌면 입김 구름과 기억해 둔 입 위치도 같은 비율로', () => {
  const sp = new BreathSpread();
  sp.update(DT, [{ key: 'a', x: 400, y: 300, scale: 200, s: 1 }], W, H);
  const it = sp.items.get('a');
  const R = it.R;
  sp.rescale(2, 2);
  assert.deepEqual([it.x, it.y], [800, 600]);
  assert.ok(Math.abs(it.R - R * 2) < 1e-9);
  const s = new BlowSensor();
  s.update(DT, null, [{ id: 1, blow: 0, mouth: { x: 100, y: 200 }, width: 150, stale: false }], W, H);
  s.rescale(1.5, 1.5);
  assert.deepEqual([s.lastMouth.x, s.lastMouth.y], [150, 300]);
});
