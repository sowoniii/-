// 늘어나는 손가락 자동 점검.
//   가리키는 손(A)의 검지 끝을 다른 손(B)으로 집어 당기고 → 휘게 하고 → 놓아서 띠용~ 돌아가는지,
//   이미 집은 채로 갖다 대도 잡히는지, 너무 늘이면 뿅! 하는지(그리고 잠깐 뒤엔 집은 채로 다시 잡히는지),
//   활짝 편 손에도 과녁·따라 하기 안내가 나오는지, 손 네 개로 두 손가락을 동시에 늘이는지 확인한다.
//
// 자동 점검용 브라우저는 소프트웨어 GPU 라서 몇 fps 밖에 안 나온다. 그래서 '실제 ms' 대신
//   - simWait(초): 놀이 안 시간(state().clock = dt 의 합)으로 기다리고
//   - animate(): 손을 한 프레임에 한 걸음씩 움직인다 (인식기가 손을 놓치지 않게).
import { synthHand } from '../../../src/core/synth.js';

const SIZE = 150;
const A = { x: 400, y: 520, size: SIZE, angle: 0, pose: 'point', side: 'left' };
// B 는 손가락이 왼쪽(A 쪽)을 향하게 돌린 오른손
const B_BASE = { size: SIZE, angle: -Math.PI / 2, side: 'right' };

