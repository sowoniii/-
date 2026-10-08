// 비눗방울 놀이 단위 테스트:  node --test tests/bubbles.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthHand } from '../src/core/synth.js';
import { HandTracker } from '../src/core/handtracker.js';
import {
  CFG,
  BubbleWorld,
  waveAmount,
  wandParams,
  blowDir,
  easeOutBack,
  sweptHit,
  inCatchReach,
  ambientTarget,
  stepFree,
  separate,
  applyWind,
  flingVelocity,
  clampRadius,
  carriedStart,
  ownGuard,
  swatTarget,
  swatCenter,
  PalmVelocity,
} from '../src/modes/bubbles/physics.js';
import { desiredHint, HintCoach, HINTS, isMilestone, crossedMilestone, milestoneText } from '../src/modes/bubbles/coach.js';
import { PopEffects, FX_CAP } from '../src/modes/bubbles/effects.js';
import { pickBucket, BUCKETS, squashX, stepWandRings } from '../src/modes/bubbles/render.js';

// ------------------------------------------------------------------ 도우미

/** 같은 결과가 나오는 의사 난수 */
function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 진짜 손 추적기(HandTracker)로 합성 손을 넣어 비눗방울 세상을 돌린다 (main.js 와 같은 순서) */
function rig(seed = 7, { width = 1280, height = 720 } = {}) {
  const tracker = new HandTracker();
  const world = new BubbleWorld({ width, height, rng: seeded(seed) });
  const r = { world, t: 0, events: [], hands: [] };
  r.step = (specs, dt = 1 / 30) => {
    r.t += dt;
    const hands = tracker.update(specs.map((s) => ({ lm: synthHand({ size: 150, ...s }), side: s.side || 'right' })), r.t);
    const ev = world.update({ hands, dt, t: r.t });
    r.events.push(...ev);
    for (const h of hands) {
      h.started = null;
      h.ended = null;
    }
    r.hands = hands;
    return ev;
  };
  r.run = (seconds, specs, dt = 1 / 30) => {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) r.step(typeof specs === 'function' ? specs(i, n) : specs, dt);
  };
  r.pops = (cause) => r.events.filter((e) => e.type === 'pop' && (!cause || e.cause === cause));
  return r;
}

/** 손 객체를 직접 만든다 (모양·시간을 정밀하게 정하는 테스트용) */
function fakeHand(o = {}) {
  const x = o.x ?? 640;
  const y = o.y ?? 400;
  const size = o.size ?? 150;
  const lm = synthHand({ x, y, size, pose: o.pose === 'open' || !o.pose ? 'open' : o.pose });
  return {
    id: 1,
    pose: 'open',
    stale: false,
    size,
    palm: { x, y },
    tips: [4, 8, 12, 16, 20].map((i) => lm[i]),
    lm,
    velocity: { x: 0, y: 0 },
    age: 1,
    poseTime: 1,
    started: null,
    pinchPoint: { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 },
    ...o,
  };
}

/** 화면 안에 방울 하나 (바로 터질 수 있는 상태) */
function placeBubble(world, t, x, y, r = 40) {
  const b = world.spawnAmbient(t, [], true);
  b.x = x;
  b.y = y;
  b.r = r;
  b.vx = 0;
  b.vy = 0;
  b.immuneUntil = t;
  return b;
}

// ------------------------------------------------------------------ 순수 함수

test('흔들기 정도는 손 크기에 비례한 속도로 정해지고, 방울 크기는 손 크기의 0.2~0.7배', () => {
  assert.equal(waveAmount({ x: 0, y: 0 }, 150), 0);
  assert.equal(waveAmount({ x: 150 * 10, y: 0 }, 150), 1);
  // 같은 '손 크기/초' 면 큰 손이든 작은 손이든 같다
  assert.ok(Math.abs(waveAmount({ x: 300, y: 0 }, 100) - waveAmount({ x: 600, y: 0 }, 200)) < 1e-9);
  let prev = -1;
  for (let w = 0; w <= 1.0001; w += 0.1) {
    const p = wandParams(w);
    assert.ok(p.radiusMinK >= CFG.radiusK[0] && p.radiusMaxK <= CFG.radiusK[1], `w=${w}`);
    assert.ok(p.radiusMinK <= p.radiusMaxK);
    assert.ok(p.radiusMinK >= prev, '흔들수록 커진다');
    prev = p.radiusMinK;
  }
  assert.ok(wandParams(1).growTime < wandParams(0).growTime, '흔들면 빨리 부푼다');
  assert.ok(wandParams(1).trailRate > 0 && wandParams(0).trailRate === 0);
});

test('easeOutBack: 0→0, 1→1, 중간에 살짝 넘친다', () => {
  assert.ok(Math.abs(easeOutBack(0)) < 1e-9);
  assert.ok(Math.abs(easeOutBack(1) - 1) < 1e-9);
  assert.ok(Math.max(...[0.6, 0.7, 0.8, 0.9].map(easeOutBack)) > 1);
});

test('blowDir: 손가락이 위면 위로, 옆으로 누워도 위쪽 성분이 남는다', () => {
  const up = blowDir(fakeHand());
  assert.ok(Math.abs(up.x) < 0.2 && up.y < -0.95, JSON.stringify(up));
  const side = blowDir({ lm: synthHand({ x: 400, y: 400, size: 150, angle: Math.PI / 2, pose: 'open' }) });
  assert.ok(side.y < -0.5 && side.x > 0.5, JSON.stringify(side));
  assert.deepEqual(blowDir({}), { x: 0, y: -1 });
});

test('sweptHit: 프레임 사이에 빠르게 지나간 손가락도 잡아낸다', () => {
  const b = { x: 500, y: 300, r: 30 };
  assert.equal(sweptHit(b, { x: 300, y: 300 }, { x: 700, y: 300 }, 10), true);
  assert.equal(sweptHit(b, { x: 700, y: 300 }, { x: 700, y: 300 }, 10), false);
  assert.equal(sweptHit(b, { x: 300, y: 380 }, { x: 700, y: 380 }, 10), false);
  assert.equal(sweptHit(b, { x: 535, y: 300 }, { x: 535, y: 300 }, 10), true);
});

test('잡기 범위는 방울 반지름 + 손 크기의 절반', () => {
  const b = { x: 0, y: 0, r: 40 };
  assert.equal(inCatchReach(b, { x: 40 + 70, y: 0 }, 150), true);
  assert.equal(inCatchReach(b, { x: 40 + 80, y: 0 }, 150), false);
  assert.equal(inCatchReach(b, { x: 40 + 80, y: 0 }, 200), true);
});

test('추적이 튀어도 방울이 총알처럼 날아가지 않고, 손 크기와 상관없이 찌를 만한 크기', () => {
  const v = flingVelocity({ x: 9000, y: 0 }, 150);
  assert.ok(Math.abs(v.x - 150 * CFG.flingMax) < 1e-6 && v.y === 0);
  assert.deepEqual(flingVelocity({ x: 100, y: -50 }, 150), { x: 100, y: -50 });
  assert.equal(clampRadius(5, 1280, 720), 720 * CFG.screenRadiusK[0]);
  assert.equal(clampRadius(900, 1280, 720), 720 * CFG.screenRadiusK[1]);
  assert.equal(clampRadius(60, 1280, 720), 60);
  // 멀리 있는 작은 손(60px)도 너무 작은 방울을 만들지 않는다
  const r = rig(14);
  r.run(2, [{ x: 640, y: 450, size: 60, pose: 'open' }]);
  const made = r.events.filter((e) => e.type === 'detach').map((e) => e.b.r);
  assert.ok(made.length > 0);
  for (const rr of made) assert.ok(rr >= 720 * CFG.screenRadiusK[0] - 1e-6, `r=${rr}`);
});

