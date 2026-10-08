// 동물 귀 놀이: 브이(✌️)를 하면 머리 위에 동물 귀가 뾱! 한 번 더 브이하면 다른 동물로 변신.
//
// 흐름
//   1) 손마다 브이를 지켜본다 (VWatcher). 새 브이 → 그 손과 가장 어울리는 얼굴을 고른다 (pickFace).
//   2) 손끝에서 마법 별이 머리로 날아가고, 닿으면 귀가 생기거나(처음) 다음 동물로 바뀐다.
//   3) 귀는 머리 틀(HeadMotion)을 따라가고, 귀마다 용수철(EarSpring)이 있어 고개를 흔들면 살랑살랑 흔들린다.
//   4) 얼굴마다 자기 동물을 가진다 (얼굴 id). 잠깐 놓쳤다가 근처에 다시 나타나면 귀를 돌려준다.
//   5) 브이 하나 = 변신 한 번: 별이 날아가는 중에 한 브이는 끝나자마자 이어서, 두 손으로 함께 한 브이는 한 번만.
//      얼굴이 안 보이는 아이(옆을 봄, 손이 얼굴을 가림, 화면 끝)의 브이는 다른 아이에게 주지 않고 잠깐 기다린다.
//   6) 귀 자리는 실제 사람 얼굴 비율(HEAD.camera)로, 연습 모드에서는 만화 얼굴 비율(HEAD.sim)로 잡는다.

import { ANIMALS, nextAnimal, firstAnimal, earReach } from './ears/animals.js';
import { HeadMotion, EarSpring, PopSpring, dirOf } from './ears/physics.js';
import { HEAD, headTarget, earAnchors, pickFace, pruneGhosts, VWatcher, findCarry, chooseHint, StableText, ParticlePool, HINTS } from './ears/logic.js';
import { drawEar, drawExtras, drawNameTag, drawParticles, drawMagicStar, FONT } from './ears/draw.js';
import { rand, pick, clamp } from '../core/math.js';

const FADE_OUT = 0.35; // 얼굴을 놓치면 귀가 작아지며 사라지는 시간
const CARRY_WINDOW = 1.5; // 이 시간 안에 근처에 얼굴이 다시 나타나면 같은 귀를 돌려준다
const SWITCH_COOLDOWN = 0.45; // 바뀐 뒤 잠깐 동안 들어온 브이는 '같이 한 브이'인지 살펴본다
const TOGETHER = 0.45; // 다른 손이 이 시간 안에 시작한 브이는 같은 브이 (두 손 브이 = 한 번)
const QUEUE_TIME = 1.5; // 별이 날아가는 중에 한 브이는 이 시간 안에 이어서 바꿔 준다
const GHOST_TIME = 1.5; // 사라진 얼굴 자리를 기억하는 시간 (그 아이의 브이를 남에게 주지 않게)
const OUT_TIME = 0.14; // 변신할 때 이전 귀가 쏙 들어가는 시간
const TAG_TIME = 1.8; // 이름표가 보이는 시간
const MAX_FLIGHTS = 6;
const SPARKLE_COLORS = ['#ffd54f', '#ffffff', '#ff8fb1', '#8fd3ff'];
const HINT_ZONE = { bottom: 112, halfWidth: 380 }; // 위쪽 가운데 안내 말풍선이 있는 곳 (화면 px)

