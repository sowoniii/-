// 효과음. 파일 없이 Web Audio 로 즉석에서 만든다.

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._noise = null;
    this._loops = new Map();
    /** 잡음 같은 소리가 끝나는 시각 (ctx 시간). 마이크가 우리 소리를 입김으로 착각하지 않게 알려 준다. */
    this.noiseUntil = 0;
  }

  /** 사용자 클릭/터치 안에서 호출해야 소리가 난다 (브라우저 정책). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.6;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
    }
    // 'suspended'(아직 안 누름)뿐 아니라 사파리의 'interrupted'(전화·다른 앱) 상태에서도 다시 켠다
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.05);
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  _noiseBuffer() {
    if (!this._noise) {
      const len = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noise = buf;
    }
    return this._noise;
  }

  _env(gainNode, t, attack, peak, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /** 짧은 음 하나. */
  tone({ type = 'sine', freq = 440, to = null, dur = 0.15, gain = 0.3, delay = 0, attack = 0.005 } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    this._env(g, t, attack, gain, dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  /** 걸러낸 잡음 한 번. */
  noise({ freq = 1200, q = 1, dur = 0.12, gain = 0.3, type = 'bandpass', delay = 0, sweepTo = null } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer();
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    this._env(g, t, 0.004, gain, dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
    this.noiseUntil = Math.max(this.noiseUntil, t + dur + 0.05);
  }

  /** 지금 스피커로 잡음 같은 소리(팡, 휘익, 바람 소리 등)가 나오고 있는지 */
  get playingNoise() {
    if (!this.ctx) return false;
    if (this.ctx.currentTime < this.noiseUntil) return true;
    for (const l of this._loops.values()) if (l.filter) return true;
    return false;
  }

  /** 비눗방울 터지는 소리. pitch 1 = 보통, 클수록 작은 방울 */
  pop(pitch = 1) {
    this.noise({ freq: 2500 * pitch, q: 2, dur: 0.06, gain: 0.35 });
    this.tone({ type: 'sine', freq: 900 * pitch, to: 300 * pitch, dur: 0.08, gain: 0.25 });
  }

  /** 반짝반짝 */
  sparkle() {
    [0, 0.06, 0.12, 0.18].forEach((d, i) => this.tone({ type: 'triangle', freq: 1320 * Math.pow(1.26, i), dur: 0.18, gain: 0.12, delay: d }));
  }

  /** 띠용~ 스프링 */
  boing(pitch = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(220 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(140 * pitch, t + 0.5);
    lfo.frequency.setValueAtTime(14, t);
    lfoGain.gain.setValueAtTime(60 * pitch, t);
    lfoGain.gain.exponentialRampToValueAtTime(1, t + 0.5);
    lfo.connect(lfoGain).connect(o.frequency);
    this._env(g, t, 0.01, 0.3, 0.5);
    o.connect(g).connect(this.master);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.6);
    lfo.stop(t + 0.6);
  }

  /** 뾱 (무언가 나타날 때) */
  pip(pitch = 1) {
    this.tone({ type: 'sine', freq: 500 * pitch, to: 1100 * pitch, dur: 0.12, gain: 0.25 });
  }

  /** 휘익 */
  whoosh(dur = 0.35) {
    this.noise({ freq: 400, sweepTo: 2400, q: 0.8, dur, gain: 0.2 });
  }

  /** 맑은 종소리 */
  chime() {
    [0, 0.09].forEach((d, i) => {
      this.tone({ type: 'sine', freq: i ? 1568 : 1046, dur: 0.6, gain: 0.15, delay: d });
      this.tone({ type: 'sine', freq: (i ? 1568 : 1046) * 2.01, dur: 0.3, gain: 0.04, delay: d });
    });
  }

  /** 끽 (뽀드득) */
  squeak(pitch = 1) {
    this.tone({ type: 'triangle', freq: 700 * pitch, to: 1400 * pitch, dur: 0.07, gain: 0.12 });
  }

  /**
   * 계속 이어지는 소리 (늘어나는 고무, 바람 소리 등). 같은 id 로 다시 부르면 값만 바뀐다.
   * @param {string} id
   * @param {{type?:'sine'|'triangle'|'sawtooth'|'square'|'noise', freq?:number, gain?:number, q?:number}} o
   */
  loop(id, { type = 'sine', freq = 200, gain = 0.1, q = 1 } = {}) {
    if (!this.ready) return;
    let l = this._loops.get(id);
    const t = this.ctx.currentTime;
    if (!l) {
      const g = this.ctx.createGain();
      g.gain.value = 0.0001;
      let node;
      let filter = null;
      if (type === 'noise') {
        node = this.ctx.createBufferSource();
        node.buffer = this._noiseBuffer();
        node.loop = true;
        filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = q;
        node.connect(filter).connect(g);
      } else {
        node = this.ctx.createOscillator();
        node.type = type;
        node.connect(g);
      }
      g.connect(this.master);
      node.start();
      l = { node, g, filter };
      this._loops.set(id, l);
    }
    if (l.filter) l.filter.frequency.setTargetAtTime(freq, t, 0.03);
    else l.node.frequency.setTargetAtTime(freq, t, 0.03);
    l.g.gain.setTargetAtTime(Math.max(0.0001, gain), t, 0.05);
  }

  stopLoop(id) {
    const l = this._loops.get(id);
    if (!l) return;
    const t = this.ctx.currentTime;
    l.g.gain.setTargetAtTime(0.0001, t, 0.05);
    l.node.stop(t + 0.3);
    this._loops.delete(id);
  }

  stopAllLoops() {
    for (const id of [...this._loops.keys()]) this.stopLoop(id);
  }
}
