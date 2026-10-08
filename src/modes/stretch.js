// 늘어나는 손가락: 한 손은 손가락을 펴고, 다른 손으로 그 손가락 끝을 집어 당기면 손가락이 쭈우욱 늘어난다.
//
// 흐름
//   1) 손마다 '꼭 집었는지'(grip) 상태를 히스테리시스로 판단한다 (stretch/logic.js).
//   2) 집는 순간, 집은 점 가까이에 다른 손의 펴진 손가락 끝이 있으면 그 손가락을 잡는다.
//   3) 잡는 동안 손가락 끝은 집은 점을 따라가고, 원래 손가락 영상 조각을 곡선 모양으로 늘여 그린다
//      (stretch/geometry.js → stage.drawPatch). 잡은 손에 가려 손가락 끝 인식이 흔들리므로, 잡기 직전의
//      손가락 길이·각도를 '손 기준'으로 기억해 두고 손가락 뿌리 위치와 손 방향으로 축을 매 프레임 다시 만든다.
//   4) 놓으면 스프링처럼 띠요옹~ 출렁이며 돌아가고, 너무 늘이면 뿅! 하고 저절로 돌아간다.
// 손이 여러 개면 여러 손가락을 동시에 늘일 수 있다 (손가락마다 '손id:손가락' 으로 따로 관리).

import { clamp, dist, lerp, smoothstep, TAU, wrapAngle } from '../core/math.js';
import {
  FINGER_BASE,
  FINGER_DIP,
  FINGER_TIP,
  FINGER_WIDTH,
  TIP_CAP,
  handAngle,
  measureFinger,
  fingerAxis,
  FingerMesh,
  CoverMesh,
} from './stretch/geometry.js';
import {
  newGrip,
  stepGrip,
  looksHeld,
  forceClosed,
  SNAP_COOL,
  hintLevel,
  findTarget,
  grabFraction,
  newFrame,
  followFrame,
  toLocal,
  toWorld,
  Rubber,
  PHYS,
  boingPitch,
  coverAmount,
  pullAmount,
} from './stretch/logic.js';

const COLOR = '#ffb74d';
const INK = '#2a2350';
const FONT = "'Jua', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif";
const EMOJI_FONT = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";

const MAX_STRETCHES = 6; // 동시에 늘일 수 있는 손가락 수
const MAX_SOUND = 2; // 고무 소리를 내는 손가락 수
const MAX_PARTICLES = 160;
const MAX_TEXTS = 8;
const GRAB_R = 0.5; // 집는 순간, 손가락 끝까지 허용 거리 (× 손 크기)
const TOUCH_R = 0.3; // 이미 집은 채로 손가락 끝에 갖다 대면 잡히는 거리
const AIM_R = 1.3; // 이만큼 가까우면 '지금 집어요!' 안내
const REVEAL_R = 1.7; // 펼친 손은 집는 손이 이만큼 와야 과녁을 보여 준다 (과녁이 너무 많지 않게)
const B_GRACE = 0.3; // 집던 손을 잠깐 놓쳐도 기다려 주는 시간(초)
const A_GRACE = 0.45; // 손가락 주인 손을 놓쳤을 때 기다려 주는 시간(초)
const MEM_FRESH = 1.5; // 기억해 둔 손가락 모양을 믿는 시간(초). 가려지기 직전 모양을 이만큼 기억한다
const MEM_COVERED = 6; // 펴진 채로 가려진 손가락은 가려진 동안 기억이 낡지 않는다 (망설이며 손을 대고 있어도 OK). 단 이만큼까지만
const MEM_KEEP_GAP = 0.4; // 가려지기 직전 이 시간 안에 펴진 모습을 봤어야 '펴진 채로 가려졌다'고 본다
const GHOST_AFTER = 5; // 마지막으로 늘이고(잡거나 띠요옹 돌아가는 중) 이만큼 지나면 다시 따라 하기 안내
const PULLED_QUIET = 2; // 방금까지 집어 당기던 손은 손을 펴도 이 시간 동안 자기 손가락에 과녁을 띄우지 않는다
const GHOST_PERIOD = 3.2; // 따라 하기 한 번 보여 주는 시간(초)
const PRIMARY_POSES = new Set(['point', 'v']);
const PRIMARY_ORDER = [1, 2, 0, 3, 4]; // 가리키기·브이가 아닌 손(활짝 편 손 등)은 이 순서로 손가락 하나에만 과녁을 보여 준다
const SIDES = [-1, 1];

const HINT = {
  oneExt: '다른 손으로 손가락 끝을 집어 보세요 🤏',
  oneNone: '손가락 하나를 쭉 펴 보세요 👆',
  twoTarget: '반짝이는 손가락 끝을 다른 손으로 꼭 집어요 🤏',
  twoNone: '한 손은 손가락을 쭉 펴고 👆 다른 손으로 끝을 집어요 🤏',
  aim: '지금! 엄지랑 검지로 꼬옥 집어요 🤏',
  held: '쭈우욱~ 멀리 당겨 봐요! 👉',
  long: '우와 길다! 손을 펴서 놓으면 띠용~ 🖐️',
  warn: '조심! 더 당기면 뿅! 할지도 몰라요 😮',
  released: '띠요옹~! 또 당겨 볼까요? 😆',
  snapped: '뿅! 너무 많이 늘였어요 😆 또 해 봐요',
};
const URGENT = new Set([HINT.aim, HINT.held, HINT.long, HINT.warn, HINT.released, HINT.snapped]);
const HELD_HINTS = [HINT.held, HINT.long, HINT.warn]; // hintLevel 0, 1, 2
const PARTICLE_COLORS = ['#ffd54f', '#ff8a65', '#fff59d', '#ffffff', '#ffb74d', '#f48fb1'];

