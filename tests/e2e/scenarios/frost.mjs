// 입김 그림 시나리오: 맑은 유리에서는 뽀득 소리 없음 → 후~ 불기 → 김 서림 → 손이 안 보이면 뒤로 물러나라는 안내 →
// 손가락으로 웃는 얼굴·하트 그리기 → 물방울 → 끊김 처리 → 두 아이 → 손바닥으로 닦기(물방울도 같이) → 다시 불기 →
// 창 크기 바꾸기 → 놀이 바꿨다 돌아오기 → 살살 불기(거의 불었어요) → 마이크 없이 저절로 서리기 → 레티나 큰 화면
//   SKIP_CAMERA=1 node tests/e2e/smoke.mjs frost
//
// 컴퓨터가 바쁘면 화면이 초당 몇 장밖에 안 그려질 수 있다. 그래서 시간을 정해 기다리지 않고
// "프레임 수"나 "상태가 바뀔 때까지" 기다린다. 손 움직임도 한 프레임에 한 걸음씩 브라우저 안에서 진행한다.

import { fileURLToPath } from 'node:url';

export default async function scenario(t) {
  const { W, H, page } = t;
  const size = Math.round(Math.min(W, H) * 0.2);
  const face = { x: W * 0.45, y: H * 0.38 };
  const hint = () => page.evaluate(() => document.getElementById('hint').textContent);
  /** 안내 문구에 word 가 나올 때까지 (문구는 0.3초 이상 유지되어야 바뀐다) */
  async function hintHas(word, ms = 8000) {
    const end = Date.now() + ms;
    let h = await hint();
    while (!h.includes(word) && Date.now() < end) {
      await frames(2);
      h = await hint();
    }
    return h;
  }

  /** n 프레임 기다리기 */
  const frames = (n = 1) =>
    page.evaluate(
      (n) =>
        new Promise((ok) => {
          let k = 0;
          const f = () => (++k >= n ? ok() : requestAnimationFrame(f));
          requestAnimationFrame(f);
        }),
      n,
    );
  /** 상태가 조건을 만족할 때까지 (최대 ms) */
  async function until(cond, ms = 20000) {
    const end = Date.now() + ms;
    let s = await t.state();
    while (!cond(s) && Date.now() < end) {
      await frames(2);
      s = await t.state();
    }
    return s;
  }
  /** 손을 points 를 따라 step px 씩, 한 프레임에 한 걸음 움직인다 (others = 함께 둘 손들) */
  const glide = (hand, points, step = 22, others = []) =>
    page.evaluate(
      async ({ hand, points, step, others }) => {
        const raf = () => new Promise((ok) => requestAnimationFrame(ok));
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1];
          const b = points[i];
          const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
          for (let k = 1; k <= n; k++) {
            const u = k / n;
            window.handplay.sim.set({ hands: [{ ...hand, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, ...others] });
            await raf();
          }
        }
      },
      { hand, points, step, others },
    );

  // 0) 시작: 김 없음, 손 없이 얼굴만
  await t.sim({ hands: [{ x: W * 0.62, y: H * 0.62, size, pose: 'fist', visible: false }], faces: [{ ...face, blow: 0 }], mic: { blowing: false, strength: 0 } });
  await frames(8);
  let s = await t.state();
  t.assert(s && s.coverage < 0.02, `처음엔 김이 없어야 함 (coverage ${s?.coverage})`);
  t.assert(s.phase === 'blow', `처음 단계는 blow (${s.phase})`);
  t.assert((await hintHas('후~')).includes('후~'), `처음 안내는 불기 (${await hint()})`);
  await t.shot('1-start');

  // 0b) 김이 없을 때 손가락을 움직여도 '뽀득' 소리는 안 난다 (아무것도 안 그려지니까)
  const pen = { size, pose: 'point', visible: true, side: 'right' };
  await t.sim({ hands: [{ ...pen, x: W * 0.3, y: H * 0.62 }] });
  await until((s) => s.pens === 1, 8000);
  await glide(pen, [{ x: W * 0.3, y: H * 0.62 }, { x: W * 0.5, y: H * 0.55 }, { x: W * 0.6, y: H * 0.7 }], 14);
  s = await t.state();
  t.assert(s.strokeLength > W * 0.2, `맑은 유리에서도 펜은 움직임 (strokeLength ${s.strokeLength})`);
  t.assert(s.squeaks === 0, `맑은 유리에서는 뽀득 소리 없음 (squeaks ${s.squeaks})`);
  await t.sim({ hands: [{ ...pen, x: W * 0.6, y: H * 0.7, visible: false }] });
  await frames(20);

  // 1) 후~ 불기 (마이크 + 오므린 입) → 입 앞에서부터 점점 퍼진다
  await t.sim({ faces: [{ ...face, blow: 1 }], mic: { blowing: true, strength: 0.8 } });
  s = await until((s) => s.coverage > 0.02);
  t.assert(s.blowing && s.sources >= 1, '불고 있음을 알아채야 함');
  t.assert(s.coverage > 0.02 && s.coverage < 0.5, `한 번에 다 덮지 않고 입 근처부터 퍼짐 (coverage ${s.coverage})`);
  t.assert(s.puffs > 0, '입김 알갱이가 보여야 함');
  t.assert((await hintHas('계속')).includes('계속'), `부는 중 안내 (${await hint()})`);
  s = await until((s) => s.coverage > 0.25);
  await t.shot('2-blowing');
  s = await until((s) => s.coverage > 0.9, 40000);
  t.assert(s.coverage > 0.9, `몇 초 불면 화면 대부분이 덮여야 함 (coverage ${s.coverage})`);
  await t.sim({ faces: [{ ...face, blow: 0 }], mic: { blowing: false, strength: 0 } });
  s = await until((s) => !s.blowing && s.phase === 'draw');
  await frames(10);
  s = await t.state();
  t.assert(!s.blowing, '불기를 멈추면 blowing=false');
  t.assert(s.phase === 'draw', `김이 서리면 그리기 단계 (${s.phase})`);
  t.assert((await hintHas('공중에')).includes('공중에'), `그리기 안내: 공중에 그려요 (${await hint()})`);
  await t.shot('3-fogged');

  // 1b) 화면을 만지러 다가온 아이: 얼굴만 보이고 손이 3초 넘게 안 보이면 뒤로 물러나 손을 들라고 안내
  // (놀이 시간으로 3초: 컴퓨터가 바쁘면 실제로는 훨씬 오래 걸릴 수 있어 넉넉히 기다린다)
  t.assert((await hintHas('한 걸음', 60000)).includes('손이 안 보여요'), `손이 안 보이면 안내 (${await hint()})`);
  await t.shot('3b-hand-away');
  await t.sim({ faces: [{ ...face, size: 1100, blow: 0 }] });
  t.assert((await hintHas('가까워요', 20000)).includes('가까워요'), `얼굴이 너무 크면 뒤로 (${await hint()}, faceK ${(await t.state()).faceK})`);
  await t.sim({ faces: [{ ...face, size: Math.round(Math.min(W, H) * 0.36), blow: 0 }] });
  s = await t.state();
  const fogged = s.coverage;

  // 2) 검지 끝 위치를 재서 손바닥 → 손가락 끝 차이를 구한다
  await t.sim({ hands: [{ ...pen, x: W * 0.7, y: H * 0.75 }] });
  s = await until((s) => s.pens === 1, 8000);
  t.assert((await hintHas('공중에', 20000)).includes('공중에'), `손이 보이면 다시 그리기 안내 (${await hint()})`);
  const off = { x: s.tip[0] - W * 0.7, y: s.tip[1] - H * 0.75 };
  const at = (p) => ({ x: p.x - off.x, y: p.y - off.y });

  // 그 자리에서 펜을 떼고(주먹) 옮긴 뒤 다시 대고(검지) 선을 따라 그린다
  let cur = { x: W * 0.7, y: H * 0.75 };
  async function stroke(points, step = 22) {
    await t.sim({ hands: [{ ...pen, ...cur, pose: 'fist' }] });
    await until((s) => s.pens === 0, 8000);
    await frames(3);
    await t.sim({ hands: [{ ...pen, ...at(points[0]), pose: 'fist' }] });
    await frames(3);
    await t.sim({ hands: [{ ...pen, ...at(points[0]) }] });
    await until((s) => s.pens === 1, 8000);
    await frames(2);
    await glide(pen, points.map(at), step);
    await frames(2);
    cur = at(points[points.length - 1]);
  }
  const arc = (cx, cy, r, a0, a1, n) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = a0 + ((a1 - a0) * i) / n;
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    });

  // 웃는 얼굴 (오른쪽)
  const C = { x: W * 0.74, y: H * 0.47 };
  const R = H * 0.22;
  const len0 = s.strokeLength;
  await stroke(arc(C.x, C.y, R, -Math.PI / 2, Math.PI * 1.5 + 0.12, 28));
  s = await t.state();
  t.assert(s.pens === 1, `검지를 펴면 펜이 됨 (pens ${s.pens})`);
  t.assert(s.strokeLength - len0 > R * 5, `동그라미를 그렸어야 함 (strokeLength ${s.strokeLength - len0})`);
  t.assert(s.squeaks >= 3, `김 위를 문지르면 뽀득 소리 (squeaks ${s.squeaks})`);
  await t.shot('4-drawing');
  await stroke([{ x: C.x - R * 0.36, y: C.y - R * 0.3 }, { x: C.x - R * 0.36, y: C.y - R * 0.16 }], 6);
  await stroke([{ x: C.x + R * 0.36, y: C.y - R * 0.3 }, { x: C.x + R * 0.36, y: C.y - R * 0.16 }], 6);
  await stroke(arc(C.x, C.y + R * 0.02, R * 0.52, Math.PI * 0.18, Math.PI * 0.82, 10));
  // 하트 (왼쪽)
  const Hc = { x: W * 0.21, y: H * 0.36 };
  const hs = H * 0.0125;
  const heart = Array.from({ length: 41 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return { x: Hc.x + hs * 16 * Math.pow(Math.sin(a), 3), y: Hc.y - hs * (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) };
  });
  await stroke(heart);
  // 손을 떼고 치운 뒤 물방울이 흐르기를 기다린다
  await t.sim({ hands: [{ ...pen, ...cur, pose: 'fist' }] });
  await until((s) => s.pens === 0, 8000);
  await t.sim({ hands: [{ ...pen, ...cur, pose: 'fist', visible: false }] });
  s = await until((s) => s.drips > 0 && s.dripsSpawned >= 3, 15000);
  await frames(25);
  s = await t.state();
  t.assert(s.coverage < fogged - 0.03, `그린 만큼 김이 닦여야 함 (${fogged} → ${s.coverage})`);
  t.assert(s.dripsSpawned > 0, `닦은 자리에서 물방울이 맺혀야 함 (dripsSpawned ${s.dripsSpawned})`);
  t.assert(s.phase === 'draw', `아직 그리기 단계 (${s.phase})`);
  await t.shot('5-drawn');

  // 3) 인식이 잠깐 끊겼다가(stale) 먼 곳에서 다시 나타나면 선을 잇지 않는다
  const p1 = at({ x: W * 0.12, y: H * 0.78 });
  const p2 = at({ x: W * 0.12 + size * 1.6, y: H * 0.78 });
  await t.sim({ hands: [{ ...pen, ...p1 }] });
  await until((s) => s.pens === 1, 8000);
  await frames(2);
  const before = (await t.state()).strokeLength;
  await t.sim({ hands: [{ ...pen, ...p1, visible: false }] });
  await frames(2); // 0.2초 안쪽: 손은 stale 로 남아 있다
  await t.sim({ hands: [{ ...pen, ...p2 }] });
  await frames(4);
  s = await t.state();
  t.assert(s.strokeLength - before < size * 0.5, `잠깐 놓쳤다 멀리서 나타나면 선을 잇지 않음 (+${s.strokeLength - before}px)`);

  // 4) 두 아이가 동시에 그리기
  const pen2 = { ...pen, side: 'left' };
  const at2 = (p) => ({ x: p.x + off.x, y: p.y - off.y }); // 왼손은 좌우가 반대
  const A = at({ x: W * 0.36, y: H * 0.7 });
  const B = at2({ x: W * 0.56, y: H * 0.7 });
  await t.sim({ hands: [{ ...pen, ...A }, { ...pen2, ...B }] });
  s = await until((s) => s.pens === 2, 8000);
  await page.evaluate(
    async ({ pen, pen2, A, B, W, H }) => {
      const raf = () => new Promise((ok) => requestAnimationFrame(ok));
      for (let i = 1; i <= 24; i++) {
        const k = i / 24;
        window.handplay.sim.set({
          hands: [
            { ...pen, x: A.x - k * W * 0.1, y: A.y + Math.sin(k * 9) * H * 0.03 },
            { ...pen2, x: B.x + k * W * 0.1, y: B.y + Math.cos(k * 9) * H * 0.03 },
          ],
        });
        await raf();
      }
    },
    { pen, pen2, A, B, W, H },
  );
  s = await t.state();
  t.assert(s.pens === 2, `두 손이 동시에 그릴 수 있어야 함 (pens ${s.pens})`);
  t.assert(s.drawing, '그리는 중 drawing=true');
  await t.shot('6-two-kids');

  // 5) 손바닥으로 쓱쓱 닦기
  const palm = { size, pose: 'open', visible: true, side: 'right' };
  await t.sim({ hands: [{ ...palm, x: W * 0.03, y: H * 0.16 }] });
  await until((s) => s.wiping, 8000);
  const rows = [0.16, 0.38, 0.6, 0.82, 0.98];
  for (let i = 0; i < rows.length; i++) {
    const y = H * rows[i];
    const [x0, x1] = i % 2 ? [W * 1.0, W * 0.0] : [W * 0.0, W * 1.0];
    const prevY = i ? H * rows[i - 1] : y;
    await glide(palm, [{ x: x0, y: prevY }, { x: x0, y }, { x: x1, y }], 40);
    if (i === 1) {
      s = await t.state();
      t.assert(s.wiping, '손바닥을 펴면 닦기');
      await t.shot('7-wiping');
    }
  }
  s = await t.state();
  t.assert(s.dripsWiped > 0, `손바닥이 지나간 물방울은 같이 닦임 (dripsWiped ${s.dripsWiped})`);
  t.assert(s.swishes > 0, `빠르게 닦으면 쓱 소리 (swishes ${s.swishes})`);
  await t.sim({ hands: [{ ...palm, visible: false }] });
  s = await until((s) => s.phase === 'again', 8000);
  t.assert(s.coverage < 0.1, `다 닦으면 김이 거의 없어야 함 (coverage ${s.coverage})`);
  t.assert(s.phase === 'again', `다시 불기 단계 (${s.phase})`);
  t.assert((await hintHas('다시')).includes('다시'), `다시 불기 안내 (${await hint()})`);
  await t.shot('8-cleared');

  // 6) 다시 불면 다시 그리기 단계, 창 크기가 바뀌어도 김이 유지된다
  await t.sim({ faces: [{ ...face, blow: 1 }], mic: { blowing: true, strength: 1 } });
  s = await until((s) => s.coverage > 0.6, 40000);
  await t.sim({ faces: [{ ...face, blow: 0 }], mic: { blowing: false, strength: 0 } });
  s = await until((s) => !s.blowing, 8000);
  t.assert(s.phase === 'draw', `다시 불면 다시 그리기 단계 (${s.phase})`);
  const g0 = s.grid;
  const c0 = s.coverage;
  await page.setViewportSize({ width: 900, height: 700 });
  await frames(12);
  s = await t.state();
  t.assert(s.grid[0] !== g0[0], `창 크기에 맞춰 김 격자를 새로 만듦 (${g0} → ${s.grid})`);
  t.assert(s.coverage > c0 - 0.15, `창 크기가 바뀌어도 김이 남아 있음 (${c0} → ${s.coverage})`);
  // 크기가 바뀐 뒤 잠깐 쉬었다가 다시 그릴 수 있다
  await t.sim({ hands: [{ ...pen, x: 300, y: 420 }] });
  await until((s) => s.pens === 1, 8000);
  const l0 = (await t.state()).strokeLength;
  await glide(pen, [{ x: 300, y: 420 }, { x: 560, y: 360 }], 12);
  s = await t.state();
  t.assert(s.strokeLength - l0 > 150, `창 크기가 바뀐 뒤에도 그려짐 (+${s.strokeLength - l0}px)`);
  await t.shot('9-resized');
  await t.sim({ hands: [{ ...pen, visible: false }] });
  await page.setViewportSize({ width: W, height: H });
  await frames(6);

  // 7) 다른 놀이로 갔다 와도 오류 없이 처음부터
  await page.evaluate(() => window.handplay.switchMode('bubbles'));
  await frames(4);
  await page.evaluate(() => window.handplay.switchMode('frost'));
  await frames(6);
  s = await t.state();
  t.assert(s.coverage === 0 && s.phase === 'blow', `다시 들어오면 처음부터 (coverage ${s.coverage}, ${s.phase})`);
  t.assert(s.ms < 15, `한 프레임 계산 시간이 짧아야 함 (${s.ms}ms)`);

  // 7b) 멀리서 살살 불기: 소리는 조금 들리는데 입김으로는 모자람 (입은 살짝만 오므림)
  //     → 희미한 입김 알갱이 + "조금 더 세게" 안내, 계속 애쓰면 몇 초 만에 김이 서려 도와준다
  await page.evaluate(() => {
    const m = window.handplay.app.mode;
    m._update = m.update;
    m.update = (f) => m._update({ ...f, mic: { enabled: true, level: 0.32, blowing: false, strength: 0 } });
  });
  await t.sim({ faces: [{ ...face, blow: 0.3 }], mic: { blowing: false, strength: 0 } });
  s = await until((s) => s.trying && s.puffs > 3, 30000);
  t.assert(s.trying && !s.blowing, `거의 불었어요 (trying ${s.trying}, blowing ${s.blowing})`);
  t.assert(s.puffs > 3, `희미한 입김 알갱이 (puffs ${s.puffs})`);
  t.assert((await hintHas('세게', 30000)).includes('세게'), `조금 더 세게 안내 (${await hint()})`);
  await t.shot('10-almost');
  s = await until((s) => s.autoFogs > 0, 90000);
  t.assert(s.autoFogs === 1, `애쓰면 도와서 김이 서림 (autoFogs ${s.autoFogs})`);
  const toast = await page.evaluate(() => document.getElementById('toast').textContent);
  t.assert(toast.includes('잘했어요'), `애쓴 아이에게 칭찬 (${toast})`);
  // 놀이 시간 기준: 아무도 안 불 때(14초)보다 훨씬 빨리 — 애쓴 시간이 6초 안쪽에서 도와준다
  t.assert(s.tryTime > 0.5 && s.tryTime < 6.5, `애쓴 지 몇 초 만에 (tryTime ${s.tryTime}초)`);
  await page.evaluate(() => window.handplay.switchMode('bubbles'));
  await frames(3);
  await page.evaluate(() => window.handplay.switchMode('frost'));
  await frames(6);

  // 8) 마이크가 없는 컴퓨터: 아무도 안 불면 8초 뒤 김이 창 가장자리부터 저절로 서린다
  //    (연습 모드 마이크는 늘 켜져 있으므로, 놀이에 들어가는 frame.mic 만 '없음'으로 바꿔서 흉내 낸다)
  await page.evaluate(() => {
    const m = window.handplay.app.mode;
    const update = m.update.bind(m);
    m.update = (f) => update({ ...f, mic: { enabled: false, level: 0, blowing: false, strength: 0 } });
  });
  await t.sim({ hands: [{ ...pen, visible: false }], faces: [{ ...face, blow: 0 }] });
  t.assert((await hintHas('오므리고')).includes('오므리고'), `마이크가 없으면 입 모양 안내 (${await hint()})`);
  s = await until((s) => s.autoFogs > 0, 90000);
  t.assert(s.autoFogs === 1, `마이크 없이 8초 지나면 저절로 서림 (autoFogs ${s.autoFogs})`);
  s = await until((s) => s.coverage > 0.25, 20000);
  await t.shot('11-autofog');
  s = await until((s) => s.coverage > 0.9 && s.phase === 'draw', 30000);
  t.assert(s.coverage > 0.9, `저절로 서린 김이 화면을 덮음 (coverage ${s.coverage})`);
  t.assert(s.phase === 'draw' && (await hintHas('손가락')).includes('손가락'), '저절로 서린 뒤 그리기 안내');

  // 9) 큰 화면 + 레티나(기기 픽셀 비율 2): 김 층은 작은 캔버스에서 합친 뒤 한 번만 늘려 그린다
  const ctx2 = await page.context().browser().newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const pg2 = await ctx2.newPage();
  const errs = [];
  pg2.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  pg2.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`));
  try {
    await pg2.goto(page.url());
    await pg2.waitForFunction(() => window.handplay?.app?.mode?.state && window.handplay.sim, null, { timeout: 15000 });
    const st2 = () => pg2.evaluate(() => window.handplay.app.mode.state());
    await pg2.evaluate(() =>
      window.handplay.sim.set({
        faces: [{ x: 700, y: 330, size: 330, blow: 1 }],
        mic: { blowing: true, strength: 1 },
        hands: [{ x: 1150, y: 640, size: 190, pose: 'point', side: 'right', visible: true }],
      }),
    );
    let r = await st2();
    for (let end = Date.now() + 120000; !(r.coverage > 0.6) && Date.now() < end; r = await st2()) await pg2.waitForTimeout(150);
    await pg2.evaluate(() => window.handplay.sim.set({ faces: [{ x: 700, y: 330, size: 330, blow: 0 }], mic: { blowing: false, strength: 0 } }));
    await pg2.waitForTimeout(600);
    r = await st2();
    t.assert(r.comp === true && r.fogScale < 2, `레티나 큰 화면은 작은 캔버스에서 합침 (comp ${r.comp}, scale ${r.fogScale})`);
    t.assert(r.coverage > 0.5, `레티나에서도 김이 서림 (${r.coverage})`);
    await pg2.screenshot({ path: fileURLToPath(new URL('../../../test-results/frost-12-retina.png', import.meta.url)) });
  } finally {
    await ctx2.close();
  }
  t.assert(errs.length === 0, `레티나 화면 오류 없음: ${errs.join(' | ')}`);
}
