// 입김 그림: 화면에 후~ 입김을 불면 겨울 창문처럼 김이 서리고, 손가락으로 그림을 그리거나 손바닥으로 닦는다.
//
// 그리는 순서 (매 프레임 — 김이 없는 곳은 아무것도 안 그려서 선명한 카메라 영상이 보인다):
//   1) 아주 작게 줄인 카메라 영상을 다시 크게 늘려 그린다 → 뿌옇게 흐린 창 너머 풍경
//   2) 안개색 바탕 + 물방울 결(미리 한 장으로 만들어 둔 것)을 얹는다
//   3) 김 농도 격자(FogField)를 작은 캔버스의 알파로 옮겨 'destination-in' 으로 오려 내고, 닦인 곳은 젖은 유리색
//   4) 김 앞에 있는 손은 살짝 비쳐 보이게 하고, 흘러내리는 물방울·입김 알갱이·손가락 커서를 그린다
//   큰 화면 + 높은 픽셀 비율에서는 1~3 을 작은 캔버스(최대 300만 화소)에서 합친 뒤 한 번만 늘려 그린다.
//
// 실제 카메라에서 인식이 흔들려도 괜찮도록: 손마다(hand.id) 그리기 상태를 따로 두고, 잠깐 놓치면(stale) 선을
// 이어 그리지 않으며, 입김 판단에는 히스테리시스와 유지 시간을 둔다 (자세한 로직은 ./frost/logic.js).
//
// 소리는 모두 짧은 '음'(사인/삼각파)이다. 걸러낸 잡음 소리는 마이크에 입김과 똑같이 들려서(넓은 대역·평탄한
// 스펙트럼) 스피커 소리가 마이크로 다시 들어가면 아이가 멈춘 뒤에도 김이 계속 퍼진다. 음은 입김 판정에 걸리지
// 않는다. 다만 길게 이어지는 음은 진짜 입김 소리를 가릴 수 있어서, 부는 동안에는 이어지는 소리(loop) 없이
// 0.05초짜리 반짝 소리만 띄엄띄엄 낸다.

import {
  BlowSensor, TrySensor, BreathSpread, PenTracker, DripSim, FogField, Coach, AutoFog, SteadyText, Latch, HINTS,
  dripRadius, fogRenderScale, penOnFog,
} from './frost/logic.js';
import { makeFrostTexture, makePuffSprite, makeDripSprite } from './frost/textures.js';

