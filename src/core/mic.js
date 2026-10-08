// 마이크로 '후~' 입김 소리를 감지한다.
// 입김은 넓은 대역의 바람 소리(잡음)처럼 들리고, 특히 낮은 주파수 에너지가 크다.
// 주변 소음 크기를 계속 따라가며(적응형 바닥값) 그보다 충분히 클 때만 반응한다.

import { clamp } from './math.js';

/**
 * 순수 판별 함수 (테스트용). 스펙트럼(dB 배열)으로 입김 후보인지와 세기를 계산한다.
 * @param {Float32Array|number[]} db  getFloatFrequencyData 결과
 * @param {number} sampleRate
 * @param {number} floorDb 적응형 소음 바닥값
 */
export function analyzeSpectrum(db, sampleRate, floorDb) {
  const binHz = sampleRate / 2 / db.length;
  let total = 0;
  let low = 0;
  let logSum = 0;
  let linSum = 0;
  let flatCount = 0;
  for (let i = 1; i < db.length; i++) {
    const hz = i * binHz;
    if (hz > 8000) break;
    const p = Math.pow(10, Math.max(-140, db[i]) / 10);
    total += p;
    if (hz < 600) low += p;
    if (hz > 150 && hz < 4000) {
      logSum += Math.log(p + 1e-20);
      linSum += p;
      flatCount++;
    }
  }
  const levelDb = 10 * Math.log10(total + 1e-20);
  const lowRatio = total > 0 ? low / total : 0;
  const flatness = flatCount ? Math.exp(logSum / flatCount) / (linSum / flatCount + 1e-20) : 0;
  const above = levelDb - floorDb;
  const candidate = above > 14 && (lowRatio > 0.5 || flatness > 0.22);
  const strength = candidate ? clamp((above - 12) / 24) : 0;
  return { levelDb, lowRatio, flatness, above, candidate, strength };
}

export class BlowDetector {
  /**
   * @param {AudioContext} ctx
   * @param {{playingNoise:boolean}} [sound] 앱 효과음. 잡음 같은 효과음이 나는 동안은 입김으로 치지 않는다
   *   (반향 제거를 꺼 두었으므로 스피커 소리가 그대로 마이크에 들어온다).
   */
  constructor(ctx, sound = null) {
    this.ctx = ctx;
    this.sound = sound;
    this.candidate = false;
    this.flatness = 0;
    this.analyser = null;
    this.data = null;
    this.floorDb = null; // 첫 측정값으로 맞춘다
    this._age = 0;
    this.level = 0; // 0..1 화면 표시용 음량
    this.strength = 0; // 0..1 입김 세기 (부드럽게)
    this.blowing = false;
    this._candTime = 0;
    this._quietTime = 0;
    this.enabled = false;
  }

  /** @param {MediaStream} stream */
  attach(stream) {
    if (!stream || !this.ctx) return;
    const src = this.ctx.createMediaStreamSource(stream);
    // 소스 노드를 붙잡아 두지 않으면, AudioContext 가 잠든(suspended) 사이 브라우저가 지워 버려 마이크가 영영 조용해진다
    this.source = src;
    this.stream = stream;
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.2;
    src.connect(an);
    this.analyser = an;
    this.data = new Float32Array(an.frequencyBinCount);
    this.enabled = true;
  }

  /** 매 프레임 호출 */
  update(dt) {
    if (!this.analyser) return this;
    // 사용자가 화면을 한 번 누르기 전(자동 시작)에는 AudioContext 가 잠들어 있다: 그동안은 아무것도 재지 않는다
    if (this.ctx.state && this.ctx.state !== 'running') return this;
    this.analyser.getFloatFrequencyData(this.data);
    if (this.floorDb === null) {
      // 아직 소리 데이터가 없으면(-Infinity) 기다린다 — 무음으로 바닥값을 잡으면 방 소음이 입김으로 들린다
      let any = false;
      for (let i = 1; i < this.data.length && !any; i++) any = Number.isFinite(this.data[i]) && this.data[i] > -139;
      if (!any) return this;
      this.floorDb = analyzeSpectrum(this.data, this.ctx.sampleRate, 0).levelDb;
    }
    this._age += dt;
    const a = analyzeSpectrum(this.data, this.ctx.sampleRate, this.floorDb);
    // 바닥값: 조용해지면 빠르게 내려가고, 시끄러운 상태가 오래 가면 아주 천천히 올라간다.
    // 처음 2초는 주변 소음에 빨리 맞추는 '보정' 시간이다.
    if (Number.isFinite(a.levelDb)) {
      const riseRate = this._age < 2 ? 20 : 1.5;
      if (a.levelDb < this.floorDb) this.floorDb += (a.levelDb - this.floorDb) * Math.min(1, dt * 4);
      else this.floorDb += Math.min(a.levelDb - this.floorDb, riseRate * dt);
    }
    if (this._age < 2) {
      this.level = 0;
      return this;
    }
    this.level = clamp((a.levelDb - this.floorDb) / 40);
    this.flatness = a.flatness;
    this.candidate = a.candidate && !this.sound?.playingNoise;
    if (this.candidate) {
      this._candTime += dt;
      this._quietTime = 0;
    } else {
      this._quietTime += dt;
      if (this._quietTime > 0.25) this._candTime = 0;
    }
    if (!this.blowing && this._candTime > 0.12) this.blowing = true;
    if (this.blowing && this._quietTime > 0.25) this.blowing = false;
    const target = this.blowing ? Math.max(a.strength, 0.25) : 0;
    this.strength += (target - this.strength) * Math.min(1, dt * (target > this.strength ? 12 : 4));
    return this;
  }

  get state() {
    return { enabled: this.enabled, level: this.level, blowing: this.blowing, strength: this.strength, candidate: this.candidate, flatness: this.flatness };
  }
}