test('떠다니는 방울: 둥실 떠오르고, 벽에 튕기고, 오래되면 터진다', () => {
  const w = new BubbleWorld({ width: 800, height: 600, rng: seeded(3) });
  const b = w.spawnAmbient(0, [], true);
  b.x = 400;
  b.y = 400;
  b.kind = 'hand';
  b.life = 10;
  let t = 0;
  for (let i = 0; i < 60; i++) stepFree(b, 1 / 60, (t += 1 / 60), 800, 600);
  assert.ok(b.y < 400 - 10, `위로 떠올라야 함 y=${b.y}`);
  // 왼쪽 벽으로 날아가면 튕겨 나온다
  b.x = 50;
  b.vx = -900;
  for (let i = 0; i < 30; i++) {
    stepFree(b, 1 / 60, (t += 1 / 60), 800, 600);
    assert.ok(b.x >= b.r - 1e-6, '벽 밖으로 나가면 안 됨');
  }
  assert.ok(b.vx > -50, '튕겨서 방향이 바뀌어야 함');
  // 수명이 다하면 'age'
  assert.equal(stepFree(b, 1 / 60, b.born + b.life + 0.1, 800, 600), 'age');
});

test('화면 위로 거의 나간 방울은 터지지만, 막 나온 방울은 조금 기다린다', () => {
  const w = new BubbleWorld({ width: 800, height: 600, rng: seeded(4) });
  const b = w.spawnAmbient(0, [], true);
  b.x = 300;
  b.y = 2;
  b.born = 0;
  b.life = 100;
  b.immuneUntil = 5;
  assert.equal(stepFree(b, 1 / 60, 1, 800, 600), null);
  b.y = 2;
  assert.equal(stepFree(b, 1 / 60, 6, 800, 600), 'ceiling');
});

test('아래에서 올라오는 방울은 바닥에 걸리지 않고, 내려오는 방울은 튕긴다', () => {
  const w = new BubbleWorld({ width: 800, height: 600, rng: seeded(5) });
  const up = w.spawnAmbient(0);
  assert.ok(up.y > 600);
  for (let i = 0; i < 20; i++) stepFree(up, 1 / 60, i / 60, 800, 600);
  assert.ok(up.y > 560 && up.vy < 0, `아래에서 계속 올라와야 함 y=${up.y}`);
  const down = w.spawnAmbient(0, [], true);
  down.y = 590;
  down.vy = 300;
  stepFree(down, 1 / 60, 0.1, 800, 600);
  assert.ok(down.y <= 600 - down.r + 1e-6 && down.vy < 0);
});

test('겹친 방울은 서로 밀어내고, 손에서 부푸는 방울은 밀리지 않는다', () => {
  const a = { id: 1, x: 100, y: 100, r: 40, vx: 0, vy: 0, jig: 0, jigV: 0, axis: 0, attached: null, dead: false };
  const b = { ...a, id: 2, x: 120 };
  for (let i = 0; i < 30; i++) separate([a, b], 1 / 60);
  assert.ok(b.x - a.x > 60, `떨어져야 함 ${b.x - a.x}`);
  const fixed = { ...a, id: 3, x: 300, attached: 9 };
  const c = { ...a, id: 4, x: 310 };
  separate([fixed, c], 1 / 60);
  assert.equal(fixed.x, 300);
  // 정확히 같은 자리여도 NaN 없이 밀린다
  const d = { ...a, id: 5, x: 500 };
  const e = { ...a, id: 6, x: 500 };
  separate([d, e], 1 / 60);
  assert.ok(Number.isFinite(d.x) && Number.isFinite(e.x) && d.x !== e.x);
});

test('바람: 빠르게 움직이는 펼친 손은 근처 방울을 손이 가는 쪽으로 민다', () => {
  const near = { x: 700, y: 400, r: 40, vx: 0, vy: 0, jigV: 0, attached: null, dead: false };
  const far = { ...near, x: 1200 };
  const still = fakeHand({ x: 640, y: 400 });
  assert.equal(applyWind([near, far], still, 1 / 60), 0);
  const moving = fakeHand({ x: 640, y: 400, velocity: { x: 900, y: 0 } });
  for (let i = 0; i < 10; i++) applyWind([near, far], moving, 1 / 60);
  assert.ok(near.vx > 100, `가까운 방울이 밀려야 함 vx=${near.vx}`);
  assert.equal(far.vx, 0);
});

test('떠다니는 방울 수: 아무도 없으면 조금, 누가 불고 있으면 0', () => {
  assert.equal(ambientTarget(0.5, 0, false), 0);
  assert.equal(ambientTarget(2, 0, false), CFG.ambientIdle);
  assert.equal(ambientTarget(0, 1, true), 0);
  assert.equal(ambientTarget(0, 1, false), CFG.ambientPlay);
});

// ------------------------------------------------------------------ 비눗방울 막대 (진짜 손 추적기 사용)

test('손바닥을 펴면 방울이 부풀었다가 떨어져 날아간다 (초당 몇 개)', () => {
  const r = rig(11);
  const open = { x: 640, y: 450, pose: 'open' };
  r.run(0.3, [open]);
  const w = [...r.world.wands.values()][0];
  assert.ok(w && w.growing, '손바닥에 부푸는 방울이 있어야 함');
  const g = w.growing;
  assert.ok(Math.abs(g.x - r.hands[0].palm.x) < r.hands[0].size * 0.6, '손바닥 근처에서 부푼다');
  r.run(2.7, [open]);
  const s = r.world.stats;
  assert.ok(s.emitted >= 5 && s.emitted <= 12, `3초 동안 ${s.emitted}개`);
  assert.equal(s.popped, 0, '펼친 손은 터뜨리지 않는다');
  const size = r.hands[0].size;
  const free = r.world.bubbles.filter((b) => b.attached === null && b.kind === 'hand');
  assert.ok(free.length >= 3);
  for (const b of free) {
    assert.ok(b.r >= size * 0.2 - 1 && b.r <= size * 0.7 + 1, `반지름 ${b.r} (손 ${size})`);
    assert.ok(b.y < r.hands[0].palm.y, '날아간 방울은 손보다 위로');
  }
});

test('펼친 손을 휘두르면 더 크고 많은 방울이 손이 가는 쪽으로 날아간다', () => {
  const still = rig(21);
  still.run(3, [{ x: 640, y: 450, pose: 'open' }]);
  const wave = rig(21);
  // 0.5초마다 왕복 (손 크기의 약 6배/초)
  wave.run(3, (i) => {
    const ph = (i % 30) / 30;
    const x = 640 + (ph < 0.5 ? -220 + ph * 2 * 440 : 220 - (ph - 0.5) * 2 * 440);
    return [{ x, y: 450, pose: 'open' }];
  });
  assert.ok(wave.world.stats.trail > 5, `작은 방울 ${wave.world.stats.trail}`);
  assert.ok(wave.world.stats.emitted > still.world.stats.emitted * 1.5, `${wave.world.stats.emitted} vs ${still.world.stats.emitted}`);
  assert.equal(wave.world.stats.popped, 0);
  assert.ok(wave.world.stats.waveTime > 0.5);
  const avgR = (rr) => {
    const hb = rr.events.filter((e) => e.type === 'detach' && e.b.kind === 'hand').map((e) => e.b.r);
    return hb.reduce((a, b) => a + b, 0) / hb.length;
  };
  assert.ok(avgR(wave) > avgR(still), `흔들면 더 크다 ${avgR(wave)} > ${avgR(still)}`);

  // 오른쪽으로 휙 → 오른쪽으로 날아간다
  const fling = rig(5);
  fling.run(0.5, [{ x: 300, y: 450, pose: 'open' }]);
  const n0 = fling.events.length;
  fling.run(0.4, (i, n) => [{ x: 300 + (i / n) * 600, y: 450, pose: 'open' }]);
  const flung = fling.events.slice(n0).filter((e) => e.type === 'trail' || e.type === 'detach');
  assert.ok(flung.length >= 2);
  const vx = flung.reduce((a, e) => a + e.b.vx, 0) / flung.length;
  assert.ok(vx > 150, `손이 가는 쪽으로 날아가야 함 vx=${vx}`);
});