export default {
  id: 'stretch',
  title: '늘어나는 손가락',
  emoji: '👆',
  color: COLOR,
  description: '한 손은 손가락을 쭉 펴고, 다른 손으로 손가락 끝을 집어서 쭈욱 당겨 봐요. 놓으면 띠용~!',
  hint: '한 손은 검지를 펴고 👆 다른 손으로 끝을 집어 당겨요 🤏',
  needs: { face: false, mic: false },
  create(app) {
    /** @type {Map<string, object>} '손id:손가락' → 늘어나는 손가락 */
    const stretches = new Map();
    const grips = new Map(); // 손id → 집기 상태
    const memory = new Map(); // 손id → 손가락별 기억 [{lrel, phi, t, ok}]
    const seen = new Map(); // 손id → 마지막으로 본 시각 (정리용)
    const byId = new Map();
    const pullers = new Set(); // 지금 손가락을 집고 있는 손
    const holders = new Set(); // 지금 손가락을 잡힌 손
    const meshPool = [];
    const particles = [];
    const texts = [];
    let live = [];
    const candidates = [];
    const targets = [];
    let aim = null;
    let ghost = null;
    let time = 0;
    let clock = 0; // 놀이 안 시간 (dt 합) — 느린 컴퓨터에서도 자동 점검이 같은 흐름으로 돌게
    let lastActiveT = -99; // 마지막으로 늘어난 손가락이 있던 시각
    const pulledAt = new Map(); // 손id → 마지막으로 손가락을 집어 당기던 시각
    let lastEvent = { kind: null, t: -99 };
    let lastToastT = -99;
    let lastAimKey = null;
    let lastAimSoundT = -99;
    let hintShown;
    let hintCand = null;
    let hintCandT = 0;
    let serial = 0;
    const stats = { grabs: 0, releases: 0, snaps: 0, best: 1 };
    const tmpL = { x: 0, y: 0 };

    // ------------------------------------------------------------ 손가락 기억

    function memFor(id) {
      let m = memory.get(id);
      if (!m) {
        m = [0, 1, 2, 3, 4].map(() => ({ lrel: 0, phi: 0, t: -99, ok: false, occluded: false, coverT: 0, keep: false }));
        memory.set(id, m);
      }
      return m;
    }

    function fresh(e) {
      return e.ok && time - e.t < MEM_FRESH;
    }

    /** 기억해 둔 모양으로 다시 만든 손가락 끝 (기억이 없으면 null) */
    function rememberedTip(h, f, e) {
      if (!fresh(e)) return null;
      const b = h.lm[FINGER_BASE[f]];
      return fingerAxis(b.x, b.y, handAngle(h.lm), h.size, e.lrel, e.phi).tip;
    }

    function nearTip(h, tip, hands) {
      for (const o of hands) {
        if (o === h) continue;
        if (dist(o.pinchPoint, tip) < 0.6 * h.size || dist(o.palm, tip) < 0.6 * h.size + 0.4 * o.size) return true;
      }
      return false;
    }

    /**
     * 다른 손이 이 손가락 끝을 가리고 있는지 (가려진 동안의 랜드마크는 믿지 않는다).
     * 가려지면 끝 랜드마크가 엉뚱한 곳(손바닥 쪽 등)으로 갈 수 있어서, 기억해 둔 끝 위치로도 확인한다.
     */
    function occluded(h, f, hands, e) {
      if (nearTip(h, h.lm[FINGER_TIP[f]], hands)) return true;
      const rt = rememberedTip(h, f, e);
      return !!rt && nearTip(h, rt, hands);
    }

    /**
     * 가려지지 않은 펴진 손가락의 길이·각도를 손 기준으로 기억해 둔다.
     * 펴진 채로 다른 손에 가려진 손가락은 가려진 동안 기억이 낡지 않게 한다: 아이가 손가락 끝에 손을 대고
     * 한참 망설여도 과녁·안내가 그대로 있고, 집으면 원래 길이로 잡힌다. (이미 굽혀 있던 손가락은 이어 주지 않는다)
     */
    function updateMemory(hands, dt) {
      for (const h of hands) {
        if (h.stale) continue;
        const m = memFor(h.id);
        for (let f = 0; f < 5; f++) {
          const e = m[f];
          e.occluded = occluded(h, f, hands, e);
          if (e.occluded) {
            if (e.coverT === 0) e.keep = e.ok && time - e.t < MEM_KEEP_GAP;
            e.coverT += dt;
            if (e.keep && e.coverT < MEM_COVERED) e.t = time;
            continue;
          }
          e.coverT = 0;
          e.keep = false;
          if (h.ext[f] < 0.5) continue;
          const cur = measureFinger(h.lm, h.size, f);
          if (!e.ok || time - e.t > 0.3) {
            e.lrel = cur.lrel;
            e.phi = cur.phi;
          } else {
            const k = 1 - Math.exp(-12 * dt);
            e.lrel += (cur.lrel - e.lrel) * k;
            e.phi = wrapAngle(e.phi + wrapAngle(cur.phi - e.phi) * k);
          }
          e.ok = true;
          e.t = time;
        }
      }
    }

    // ------------------------------------------------------------ 효과

    function burst(x, y, n, size, big) {
      for (let i = 0; i < n && particles.length < MAX_PARTICLES; i++) {
        const a = Math.random() * TAU;
        const sp = size * (big ? 2.2 + Math.random() * 3 : 0.8 + Math.random() * 1.6);
        particles.push({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0,
          max: 0.45 + Math.random() * (big ? 0.6 : 0.3),
          r: size * (big ? 0.07 + Math.random() * 0.07 : 0.03 + Math.random() * 0.03),
          color: PARTICLE_COLORS[(Math.random() * PARTICLE_COLORS.length) | 0],
          star: Math.random() < 0.6,
          spin: (Math.random() - 0.5) * 8,
        });
      }
    }

    function addText(x, y, text, size, color, big = false) {
      if (texts.length >= MAX_TEXTS) texts.shift();
      // 위쪽 안내 말풍선과 아래 놀이 막대에 가리지 않는 곳에
      const w = app.width;
      const h = app.height;
      const fs = clamp(size * (big ? 0.5 : 0.32), big ? 44 : 26, big ? 84 : 64);
      texts.push({ x: clamp(x, fs * 2, w - fs * 2), y: clamp(y, 130 + fs / 2, h - 150 - fs / 2), text, size: fs, color, life: 0, max: big ? 1.3 : 1.1 });
    }

    function toast(text, minGap = 4) {
      if (time - lastToastT < minGap) return;
      lastToastT = time;
      app.ui.toast(text);
    }

    function stopSound(st) {
      if (!st.sounding) return;
      app.sound.stopLoop(st.sound);
      app.sound.stopLoop(st.sound + '-c');
      st.sounding = false;
    }

    // ------------------------------------------------------------ 늘이기 시작/끝

    function makeStretch(A, B, cand) {
      const f = cand.f;
      const m = memFor(A.id)[f];
      let lrel;
      let phi;
      if (fresh(m)) {
        lrel = m.lrel;
        phi = m.phi;
      } else {
        ({ lrel, phi } = measureFinger(A.lm, A.size, f));
      }
      const base = A.lm[FINGER_BASE[f]];
      const theta = handAngle(A.lm);
      const ax = fingerAxis(base.x, base.y, theta, A.size, lrel, phi);
      const gfrac = grabFraction(B.pinchPoint, ax.base, ax.dir, ax.len);
      const meshes = meshPool.pop() || { mesh: new FingerMesh(), cover: new CoverMesh() };
      const st = {
        key: cand.key,
        aId: A.id,
        bId: B.id,
        f,
        rubber: new Rubber(lrel, phi, gfrac),
        frame: newFrame(),
        meshes,
        fingerPatch: { pos: meshes.mesh.pos, src: meshes.mesh.src, alpha: meshes.mesh.alpha, indices: meshes.mesh.indices, tint: [1, 0.25, 0.3, 0], opacity: 1 },
        coverL: { pos: meshes.cover.pos, src: meshes.cover.srcL, alpha: meshes.cover.alphaL, indices: meshes.cover.indices, opacity: 0 },
        coverR: { pos: meshes.cover.pos, src: meshes.cover.srcR, alpha: meshes.cover.alphaR, indices: meshes.cover.indices, opacity: 0 },
        axis: ax,
        end: { x: B.pinchPoint.x, y: B.pinchPoint.y },
        ctrlW: { x: 0, y: 0 },
        ratio: 1,
        pull: 1,
        peak: 1,
        lastRatio: 1,
        speed: 0,
        tension: 0,
        cover: 0,
        aLost: 0,
        bLost: 0,
        lastPinch: { x: B.pinchPoint.x, y: B.pinchPoint.y },
        bSize: B.size,
        bSeenT: time, // 집던 손을 마지막으로 제대로 본 시각
        bSpeed: 0, // 그때 손 빠르기 (px/초) — 놓쳤다 다시 잡힐 때 찾는 범위
        vis: 1, // 손가락 주인 손을 놓치면 서서히 사라진다 (0..1)
        lastPalm: { x: A.palm.x, y: A.palm.y },
        aSize: A.size,
        said3: false,
        said5: false,
        built: false,
        sound: `stretch-${++serial}`,
        sounding: false,
      };
      followFrame(st.frame, base, theta, A.size, 0);
      stretches.set(cand.key, st);
      return st;
    }

    function grab(B, cand) {
      let st = stretches.get(cand.key);
      if (st) {
        // 돌아가던 손가락을 다시 잡았다
        st.rubber.regrab();
        st.bId = B.id;
        st.bLost = 0;
        st.lastPinch.x = B.pinchPoint.x;
        st.lastPinch.y = B.pinchPoint.y;
        st.bSize = B.size;
        st.bSeenT = time;
        st.bSpeed = 0;
        st.peak = st.ratio;
      } else {
        st = makeStretch(cand.hand, B, cand);
      }
      stats.grabs++;
      app.sound.squeak(1.3);
      app.sound.pip(1.5);
      burst(B.pinchPoint.x, B.pinchPoint.y, 10, cand.size, false);
      return st;
    }

    function releaseStretch(st, snapped) {
      st.rubber.release();
      stopSound(st);
      stats.releases++;
      lastEvent = { kind: snapped ? 'snap' : 'release', t: time };
      const e = st.end;
      if (snapped) {
        stats.snaps++;
        app.sound.pop(0.7);
        app.sound.tone({ type: 'square', freq: 1100, to: 160, dur: 0.22, gain: 0.07 });
        app.sound.boing(1.6);
        burst(e.x, e.y, 30, st.aSize, true);
        addText(e.x, e.y, '뿅!', st.aSize, '#ff5a7a', true);
        // 뿅! 하는 순간 집은 점이 손가락 끝 바로 위라서, 잠깐 쉬지 않으면 곧바로 다시 잡혀 또 뿅! 한다
        const g = grips.get(st.bId);
        if (g) g.cool = SNAP_COOL;
        toast('뿅! 너무 늘였다~ 😆', 2);
      } else {
        app.sound.boing(boingPitch(st.peak));
        if (st.peak > 1.4) addText(e.x, e.y, '띠용~', st.aSize, COLOR);
        burst(e.x, e.y, 8, st.aSize, false);
      }
    }

    function removeStretch(st) {
      stopSound(st);
      meshPool.push(st.meshes);
      stretches.delete(st.key);
    }

    /**
     * 손가락 주인 손을 놓쳤다가 새 id 로 다시 잡혔으면 이어 붙인다.
     * 늘어나는 손가락은 '손id:손가락' 이름으로 관리하므로 이름도 새 id 로 바꾼다
     * (안 바꾸면 가려진 원래 손가락 끝에 과녁이 다시 생기고, 같은 손가락을 두 번 늘일 수 있게 된다).
     */
    function adoptA(st) {
      let best = null;
      let bd = Infinity;
      for (const h of live) {
        if (pullers.has(h.id)) continue;
        const other = stretches.get(`${h.id}:${st.f}`);
        if (other && other !== st) continue; // 그 손의 같은 손가락은 이미 따로 늘어나는 중
        const d = dist(h.palm, st.lastPalm);
        if (d < 0.9 * st.aSize && d < bd) {
          best = h;
          bd = d;
        }
      }
      if (best) {
        stretches.delete(st.key);
        st.aId = best.id;
        st.key = `${best.id}:${st.f}`;
        stretches.set(st.key, st);
        holders.add(best.id);
      }
      return best;
    }

    /**
     * 집던 손을 놓쳤다가 새 id 로 다시 잡혔으면(여전히 집은 채로) 이어 붙인다.
     *  - 막 나타난 손은 집기 상태가 처음부터라, 느슨하게 집은 손(0.3..0.5)도 '집고 있음'으로 본다.
     *  - 휙 당기다 놓친 손은 멀리서 다시 잡히므로, 놓친 시간 × 빠르기만큼, 그 사이 새로 나타난 손은 더 넓게 찾는다.
     */
    function adoptB(st) {
      const gap = Math.max(0, time - st.bSeenT);
      const reach = 0.9 * st.bSize + Math.min(st.bSpeed * gap * 1.3, 3 * st.bSize);
      const reachNew = Math.max(reach, 2.2 * st.bSize);
      let best = null;
      let bd = Infinity;
      for (const h of live) {
        if (h.id === st.aId || pullers.has(h.id) || holders.has(h.id)) continue;
        const g = grips.get(h.id);
        if (!g || g.cool > 0 || !(g.closed || looksHeld(h))) continue;
        const d = dist(h.pinchPoint, st.lastPinch);
        const appeared = h.age <= gap + 0.15; // 놓친 뒤에 새로 나타난 손
        if (d < (appeared ? reachNew : reach) && d < bd) {
          best = h;
          bd = d;
        }
      }
      if (best) {
        forceClosed(grips.get(best.id));
        pullers.delete(st.bId);
        st.bId = best.id;
        pullers.add(best.id);
      }
      return best;
    }

    // ------------------------------------------------------------ 매 프레임

    function buildGeometry(st) {
      const r = st.rubber;
      const fr = st.frame;
      const size = fr.size;
      const ax = fingerAxis(fr.bx, fr.by, fr.theta, size, r.lrel, r.phi);
      st.axis = ax;
      toWorld(fr, r.phi, r.ctrl, st.ctrlW);
      toWorld(fr, r.phi, r.end, st.end);
      const width = FINGER_WIDTH[st.f] * size;
      const cap = TIP_CAP * size;
      const mesh = st.meshes.mesh;
      st.ratio = mesh.build({ base: ax.base, dir: ax.dir, len: ax.len, grab: r.gs * size, width, cap, ctrl: st.ctrlW, end: st.end });
      st.pull = pullAmount(st.ratio, r.end, r.gs);
      st.cover = coverAmount(mesh.deviation(ax.base, ax.dir, ax.len), width, st.ratio);
      if (st.cover > 0.01) st.meshes.cover.build({ base: ax.base, dir: ax.dir, len: ax.len, width, cap, size });
      st.coverL.opacity = st.cover * st.vis;
      st.coverR.opacity = st.cover * st.vis;
      st.fingerPatch.opacity = st.vis;
      st.fingerPatch.tint[3] = 0.32 * st.tension;
      st.built = true;
    }

    function stepStretch(st, dt) {
      let A = byId.get(st.aId);
      if (!A) A = adoptA(st);
      if (A) {
        st.aLost = 0;
        st.vis = Math.min(1, st.vis + dt * 8);
        if (!A.stale) {
          followFrame(st.frame, A.lm[FINGER_BASE[st.f]], handAngle(A.lm), A.size, dt);
          st.lastPalm.x = A.palm.x;
          st.lastPalm.y = A.palm.y;
          st.aSize = A.size;
        }
      } else {
        // 손가락 주인 손이 화면 밖으로 나갔다: 그 자리 영상은 이제 배경이라 빈 '고무관'처럼 보이므로 서서히 지우고,
        // 끝까지 안 돌아오면 띠용~ 소리와 함께 놓는다
        st.aLost += dt;
        st.vis = Math.max(0, Math.min(st.vis, 1 - st.aLost / A_GRACE));
        if (st.aLost > A_GRACE) {
          if (st.rubber.phase === 'held') releaseStretch(st, false);
          removeStretch(st);
          return;
        }
      }

      const r = st.rubber;
      if (r.phase === 'held') {
        let B = byId.get(st.bId);
        if (!B) B = adoptB(st);
        const g = B ? grips.get(B.id) : null;
        if (B && g && g.closed) {
          st.bLost = 0;
          if (!B.stale) {
            st.lastPinch.x = B.pinchPoint.x;
            st.lastPinch.y = B.pinchPoint.y;
            st.bSize = B.size;
            st.bSeenT = time;
            st.bSpeed = Math.hypot(B.velocity.x, B.velocity.y);
          }
        } else if (B) {
          releaseStretch(st, false); // 손을 폈다 → 놓기
        } else {
          st.bLost += dt;
          if (st.bLost > B_GRACE) releaseStretch(st, false);
        }
        if (r.phase === 'held') {
          toLocal(st.frame, r.phi, st.lastPinch, tmpL);
          const jitter = st.tension > 0 ? Math.sin(time * 47) * 0.06 * st.tension * r.gs : 0;
          r.hold(tmpL.x, tmpL.y, dt, jitter);
        } else {
          r.step(dt);
        }
      } else if (r.step(dt)) {
        removeStretch(st);
        return;
      }

      buildGeometry(st);

      if (r.phase === 'held') {
        st.speed += (Math.abs(st.ratio - st.lastRatio) / Math.max(dt, 1e-3) - st.speed) * 0.25;
        st.peak = Math.max(st.peak, st.ratio);
        stats.best = Math.max(stats.best, st.ratio);
        st.tension = smoothstep(PHYS.warnRatio, PHYS.snapRatio, st.pull);
        if (st.ratio > 3 && !st.said3) {
          // 손가락 가운데에서 '쭈우욱~!' 글자가 뿅 튀어나온다 (화면 가운데를 가리지 않게)
          st.said3 = true;
          const m = st.meshes.mesh;
          const k = m.nb + (m.nm >> 1);
          addText(m.cx[k] - m.nx[k] * st.aSize * 0.45, m.cy[k] - m.ny[k] * st.aSize * 0.45, '쭈우욱~!', st.aSize, COLOR);
          app.sound.sparkle();
        }
        if (st.ratio > 5 && !st.said5) {
          st.said5 = true;
          toast('기린 손가락이다! 🦒', 3);
        }
        if (st.pull > PHYS.snapRatio) releaseStretch(st, true);
      } else {
        st.tension = Math.max(0, st.tension - dt * 3);
        st.speed = 0;
      }
      st.lastRatio = st.ratio;
    }

    /** 잡을 수 있는 손가락 목록 */
    function collectCandidates() {
      candidates.length = 0;
      for (const A of live) {
        if (pullers.has(A.id)) continue;
        const gA = grips.get(A.id);
        const pinching = gA && gA.closed;
        const mem = memFor(A.id);
        for (let f = 0; f < 5; f++) {
          const key = `${A.id}:${f}`;
          const st = stretches.get(key);
          if (st) {
            // 돌아가는 중인 손가락은 지금 보이는 끝을 다시 집을 수 있다
            if (st.rubber.phase === 'release' && st.built) {
              const m = st.meshes.mesh;
              const k = m.nb + m.nm;
              candidates.push({ handId: A.id, hand: A, f, key, tip: st.end, dip: { x: m.cx[k], y: m.cy[k] }, size: A.size, primary: false, regrab: true });
            }
            continue;
          }
          const e = mem[f];
          const remembered = fresh(e);
          // 집고 있는 손(OK 모양 등)의 손가락은 과녁으로 쓰지 않는다. 단, 가려진 손가락 끝이 엄지 옆으로 잘못
          // 인식되어 '집기'처럼 보이는 경우가 있어서, 방금까지 펴져 있다가 가려진 손가락은 그대로 둔다.
          if (pinching && !(remembered && e.occluded)) continue;
          // 다른 손에 가려지면 펴짐 점수가 흔들리므로, 방금 전까지 펴져 있던 손가락은 계속 잡을 수 있게 둔다
          if (!(A.extended[f] || (remembered && (A.ext[f] > 0.4 || e.occluded)))) continue;
          const lrel = remembered ? e.lrel : measureFinger(A.lm, A.size, f).lrel;
          if (lrel < 0.4) continue;
          let tip = A.lm[FINGER_TIP[f]];
          let dip = A.lm[FINGER_DIP[f]];
          if (remembered && e.occluded) {
            // 가려진 손가락 끝은 인식이 엉뚱해지기 쉬워서, 기억해 둔 모양으로 끝 위치를 다시 만든다
            const b = A.lm[FINGER_BASE[f]];
            tip = rememberedTip(A, f, e);
            dip = { x: b.x + (tip.x - b.x) * 0.72, y: b.y + (tip.y - b.y) * 0.72 };
          }
          candidates.push({
            handId: A.id,
            hand: A,
            f,
            key,
            tip,
            dip,
            size: A.size,
            primary: PRIMARY_POSES.has(A.pose),
            regrab: false,
            near: Infinity,
            nearClosed: false,
            nearId: null,
          });
        }
        // 지금 늘어나는 손의 다른 손가락, 방금 놓은(손을 편) 손에는 띄우지 않는다 (띠용~ 하는 순간이 어수선하지 않게)
        if (!holders.has(A.id) && !(time - (pulledAt.get(A.id) ?? -99) < PULLED_QUIET)) promotePrimary(A.id);
      }
    }

    /**
     * 가리키기·브이가 아닌 손(아이들이 제일 먼저 하는 활짝 편 손 등)도 손가락 하나(검지 먼저)에는 과녁과
     * 따라 하기 안내를 보여 준다. 나머지 손가락 과녁은 집는 손이 가까이 올 때만 (너무 어수선하지 않게).
     */
    function promotePrimary(handId) {
      let first = candidates.length;
      while (first > 0 && candidates[first - 1].handId === handId) first--;
      if (first === candidates.length) return;
      let best = null;
      let bestRank = Infinity;
      for (let i = first; i < candidates.length; i++) {
        const c = candidates[i];
        if (c.regrab) continue;
        if (c.primary) return;
        const rank = PRIMARY_ORDER.indexOf(c.f);
        if (rank < bestRank) {
          best = c;
          bestRank = rank;
        }
      }
      if (best) best.primary = true;
    }

    function tryGrabs() {
      for (const B of live) {
        const g = grips.get(B.id);
        if (!g || !g.closed || g.cool > 0 || pullers.has(B.id) || holders.has(B.id)) continue;
        const justNow = g.justClosed;
        // 집는 순간이거나, 이미 집은 채로 손가락 끝에 갖다 댔을 때
        if (!justNow && g.closedT < 0.12) continue;
        const hit = findTarget(B.pinchPoint, candidates, justNow ? GRAB_R : TOUCH_R, B.id);
        if (!hit) continue;
        if (!hit.target.regrab && stretches.size >= MAX_STRETCHES) continue;
        grab(B, hit.target);
        candidates.splice(candidates.indexOf(hit.target), 1);
        pullers.add(B.id);
        holders.add(hit.target.handId);
      }
    }

    function collectTargets() {
      targets.length = 0;
      aim = null;
      for (const c of candidates) {
        if (c.regrab) continue;
        let near = Infinity;
        let nearClosed = false;
        let nearPt = null;
        let nearId = null;
        for (const B of live) {
          if (B.id === c.handId || pullers.has(B.id) || holders.has(B.id)) continue;
          // 뿅! 한 뒤 쉬는 손은 지금 집어도 안 잡히니 '꼬옥 집어요!' 라고 하지 않는다
          if (grips.get(B.id)?.cool > 0) continue;
          const d = dist(B.pinchPoint, c.tip) / c.size;
          if (d < near) {
            near = d;
            nearClosed = !!grips.get(B.id)?.closed;
            nearPt = B.pinchPoint;
            nearId = B.id;
          }
        }
        if (!(c.primary || near < REVEAL_R)) continue;
        c.near = near;
        c.nearClosed = nearClosed;
        c.nearPt = nearPt;
        c.nearId = nearId;
        targets.push(c);
        if (near < AIM_R && (!aim || near < aim.near)) aim = c;
      }
      if (aim) {
        // 집으러 다가가는 손 자기 손가락의 과녁은 치운다 (집는 손 바로 옆에 과녁이 겹쳐 헷갈리지 않게)
        for (let i = targets.length - 1; i >= 0; i--) if (targets[i].handId === aim.nearId) targets.splice(i, 1);
      }
      if (aim && aim.key !== lastAimKey && time - lastAimSoundT > 0.8) {
        app.sound.tone({ type: 'sine', freq: 1250, dur: 0.05, gain: 0.06 });
        lastAimSoundT = time;
      }
      lastAimKey = aim ? aim.key : null;

      // 따라 하기 안내 (유령 손 🤏): 아무도 잡고 있지 않을 때 가장 잡기 좋은 손가락에
      ghost = null;
      if (!stretches.size && !aim && time - lastActiveT > GHOST_AFTER) {
        let best = null;
        let bestScore = -1;
        for (const c of targets) {
          if (!c.primary) continue;
          const score = (c.f === 1 ? 2 : 0) + (c.hand.pose === 'point' ? 1 : 0);
          if (score > bestScore) {
            best = c;
            bestScore = score;
          }
        }
        if (best) ghost = { c: best, p: (time % GHOST_PERIOD) / GHOST_PERIOD };
      }
    }

    function heldList() {
      const out = [];
      for (const st of stretches.values()) if (st.rubber.phase === 'held') out.push(st);
      return out;
    }

    function updateSound(held) {
      held.sort((a, b) => b.ratio - a.ratio);
      for (let i = 0; i < held.length; i++) {
        const st = held[i];
        if (i >= MAX_SOUND) {
          stopSound(st);
          continue;
        }
        const mv = clamp(st.speed / 3);
        // 늘일수록 올라가는 '쭈우욱' 슬라이드 휘슬 + 움직일 때 고무 삐걱 소리
        app.sound.loop(st.sound, {
          type: 'triangle',
          freq: (170 + 90 * st.ratio) * (1 + 0.025 * Math.sin(time * TAU * 6)),
          gain: 0.012 + 0.07 * mv + 0.03 * st.tension,
        });
        app.sound.loop(st.sound + '-c', { type: 'noise', freq: 600 + 260 * st.ratio, q: 9, gain: 0.06 * mv });
        st.sounding = true;
      }
    }

    function chooseHint(held) {
      if (!held.length && lastEvent.kind) {
        // 놓은 직후, 그리고 손가락이 아직 띠요옹 출렁이는 동안은 '또 당겨 볼까요?'
        let springing = false;
        for (const st of stretches.values()) if (st.rubber.phase === 'release') springing = true;
        if (springing || time - lastEvent.t < 1.4) return lastEvent.kind === 'snap' ? HINT.snapped : HINT.released;
      }
      if (held.length) {
        let r = 0;
        let p = 0;
        for (const st of held) {
          r = Math.max(r, st.ratio);
          p = Math.max(p, st.pull);
        }
        // 경계에서 손이 조금 흔들려도 안내가 왔다 갔다 하지 않게 지금 보이는 안내를 기준으로 여유를 둔다
        const prev = hintShown === HINT.warn ? 2 : hintShown === HINT.long ? 1 : 0;
        return HELD_HINTS[hintLevel(prev, r, p)];
      }
      if (aim && !aim.nearClosed) return HINT.aim;
      if (live.length >= 2) return targets.length ? HINT.twoTarget : HINT.twoNone;
      if (live.length === 1) return candidates.length ? HINT.oneExt : HINT.oneNone;
      return null;
    }

    function updateHint(held, dt) {
      const want = chooseHint(held);
      if (want === hintShown) {
        hintCand = null;
        return;
      }
      if (want !== hintCand) {
        hintCand = want;
        hintCandT = 0;
      } else {
        hintCandT += dt;
      }
      // 급한 안내는 바로, 나머지는 잠깐 그대로일 때만 바꿔서 깜빡이지 않게
      if (URGENT.has(want) || hintCandT > 0.35) {
        hintShown = want;
        hintCand = null;
        app.ui.hint(want);
      }
    }

    function updateEffects(dt) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.life >= p.max) {
          particles[i] = particles[particles.length - 1];
          particles.pop();
          continue;
        }
        const drag = Math.exp(-3 * dt);
        p.vx *= drag;
        p.vy = p.vy * drag + 300 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      for (let i = texts.length - 1; i >= 0; i--) {
        const t = texts[i];
        t.life += dt;
        t.y -= 40 * dt;
        if (t.life >= t.max) texts.splice(i, 1);
      }
    }

    // ------------------------------------------------------------ 그리기 (2D 덧그림)

    /** 늘어난 손가락 모양(가운데~손끝, 둥근 끝) 경로. dx, dy 만큼 옮겨서 그릴 수 있다 (그림자용). */
    function fingerPath(ctx, m, r0, r1, dx, dy) {
      for (let r = r0; r <= r1; r++) {
        const x = m.cx[r] - m.nx[r] * m.hw[r] + dx;
        const y = m.cy[r] - m.ny[r] * m.hw[r] + dy;
        if (r === r0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const a0 = Math.atan2(-m.ny[r1], -m.nx[r1]);
      ctx.arc(m.cx[r1] + dx, m.cy[r1] + dy, m.hw[r1], a0, a0 + Math.PI, false);
      for (let r = r1; r >= r0; r--) ctx.lineTo(m.cx[r] + m.nx[r] * m.hw[r] + dx, m.cy[r] + m.ny[r] * m.hw[r] + dy);
      ctx.closePath();
    }

    function drawStretch(ctx, st, width, height) {
      const m = st.meshes.mesh;
      const size = st.frame.size;
      const a = Math.max(smoothstep(1.06, 1.5, st.ratio), smoothstep(0.95, 0.8, st.ratio), smoothstep(0.08, 0.35, st.rubber.displacement));
      if (a > 0.01) {
        const r0 = m.nb;
        const r1 = m.rows - 3;
        // 살짝 아래로 떨어진 그림자 (손가락 바깥에만: 손가락 모양을 뚫어 낸 영역에 그린다) → 화면 위로 떠 보인다
        const sx = size * 0.03;
        const sy = size * 0.07;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        fingerPath(ctx, m, r0, r1, 0, 0);
        ctx.clip('evenodd');
        ctx.beginPath();
        fingerPath(ctx, m, r0 + 2, r1, sx, sy);
        const k = Math.min(r0 + 6, r1);
        const grad = ctx.createLinearGradient(m.cx[r0 + 2], m.cy[r0 + 2], m.cx[k], m.cy[k]);
        grad.addColorStop(0, 'rgba(60,30,20,0)');
        grad.addColorStop(1, `rgba(60,30,20,${0.2 * a})`);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // 손가락 테두리 (늘어난 모양이 또렷하게)
        ctx.strokeStyle = `rgba(150,75,45,${0.34 * a})`;
        ctx.lineWidth = Math.max(1.5, size * 0.012);
        for (const side of SIDES) {
          ctx.beginPath();
          for (let r = r0; r <= r1; r++) {
            const x = m.cx[r] + m.nx[r] * m.hw[r] * side;
            const y = m.cy[r] + m.ny[r] * m.hw[r] * side;
            if (r === r0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        // 말랑한 고무 광택
        ctx.strokeStyle = `rgba(255,255,255,${0.32 * a})`;
        ctx.lineWidth = Math.max(2, size * 0.028);
        ctx.beginPath();
        const s0 = r0 + 2;
        const s1 = m.nb + m.nm - 1;
        for (let r = s0; r <= s1; r++) {
          const x = m.cx[r] - m.nx[r] * m.hw[r] * 0.45;
          const y = m.cy[r] - m.ny[r] * m.hw[r] * 0.45;
          if (r === s0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      if (st.rubber.phase === 'held') {
        // 집은 곳 반짝이
        const e = st.end;
        const pulse = 0.5 + 0.5 * Math.sin(time * 10);
        ctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.3 * pulse})`;
        ctx.lineWidth = Math.max(2, size * 0.022);
        ctx.beginPath();
        ctx.arc(e.x, e.y, size * (0.2 + 0.03 * pulse), 0, TAU);
        ctx.stroke();
        for (let i = 0; i < 3; i++) {
          const ang = time * 4 + (i * TAU) / 3;
          const R = size * 0.27;
          drawStar(ctx, e.x + Math.cos(ang) * R, e.y + Math.sin(ang) * R, size * 0.045, ang, i === 0 ? '#fff59d' : '#ffffff');
        }
        if (st.tension > 0.05) {
          // 너무 늘이면 '부들부들' 표시
          const k = (m.nb + m.nb + m.nm) >> 1;
          ctx.strokeStyle = `rgba(255,80,90,${0.8 * st.tension})`;
          ctx.lineWidth = Math.max(2, size * 0.02);
          for (const side of SIDES) {
            const ox = m.cx[k] + m.nx[k] * (m.hw[k] + size * 0.12) * side;
            const oy = m.cy[k] + m.ny[k] * (m.hw[k] + size * 0.12) * side;
            const tx = -m.ny[k];
            const ty = m.nx[k];
            const w = Math.sin(time * 40) * size * 0.02;
            ctx.beginPath();
            ctx.moveTo(ox - tx * size * 0.12 + m.nx[k] * w, oy - ty * size * 0.12 + m.ny[k] * w);
            ctx.lineTo(ox + tx * size * 0.12 - m.nx[k] * w, oy + ty * size * 0.12 - m.ny[k] * w);
            ctx.stroke();
          }
        }
      }
    }

    function drawTarget(ctx, c, aiming) {
      const { tip, size } = c;
      const pulse = 0.5 + 0.5 * Math.sin(time * 6 + c.f * 1.3);
      let R = size * (0.19 + 0.035 * pulse);
      if (aiming) R = size * lerp(0.15, 0.23, clamp((c.near - 0.3) / 1));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, R, 0, TAU);
      ctx.lineWidth = size * 0.1;
      ctx.strokeStyle = `rgba(255,183,77,${aiming ? 0.5 : 0.22 + 0.18 * pulse})`;
      ctx.stroke();
      ctx.lineWidth = Math.max(2.5, size * 0.025);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.save();
      ctx.setLineDash([size * 0.07, size * 0.055]);
      ctx.lineDashOffset = -time * size * 0.5;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, R + size * 0.065, 0, TAU);
      ctx.strokeStyle = COLOR;
      ctx.lineWidth = Math.max(2.5, size * 0.03);
      ctx.stroke();
      ctx.restore();
      if (aiming) {
        for (let i = 0; i < 4; i++) {
          const ang = -time * 3 + (i * TAU) / 4;
          drawStar(ctx, tip.x + Math.cos(ang) * (R + size * 0.16), tip.y + Math.sin(ang) * (R + size * 0.16), size * 0.04, ang, '#fff59d');
        }
      }
    }

    /**
     * 손가락 끝 주변 방향 정하기: dir = 손가락 방향, n = 다른 손(없으면 화면 가운데) 쪽 옆 방향.
     * 유령 손은 n 쪽에서 다가와 손가락 방향과 n 사이로 당기고, 안내 글자는 반대쪽(-n)에 둔다 → 서로 겹치지 않는다.
     */
    function tipFrame(c, width, height) {
      const { tip, dip } = c;
      let dx = tip.x - dip.x;
      let dy = tip.y - dip.y;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      let nx = -dy;
      let ny = dx;
      const ref = c.nearPt || { x: width / 2, y: height / 2 };
      if (nx * (ref.x - tip.x) + ny * (ref.y - tip.y) < 0) {
        nx = -nx;
        ny = -ny;
      }
      return { dx, dy, nx, ny };
    }

    function drawLabel(ctx, c, text, width, height) {
      const { tip, size } = c;
      const { dx, dy, nx, ny } = tipFrame(c, width, height);
      const fs = Math.round(clamp(size * 0.17, 18, 32));
      ctx.font = `${fs}px ${FONT}`;
      const tw = ctx.measureText(text).width;
      const bw = tw + fs * 1.1;
      const bh = fs * 1.7;
      // 손가락 끝에서 '다른 손 반대쪽' 옆으로, 상자 크기만큼 더 떨어뜨린다
      const reach = size * 0.36 + Math.abs(nx) * (bw / 2) + Math.abs(ny) * (bh / 2);
      let x = tip.x - nx * reach + dx * size * 0.25;
      let y = tip.y - ny * reach + dy * size * 0.25;
      x = clamp(x, bw / 2 + 10, width - bw / 2 - 10);
      y = clamp(y, bh / 2 + 110, height - bh / 2 - 130);
      const bob = Math.sin(time * 4) * fs * 0.12;
      roundRect(ctx, x - bw / 2, y - bh / 2 + bob, bw, bh, bh / 2);
      ctx.fillStyle = 'rgba(255,253,247,0.95)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLOR;
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + bob + fs * 0.05);
    }

    function drawGhost(ctx, g, width, height) {
      const c = g.c;
      const { tip, size } = c;
      const base = c.hand.lm[FINGER_BASE[c.f]];
      const len = dist(base, tip);
      const { dx, dy, nx, ny } = tipFrame(c, width, height);
      const start = { x: tip.x + nx * size * 0.95 + dx * size * 0.2, y: tip.y + ny * size * 0.95 + dy * size * 0.2 };
      // 당기는 쪽: 손가락 방향과 유령 손 쪽 사이 (화면 밖이면 화면 가운데 쪽)
      let vx = dx + nx * 0.8;
      let vy = dy + ny * 0.8;
      let vl = Math.hypot(vx, vy) || 1;
      let px = tip.x + (vx / vl) * len * 1.5;
      let py = tip.y + (vy / vl) * len * 1.5;
      if (px < 60 || px > width - 60 || py < 110 || py > height - 140) {
        vx = width / 2 - tip.x;
        vy = height / 2 - tip.y;
        vl = Math.hypot(vx, vy) || 1;
        px = tip.x + (vx / vl) * len * 1.5;
        py = tip.y + (vy / vl) * len * 1.5;
      }
      const p = g.p;
      const ease = (k) => k * k * (3 - 2 * k);
      let x;
      let y;
      let alpha = 1;
      let squeeze = 1;
      let stretch = 0;
      if (p < 0.3) {
        const k = ease(p / 0.3);
        x = lerp(start.x, tip.x, k);
        y = lerp(start.y, tip.y, k);
        alpha = smoothstep(0, 0.1, p);
      } else if (p < 0.42) {
        x = tip.x;
        y = tip.y;
        squeeze = 1 - 0.18 * Math.sin(((p - 0.3) / 0.12) * Math.PI);
      } else if (p < 0.78) {
        const k = ease((p - 0.42) / 0.36);
        x = lerp(tip.x, px, k);
        y = lerp(tip.y, py, k);
        stretch = k;
      } else {
        x = px;
        y = py;
        stretch = 1;
        alpha = 1 - smoothstep(0.86, 1, p);
      }
      ctx.save();
      ctx.globalAlpha = 0.85 * alpha;
      if (stretch > 0) {
        // 늘어나는 모습 미리 보기 (말랑한 띠)
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(x, y);
        ctx.lineWidth = size * 0.17;
        ctx.strokeStyle = 'rgba(255,224,178,0.75)';
        ctx.stroke();
        ctx.setLineDash([size * 0.06, size * 0.06]);
        ctx.lineDashOffset = -time * size * 0.4;
        ctx.lineWidth = Math.max(2, size * 0.02);
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const fs = Math.round(size * 0.62 * squeeze);
      ctx.font = `${fs}px ${EMOJI_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 이모지의 집는 손가락 끝이 (x, y) 에 오도록 조금 옮겨 그린다
      ctx.fillText('🤏', x + fs * 0.12, y + fs * 0.3);
      ctx.restore();
    }

    function drawEffects(ctx) {
      for (const p of particles) {
        const k = 1 - p.life / p.max;
        ctx.globalAlpha = clamp(k * 1.5);
        if (p.star) drawStar(ctx, p.x, p.y, p.r * (0.6 + 0.4 * k), p.life * p.spin, p.color);
        else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * k, 0, TAU);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      for (const t of texts) {
        const k = t.life / t.max;
        const pop = k < 0.15 ? 0.6 + 0.4 * (k / 0.15) + 0.25 * Math.sin((k / 0.15) * Math.PI) : 1;
        ctx.globalAlpha = 1 - smoothstep(0.7, 1, k);
        ctx.font = `${Math.round(t.size * pop)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(4, t.size * 0.16);
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(t.text, t.x, t.y);
        ctx.fillStyle = t.color;
        ctx.fillText(t.text, t.x, t.y);
      }
      ctx.globalAlpha = 1;
    }

    return {
      enter() {
        app.ui.hint(null);
      },

      update(frame) {
        time = frame.t;
        const dt = frame.dt;
        clock += dt;
        const hands = frame.hands;
        byId.clear();
        for (const h of hands) {
          byId.set(h.id, h);
          seen.set(h.id, time);
        }
        live = hands.filter((h) => !h.stale);
        // 사라진 손의 상태 정리
        for (const [id, t] of seen) {
          if (time - t > 1.5) {
            seen.delete(id);
            grips.delete(id);
            memory.delete(id);
            pulledAt.delete(id);
          }
        }
        for (const h of hands) {
          let g = grips.get(h.id);
          if (!g) {
            g = newGrip();
            grips.set(h.id, g);
          }
          stepGrip(g, h, dt);
        }
        updateMemory(hands, dt);

        pullers.clear();
        holders.clear();
        for (const st of stretches.values()) {
          if (st.rubber.phase === 'held') {
            pullers.add(st.bId);
            holders.add(st.aId);
          }
        }
        for (const st of [...stretches.values()]) stepStretch(st, dt);
        pullers.clear();
        holders.clear();
        for (const st of stretches.values()) {
          if (st.rubber.phase === 'held') {
            pullers.add(st.bId);
            holders.add(st.aId);
            pulledAt.set(st.bId, time);
          }
        }
        if (stretches.size) lastActiveT = time;

        collectCandidates();
        tryGrabs();
        collectTargets();

        const held = heldList();
        updateSound(held);
        updateHint(held, dt);
        updateEffects(dt);
      },

      drawGL(stage) {
        // 원래 손가락 자리를 먼저 모두 덮고, 그 위에 늘어난 손가락들을 그린다
        for (const st of stretches.values()) {
          if (st.built && st.cover * st.vis > 0.01) {
            stage.drawPatch(st.coverL);
            stage.drawPatch(st.coverR);
          }
        }
        for (const st of stretches.values()) if (st.built && st.vis > 0.01) stage.drawPatch(st.fingerPatch);
      },

      draw(ctx, frame) {
        for (const st of stretches.values()) {
        if (!st.built || st.vis < 0.01) continue;
        ctx.save();
        ctx.globalAlpha = st.vis;
        drawStretch(ctx, st, frame.width, frame.height);
        ctx.restore();
      }
        for (const c of targets) drawTarget(ctx, c, c === aim);
        if (ghost) drawGhost(ctx, ghost, frame.width, frame.height);
        const labelC = aim || ghost?.c || (live.length >= 2 && !pullers.size ? targets.find((c) => c.primary) : null);
        if (labelC) drawLabel(ctx, labelC, aim ? '꼬옥 집어요!' : '여기를 집어요!', frame.width, frame.height);
        drawEffects(ctx);
      },

      exit() {
        for (const st of stretches.values()) stopSound(st);
        stretches.clear();
        grips.clear();
        memory.clear();
        seen.clear();
        pulledAt.clear();
        meshPool.length = 0;
        particles.length = 0;
        texts.length = 0;
        app.ui.hint(null);
      },

      state() {
        return {
          stretches: [...stretches.values()].map((st) => ({
            handA: st.aId,
            handB: st.bId,
            finger: st.f,
            ratio: Math.round(st.ratio * 100) / 100,
            pull: Math.round(st.pull * 100) / 100,
            phase: st.rubber.phase === 'held' ? 'held' : 'release',
            cover: Math.round(st.cover * 100) / 100,
          })),
          targets: targets.length,
          targetKeys: targets.map((c) => c.key),
          aim: !!aim,
          ghost: ghost ? Math.round(ghost.p * 100) / 100 : null,
          hands: live.length,
          grabs: stats.grabs,
          releases: stats.releases,
          snaps: stats.snaps,
          best: Math.round(stats.best * 100) / 100,
          hint: hintShown ?? null,
          clock: Math.round(clock * 1000) / 1000,
        };
      },
    };
  },
};

// ---------------------------------------------------------------- 그리기 도우미

function drawStar(ctx, x, y, r, rot, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = rot + (i * Math.PI) / 4;
    const rr = i % 2 ? r * 0.38 : r;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
