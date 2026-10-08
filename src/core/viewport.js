// 카메라 영상(원본 좌표)과 화면(CSS px) 사이 변환.
// 영상은 화면을 꽉 채우도록(cover) 확대되고, 거울처럼 좌우가 뒤집혀 보인다.

export class Viewport {
  constructor() {
    this.width = 1; // 화면 CSS px
    this.height = 1;
    this.srcWidth = 1; // 영상 원본 px
    this.srcHeight = 1;
    this.mirror = true;
    this._update();
  }

  resize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this._update();
  }

  setSource(srcWidth, srcHeight, mirror = this.mirror) {
    if (srcWidth === this.srcWidth && srcHeight === this.srcHeight && mirror === this.mirror) return;
    this.srcWidth = Math.max(1, srcWidth);
    this.srcHeight = Math.max(1, srcHeight);
    this.mirror = mirror;
    this._update();
  }

  _update() {
    const s = Math.max(this.width / this.srcWidth, this.height / this.srcHeight);
    this.scale = s;
    this.drawWidth = this.srcWidth * s;
    this.drawHeight = this.srcHeight * s;
    this.offsetX = (this.width - this.drawWidth) / 2;
    this.offsetY = (this.height - this.drawHeight) / 2;
  }

  /** MediaPipe 정규화 좌표(0..1, 원본 기준) → 화면 px. z 는 영상 너비 기준 px 로 바꾼다. */
  toScreen(nx, ny, nz = 0) {
    const u = this.mirror ? 1 - nx : nx;
    return {
      x: this.offsetX + u * this.drawWidth,
      y: this.offsetY + ny * this.drawHeight,
      z: nz * this.drawWidth,
    };
  }

  /** 화면 px → 영상 텍스처 좌표 (0..1, 원본 기준) */
  toTexture(sx, sy) {
    const u = (sx - this.offsetX) / this.drawWidth;
    return { u: this.mirror ? 1 - u : u, v: (sy - this.offsetY) / this.drawHeight };
  }

  /**
   * 2D 캔버스에 화면과 똑같이 보이도록(거울 + cover) 영상을 그린다.
   * w, h 는 대상 캔버스 크기 — 화면 크기와 다르면 비율대로 축소/확대된다 (흐림 효과용 작은 캔버스 등).
   */
  drawSource(ctx, source, w = this.width, h = this.height) {
    if (!source) return;
    const k = w / this.width;
    const ky = h / this.height;
    ctx.save();
    if (this.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    // 거울일 때 offsetX 는 오른쪽 기준이 되므로 대칭이라 그대로 써도 된다 (cover 는 가운데 정렬).
    ctx.drawImage(source, this.offsetX * k, this.offsetY * ky, this.drawWidth * k, this.drawHeight * ky);
    ctx.restore();
  }
}
