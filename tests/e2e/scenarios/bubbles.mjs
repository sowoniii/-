// 비눗방울 놀이 자동 점검: 아무도 없음 → 불기 → 흔들기 → 콕 찌르기 → 꽉 잡기 → 휙 치기 → 10개 축하 → 두 손 → 손 사라짐 → 창 크기 바꾸기
//
// 소프트웨어 GPU 라 화면이 느리게(초당 몇 장) 돌 수 있어서, 정해진 시간만큼 기다리지 않고
// 상태가 될 때까지 기다린다(until).

export default async function scenario(t) {
  const { W, H } = t;
  const st = () => t.state();
  const until = async (pred, timeout = 10000, step = 120) => {
    const t0 = Date.now();
    let s = await st();
    while (!pred(s) && Date.now() - t0 < timeout) {
      await t.wait(step);
      s = await st();
    }
    return s;
  };
  const hintText = () => t.page.evaluate(() => document.getElementById('hint').textContent);
  const toastText = () => t.page.evaluate(() => document.getElementById('toast').textContent);
  /** 손가락으로 찌르기 좋은 방울 (화면 가운데쪽, 아래 버튼 막대와 먼 곳, 큰 것부터) */
  const pickTarget = (s) =>
    s.targets.filter((b) => b.y > 150 && b.y < H - 210 && b.x > 140 && b.x < W - 140).sort((a, b) => b.r - a.r)[0];
  /**
   * 손을 a↔b 사이로 왕복시킨다: 프레임마다 한 걸음씩, 실제 시간으로 speed(px/초)가 되게.
   * 기계가 바빠 화면이 초당 몇 장밖에 안 그려져도 한 걸음은 손 크기의 maxStep 배를 넘지 않는다
   * (그 이상 순간이동하면 추적기가 다른 손으로 본다). 프레임마다 놀이가 잰 손 속도를 돌려준다.
   * @returns {Promise<{speeds:number[], maxSpeed:number, tracked:boolean}>}
   */
  const frameSweep = async (hand, a, b, { speed, ms = 3000, maxStep = 1.2, others = [], index = 0, once = false, id = null, until: stop = () => false }) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let pos = 0;
    let dir = 1;
    const speeds = [];
    let tracked = true;
    const T0 = Date.now();
    let last = T0;
    let cur = await st();
    while (Date.now() - T0 < ms && !stop(cur)) {
      const now = Date.now();
      const step = Math.min(maxStep * hand.size, Math.max(8, (speed * (now - last)) / 1000));
      last = now;
      if (once && pos >= len) break;
      pos += dir * step;
      if (pos >= len) {
        pos = len;
        dir = -1;
      } else if (pos <= 0) {
        pos = 0;
        dir = 1;
      }
      const k = len ? pos / len : 0;
      const hs = [...others];
      hs.splice(index, 0, { ...hand, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      await t.sim({ hands: hs });
      const t0 = (await st()).t;
      cur = await until((v) => v.t > t0, 3000, 5);
      // 움직이는 손: id 를 알면 그 손, 아니면 처음 본 손 (다른 손들은 제자리)
      const mine = id === null ? cur.hands[0] : cur.hands.find((h) => h.id === id);
      if (!mine) tracked = false;
      else {
        if (id === null) id = mine.id;
        const w = cur.wands.find((x) => x.id === mine.id);
        speeds.push(w ? w.speed : 0);
      }
    }
    return { speeds, maxSpeed: Math.max(0, ...speeds), tracked };
  };
  // 오른손 'point' 자세(size 150)에서 검지 끝은 손바닥 중심에서 대략 이만큼 떨어져 있다 (synth.js 손 모양)
  const TIP = { dx: -69, dy: -173 };
  /** 검지 끝이 방울 가운데에 오도록 손을 옮기고 그 방울이 터질 때까지 기다린다 */
  const pokeAt = async (target, extra = []) => {
    const before = (await st()).poked;
    const hand = { x: target.x - TIP.dx, y: target.y - TIP.dy, size: 150, pose: 'point', side: 'right', angle: 0 };
    await t.sim({ hands: [hand, ...extra] });
    return until((s) => s.poked > before, 5000);
  };

  // 0) 아무도 없을 때: 방울 몇 개가 둥실둥실 떠다닌다
  await t.sim({ hands: [] });
  let s = await until((x) => x.free >= 4, 4000);
  t.assert(s.free >= 4, `아무도 없을 때 떠다니는 방울이 있어야 함 (free=${s.free})`);
  t.assert(s.popped === 0, '아무도 없는데 점수가 오르면 안 됨');
  await t.wait(400);
  await t.shot('1-idle');

  // 1) 손바닥을 펴면 손바닥에서 방울이 부풀어 나온다
  const open = { x: W * 0.5, y: H * 0.6, size: 150, pose: 'open', side: 'right', angle: 0 };
  await t.sim({ hands: [open] });
  s = await until((x) => x.growing >= 1, 6000);
  t.assert(s.growing >= 1, `펼친 손바닥에서 방울이 부풀어야 함 (growing=${s.growing})`);
  await t.wait(250);
  await t.shot('2-inflating');
  s = await until((x) => x.emitted >= 3, 20000);
  t.assert(s.emitted >= 3, `손바닥에서 방울이 여러 개 나와야 함 (emitted=${s.emitted})`);
  t.assert(s.popped === 0, `펼친 손은 방울을 터뜨리지 않아야 함 (popped=${s.popped})`);
  s = await until((x) => x.hint === 'poke', 3000);
  t.assert(s.hint === 'poke', `방울이 생기면 찌르기 안내가 나와야 함 (hint=${s.hint})`);
  const h1 = await hintText();
  t.assert(h1.includes('콕'), `안내 문구: ${h1}`);
  await t.shot('3-blowing');

  // 2) 손을 흔들면 작은 방울이 우르르, 손이 가는 쪽으로 (손 크기의 약 3배/초 — 살랑살랑)
  const before = s.emitted;
  // (지금 손이 있는 곳에서 시작해야 순간이동으로 다른 손이 되지 않는다)
  const wv = await frameSweep(open, { x: open.x, y: open.y }, { x: W * 0.2, y: H * 0.64 }, { speed: 450, ms: 12000, maxStep: 0.9, until: (x) => x.trail >= 3 });
  s = await st();
  // 손 크기 2.6배/초 넘게 흔든 프레임이 충분하면 작은 방울이 나와야 한다
  // (기계가 너무 바빠 초당 2~3장이면 추적이 끊기지 않는 걸음으로는 그만큼 빨리 못 흔든다 → 단위 테스트가 대신 확인)
  const fastFrames = wv.speeds.filter((v) => v >= 2.6 * open.size).length;
  if (s.trail > 0 || (wv.tracked && fastFrames >= 8)) {
    t.assert(s.trail > 0, `흔들면 작은 방울이 우르르 나와야 함 (trail=${s.trail}, 빠른 프레임 ${fastFrames})`);
  } else {
    console.log(`  (bubbles) 화면이 너무 느려 흔들기 확인은 건너뜀: 추적 ${wv.tracked}, 빠른 프레임 ${fastFrames}/${wv.speeds.length}`);
  }
  t.assert(s.emitted - before >= 3, `흔들면서도 방울이 계속 나와야 함 (+${s.emitted - before})`);
  // 펼친 손은 콕·잡기를 하지 않는다 (아주 세게 휘둘러 남의 방울을 치는 것만 터진다)
  t.assert(s.poked === 0 && s.caught === 0, `흔드는 펼친 손은 콕·잡기를 안 함 (poked=${s.poked}, caught=${s.caught})`);
  await t.shot('4-wave');

  // 3) 손가락으로 콕! (불던 손을 빼고 새 손으로 — 방금까지 불던 손은 자기 방울을 잠깐 안 터뜨린다)
  await t.sim({ hands: [] });
  await until((x) => x.wands.length === 0, 4000);
  s = await until((x) => !!pickTarget(x), 8000);
  let target = pickTarget(s);
  t.assert(!!target, '찌를 방울이 있어야 함');
  if (target) {
    s = await pokeAt(target);
    t.assert(s.poked >= 1, `검지로 찌르면 터져야 함 (poked=${s.poked})`);
    await t.shot('5-poke');
  }

  // 4) 손바닥을 펴서 방울에 대고 → 꽉 쥐면 잡았다!
  // (가리키던 손이 방울 사이를 순간이동하며 콕콕 터뜨리지 않게, 손을 먼저 뺐다가 새로 넣는다)
  await t.sim({ hands: [] });
  await until((x) => x.wands.length === 0, 4000);
  s = await until((x) => !!pickTarget(x), 8000);
  target = pickTarget(s);
  t.assert(!!target, '잡을 방울이 있어야 함');
  if (target) {
    const caughtBefore = s.caught;
    const at = { x: target.x, y: target.y + 10 };
    await t.sim({ hands: [{ ...open, ...at, pose: 'open' }] });
    s = await until((x) => x.hands.some((h) => h.pose === 'open' && !h.stale) && x.growing >= 1, 4000);
    const releasedBefore = s.released;
    await t.sim({ hands: [{ ...open, ...at, pose: 'fist' }] });
    s = await until((x) => x.caught > caughtBefore, 6000);
    t.assert(s.caught > caughtBefore, `꽉 쥐면 잡혀야 함 (caught=${s.caught})`);
    await t.wait(150);
    await t.shot('6-catch');
    // 손바닥에서 부풀던 방울도 같이 잡히거나 사르르 — 주먹 밖으로 날아가지 않는다
    s = await until((x) => x.growing === 0, 2000);
    t.assert(s.growing === 0, `주먹 안에 부풀던 방울이 남으면 안 됨 (growing=${s.growing})`);
    t.assert(s.released === releasedBefore, `잡을 때 방울이 주먹 밖으로 도망가면 안 됨 (released ${releasedBefore}→${s.released})`);
  }

  // 4-2) 친구가 분 방울을 펼친 손으로 휙 휘둘러 치면 뽁! (천천히 움직이는 펼친 손은 불기만 하고, 자기가 막 분 방울은 안 친다)
  const friend = { x: W * 0.5, y: H * 0.84, size: 150, pose: 'open', side: 'left', angle: 0 };
  await t.sim({ hands: [friend] });
  s = await until((x) => x.hands.length === 1 && x.hands[0].pose === 'open' && !x.hands[0].stale, 4000);
  const fid = s.hands[0] ? s.hands[0].id : -1;
  const pickSwat = (x) =>
    x.targets.filter((b) => b.o === fid && b.y > 150 && b.y < friend.y - 200 && b.x > 380 && b.x < W - 380).sort((a, b) => b.r - a.r)[0];
  s = await until((x) => !!pickSwat(x), 20000);
  let sw = pickSwat(s);
  t.assert(!!sw, `칠 방울이 있어야 함 (free=${s.free}, targets=${JSON.stringify(s.targets.map((b) => [b.x, b.y, b.o]))})`);
  if (sw) {
    // 손바닥+손가락 판(손바닥에서 손가락 쪽으로 손 크기의 약 0.6배)이 방울 높이를 지나가게
    const DISC = 0.6 * open.size;
    let from = { x: sw.x - 330, y: sw.y + DISC };
    await t.sim({ hands: [{ ...open, ...from }, friend] });
    s = await until((x) => x.hands.some((h) => h.id !== fid && h.pose === 'open' && !h.stale), 4000);
    // 기다리는 동안 방울이 떠올랐으니 다시 겨눈다 (휘두를 손이 분 방울은 빼고)
    const me = (s.hands.find((h) => h.id !== fid) || { id: -1 }).id;
    const near = s.targets.filter((b) => b.o !== me).sort((a, b) => Math.hypot(a.x - sw.x, a.y - sw.y) - Math.hypot(b.x - sw.x, b.y - sw.y))[0];
    if (near) sw = near;
    from = { x: from.x, y: sw.y + DISC };
    const swBefore = s.swatted;
    const pokedBefore = s.poked;
    const caughtBefore2 = s.caught;
    // 휙! 프레임마다 한 걸음 (실제 시간으로 손 크기의 6배/초, 한 걸음은 추적이 끊기지 않는 손 크기의 1.4배까지)
    const to = { x: sw.x + 330, y: from.y };
    const { speeds, maxSpeed, tracked } = await frameSweep(open, from, to, {
      speed: 6 * open.size,
      ms: 4000,
      maxStep: 1.4,
      others: [friend],
      index: 0,
      once: true,
      id: me,
      until: (x) => x.swatted > swBefore,
    });
    s = await until((x) => x.swatted > swBefore, 1500);
    // 휘두르는 내내(첫 걸음 빼고) 손 크기 3.5배/초보다 빨랐으면 반드시 터져야 한다
    const fastAll = tracked && speeds.length > 2 && speeds.slice(1).every((v) => v >= 3.5 * open.size);
    if (s.swatted > swBefore || fastAll) {
      t.assert(s.swatted > swBefore, `펼친 손을 휙 휘둘러 치면 터져야 함 (swatted=${s.swatted}, 속도 ${speeds.join(',')}px/s)`);
    } else {
      // 화면이 초당 2~3장밖에 안 그려지는 환경에선 '빠른 손'을 한 손으로 이어서 추적할 수 없다 (단위 테스트가 대신 확인)
      console.log(`  (bubbles) 화면이 너무 느려 휙 치기 확인은 건너뜀: 추적 ${tracked}, 잰 속도 ${maxSpeed}px/s`);
    }
    t.assert(s.poked === pokedBefore && s.caught === caughtBefore2, `펼친 손은 콕·잡기를 하지 않는다 (poked ${pokedBefore}→${s.poked}, caught ${caughtBefore2}→${s.caught})`);
    await t.shot('6b-swat');
  }

  // 5) 한 손은 불고, 한 손은 콕콕 → 10개 축하
  const blower = { x: W * 0.22, y: H * 0.7, size: 150, pose: 'open', side: 'left', angle: 0 };
  let sawToast = '';
  for (let round = 0; round < 30 && (await st()).popped < 10; round++) {
    s = await until((x) => !!pickTarget(x), 6000);
    const tg = pickTarget(s);
    if (!tg) continue;
    await pokeAt(tg, [blower]);
    const tt = await toastText();
    if (/10/.test(tt)) sawToast = tt;
  }
  s = await st();
  t.assert(s.popped >= 10, `10개 이상 터뜨려야 함 (popped=${s.popped})`);
  t.assert(s.milestone >= 10, `10개 축하 (milestone=${s.milestone})`);
  if (!sawToast) sawToast = await toastText();
  t.assert(/10|25/.test(sawToast), `축하 알림: ${sawToast}`);
  await t.shot('7-milestone');
  // 찌르기·잡기를 해 봤으니 다음 안내는 흔들기 (안내는 너무 자주 안 바뀌게 잠깐 머문다)
  // (앞에서 이미 충분히 흔들었으면 '마음껏 놀기' 로 바로 넘어간다)
  s = await until((x) => x.hint === 'wave' || x.hint === 'free', 25000, 300);
  t.assert(s.hint === 'wave' || s.hint === 'free', `잡고 나면 흔들기(또는 마음껏) 안내 (hint=${s.hint})`);
  const h2 = await hintText();
  t.assert(h2.includes(s.hint === 'wave' ? '흔들' : '몇 개'), `안내 문구: ${h2}`);

  // 6) 두 손 모두 펴서 불기 — 손마다 따로 방울이 나온다
  await t.sim({
    hands: [
      { x: W * 0.3, y: H * 0.62, size: 140, pose: 'open', side: 'left', angle: -0.3 },
      { x: W * 0.7, y: H * 0.62, size: 170, pose: 'open', side: 'right', angle: 0.3 },
    ],
  });
  s = await until((x) => x.wands.length === 2 && x.wands.every((w) => w.made >= 1), 20000);
  t.assert(s.wands.length === 2, `두 손 모두 막대가 있어야 함 (wands=${s.wands.length})`);
  t.assert(s.wands.every((w) => w.made >= 1), `두 손 모두 방울을 불어야 함 (${JSON.stringify(s.wands)})`);
  t.assert(s.bubbles <= 60, `방울 수 상한 (${s.bubbles})`);
  await until((x) => x.growing === 2, 3000);
  await t.shot('8-two-hands');

  // 7) 손이 사라지면 부풀던 방울은 날아가거나 사라지고, 손 상태는 정리된다
  await t.sim({ hands: [] });
  s = await until((x) => x.wands.length === 0 && x.growing === 0, 5000);
  t.assert(s.wands.length === 0, `사라진 손 상태 정리 (wands=${s.wands.length})`);
  t.assert(s.growing === 0, `손에 붙은 방울이 남으면 안 됨 (growing=${s.growing})`);
  t.assert(!s.windOn, '손이 없으면 바람 소리도 꺼져야 함');

  // 8) 창 크기를 바꿔도 방울은 화면 안에
  await t.page.setViewportSize({ width: 820, height: 600 });
  s = await until((x) => x.width === 820 && x.height === 600, 4000);
  t.assert(s.width === 820 && s.height === 600, `크기 반영 (${s.width}x${s.height})`);
  t.assert(s.inBounds, '창이 작아져도 방울이 화면 안에 있어야 함');
  await t.wait(500);
  await t.shot('9-resized');
  await t.page.setViewportSize({ width: W, height: H });
  await t.wait(300);
}
