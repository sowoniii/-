// 비눗방울 놀이: 손바닥을 활짝 펴면 비눗방울이 퐁퐁 나오고, 손가락으로 콕 찌르거나 꽉 잡아서 터뜨린다.
//
// 나뉜 파일
//   bubbles/physics.js  방울 세상 (만들기, 떠다니기, 바람, 터뜨리기 판정) — 순수 로직
//   bubbles/render.js   진짜 같은 비눗방울 그림 (크기별 스프라이트 미리 그려 두기), 손바닥 고리
//   bubbles/effects.js  터질 때 고리·물방울·글자·별
//   bubbles/coach.js    안내 문구 단계와 축하

import { clamp, damp, Spring, TAU } from '../core/math.js';
import { BubbleWorld } from './bubbles/physics.js';
import { BubbleArt, stepWandRings } from './bubbles/render.js';
import { PopEffects, FONT } from './bubbles/effects.js';
import { HintCoach, crossedMilestone, milestoneText } from './bubbles/coach.js';

const WIND_LOOP = 'bubbles-wind';
/** 이만큼(초) 아무 손도 안 보이면 다음 친구를 위해 점수와 안내를 처음으로 */
const FRESH_START_AFTER = 25;
const COUNTER = { x: 16, y: 16, h: 56, iconR: 17 };

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default {
  id: 'bubbles',
  title: '비눗방울',
  emoji: '🫧',
  color: '#4fc3f7',
  description: '손바닥을 활짝 펴면 비눗방울이 퐁퐁! 손가락으로 콕 찌르거나 꽉 잡아서 터뜨려요.',
  hint: '손바닥을 활짝 펴 보세요 🖐️',
  needs: { face: false, mic: false },
  create(app) {
    const world = new BubbleWorld({ width: app.width, height: app.height });
    const art = new BubbleArt();
    const fx = new PopEffects();
    let coach = new HintCoach();
    /** hand.id → 손바닥 막대 고리 {v 보이는 정도 0..1, x, y, size} */
    const rings = new Map();
    const counter = {
      alpha: 0,
      bump: new Spring(1, { stiffness: 420, damping: 13 }),
      icon: { x: 0, y: 0, r: COUNTER.iconR, film: 0, hue: 0.3, phase: 0, breathF: 1.5, jig: 0, axis: 0 },
    };
    const snd = { lastPop: -1, pops: 0, lastBlub: -1, lastNatural: -1, wind: 0, windSent: -1, windOn: false };
    let clock = 0;
    let lastHint;
    let milestone = null;
    let firstCatch = true;
    let handsSummary = [];
    let nobodyFor = 0;
    const dpr = () => app.dpr || (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    function popSound(r) {
      if (snd.pops >= 2 || clock - snd.lastPop < 0.03) return;
      snd.pops++;
      snd.lastPop = clock;
      app.sound.pop(clamp(55 / Math.max(r, 8), 0.55, 1.9));
    }

    function handle(ev) {
      switch (ev.type) {
        case 'pop': {
          // 손바닥으로 휙 쳐서 터뜨린 것도 콕 찌른 것처럼 크게 (뽁! 글자)
          const kind = ev.counted ? (ev.cause === 'swat' ? 'poke' : ev.cause) : ev.cause === 'fizzle' ? 'fizzle' : 'natural';
          fx.pop(ev.x, ev.y, ev.r, kind, ev.b.hue);
          if (ev.counted) {
            popSound(ev.r);
          } else if (kind === 'natural' && clock - snd.lastNatural > 0.25) {
            snd.lastNatural = clock;
            app.sound.noise({ freq: 3400, q: 3, dur: 0.035, gain: 0.05 });
          }
          break;
        }
        case 'catch':
          fx.caught(ev.x, ev.y, ev.size, ev.n);
          app.sound.tone({ type: 'triangle', freq: 1046, dur: 0.12, gain: 0.12, delay: 0.04 });
          app.sound.tone({ type: 'triangle', freq: 1568, dur: 0.2, gain: 0.1, delay: 0.11 });
          if (firstCatch) {
            firstCatch = false;
            app.ui.toast('꽉 잡았다! 👏');
          }
          break;
        case 'detach':
          if (clock - snd.lastBlub > 0.12) {
            snd.lastBlub = clock;
            const p = clamp(60 / Math.max(ev.b.r, 8), 0.6, 1.6);
            app.sound.tone({ type: 'sine', freq: 380 * p, to: 760 * p, dur: 0.07, gain: 0.045 });
          }
          break;
        default:
          break;
      }
    }

    function updateWind(dt) {
      snd.wind = damp(snd.wind, world.wave, 6, dt);
      if (snd.wind > 0.03) {
        if (Math.abs(snd.wind - snd.windSent) > 0.01) {
          snd.windSent = snd.wind;
          snd.windOn = true;
          app.sound.loop(WIND_LOOP, { type: 'noise', freq: 700 + 1400 * snd.wind, gain: 0.07 * snd.wind, q: 0.7 });
        }
      } else if (snd.windOn) {
        snd.windOn = false;
        snd.windSent = -1;
        app.sound.stopLoop(WIND_LOOP);
      }
    }

    function drawCounter(ctx) {
      if (counter.alpha < 0.01) return;
      const { x, y, h, iconR } = COUNTER;
      const text = String(world.stats.popped);
      ctx.save();
      ctx.font = `32px ${FONT}`;
      const tw = ctx.measureText(text).width;
      const w = 14 + iconR * 2 + 10 + tw + 22;
      const s = counter.bump.value;
      ctx.globalAlpha = counter.alpha;
      ctx.translate(x + h / 2, y + h / 2);
      ctx.scale(s, s);
      ctx.translate(-(x + h / 2), -(y + h / 2));
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      roundRectPath(ctx, x, y + 6, w, h, h / 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,253,247,0.94)';
      roundRectPath(ctx, x, y, w, h, h / 2);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#4fc3f7';
      ctx.stroke();
      // 작은 비눗방울 아이콘 (하늘색 바탕 위에)
      const cx = x + 14 + iconR;
      const cy = y + h / 2;
      const g = ctx.createRadialGradient(cx - iconR * 0.3, cy - iconR * 0.3, 1, cx, cy, iconR);
      g.addColorStop(0, 'rgba(179,229,252,0.5)');
      g.addColorStop(1, 'rgba(79,195,247,0.75)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, iconR, 0, TAU);
      ctx.fill();
      const ic = counter.icon;
      ic.x = cx;
      ic.y = cy;
      ic.film = clock * 0.8;
      art.drawBubble(ctx, ic, clock, dpr(), 1);
      ctx.fillStyle = '#2a2350';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cx + iconR + 10, cy + 2);
      ctx.restore();
    }

    return {
      enter() {
        art.warm(dpr());
        // 처음부터 화면이 비어 있지 않게 몇 개 띄워 둔다
        for (let i = 0; i < 5; i++) world.spawnAmbient(0, [], true);
      },

      update(frame) {
        const dt = frame.dt;
        clock += dt;
        if (frame.width !== world.width || frame.height !== world.height) world.resize(frame.width, frame.height);
        fx.width = frame.width;
        const before = world.stats.popped;
        const events = world.update({ hands: frame.hands, dt, t: clock, now: frame.t });
        snd.pops = 0;
        for (const ev of events) handle(ev);
        fx.update(dt);

        // 개수 판: 늘어날 때 통 튄다
        const popped = world.stats.popped;
        if (popped > before) counter.bump.velocity += 5;
        counter.bump.step(dt, 1);
        counter.alpha = damp(counter.alpha, popped > 0 ? 1 : 0, 8, dt);
        const m = crossedMilestone(before, popped);
        if (m) {
          milestone = m;
          app.ui.toast(milestoneText(m), 1900);
          app.sound.sparkle();
          fx.sparkle(COUNTER.x + 40, COUNTER.y + COUNTER.h / 2, 18, 34);
          fx.sparkle(frame.width / 2, frame.height * 0.42, 22, 60);
        }

        // 펼친 손바닥의 막대 고리 (잠깐 놓친 손은 그대로, 사라진 손은 그 자리에서 스르르)
        let live = 0;
        for (const h of frame.hands) if (!h.stale) live++;
        stepWandRings(rings, frame.hands, dt);
        handsSummary = frame.hands.map((h) => ({ id: h.id, pose: h.pose, stale: h.stale, x: Math.round(h.palm.x), y: Math.round(h.palm.y) }));

        updateWind(dt);

        // 한참 아무도 없으면 다음 친구를 위해 처음부터
        nobodyFor = live ? 0 : nobodyFor + dt;
        if (nobodyFor > FRESH_START_AFTER && (world.stats.popped > 0 || world.stats.emitted > 0)) {
          world.resetStats();
          coach = new HintCoach();
          milestone = null;
          firstCatch = true;
        }

        const s = world.stats;
        const hint = coach.update(dt, { live, emitted: s.emitted, popped: s.popped, caught: s.caught, bubbles: world.count, waved: s.waveTime > 1.2 });
        if (hint !== lastHint) {
          lastHint = hint;
          app.ui.hint(hint);
        }
      },

      draw(ctx, frame) {
        const d = dpr();
        for (const r of rings.values()) if (r.v > 0.01) art.drawWand(ctx, r.x, r.y, r.size * 0.36, clock, d, r.v);
        for (const b of world.bubbles) if (b.attached === null) art.drawBubble(ctx, b, clock, d);
        for (const b of world.bubbles) if (b.attached !== null) art.drawBubble(ctx, b, clock, d);
        // 카메라 화면만 모드: 터지는 물방울·별은 그대로, 글자와 점수판은 그리지 않는다
        fx.showWords = !app.clean;
        fx.draw(ctx);
        if (!app.clean) drawCounter(ctx);
      },

      resize(width, height) {
        world.resize(width, height);
      },

      exit() {
        app.sound.stopLoop(WIND_LOOP);
        snd.windOn = false;
        art.dispose();
        rings.clear();
      },

      state() {
        const s = world.stats;
        let free = 0;
        let growing = 0;
        let inBounds = true;
        let maxR = 0;
        const targets = [];
        for (const b of world.bubbles) {
          if (b.dead) continue;
          if (b.attached !== null) {
            growing++;
            continue;
          }
          free++;
          maxR = Math.max(maxR, b.r);
          if (b.x < b.r - 1 || b.x > world.width - b.r + 1) inBounds = false;
          if (clock >= b.immuneUntil && b.y > 0 && b.y < world.height) {
            targets.push({ x: Math.round(b.x), y: Math.round(b.y), r: Math.round(b.r), vx: Math.round(b.vx), vy: Math.round(b.vy), o: b.owner || 0 });
          }
        }
        return {
          t: +clock.toFixed(2),
          width: world.width,
          height: world.height,
          bubbles: free + growing,
          free,
          growing,
          maxR: Math.round(maxR),
          inBounds,
          emitted: s.emitted,
          trail: s.trail,
          popped: s.popped,
          poked: s.poked,
          swatted: s.swatted,
          caught: s.caught,
          released: s.released,
          natural: s.natural,
          ambient: s.ambient,
          waveTime: +s.waveTime.toFixed(2),
          wands: [...world.wands.values()].map((w) => ({ id: w.id, growing: !!w.growing, made: w.made, speed: Math.round(Math.hypot(w.v.x, w.v.y)) })),
          rings: [...rings.values()].map((r) => +r.v.toFixed(2)),
          hands: handsSummary,
          effects: fx.count,
          hint: coach.current,
          milestone,
          windOn: snd.windOn,
          targets: targets.slice(0, 30),
        };
      },
    };
  },
};
