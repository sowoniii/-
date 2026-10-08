// 말랑 화면 e2e: 주먹 잡기 → 당기기 → 비틀기 → 인식 흔들림 견디기 → 놓기(출렁) → 두 손 → 꼬집기(→ 주먹) → 창 크기 변경
//              → 화면 가장자리 잡기
// 헤드리스 브라우저는 느려서(소프트웨어 GPU, 3~10fps) 정해진 시간 대신 상태가 될 때까지 기다린다(until).
// (엔진이 dt 를 0.05초로 자르므로 느릴수록 놀이 속 시간은 실제보다 천천히 흐른다)
// folds = 손 밖에서 뒤집혀(접혀) 보이는 화면 넓이 px². 예전에는 주먹 둘레가 접혀 3만 px² 넘게 보였다.
export default async function scenario(t) {
  const hand = (o) => ({ size: 140, angle: 0, side: 'right', visible: true, pose: 'fist', ...o });
  const set = (hands) => t.sim({ hands });
  const state = () => t.state();
  /** cond(state) 가 참이 될 때까지 기다린다. 마지막 상태를 돌려준다. */
  async function until(cond, ms = 20000) {
    const end = Date.now() + ms;
    let s = await state();
    while (!cond(s) && Date.now() < end) {
      await t.wait(50);
      s = await state();
    }
    return s;
  }
  const J = (s) => JSON.stringify({ ...s, log: undefined });
  const FOLDS = 400;

  // 1) 펼친 손: 아직 아무것도 잡지 않고 '주먹 쥐기' 안내 고리가 보인다
  await set([hand({ x: 640, y: 430, pose: 'open' })]);
  await t.wait(900);
  let s = await state();
  t.assert(s.grabs === 0, `펼친 손은 잡지 않아야 함: ${J(s)}`);
  t.assert(!s.deformed, '처음엔 화면이 반듯해야 함');
  await t.shot('1-hover');

  // 2) 주먹 → 잡기
  await set([hand({ x: 640, y: 430 })]);
  s = await until((s) => s.grabs === 1);
  t.assert(s.grabs === 1 && s.kinds[0] === 'fist', `주먹으로 잡아야 함: ${J(s)}`);
  t.assert(s.hint && s.hint.includes('당겨'), `잡으면 '당겨 보세요' 안내: ${s.hint}`);
  await t.wait(120);
  await t.shot('2-grab');

  // 3) 당기기 → 화면이 따라온다. 주먹 둘레가 접히지 않는다.
  await t.move(hand({}), { x: 640, y: 430 }, { x: 930, y: 300 }, 700);
  s = await until((s) => s.maxOffset > 280);
  t.assert(s.maxOffset > 280, `당기면 크게 늘어나야 함: maxOffset=${s.maxOffset}`);
  t.assert(s.hint && s.hint.includes('돌려'), `당긴 뒤에는 '돌려 보세요' 안내: ${s.hint}`);
  await t.wait(500);
  s = await state();
  t.assert(s.folds < FOLDS, `당긴 채로 손 밖에서 화면이 접히면 안 됨: folds=${s.folds}`);
  await t.shot('3-pull');

  // 4) 비틀기 → 소용돌이 (멀리 당긴 채라 소용돌이는 조금 약하게, 아이가 돌린 손목은 그대로 잰다)
  for (let i = 1; i <= 16; i++) {
    await set([hand({ x: 930, y: 300, angle: i * 0.08 })]);
    await t.wait(40);
  }
  s = await until((s) => s.wrist > 1.1 && s.twist > 0.4);
  t.assert(s.wrist > 1.1, `손목을 돌린 만큼 잰다: wrist=${s.wrist}`);
  t.assert(s.twist > 0.4, `비틀면 소용돌이: twist=${s.twist}`);
  s = await until((s) => s.coach.twisted, 8000);
  t.assert(s.coach.twisted, '비틀기를 해 봤음 (잠깐 버티면)');
  await t.wait(400);
  s = await state();
  t.assert(s.folds < FOLDS, `비틀어도 손 밖에서 접히면 안 됨: folds=${s.folds}`);
  t.assert(s.toasts === 0, `혼자 놀 때 칭찬은 손 옆 글자로 (가운데 큰 글씨가 주먹을 가리지 않게): toasts=${s.toasts}`);
  await t.shot('4-twist');

  // 5) 인식 흔들림: 잠깐 다른 모양으로 읽혀도, 잠깐 손을 놓쳐도 계속 잡고 있다
  const A = 1.28;
  const before = await state();
  await set([hand({ x: 930, y: 300, angle: A, pose: 'other' })]);
  await t.wait(90);
  await set([hand({ x: 930, y: 300, angle: A })]);
  await t.wait(400);
  s = await state();
  t.assert(s.grabs === 1 && s.released === before.released && s.created === before.created, `깜빡임에 놓치면 안 됨: ${J(s)}`);
  // 짧게 사라짐(stale) → 그대로
  await set([hand({ x: 930, y: 300, angle: A, visible: false })]);
  await t.wait(100);
  await set([hand({ x: 930, y: 300, angle: A })]);
  await t.wait(400);
  s = await state();
  t.assert(s.grabs === 1 && s.created === before.created && s.released === before.released, `잠깐 사라져도 유지: ${J(s)}`);
  // 길게 사라져 손 추적이 끊김 → 잡기는 잠깐 남아 있고(orphan), 근처에 다시 나타난 주먹이 이어받는다
  await set([hand({ x: 930, y: 300, angle: A, visible: false })]);
  s = await until((s) => s.orphans === 1);
  t.assert(s.orphans === 1 && s.grabs === 1, `손을 놓쳐도 잠깐은 잡고 있어야 함: ${J(s)}`);
  t.assert(s.folds < FOLDS, `손을 놓친 동안에도(마지막 손 모습을 그대로 그림) 접히면 안 됨: folds=${s.folds}`);
  await set([hand({ x: 945, y: 310, angle: A })]);
  s = await until((s) => s.adopted >= 1 || s.grabs === 0 || s.created > before.created);
  t.assert(s.grabs === 1 && s.created === before.created && s.adopted >= 1, `다시 나타난 주먹이 이어받아야 함: ${J(s)}`);
  t.assert(s.maxOffset > 250, `이어받은 뒤에도 화면이 늘어난 채: ${s.maxOffset}`);

  // 6) 손을 펴면 놓고 젤리처럼 출렁이다가 제자리
  await set([hand({ x: 945, y: 310, angle: A, pose: 'open' })]);
  s = await until((s) => s.grabs === 0);
  t.assert(s.grabs === 0 && s.released === before.released + 1, `손을 펴면 놓아야 함: ${J(s)}`);
  t.assert(s.deformed, '놓은 직후엔 아직 출렁이는 중');
  await t.wait(150);
  await t.shot('5-release-wobble');
  s = await until((s) => s.sleeping, 60000);
  t.assert(!s.deformed && s.sleeping, `출렁임이 멈추고 제자리로: ${J(s)}`);
  t.assert(s.hint && s.hint.includes('두 손'), `놓은 뒤엔 두 손 안내: ${s.hint}`);
  await t.shot('6-rest');

  // 7) 두 손으로 양쪽 잡아당기기
  const pair = (dx, pose = 'fist') => [hand({ x: 480 - dx, y: 400, pose }), hand({ x: 800 + dx, y: 400, side: 'left', pose })];
  await set(pair(0));
  s = await until((s) => s.grabs === 2);
  t.assert(s.grabs === 2, `두 손이 각각 잡아야 함: ${J(s)}`);
  for (let i = 1; i <= 16; i++) {
    await set(pair(i * 12));
    await t.wait(40);
  }
  // 한 손당 192px 당김. 젤리가 이웃끼리 당겨 꼭짓점을 조금 둥글게 하므로 잡은 점은 거의(160px 넘게) 따라온다
  s = await until((s) => s.maxOffset > 160);
  t.assert(s.grabs === 2 && s.maxOffset > 160, `두 손으로 늘이기 (잡은 점이 손을 따라감): ${J(s)}`);
  t.assert(s.coach.two, '두 손 놀이를 해 봤음');
  await t.shot('7-two-hands');
  await t.wait(1800); // 칭찬 글자가 사라진 뒤 모습
  s = await state();
  t.assert(s.folds < FOLDS, `두 손으로 늘여도 손 밖에서 접히면 안 됨: folds=${s.folds}`);
  await t.shot('7b-two-hands-clean');
  await set(pair(192, 'open'));
  s = await until((s) => s.grabs === 0 && s.sleeping, 60000);
  t.assert(s.grabs === 0 && !s.deformed, `두 손을 놓으면 제자리: ${J(s)}`);
  t.assert(s.hint && s.hint.includes('꼬집'), `다음은 꼬집기 안내: ${s.hint}`);

  // 8) 꼬집기: 작은 부분만 쏙
  await set([hand({ x: 640, y: 330, pose: 'pinch' })]);
  s = await until((s) => s.grabs === 1);
  t.assert(s.grabs === 1 && s.kinds[0] === 'pinch', `꼬집기로 잡아야 함: ${J(s)}`);
  await t.move(hand({ pose: 'pinch' }), { x: 640, y: 330 }, { x: 770, y: 400 }, 400);
  s = await until((s) => s.maxOffset > 100);
  t.assert(s.maxOffset > 100, `꼬집어 당기기: ${s.maxOffset}`);
  await t.shot('8-pinch');
  await t.wait(1800);
  s = await state();
  t.assert(s.folds < FOLDS, `꼬집어 당겨도 접히면 안 됨: folds=${s.folds}`);
  await t.shot('8b-pinch-clean');
  // 꼬집다가 주먹을 쥐면 놓지 않고 그대로 큰 잡기로 바뀐다 (늘어난 모양 유지, 띠용 없음)
  const pinched = await state();
  await set([hand({ x: 770, y: 400 })]);
  s = await until((s) => s.kinds[0] === 'fist');
  t.assert(s.grabs === 1 && s.kinds[0] === 'fist' && s.converted >= 1, `꼬집기 → 주먹: ${J(s)}`);
  t.assert(s.released === pinched.released && s.created === pinched.created, `바뀔 때 놓았다 다시 잡지 않음: ${J(s)}`);
  await t.wait(500);
  s = await state();
  t.assert(s.maxOffset > 100, `바뀐 뒤에도 늘어난 채 (튕겨 돌아가지 않음): maxOffset=${s.maxOffset}`);

  // 9) 잡은 채로 창 크기가 바뀌어도 오류 없이 계속
  await t.page.setViewportSize({ width: 900, height: 700 });
  await t.wait(300);
  await t.move(hand({}), { x: 600, y: 380 }, { x: 420, y: 300 }, 400);
  s = await until((s) => s.maxOffset > 100);
  t.assert(s.grabs === 1 && s.maxOffset > 100, `창 크기 바뀐 뒤에도 잡기: ${J(s)}`);
  await t.wait(400);
  s = await state();
  t.assert(s.folds < FOLDS, `창 크기가 바뀌어도 접히면 안 됨: folds=${s.folds}`);
  await t.shot('9-resized');
  await t.page.setViewportSize({ width: t.W, height: t.H });
  await set([hand({ x: 420, y: 300, pose: 'open' })]);
  await until((s) => s.grabs === 0 && s.sleeping, 60000);

  // 10) 화면 오른쪽 끝에서 잡아 안쪽으로 크게 당겨도 화면 밖 여백(줄무늬)이 끌려 들어오지 않는다
  await set([hand({ x: 1185, y: 360 })]);
  s = await until((s) => s.grabs === 1);
  await t.move(hand({}), { x: 1185, y: 360 }, { x: 765, y: 360 }, 700);
  s = await until((s) => s.maxOffset > 300);
  await t.wait(500);
  s = await state();
  t.assert(s.maxOffset > 300, `가장자리에서도 잡아 당겨짐: ${s.maxOffset}`);
  t.assert(s.borderIn < 1, `화면 테두리는 안쪽으로 끌려오지 않음: borderIn=${s.borderIn}`);
  t.assert(s.folds < FOLDS, `가장자리 당기기 접힘: folds=${s.folds}`);
  await t.shot('10-edge');
  await set([hand({ x: 765, y: 360, pose: 'open' })]);
  s = await until((s) => s.grabs === 0);
  await t.wait(200);
  s = await state();
  t.assert(s.borderIn < 1, `출렁여도 테두리는 안쪽으로 넘어오지 않음: borderIn=${s.borderIn}`);

  // 11) 다른 놀이로 갔다가 돌아와도 깨끗하게 시작
  await t.page.evaluate(() => window.handplay.switchMode('bubbles'));
  await t.wait(300);
  await t.page.evaluate(() => window.handplay.switchMode('warp'));
  await t.wait(300);
  s = await state();
  t.assert(s.grabs === 0 && !s.deformed, `다시 들어오면 처음 상태: ${J(s)}`);
}