test('여러 손: 손마다 따로 방울을 불고, 사라진 손은 정리된다', () => {
  const r = rig(31);
  const a = { x: 350, y: 450, pose: 'open', side: 'left' };
  const b = { x: 930, y: 450, pose: 'open', side: 'right' };
  r.run(1.5, [a, b]);
  assert.equal(r.world.wands.size, 2);
  for (const w of r.world.wands.values()) assert.ok(w.made >= 1, '두 손 모두 방울을 만든다');
  // 한 손이 사라지면 (추적기 여유 시간 0.2초 뒤) 그 손 상태가 정리된다
  r.run(0.5, [a]);
  assert.equal(r.world.wands.size, 1);
  assert.equal(r.world.bubbles.filter((x) => x.attached !== null).length, 1, '남은 손의 방울만 손에 붙어 있다');
  r.run(0.5, []);
  assert.equal(r.world.wands.size, 0);
  assert.equal(r.world.bubbles.filter((x) => x.attached !== null).length, 0);
});

test('손이 사라지면 많이 부푼 방울은 날아가고, 덜 부푼 방울은 사르르 사라진다 (점수 없음)', () => {
  const w = new BubbleWorld({ rng: seeded(2) });
  let t = 0;
  const h = fakeHand();
  for (let i = 0; i < 4; i++) w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  const g1 = [...w.wands.values()][0].growing;
  assert.ok(g1 && g1.grow < CFG.minReleaseGrow);
  const ev = w.update({ hands: [], dt: 1 / 60, t: (t += 1 / 60) });
  assert.ok(ev.some((e) => e.type === 'pop' && e.cause === 'fizzle' && e.b === g1));
  assert.equal(w.stats.popped, 0);

  const w2 = new BubbleWorld({ rng: seeded(2) });
  t = 0;
  for (let i = 0; i < 20; i++) w2.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  const g2 = [...w2.wands.values()][0].growing;
  assert.ok(g2 && g2.grow >= CFG.minReleaseGrow, `grow=${g2 && g2.grow}`);
  const ev2 = w2.update({ hands: [], dt: 1 / 60, t: (t += 1 / 60) });
  assert.ok(ev2.some((e) => e.type === 'detach' && e.b === g2));
  assert.equal(g2.attached, null);
  assert.ok(t < g2.immuneUntil, '날아간 방울도 잠깐은 안 터진다');
});

test('손 모양이 잠깐 흔들려도 부풀던 방울을 놓치지 않고, 오래 오므리면 놓는다', () => {
  const w = new BubbleWorld({ rng: seeded(8) });
  let t = 0;
  const h = fakeHand();
  for (let i = 0; i < 6; i++) w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  const g = [...w.wands.values()][0].growing;
  assert.ok(g);
  // 0.15초 동안 'other' 로 잘못 보임 → 그대로 붙잡고 있음
  h.pose = 'other';
  for (let i = 0; i < 9; i++) w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  assert.equal([...w.wands.values()][0].growing, g);
  assert.equal(g.attached, h.id);
  h.pose = 'open';
  w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  // 잠깐 놓친(stale) 손: 부풀기가 멈춘다
  h.stale = true;
  const before = g.grow;
  for (let i = 0; i < 6; i++) w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  assert.equal(g.grow, before);
  h.stale = false;
  // 오래 오므리면 놓는다
  h.pose = 'fist';
  for (let i = 0; i < 30; i++) w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  assert.equal([...w.wands.values()][0].growing, null);
  assert.ok(g.dead || g.attached === null, '날려 보내거나 사르르 사라진다');
  assert.equal(w.stats.popped, 0);
});

// ------------------------------------------------------------------ 터뜨리기

test('콕 찌르기: 가리키는 손가락 끝에 닿으면 뽁! (점수 +1)', () => {
  const r = rig(41);
  const point = { x: 640, y: 520, pose: 'point' };
  r.run(0.4, [point]);
  assert.equal(r.hands[0].pose, 'point');
  const tip = r.hands[0].tips[1];
  const b = placeBubble(r.world, r.t, tip.x + 20, tip.y - 10, 40);
  r.step([point]);
  const p = r.pops('poke');
  assert.equal(p.length, 1);
  assert.equal(p[0].b, b);
  assert.equal(p[0].counted, true);
  assert.equal(r.world.stats.popped, 1);
  assert.equal(r.world.stats.poked, 1);
});

test('콕 찌르기: 주먹·브이·집기 손도 손가락 끝으로 터뜨린다, 천천히 움직이는 펼친 손은 안 터뜨린다', () => {
  for (const pose of ['fist', 'v', 'pinch', 'other']) {
    const r = rig(42);
    const spec = { x: 640, y: 520, pose };
    r.run(0.4, [spec]);
    const tip = r.hands[0].tips[1];
    placeBubble(r.world, r.t, tip.x, tip.y, 35);
    r.step([spec]);
    assert.equal(r.world.stats.popped, 1, pose);
  }
  const r = rig(43);
  const open = { x: 640, y: 520, pose: 'open' };
  r.run(0.4, [open]);
  for (const tip of r.hands[0].tips) placeBubble(r.world, r.t, tip.x, tip.y, 35);
  placeBubble(r.world, r.t, r.hands[0].palm.x, r.hands[0].palm.y, 35);
  // 펼친 손을 방울 사이로 이리저리 (휘두르지 않고) 움직여도 — 최대 손 크기 2배/초
  r.run(3, (i) => [{ x: 640 + Math.sin(i / 10) * 100, y: 520, pose: 'open' }]);
  assert.equal(r.world.stats.popped, 0);
});

test('빠르게 휙 지나간 손가락도 방울을 터뜨린다 (프레임 사이 쓸기 판정)', () => {
  const w = new BubbleWorld({ rng: seeded(9) });
  let t = 0;
  const h = fakeHand({ pose: 'point', x: 300, y: 500 });
  for (let i = 0; i < 6; i++) w.update({ hands: [h], dt: 1 / 30, t: (t += 1 / 30) });
  const b = placeBubble(w, t, 0, 0, 30);
  // 이번 프레임에 손가락이 방울을 가로질러 간다 (손 크기 1.5배보다 짧은 이동)
  const h2 = fakeHand({ pose: 'point', x: 500, y: 500 });
  // 같은 손(같은 id)이 옮겨 간 것
  b.x = (h.tips[1].x + h2.tips[1].x) / 2;
  b.y = h.tips[1].y;
  w.update({ hands: [h2], dt: 1 / 30, t: (t += 1 / 30) });
  assert.equal(b.dead, true);
});

