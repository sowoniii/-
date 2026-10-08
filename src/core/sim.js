// 연습 모드: 카메라 없이 마우스·키보드로 가짜 손과 얼굴을 움직인다.
// 자동 테스트에서도 window.handplay.sim.set({...}) 으로 손 모양을 정할 수 있다.
//
// 조작법
//   마우스 이동: 손 움직이기   (Shift 누른 채 이동: 두 번째 손)
//   마우스 왼쪽 버튼 누르고 있기: 주먹   / 오른쪽 버튼: 집기
//   Q 펼친 손, W 주먹, E 브이, R 가리키기, T 집기, Y 힘 뺀 손
//   G 두 번째 손 보이기/숨기기, F 얼굴 보이기/숨기기, B 누르고 있기: 입김 불기
//   마우스 휠: 손 크기, [ ] : 손 기울이기

import { synthHand, synthFace, synthBlendshapes, FACE } from './synth.js';
import { HAND_CONNECTIONS } from './gestures.js';

const KEY_POSES = { KeyQ: 'open', KeyW: 'fist', KeyE: 'v', KeyR: 'point', KeyT: 'pinch', KeyY: 'other' };

export class SimInput {
  constructor() {
    this.hands = [
      { x: 0, y: 0, size: 150, angle: 0, pose: 'open', side: 'right', visible: true },
      { x: 0, y: 0, size: 150, angle: 0, pose: 'open', side: 'left', visible: false },
    ];
    this.faces = [{ x: 0, y: 0, size: 260, roll: 0, blow: 0, mouthOpen: 0, visible: true }];
    this.mic = { blowing: false, strength: 0 };
    this._blend = new Map(); // hand index → {from, start}
    this._mouseDown = null;
    this._placed = false;
    this.interactive = true;
  }

  /** 화면 크기에 맞춰 처음 위치를 잡는다. */
  layout(width, height) {
    if (this._placed) return;
    this._placed = true;
    this.hands[0].x = width * 0.62;
    this.hands[0].y = height * 0.62;
    this.hands[1].x = width * 0.3;
    this.hands[1].y = height * 0.62;
    this.faces[0].x = width * 0.45;
    this.faces[0].y = height * 0.38;
    const s = Math.min(width, height);
    this.hands[0].size = this.hands[1].size = s * 0.2;
    this.faces[0].size = s * 0.36;
  }

  /**
   * 프로그램으로 상태를 정한다. 넘긴 항목만 바뀐다.
   * @param {{hands?: object[], faces?: object[], mic?: {blowing?:boolean, strength?:number}}} s
   */
  set({ hands, faces, mic } = {}) {
    this._placed = true;
    if (hands) {
      this.hands = hands.map((h, i) => ({
        size: 150, angle: 0, pose: 'open', side: i % 2 ? 'left' : 'right', visible: true,
        ...(this.hands[i] || {}), ...h,
      }));
    }
    if (faces) {
      this.faces = faces.map((f, i) => ({ size: 260, roll: 0, blow: 0, mouthOpen: 0, visible: true, ...(this.faces[i] || {}), ...f }));
    }
    if (mic) this.mic = { ...this.mic, ...mic };
  }

  _setPose(i, pose) {
    const h = this.hands[i];
    if (!h || h.pose === pose) return;
    this._blend.set(i, { from: h.pose, start: performance.now() });
    h.pose = pose;
  }

