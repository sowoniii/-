// 앱 시작점: 카메라 → 손/얼굴 인식 → 현재 놀이(모드) → 화면 그리기 를 매 프레임 반복한다.

import { Viewport } from './core/viewport.js';
import { Stage, sourceSize, isSourceReady } from './core/stage.js';
import { HandTracker } from './core/handtracker.js';
import { FaceTracker } from './core/facetracker.js';
import { Tracker } from './core/tracker.js';
import { openCamera } from './core/camera.js';
import { BlowDetector } from './core/mic.js';
import { Sound } from './core/sound.js';
import { SimInput, SimScene } from './core/sim.js';
import { drawDebug } from './core/debug.js';
import { UI } from './ui/ui.js';
import { MODES } from './modes/index.js';

const params = new URLSearchParams(location.search);
const int = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

export const config = {
  numHands: int(params.get('hands'), 1, 6, 4),
  numFaces: int(params.get('faces'), 1, 4, 3),
  delegate: params.has('cpu') ? 'CPU' : 'GPU',
  sim: params.has('sim'),
  debug: params.has('debug'),
  startMode: params.get('mode'),
  muted: params.has('mute'),
  autostart: params.has('autostart') || params.has('kiosk'),
  kiosk: params.has('kiosk'),
};

export class App {
  constructor() {
    this.config = config;
    this.video = document.getElementById('video');
    this.stage = new Stage(document.getElementById('stage'));
    this.overlay = document.getElementById('overlay');
    this.ctx = this.overlay.getContext('2d');
    this.viewport = new Viewport();
    this.sound = new Sound();
    this.sound.muted = config.muted;
    this.handTracker = new HandTracker();
    this.faceTracker = new FaceTracker();
    this.tracker = null;
    this.mic = null;
    this.sim = null;
    this.simScene = null;
    this.source = null;
    this.modeDef = null;
    this.mode = null;
    this.hands = [];
    this.faces = [];
    this.debug = config.debug;
    this.running = false;
    this.started = false;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.stats = { fps: 0, detectMs: 0, source: '' };
    this._lastVideoTime = -1;
    this._lastT = null;
    this.ui = new UI(this, MODES);
    this._resize();
    window.addEventListener('resize', () => this._resize());
    window.addEventListener('keydown', (e) => this._onKey(e));
    // 소리는 사용자가 한 번 누른 뒤에야 켤 수 있다.
    window.addEventListener('pointerdown', () => this.sound.unlock(), { passive: true });
    this.frame = this.frame.bind(this);
    if (config.autostart || config.sim) this.start({ sim: config.sim, modeId: config.startMode });
  }

  // ------------------------------------------------------------------ 모드가 쓰는 도구

  get isSim() {
    return !!this.sim;
  }

  /** 현재 영상 소스 (카메라 video 또는 연습 모드 캔버스) */
  getSource() {
    return this.source;
  }

  /** 2D 캔버스에 화면과 똑같이 보이는(거울+꽉 채운) 영상을 그린다. 작은 캔버스에 그리면 흐림 효과용으로 좋다. */
  drawSource(ctx, w = this.width, h = this.height) {
    if (this.source && isSourceReady(this.source)) this.viewport.drawSource(ctx, this.source, w, h);
  }

  // ------------------------------------------------------------------ 시작/전환

