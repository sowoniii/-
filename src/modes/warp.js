// 말랑 화면: 주먹을 꽉 쥐면 화면이 잡히고, 당기면 고무판처럼 늘어나고, 돌리면 소용돌이친다.
// 손을 펴면 젤리처럼 띠용~ 출렁이며 제자리로 돌아간다. 두 손(여러 아이)이 함께 잡으면 힘이 더해진다.
// 엄지-검지로 꼬집으면 작은 부분만 쏙 잡힌다.
//
// 구조: 잡기 상태 기계(Grabber) → 잡기마다 변형 모양(grabField) → 격자 목표 변위(computeTargets)
//       → 젤리 물리(Jelly, stage.grid.offset 에 직접 씀) → 2D 위에 손잡이·고무줄·글자 효과.
// 잡은 점과 손 사이의 화면은 주먹 속으로 접혀 들어가고(손 조각 아래에 숨는다), 손 앞쪽은 그대로라서
// 영상 속 아이 손이 일그러지거나 두 개로 보이지 않는다. 순수 로직은 ./warp/jelly.js (테스트: tests/warp.test.js)

import { clamp, lerp, rand, pick, TAU } from '../core/math.js';
import { GRAB, Grabber, Jelly, grabField, segmentStrain, boingPitch, buildHandPatch, makePatchBuffer, buildMasks, insidePatch } from './warp/jelly.js';

const FONT = '"Jua", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';
const LAVENDER = [179, 157, 219];
const PURPLE = [126, 87, 194];
const PINK = [255, 110, 170];
const AMBER = [255, 179, 0];
const YELLOW = '#ffd54f';
const LOOP_ID = 'warp-stretch';

const MAX_RINGS = 16;
const MAX_TEXTS = 8;
const MAX_SPARKS = 64;
/** 손이 하나도 안 보인 채 이만큼(초) 지나면 다음 아이를 위해 안내를 처음부터 */
const COACH_RESET = 9;