export default {
  id: 'ears',
  title: '동물 귀',
  emoji: '🐰',
  color: '#f48fb1',
  description: '브이(✌️)를 하면 머리 위에 고양이·토끼 귀가 뿅! 또 브이하면 다른 동물로 변신해요.',
  hint: '브이 ✌️ 를 해 보세요!',
  needs: { face: true, mic: false },
  create(app) {
    /** @type {Map<number, object>} 얼굴 id → 얼굴 상태 */
    const states = new Map();
    /** 놓친 얼굴 상태 (귀 돌려주기 + 사라지는 모습) */
    let lost = [];
    /** 사라진 얼굴 자리 (귀가 있든 없든) */
    const ghosts = [];
    /** 브이 주인 후보 (얼굴 + 사라진 얼굴 자리) — 매번 새로 만들지 않게 재사용 */
    const cands = [];
    /** 손 key → 이미 '알아들었어요' 표시를 한(= 쓴) 브이의 since */
    const acked = new Map();
    const watcher = new VWatcher();
    const pool = new ParticlePool(160);
    const flights = [];
    const hintText = new StableText(0.45);
    let now = 0; // 실제 시각 (판정용)
    let clock = 0; // 애니메이션 시각 (dt 를 더한 값 — 프레임이 느려도 애니메이션과 박자가 맞는다)
    let switches = 0;
    let lastChange = -1;
    let celebrateAt = -1;
    const seen = new Set();
    /** 머리 모양: 실제 카메라 얼굴 / 연습 모드 만화 얼굴 */
    const profile = () => (app.isSim ? HEAD.sim : HEAD.camera);

    function newState(face) {
      return {
        id: face.id,
        face,
        head: new HeadMotion(),
        anchors: [{}, {}],
        springs: [new EarSpring(ANIMALS[0].phys), new EarSpring(ANIMALS[0].phys)],
        animal: -1,
        prevAnimal: -1,
        phase: 'none', // 'out' 이전 귀 들어감 → 'in' 새 귀 뾱
        phaseT: 0,
        pop: new PopSpring(0, { stiffness: 320, damping: 13 }),
        alive: true,
        lostAt: 0,
        visited: new Set(),
        allDone: false,
        cooldownUntil: 0,
        pending: false,
        queued: null, // 바쁠 때 들어온 브이 (끝나면 이어서)
        trigHand: -1, // 지금 변신을 일으킨 브이의 손 key 와 시작 시각
        trigSince: -10,
        nameT: -10,
        twitchAt: clock + rand(1.5, 3.5), // 움찔 시각은 애니메이션 시각(clock)으로 (프레임이 느려도 뾱 흔들림과 겹치지 않게)
        flickAt: -1,
        flickSide: 1,
        tagSlot: null,
      };
    }

    const animalOf = (st) => (st.phase === 'out' ? ANIMALS[st.prevAnimal] : st.animal >= 0 ? ANIMALS[st.animal] : null);

    /** 지금 그릴 귀 크기 */
    function earScale(st) {
      let s;
      if (st.phase === 'out') {
        const u = clamp(st.phaseT / OUT_TIME);
        s = 1 - u * u;
      } else s = st.pop.value;
      if (!st.alive) s *= clamp(1 - (now - st.lostAt) / FADE_OUT);
      return s;
    }

    // ------------------------------------------------------------ 소리, 반짝이

    function voice(A, delay = 0) {
      for (const v of A.voice) {
        const o = { ...v, delay: (v.delay || 0) + delay };
        if (v.kind === 'noise') app.sound.noise(o);
        else app.sound.tone(o);
      }
    }

    function burst(x, y, n, speed, size, colors, kinds = ['star', 'dot'], dir = null) {
      for (let i = 0; i < n; i++) {
        let a = rand(0, Math.PI * 2);
        if (dir) a = Math.atan2(dir.y, dir.x) + rand(-1.1, 1.1);
        const v = speed * rand(0.4, 1);
        pool.emit({
          x, y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          life: rand(0.45, 0.9),
          size: size * rand(0.6, 1.2),
          rot: rand(0, 6.28),
          spin: rand(-6, 6),
          color: pick(colors),
          kind: pick(kinds),
          gravity: speed * 0.9,
          drag: 2.2,
        });
      }
    }

    function puff(x, y, S) {
      for (let i = 0; i < 6; i++) {
        const a = rand(0, Math.PI * 2);
        const v = S * rand(0.4, 0.9);
        pool.emit({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.35, 0.5), size: S * rand(0.06, 0.1), color: '#ffffff', kind: 'puff', drag: 5 });
      }
    }

    function earTips(st, A) {
      // 반짝이를 뿌릴 귀 가운데쯤
      const S = st.head.size;
      return st.anchors.map((an) => {
        const d = dirOf(an.angle);
        const l = A.length * S * 0.55;
        return { x: an.x + d.x * l, y: an.y + d.y * l, d };
      });
    }

    // ------------------------------------------------------------ 귀 생기기 / 바뀌기

    /** 브이를 알아들었다는 표시 (손끝 빛 고리 + 삑) — 브이 하나에 한 번만 */
    function ack(v) {
      if (acked.get(v.handId) === v.since) return;
      acked.set(v.handId, v.since);
      const s = clamp((v.size || 84) / 140, 0.5, 2);
      pool.emit({ x: v.x, y: v.y, life: 0.35, size: 40 * s, color: '#ffd54f', kind: 'ring' });
      app.sound.pip(1.25);
    }

    /** 브이 사건 → 손 정보만 담은 작은 객체 (기다리게 둘 때 손 객체를 붙잡지 않도록) */
    const vInfo = (ev) => ({ x: ev.x, y: ev.y, handId: ev.key, size: ev.hand.size, since: ev.since, at: now });

    /** 손끝에서 마법 별이 머리로 날아간다 (닿으면 arrive) */
    function launch(st, v, kind) {
      if (flights.length >= MAX_FLIGHTS) return;
      ack(v);
      st.pending = true;
      st.queued = null;
      st.trigHand = v.handId;
      st.trigSince = v.since;
      const { x, y } = v;
      const dx = st.head.x - x;
      const dy = st.head.y - y;
      const dur = clamp(0.15 + Math.hypot(dx, dy) / (st.head.size * 14), 0.18, 0.3);
      flights.push({ st, x0: x, y0: y, t0: now, dur, kind, x, y, r: 0, rot: 0 });
      // 손끝에서 반짝!
      const s = clamp((v.size || st.head.size * 0.6) / 140, 0.5, 2);
      burst(x, y, 16, 320 * s, 13 * s, SPARKLE_COLORS, ['star', 'star', 'dot']);
    }

    function arrive(st, kind) {
      st.pending = false;
      const S = st.head.size;
      if (kind === 'give' || st.animal < 0) {
        const used = [];
        for (const o of states.values()) if (o !== st && o.animal >= 0) used.push(o.animal);
        st.animal = firstAnimal(used);
        st.phase = 'in';
        st.pop.value = 0;
        st.pop.velocity = 0;
        startAnimal(st);
        app.sound.chime();
        voice(ANIMALS[st.animal], 0.14);
        const A = ANIMALS[st.animal];
        earAnchors(st.head, A, st.anchors, profile());
        for (const tip of earTips(st, A)) burst(tip.x, tip.y, 16, S * 2.4, S * 0.05, [...SPARKLE_COLORS, A.colors.accent], ['star', 'heart', 'dot'], tip.d);
      } else {
        st.prevAnimal = st.animal;
        st.animal = nextAnimal(st.animal);
        st.phase = 'out';
        st.phaseT = 0;
        app.sound.pop(0.8);
        voice(ANIMALS[st.animal], 0.12);
      }
      st.visited.add(st.animal);
      st.nameT = clock;
      st.tagSlot = null;
      st.cooldownUntil = now + SWITCH_COOLDOWN;
      switches++;
      lastChange = now;
      // 축하 (가끔만): 토스트는 화면 가운데(얼굴 위)에 뜨므로 새 귀를 먼저 보고 난 뒤에
      if (!st.allDone && st.visited.size >= ANIMALS.length) {
        st.allDone = true;
        celebrateAt = now + 1.6;
      }
    }

    /** 새 동물의 흔들림 값으로 바꾸고 신나게 한 번 흔든다 */
    function startAnimal(st) {
      const A = ANIMALS[st.animal];
      st.springs.forEach((sp, i) => {
        sp.setPhys(A.phys);
        sp.theta = 0;
        sp.omega = (i === 0 ? -1 : 1) * 5;
      });
      // 뾱 흔들림이 끝난 뒤에 움찔 (얼굴이 보인 지 오래됐어도 나오자마자 겹쳐 파닥이지 않게)
      st.twitchAt = clock + rand(1.8, 3.5);
      st.flickAt = -1;
    }

    function twitch(st) {
      const A = ANIMALS[st.animal];
      const side = Math.random() < 0.5 ? 0 : 1;
      const dir = side === 0 ? -1 : 1;
      switch (A.twitch) {
        case 'flick': // 고양이·여우: 한쪽 귀를 바깥으로 파닥, 파닥
          st.springs[side].impulse(dir * 9);
          st.flickAt = clock + 0.16;
          st.flickSide = side;
          break;
        case 'flop': // 토끼: 한쪽 귀가 폴짝
          st.springs[side].impulse(dir * 5);
          break;
        case 'wiggle': // 곰·판다: 동그란 귀 둘 다 꼼지락
          st.springs[0].impulse(-3.5);
          st.springs[1].impulse(3.5);
          break;
        case 'shake': // 강아지: 늘어진 귀를 같은 쪽으로 살랑 (너무 세면 날개처럼 들린다)
          st.springs[0].impulse(3.5);
          st.springs[1].impulse(3.5);
          break;
        default:
      }
      st.twitchAt = clock + rand(2.2, 5.5);
    }

    // ------------------------------------------------------------ 매 프레임

    function syncFaces(faces) {
      seen.clear();
      for (const face of faces) {
        seen.add(face.id);
        let st = states.get(face.id);
        if (!st) {
          const target = headTarget(face, profile());
          const idx = findCarry(target, lost.map((l) => ({ x: l.head.x, y: l.head.y, size: l.head.size, lostAt: l.lostAt })), now, { window: CARRY_WINDOW });
          if (idx >= 0) {
            // 같은 아이가 돌아왔다: 귀를 그대로 돌려준다
            st = lost[idx];
            lost.splice(idx, 1);
            const shown = earScale(st);
            st.alive = true;
            st.id = face.id;
            if (st.phase !== 'out') {
              st.phase = 'in';
              st.pop.value = shown;
            }
            st.head.snap(target);
            st.queued = null;
          } else {
            st = newState(face);
            st.head.snap(target);
          }
          states.set(face.id, st);
        }
        st.face = face;
      }
      for (const [id, st] of states) {
        if (seen.has(id)) continue;
        states.delete(id);
        st.alive = false;
        st.lostAt = now;
        st.pending = false;
        st.queued = null;
        if (st.animal >= 0) lost.push(st);
        if (st.head.ready) ghosts.push({ x: st.head.x, y: st.head.y, size: st.head.size, lostAt: now, ghost: true });
      }
      lost = lost.filter((l) => now - l.lostAt <= CARRY_WINDOW);
      cands.length = 0;
      for (const st of states.values()) cands.push(st.head);
      pruneGhosts(ghosts, cands, now, GHOST_TIME);
    }

    function handleV(frame) {
      const events = watcher.update(frame.hands, now, frame);
      forgetHands();
      if (!events.length) return;
      // 후보: 보이는 얼굴들 + 잠깐 전에 사라진 얼굴 자리
      cands.length = 0;
      for (const st of states.values()) if (st.head.ready) cands.push(st.head);
      const live = cands.length;
      for (const g of ghosts) cands.push(g);
      for (const ev of events) {
        // 이미 쓴 브이를 계속 들고 있는 것: 옆에 새로 온 친구에게 공짜로 귀를 주지 않는다 (브이 하나 = 한 번)
        if (ev.type === 'held' && acked.get(ev.key) === ev.since) continue;
        const i = pickFace(ev.x, ev.y, ev.hand.size, cands);
        if (i < 0 || i >= live) {
          // 이 브이의 주인 얼굴이 안 보인다 (손이 얼굴을 가림, 옆을 봄, 화면 밖): 남에게 주지 않고 잠깐 기다린다
          if (ev.type === 'fresh') watcher.restore(ev.hand.id, now);
          continue;
        }
        const st = stateOfHead(cands[i]);
        if (!st) continue;
        if (st.pending || now < st.cooldownUntil) {
          if (ev.type !== 'fresh') continue;
          ack(vInfo(ev));
          // 두 손으로 함께 한 브이는 한 번만. 그 밖의 브이(같은 손으로 빠르게 또 브이 등)는 끝나면 이어서 바꾼다.
          const together = ev.key !== st.trigHand && Math.abs(ev.since - st.trigSince) < TOGETHER;
          if (!together) st.queued = vInfo(ev);
          continue;
        }
        if (st.animal < 0) launch(st, vInfo(ev), 'give');
        else if (ev.type === 'fresh') launch(st, vInfo(ev), 'switch');
      }
    }

    function stateOfHead(head) {
      for (const st of states.values()) if (st.head === head) return st;
      return null;
    }

    /** 아주 사라진 손의 '알아들음' 기록 지우기 (잠깐 놓쳐 이어질 수 있는 손은 남겨 둔다) */
    function forgetHands() {
      for (const key of acked.keys()) if (!watcher.isKnown(key)) acked.delete(key);
    }

    /** 바빠서 기다리던 브이를 이어서 쓴다 */
    function runQueue() {
      for (const st of states.values()) {
        const q = st.queued;
        if (!q) continue;
        if (now - q.at > QUEUE_TIME) st.queued = null;
        else if (!st.pending && now >= st.cooldownUntil) launch(st, q, st.animal < 0 ? 'give' : 'switch');
      }
    }

    function updateFlights() {
      for (let i = flights.length - 1; i >= 0; i--) {
        const f = flights[i];
        if (!f.st.alive) {
          f.st.pending = false;
          flights.splice(i, 1);
          continue;
        }
        const k = (now - f.t0) / f.dur;
        if (k >= 1) {
          flights.splice(i, 1);
          arrive(f.st, f.kind);
          continue;
        }
        // 위로 볼록한 길을 따라 정수리로
        const h = f.st.head;
        const tx = h.x + Math.sin(h.ang) * h.crown;
        const ty = h.y - Math.cos(h.ang) * h.crown;
        const mx = (f.x0 + tx) / 2;
        const my = Math.min(f.y0, ty) - h.size * 0.5;
        const e = 1 - (1 - k) * (1 - k);
        const a = 1 - e;
        f.x = a * a * f.x0 + 2 * a * e * mx + e * e * tx;
        f.y = a * a * f.y0 + 2 * a * e * my + e * e * ty;
        f.rot = k * 9;
        f.r = h.size * (0.1 + 0.05 * Math.sin(k * Math.PI));
        pool.emit({ x: f.x, y: f.y, vx: rand(-40, 40), vy: rand(-40, 40), life: 0.4, size: f.r * 0.45, color: pick(SPARKLE_COLORS), kind: Math.random() < 0.5 ? 'star' : 'dot', rot: rand(0, 6), spin: 4, drag: 3 });
      }
    }

    function updateState(st, dt) {
      const face = st.face;
      if (st.alive) st.head.update(headTarget(face, profile()), dt);
      if (st.phase === 'out') {
        st.phaseT += dt;
        if (st.phaseT >= OUT_TIME) {
          // 이전 귀가 쏙 들어갔다 → 펑! 새 귀가 뾱
          st.phase = 'in';
          st.pop.value = 0;
          st.pop.velocity = 0;
          startAnimal(st);
          const A = ANIMALS[st.animal];
          earAnchors(st.head, A, st.anchors, profile());
          for (const an of st.anchors) puff(an.x, an.y, st.head.size);
          for (const tip of earTips(st, A)) burst(tip.x, tip.y, 10, st.head.size * 2.2, st.head.size * 0.045, [...SPARKLE_COLORS, A.colors.accent], ['star', 'heart', 'dot'], tip.d);
        }
      }
      if (st.phase === 'in') {
        st.pop.target = 1;
        st.pop.step(dt);
      }
      const A = animalOf(st);
      if (!A) return;
      earAnchors(st.head, A, st.anchors, profile());
      const motion = st.alive ? st.head : { ax: 0, ay: 0, aa: 0, ang: st.head.ang };
      for (let i = 0; i < 2; i++) st.springs[i].step(dt, motion, st.anchors[i].rest, A.length);
      if (st.alive && st.animal >= 0 && st.phase === 'in') {
        if (clock >= st.twitchAt) twitch(st);
        if (st.flickAt > 0 && clock >= st.flickAt) {
          st.springs[st.flickSide].impulse((st.flickSide === 0 ? -1 : 1) * 6);
          st.flickAt = -1;
        }
      }
    }

    /** 귀 끝이 위쪽 안내 말풍선 자리에 들어갔는지 (긴 토끼 귀 등) */
    function earsUnderHint() {
      const W = app.width;
      for (const st of states.values()) {
        const A = animalOf(st);
        if (!A) continue;
        const L = A.length * st.head.size * earScale(st);
        for (let i = 0; i < 2; i++) {
          const an = st.anchors[i];
          const d = dirOf(an.angle + st.springs[i].theta);
          const x = an.x + d.x * L;
          const y = an.y + d.y * L;
          if (y < HINT_ZONE.bottom && Math.abs(x - W / 2) < HINT_ZONE.halfWidth) return true;
        }
      }
      return false;
    }

    function updateHint() {
      let biggest = null;
      for (const st of states.values()) if (!biggest || st.head.size > biggest.head.size) biggest = st;
      // 뒤에 멀리 지나가는 사람(아주 작은 얼굴)은 '친구'로 세지 않는다
      let faces = 0;
      let withEars = 0;
      for (const st of states.values()) {
        if (st.head.size < biggest.head.size * 0.45 && st.animal < 0) continue;
        faces++;
        if (st.animal >= 0) withEars++;
      }
      const animal = biggest && biggest.animal >= 0 ? ANIMALS[biggest.animal].id : null;
      const idle = lastChange >= 0 ? now - lastChange : 0;
      const mouthOpen = biggest?.face?.mouthOpen || 0;
      let text = chooseHint({ faces, withEars, animal, idle, mouthOpen });
      // 이미 브이로 바꿔 본 아이라면, 귀를 가리는 말풍선은 잠시 숨긴다 (꼭 필요한 안내는 그대로)
      const optional = text === HINTS.again || text === HINTS.shake || text === HINTS.tongue;
      if (optional && switches >= 2 && earsUnderHint()) text = '';
      if (hintText.push(text, now)) app.ui.hint(hintText.value);
    }

    // ------------------------------------------------------------ 그리기

    function drawState(ctx, st) {
      const A = animalOf(st);
      if (!A) return;
      const scale = earScale(st);
      if (scale <= 0.01) return;
      const S = st.head.size;
      if (!Number.isFinite(st.head.x + st.head.y + S + st.head.ang)) return;
      const fadeAlpha = st.alive ? 1 : clamp(1 - (now - st.lostAt) / FADE_OUT);
      // 뾱 할 때 길쭉해졌다 납작해졌다
      const stretch = st.phase === 'in' ? 1 + clamp(st.pop.velocity * 0.025, -0.18, 0.22) : 1;
      ctx.save();
      ctx.globalAlpha = fadeAlpha;
      // 먼 귀 먼저, 가까운 귀 나중에
      const order = st.anchors[0].near ? [1, 0] : [0, 1];
      for (const i of order) drawEar(ctx, A, st.anchors[i], S, st.springs[i].theta, scale, stretch);
      if (st.alive || fadeAlpha > 0) drawExtras(ctx, A, st.face, st.head.ang, S, Math.min(scale, 1.08), now);
      ctx.restore();
      drawTag(ctx, st, A);
    }

    /** 이번 프레임에 그린 이름표 자리 (서로 겹치지 않게) */
    const placedTags = [];

    /** 이름표 후보 자리가 다른 아이 얼굴·다른 이름표와 얼마나 겹치는지 (0 = 안 겹침) */
    function tagOverlap(st, x, y, w, hh) {
      let score = 0;
      for (const o of states.values()) {
        if (o === st) continue;
        const h = o.head;
        const cx = h.x + Math.sin(h.ang) * h.crown * 0.25;
        const cy = h.y - Math.cos(h.ang) * h.crown * 0.25;
        const r = h.size * 0.8;
        const dx = Math.max(Math.abs(cx - x) - w / 2, 0);
        const dy = Math.max(Math.abs(cy - y) - hh / 2, 0);
        const d = Math.hypot(dx, dy);
        if (d < r) score += r - d;
      }
      for (const t of placedTags) {
        const ox = Math.min(x + w / 2, t.x + t.w / 2) - Math.max(x - w / 2, t.x - t.w / 2);
        const oy = Math.min(y + hh / 2, t.y + t.h / 2) - Math.max(y - hh / 2, t.y - t.h / 2);
        if (ox > 0 && oy > 0) score += Math.min(ox, oy) * 2;
      }
      return score;
    }

    function drawTag(ctx, st, A) {
      const age = clock - st.nameT;
      if (age < 0 || age > TAG_TIME || !st.alive || st.phase === 'out') return;
      const S = st.head.size;
      const k = age < 0.3 ? popEase(age / 0.3) : 1;
      const alpha = age > TAG_TIME - 0.35 ? (TAG_TIME - age) / 0.35 : 1;
      const font = clamp(S * 0.16, 22, 44);
      const text = `${A.name} ${A.emoji}`;
      ctx.font = `${Math.round(font)}px ${FONT}`;
      const w = ctx.measureText(text).width + font * 1.2;
      const hh = font * 1.65;
      const h = st.head;
      const up = dirOf(h.ang);
      const r = { x: Math.cos(h.ang), y: Math.sin(h.ang) };
      const W = app.width;
      const H = app.height;
      const rise = age * 14;
      const cands = [];
      // 1) 귀 위 (위쪽 한 줄 — 안내 말풍선, 구석 버튼 — 은 비워 둔다)
      const reach = h.crown + (earReach(A) + 0.12) * S + font * 1.2 + rise;
      const ax = h.x + up.x * reach;
      const ay = h.y + up.y * reach;
      if (ay - font >= HINT_ZONE.bottom) cands.push({ x: ax, y: ay, slot: 'above' });
      // 2) 머리 옆, 귀 끝보다 바깥 (화면 가운데 쪽 먼저)
      const L = A.length * S * earScale(st);
      const first = h.x < W / 2 ? 1 : -1;
      for (const side of [first, -first]) {
        let lateral = S * 0.6;
        for (let i = 0; i < 2; i++) {
          const an = st.anchors[i];
          const d = dirOf(an.angle + st.springs[i].theta);
          const tip = (an.x + d.x * L - h.x) * r.x + (an.y + d.y * L - h.y) * r.y;
          lateral = Math.max(lateral, tip * side + S * 0.08);
        }
        const off = lateral + w / 2;
        cands.push({ x: h.x + r.x * side * off + up.x * h.crown * 0.55, y: h.y + r.y * side * off + up.y * h.crown * 0.55 - rise, slot: side > 0 ? 'right' : 'left' });
      }
      // 3) 턱 아래
      const chin = st.face.chin || { x: h.x, y: h.y + S };
      cands.push({ x: chin.x, y: chin.y + font * 1.4 + S * 0.08 - rise * 0.5, slot: 'chin' });
      let best = null;
      let bestScore = Infinity;
      let kept = null;
      for (const c of cands) {
        c.x = clamp(c.x, w / 2 + 8, W - w / 2 - 8);
        c.y = clamp(c.y, Math.max(font + 8, HINT_ZONE.bottom + hh / 2), H - 150);
        c.score = tagOverlap(st, c.x, c.y, w, hh);
        if (c.score < bestScore - 0.5) {
          best = c;
          bestScore = c.score;
        }
        if (c.slot === st.tagSlot) kept = c;
      }
      // 얼굴이 움직여도 이름표가 이리저리 뛰지 않게, 지금 자리가 크게 나빠지지 않으면 그대로
      if (kept && kept.score <= bestScore + S * 0.15) best = kept;
      st.tagSlot = best.slot;
      placedTags.push({ x: best.x, y: best.y, w, h: hh });
      drawNameTag(ctx, best.x, best.y, text, A.colors.accent, k, alpha, font);
    }

    return {
      enter() {
        app.ui.hint(null);
      },

      update(frame) {
        now = frame.t;
        const dt = frame.dt;
        clock += dt;
        syncFaces(frame.faces || []);
        handleV(frame);
        updateFlights();
        runQueue();
        for (const st of states.values()) updateState(st, dt);
        for (const st of lost) updateState(st, dt);
        pool.update(dt);
        if (celebrateAt > 0 && now >= celebrateAt) {
          celebrateAt = -1;
          app.ui.toast('동물 친구 모두 변신 성공! 🎉', 1400);
          app.sound.sparkle();
        }
        updateHint();
      },

      draw(ctx) {
        placedTags.length = 0;
        // 사라지는 귀 → 작은(먼) 얼굴 → 큰(가까운) 얼굴 순으로 (가까운 아이가 위에 보이게)
        for (const st of lost) drawState(ctx, st);
        const list = [...states.values()].sort((a, b) => a.head.size - b.head.size);
        for (const st of list) drawState(ctx, st);
        for (const f of flights) if (f.r) drawMagicStar(ctx, f.x, f.y, f.r, f.rot);
        drawParticles(ctx, pool);
      },

      resize() {
        // 크기에 따라 만든 버퍼가 없다. 날아가던 반짝이만 정리한다.
        pool.clear();
      },

      exit() {
        pool.clear();
        flights.length = 0;
        states.clear();
        lost = [];
        ghosts.length = 0;
        acked.clear();
        app.ui.hint(null);
      },

      state() {
        const ears = [];
        for (const st of states.values()) {
          ears.push({
            faceId: st.id,
            animal: st.animal >= 0 ? ANIMALS[st.animal].id : null,
            scale: Math.round(earScale(st) * 100) / 100,
            visited: st.visited.size,
            phase: st.phase,
            theta: Math.round((st.springs[0].theta + st.springs[1].theta) * 500) / 1000,
          });
        }
        return {
          faces: states.size,
          withEars: ears.filter((e) => e.animal).length,
          ears,
          switches,
          flights: flights.length,
          particles: pool.count,
          lost: lost.length,
          ghosts: ghosts.length,
          queued: [...states.values()].filter((st) => st.queued).length,
        };
      },
    };
  },
};

/** 0..1 → 살짝 넘쳤다 돌아오는 곡선 */
function popEase(u) {
  const c = 1.9;
  const x = u - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}