test('막 나온 방울은 0.8초 동안 안 터지고, 새로 나타난 손은 모양이 정해질 때까지 안 찌른다', () => {
  const w = new BubbleWorld({ rng: seeded(10) });
  let t = 0;
  const h = fakeHand({ pose: 'point', x: 640, y: 500 });
  w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  const b = placeBubble(w, t, h.tips[1].x, h.tips[1].y, 40);
  b.immuneUntil = t + 0.5;
  for (let i = 0; i < 20; i++) {
    b.x = h.tips[1].x;
    b.y = h.tips[1].y;
    w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  }
  assert.equal(b.dead, false, '아직 안 터짐');
  for (let i = 0; i < 25 && !b.dead; i++) {
    b.x = h.tips[1].x;
    b.y = h.tips[1].y;
    w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  }
  assert.equal(b.dead, true, '시간이 지나면 터짐');

  const w2 = new BubbleWorld({ rng: seeded(10) });
  const young = fakeHand({ id: 5, pose: 'other', age: 0.05 });
  w2.update({ hands: [young], dt: 1 / 60, t: 1 });
  const b2 = placeBubble(w2, 1, young.tips[1].x, young.tips[1].y, 40);
  w2.update({ hands: [young], dt: 1 / 60, t: 1.02 });
  assert.equal(b2.dead, false, '새 손은 바로 안 찌름');
  // 화면이 느려서(초당 3장) 시간은 지났어도, 손 모양이 정해질 만큼 프레임을 못 봤으면 안 찌른다
  const w4 = new BubbleWorld({ rng: seeded(10) });
  const slow = fakeHand({ id: 7, pose: 'other', age: 0 });
  let ts = 1;
  for (let i = 0; i < 3; i++) {
    slow.age = i * 0.33;
    w4.update({ hands: [slow], dt: 0.05, t: (ts += 0.33) });
  }
  const b4 = placeBubble(w4, ts, slow.tips[1].x, slow.tips[1].y, 40);
  slow.age = 1;
  w4.update({ hands: [slow], dt: 0.05, t: (ts += 0.33) });
  assert.equal(b4.dead, false, '느린 화면에서도 새 손은 바로 안 찌름');
  for (let i = 0; i < 3 && !b4.dead; i++) {
    b4.x = slow.tips[1].x;
    b4.y = slow.tips[1].y;
    w4.update({ hands: [slow], dt: 0.05, t: (ts += 0.33) });
  }
  assert.equal(b4.dead, true, '몇 프레임 지나면 찌른다');
  const stale = fakeHand({ id: 6, pose: 'point', stale: true });
  const w3 = new BubbleWorld({ rng: seeded(10) });
  const b3 = placeBubble(w3, 1, stale.tips[1].x, stale.tips[1].y, 40);
  w3.update({ hands: [stale], dt: 1 / 60, t: 1.02 });
  assert.equal(b3.dead, false, '잠깐 놓친 손은 안 찌름');
});

test('꽉 잡기: 펼친 손을 방울에 대고 주먹을 쥐면 잡았다! (점수 +1)', () => {
  const r = rig(51);
  const at = { x: 640, y: 450 };
  r.run(0.5, [{ ...at, pose: 'open' }]);
  const palm = r.hands[0].palm;
  const b = placeBubble(r.world, r.t, palm.x + 40, palm.y + 30, 45);
  r.run(0.3, [{ ...at, pose: 'fist' }]);
  const c = r.events.filter((e) => e.type === 'catch');
  assert.equal(c.length, 1);
  assert.ok(c[0].n >= 1);
  assert.equal(b.dead, true);
  assert.ok(r.pops('catch').some((e) => e.b === b && e.counted));
  assert.equal(r.world.stats.caught, r.pops('catch').length);
  assert.equal(r.world.stats.popped, r.world.stats.caught + r.world.stats.poked);
});

test('꽉 잡기: 엄지와 검지로 집어도 잡힌다, 멀리 있는 방울은 안 잡힌다', () => {
  const r = rig(52);
  const at = { x: 640, y: 450 };
  r.run(0.5, [{ ...at, pose: 'open' }]);
  // 집기 손 모양의 집는 곳 (손바닥 기준 위치)을 미리 알아 둔다
  const pinchLm = synthHand({ ...at, size: 150, pose: 'pinch' });
  const pp = { x: (pinchLm[4].x + pinchLm[8].x) / 2, y: (pinchLm[4].y + pinchLm[8].y) / 2 };
  const near = placeBubble(r.world, r.t, pp.x + 25, pp.y - 30, 30);
  const far = placeBubble(r.world, r.t, 1150, 150, 30);
  r.run(0.3, [{ ...at, pose: 'pinch' }]);
  assert.equal(near.dead, true);
  assert.equal(far.dead, false);
  assert.ok(r.events.some((e) => e.type === 'catch' && e.pose === 'pinch'));
});

test('천천히 쥐어서 손 모양이 잠깐 애매하게(other) 보여도, 손바닥 근처 방울은 잡기로 친다', () => {
  const w = new BubbleWorld({ rng: seeded(12) });
  let t = 0;
  const h = fakeHand({ x: 640, y: 450 });
  for (let i = 0; i < 10; i++) w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  // 오므리는 중: 'other' 손 모양, 손가락 끝이 손바닥 쪽으로 들어온 방울에 닿는다
  const closing = fakeHand({ x: 640, y: 450, pose: 'other' });
  Object.assign(h, { pose: 'other', tips: closing.tips, lm: closing.lm });
  const b = placeBubble(w, t, h.tips[2].x, h.tips[2].y, 30);
  assert.ok(inCatchReach(b, h.palm, h.size));
  const ev = w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  assert.ok(ev.some((e) => e.type === 'pop' && e.cause === 'catch' && e.b === b));
  assert.ok(ev.some((e) => e.type === 'catch' && e.n === 1));
  // 한참 뒤에 'other' 손으로 닿으면 그냥 콕
  for (let i = 0; i < 40; i++) w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  const b2 = placeBubble(w, t, h.tips[2].x, h.tips[2].y, 30);
  const ev2 = w.update({ hands: [h], dt: 1 / 60, t: (t += 1 / 60) });
  assert.ok(ev2.some((e) => e.type === 'pop' && e.cause === 'poke' && e.b === b2));
  // 펼쳤다가 바로 가리키기로 바꿔 찌르면 잡기가 아니라 콕
  const w3 = new BubbleWorld({ rng: seeded(12) });
  t = 0;
  const p = fakeHand({ x: 640, y: 450 });
  for (let i = 0; i < 10; i++) w3.update({ hands: [p], dt: 1 / 60, t: (t += 1 / 60) });
  const pt = fakeHand({ x: 640, y: 450, pose: 'point' });
  Object.assign(p, { pose: 'point', tips: pt.tips, lm: pt.lm });
  const b3 = placeBubble(w3, t, p.tips[1].x, p.tips[1].y, 30);
  const ev3 = w3.update({ hands: [p], dt: 1 / 60, t: (t += 1 / 60) });
  assert.ok(ev3.some((e) => e.type === 'pop' && e.cause === 'poke' && e.b === b3));
});

test('계속 불어도 방울이 손바닥 위에 쌓이지 않고 좌우로 벌어지며 올라간다', () => {
  const r = rig(13);
  r.run(4, [{ x: 640, y: 450, pose: 'open' }]);
  const palm = r.hands[0].palm;
  const free = r.world.bubbles.filter((b) => b.attached === null && b.kind === 'hand');
  assert.ok(free.length >= 6, `${free.length}`);
  for (const b of free) assert.ok(b.y < palm.y - 30, `손바닥 위로 올라가야 함 y=${b.y.toFixed(0)}`);
  assert.ok(free.some((b) => b.x < palm.x - 20) && free.some((b) => b.x > palm.x + 20), '좌우로 번갈아 벌어진다');
  // 가까이 붙어 겹친 방울이 거의 없다
  let overlaps = 0;
  for (let i = 0; i < free.length; i++)
    for (let j = i + 1; j < free.length; j++) if (Math.hypot(free[i].x - free[j].x, free[i].y - free[j].y) < (free[i].r + free[j].r) * 0.7) overlaps++;
  assert.ok(overlaps <= 1, `겹침 ${overlaps}`);
});

