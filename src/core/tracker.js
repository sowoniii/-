// MediaPipe 손/얼굴 인식기 래퍼.
// vendor/ 폴더에 내려받은 파일이 있으면 그것을 쓰고(오프라인 전시용), 없으면 CDN 에서 불러온다.

const MP_VERSION = '0.10.35';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const ASSETS = {
  bundle: { local: './vendor/mediapipe/vision_bundle.mjs', remote: `${CDN}/vision_bundle.mjs` },
  wasm: { local: './vendor/mediapipe/wasm', remote: `${CDN}/wasm` },
  hand: {
    local: './vendor/models/hand_landmarker.task',
    remote: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
  face: {
    local: './vendor/models/face_landmarker.task',
    remote: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
};

/** 상대 경로는 이 파일이 아니라 페이지(index.html) 기준으로 풀어야 한다. */
const abs = (u) => new URL(u, document.baseURI).href;

async function exists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    // 없는 주소에 index.html 을 돌려주는 호스팅(SPA 설정 등)은 200 이어도 진짜 파일이 아니다
    return r.ok && !/text\/html/i.test(r.headers.get('content-type') || '');
  } catch {
    return false;
  }
}

export class Tracker {
  /**
   * @param {import('./viewport.js').Viewport} viewport
   * @param {{numHands?:number, numFaces?:number, delegate?:'GPU'|'CPU'}} [opts]
   */
  constructor(viewport, { numHands = 4, numFaces = 3, delegate = 'GPU' } = {}) {
    this.viewport = viewport;
    this.numHands = numHands;
    this.numFaces = numFaces;
    this.delegate = delegate;
    this.hands = null;
    this.face = null;
    this._facePromise = null;
    this._lastTs = -1;
    this.source = 'cdn';
  }

  async _vision() {
    if (this._visionPromise) return this._visionPromise;
    this._visionPromise = (async () => {
      if (await exists(ASSETS.bundle.local)) {
        try {
          const mod = await import(abs(ASSETS.bundle.local));
          const fileset = await mod.FilesetResolver.forVisionTasks(abs(ASSETS.wasm.local));
          this.source = 'local';
          return { mod, fileset };
        } catch (e) {
          console.warn('vendor/ 의 MediaPipe 를 쓰지 못해 CDN 에서 불러옵니다.', e);
        }
      }
      this.source = 'cdn';
      const mod = await import(ASSETS.bundle.remote);
      const fileset = await mod.FilesetResolver.forVisionTasks(ASSETS.wasm.remote);
      return { mod, fileset };
    })().catch((e) => {
      this._visionPromise = null;
      throw e;
    });
    return this._visionPromise;
  }

  async _model(kind) {
    const a = ASSETS[kind];
    return (await exists(a.local)) ? abs(a.local) : a.remote;
  }

  async _create(Cls, fileset, options) {
    try {
      return await Cls.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: this.delegate } });
    } catch (e) {
      if (this.delegate === 'CPU') throw e;
      console.warn('GPU 로 시작하지 못해 CPU 로 다시 시도합니다.', e);
      return Cls.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
    }
  }

  async initHands() {
    if (this.hands) return;
    const { mod, fileset } = await this._vision();
    this.hands = await this._create(mod.HandLandmarker, fileset, {
      baseOptions: { modelAssetPath: await this._model('hand') },
      runningMode: 'VIDEO',
      numHands: this.numHands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  /** 얼굴 인식기는 필요한 모드에서만 불러온다. */
  initFace() {
    if (!this._facePromise) {
      this._facePromise = (async () => {
        const { mod, fileset } = await this._vision();
        this.face = await this._create(mod.FaceLandmarker, fileset, {
          baseOptions: { modelAssetPath: await this._model('face') },
          runningMode: 'VIDEO',
          numFaces: this.numFaces,
          outputFaceBlendshapes: true,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      })().catch((e) => {
        this._facePromise = null;
        throw e;
      });
    }
    return this._facePromise;
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {number} nowMs performance.now()
   * @param {{face?: boolean}} opts
   * @returns {{hands: {lm:object[], side:string, score:number}[], faces: {lm:object[], blend:object}[] | null}}
   */
  detect(video, nowMs, { face = false } = {}) {
    // MediaPipe 는 타임스탬프가 반드시 증가해야 한다.
    const ts = Math.max(nowMs, this._lastTs + 1);
    this._lastTs = ts;
    const vp = this.viewport;
    const out = { hands: [], faces: null };
    if (this.hands) {
      const r = this.hands.detectForVideo(video, ts);
      for (let i = 0; i < r.landmarks.length; i++) {
        const cat = (r.handedness?.[i] || r.handednesses?.[i] || [])[0];
        // MediaPipe 는 거울 영상을 가정하고 왼손/오른손을 붙인다. 우리는 원본(거울 아님)을 넣으므로 반대로 바꾼다.
        const side = cat ? (cat.categoryName === 'Left' ? 'right' : 'left') : 'right';
        const lms = r.landmarks[i];
        // 손가락 뿌리가 카메라 화면 가장자리에 붙어 있으면 손가락이 화면 밖으로 잘렸을 수 있다
        const clipped = [5, 9, 13, 17].some((k) => lms[k].y < 0.06 || lms[k].x < 0.04 || lms[k].x > 0.96);
        out.hands.push({ lm: lms.map((p) => vp.toScreen(p.x, p.y, p.z)), side, score: cat?.score ?? 1, clipped });
      }
    }
    if (face && this.face) {
      const r = this.face.detectForVideo(video, ts);
      out.faces = r.faceLandmarks.map((lms, i) => {
        const blend = {};
        for (const c of r.faceBlendshapes?.[i]?.categories || []) blend[c.categoryName] = c.score;
        return { lm: lms.map((p) => vp.toScreen(p.x, p.y, p.z)), blend };
      });
    }
    return out;
  }
}