const HINTS = {
  pull: '꽉 잡았어요! 쭈욱 당겨 보세요 👉',
  twist: '주먹을 빙글 돌려 보세요! 🌀',
  letGo: '손을 활짝 펴면 띠용~ 놓아져요 🖐️',
  two: '양쪽으로 쭈우욱~ 늘려 봐요! ↔️',
  pinchHold: '꼬집어서 쭉~ 당겨 봐요! 🤏',
  tryTwo: '두 손으로 잡아당겨 봐요 ✊✊',
  tryPinch: '엄지랑 검지로 꼬집어 봐요 🤏',
};

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mixColor = (a, b, t) => [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
const easeOutBack = (t) => {
  const c = 1.9;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

/** 화면 가운데 큰 글씨(app.ui.toast)가 뜨는 자리 — 여기에 손이 있으면 손을 가리므로 띄우지 않는다 */
export function inToastBox(x, y, width, height) {
  return Math.abs(x - width / 2) < 0.34 * width && Math.abs(y - 0.42 * height) < 0.14 * height;
}

/**
 * 손 근처 칭찬 글자 자리: 손잡이 고리(반지름 ring) 바로 위. 글자는 떠오르며 사라지므로(40px)
 * 위쪽 안내 말풍선(아래 끝 약 100px)에 닿을 것 같으면 고리 옆으로 — 손(awayX 쪽)을 가리지 않는 쪽,
 * 정하지 않았으면 화면이 더 넓은 쪽. 화면 밖으로 나가지 않게.
 */
export function praiseSpot(x, y, ring, width, height, textSize, awayX = x) {
  const half = Math.min(0.45 * width, 1.6 * textSize);
  let tx = x;
  let ty = y - ring - 0.9 * textSize;
  if (ty - 0.6 * textSize - 40 < 100) {
    let side = awayX > x + 1 ? -1 : awayX < x - 1 ? 1 : x < width / 2 ? 1 : -1;
    tx = x + side * (ring + half + 10);
    if (tx - half < 10 || tx + half > width - 10) {
      side = -side;
      tx = x + side * (ring + half + 10);
    }
    ty = y - 0.2 * textSize;
  }
  return { x: clamp(tx, half, width - half), y: clamp(ty, 60, height - 60) };
}

export default {
  id: 'warp',
  title: '말랑 화면',
  emoji: '✊',
  color: '#b39ddb',
  description: '주먹을 꽉 쥐면 화면이 잡혀요. 쭈욱 당기고 빙글 돌려 봐요!',
  hint: '주먹을 꽉 쥐면 화면이 잡혀요 ✊',
  needs: { face: false, mic: false },
  create(app) {
    const grabber = new Grabber();
    const jelly = new Jelly();
    const fields = [];
    /** 잡지 않은 손 자리 가리개 (손은 젤리 위에 올려진 것처럼 일그러지지 않게) */
    const masks = [];
    const maskPool = [];
    /** 손 id → 손 조각 버퍼 (일그러지지 않은 손을 다시 그리는 데 사용) */
    const patchBufs = new Map();
    /** 손을 놓친 잡기 → 마지막 모습의 손 조각 버퍼 */
    const orphanBufs = new Map();
    const fx = { rings: [], texts: [], sparks: [] };
    // 아이가 해 본 것 (안내 문구를 다음 단계로 넘기는 데 사용)
    const coach = { pulled: false, twisted: false, released: false, two: false, pinched: false };
    const toastAt = new Map();
    const praiseAt = new Map();
    let lastToast = -Infinity;
    let lastPraise = -Infinity;
    let now = 0;
    let peak = 0;
    let loopOn = false;
    let hintText = null;
    let lastSqueak = 0;
    let twoSince = 0;
    let emptyFor = 0;
    let coachResets = 0;
    let toasts = 0;
    /** 이번 프레임에 잡고 있는 것들 (update 에서 갱신) */
    let list = [];
    let hands = [];
    /** 최근 사건 몇 개 (자동 테스트·문제 찾기용) */
    const log = [];
    /** 손 id → 이 시각까지는 '주먹 쥐기' 안내를 쉰다 (방금 놓은 손 위의 띠용~ 효과를 가리지 않게) */
    const hoverQuiet = new Map();
    /** 늘어남 표시선을 그리지 않을 곳 (손 위) — 매 프레임 재사용 */
    const keepOut = [];

    const minDim = () => Math.min(app.width, app.height);
    const isGrabbing = (id) => grabber.byHand.has(id);

    function resetCoach() {
      for (const k of Object.keys(coach)) coach[k] = false;
      toastAt.clear();
      praiseAt.clear();
      lastToast = -Infinity;
      lastPraise = -Infinity;
      coachResets++;
    }

    /** 가끔 화면 가운데 큰 칭찬 — 손이 그 자리에 있으면 손을 가리므로 띄우지 않는다. 보여 줬으면 true */
    function toast(key, text, again = 45) {
      if (now - lastToast < 4) return false;
      const last = toastAt.get(key);
      if (last !== undefined && now - last < again) return false;
      for (const g of list) if (inToastBox(g.pos.x, g.pos.y, app.width, app.height)) return false;
      for (const h of hands) if (inToastBox(h.palm.x, h.palm.y, app.width, app.height)) return false;
      toastAt.set(key, now);
      lastToast = now;
      toasts++;
      app.ui.toast(text);
      return true;
    }

    /** 손 바로 옆 큰 칭찬 글자 (같은 칭찬은 again 초에 한 번, 아무 칭찬이나 2.5초에 한 번). 보여 줬으면 true */
    function praise(key, x, y, size, ring, text, color, again = 20, awayX = x) {
      if (now - lastPraise < 2.5) return false;
      const last = praiseAt.get(key);
      if (last !== undefined && now - last < again) return false;
      praiseAt.set(key, now);
      lastPraise = now;
      const ts = clamp(size * 0.5, 34, 78);
      const p = praiseSpot(x, y, ring, app.width, app.height, ts, awayX);
      // 같은 자리에 떠 있는 작은 글자('꽉!', '꼬집!')는 치워서 겹치지 않게
      for (let i = fx.texts.length - 1; i >= 0; i--) {
        const tx = fx.texts[i];
        if (Math.abs(tx.x - p.x) < 2.2 * ts && Math.abs(tx.y - p.y) < 1.6 * ts) fx.texts.splice(i, 1);
      }
      addText(p.x, p.y, text, ts, color);
      return true;
    }

    function addRing(x, y, r0, r1, color, life = 0.5, width = 6) {
      if (fx.rings.length >= MAX_RINGS) fx.rings.shift();
      fx.rings.push({ x, y, r0, r1, color, life, width, t: now });
    }

    function addText(x, y, text, size, color) {
      if (fx.texts.length >= MAX_TEXTS) fx.texts.shift();
      fx.texts.push({ x, y, text, size: clamp(size, 30, 84), color, t: now, life: 0.95 });
    }

    function addSparks(x, y, n, speed, size) {
      for (let i = 0; i < n; i++) {
        if (fx.sparks.length >= MAX_SPARKS) fx.sparks.shift();
        const a = rand(0, TAU);
        const v = speed * rand(0.5, 1.1);
        fx.sparks.push({
          x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.2,
          r: size * rand(0.05, 0.1), color: pick([LAVENDER, PINK, [255, 213, 79], [255, 255, 255]]), t: now, life: rand(0.45, 0.8),
        });
      }
    }

    /** 잡기 하나의 '팽팽함' 0..1 (얼마나 멀리 당겼고 얼마나 비틀었나) */
    function tensionOf(g) {
      const F = g.field;
      if (!F) return 0;
      const drag = Math.hypot(F.dx, F.dy);
      return clamp(drag / (1.4 * g.sigma) + (Math.abs(F.theta) / 1.1) * 0.4 + Math.abs(F.bulge) * 0.5);
    }

    function onGrab(g) {
      g.vis = { born: now, pulled: false, twisted: false, lastTravel: 0, twistStep: 0, twistHeld: 0, twistCoach: 0, speed: 0, lastPos: { ...g.pos } };
      const s = g.size;
      if (g.kind === 'pinch') {
        coach.pinched = true;
        app.sound.squeak(1.5);
        app.sound.tone({ type: 'sine', freq: 900, to: 1500, dur: 0.06, gain: 0.12 });
        addRing(g.p0.x, g.p0.y, s * 0.15, s * 0.9, PINK, 0.4, 4);
        addText(g.p0.x, g.p0.y - s * 0.55, '꼬집!', s * 0.38, PINK);
      } else {
        app.sound.squeak(0.8 + rand(0, 0.15));
        app.sound.tone({ type: 'sine', freq: 300, to: 620, dur: 0.09, gain: 0.22 });
        addRing(g.p0.x, g.p0.y, s * 0.4, s * 1.9, LAVENDER, 0.55, 8);
        addRing(g.p0.x, g.p0.y, s * 0.2, s * 1.2, [255, 255, 255], 0.4, 4);
        addText(g.p0.x, g.p0.y - s * 0.9, '꽉!', s * 0.5, PURPLE);
      }
    }

    /** 꼬집던 손이 주먹을 쥐었다: 놓지 않고 그대로 큰 잡기가 된다 (늘어난 모양 유지) */
    function onConvert(g) {
      const s = g.size;
      g.vis.born = now; // 손잡이 고리가 한 번 통 튀게
      app.sound.squeak(0.9);
      app.sound.tone({ type: 'sine', freq: 420, to: 760, dur: 0.08, gain: 0.16 });
      addRing(g.pos.x, g.pos.y, s * 0.3, s * 1.4, LAVENDER, 0.45, 6);
      addText(g.pos.x, g.pos.y - s * 0.9, '꽉!', s * 0.45, PURPLE);
    }

    function onRelease(g) {
      coach.released = true;
      hoverQuiet.set(g.handId, now + 1.1);
      if (hoverQuiet.size > 12) for (const [id, until] of hoverQuiet) if (until < now) hoverQuiet.delete(id);
      const F = g.field || grabField(g);
      const drag = Math.hypot(F.dx, F.dy);
      const amount = drag / g.sigma + Math.abs(F.theta) * 0.6 + Math.abs(F.bulge);
      const s = g.size;
      if (amount > 0.25) {
        app.sound.boing(boingPitch(drag + Math.abs(F.theta) * g.sigma * 0.6, g.sigma));
        addText(g.pos.x, g.pos.y - s * 0.8, '띠용~', s * 0.45, PINK);
        addRing(g.pos.x, g.pos.y, s * 0.3, s * 1.6, PINK, 0.5, 7);
        addSparks(g.pos.x, g.pos.y, 10, s * 4, s);
      } else {
        app.sound.pip(0.8);
        addRing(g.pos.x, g.pos.y, s * 0.3, s * 1.0, LAVENDER, 0.35, 4);
      }
    }

    /** 잡고 있는 동안: 뽀득 소리, 비틀기 딸깍, 한 번씩 손 옆 칭찬 글자 */
    function whileHeld(g, dt) {
      const v = g.vis;
      const F = g.field;
      const s = g.size;
      const drag = Math.hypot(F.dx, F.dy);
      const tension = tensionOf(g);
      // 손 속도 (부드럽게)
      const sp = Math.hypot(g.pos.x - v.lastPos.x, g.pos.y - v.lastPos.y) / Math.max(dt, 1e-3);
      v.speed += (sp - v.speed) * 0.25;
      v.lastPos.x = g.pos.x;
      v.lastPos.y = g.pos.y;

      if (g.travel - v.lastTravel > 0.8 * s && now - lastSqueak > 0.11 && drag > 0.3 * s) {
        v.lastTravel = g.travel;
        lastSqueak = now;
        app.sound.squeak(0.55 + tension * 0.8 + rand(-0.05, 0.05));
      }
      // 비틀기는 아이가 실제로 돌린 손목 각도로 (화면 소용돌이는 멀리 당겼을 때 줄어든다)
      const tw = Math.abs(g.twist);
      const step = Math.floor(tw / 0.4);
      if (step !== v.twistStep) {
        if (step > v.twistStep) app.sound.tone({ type: 'triangle', freq: 480 + 110 * step, dur: 0.05, gain: 0.1 });
        v.twistStep = step;
      }
      // 팔을 휘두르다 손이 잠깐 기운 것은 '비틀기'로 치지 않는다: 충분히 돌린 채 잠깐 버텨야 한다
      v.twistCoach = tw > 0.75 ? v.twistCoach + dt : 0;
      v.twistHeld = tw > 0.9 ? v.twistHeld + dt : 0;
      if (drag > Math.max(1.2 * s, 0.12 * minDim())) coach.pulled = true;
      if (v.twistCoach > 0.35) coach.twisted = true;
      if (!v.pulled && drag > 1.05 * g.sigma) {
        v.pulled = true;
        // 꼬집기는 잡는 점이 손가락 끝이라 손바닥 쪽을 피해서
        const palmX = g.lm[0].x * 0.5 + g.lm[9].x * 0.5;
        const big = g.kind === 'pinch' ? praise('pinch', g.pos.x, g.pos.y, s, 0.38 * s, '꼬집기 성공! 🤏', PINK, 60, palmX) : praise('stretch', g.pos.x, g.pos.y, s, 0.72 * s, '쭈우우욱~ 😆', PURPLE);
        if (!big) addText(g.pos.x, g.pos.y - s * 0.95, g.kind === 'pinch' ? '쭉~' : '쭈욱~', s * 0.42, PURPLE);
      }
      if (!v.twisted && v.twistHeld > 0.3) {
        v.twisted = true;
        if (!praise('twist', g.pos.x, g.pos.y, s, 0.72 * s + Math.max(10, s * 0.22), '빙글빙글~ 🌀', AMBER)) addText(g.pos.x + s * 0.8, g.pos.y - s * 0.6, '빙글~', s * 0.4, AMBER);
      }
    }

    function chooseHint(list) {
      if (list.length >= 2) return HINTS.two;
      if (list.length === 1) {
        if (list[0].kind === 'pinch') return HINTS.pinchHold;
        if (!coach.pulled) return HINTS.pull;
        if (!coach.twisted) return HINTS.twist;
        return HINTS.letGo;
      }
      if (!coach.released) return null; // 기본 문구: 주먹을 꽉 쥐면 화면이 잡혀요
      if (!coach.two) return HINTS.tryTwo;
      if (!coach.pinched) return HINTS.tryPinch;
      return null;
    }

    function updateSound(list) {
      if (!list.length) {
        if (loopOn) {
          app.sound.stopLoop(LOOP_ID);
          loopOn = false;
        }
        return;
      }
      let tension = 0;
      let motion = 0;
      for (const g of list) {
        tension = Math.max(tension, tensionOf(g));
        motion = Math.max(motion, clamp(g.vis.speed / (4 * Math.max(g.size, 40))));
      }
      // 늘어날수록 높아지는 고무 소리. 손이 멈춰 있으면 거의 안 들린다.
      const gain = tension < 0.06 ? 0 : 0.055 * tension * (0.25 + 0.75 * motion);
      app.sound.loop(LOOP_ID, { type: 'triangle', freq: 150 + 520 * tension, gain });
      loopOn = true;
    }

    // ---------------------------------------------------------------- 그리기

    /** 늘어나거나 눌린 격자선을 살짝 보여 준다 (진짜 카메라 영상에서도 '고무판' 느낌이 나게). 손 위는 비운다. */
    function drawStrain(ctx) {
      const g = app.stage.grid;
      if (jelly.grid !== g || jelly.maxOffset < 3) return;
      const { cols, rows, rest, offset: off } = g;
      const W = app.width;
      const H = app.height;
      const pad = 40;
      const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      const used = [false, false, false, false, false, false];
      const nk = keepOut.length;
      const seg = (a, b) => {
        const ax = rest[a * 2] + off[a * 2];
        const ay = rest[a * 2 + 1] + off[a * 2 + 1];
        const bx = rest[b * 2] + off[b * 2];
        const by = rest[b * 2 + 1] + off[b * 2 + 1];
        if ((ax < -pad && bx < -pad) || (ax > W + pad && bx > W + pad) || (ay < -pad && by < -pad) || (ay > H + pad && by > H + pad)) return;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        for (let q = 0; q < nk; q++) {
          const K = keepOut[q];
          const dx = mx - K.x;
          const dy = my - K.y;
          if (dx * dx + dy * dy < K.r2) return;
        }
        const st = segmentStrain(g, a, b);
        const m = Math.abs(st);
        if (m < 0.12) return;
        const lvl = Math.min(2, Math.floor((m - 0.12) / 0.2));
        const idx = (st > 0 ? 0 : 3) + lvl;
        paths[idx].moveTo(ax, ay);
        paths[idx].lineTo(bx, by);
        used[idx] = true;
      };
      const stride = cols + 1;
      for (let j = 1; j <= rows; j += 3) for (let i = 0; i < cols; i++) seg(j * stride + i, j * stride + i + 1);
      for (let i = 1; i <= cols; i += 3) for (let j = 0; j < rows; j++) seg(j * stride + i, (j + 1) * stride + i);
      ctx.lineCap = 'round';
      // 많이 늘어날수록 진하게: 늘어남 = 분홍, 눌림 = 하늘색. 영상을 가리지 않게 은은하게.
      const alphas = [0.16, 0.26, 0.4];
      for (let k = 0; k < 6; k++) {
        if (!used[k]) continue;
        const lvl = k % 3;
        ctx.strokeStyle = k < 3 ? `rgba(255,150,200,${alphas[lvl]})` : `rgba(150,220,255,${alphas[lvl]})`;
        ctx.lineWidth = 1.5 + lvl * 0.75;
        ctx.stroke(paths[k]);
      }
    }

    /** 잡은 곳(원래 자리) → 손까지 이어지는 고무줄 */
    function drawBand(ctx, g) {
      const F = g.field;
      const s = g.size;
      const drag = Math.hypot(F.dx, F.dy);
      if (drag < 0.45 * s) return;
      const t = tensionOf(g);
      const col = mixColor(LAVENDER, PINK, t);
      const ux = F.dx / drag;
      const uy = F.dy / drag;
      const R = (g.kind === 'pinch' ? 0.38 : 0.72) * s;
      const ex = g.pos.x - ux * R;
      const ey = g.pos.y - uy * R;
      const w = Math.max(3, s * 0.13 * (1 - 0.6 * t));
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = w + 4;
      ctx.beginPath();
      ctx.moveTo(g.p0.x, g.p0.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.strokeStyle = rgba(col, 0.95);
      ctx.lineWidth = w;
      ctx.stroke();
      // 원래 자리 표시 (작은 핀)
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(g.p0.x, g.p0.y, Math.max(5, s * 0.09), 0, TAU);
      ctx.fill();
      ctx.fillStyle = rgba(col, 1);
      ctx.beginPath();
      ctx.arc(g.p0.x, g.p0.y, Math.max(3, s * 0.055), 0, TAU);
      ctx.fill();
    }

    /** 주먹 둘레의 손잡이 고리 (손과 함께 돌아가는 톱니 + 비튼 만큼 노란 화살표) */
    function drawGrip(ctx, g, fade) {
      const s = g.size;
      const age = now - g.vis.born;
      const pop = age < 0.35 ? 1 + 0.35 * Math.exp(-age * 9) * Math.cos(age * 22) : 1;
      const t = tensionOf(g);
      const col = mixColor(LAVENDER, PINK, t);
      const R = (g.kind === 'pinch' ? 0.38 : 0.72) * s * pop;
      const x = g.pos.x;
      const y = g.pos.y;
      ctx.globalAlpha = fade;
      // 은은한 빛 (고리 바깥쪽만 — 아이 주먹은 물들이지 않는다)
      const glow = ctx.createRadialGradient(x, y, R, x, y, R * 1.6);
      glow.addColorStop(0, rgba(col, 0.32));
      glow.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, R * 1.6, 0, TAU);
      ctx.arc(x, y, R, 0, TAU, true);
      ctx.fill();
      // 고리
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = Math.max(5, s * 0.12);
      ctx.beginPath();
      ctx.arc(x, y, R, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = rgba(col, 1);
      ctx.lineWidth = Math.max(3, s * 0.07);
      ctx.stroke();
      // 톱니 (손을 돌리면 같이 돈다)
      const teeth = g.kind === 'pinch' ? 4 : 6;
      ctx.fillStyle = '#fff';
      for (let i = 0; i < teeth; i++) {
        const a = g.angle + (i * TAU) / teeth;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * R, y + Math.sin(a) * R, Math.max(3.5, s * 0.055), 0, TAU);
        ctx.fill();
      }
      // 비튼 만큼 노란 화살표
      if (Math.abs(g.twist) > 0.25 && g.kind !== 'pinch') {
        const rr = R + Math.max(10, s * 0.22);
        const a1 = g.angle - Math.PI / 2;
        const a0 = a1 - g.twist;
        const ccw = g.twist < 0;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(7, s * 0.11);
        ctx.beginPath();
        ctx.arc(x, y, rr, a0, a1, ccw);
        ctx.stroke();
        ctx.strokeStyle = YELLOW;
        ctx.lineWidth = Math.max(4, s * 0.065);
        ctx.stroke();
        // 화살촉
        const dir = ccw ? -1 : 1;
        const hx = x + Math.cos(a1) * rr;
        const hy = y + Math.sin(a1) * rr;
        const tx = -Math.sin(a1) * dir;
        const ty = Math.cos(a1) * dir;
        const nx = Math.cos(a1);
        const ny = Math.sin(a1);
        const L = Math.max(12, s * 0.2);
        ctx.fillStyle = YELLOW;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(hx + tx * L, hy + ty * L);
        ctx.lineTo(hx + nx * L * 0.6, hy + ny * L * 0.6);
        ctx.lineTo(hx - nx * L * 0.6, hy - ny * L * 0.6);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /** 아직 안 잡은 손: '여기서 주먹!' 하고 오므라드는 점선 고리 */
    function drawHover(ctx, h) {
      const quiet = hoverQuiet.get(h.id);
      const fade = quiet === undefined ? 1 : clamp((now - quiet) / 0.4);
      if (fade <= 0) return;
      ctx.globalAlpha = fade;
      const s = h.size;
      const open = clamp(h.openness);
      const R = s * (0.55 + 0.55 * open);
      ctx.save();
      ctx.setLineDash([s * 0.12, s * 0.1]);
      ctx.lineDashOffset = -now * s * 0.4;
      ctx.lineWidth = Math.max(3, s * 0.045);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.arc(h.palm.x, h.palm.y, R, 0, TAU);
      ctx.stroke();
      ctx.restore();
      // 주먹 그림 배지 (통통 튄다): '이렇게 쥐어 봐요'
      const bob = Math.sin(now * 5 + h.id) * s * 0.05;
      const fs = clamp(s * 0.34, 24, 56);
      const bx = h.palm.x + R * 0.78;
      const by = h.palm.y - R * 0.78 + bob;
      const br = fs * 0.78;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = rgba(LAVENDER, 1);
      ctx.lineWidth = Math.max(3, fs * 0.1);
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.font = `${fs}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#000';
      ctx.fillText('✊', bx, by + fs * 0.04);
      ctx.globalAlpha = 1;
    }

    function drawFx(ctx, dt) {
      for (let i = fx.rings.length - 1; i >= 0; i--) {
        const r = fx.rings[i];
        const k = (now - r.t) / r.life;
        // 카메라 화면만 모드: 동그라미 표시는 그리지 않는다 (반짝이 입자만)
        if (k >= 1 || app.clean) {
          fx.rings.splice(i, 1);
          continue;
        }
        const e = 1 - (1 - k) * (1 - k);
        ctx.strokeStyle = rgba(r.color, (1 - k) * 0.9);
        ctx.lineWidth = r.width * (1 - k * 0.6);
        ctx.beginPath();
        ctx.arc(r.x, r.y, lerp(r.r0, r.r1, e), 0, TAU);
        ctx.stroke();
      }
      for (let i = fx.sparks.length - 1; i >= 0; i--) {
        const p = fx.sparks[i];
        const k = (now - p.t) / p.life;
        if (k >= 1) {
          fx.sparks.splice(i, 1);
          continue;
        }
        p.vx *= Math.exp(-3 * dt);
        p.vy = p.vy * Math.exp(-3 * dt) + 600 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.fillStyle = rgba(p.color, 1 - k);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (1 - 0.5 * k), 0, TAU);
        ctx.fill();
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      for (let i = fx.texts.length - 1; i >= 0; i--) {
        const tx = fx.texts[i];
        const age = now - tx.t;
        const k = age / tx.life;
        if (k >= 1 || app.clean) {
          fx.texts.splice(i, 1);
          continue;
        }
        const sc = age < 0.22 ? Math.max(0.01, easeOutBack(age / 0.22)) : 1;
        const a = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
        ctx.save();
        ctx.translate(tx.x, tx.y - 40 * k);
        ctx.scale(sc, sc);
        ctx.globalAlpha = a;
        ctx.font = `${Math.round(tx.size)}px ${FONT}`;
        ctx.lineWidth = Math.max(5, tx.size * 0.16);
        ctx.strokeStyle = rgba(tx.color, 1);
        ctx.strokeText(tx.text, 0, 0);
        ctx.fillStyle = '#fff';
        ctx.fillText(tx.text, 0, 0);
        ctx.restore();
      }
    }

    /** 손 조각 하나 그리기 (일그러지기 전 영상의 손을 제자리에) */
    function drawHandPatch(stage, buf, lm, size, opacity = 1) {
      const n = buildHandPatch(lm, size, buf);
      if (!n) return;
      const pos = buf.pos.subarray(0, n * 2);
      stage.drawPatch({ pos, src: pos, alpha: buf.alpha.subarray(0, n), indices: buf.indices.subarray(0, buf.ni), opacity });
    }

    /**
     * 손 밖에서 뒤집혀(접혀) 보이는 격자 넓이 px² (자동 테스트용, 부를 때만 계산).
     * 손 조각 아래는 손이 덮으므로 세지 않는다.
     */
    function visibleFolds() {
      const g = app.stage.grid;
      const bufs = [];
      for (const h of hands) {
        const b = makePatchBuffer();
        if (buildHandPatch(h.lm, h.size, b)) bufs.push(b);
      }
      for (const gr of list) {
        if (gr.orphan <= 0) continue;
        const b = makePatchBuffer();
        if (buildHandPatch(gr.lm, gr.size, b)) bufs.push(b);
      }
      const { rest, offset: o, cols, rows } = g;
      const st = cols + 1;
      const W = app.width;
      const H = app.height;
      let area = 0;
      const tri = (a, b, c) => {
        const ax = rest[a * 2] + o[a * 2];
        const ay = rest[a * 2 + 1] + o[a * 2 + 1];
        const bx = rest[b * 2] + o[b * 2];
        const by = rest[b * 2 + 1] + o[b * 2 + 1];
        const cx = rest[c * 2] + o[c * 2];
        const cy = rest[c * 2 + 1] + o[c * 2 + 1];
        const s = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
        if (s >= 0) return;
        const mx = (ax + bx + cx) / 3;
        const my = (ay + by + cy) / 3;
        if (mx < 0 || my < 0 || mx > W || my > H) return;
        for (const b2 of bufs) if (insidePatch(b2, mx, my, 0)) return;
        area -= s;
      };
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const a = j * st + i;
          tri(a, a + 1, a + st);
          tri(a + 1, a + st + 1, a + st);
        }
      }
      return Math.round(area);
    }

    /** 화면 테두리 줄이 안쪽으로 끌려 들어온 최대 거리 px (0 이어야 화면 밖 줄무늬가 안 보인다) */
    function borderInward() {
      const g = app.stage.grid;
      const B = jelly.border;
      if (!B || jelly.grid !== g) return 0;
      let m = 0;
      for (const k of B.list) {
        const ox = g.offset[k * 2];
        const oy = g.offset[k * 2 + 1];
        if (B.fxp[k] === 0) m = Math.max(m, ox);
        if (B.fxn[k] === 0) m = Math.max(m, -ox);
        if (B.fyp[k] === 0) m = Math.max(m, oy);
        if (B.fyn[k] === 0) m = Math.max(m, -oy);
      }
      return m;
    }

    // ---------------------------------------------------------------- 모드

    return {
      enter() {
        app.ui.hint(null);
        jelly.bind(app.stage.grid);
      },

      update(frame) {
        now = frame.t;
        const dt = frame.dt;
        hands = frame.hands;
        // 아무도 없이 한참 지나면 다음 아이를 위해 안내를 처음부터
        emptyFor = hands.length ? 0 : emptyFor + dt;
        if (emptyFor > COACH_RESET && (coach.pulled || coach.twisted || coach.released || coach.two || coach.pinched)) resetCoach();
        const events = grabber.update(hands, dt, frame.width, frame.height);
        for (const ev of events) {
          log.push(`${now.toFixed(2)} ${ev.type}${ev.reason ? ':' + ev.reason : ''} #${ev.grab.serial} h${ev.grab.handId}`);
          if (log.length > 8) log.shift();
          if (ev.type === 'grab') onGrab(ev.grab);
          else if (ev.type === 'convert') onConvert(ev.grab);
          else if (ev.type === 'release') onRelease(ev.grab);
        }
        list = grabber.list;
        const grid = app.stage.grid;
        const cell = Math.max(grid.cellW, grid.cellH);
        const capD = 0.6 * minDim();
        fields.length = 0;
        for (const g of list) {
          g.field = grabField(g, g.field, capD, cell);
          fields.push(g.field);
        }
        for (const g of list) whileHeld(g, dt);
        // 두 손 이상이 함께 잡고 늘이면 칭찬
        let stretched = 0;
        for (const g of list) if (Math.hypot(g.field.dx, g.field.dy) > 0.6 * g.size) stretched++;
        twoSince = list.length >= 2 ? twoSince + dt : 0;
        if (list.length >= 2 && (stretched >= 2 || twoSince > 1.2)) {
          coach.two = true;
          if (stretched >= 2 && !toast('two', '두 손으로 쭈욱! 🙌')) {
            // 손이 가운데 있으면 큰 글씨 대신 두 손 사이 위쪽에
            const a = list[0].pos;
            const b = list[1].pos;
            praise('two', (a.x + b.x) / 2, Math.min(a.y, b.y), list[0].size, 0.72 * list[0].size, '두 손으로 쭈욱! 🙌', PINK, 45);
          }
        }
        updateSound(list);
        hintText = chooseHint(list);
        app.ui.hint(hintText);
      },

      drawGL(stage, frame) {
        jelly.bind(stage.grid);
        buildMasks(frame.hands, isGrabbing, masks, maskPool);
        jelly.setFields(fields, minDim(), masks);
        const m = jelly.step(frame.dt);
        if (m > peak) peak = m;
        // 화면은 일그러져도 손은 제 자리에 또렷하게: 일그러지기 전 영상의 손을 그 위에 다시 그린다
        if (m > 1) {
          for (const h of frame.hands) {
            let buf = patchBufs.get(h.id);
            if (!buf) patchBufs.set(h.id, (buf = makePatchBuffer()));
            drawHandPatch(stage, buf, h.lm, h.size);
          }
          // 손을 잠깐 놓친 잡기: 마지막으로 본 모습 그대로, 놓기 전까지 서서히 흐려진다
          for (const g of list) {
            if (g.orphan <= 0) continue;
            let buf = orphanBufs.get(g.serial);
            if (!buf) orphanBufs.set(g.serial, (buf = makePatchBuffer()));
            drawHandPatch(stage, buf, g.lm, g.size, clamp(1 - g.orphan / GRAB.orphanGrace));
          }
        }
        if (patchBufs.size > frame.hands.length) {
          for (const id of patchBufs.keys()) if (!frame.hands.some((h) => h.id === id)) patchBufs.delete(id);
        }
        if (orphanBufs.size) {
          for (const serial of orphanBufs.keys()) if (!list.some((g) => g.serial === serial && g.orphan > 0)) orphanBufs.delete(serial);
        }
      },

      draw(ctx, frame) {
        // 늘어남 표시선은 손 위에 그리지 않는다
        keepOut.length = 0;
        for (const g of list) keepOut.push({ x: g.pos.x, y: g.pos.y, r2: (1.05 * g.size) ** 2 });
        for (const h of frame.hands) if (!isGrabbing(h.id)) keepOut.push({ x: h.palm.x, y: h.palm.y, r2: (1.1 * h.size) ** 2 });
        // 카메라 화면만 모드: 일그러지는 영상과 터지는 효과만 남기고, 표시선·잡기 고리·주먹 안내·글자는 그리지 않는다
        if (!app.clean) {
          drawStrain(ctx);
          for (const g of list) drawBand(ctx, g);
          for (const h of frame.hands) {
            if (!isGrabbing(h.id) && !h.stale && h.age > 0.15) drawHover(ctx, h);
          }
          for (const g of list) {
            let fade = g.orphan > 0 ? 0.45 * clamp(1 - g.orphan / GRAB.orphanGrace) + 0.15 : 1;
            for (const h of frame.hands) if (h.id === g.handId && h.stale) fade = 0.45;
            drawGrip(ctx, g, fade);
          }
        }
        drawFx(ctx, frame.dt);
      },

      resize() {
        // 엔진이 격자를 새로 만들었다 → 속도 버퍼도 새 격자에 맞춘다 (잡은 위치는 화면 px 라 그대로)
        jelly.bind(app.stage.grid);
      },

      exit() {
        app.sound.stopLoop(LOOP_ID);
        loopOn = false;
        grabber.clear();
        list = [];
        hands = [];
        fx.rings.length = 0;
        fx.texts.length = 0;
        fx.sparks.length = 0;
        patchBufs.clear();
        orphanBufs.clear();
      },

      state() {
        let twist = 0;
        let wrist = 0;
        for (const g of list) {
          twist = Math.max(twist, Math.abs(g.field?.th ?? g.field?.theta ?? 0)); // 화면에 보이는 소용돌이
          wrist = Math.max(wrist, Math.abs(g.twist));
        }
        return {
          grabs: list.length,
          kinds: list.map((g) => g.kind),
          maxOffset: Math.round(jelly.maxOffset),
          deformed: jelly.maxOffset > 0.5,
          peak: Math.round(peak),
          twist: Math.round(twist * 100) / 100,
          wrist: Math.round(wrist * 100) / 100,
          created: grabber.created,
          released: grabber.released,
          adopted: grabber.adopted,
          converted: grabber.converted,
          orphans: list.filter((g) => g.orphan > 0).length,
          sleeping: jelly.sleeping,
          folds: visibleFolds(),
          borderIn: Math.round(borderInward() * 10) / 10,
          pins: masks.filter((M) => M.kmin < 1).length,
          toasts,
          hint: hintText,
          log: log.slice(),
          coach: { ...coach },
          coachResets,
        };
      },
    };
  },
};