  /** @param {HTMLElement} el 마우스 이벤트를 받을 요소 */
  attach(el) {
    const which = (e) => (e.shiftKey ? 1 : 0);
    el.addEventListener('pointermove', (e) => {
      if (!this.interactive) return;
      const h = this.hands[which(e)];
      if (!h) return;
      h.x = e.clientX;
      h.y = e.clientY;
      if (which(e) === 1) h.visible = true;
    });
    el.addEventListener('pointerdown', (e) => {
      if (!this.interactive) return;
      const i = which(e);
      if (!this.hands[i]) return;
      this._mouseDown = { i, prev: this.hands[i].pose };
      this._setPose(i, e.button === 2 ? 'pinch' : 'fist');
    });
    const up = () => {
      if (!this._mouseDown) return;
      this._setPose(this._mouseDown.i, this._mouseDown.prev);
      this._mouseDown = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      if (!this.interactive) return;
      const h = this.hands[which(e)];
      if (h) h.size = Math.max(60, Math.min(400, h.size * (e.deltaY > 0 ? 0.92 : 1.08)));
    }, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (!this.interactive || e.target instanceof HTMLInputElement) return;
      const i = e.shiftKey ? 1 : 0;
      if (KEY_POSES[e.code]) this._setPose(i, KEY_POSES[e.code]);
      else if (e.code === 'KeyG') this.hands[1].visible = !this.hands[1].visible;
      else if (e.code === 'KeyF' && this.faces[0]) this.faces[0].visible = !this.faces[0].visible;
      else if (e.code === 'KeyB') {
        this.mic = { blowing: true, strength: 0.8 };
        if (this.faces[0]) this.faces[0].blow = 1;
      } else if (e.code === 'BracketLeft') this.hands[i].angle -= 0.15;
      else if (e.code === 'BracketRight') this.hands[i].angle += 0.15;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyB') {
        this.mic = { blowing: false, strength: 0 };
        if (this.faces[0]) this.faces[0].blow = 0;
      }
    });
  }

  /** 트래커와 같은 형식의 검출 결과 */
  detect() {
    const now = performance.now();
    const hands = [];
    this.hands.forEach((h, i) => {
      if (!h.visible) return;
      const b = this._blend.get(i);
      let blend = 1;
      let from = null;
      if (b) {
        blend = Math.min(1, (now - b.start) / 120);
        from = b.from;
        if (blend >= 1) this._blend.delete(i);
      }
      hands.push({ lm: synthHand({ ...h, blend, from }), side: h.side, score: 1 });
    });
    const faces = this.faces
      .filter((f) => f.visible)
      .map((f) => ({ lm: synthFace(f), blend: synthBlendshapes({ blow: f.blow, mouthOpen: f.mouthOpen }) }));
    return { hands, faces };
  }
}

/**
 * 연습 모드용 가짜 '카메라 영상'. 화면과 같은 크기의 캔버스에 배경, 얼굴, 손을 그린다.
 * (거울 뒤집기 없이 화면 좌표 그대로 그린다)
 */
