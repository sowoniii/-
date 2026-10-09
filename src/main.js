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
  // 기본은 '카메라 화면만': 시작 화면·버튼·안내 글자 없이 바로 카메라로 시작한다. ?ui 를 붙이면 예전 화면(메뉴, 버튼, 안내).
  ui: params.has('ui'),
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
    /** 놀이 시간: frame.dt 를 더한 값 (느린 기기에서는 실제 시간보다 천천히 간다) */
    this.clock = 0;
    /** 그린 프레임 수 */
    this.frameCount = 0;
    this._lastVideoTime = -1;
    this._lastT = null;
    this._detectCount = 0;
    this._starting = false;
    this._pendingMode = null;
    this._audioStream = null;
    this._simFallback = false;
    this.ui = new UI(this, MODES);
    this._resize();
    window.addEventListener('resize', () => this._resize());
    window.addEventListener('keydown', (e) => this._onKey(e));
    // 소리는 사용자가 한 번 누른 뒤에야 켤 수 있다.
    window.addEventListener('pointerdown', () => this.sound.unlock(), { passive: true });
    // 키보드를 누른 것도 '사용자 동작'이라 소리를 켤 수 있다 (화면에 버튼이 없을 때 직원이 쓰는 길)
    window.addEventListener('keydown', () => this.sound.unlock());
    this.frame = this.frame.bind(this);
    this.setClean(!config.ui);
    if (this.clean || config.autostart || config.sim) this.start({ sim: config.sim, modeId: config.startMode });
  }

  /**
   * 카메라 화면만 보여 줄지(true) 메뉴·버튼·안내를 함께 보여 줄지(false).
   * 놀이들은 그릴 때마다 app.clean 을 보고 글자·안내 표시를 생략한다.
   */
  setClean(on) {
    this.clean = on;
    document.body.classList.toggle('clean', on);
    if (on) this.ui.showStart(false);
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
      // 카메라로 놀다가 '마우스로 연습하기'를 고르거나 그 반대면, 깨끗하게 다시 시작한다.
      // (카메라가 안 돼서 연습 모드로 온 경우에는 카드를 눌러도 연습 모드 안에서 놀이만 바꾼다)
      if (!!sim !== this.isSim && !(this._simFallback && !sim)) {
        this._relaunch({ sim, modeId: modeId || this.modeDef?.id });
        return;
      }
      this.ui.showStart(false);
      if (modeId) this.switchMode(modeId);
      return;
    }
    // 준비 중에 또 누르면(카드를 두 번, 다른 카드) 카메라를 두 번 켜지 않고 고른 놀이만 기억한다.
    if (this._starting) {
      if (modeId) this._pendingMode = modeId;
      return;
    }
    this._starting = true;
    this._pendingMode = null;
    document.body.classList.add('loading');
    this.sound.unlock();
    this.ui.hideError();
    this.ui.showStart(false);
    const def = MODES.find((m) => m.id === modeId) || MODES[0];

    if (sim) {
      this._startSim();
    } else {
      // 카메라 허락 창이나 모델 내려받기가 끝나지 않을 때를 위한 탈출구
      const escape = { label: '기다리기 힘들면: 마우스로 연습하기 🖱️', onClick: () => this._relaunch({ sim: true, modeId: this._pendingMode || def.id }) };
      this.ui.showStatus('카메라를 켜고 있어요… 📷', escape);
      try {
        const { audioStream } = await openCamera(this.video, { audio: true });
        this.source = this.video;
        this.viewport.mirror = true;
        this._audioStream = audioStream;
        if (audioStream && this.sound.ctx) {
          this.mic = new BlowDetector(this.sound.ctx, this.sound);
          this.mic.attach(audioStream);
        }
        for (const track of this.video.srcObject?.getVideoTracks?.() || []) {
          track.addEventListener('ended', () => this._cameraLost(), { once: true });
        }
      } catch (e) {
        this._starting = false;
        document.body.classList.remove('loading');
        this._cameraError(e, this._pendingMode || def.id);
        return;
      }
      this.ui.showStatus('손을 알아보는 준비를 하고 있어요… ✋', escape);
      try {
        this.tracker = new Tracker(this.viewport, config);
        await this.tracker.initHands();
        this.stats.source = this.tracker.source === 'local' ? '로컬 모델' : 'CDN 모델';
      } catch (e) {
        console.error(e);
        this._starting = false;
        document.body.classList.remove('loading');
        const id = this._pendingMode || def.id;
        this.ui.showError({
          title: '손 인식 준비에 실패했어요 😢',
          message: '인터넷 연결을 확인해 주세요. 오프라인 전시라면 README 의 "오프라인 준비"를 따라 해 주세요.',
          actions: [
            { label: '다시 시도', onClick: () => location.reload() },
            { label: '마우스로 연습하기', onClick: () => this._fallbackToSim(id) },
          ],
        });
        return;
      }
      this.ui.showStatus(null);
    }
    this._starting = false;
    document.body.classList.remove('loading');
    this.started = true;
    this.switchMode(this._pendingMode || def.id);
    this._pendingMode = null;
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this.frame);
    }
  }

  /** 카메라 ↔ 연습 모드를 바꿀 때는 페이지를 새로 연다 (카메라·인식기·마이크를 깔끔하게 정리하는 가장 확실한 방법). */
  _relaunch({ sim, modeId }) {
    const u = new URL(location.href);
    u.searchParams.delete('sim');
    u.searchParams.delete('autostart');
    u.searchParams.set(sim ? 'sim' : 'autostart', '');
    if (modeId) u.searchParams.set('mode', modeId);
    location.assign(u);
  }

  /** 놀이 중에 카메라 연결이 끊겼을 때 */
  _cameraLost() {
    if (this.sim) return;
    this.ui.showError({
      title: '카메라 연결이 끊겼어요 📷',
      message: '카메라 선이 잘 꽂혀 있는지 확인한 뒤 다시 시도해 주세요.',
      actions: [{ label: '다시 시도', onClick: () => this._relaunch({ sim: false, modeId: this.modeDef?.id }) }],
    });
  }

  /** 카메라·마이크를 끈다 (연습 모드로 바꿀 때) */
  _stopCamera() {
    for (const t of this.video.srcObject?.getTracks?.() || []) t.stop();
    this.video.srcObject = null;
    for (const t of this._audioStream?.getTracks?.() || []) t.stop();
    this._audioStream = null;
    this.mic = null;
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
    this._simFallback = true;
    this.tracker = null;
    this._stopCamera();
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
      busy: '다른 프로그램(화상회의, 카메라 앱, 다른 브라우저 탭)이 카메라를 쓰고 있어요. 그 프로그램을 닫고 다시 시도해 주세요.',
    };
    this.ui.showError({
      title: '카메라를 켤 수 없어요 📷',
      message: messages[e.code] || `카메라를 켜는 중에 문제가 생겼어요. 카메라 연결을 확인하고 다시 시도해 주세요. (${e.name || 'Error'}: ${e.message})`,
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
      const wantsFace = () => !!this.modeDef?.needs?.face;
      this.tracker
        .initFace()
        .then(() => {
          if (wantsFace()) this.ui.showStatus(null);
        })
        .catch((e) => {
          console.error(e);
          this.ui.showStatus(null);
          if (wantsFace()) this.ui.toast('얼굴 인식을 불러오지 못했어요 😢');
        });
    } else if (this.tracker) {
      // 얼굴 모델을 받는 중에 얼굴이 필요 없는 놀이로 바꾸면 안내를 치운다
      this.ui.showStatus(null);
    }
  }

  showMenu() {
    // 아직 준비 중이면(카메라 허락 창, 모델 내려받는 중) 메뉴로 돌아가지 않는다. 카메라 화면만 모드에는 메뉴가 없다.
    if (!this.started || this.clean) return;
    this.sound.stopAllLoops();
    this.ui.showStart(true);
  }

  get menuOpen() {
    return !this.ui.startEl.hidden;
  }

  // ------------------------------------------------------------------ 매 프레임

  frame(nowMs) {
    requestAnimationFrame(this.frame);
    const t = nowMs / 1000;
    const realDt = this._lastT === null ? 1 / 60 : Math.min(0.25, Math.max(0, t - this._lastT));
    const dt = Math.min(0.05, realDt);
    this._lastT = t;
    this.clock += dt;
    this.frameCount++;
    if (dt > 0) this.stats.fps += (1 / dt - this.stats.fps) * 0.05;

    // 처음 화면(메뉴)이 떠 있는 동안은 놀이를 멈춘다 (소리·인식도 쉬게)
    if (this.menuOpen) return;

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
        // 인식이 느린 컴퓨터에서는 얼굴은 한 프레임 걸러 한 번만 본다 (손은 매번)
        const slow = this.stats.detectMs > 22;
        const face = needFace && (!slow || this._detectCount++ % 2 === 0);
        try {
          det = this.tracker.detect(this.video, nowMs, { face });
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
      const m = this.sim.mic;
      const strength = m.blowing ? m.strength ?? 0.8 : 0;
      mic = { enabled: m.enabled ?? true, level: m.level ?? strength, blowing: !!m.blowing, strength };
    } else if (this.mic) {
      mic = this.mic.update(dt).state;
    } else {
      mic = { enabled: false, level: 0, blowing: false, strength: 0 };
    }

    const frame = { t, dt, realDt, frame: this.frameCount, width: this.width, height: this.height, hands: this.hands, faces: this.faces, mic };

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
    // 카메라 영상은 720p 라서 무대를 기기 해상도 그대로(2배) 그려도 더 선명해지지 않는다
    this.stage.resize(this.width, this.height, Math.min(this.dpr, 1.5));
    this.mode?.resize?.(this.width, this.height);
  }

  /** 다음/이전 놀이 (step = 1 / -1) */
  cycleMode(step) {
    const i = MODES.findIndex((m) => m.id === this.modeDef?.id);
    this.switchMode(MODES[(i + step + MODES.length) % MODES.length].id);
  }

  _onKey(e) {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= MODES.length && !e.shiftKey) this.switchMode(MODES[n - 1].id);
    // 화살표·PageUp/PageDown: 발표용 리모컨(클리커)으로도 놀이를 넘길 수 있다
    else if (e.code === 'ArrowRight' || e.code === 'PageDown') this.cycleMode(1);
    else if (e.code === 'ArrowLeft' || e.code === 'PageUp') this.cycleMode(-1);
    else if (e.code === 'KeyU') this.setClean(!this.clean);
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