test('저절로 터지는 방울(오래됨·위로 나감·너무 많음)은 점수에 안 셈', () => {
  const r = rig(61);
  r.run(3, [{ x: 640, y: 300, pose: 'open' }]);
  r.run(14, []);
  assert.ok(r.world.stats.natural > 0);
  assert.equal(r.world.stats.popped, 0);
  assert.ok(r.pops().every((e) => !e.counted));
});

test('방울 수 상한: 네 손이 마구 흔들어도 60개를 넘지 않고, 오래된 방울부터 비킨다', () => {
  const r = rig(71);
  let max = 0;
  for (let i = 0; i < 240; i++) {
    const s = Math.sin(i / 3) * 200;
    r.step([
      { x: 300 + s, y: 500, pose: 'open', side: 'left' },
      { x: 980 - s, y: 500, pose: 'open', side: 'right' },
      { x: 640 + s, y: 300, pose: 'open', side: 'left' },
      { x: 640 - s, y: 600, pose: 'open', side: 'right' },
    ]);
    max = Math.max(max, r.world.bubbles.length);
  }
  assert.ok(max <= CFG.maxBubbles, `최대 ${max}개`);
  assert.ok(max >= CFG.maxBubbles - 5, `꽉 찰 만큼 불었다 (${max})`);
  assert.ok(r.pops('crowd').length > 0, '꽉 차면 오래된 방울이 터져서 자리를 만든다');
  // 휘두르는 펼친 손끼리는 서로의 방울을 휙 쳐서 터뜨릴 수 있지만, 콕·잡기는 없다
  assert.equal(r.world.stats.popped, r.world.stats.swatted);
});

test('아무도 없으면 방울이 몇 개 떠다니고, 손바닥을 펴면 더 띄우지 않는다', () => {
  const r = rig(81);
  r.run(12, []);
  const free = r.world.bubbles.filter((b) => b.attached === null).length;
  assert.ok(free >= 3 && free <= CFG.ambientIdle + 1, `free=${free}`);
  const amb = r.world.stats.ambient;
  r.run(3, [{ x: 640, y: 450, pose: 'open' }]);
  assert.equal(r.world.stats.ambient, amb);
});

test('창 크기가 바뀌면 방울을 화면 안으로 옮긴다', () => {
  const r = rig(91);
  r.run(4, [{ x: 1100, y: 500, pose: 'open' }]);
  r.world.resize(600, 400);
  for (const b of r.world.bubbles) assert.ok(b.x >= b.r - 1e-6 && b.x <= 600 - b.r + 1e-6);
  r.run(1, []);
  for (const b of r.world.bubbles) assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
});

// ------------------------------------------------------------------ 진짜 카메라처럼 흔들릴 때

test('손끝이 쓸고 간 길: 손 전체가 움직인 만큼만 (손 모양이 바뀌며 휙 옮겨진 건 빼고)', () => {
  const pf = { x: 100, y: 100, ang: 0, size: 100 };
  // 손이 오른쪽으로 50 옮겨지면서 손끝도 50 → 지난 손끝부터 지금 손끝까지 쓸기
  assert.deepEqual(carriedStart({ x: 100, y: 0 }, pf, { ...pf, x: 150 }, { x: 150, y: 0 }), { x: 100, y: 0 });
  // 손은 그대로인데 손끝만 휙 (펼침→오므림, 잘못 보인 프레임) → 지금 자리만
  assert.deepEqual(carriedStart({ x: 100, y: 0 }, pf, pf, { x: 100, y: 80 }), { x: 100, y: 80 });
  // 손이 손바닥을 중심으로 90° 돌면 손끝도 같이 돈다
  const st = carriedStart({ x: 100, y: 0 }, pf, { ...pf, ang: Math.PI / 2 }, { x: 200, y: 100 });
  assert.ok(Math.hypot(st.x - 100, st.y - 0) < 1e-6, JSON.stringify(st));
  // 옮겨지면서 모양도 바뀌면 옮겨진 만큼만 거슬러 올라간다
  const mix = carriedStart({ x: 100, y: 0 }, pf, { ...pf, x: 130 }, { x: 130, y: 70 });
  assert.ok(Math.abs(mix.x - 100) < 1e-6 && Math.abs(mix.y - 70) < 1e-6, JSON.stringify(mix));
  // 추적이 크게 튀면 쓸지 않는다
  assert.deepEqual(carriedStart({ x: 100, y: 0 }, pf, { ...pf, x: 400 }, { x: 400, y: 0 }), { x: 400, y: 0 });
});

test('내 방울 지키기: 방금까지 불던 손, 또는 아직 어리고 손바닥 가까이 있는 내 방울만', () => {
  const h = { id: 1, palm: { x: 0, y: 0 }, size: 100 };
  const near = { owner: 1, born: 9, x: 0, y: -80 };
  const far = { owner: 1, born: 9, x: 0, y: -300 };
  assert.equal(ownGuard(far, h, 9.8, 10), true, '방금까지 펼쳐서 불던 손');
  assert.equal(ownGuard(near, h, 5, 10), true, '어리고 가까운 내 방울');
  assert.equal(ownGuard(far, h, 5, 10), false, '멀리 떠난 내 방울은 콕 할 수 있다');
  assert.equal(ownGuard({ ...near, born: 7 }, h, 5, 10), false, '오래된 내 방울은 콕 할 수 있다');
  assert.equal(ownGuard({ ...near, owner: 2 }, h, 9.9, 10), false, '친구 방울은 언제나 콕');
  assert.equal(ownGuard({ ...near, owner: null }, h, 9.9, 10), false, '떠다니는 방울도 언제나 콕');
  assert.equal(swatTarget({ owner: 1, born: 9.5 }, 1, 10), false);
  assert.equal(swatTarget({ owner: 1, born: 8 }, 1, 10), true);
  assert.equal(swatTarget({ owner: null, born: 9.9 }, 1, 10), true);
});

/** 불던 손을 카메라가 가끔 몇 프레임 다른 모양으로 잘못 본다 (주먹·브이·가리키기·집기 3프레임, 그 밖 6프레임) */
function flickerRun(seed, size, seconds = 20) {
  const r = rig(seed);
  const poses = ['v', 'point', 'fist', 'other', 'pinch'];
  let left = 0;
  let fp = 'open';
  let k = 0;
  const seen = new Set();
  const n = Math.round(seconds * 30);
  for (let i = 0; i < n; i++) {
    // 손이 처음 나타날 때 생긴 떠다니는 방울은 치운다 — 이 시험은 '내가 분 방울' 만 본다
    // (남의 방울이 손바닥 안에 있을 때 주먹으로 보이면 그건 잡기로 친다)
    if (i === 20) for (const b of r.world.bubbles) if (b.kind === 'ambient') b.dead = true;
    if (left <= 0 && i > 30 && i % 50 === 0) {
      fp = poses[k++ % poses.length];
      left = fp === 'other' ? 6 : 3;
    }
    const pose = left > 0 ? fp : 'open';
    if (left > 0) left--;
    r.step([{ x: 640, y: 520, size, pose }]);
    if (r.hands[0] && r.hands[0].pose !== 'open') seen.add(r.hands[0].pose);
  }
  return { r, seen, id: r.hands[0].id };
}