  async start({ sim = false, modeId = null } = {}) {
    if (this.started) {
      this.ui.showStart(false);
      if (modeId) this.switchMode(modeId);
      return;
    }
    this.sound.unlock();
    this.ui.hideError();
    this.ui.showStart(false);
    const def = MODES.find((m) => m.id === modeId) || MODES[0];

    if (sim) {
      this._startSim();
    } else {
      this.ui.showStatus('카메라를 켜고 있어요… 📷');
      try {
        const { audioStream } = await openCamera(this.video, { audio: true });
        this.source = this.video;
        this.viewport.mirror = true;
        if (audioStream && this.sound.ctx) {
          this.mic = new BlowDetector(this.sound.ctx);
          this.mic.attach(audioStream);
        }
      } catch (e) {
        this._cameraError(e, def.id);
        return;
      }
      this.ui.showStatus('손을 알아보는 준비를 하고 있어요… ✋');
      try {
        this.tracker = new Tracker(this.viewport, config);
        await this.tracker.initHands();
        this.stats.source = this.tracker.source === 'local' ? '로컬 모델' : 'CDN 모델';
      } catch (e) {
        console.error(e);
        this.ui.showError({
          title: '손 인식 준비에 실패했어요 😢',
          message: '인터넷 연결을 확인해 주세요. 오프라인 전시라면 README 의 "오프라인 준비"를 따라 해 주세요.',
          actions: [
            { label: '다시 시도', onClick: () => location.reload() },
            { label: '마우스로 연습하기', onClick: () => this._fallbackToSim(def.id) },
          ],
        });
        return;
      }
      this.ui.showStatus(null);
    }
    this.started = true;
    this.switchMode(def.id);
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this.frame);
    }
  }

  _startSim() {
    this.sim = new SimInput();
    this.sim.attach(document.getElementById('hud'));
    this.sim.layout(this.width, this.height);
    this.simScene = new SimScene();
    this.simScene.resize(this.width, this.height);
    this.source = this.simScene.canvas;
    this.viewport.mirror = false;
    this.stats.source = '연습 모드';
    document.body.classList.add('sim');
  }

  _fallbackToSim(modeId) {
    this.tracker = null;
    this._startSim();
    this.started = true;
    this.switchMode(modeId);
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this.frame);
    }
  }

  _cameraError(e, modeId) {
    console.error(e);
    const messages = {
      denied: '카메라 사용을 허락해 주세요. 주소창 옆 🔒 아이콘에서 카메라를 "허용"으로 바꾼 뒤 다시 시도해 주세요.',
      notfound: '연결된 카메라를 찾지 못했어요. 카메라를 연결한 뒤 다시 시도해 주세요.',
      unsupported: '이 브라우저에서는 카메라를 쓸 수 없어요. 크롬이나 사파리 최신 버전에서 https 주소로 열어 주세요.',
    };
    this.ui.showError({
      title: '카메라를 켤 수 없어요 📷',
      message: messages[e.code] || `문제가 생겼어요: ${e.message}`,
      actions: [
        { label: '다시 시도', onClick: () => this.start({ modeId }) },
        { label: '마우스로 연습하기', onClick: () => this._fallbackToSim(modeId) },
      ],
    });
  }

  switchMode(id) {
    const def = MODES.find((m) => m.id === id);
    if (!def || !this.started) return;
    if (this.mode) {
      try {
        this.mode.exit?.();
      } catch (e) {
        console.error(e);
      }
    }
    this.sound.stopAllLoops();
    this.stage.grid.reset();
    this.stage.tint = [0, 0, 0, 0];
    this.modeDef = def;
    this.ui.setActive(def);
    this.mode = def.create(this);
    this.mode.enter?.();
    const url = new URL(location.href);
    url.searchParams.set('mode', id);
    history.replaceState(null, '', url);
    if (def.needs?.face && this.tracker) {
      if (!this.tracker.face) this.ui.showStatus('얼굴을 알아보는 준비를 하고 있어요… 🙂');
      this.tracker
        .initFace()
        .then(() => this.ui.showStatus(null))
        .catch((e) => {
          console.error(e);
          this.ui.showStatus(null);
          this.ui.toast('얼굴 인식을 불러오지 못했어요 😢');
        });
    }
  }

  showMenu() {
    this.ui.showStart(true);
  }

  // ------------------------------------------------------------------ 매 프레임

  frame(nowMs) {
    requestAnimationFrame(this.frame);
    const t = nowMs / 1000;
    const dt = this._lastT === null ? 1 / 60 : Math.min(0.05, Math.max(0, t - this._lastT));
    this._lastT = t;
    if (dt > 0) this.stats.fps += (1 / dt - this.stats.fps) * 0.05;

    const needFace = !!this.modeDef?.needs?.face;
    let det = null;
    if (this.sim) {
      this.sim.layout(this.width, this.height);
      det = this.sim.detect();
      this.simScene.resize(this.width, this.height);
      this.simScene.draw(det);
      this.viewport.setSource(this.width, this.height, false);
    } else if (this.tracker && isSourceReady(this.video)) {
      const { w, h } = sourceSize(this.video);
      this.viewport.setSource(w, h, true);
      if (this.video.currentTime !== this._lastVideoTime) {
        this._lastVideoTime = this.video.currentTime;
        const t0 = performance.now();
        try {
          det = this.tracker.detect(this.video, nowMs, { face: needFace });
        } catch (e) {
          console.error(e);
        }
        this.stats.detectMs += (performance.now() - t0 - this.stats.detectMs) * 0.1;
      }
    }
    if (det) {
      this.hands = this.handTracker.update(det.hands, t);
      if (needFace && det.faces) this.faces = this.faceTracker.update(det.faces, t);
    }
    if (!needFace && this.faces.length) {
      this.faces = [];
      this.faceTracker.reset();
    }

    let mic;
    if (this.sim) {
      mic = { enabled: true, level: this.sim.mic.blowing ? this.sim.mic.strength : 0, blowing: this.sim.mic.blowing, strength: this.sim.mic.blowing ? this.sim.mic.strength : 0 };
    } else if (this.mic) {
      mic = this.mic.update(dt).state;
    } else {
      mic = { enabled: false, level: 0, blowing: false, strength: 0 };
    }

    const frame = { t, dt, width: this.width, height: this.height, hands: this.hands, faces: this.faces, mic };

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.mode) {
      try {
        this.mode.update?.(frame);
        this.mode.drawGL?.(this.stage, frame);
      } catch (e) {
        console.error(e);
      }
    }
    this.stage.render(this.source, this.viewport);
    if (this.mode) {
      try {
        ctx.save();
        this.mode.draw?.(ctx, frame);
        ctx.restore();
      } catch (e) {
        console.error(e);
      }
    }
    if (this.debug) drawDebug(ctx, frame, this.stats);
    this.ui.update(frame);
    // 'started/ended' 같은 한 번만 일어나는 사건은 한 프레임만 보이게 지운다.
    for (const h of this.hands) {
      h.started = null;
      h.ended = null;
    }
  }

  _resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = Math.round(this.width * this.dpr);
    this.overlay.height = Math.round(this.height * this.dpr);
    this.viewport.resize(this.width, this.height);
    this.stage.resize(this.width, this.height, this.dpr);
    this.mode?.resize?.(this.width, this.height);
  }

  _onKey(e) {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= MODES.length && !e.shiftKey) this.switchMode(MODES[n - 1].id);
    else if (e.code === 'KeyD') this.debug = !this.debug;
    else if (e.code === 'KeyM') {
      this.sound.setMuted(!this.sound.muted);
      this.ui.syncMute();
    } else if (e.code === 'Escape') this.showMenu();
  }
}

const app = new App();
// 디버깅과 자동 테스트용
window.handplay = {
  app,
  get sim() {
    return app.sim;
  },
  modes: MODES.map((m) => m.id),
  switchMode: (id) => app.switchMode(id),
  start: (opts) => app.start(opts),
};
