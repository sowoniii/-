// 비눗방울 놀이의 안내 문구와 축하 (순수 로직, DOM 없음)
//
// 아이가 배워 가는 순서: 손바닥 펴기 → 콕 찌르기 → 꽉 잡기 → 흔들기 → 마음껏 놀기.
// 한 단계 문구를 너무 오래(maxShow) 보여 줘도 못 하면 다음으로 넘어가서 잔소리처럼 되지 않게 한다.
// 한 번 불어 본 뒤로는 '손바닥을 펴 보세요'(이미 하고 있는 것)로 되돌아가지 않는다.

export const HINTS = Object.freeze({
  poke: '손가락으로 콕! 찌르거나 꽉 잡아 보세요 👉',
  /** 찌르기 안내를 한참 봐도 못 터뜨렸을 때: 손 모양을 더 쉽게 알려 준다 */
  poke2: '손가락 하나만 쭉 펴서 방울을 콕! 👆',
  catch: '손을 꽉! 쥐면 방울을 잡을 수 있어요 ✊',
  wave: '펼친 손을 살랑살랑 흔들어 봐요 👋',
  free: '비눗방울을 몇 개나 터뜨릴 수 있을까요? 🫧',
});

/**
 * 지금 보여 주고 싶은 안내 단계. null 이면 놀이 기본 문구('손바닥을 활짝 펴 보세요').
 * @param {{live:number, emitted:number, popped:number, caught:number, bubbles:number, waved:boolean}} s
 * @param {Set<string>} [done] 충분히 보여 줘서 건너뛸 단계
 * @returns {'poke'|'poke2'|'catch'|'wave'|'free'|null}
 */
export function desiredHint(s, done = new Set()) {
  if (!s.live) return null;
  // 아직 손바닥으로 불어 본 적이 없으면 기본 문구(손바닥 펴기)가 먼저
  if (s.emitted === 0) return null;
  if (s.popped === 0) {
    // 화면에 방울이 하나도 없으면 먼저 불어야 한다
    if (s.bubbles === 0) return null;
    if (!done.has('poke')) return 'poke';
    if (!done.has('poke2')) return 'poke2';
    // 그래도 못 터뜨렸으면 잡기·흔들기 등 다른 놀이 방법으로 넘어간다 (기본 문구로 되돌아가지 않게)
  }
  if (s.caught === 0 && !done.has('catch')) return 'catch';
  if (!s.waved && !done.has('wave')) return 'wave';
  // 다 해 봤으면 마음껏 놀기
  return 'free';
}

/** 안내 문구가 너무 자주 바뀌지 않게 붙잡아 두고, 오래 본 단계는 졸업시킨다. */
export class HintCoach {
  constructor({ minShow = 2.2, maxShow = 14 } = {}) {
    this.minShow = minShow;
    this.maxShow = maxShow;
    this.current = null;
    this.shownFor = 0;
    this.total = new Map();
    this.done = new Set();
  }

  /** @returns {string|null} ui.hint 에 넘길 문구 */
  update(dt, stats) {
    this.shownFor += dt;
    if (this.current) {
      const tot = (this.total.get(this.current) || 0) + dt;
      this.total.set(this.current, tot);
      if (tot > this.maxShow && this.current !== 'free') this.done.add(this.current);
    }
    const want = desiredHint(stats, this.done);
    if (want !== this.current && (this.current === null || this.shownFor >= this.minShow || this.done.has(this.current))) {
      this.current = want;
      this.shownFor = 0;
    }
    return this.current ? HINTS[this.current] : null;
  }
}

/** 축하할 개수인지: 10, 25, 50, 75, 100, 그다음은 50개마다 */
export function isMilestone(n) {
  return n === 10 || n === 25 || n === 50 || n === 75 || n === 100 || (n > 100 && n % 50 === 0);
}

/** prev → next 로 늘어나는 동안 지나간 가장 큰 축하 개수 (없으면 null) */
export function crossedMilestone(prev, next) {
  let found = null;
  for (let n = prev + 1; n <= next; n++) if (isMilestone(n)) found = n;
  return found;
}

/** 축하 문구 */
export function milestoneText(n) {
  if (n <= 10) return `비눗방울 ${n}개 뽁! 🎉`;
  if (n <= 25) return `${n}개! 정말 잘해요 🌟`;
  if (n <= 50) return `${n}개! 비눗방울 대장 👑`;
  if (n <= 75) return `${n}개! 우와아 🎊`;
  if (n <= 100) return `${n}개! 비눗방울 박사님 🏆`;
  return `${n}개! 최고 최고 🥳`;
}