export class SimScene {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.bg = document.createElement('canvas');
  }

  resize(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = this.bg.width = w;
    this.canvas.height = this.bg.height = h;
    this._paintBackground();
  }

  _paintBackground() {
    const { width: w, height: h } = this.bg;
    const g = this.bg.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#9fd8ff');
    sky.addColorStop(0.65, '#e9f6ff');
    sky.addColorStop(0.66, '#c9e7a8');
    sky.addColorStop(1, '#8cc06b');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    // 창틀과 격자 무늬 (일그러짐이 잘 보이도록)
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 2;
    const step = Math.max(40, Math.round(Math.min(w, h) / 12));
    for (let x = 0; x <= w; x += step) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = 0; y <= h; y += step) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    // 해, 구름, 집
    g.fillStyle = '#ffd34d';
    g.beginPath();
    g.arc(w * 0.85, h * 0.15, Math.min(w, h) * 0.08, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    for (const [cx, cy, r] of [[0.15, 0.15, 0.05], [0.2, 0.13, 0.06], [0.26, 0.16, 0.045], [0.6, 0.1, 0.04], [0.65, 0.09, 0.05]]) {
      g.beginPath();
      g.arc(w * cx, h * cy, Math.min(w, h) * r, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#ff8a65';
    g.fillRect(w * 0.06, h * 0.55, w * 0.14, h * 0.2);
    g.fillStyle = '#c0504d';
    g.beginPath();
    g.moveTo(w * 0.04, h * 0.56);
    g.lineTo(w * 0.13, h * 0.44);
    g.lineTo(w * 0.22, h * 0.56);
    g.fill();
  }

  /**
   * @param {{hands: {lm:object[]}[], faces: {lm:object[], blend:object}[]}} det
   */
  draw(det) {
    const g = this.ctx;
    g.drawImage(this.bg, 0, 0);
    for (const f of det.faces) drawCartoonFace(g, f.lm, f.blend);
    for (const h of det.hands) drawCartoonHand(g, h.lm);
  }
}

function drawCartoonFace(g, lm, blend) {
  const top = lm[FACE.FOREHEAD];
  const chin = lm[FACE.CHIN];
  const cx = (top.x + chin.x) / 2;
  const cy = (top.y + chin.y) / 2;
  const hgt = Math.hypot(top.x - chin.x, top.y - chin.y);
  const roll = Math.atan2(top.y - chin.y, top.x - chin.x) + Math.PI / 2;
  const yawShift = (lm[FACE.NOSE_TIP].x - cx) * Math.cos(roll) + (lm[FACE.NOSE_TIP].y - cy) * Math.sin(roll);
  g.save();
  g.translate(cx, cy);
  g.rotate(roll);
  // 머리카락: 실제 사람 비율 (눈 사이가 중심, 정수리는 이마 위로 얼굴 높이의 약 0.4, 옆은 얼굴보다 조금 넓게)
  g.fillStyle = '#4a2f23';
  g.beginPath();
  const hx = -yawShift * 0.6;
  const hy = -hgt * 0.12;
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const s = Math.sin(a);
    const c = Math.cos(a);
    const e = 2 / 2.6;
    const px = hx + hgt * 0.53 * Math.sign(s) * Math.pow(Math.abs(s), e);
    const py = hy - (c > 0 ? hgt * 0.8 : hgt * 0.32) * Math.sign(c) * Math.pow(Math.abs(c), e);
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.fill();
  // 얼굴
  g.fillStyle = '#ffd9b8';
  g.beginPath();
  g.ellipse(yawShift * 0.25, hgt * 0.02, hgt * 0.42 * (1 - Math.abs(yawShift) / hgt), hgt * 0.5, 0, 0, Math.PI * 2);
  g.fill();
  // 눈
  g.fillStyle = '#2b2b2b';
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.ellipse(sx * hgt * 0.2 + yawShift * 0.5, -hgt * 0.12, hgt * 0.045, hgt * 0.06, 0, 0, Math.PI * 2);
    g.fill();
  }
  // 볼
  g.fillStyle = 'rgba(255,120,120,0.35)';
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.ellipse(sx * hgt * 0.27, hgt * 0.08, hgt * 0.07, hgt * 0.045, 0, 0, Math.PI * 2);
    g.fill();
  }
  // 입
  const blow = blend?.mouthPucker || 0;
  g.strokeStyle = '#a0413c';
  g.fillStyle = '#a0413c';
  g.lineWidth = hgt * 0.025;
  g.lineCap = 'round';
  if (blow > 0.3) {
    g.beginPath();
    g.ellipse(0, hgt * 0.25, hgt * 0.04, hgt * 0.05, 0, 0, Math.PI * 2);
    g.fill();
  } else {
    g.beginPath();
    g.arc(0, hgt * 0.18, hgt * 0.1, 0.2 * Math.PI, 0.8 * Math.PI);
    g.stroke();
  }
  g.restore();
}

function drawCartoonHand(g, lm) {
  const size = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // 손바닥
  g.fillStyle = '#f0b98d';
  g.beginPath();
  for (const [k, i] of [0, 1, 5, 9, 13, 17].entries()) {
    if (k === 0) g.moveTo(lm[i].x, lm[i].y);
    else g.lineTo(lm[i].x, lm[i].y);
  }
  g.closePath();
  g.fill();
  g.strokeStyle = '#f0b98d';
  g.lineWidth = size * 0.3;
  g.stroke();
  // 손가락
  for (const [a, b] of HAND_CONNECTIONS) {
    g.strokeStyle = '#e8ad80';
    g.lineWidth = size * 0.2;
    g.beginPath();
    g.moveTo(lm[a].x, lm[a].y);
    g.lineTo(lm[b].x, lm[b].y);
    g.stroke();
  }
  // 손톱
  g.fillStyle = '#ffe3d1';
  for (const i of [4, 8, 12, 16, 20]) {
    g.beginPath();
    g.arc(lm[i].x, lm[i].y, size * 0.06, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}