/** pinch 자세일 때 손바닥 중심에서 집는 점(엄지·검지 끝 중간)까지의 차이 */
function pinchOffset(hand) {
  const lm = synthHand({ ...hand, x: 0, y: 0, pose: 'pinch' });
  return { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
}

/** 집는 점이 (px, py) 에 오도록 놓은 손 */
function bAt(px, py, pose, hand = B_BASE) {
  const o = pinchOffset(hand);
  return { ...hand, x: px - o.x, y: py - o.y, pose };
}

const lerp = (a, b, k) => a + (b - a) * k;
const moveTo = (h, to, k) => ({ ...h, x: lerp(h.x, to.x, k), y: lerp(h.y, to.y, k) });

export default async function scenario(t) {
  const { page } = t;
  const st = () => t.state();
  const frames = (n) =>
    page.evaluate(
      (n) =>
        new Promise((ok) => {
          let k = 0;
          const f = () => (++k >= n ? ok() : requestAnimationFrame(f));
          requestAnimationFrame(f);
        }),
      n,
    );
  /** 놀이 안 시간으로 sec 초 기다린다 (until 이 참이 되면 일찍 끝). 마지막 state 를 돌려준다. */
  async function simWait(sec, until = null) {
    const c0 = (await st()).clock;
    const t0 = Date.now();
    for (;;) {
      await frames(1);
      const s = await st();
      if (until && until(s)) return s;
      if (s.clock - c0 >= sec || Date.now() - t0 > 30000) return s;
    }
  }
  const setHands = (hands) => t.sim({ hands });
  /** 여러 손을 한 프레임에 한 걸음씩 움직인다. fn(k) → 손 배열 (k: 0..1) */
  async function animate(fn, steps) {
    for (let i = 1; i <= steps; i++) {
      await setHands(fn(i / steps));
      await frames(1);
    }
  }
  const live = () =>
    page.evaluate(() =>
      window.handplay.app.hands.map((h) => ({
        id: h.id,
        pose: h.pose,
        size: h.size,
        base: { x: h.lm[5].x, y: h.lm[5].y },
        tip: { x: h.lm[8].x, y: h.lm[8].y },
        palm: { x: h.palm.x, y: h.palm.y },
      })),
    );

  // ------------------------------------------------------------ 0) 활짝 편 손 (아이들이 제일 먼저 하는 손): 검지에 과녁 하나 + 유령 손
  await setHands([{ ...A, pose: 'open' }]);
  {
    const s = await simWait(0.8, (x) => x.targets >= 1 && x.ghost !== null);
    t.assert(s.targets === 1, `활짝 편 손은 검지에 과녁 하나: ${JSON.stringify(s)}`);
    t.assert(s.ghost !== null, `활짝 편 손에도 따라 하기 유령 손: ${JSON.stringify(s)}`);
    const g = await simWait(8, (x) => x.ghost !== null && x.ghost > 0.3 && x.ghost < 0.42);
    t.assert(g.ghost !== null, '유령 손이 손가락 끝을 집는 장면');
    await t.shot('0-open-palm');
  }

  // ------------------------------------------------------------ 1) 한 손: 과녁 + 따라 하기 유령 손
  await setHands([A]);
  let s = await simWait(0.6);
  t.assert(s.hands === 1, `손 1개여야 함: ${JSON.stringify(s)}`);
  t.assert(s.targets >= 1, `검지 끝에 과녁이 있어야 함: ${JSON.stringify(s)}`);
  t.assert(s.ghost !== null, '따라 하기 유령 손이 보여야 함');
  t.assert(/다른 손으로/.test(s.hint || ''), `한 손 안내 문구: ${s.hint}`);
  // 유령 손이 손가락을 당기는 장면을 찍는다
  s = await simWait(8, (x) => x.ghost !== null && x.ghost > 0.6 && x.ghost < 0.78);
  await t.shot('1-one-hand');

  const aHand = (await live())[0];
  const tip = aHand.tip;
  t.assert(aHand.pose === 'point', `A 는 가리키기여야 함: ${aHand.pose}`);

  // ------------------------------------------------------------ 2) 두 번째 손이 다가오면 '꼬옥 집어요!'
  const farB = bAt(tip.x + 420, tip.y + 40, 'other');
  const nearB = bAt(tip.x + 4, tip.y + 2, 'other');
  await setHands([A, farB]);
  await simWait(0.6);
  s = await st();
  t.assert(/반짝이는|집어요/.test(s.hint || ''), `두 손 안내 문구: ${s.hint}`);
  await animate((k) => [A, moveTo(farB, nearB, k)], 10);
  s = await simWait(0.3);
  t.assert(s.aim, `B 가 가까우면 '집어요' 상태여야 함: ${JSON.stringify(s)}`);
  t.assert(s.stretches.length === 0, '아직 집지 않았으니 늘어나지 않아야 함');
  t.assert(/꼬옥/.test(s.hint || ''), `가까이 오면 '꼬옥 집어요' 안내: ${s.hint}`);
  await t.shot('2-aim');

  // ------------------------------------------------------------ 3) 집기 → 잡힌다
  const grabbed = { ...nearB, pose: 'pinch' };
  await setHands([A, grabbed]);
  s = await simWait(0.4, (x) => x.stretches.length > 0);
  t.assert(s.stretches.length === 1 && s.stretches[0].phase === 'held', `집으면 잡혀야 함: ${JSON.stringify(s)}`);
  t.assert(s.stretches[0]?.finger === 1, `검지(1)를 잡아야 함: ${JSON.stringify(s.stretches)}`);
  t.assert(s.grabs === 1, `잡은 횟수 1: ${s.grabs}`);

  // ------------------------------------------------------------ 4) 오른쪽 위로 쭈욱
  const far = bAt(tip.x + 390, tip.y - 50, 'pinch');
  await animate((k) => [A, moveTo(grabbed, far, k)], 14);
  s = await simWait(0.35);
  const r1 = s.stretches[0]?.ratio ?? 0;
  t.assert(s.stretches[0]?.phase === 'held', `당기는 동안 계속 잡혀 있어야 함: ${JSON.stringify(s)}`);
  t.assert(r1 > 2.5 && r1 < 5, `손가락이 2.5배 넘게 늘어나야 함: ${r1}`);
  t.assert(s.stretches[0]?.cover > 0.5, `원래 손가락 자리를 배경으로 덮어야 함: ${s.stretches[0]?.cover}`);
  t.assert(/길다|당겨/.test(s.hint || ''), `잡고 있을 때 안내: ${s.hint} ${JSON.stringify(s)}`);
  await t.shot('3-stretch-far');

  // ------------------------------------------------------------ 5) 아래로 휘게
  const bend = bAt(tip.x + 330, tip.y + 230, 'pinch');
  await animate((k) => [A, moveTo(far, bend, k)], 10);
  s = await simWait(0.3);
  t.assert(s.stretches[0]?.phase === 'held', '휘어도 잡혀 있어야 함');
  await t.shot('4-stretch-bend');

  // ------------------------------------------------------------ 6) 손을 펴서 놓기 → 띠용~
  await setHands([A, { ...bend, pose: 'open' }]);
  s = await simWait(0.6, (x) => x.stretches[0]?.phase === 'release');
  t.assert(s.stretches.length === 1 && s.stretches[0].phase === 'release', `놓으면 돌아가는 중이어야 함: ${JSON.stringify(s)}`);
  t.assert(s.releases === 1, `놓은 횟수 1: ${s.releases}`);
  s = await simWait(0.1);
  await t.shot('5-release-boing');
  s = await simWait(3.5, (x) => x.stretches.length === 0);
  t.assert(s.stretches.length === 0, `다 돌아가면 효과가 사라져야 함: ${JSON.stringify(s)}`);
  await t.shot('6-back');
  await setHands([]);
  await simWait(0.8, (x) => x.hands === 0 && x.stretches.length === 0);

  // ------------------------------------------------------------ 7) 이미 집은 손을 갖다 대도 잡히고, 너무 늘이면 뿅!
  const As = { x: 230, y: 560, size: 100, angle: 0.35, pose: 'point', side: 'left' };
  const Bs = { size: 110, angle: -Math.PI / 2, side: 'right' };
  await setHands([As]);
  await simWait(0.6);
  const small = (await live())[0];
  const sTip = small.tip;
  const sBase = small.base;
  const len = Math.hypot(sTip.x - sBase.x, sTip.y - sBase.y);
  const pre = bAt(sTip.x + 260, sTip.y + 30, 'pinch', Bs);
  const touch = bAt(sTip.x + 3, sTip.y + 1, 'pinch', Bs);
  await setHands([As, pre]);
  await simWait(0.4);
  s = await st();
  t.assert(s.stretches.length === 0, '멀리서 집고만 있으면 잡히지 않아야 함');
  await animate((k) => [As, moveTo(pre, touch, k)], 10);
  s = await simWait(0.4, (x) => x.stretches.length > 0);
  t.assert(s.stretches.length === 1 && s.stretches[0].phase === 'held', `집은 채로 갖다 대면 잡혀야 함: ${JSON.stringify(s)}`);
  // 뿌리에서 오른쪽 위로 원래 길이의 5배쯤 → 빨개지고 부들부들
  const ux = Math.cos(-0.42);
  const uy = Math.sin(-0.42);
  const warnAt = bAt(sBase.x + ux * len * 5.1, sBase.y + uy * len * 5.1, 'pinch', Bs);
  await animate((k) => [As, moveTo(touch, warnAt, k)], 16);
  s = await simWait(0.3);
  t.assert(s.stretches[0]?.phase === 'held' && s.stretches[0].ratio > 4.4, `많이 늘어나야 함: ${JSON.stringify(s)}`);
  t.assert(/조심/.test(s.hint || ''), `너무 늘이면 '조심' 안내: ${s.hint}`);
  await t.shot('7-tension');
  const snapAt = bAt(sBase.x + ux * len * 7.4, sBase.y + uy * len * 7.4, 'pinch', Bs);
  await animate((k) => [As, moveTo(warnAt, snapAt, k)], 8);
  s = await simWait(0.5, (x) => x.snaps > 0);
  t.assert(s.snaps === 1, `너무 늘이면 뿅! 해야 함: ${JSON.stringify(s)}`);
  t.assert(s.stretches.every((x) => x.phase === 'release'), '뿅! 하면 돌아가는 중이어야 함');
  await frames(1);
  await t.shot('8-snap');
  // 뿅! 한 자리에서 집은 채로 있어도 곧바로 다시 잡혀 또 뿅! 하지 않는다
  s = await simWait(0.25);
  t.assert(!s.stretches.some((x) => x.phase === 'held') && s.snaps === 1, `뿅! 하자마자 다시 잡히지 않아야 함: ${JSON.stringify(s)}`);
  // 손을 펴지 않고 집은 채로 다시 손가락 끝에 갖다 대면, 잠깐 뒤 다시 잡힌다 (손을 꼭 펴야 하는 숨은 규칙 없음)
  const grabsBefore = s.grabs;
  await animate((k) => [As, moveTo(snapAt, touch, k)], 12);
  s = await simWait(1.5, (x) => x.stretches.some((y) => y.phase === 'held'));
  t.assert(s.stretches.some((x) => x.phase === 'held'), `집은 채로 다시 갖다 대면 또 잡혀야 함: ${JSON.stringify(s)}`);
  t.assert(s.grabs === grabsBefore + 1, `다시 잡은 횟수: ${JSON.stringify(s)}`);
  t.assert(s.stretches.length === 1, `같은 손가락을 다시 잡아야 함 (두 개로 늘어나지 않게): ${JSON.stringify(s.stretches)}`);
  await setHands([]);
  await simWait(0.8, (x) => x.hands === 0 && x.stretches.length === 0);

  // ------------------------------------------------------------ 8) 손 네 개: 두 아이가 동시에
  const A1 = { x: 330, y: 540, size: 130, angle: 0.25, pose: 'point', side: 'left' };
  const A2 = { x: 930, y: 540, size: 130, angle: -0.2, pose: 'v', side: 'right' };
  const B1base = { size: 130, angle: Math.PI / 2, side: 'left' };
  const B2base = { size: 130, angle: -Math.PI / 2, side: 'right' };
  await setHands([A1, A2]);
  s = await simWait(0.6);
  const two = await live();
  const tip1 = two.find((h) => h.palm.x < 640).tip;
  const tip2 = two.find((h) => h.palm.x > 640).tip;
  t.assert(s.targets >= 3, `가리키기 1 + 브이 2 = 과녁 3개 이상: ${s.targets}`);
  await t.shot('9-two-kids-targets');
  const n1 = bAt(tip1.x - 4, tip1.y, 'other', B1base);
  const n2 = bAt(tip2.x + 4, tip2.y, 'other', B2base);
  const o1 = { ...n1, x: n1.x - 300 };
  const o2 = { ...n2, x: n2.x + 300 };
  await setHands([A1, A2, o1, o2]);
  await simWait(0.3);
  await animate((k) => [A1, A2, moveTo(o1, n1, k), moveTo(o2, n2, k)], 10);
  await simWait(0.2);
  await setHands([A1, A2, { ...n1, pose: 'pinch' }, { ...n2, pose: 'pinch' }]);
  await simWait(0.3);
  const f1 = bAt(tip1.x - 250, tip1.y - 120, 'pinch', B1base);
  const f2 = bAt(tip2.x + 260, tip2.y - 100, 'pinch', B2base);
  await animate((k) => [A1, A2, moveTo({ ...n1, pose: 'pinch' }, f1, k), moveTo({ ...n2, pose: 'pinch' }, f2, k)], 14);
  s = await simWait(0.3);
  const held = s.stretches.filter((x) => x.phase === 'held');
  t.assert(held.length === 2, `두 손가락이 동시에 늘어나야 함: ${JSON.stringify(s)}`);
  t.assert(held.every((x) => x.ratio > 1.8), `둘 다 길게 늘어나야 함: ${JSON.stringify(held)}`);
  t.assert(new Set(held.map((x) => x.handA)).size === 2, '서로 다른 손의 손가락이어야 함');
  await t.shot('10-double');

  // ------------------------------------------------------------ 9) 손이 다 사라지면 정리
  await setHands([]);
  s = await simWait(1.5, (x) => x.stretches.length === 0 && x.hands === 0);
  t.assert(s.stretches.length === 0, `손이 사라지면 효과도 정리: ${JSON.stringify(s)}`);
  t.assert(s.hands === 0, '손 0개');
}