test('카메라가 불던 손을 잠깐 다른 모양으로 잘못 봐도, 그 손이 분 방울은 터지지 않는다 (손이 커도)', () => {
  for (const size of [110, 180, 250]) {
    for (const seed of [1, 2, 3]) {
      const { r, seen, id } = flickerRun(seed, size);
      // 정말로 손 모양이 잠깐씩 바뀌었는지 (안정화를 통과한 잘못 보임)
      assert.ok(seen.has('fist') && seen.has('v') && seen.has('other'), [...seen].join());
      assert.ok(r.world.stats.emitted > 30, `emitted ${r.world.stats.emitted}`);
      const own = r.pops().filter((e) => e.counted && e.b.owner === id);
      assert.equal(own.length, 0, `size ${size} seed ${seed}: 내 방울 ${own.map((e) => e.cause).join(',')}`);
      assert.ok(!r.events.some((e) => e.type === 'catch'), '잡았다! 가 나오면 안 됨');
    }
  }
});

test('불던 손이 몇 프레임 주먹으로 보여도 부풀던 방울은 손바닥을 따라다니다 계속 부푼다', () => {
  const r = rig(3);
  const open = { x: 640, y: 450, pose: 'open' };
  let g = null;
  for (let i = 0; i < 90 && !g; i++) {
    r.step([open]);
    const w = r.world.wands.get(r.hands[0].id);
    if (w && w.growing && w.growing.grow > 0.15 && w.growing.grow < 0.4) g = w.growing;
  }
  assert.ok(g);
  // 주먹 3프레임 + 손이 살짝 옮겨진다
  let sawFist = false;
  for (let i = 0; i < 3; i++) {
    r.step([{ x: 660, y: 440, pose: 'fist' }]);
    sawFist ||= r.hands[0].pose === 'fist';
  }
  for (let i = 0; i < 3; i++) {
    r.step([{ x: 660, y: 440, pose: 'open' }]);
    sawFist ||= r.hands[0].pose === 'fist';
    if (!g.dead && g.attached !== null) assert.ok(Math.abs(g.x - r.hands[0].palm.x) < r.hands[0].size * 0.5, '손바닥을 따라간다');
  }
  assert.ok(sawFist, '주먹으로 잘못 보인 프레임이 있어야 함');
  r.run(0.8, [{ x: 660, y: 440, pose: 'open' }]);
  assert.ok(!r.events.some((e) => e.type === 'catch'));
  assert.ok(r.events.some((e) => e.type === 'detach' && e.b === g), '다시 펴면 다 부풀어서 날아간다');
  assert.equal(r.world.stats.popped, 0);
});

test('불던 방울을 꽉 쥐면 잡았다! (손 안에서 멈춰 있다가 도망가지 않는다)', () => {
  const r = rig(4);
  const at = { x: 640, y: 450 };
  let g = null;
  for (let i = 0; i < 90 && !g; i++) {
    r.step([{ ...at, pose: 'open' }]);
    const w = r.world.wands.get(r.hands[0].id);
    if (w && w.growing && w.growing.grow >= 0.6 && w.growing.grow < 0.9) g = w.growing;
  }
  assert.ok(g);
  const n0 = r.events.length;
  r.run(0.6, [{ ...at, pose: 'fist' }]);
  const after = r.events.slice(n0);
  assert.ok(after.some((e) => e.type === 'pop' && e.cause === 'catch' && e.b === g && e.counted), '불던 방울이 잡힌다');
  assert.ok(after.some((e) => e.type === 'catch' && e.n >= 1));
  assert.ok(!after.some((e) => e.type === 'detach' && !e.b.dead), '주먹 밖으로 날아가는 방울이 없다');
  assert.equal(r.world.stats.caught, r.world.stats.popped);
});

test('펼친 손을 방울에 대고 꽉 쥐면: 그 방울과 손바닥 방울을 한 번에 잡고, 아무것도 주먹 밖으로 안 도망간다', () => {
  let escaped = 0;
  let target = 0;
  for (let k = 0; k < 24; k++) {
    const r = rig(100 + k);
    const at = { x: 640, y: 420 };
    r.run(0.15, [{ ...at, pose: 'open' }]);
    const palm = r.hands[0].palm;
    const b = placeBubble(r.world, r.t, palm.x + 30, palm.y - 20, 40);
    r.run(0.1 + (k % 8) * 0.07, [{ ...at, pose: 'open' }]);
    const n0 = r.events.length;
    r.run(1, [{ ...at, pose: 'fist' }]);
    const after = r.events.slice(n0);
    if (b.dead && r.pops('catch').some((e) => e.b === b)) target++;
    escaped += after.filter((e) => e.type === 'detach' && !e.b.dead).length;
    assert.ok(after.filter((e) => e.type === 'catch').length <= 1, '잡았다! 는 한 번');
  }
  assert.equal(target, 24);
  assert.equal(escaped, 0);
});

test('천천히 오므리다(그 밖 모양) 놓친 방울도 이어서 주먹을 쥐면 잡힌다', () => {
  const r = rig(9);
  const at = { x: 640, y: 450 };
  let g = null;
  // 막 부풀기 시작한 방울 (손 모양이 'other' 로 바뀌는 데 몇 프레임 걸리는 동안 절반쯤 부푼다)
  for (let i = 0; i < 90 && !g; i++) {
    r.step([{ ...at, pose: 'open' }]);
    const w = r.world.wands.get(r.hands[0].id);
    if (w && w.growing && w.growing.grow >= 0.15 && w.growing.grow < 0.25) g = w.growing;
  }
  assert.ok(g);
  r.run(0.5, [{ ...at, pose: 'other' }]);
  assert.equal(g.attached, null, '오래 오므리면 놓는다');
  assert.equal(g.dead, false);
  assert.equal(r.world.stats.released, 1);
  r.run(0.5, [{ ...at, pose: 'fist' }]);
  assert.ok(r.pops('catch').some((e) => e.b === g && e.counted), '놓친 방울을 주먹으로 잡는다');
});

test('불다가 일부러 가리키기로 바꾸면, 조금 뒤엔 내 방울도 콕 터뜨릴 수 있다', () => {
  const r = rig(15);
  r.run(1.5, [{ x: 640, y: 520, pose: 'open' }]);
  const id = r.hands[0].id;
  const point = { x: 640, y: 520, pose: 'point' };
  r.run(0.12, [point]);
  assert.equal(r.hands[0].pose, 'point');
  const tip = r.hands[0].tips[1];
  const b = placeBubble(r.world, r.t, tip.x, tip.y - 10, 40);
  b.owner = id;
  b.born = r.t - 3;
  r.step([point]);
  assert.equal(b.dead, false, '방금까지 불던 손은 아직 안 터뜨림');
  for (let i = 0; i < 20 && !b.dead; i++) {
    b.x = r.hands[0].tips[1].x;
    b.y = r.hands[0].tips[1].y - 10;
    r.step([point]);
  }
  assert.ok(r.pops('poke').some((e) => e.b === b), '조금 뒤엔 콕');
});

