// 동물 귀 놀이 자동 점검: 브이 → 고양이 귀, 다시 브이 → 다음 동물 … 한 바퀴,
// 고개 흔들기(귀 출렁임), 두 아이, 얼굴을 잠깐 놓쳤다 돌아오기, 얼굴이 없을 때 안내, 창 크기 바꾸기.
// 점검 컴퓨터가 느려도(초당 몇 프레임) 통과하도록 정해진 시간 대신 '조건이 될 때까지' 기다린다.

const ORDER = ['cat', 'rabbit', 'bear', 'fox', 'dog', 'panda'];

export default async function scenario(t) {
  const { W, H, page } = t;
  const face = { x: W * 0.44, y: H * 0.52, size: 240, roll: 0, mouthOpen: 0, visible: true };
  const handAt = { x: W * 0.66, y: H * 0.74 };
  const hand = (pose, extra = {}) => ({ ...handAt, size: 135, angle: 0.15, pose, side: 'right', visible: true, ...extra });
  const earsOf = (s, i = 0) => s?.ears?.[i] || {};

  /** 다음 화면이 그려질 때까지 */
  const nextFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  /** state 가 조건을 만족할 때까지 (최대 ms) */
  async function until(pred, ms = 8000) {
    const t0 = Date.now();
    let s = await t.state();
    while (!pred(s) && Date.now() - t0 < ms) {
      await t.wait(50);
      s = await t.state();
    }
    return s;
  }
  /** 첫 번째 손이 그 모양으로 인식될 때까지 */
  async function untilPose(pose, ms = 8000) {
    await page
      .waitForFunction((p) => window.handplay.app.hands[0]?.pose === p, pose, { timeout: ms, polling: 30 })
      .catch(() => t.assert(false, `손 모양 ${pose} 인식 시간 초과`));
  }
  /** 손을 폈다가 (다시 준비되도록 잠깐 기다린 뒤) 브이 */
  async function vAgain(extra = {}) {
    await t.sim({ hands: [hand('open', extra)] });
    await untilPose('open');
    await t.wait(320);
    await nextFrame();
    await t.sim({ hands: [hand('v', extra)] });
    await untilPose('v');
  }

  // 1) 얼굴만 있고 귀는 없음
  await t.sim({ faces: [face], hands: [hand('open')] });
  let s = await until((x) => x?.faces === 1);
  await untilPose('open');
  t.assert(s && s.faces === 1, `얼굴 1개여야 함: ${JSON.stringify(s)}`);
  t.assert(s.withEars === 0, '처음엔 귀가 없어야 함');
  await t.wait(400);
  await t.shot('1-idle');

  // 2) 브이 → 손끝에서 반짝, 마법 별이 날아가고 고양이 귀가 뾱
  await t.sim({ hands: [hand('v')] });
  s = await until((x) => x.flights > 0 || x.withEars > 0);
  t.assert(s.flights === 1 || earsOf(s).animal === 'cat', `브이하면 별이 날아가야 함: ${JSON.stringify(s)}`);
  await nextFrame();
  await t.shot('2-flying');
  s = await until((x) => x.withEars > 0);
  await nextFrame();
  await t.shot('3-pop');
  s = await until((x) => earsOf(x).animal === 'cat' && Math.abs(earsOf(x).scale - 1) < 0.04);
  t.assert(earsOf(s).animal === 'cat', `첫 브이는 고양이: ${JSON.stringify(s)}`);
  t.assert(earsOf(s).scale > 0.9 && earsOf(s).scale < 1.1, `귀가 다 자라야 함: ${earsOf(s).scale}`);
  await t.shot('4-cat');

  // 3) 브이를 계속 하고 있어도 다시 바뀌지 않는다
  await t.wait(1000);
  await nextFrame();
  s = await t.state();
  t.assert(earsOf(s).animal === 'cat' && s.switches === 1, `브이 유지 중엔 그대로: ${JSON.stringify(s)}`);

  // 3-1) 얼굴이 안 보이는 다른 아이가 화면 반대쪽 멀리서 한 브이는 이 아이의 귀를 바꾸지 않는다
  const far = { x: W * 0.95, y: H * 0.62 };
  await t.sim({ hands: [hand('open', far)] });
  await untilPose('open');
  await t.wait(320);
  await t.sim({ hands: [hand('v', far)] });
  await untilPose('v');
  await t.wait(900);
  await nextFrame();
  s = await t.state();
  t.assert(earsOf(s).animal === 'cat' && s.switches === 1 && s.flights === 0, `먼 곳의 남의 브이로는 안 바뀜: ${JSON.stringify(s)}`);

  // 4) 손을 폈다가 다시 브이 → 다음 동물, 한 바퀴 (마지막엔 다시 고양이)
  for (let i = 1; i <= ORDER.length; i++) {
    const want = ORDER[i % ORDER.length];
    await vAgain();
    s = await until((x) => earsOf(x).animal === want && earsOf(x).phase === 'in' && Math.abs(earsOf(x).scale - 1) < 0.05);
    t.assert(earsOf(s).animal === want, `${i}번째 변신은 ${want}: ${JSON.stringify(earsOf(s))}`);
    if (want === 'dog') {
      await t.sim({ faces: [{ ...face, mouthOpen: 0.9 }] });
      await nextFrame();
      await nextFrame();
    }
    if (i < ORDER.length) await t.shot(`5-${want}`);
    if (want === 'dog') await t.sim({ faces: [face] });
  }
  t.assert(s.switches === ORDER.length + 1, `변신 횟수: ${s.switches}`);
  t.assert(earsOf(s).visited === ORDER.length, `모든 동물 방문: ${earsOf(s).visited}`);

  // 5) 토끼로 바꾸고 고개를 빠르게 움직이면 귀가 출렁인다
  await vAgain();
  s = await until((x) => earsOf(x).animal === 'rabbit' && Math.abs(earsOf(x).scale - 1) < 0.05);
  t.assert(earsOf(s).animal === 'rabbit', `토끼여야 함: ${earsOf(s).animal}`);
  await t.wait(600);
  let maxSwing = 0;
  for (let i = 0; i <= 8; i++) {
    await t.sim({ faces: [{ ...face, x: face.x + i * 20, roll: i * 0.035 }] });
    await nextFrame();
    s = await t.state();
    maxSwing = Math.max(maxSwing, Math.abs(earsOf(s).theta));
    if (i === 6) await t.shot('6-swing');
  }
  t.assert(maxSwing > 0.03, `머리를 움직이면 귀가 출렁여야 함: ${maxSwing}`);
  // 기울인 채로 멈추기
  const tilted = { ...face, x: face.x + 160, roll: 0.28 };
  await t.sim({ faces: [tilted] });
  await t.wait(1000);
  await t.shot('7-tilt');

  // 6) 두 아이: 왼쪽 아이 앞에서 브이 → 그 아이만 귀가 생기고, 다른 동물 (안 쓰는 동물 중 첫째 = 고양이)
  const friend = { x: W * 0.17, y: H * 0.52, size: 200, roll: -0.12, mouthOpen: 0, visible: true };
  const near = { x: W * 0.3, y: H * 0.8, size: 115 };
  await t.sim({ faces: [tilted, friend], hands: [hand('open', near)] });
  s = await until((x) => x.faces === 2);
  t.assert(s.faces === 2, `얼굴 2개: ${JSON.stringify(s)}`);
  const firstId = s.ears.find((e) => e.animal === 'rabbit')?.faceId;
  t.assert(firstId, `첫 아이는 토끼 귀를 유지: ${JSON.stringify(s.ears)}`);
  await vAgain(near);
  s = await until((x) => x.withEars === 2 && x.ears.every((e) => e.scale > 0.95));
  const a = s.ears.find((e) => e.faceId === firstId);
  const b = s.ears.find((e) => e.faceId !== firstId);
  t.assert(a?.animal === 'rabbit', `첫 아이는 그대로 토끼: ${JSON.stringify(s.ears)}`);
  t.assert(b?.animal === 'cat', `둘째 아이는 고양이 귀: ${JSON.stringify(s.ears)}`);
  await t.wait(300);
  await t.shot('8-two-kids');

  // 7) 첫 아이 얼굴을 잠깐 놓쳤다가 같은 자리에 다시 → 귀를 돌려받는다
  await t.sim({ faces: [{ ...tilted, visible: false }, friend], hands: [hand('open', near)] });
  s = await until((x) => x.faces === 1 && x.lost === 1, 3000);
  t.assert(s.faces === 1 && s.lost === 1, `놓친 얼굴은 잠시 기억: ${JSON.stringify(s)}`);
  await t.sim({ faces: [tilted, friend] });
  s = await until((x) => x.faces === 2, 3000);
  const back = s.ears.find((e) => e.faceId !== b?.faceId);
  t.assert(back && back.faceId !== firstId && back.animal === 'rabbit', `돌아온 아이는 토끼 귀 그대로: ${JSON.stringify(s.ears)}`);

  // 8) 오래 사라지면 귀도 사라진다
  await t.sim({ faces: [{ ...tilted, visible: false }, friend] });
  await until((x) => x.faces === 1, 3000);
  await t.wait(1700);
  await until((x) => x.lost === 0, 4000);
  await t.sim({ faces: [tilted, friend] });
  s = await until((x) => x.faces === 2, 3000);
  const fresh = s.ears.find((e) => e.faceId !== b?.faceId);
  t.assert(fresh && fresh.animal === null, `오래 사라졌다 오면 새로 시작: ${JSON.stringify(s.ears)}`);
  await t.wait(500);
  await t.shot('9-after-lost');

  // 9) 얼굴이 없으면 안내
  await t.sim({ faces: [{ ...tilted, visible: false }, { ...friend, visible: false }] });
  s = await until((x) => x.faces === 0, 3000);
  await page
    .waitForFunction(() => document.getElementById('hint').textContent.includes('얼굴'), null, { timeout: 4000, polling: 50 })
    .catch(() => {});
  const hint = await page.evaluate(() => document.getElementById('hint').textContent);
  t.assert(s.faces === 0 && hint.includes('얼굴'), `얼굴이 없을 때 안내: ${hint}`);

  // 10) 창 크기가 바뀌어도 문제 없이
  await page.setViewportSize({ width: 860, height: 640 });
  const small = { x: 400, y: 340, size: 210, roll: 0.05, mouthOpen: 0, visible: true };
  const smallHand = { x: 620, y: 520, size: 120 };
  await t.sim({ faces: [small, { ...friend, visible: false }], hands: [hand('open', smallHand)] });
  await until((x) => x.faces === 1, 3000);
  await vAgain(smallHand);
  s = await until((x) => x.withEars === 1 && earsOf(x).scale > 0.95);
  t.assert(s.withEars === 1, `작은 창에서도 귀: ${JSON.stringify(s)}`);
  await t.shot('10-resized');
}
