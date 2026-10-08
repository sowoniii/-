// One Euro 필터: 손이 가만히 있을 땐 떨림을 강하게 줄이고, 빠르게 움직일 땐 지연을 줄인다.
// https://gery.casiez.net/1euro/

function smoothingFactor(cutoff, dt) {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.012, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
  }
  filter(value, dt) {
    if (this.x === null || !(dt > 0)) {
      this.x = value;
      this.dx = 0;
      return value;
    }
    const rawDx = (value - this.x) / dt;
    this.dx += smoothingFactor(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** {x,y,z} 점 배열 전체를 필터링한다. */
export class PointsFilter {
  constructor(count, opts) {
    this.filters = Array.from({ length: count * 3 }, () => new OneEuroFilter(opts));
  }
  filter(points, dt) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      out[i] = {
        x: this.filters[i * 3].filter(p.x, dt),
        y: this.filters[i * 3 + 1].filter(p.y, dt),
        z: this.filters[i * 3 + 2].filter(p.z || 0, dt),
      };
    }
    return out;
  }
  reset() {
    for (const f of this.filters) f.reset();
  }
}