test('손 속도는 직접 잰다: 잠깐 놓쳤다 다시 찾아도 튀지 않는다', () => {
  const pv = new PalmVelocity();
  let t = 0;
  for (let i = 0; i < 12; i++) {
    t += 1 / 30;
    pv.push(300 * t, 0, t);
  }
  assert.ok(Math.abs(pv.x - 300) < 1, `${pv.x}`);
  // 3프레임 놓친 뒤
  t += 4 / 30;
  pv.push(300 * t, 0, t);
  assert.ok(Math.abs(pv.x - 300) < 1, `놓친 뒤 ${pv.x}`);
  // 화면(60fps)이 검출(30fps)보다 빨라 같은 위치가 두 번씩 들어와도
  const p2 = new PalmVelocity();
  let t2 = 0;
  let x = 0;
  for (let i = 0; i < 40; i++) {
    t2 += 1 / 60;
    if (i % 2 === 0) x += 10;
    p2.push(x, 0, t2);
  }
  assert.ok(p2.x > 250 && p2.x < 350, `${p2.x}`);
  // 멈추면 0
  for (let i = 0; i < 10; i++) p2.push(x, 0, (t2 += 1 / 60));
  assert.equal(p2.x, 0);

  // 진짜 손 추적기: 흔들다가 3프레임 놓치면 추적기 속도는 3배 넘게 튀지만, 방울 세상은 튀지 않는다
  const r = rig(3);
  let hx = 300;
  let trkMax = 0;
  let mineMax = 0;
  let waveMax = 0;
  for (let i = 0; i < 50; i++) {
    hx += 450 / 30;
    const drop = i >= 30 && i < 33;
    r.step(drop ? [] : [{ x: hx, y: 450, pose: 'open' }]);
    if (i >= 33) {
      const h = r.hands[0];
      const w = r.world.wands.get(h.id);
      trkMax = Math.max(trkMax, Math.hypot(h.velocity.x, h.velocity.y));
      mineMax = Math.max(mineMax, Math.hypot(w.v.x, w.v.y));
      waveMax = Math.max(waveMax, r.world.wave);
    }
  }
  // (예전 추적기는 여기서 1000px/s 넘게 튀었다. 지금은 추적기도 실제 경과 시간으로 잰다)
  assert.ok(trkMax < 450 * 1.5, `추적기 속도 ${trkMax}`);
  assert.ok(mineMax < 450 * 1.5, `직접 잰 속도 ${mineMax}`);
  assert.ok(waveMax < 0.9, `흔들기 정도 ${waveMax}`);

  // 화면이 아주 느려서(초당 5장) 놀이 시계(dt 0.05 로 잘림)가 실제보다 천천히 가도, 속도는 실제 시간으로 잰다
  const w = new BubbleWorld({ rng: seeded(2) });
  const h = fakeHand({ x: 200, y: 400 });
  let clock = 0;
  let now = 0;
  for (let i = 0; i < 6; i++) {
    clock += 0.05;
    now += 0.2;
    h.palm = { x: 200 + 300 * now, y: 400 };
    w.update({ hands: [h], dt: 0.05, t: clock, now });
  }
  const sp = Math.hypot(w.wands.get(1).v.x, w.wands.get(1).v.y);
  assert.ok(Math.abs(sp - 300) < 1, `느린 화면에서 속도 ${sp}`);
});

test('펼친 손을 휙 휘둘러 치면 터진다 (내가 막 분 방울은 빼고), 천천히 지나가면 안 터진다', () => {
  const r = rig(6);
  r.run(0.5, [{ x: 300, y: 450, pose: 'open' }]);
  const c = swatCenter(r.hands[0]);
  const b = placeBubble(r.world, r.t, 640, c.y, 40);
  // 0.6초에 540px (손 크기 6배/초)
  r.run(0.6, (i, n) => [{ x: 300 + (540 * (i + 1)) / n, y: 450, pose: 'open' }]);
  const sw = r.pops('swat');
  assert.ok(sw.some((e) => e.b === b && e.counted), '휙 치면 뽁!');
  assert.equal(r.world.stats.swatted, sw.length);
  assert.ok(sw.every((e) => e.b.owner !== r.hands[0].id), '내가 막 분 방울은 안 터뜨림');

  const slow = rig(6);
  slow.run(0.5, [{ x: 300, y: 450, pose: 'open' }]);
  const c2 = swatCenter(slow.hands[0]);
  const b2 = placeBubble(slow.world, slow.t, 400, c2.y, 40);
  slow.run(2, (i, n) => [{ x: 300 + (240 * (i + 1)) / n, y: 450, pose: 'open' }]);
  assert.equal(b2.dead, false, '천천히 지나가면 불기만 한다');
  assert.equal(slow.world.stats.popped, 0);
});

test('손바닥 고리: 잠깐 놓친 손은 그대로, 사라진 손은 그 자리에서 스르르', () => {
  const rings = new Map();
  const h = { id: 1, pose: 'open', stale: false, palm: { x: 100, y: 200 }, size: 150 };
  for (let i = 0; i < 60; i++) stepWandRings(rings, [h], 1 / 60);
  assert.ok(rings.get(1).v > 0.99);
  h.stale = true;
  for (let i = 0; i < 4; i++) stepWandRings(rings, [h], 1 / 60);
  assert.ok(rings.get(1).v > 0.99, '잠깐 놓쳐도 작아지지 않는다');
  h.stale = false;
  h.pose = 'point';
  stepWandRings(rings, [h], 1 / 60);
  assert.ok(rings.get(1).v < 0.9, '오므리면 작아진다');
  h.pose = 'open';
  for (let i = 0; i < 60; i++) stepWandRings(rings, [h], 1 / 60);
  stepWandRings(rings, [], 1 / 60);
  const r = rings.get(1);
  assert.ok(r && r.v > 0.5 && r.x === 100 && r.y === 200, '사라진 자리에서 스르르');
  for (let i = 0; i < 60; i++) stepWandRings(rings, [], 1 / 60);
  assert.equal(rings.size, 0);
});

// ------------------------------------------------------------------ 안내·축하

test('안내 단계: 펴기 → 찌르기 → 잡기 → 흔들기 → 마음껏', () => {
  const s = { live: 1, emitted: 0, popped: 0, caught: 0, bubbles: 0, waved: false };
  assert.equal(desiredHint({ ...s, live: 0 }), null);
  assert.equal(desiredHint(s), null);
  assert.equal(desiredHint({ ...s, emitted: 3, bubbles: 3 }), 'poke');
  assert.equal(desiredHint({ ...s, emitted: 3, bubbles: 3, popped: 1 }), 'catch');
  assert.equal(desiredHint({ ...s, emitted: 3, popped: 2, caught: 1 }), 'wave');
  assert.equal(desiredHint({ ...s, emitted: 3, popped: 2, caught: 1, waved: true }), 'free');
  assert.equal(desiredHint({ ...s, emitted: 3, popped: 1 }, new Set(['catch'])), 'wave');
  // 떠다니는 방울만 콕콕 하고 아직 손바닥으로 불어 본 적 없으면 '손바닥 펴기' 가 먼저
  assert.equal(desiredHint({ ...s, emitted: 0, popped: 4, bubbles: 2 }), null);
  assert.ok(HINTS.poke.includes('콕'));
});

test('HintCoach: 불기만 하고 못 터뜨려도 "손바닥 펴기" 로 되돌아가지 않고 쉬운 안내를 이어 간다', () => {
  const c = new HintCoach();
  const seen = [];
  for (let i = 0; i < 60 * 60; i++) {
    const h = c.update(1 / 60, { live: 1, emitted: 3 + i, popped: 0, caught: 0, bubbles: 6, waved: false });
    assert.notEqual(h, null, `${(i / 60).toFixed(1)}초에 기본 문구로 돌아감`);
    if (seen[seen.length - 1] !== c.current) seen.push(c.current);
  }
  assert.deepEqual(seen.slice(0, 3), ['poke', 'poke2', 'catch']);
  assert.ok(HINTS.poke2.includes('콕'));
  // 방울이 하나도 없으면 먼저 불어야 하니 기본 문구
  assert.equal(desiredHint({ live: 1, emitted: 3, popped: 0, caught: 0, bubbles: 0, waved: false }), null);
});

