// WebGL 무대: 카메라 영상을 '말랑한 격자(mesh)' 위에 그린다.
//
// - grid.offset 을 바꾸면 화면이 고무판처럼 늘어나고 일그러진다 (화면 잡아당기기 모드).
// - drawPatch() 로 영상의 일부를 원하는 모양으로 옮겨 그릴 수 있다 (손가락 늘리기 모드).
//
// 모든 좌표는 화면 CSS px 이다. 'src' 좌표는 "일그러지지 않은 화면에서 그 점에 보이던 영상"을 뜻한다.

const VS = `
attribute vec2 a_pos;
attribute vec2 a_src;
attribute float a_alpha;
uniform vec2 u_screen;
uniform vec4 u_map;
uniform float u_mirror;
varying vec2 v_uv;
varying float v_alpha;
void main() {
  vec2 clip = a_pos / u_screen * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float u = (a_src.x - u_map.x) / u_map.z;
  if (u_mirror > 0.5) u = 1.0 - u;
  v_uv = vec2(u, (a_src.y - u_map.y) / u_map.w);
  v_alpha = a_alpha;
}`;

const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_hasTex;
uniform float u_opacity;
uniform vec4 u_tint;
varying vec2 v_uv;
varying float v_alpha;
void main() {
  // 영상 바깥을 가져오면 가장자리 줄무늬 대신 거울처럼 접힌 영상을 보여 준다 (-1..2 범위)
  vec2 uv = 1.0 - abs(1.0 - abs(v_uv));
  vec4 c = u_hasTex > 0.5 ? texture2D(u_tex, clamp(uv, 0.0, 1.0)) : vec4(0.12, 0.13, 0.2, 1.0);
  c.rgb = mix(c.rgb, u_tint.rgb, u_tint.a);
  gl_FragColor = vec4(c.rgb, v_alpha * u_opacity);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader error');
  return sh;
}

/**
 * 변형 가능한 격자. 정점 (i, j) 의 번호는 j * (cols + 1) + i.
 * rest[k*2], rest[k*2+1] : 원래 위치 (화면 px, 화면 바깥 여백 포함)
 * offset[k*2], offset[k*2+1] : 원래 위치에서 얼마나 밀려났는지 (px). 모드가 직접 바꾼다.
 */
export class WarpGrid {
  constructor(width, height, { cells = 56, marginRatio = 0.15 } = {}) {
    const m = Math.max(width, height) * marginRatio;
    const aspect = (width + 2 * m) / (height + 2 * m);
    this.cols = aspect >= 1 ? cells : Math.max(8, Math.round(cells * aspect));
    this.rows = aspect >= 1 ? Math.max(8, Math.round(cells / aspect)) : cells;
    this.margin = m;
    this.x0 = -m;
    this.y0 = -m;
    this.cellW = (width + 2 * m) / this.cols;
    this.cellH = (height + 2 * m) / this.rows;
    const n = (this.cols + 1) * (this.rows + 1);
    this.count = n;
    this.rest = new Float32Array(n * 2);
    this.offset = new Float32Array(n * 2);
    this.positions = new Float32Array(n * 2);
    for (let j = 0; j <= this.rows; j++) {
      for (let i = 0; i <= this.cols; i++) {
        const k = j * (this.cols + 1) + i;
        this.rest[k * 2] = this.x0 + i * this.cellW;
        this.rest[k * 2 + 1] = this.y0 + j * this.cellH;
      }
    }
    const idx = [];
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const a = j * (this.cols + 1) + i;
        const b = a + 1;
        const c = a + this.cols + 1;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    this.indices = new Uint16Array(idx);
  }
  index(i, j) {
    return j * (this.cols + 1) + i;
  }
  reset() {
    this.offset.fill(0);
  }
  /** 변형이 하나라도 남아 있는지 */
  isDeformed(eps = 0.05) {
    for (let k = 0; k < this.offset.length; k++) if (Math.abs(this.offset[k]) > eps) return true;
    return false;
  }
}