const EVAP_RATE = 1.3 / 50; // 가장 진한 김이 평균 50초쯤 지나면 다 마른다 (곳곳마다 조금씩 다르게)
const HAND_REVEAL = 0.55; // 김 앞에 있는 손이 보이도록 손 모양만큼 김을 살짝 걷어 그린다 (김 자체는 그대로)
const HAZE = 'rgba(230, 240, 248, 0.66)';
const WET = 'rgba(8, 30, 52, 0.16)'; // 닦인 유리는 김보다 어둡고 맑게 보인다 → 그림이 또렷해진다
const WATER_PER_PX2 = 1 / 5200; // 닦아 낸 김(px²·농도)이 이만큼 모이면 물방울 하나
const MAX_PUFFS = 70;
const COVERAGE_EVERY = 0.25; // 초
const FOG_MAX_PX = 3e6; // 김 층을 합치는 캔버스의 최대 화소 수
const RESIZE_SETTLE = 0.25; // 창 크기가 바뀐 뒤 손 좌표가 자리 잡을 때까지 그리기를 쉬는 시간(초)
const TINKS = [2093, 2349, 2637, 3136, 3520, 4186]; // 서리 맺히는 반짝 소리 (5음계라 아무렇게나 골라도 듣기 좋다)

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export default {
  id: 'frost',
  title: '입김 그림',
  emoji: '🌬️',
  color: '#80deea',
  description: '화면에 후~ 입김을 불면 창문처럼 김이 서려요. 손가락으로 쓱쓱 그림을 그려요!',
  hint: HINTS.blow,
  needs: { face: true, mic: true },
  create(app) {
    const rng = Math.random;
    const sensor = new BlowSensor();
    const tries = new TrySensor();
    const spread = new BreathSpread();
    const pens = new PenTracker();
    const drips = new DripSim({ max: 24 });
    const coach = new Coach();
    const autoFog = new AutoFog();
    const hint = new SteadyText(0.3);
    const drawLatch = new Latch(0.15);
    const puffSprite = makePuffSprite();
    const drip = makeDripSprite();
    const puffs = [];
    const water = new Map(); // hand id → 모인 물 (물방울 만들기)
    const squeakAcc = new Map(); // hand id → 지난 뽀득 소리 뒤로 김 위를 문지른 거리

    let W = 0;
    let H = 0;
    let field = null;
    let mask = null;
    let maskCtx = null;
    let maskImg = null;
    let edge = null;
    let edgeCtx = null;
    let edgeImg = null;
    let small = null;
    let tiny = null;
    let mid = null;
    let sil = null; // 김 앞의 손 모양 (김 격자와 같은 낮은 해상도)
    let silCtx = null;
    let comp = null; // 큰 화면에서 김 층을 합치는 캔버스 (없으면 화면에 바로 그린다)
    let compCtx = null;
    let fogScale = 1;
    let frostTex = null;
    let texTimer = null;

    let coverage = 0;
    let coverageT = 0;
    let autoFogP = -1;
    let autoFogs = 0;
    let wasBlowing = false;
    let sinceBlow = Infinity;
    let lastSwish = -1;
    let lastSqueak = -1;
    let lastWhoosh = -1;
    let lastPlip = -1;
    let nextTink = 0;
    let squeakAlt = false;
    let squeaks = 0;
    let swishes = 0;
    let now = 0;
    let strokeLen = 0;
    let drawing = false;
    let wiping = false;
    let trying = false;
    let penCount = 0;
    let blowState = { blowing: false, strength: 0, sources: [] };
    let msAvg = 0;
    let frameMs = 0;
    let puffDebt = 0;
    let lastHands = [];
    let faceK = 0;

    function setup(w, h) {
      const old = field;
      const oldW = W;
      const oldH = H;
      W = Math.max(1, w);
      H = Math.max(1, h);
      field = new FogField(W, H);
      if (old) field.resampleFrom(old);
      // 작은 캔버스들은 새로 만들고 예전 것은 바로 비운다
      for (const c of [mask, edge, small, tiny, mid, sil]) if (c) c.width = c.height = 0;
      mask = makeCanvas(field.gw, field.gh);
      maskCtx = mask.getContext('2d');
      maskImg = maskCtx.createImageData(field.gw, field.gh);
      // RGB 는 흰색으로 한 번만 채워 두고, 매 프레임 알파만 바꾼다
      const data = maskImg.data;
      for (let p = 0; p < data.length; p += 4) data[p] = data[p + 1] = data[p + 2] = 255;
      edge = makeCanvas(field.gw, field.gh);
      edgeCtx = edge.getContext('2d');
      edgeImg = edgeCtx.createImageData(field.gw, field.gh);
      sil = makeCanvas(field.gw, field.gh);
      silCtx = sil.getContext('2d');
      field.dirty = true;
      // 흐린 영상: 큰 영상 → 1/6 → 1/22 → 다시 1/5 로 늘려서 부드럽게 흐리게
      small = makeCanvas(W / 6, H / 6);
      tiny = makeCanvas(W / 22, H / 22);
      mid = makeCanvas(W / 5, H / 5);
      for (const c of [small, tiny, mid]) {
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
      }
      // 김 층 해상도: 큰 화면에서는 작은 캔버스에서 합친다 (화면 전체를 여러 번 겹쳐 칠하는 비용 줄이기)
      const rs = fogRenderScale(W, H, app.dpr || window.devicePixelRatio || 1, FOG_MAX_PX);
      fogScale = rs.scale;
      if (rs.comp) {
        const cw = Math.max(1, Math.round(W * fogScale));
        const ch = Math.max(1, Math.round(H * fogScale));
        if (!comp || comp.width !== cw || comp.height !== ch) {
          if (comp) comp.width = comp.height = 0;
          comp = makeCanvas(cw, ch);
          compCtx = comp.getContext('2d');
        }
      } else if (comp) {
        comp.width = comp.height = 0;
        comp = compCtx = null;
      }
      // 물방울 결은 만들기가 조금 무거우니, 창 크기를 끄는 동안에는 예전 것을 늘려 쓰고 멈추면 새로 만든다
      const makeTex = () => {
        texTimer = null;
        if (frostTex) frostTex.width = frostTex.height = 0;
        frostTex = makeFrostTexture(W, H, fogScale, 3, HAZE);
      };
      clearTimeout(texTimer);
      if (frostTex) texTimer = setTimeout(makeTex, 250);
      else makeTex();
      if (old) {
        const sx = W / oldW;
        const sy = H / oldH;
        drips.rescale(sx, sy);
        spread.rescale(sx, sy);
        sensor.rescale(sx, sy);
        for (const p of puffs) {
          p.x *= sx;
          p.y *= sy;
        }
        // 손 좌표가 새 화면에 자리 잡을 때까지 잠깐 쉰다 (가만히 있는 손가락이 줄을 긋지 않게)
        pens.suspend(RESIZE_SETTLE);
        drawLatch.reset();
      }
    }

    function release() {
      clearTimeout(texTimer);
      for (const c of [mask, edge, small, tiny, mid, sil, comp, frostTex]) if (c) c.width = c.height = 0;
      mask = edge = small = tiny = mid = sil = comp = frostTex = null;
      silCtx = compCtx = null;
    }

    function setHint(text, dt = 0) {
      if (hint.update(dt, text)) app.ui.hint(hint.value);
    }

    // ---------------------------------------------------------------- 입김

    function spawnPuffs(dt, sources, rateK = 1, faint = false) {
      for (const s of sources) {
        puffDebt += dt * (18 + 30 * s.s) * rateK;
        while (puffDebt >= 1) {
          puffDebt -= 1;
          if (puffs.length >= MAX_PUFFS) puffs.shift();
          const a = rng() * Math.PI * 2;
          const sc = s.scale;
          const sp = sc * (0.5 + rng() * 1.1) * (0.6 + 0.6 * s.s);
          puffs.push({
            x: s.x + Math.cos(a) * sc * 0.08,
            y: s.y + Math.sin(a) * sc * 0.05,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp * 0.75 - sc * 0.15,
            r: sc * (0.1 + rng() * 0.08),
            grow: sc * (0.5 + rng() * 0.5),
            life: 0.6 + rng() * 0.6,
            age: 0,
            faint,
          });
        }
      }
    }

    function stepPuffs(dt) {
      const drag = Math.exp(-dt * 2.2);
      for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i];
        p.age += dt;
        if (p.age >= p.life) {
          puffs.splice(i, 1);
          continue;
        }
        p.vx *= drag;
        p.vy *= drag;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.r += p.grow * dt;
      }
    }

    function breathSound(blow, growing) {
      const s = app.sound;
      // 후~ 시작: 위로 미끄러지는 짧은 소리 (입김 감지가 끊기지 않을 만큼 짧게)
      if (blow.blowing && !wasBlowing && now - lastSwish > 0.6) {
        s.tone({ type: 'sine', freq: 620, to: 1240, dur: 0.15, gain: 0.07 });
        lastSwish = now;
      }
      // 김이 맺히는 동안 '반짝반짝' 서리 소리
      if (blow.blowing && growing && now >= nextTink) {
        const f = TINKS[(rng() * TINKS.length) | 0];
        s.tone({ type: 'sine', freq: f, to: f * 1.03, dur: 0.05, gain: 0.025 + 0.025 * blow.strength });
        nextTink = now + 0.09 + rng() * 0.14;
      }
      wasBlowing = blow.blowing;
    }

    // ---------------------------------------------------------------- 그리기 / 닦기

    function collectWater(id, removed, x, y) {
      let wv = (water.get(id) || 0) + removed * field.cell * field.cell * WATER_PER_PX2;
      if (wv >= 1) {
        // 닦인 자리 아래쪽 가장자리, 김이 남아 있는 곳에서 물방울이 맺힌다
        if (field.sample(x, y + field.cell) > 0.45) {
          drips.spawn(x, y, 0.55 + rng() * 0.55, rng);
          wv -= 1 + rng() * 0.8;
        } else wv = 0.8;
      }
      water.set(id, wv);
    }

    /** 뽀득: 김 위에 처음 닿을 때, 그리고 김 위를 일정 거리 문지를 때마다. 맑은 유리 위에서는 조용하다. */
    function penSqueak(op, onFog) {
      const v = op.speed / op.size; // 손 크기/초
      let acc = squeakAcc.get(op.id) || 0;
      let pitch = 0;
      if (op.start) {
        acc = 0;
        if (onFog && now - lastSqueak > 0.25) pitch = 1.25 + rng() * 0.2;
      } else if (onFog) {
        acc += op.len;
        if (acc > op.size * 0.7 && v > 0.8 && now - lastSqueak > 0.09) pitch = 0.9 + Math.min(0.7, v * 0.1) + rng() * 0.12;
      }
      if (pitch) {
        squeakAlt = !squeakAlt; // 뽀-득 뽀-득 높낮이를 번갈아
        app.sound.squeak(pitch * (squeakAlt ? 1.08 : 1));
        lastSqueak = now;
        squeaks++;
        acc = 0;
      }
      squeakAcc.set(op.id, acc);
    }

    function applyOps(ops, dt) {
      let moved = false;
      wiping = false;
      penCount = 0;
      let drawn = 0;
      for (const op of ops) {
        if (op.type === 'pen') {
          penCount++;
          const removed = field.eraseCapsule(op.ax, op.ay, op.bx, op.by, op.r);
          drips.wipe(op.ax, op.ay, op.bx, op.by, op.r); // 손가락이 지나간 물방울은 같이 닦인다
          strokeLen += op.len;
          drawn += op.len / op.size;
          if (op.len > 0.5) moved = true;
          collectWater(op.id, removed, op.bx + (rng() - 0.5) * op.r, op.by + op.r + field.cell);
          penSqueak(op, penOnFog(removed, op, field.cell));
        } else if (op.type === 'wipe') {
          wiping = true;
          let removed = field.eraseCapsule(op.fromPalm.x, op.fromPalm.y, op.palm.x, op.palm.y, op.r);
          for (const f of op.fingers) removed += field.eraseCapsule(f[0], f[1], f[2], f[3], op.fr);
          for (const tr of op.trails) removed += field.eraseCapsule(tr[0], tr[1], tr[2], tr[3], op.fr);
          // 손바닥에 걸린 물방울도 닦여 나간다 (손바닥 가장자리에서 새로 맺히는 물방울은 남도록 조금 안쪽만)
          drips.wipe(op.fromPalm.x, op.fromPalm.y, op.palm.x, op.palm.y, op.r * 0.85);
          for (const f of op.fingers) drips.wipe(f[0], f[1], f[2], f[3], op.fr);
          for (const tr of op.trails) drips.wipe(tr[0], tr[1], tr[2], tr[3], op.fr);
          collectWater(op.id, removed * 0.6, op.palm.x + (rng() - 0.5) * op.r * 1.4, op.palm.y + op.r * 0.95);
          const v = op.speed / op.size;
          if (v > 1.8 && removed > 2 && now - lastWhoosh > 0.32) {
            // 쓱: 아래로 미끄러지는 짧은 음 두 개
            const f = 1150 + rng() * 250;
            app.sound.tone({ type: 'sine', freq: f, to: f * 0.5, dur: 0.13, gain: 0.07 });
            app.sound.tone({ type: 'triangle', freq: f * 1.5, to: f * 0.7, dur: 0.1, gain: 0.025 });
            lastWhoosh = now;
            swishes++;
          }
        }
      }
      // 새 손 인식이 없는 프레임(화면이 카메라보다 빠를 때)에는 손이 제자리라 len 이 0 → 잠깐 유지해서 깜빡이지 않게
      drawing = drawLatch.update(dt, moved);
      for (const id of [...water.keys()]) if (!ops.some((o) => o.id === id)) water.delete(id);
      for (const id of [...squeakAcc.keys()]) if (!ops.some((o) => o.id === id)) squeakAcc.delete(id);
      return drawn;
    }

    // ---------------------------------------------------------------- 그리기 도우미

    const CHAINS = [
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
      [17, 18, 19, 20],
    ];
    const PALM = [0, 1, 5, 9, 13, 17];

    function handPath(g, lm, withPalm) {
      g.beginPath();
      for (const ch of CHAINS) {
        g.moveTo(lm[ch[0]].x, lm[ch[0]].y);
        for (let i = 1; i < ch.length; i++) g.lineTo(lm[ch[i]].x, lm[ch[i]].y);
      }
      if (withPalm) {
        g.moveTo(lm[PALM[0]].x, lm[PALM[0]].y);
        for (let i = 1; i < PALM.length; i++) g.lineTo(lm[PALM[i]].x, lm[PALM[i]].y);
        g.closePath();
      }
    }

    /**
     * 김 앞에 있는 손 모양을 작은 캔버스(sil)에 그린다: 바깥 테두리는 반투명, 손 모양은 불투명.
     * 겹치는 부분도 같은 진하기가 되도록 '불투명하게 합친 모양'을 만든 뒤, 김에서는 한 번만 걷어 낸다.
     * @returns {{x:number,y:number,w:number,h:number}|null} 손이 있는 영역 (화면 px)
     */
    function buildSilhouette() {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const h of lastHands) {
        if (h.stale) continue;
        const pad = h.size * 0.3;
        for (const p of h.lm) {
          if (p.x - pad < x0) x0 = p.x - pad;
          if (p.y - pad < y0) y0 = p.y - pad;
          if (p.x + pad > x1) x1 = p.x + pad;
          if (p.y + pad > y1) y1 = p.y + pad;
        }
      }
      x0 = Math.max(0, x0);
      y0 = Math.max(0, y0);
      x1 = Math.min(W, x1);
      y1 = Math.min(H, y1);
      if (!(x1 > x0 && y1 > y0)) return null;
      const g = silCtx;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, sil.width, sil.height);
      g.setTransform(sil.width / W, 0, 0, sil.height / H, 0, 0);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.fillStyle = g.strokeStyle = '#000';
      // 바깥 테두리: 손마다 한 번의 선 긋기라서 손가락끼리 겹쳐도 진하기가 같다
      g.globalAlpha = 0.45;
      for (const h of lastHands) {
        if (h.stale) continue;
        handPath(g, h.lm, true);
        g.lineWidth = h.size * 0.29;
        g.stroke();
      }
      // 손 모양: 불투명하게 칠하므로 여러 번 겹쳐 칠해도 똑같다
      g.globalAlpha = 1;
      for (const h of lastHands) {
        if (h.stale) continue;
        handPath(g, h.lm, true);
        g.lineWidth = h.size * 0.2;
        g.stroke();
        g.fill();
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /** 김 층 한 장을 g 에 그린다 (g 는 화면 CSS px 좌표). first = 처음 그리는 방법 ('copy' 면 이전 내용을 지운다) */
    function composeFog(g, first, hand) {
      const gw = field.gw * field.cell;
      const gh = field.gh * field.cell;
      g.imageSmoothingEnabled = true;
      // 흐린 창 너머 풍경 + 안개색과 물방울 결
      g.globalCompositeOperation = first;
      g.drawImage(mid, 0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
      g.drawImage(frostTex, 0, 0, W, H);
      // 김 농도로 오려 내기
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(mask, 0, 0, gw, gh);
      // 김 가장자리의 도톰한 결 (빛 받는 쪽 흰색, 반대쪽 그림자)
      g.globalCompositeOperation = 'source-over';
      g.drawImage(edge, 0, 0, gw, gh);
      // 김이 없는 곳(닦인 유리)은 살짝 어둡게: 이미 그린 김 '뒤'에만 칠해진다
      g.globalCompositeOperation = 'destination-over';
      g.globalAlpha = Math.min(1, coverage * 4);
      g.fillStyle = WET;
      g.fillRect(0, 0, W, H);
      // 김 앞의 손은 살짝 비쳐 보이게 (농도는 그대로라 손을 치우면 다시 김) — 손이 있는 영역만 한 번에
      if (hand) {
        const kx = sil.width / W;
        const ky = sil.height / H;
        g.globalCompositeOperation = 'destination-out';
        g.globalAlpha = HAND_REVEAL;
        g.drawImage(sil, hand.x * kx, hand.y * ky, hand.w * kx, hand.h * ky, hand.x, hand.y, hand.w, hand.h);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    function drawFog(ctx) {
      if (field.dirty) {
        field.writeAlpha(maskImg.data, edgeImg.data);
        maskCtx.putImageData(maskImg, 0, 0);
        edgeCtx.putImageData(edgeImg, 0, 0);
      }
      // 흐린 창 너머 풍경
      const sg = small.getContext('2d');
      sg.clearRect(0, 0, small.width, small.height);
      app.drawSource(sg, small.width, small.height);
      tiny.getContext('2d').drawImage(small, 0, 0, tiny.width, tiny.height);
      mid.getContext('2d').drawImage(tiny, 0, 0, mid.width, mid.height);
      const hand = HAND_REVEAL > 0 ? buildSilhouette() : null;
      if (comp) {
        compCtx.setTransform(comp.width / W, 0, 0, comp.height / H, 0, 0);
        composeFog(compCtx, 'copy', hand);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(comp, 0, 0, W, H);
      } else {
        ctx.save();
        composeFog(ctx, 'source-over', hand);
        ctx.restore();
      }
    }

    function drawDrips(ctx) {
      const unit = H / 720;
      const s = drip.canvas;
      for (const d of drips.drips) {
        const r = dripRadius(d.m, unit);
        const k = r / drip.R;
        const stretch = 1 + 0.6 * Math.min(1, d.v / (unit * 110));
        ctx.globalAlpha = d.dead ? Math.max(0, d.fade) : Math.min(1, d.age / 0.25);
        const h = s.height * k * stretch;
        ctx.drawImage(s, d.x - drip.cx * k, d.y + (s.height - drip.cy) * k - h, s.width * k, h);
      }
      ctx.globalAlpha = 1;
    }

    function drawPuffs(ctx) {
      for (const p of puffs) {
        const u = p.age / p.life;
        const a = (p.faint ? 0.38 : 0.5) * Math.min(1, p.age / 0.1) * Math.pow(1 - u, 1.3);
        if (a <= 0.005) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(puffSprite, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
      ctx.globalAlpha = 1;
    }

    function drawCursors(ctx) {
      const t = now;
      for (const h of lastHands) {
        if (h.stale) continue;
        const mode = pens.modeOf(h.id);
        const tip = h.lm[8];
        const r = Math.max(7, Math.min(35, h.size * 0.09)) + 3;
        if (mode === 'pen') {
          const pulse = 1 + 0.08 * Math.sin(t * 9);
          ctx.lineWidth = 5;
          ctx.strokeStyle = 'rgba(10,50,80,0.32)';
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, r * pulse, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = 'rgba(255,255,255,0.95)';
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        } else if (mode === 'none' && coverage > 0.05 && h.pose !== 'open') {
          // 아직 그리지 않는 손: 검지 끝에 점선 동그라미 → "이 손가락으로 그려요"
          ctx.setLineDash([5, 6]);
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = 'rgba(255,255,255,0.6)';
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    setup(app.width, app.height);

    return {
      enter() {
        setHint(HINTS.blow);
      },

      update(frame) {
        const t0 = performance.now();
        if (frame.width !== W || frame.height !== H) setup(frame.width, frame.height);
        const dt = frame.dt;
        now = frame.t;
        const mic = frame.mic || { enabled: false, level: 0, blowing: false, strength: 0 };
        const faces = frame.faces || [];
        lastHands = frame.hands;

        // 1) 입김 → 입 앞에서부터 김이 퍼진다
        blowState = sensor.update(dt, mic, faces, W, H);
        const blobs = spread.update(dt, blowState.sources, W, H);
        let added = 0;
        for (const b of blobs) added += field.addBlob(b.x, b.y, b.R, b.amount);
        if (blowState.blowing) {
          sinceBlow = 0;
          spawnPuffs(dt, blowState.sources);
        } else sinceBlow += dt;
        breathSound(blowState, added > 1);

        // 1b) '거의 불었어요': 소리는 들리는데 입김으로는 모자라면 희미한 알갱이와 옅은 김으로 "조금만 더!"
        //     (김이 거의 없을 때만 — 그림 위에 김이 끼지 않게)
        const fallback = sensor.lastMouth && sensor.lastMouthAge < 2.5
          ? { x: sensor.lastMouth.x, y: sensor.lastMouth.y, scale: sensor.lastMouth.w || Math.min(W, H) * 0.3 }
          : { x: W / 2, y: H / 2, scale: Math.min(W, H) * 0.3 };
        tries.update(dt, mic, faces, blowState.blowing, fallback);
        trying = tries.trying && coach.phase !== 'draw';
        if (trying) {
          const src = tries.source;
          spawnPuffs(dt, [{ x: src.x, y: src.y, scale: src.scale, s: 0 }], 0.6, true);
          if (field.sample(src.x, src.y) < 0.38) field.addBlob(src.x, src.y, src.scale * 0.6, dt * (0.15 + 0.5 * (mic.level || 0)));
        }
        stepPuffs(dt);

        // 2) 아무도 안 불면 저절로 서리기 (마이크가 없을 때 특히, 애쓰는 아이가 있으면 더 빨리)
        if (autoFog.update(dt, { micEnabled: !!mic.enabled, blowing: blowState.blowing, coverage, trying })) {
          autoFogP = 0;
          autoFogs++;
          app.ui.toast(autoFog.lastTried ? '후~ 잘했어요! 김이 서려요 ❄️' : '김이 저절로 서렸어요 ❄️');
          app.sound.sparkle();
          coach.markToast(); // 바로 뒤에 "김이 서렸어요!" 가 겹쳐 나오지 않게
        }
        if (autoFogP >= 0) {
          autoFogP = Math.min(1, autoFogP + dt / 2.4);
          field.fogIn(autoFogP);
          if (autoFogP >= 1) autoFogP = -1;
        }

        // 3) 손가락으로 그리기, 손바닥으로 닦기
        const ops = pens.update(frame.hands, dt);
        const drawn = applyOps(ops, dt);

        // 4) 물방울: 진한 김에서는 가끔 저절로 맺힌다 (방금 분 김일수록 자주)
        const fresh = sinceBlow < 4 ? 1 : 0;
        if (coverage > 0.35 && rng() < dt * (0.06 + 0.3 * fresh)) {
          const spot = field.randomDenseSpot(rng, 1.0);
          if (spot) drips.spawn(spot.x, spot.y, 0.5 + rng() * 0.4, rng, 0.6);
        }
        const started = drips.step(dt, field, H, rng);
        if (started && now - lastPlip > 1.3) {
          const f = 1300 + rng() * 500;
          app.sound.tone({ type: 'sine', freq: f, to: f * 0.62, dur: 0.07, gain: 0.05 });
          lastPlip = now;
        }

        // 5) 김은 천천히 마른다
        field.evaporate(dt, EVAP_RATE);

        // 6) 덮인 정도는 가끔만 센다
        coverageT -= dt;
        if (coverageT <= 0) {
          coverage = field.empty ? 0 : field.coverage(0.4, 2);
          coverageT = COVERAGE_EVERY;
        }

        // 7) 안내와 축하
        let liveHands = 0;
        for (const h of frame.hands) if (!h.stale) liveHands++;
        let faceW = 0;
        for (const f of faces) faceW = Math.max(faceW, f.width || 0);
        faceK = faceW / W;
        const c = coach.update(dt, {
          coverage, blowing: blowState.blowing, drawing, wiping, drawn, micEnabled: !!mic.enabled,
          liveHands, faces: faces.length, faceK, trying, tryTime: tries.time,
        });
        setHint(c.hint, dt);
        for (const e of c.events) {
          if (e === 'fogged') {
            app.ui.toast('김이 서렸어요! ❄️');
            app.sound.chime();
          } else if (e === 'art') {
            app.ui.toast('우와, 멋진 그림! 🎨');
            app.sound.sparkle();
          }
        }
        frameMs = performance.now() - t0;
      },

      draw(ctx) {
        const t0 = performance.now();
        if (!field.empty) drawFog(ctx);
        drawDrips(ctx);
        drawPuffs(ctx);
        // 카메라 화면만 모드에서는 손가락 끝 안내 고리를 그리지 않는다 (그린 선은 바로 보인다)
        if (!app.clean) drawCursors(ctx);
        frameMs += performance.now() - t0;
        msAvg += (frameMs - msAvg) * 0.05;
      },

      resize(w, h) {
        setup(w, h);
      },

      exit() {
        puffs.length = 0;
        drips.clear();
        release();
      },

      state() {
        return {
          coverage: Math.round(coverage * 1000) / 1000,
          blowing: blowState.blowing,
          strength: Math.round(blowState.strength * 100) / 100,
          sources: blowState.sources.length,
          strict: sensor.strict,
          trying,
          tryTime: Math.round(tries.time * 100) / 100,
          drawing,
          wiping,
          pens: penCount,
          squeaks,
          swishes,
          drips: drips.count,
          dripsSpawned: drips.spawned,
          dripsWiped: drips.wiped,
          strokeLength: Math.round(strokeLen),
          phase: coach.phase,
          hint: hint.value,
          autoFogs,
          puffs: puffs.length,
          grid: [field.gw, field.gh],
          comp: !!comp,
          fogScale: Math.round(fogScale * 100) / 100,
          faceK: Math.round(faceK * 100) / 100,
          tip: lastHands[0] ? [Math.round(lastHands[0].lm[8].x), Math.round(lastHands[0].lm[8].y)] : null,
          ms: Math.round(msAvg * 100) / 100,
        };
      },
    };
  },
};