test('HintCoach: 너무 자주 안 바뀌고, 오래 본 안내는 졸업한다', () => {
  const c = new HintCoach({ minShow: 2, maxShow: 6 });
  const s = { live: 1, emitted: 3, popped: 0, caught: 0, bubbles: 3, waved: false };
  assert.equal(c.update(0.1, s), HINTS.poke);
  // 바로 터뜨려도 2초는 찌르기 안내 유지
  assert.equal(c.update(0.5, { ...s, popped: 1 }), HINTS.poke);
  assert.equal(c.update(2, { ...s, popped: 1 }), HINTS.catch);
  // 잡기를 못 해도 6초 넘게 보면 다음 단계로
  for (let i = 0; i < 70; i++) c.update(0.1, { ...s, popped: 1 });
  assert.equal(c.current, 'wave');
  assert.ok(c.done.has('catch'));
  // 마지막 '마음껏 놀기' 는 졸업하지 않고 계속 보인다
  for (let i = 0; i < 200; i++) c.update(0.1, { ...s, popped: 5, caught: 1, waved: true });
  assert.equal(c.current, 'free');
  assert.ok(!c.done.has('free'));
});

test('축하 개수와 문구', () => {
  assert.deepEqual([...Array(160).keys()].filter(isMilestone), [10, 25, 50, 75, 100, 150]);
  assert.equal(crossedMilestone(8, 9), null);
  assert.equal(crossedMilestone(9, 10), 10);
  assert.equal(crossedMilestone(8, 12), 10);
  assert.equal(crossedMilestone(24, 26), 25);
  for (const n of [10, 25, 50, 75, 100, 150]) assert.ok(milestoneText(n).includes(String(n)));
});

// ------------------------------------------------------------------ 효과·그림

test('터지는 효과: 입자 수 상한, 시간이 지나면 사라진다', () => {
  const fx = new PopEffects(seeded(1));
  for (let i = 0; i < 200; i++) fx.pop(100 + i, 200, 80, i % 2 ? 'poke' : 'natural', 0.3);
  fx.caught(300, 300, 150, 2);
  assert.ok(fx.rings.length <= FX_CAP.rings);
  assert.ok(fx.drops.length <= FX_CAP.drops);
  assert.ok(fx.words.length <= FX_CAP.words);
  assert.ok(fx.stars.length <= FX_CAP.stars);
  assert.ok(fx.words.every((w) => w.y >= 104), '글자는 안내 말풍선 아래에서');
  fx.width = 800;
  fx.pop(795, 300, 60, 'poke');
  fx.pop(3, 300, 60, 'poke');
  const [a, b] = fx.words.slice(-2);
  assert.ok(a.x < 800 - a.size * 0.5 && b.x > b.size * 0.5, '글자가 화면 옆으로 잘리지 않는다');
  for (let i = 0; i < 90; i++) fx.update(1 / 60);
  assert.equal(fx.count, 0);
});

test('말랑 찌그러짐: 가로로 부딪히면 가로로, 세로로 부딪히면 세로로 늘어난다', () => {
  assert.ok(Math.abs(squashX(1.2, 0) - 1.2) < 1e-9);
  assert.ok(Math.abs(squashX(1.2, Math.PI / 2) - 0.8) < 1e-9, '세로로 늘어나면 가로 배율은 작아진다');
  assert.ok(Math.abs(squashX(1.2, Math.PI / 4) - 1) < 1e-9);
  assert.equal(squashX(1, 0.7), 1);
});

test('스프라이트 버킷: 조금 큰 것을 골라 줄여 그린다', () => {
  assert.equal(pickBucket(1), 0);
  assert.equal(BUCKETS[pickBucket(70)] >= 70 * 0.85, true);
  assert.equal(pickBucket(5000), BUCKETS.length - 1);
});

// ------------------------------------------------------------------ 놀이 전체 (가짜 app·캔버스)

test('놀이 전체: 여러 손으로 오래 놀아도 오류 없이 돌고, 나갈 때 소리를 끈다', async () => {
  // 노드에는 캔버스가 없으므로 아무것도 안 하는 2D 컨텍스트를 흉내 낸다
  const calls = { drawImage: 0, fillText: 0 };
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const fakeCtx = new Proxy(
    {},
    {
      get(target, k) {
        if (k in target) return target[k];
        if (k === 'measureText') return (s) => ({ width: String(s).length * 16 });
        if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createConicGradient') return () => gradient;
        if (k === 'drawImage') return () => calls.drawImage++;
        if (k === 'fillText') return () => calls.fillText++;
        return noop;
      },
      set(target, k, v) {
        target[k] = v;
        return true;
      },
    },
  );
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx }) };
  const { default: mode } = await import('../src/modes/bubbles.js');
  assert.equal(mode.id, 'bubbles');
  const log = { loops: 0, stopped: [], pops: 0, hints: [], toasts: [] };
  const app = {
    width: 1280,
    height: 720,
    dpr: 2,
    sound: {
      pop: () => log.pops++,
      tone: noop,
      noise: noop,
      sparkle: noop,
      loop: () => log.loops++,
      stopLoop: (id) => log.stopped.push(id),
    },
    ui: { hint: (h) => log.hints.push(h), toast: (s) => log.toasts.push(s) },
  };
  const m = mode.create(app);
  m.enter();
  const tracker = new HandTracker();
  let t = 0;
  for (let i = 0; i < 900; i++) {
    t += 1 / 60;
    const ph = i / 60;
    const specs = [
      { x: 400 + Math.sin(ph * 5) * 250, y: 480, size: 150, pose: 'open', side: 'left' },
      { x: 900 + Math.sin(ph * 0.7) * 250, y: 300 + Math.cos(ph * 0.9) * 120, size: 150, pose: i % 120 < 60 ? 'point' : 'fist', side: 'right' },
    ];
    if (i > 700) specs.length = 0;
    const hands = tracker.update(specs.map((s) => ({ lm: synthHand(s), side: s.side })), t);
    const frame = { t, dt: 1 / 60, width: 1280, height: 720, hands, faces: [], mic: { enabled: false } };
    m.update(frame);
    m.draw(fakeCtx, frame);
    for (const h of hands) {
      h.started = null;
      h.ended = null;
    }
    if (i === 450) m.resize(1000, 640);
  }
  const s = m.state();
  assert.doesNotThrow(() => JSON.stringify(s));
  assert.ok(s.inBounds);
  assert.ok(s.emitted > 10, `emitted ${s.emitted}`);
  assert.ok(s.popped > 0 && log.pops > 0, `popped ${s.popped}`);
  assert.ok(s.bubbles <= CFG.maxBubbles);
  assert.ok(calls.drawImage > 1000);
  assert.ok(log.hints.length > 0);
  assert.ok(log.loops > 0, '흔들 때 바람 소리');
  // 한참 아무도 없으면 다음 친구를 위해 점수와 안내가 처음으로
  for (let i = 0; i < 60 * 27; i++) {
    t += 1 / 60;
    const frame = { t, dt: 1 / 60, width: 1000, height: 640, hands: tracker.update([], t), faces: [], mic: { enabled: false } };
    m.update(frame);
  }
  const fresh = m.state();
  assert.equal(fresh.popped, 0);
  assert.equal(fresh.emitted, 0);
  assert.equal(fresh.milestone, null);
  assert.ok(fresh.free >= 3, '아무도 없을 때도 방울이 떠다닌다');
  m.exit();
  assert.ok(log.stopped.includes('bubbles-wind'));
  delete globalThis.document;
});