export class Stage {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.patches = [];
    /** 화면 전체에 섞을 색 [r, g, b, 섞는 정도] (0..1) */
    this.tint = [0, 0, 0, 0];
    this.grid = new WarpGrid(1, 1);
    this.ok = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ok = false;
    });
    canvas.addEventListener('webglcontextrestored', () => this._init());
    this._init();
  }

  _init() {
    // 격자 안쪽 모서리와 가장자리를 흐리게 처리한 조각만 그리므로 MSAA·깊이 버퍼는 필요 없다 (고해상도 화면에서 GPU 부담만 커진다)
    const gl = this.canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      this.ok = false;
      return;
    }
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link error');
    this.prog = prog;
    this.loc = {
      pos: gl.getAttribLocation(prog, 'a_pos'),
      src: gl.getAttribLocation(prog, 'a_src'),
      alpha: gl.getAttribLocation(prog, 'a_alpha'),
      screen: gl.getUniformLocation(prog, 'u_screen'),
      map: gl.getUniformLocation(prog, 'u_map'),
      mirror: gl.getUniformLocation(prog, 'u_mirror'),
      tex: gl.getUniformLocation(prog, 'u_tex'),
      hasTex: gl.getUniformLocation(prog, 'u_hasTex'),
      opacity: gl.getUniformLocation(prog, 'u_opacity'),
      tint: gl.getUniformLocation(prog, 'u_tint'),
    };
    this.buf = { pos: gl.createBuffer(), src: gl.createBuffer(), alpha: gl.createBuffer(), idx: gl.createBuffer() };
    this.gridBuf = { pos: gl.createBuffer(), src: gl.createBuffer(), alpha: gl.createBuffer(), idx: gl.createBuffer() };
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 22, 40, 255]));
    this.hasTex = false;
    this.ok = true;
    this._uploadGridStatic();
  }

  /** 화면 크기가 바뀌면 호출. 격자는 새로 만들어진다. */
  resize(width, height, dpr = Math.min(window.devicePixelRatio || 1, 2)) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.grid = new WarpGrid(width, height);
    if (this.ok) this._uploadGridStatic();
  }

  _uploadGridStatic() {
    const gl = this.gl;
    const g = this.grid;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf.src);
    gl.bufferData(gl.ARRAY_BUFFER, g.rest, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf.alpha);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.count).fill(1), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gridBuf.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
  }

  /**
   * 이번 프레임에 영상 조각을 하나 더 그린다 (격자 위에 덮어 그림).
   * @param {object} p
   * @param {ArrayLike<number>} p.pos   정점 위치 [x0,y0, x1,y1, ...] 화면 px
   * @param {ArrayLike<number>} p.src   정점이 가져올 영상 위치 [x0,y0, ...] (일그러지기 전 화면 px)
   * @param {ArrayLike<number>} [p.alpha] 정점별 투명도 0..1 (가장자리를 부드럽게)
   * @param {ArrayLike<number>} [p.indices] 삼각형 정점 번호. 없으면 3개씩 순서대로.
   * @param {number} [p.opacity=1]
   * @param {number[]} [p.tint] [r,g,b,a] 섞을 색
   */
  drawPatch(p) {
    this.patches.push(p);
  }

  /**
   * @param {HTMLVideoElement|HTMLCanvasElement|null} source
   * @param {import('./viewport.js').Viewport} viewport
   */
  render(source, viewport) {
    if (!this.ok) {
      this.patches.length = 0;
      return;
    }
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.07, 0.08, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (source && isReady(source)) {
      try {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        this.hasTex = true;
      } catch {
        // 영상이 아직 준비되지 않았으면 이전 프레임을 그대로 사용
      }
    }
    gl.uniform1i(this.loc.tex, 0);
    gl.uniform1f(this.loc.hasTex, this.hasTex ? 1 : 0);
    gl.uniform2f(this.loc.screen, this.width, this.height);
    gl.uniform4f(this.loc.map, viewport.offsetX, viewport.offsetY, viewport.drawWidth, viewport.drawHeight);
    gl.uniform1f(this.loc.mirror, viewport.mirror ? 1 : 0);

    // 1) 격자
    const g = this.grid;
    for (let k = 0; k < g.positions.length; k++) g.positions[k] = g.rest[k] + g.offset[k];
    gl.disable(gl.BLEND);
    gl.uniform1f(this.loc.opacity, 1);
    gl.uniform4fv(this.loc.tint, this.tint);
    this._bindAttrib(this.gridBuf.pos, this.loc.pos, 2, g.positions, gl.DYNAMIC_DRAW);
    this._bindAttrib(this.gridBuf.src, this.loc.src, 2);
    this._bindAttrib(this.gridBuf.alpha, this.loc.alpha, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gridBuf.idx);
    gl.drawElements(gl.TRIANGLES, g.indices.length, gl.UNSIGNED_SHORT, 0);

    // 2) 조각들
    if (this.patches.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const p of this.patches) this._drawPatch(p);
      this.patches.length = 0;
    }
  }

  _drawPatch(p) {
    const gl = this.gl;
    const n = p.pos.length / 2;
    if (n < 3) return;
    const pos = p.pos instanceof Float32Array ? p.pos : new Float32Array(p.pos);
    const src = p.src instanceof Float32Array ? p.src : new Float32Array(p.src);
    const alpha = p.alpha ? (p.alpha instanceof Float32Array ? p.alpha : new Float32Array(p.alpha)) : new Float32Array(n).fill(1);
    gl.uniform1f(this.loc.opacity, p.opacity ?? 1);
    gl.uniform4fv(this.loc.tint, p.tint || [0, 0, 0, 0]);
    this._bindAttrib(this.buf.pos, this.loc.pos, 2, pos, gl.STREAM_DRAW);
    this._bindAttrib(this.buf.src, this.loc.src, 2, src, gl.STREAM_DRAW);
    this._bindAttrib(this.buf.alpha, this.loc.alpha, 1, alpha, gl.STREAM_DRAW);
    if (p.indices) {
      const idx = p.indices instanceof Uint16Array ? p.indices : new Uint16Array(p.indices);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STREAM_DRAW);
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, n - (n % 3));
    }
  }

  _bindAttrib(buffer, loc, size, data, usage) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (data) gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
}

function isReady(source) {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return source.readyState >= 2 && source.videoWidth > 0;
  }
  return source.width > 0 && source.height > 0;
}

/** 영상 원본 크기 */
export function sourceSize(source) {
  if (!source) return { w: 0, h: 0 };
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { w: source.videoWidth, h: source.videoHeight };
  }
  return { w: source.width, h: source.height };
}

export { isReady as isSourceReady };
