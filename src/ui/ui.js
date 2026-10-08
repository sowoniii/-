// 화면 위 UI: 시작 화면, 아래쪽 놀이 선택 막대, 안내 말풍선, 알림, 로딩/오류 화면.
// 손가락으로 버튼을 가리키고 잠시 기다리면 선택되는 '머무르기 선택'도 여기서 처리한다.

const DWELL_SECONDS = 1.5;
const NO_HAND_HINT_AFTER = 4;

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) e.style.setProperty(sk, sv);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

export class UI {
  /**
   * @param {import('../main.js').App} app
   * @param {object[]} modes
   */
  constructor(app, modes) {
    this.app = app;
    this.modes = modes;
    this.$ = (id) => document.getElementById(id);
    this.hintEl = this.$('hint');
    this.toastEl = this.$('toast');
    this.barEl = this.$('modebar');
    this.statusEl = this.$('status');
    this.noHandEl = this.$('nohand');
    this.startEl = this.$('start');
    this.errorEl = this.$('error');
    this.defaultHint = '';
    this.customHint = null;
    this._toastTimer = null;
    this._dwell = new Map();
    this._noHandTime = 0;
    this._buildStart();
    this._buildBar();
    this._buildTopButtons();
  }

  _buildStart() {
    const grid = this.$('cards');
    for (const m of this.modes) {
      grid.append(
        el('button', { class: 'card', style: { '--c': m.color }, onclick: () => this.app.start({ modeId: m.id }) }, [
          el('span', { class: 'card-emoji', text: m.emoji }),
          el('span', { class: 'card-title', text: m.title }),
          el('span', { class: 'card-desc', text: m.description }),
        ]),
      );
    }
    this.$('practice').addEventListener('click', () => this.app.start({ sim: true }));
  }

  _buildBar() {
    this.buttons = new Map();
    for (const m of this.modes) {
      // 지금 하고 있는 놀이 버튼을 또 눌러도 처음부터 다시 시작하지 않는다 (숫자 키는 직원용 초기화로 남겨 둔다)
      const pick = () => {
        if (this.app.modeDef?.id !== m.id) this.app.switchMode(m.id);
      };
      const b = el('button', { class: 'mode-btn', title: m.title, style: { '--c': m.color }, onclick: pick }, [
        el('span', { class: 'mode-emoji', text: m.emoji }),
        el('span', { class: 'mode-label', text: m.title }),
      ]);
      this.buttons.set(m.id, b);
      this.barEl.append(b);
    }
  }

  _buildTopButtons() {
    this.$('btn-home').addEventListener('click', () => this.app.showMenu());
    const mute = this.$('btn-mute');
    const sync = () => (mute.textContent = this.app.sound.muted ? '🔇' : '🔊');
    sync();
    mute.addEventListener('click', () => {
      this.app.sound.setMuted(!this.app.sound.muted);
      sync();
    });
    this._syncMute = sync;
    this.$('btn-full').addEventListener('click', () => this.toggleFullscreen());
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  syncMute() {
    this._syncMute?.();
  }

  showStart(show) {
    this.startEl.hidden = !show;
    document.body.classList.toggle('playing', !show);
  }

  setActive(mode) {
    for (const [id, b] of this.buttons) b.classList.toggle('active', id === mode.id);
    this.defaultHint = mode.hint;
    this.customHint = null;
    this._renderHint();
    document.documentElement.style.setProperty('--mode-color', mode.color);
  }

  /** 모드가 안내 문구를 바꾼다. null 이면 기본 문구로 돌아간다. */
  hint(text) {
    if (text === this.customHint) return;
    this.customHint = text;
    this._renderHint();
  }

  _renderHint() {
    const text = this.customHint ?? this.defaultHint;
    if (this.hintEl.textContent !== text) {
      this.hintEl.textContent = text;
      this.hintEl.classList.remove('pop');
      void this.hintEl.offsetWidth;
      this.hintEl.classList.add('pop');
    }
    this.hintEl.hidden = !text;
  }

  /**
   * 큰 글씨로 잠깐 보여준다. 기본은 화면 가운데.
   * @param {string} text
   * @param {number} [ms=1600]
   * @param {{x?:number, y?:number, position?:'center'|'top'|'bottom'}} [opts]
   *   얼굴·손을 가리지 않게 위치를 고를 수 있다. x, y 는 화면 px (글자 가운데).
   */
  toast(text, ms = 1600, opts = {}) {
    const st = this.toastEl.style;
    const pos = { center: '42%', top: '24%', bottom: '70%' }[opts.position] || null;
    st.left = opts.x != null ? `${Math.round(opts.x)}px` : '';
    st.top = opts.y != null ? `${Math.round(opts.y)}px` : pos || '';
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  showStatus(text) {
    this.statusEl.hidden = !text;
    this.statusEl.querySelector('.status-text').textContent = text || '';
  }

  /**
   * @param {{title:string, message:string, actions?: {label:string, onClick:()=>void}[]}} e
   */
  showError({ title, message, actions = [] }) {
    this.showStatus(null);
    this.errorEl.hidden = false;
    this.errorEl.querySelector('.error-title').textContent = title;
    this.errorEl.querySelector('.error-message').textContent = message;
    const box = this.errorEl.querySelector('.error-actions');
    box.replaceChildren(
      ...actions.map((a) =>
        el('button', {
          class: 'big-btn',
          text: a.label,
          onclick: () => {
            this.errorEl.hidden = true;
            a.onClick();
          },
        }),
      ),
    );
  }

  hideError() {
    this.errorEl.hidden = true;
  }

  /** 매 프레임: 손 안내, 손가락 머무르기 선택 */
  update(frame) {
    const live = frame.hands.filter((h) => !h.stale);
    // 얼굴이 보이면 놀이 자체 안내가 코치하므로 '손을 보여 주세요' 는 띄우지 않는다.
    const someone = live.length > 0 || frame.faces.length > 0;
    this._noHandTime = someone ? 0 : this._noHandTime + frame.dt;
    this.noHandEl.classList.toggle('show', this._noHandTime > NO_HAND_HINT_AFTER);

    // 아래 버튼을 검지로 가리키고 기다리면 선택
    // 그림 그리듯 지나가는 손가락은 무시하고, 버튼 위에 멈춰 있는 손가락만 센다.
    const hovered = new Set();
    for (const h of live) {
      if (h.pose !== 'point') continue;
      if (Math.hypot(h.velocity.x, h.velocity.y) > h.size * 1.5) continue;
      const tip = h.lm[8];
      for (const [id, b] of this.buttons) {
        if (b.classList.contains('active')) continue;
        const r = b.getBoundingClientRect();
        if (tip.x > r.left - 8 && tip.x < r.right + 8 && tip.y > r.top - 8 && tip.y < r.bottom + 8) hovered.add(id);
      }
    }
    for (const [id, b] of this.buttons) {
      let v = this._dwell.get(id) || 0;
      v = hovered.has(id) ? v + frame.dt / DWELL_SECONDS : Math.max(0, v - frame.dt * 2);
      if (v >= 1) {
        v = 0;
        this.app.switchMode(id);
      }
      this._dwell.set(id, v);
      b.style.setProperty('--dwell', v.toFixed(3));
    }
  }
}
