// 가짜(합성) 손·얼굴 랜드마크 생성기.
// 카메라 없이 마우스로 연습하는 '연습 모드'와 자동 테스트에서 사용한다.
// MediaPipe 와 같은 21점 손 / 478점 얼굴 형식을 화면 px 좌표로 만들어 준다. DOM 의존성 없음.

const D2R = Math.PI / 180;

// 오른손, 손바닥이 화면을 향하고 손가락이 위로 향한 자세의 로컬 좌표.
// 단위: 손목→중지 뿌리 = 1. x 는 화면 오른쪽(새끼 쪽), y 는 위쪽, z 는 음수일수록 카메라 쪽.
const MCP = [null, [-0.3, 0.95], [0, 1.0], [0.27, 0.93], [0.5, 0.8]];
const SEG = [null, [0.45, 0.27, 0.22], [0.5, 0.3, 0.24], [0.46, 0.28, 0.22], [0.36, 0.22, 0.2]];

const STRAIGHT = [4, 4, 3];
const CURLED = [80, 100, 60];
const RELAXED = [35, 45, 25];

const THUMB = {
  extended: [[-0.2, 0.15, 0], [-0.45, 0.35, -0.05], [-0.7, 0.5, -0.08], [-0.92, 0.62, -0.1]],
  folded: [[-0.2, 0.15, 0], [-0.35, 0.38, -0.12], [-0.28, 0.6, -0.3], [-0.1, 0.72, -0.4]],
  holding: [[-0.2, 0.15, 0], [-0.35, 0.38, -0.12], [-0.15, 0.62, -0.32], [0.12, 0.74, -0.42]],
  relaxed: [[-0.2, 0.15, 0], [-0.42, 0.36, -0.08], [-0.58, 0.55, -0.15], [-0.66, 0.74, -0.2]],
};

/** 손 모양별 [손가락별 (벌림각, 굽힘[3])], 엄지 자세 */
const POSE_TABLE = {
  open: { fingers: [[-10, STRAIGHT], [-2, STRAIGHT], [7, STRAIGHT], [16, STRAIGHT]], thumb: 'extended' },
  fist: { fingers: [[-3, CURLED], [0, CURLED], [3, CURLED], [6, CURLED]], thumb: 'folded' },
  v: { fingers: [[-12, STRAIGHT], [10, STRAIGHT], [3, CURLED], [6, CURLED]], thumb: 'holding' },
  point: { fingers: [[-4, STRAIGHT], [0, CURLED], [3, CURLED], [6, CURLED]], thumb: 'holding' },
  pinch: { fingers: [[-6, [25, 45, 25]], [0, RELAXED], [4, RELAXED], [8, RELAXED]], thumb: 'pinch' },
  other: { fingers: [[-6, RELAXED], [0, RELAXED], [4, RELAXED], [8, RELAXED]], thumb: 'relaxed' },
};

export const SYNTH_POSES = Object.freeze(Object.keys(POSE_TABLE));

function fingerChain(f, spreadDeg, flex) {
  const [bx, by] = MCP[f];
  const phi = spreadDeg * D2R;
  const pts = [[bx, by, 0]];
  let cum = 0;
  let [x, y, z] = [bx, by, 0];
  for (let i = 0; i < 3; i++) {
    cum += flex[i] * D2R;
    const l = SEG[f][i];
    x += Math.sin(phi) * Math.cos(cum) * l;
    y += Math.cos(phi) * Math.cos(cum) * l;
    z += -Math.sin(cum) * l;
    pts.push([x, y, z]);
  }
  return pts;
}

/** 두 자세 사이를 섞을 수 있도록 로컬 21점을 만든다. */
function localHand(pose) {
  const spec = POSE_TABLE[pose] || POSE_TABLE.other;
  const pts = new Array(21);
  pts[0] = [0, 0, 0];
  for (let f = 1; f <= 4; f++) {
    const [spread, flex] = spec.fingers[f - 1];
    const chain = fingerChain(f, spread, flex);
    for (let j = 0; j < 4; j++) pts[f * 4 + 1 + j] = chain[j];
  }
  let thumb;
  if (spec.thumb === 'pinch') {
    const tip = pts[8];
    const mcp = [-0.45, 0.35, -0.05];
    thumb = [
      [-0.2, 0.15, 0],
      mcp,
      [(mcp[0] + tip[0]) / 2 - 0.12, (mcp[1] + tip[1]) / 2 - 0.02, (mcp[2] + tip[2]) / 2 - 0.05],
      [tip[0] - 0.05, tip[1] - 0.02, tip[2] - 0.03],
    ];
  } else {
    thumb = THUMB[spec.thumb];
  }
  for (let j = 0; j < 4; j++) pts[1 + j] = thumb[j];
  return pts;
}

function palmOf(pts) {
  let x = 0;
  let y = 0;
  for (const i of [0, 5, 9, 13, 17]) {
    x += pts[i][0];
    y += pts[i][1];
  }
  return [x / 5, y / 5];
}

/**
 * 화면 px 좌표의 손 랜드마크 21개를 만든다.
 * @param {object} o
 * @param {number} o.x 손바닥 중심 x (px)
 * @param {number} o.y 손바닥 중심 y (px)
 * @param {number} [o.size=150] 손목→중지 뿌리 길이 (px)
 * @param {number} [o.angle=0] 회전(라디안). 0 이면 손가락이 위를 향함, 양수면 시계 방향.
 * @param {'open'|'fist'|'v'|'point'|'pinch'|'other'} [o.pose='open']
 * @param {'left'|'right'} [o.side='right'] 사용자 기준 손 (거울 화면에서 오른손은 엄지가 왼쪽)
 * @param {number} [o.blend] 0..1, o.from 자세에서 pose 로 섞기 (부드러운 전환용)
 * @param {string} [o.from]
 */
export function synthHand({ x, y, size = 150, angle = 0, pose = 'open', side = 'right', blend = 1, from = null }) {
  let pts = localHand(pose);
  if (from && blend < 1) {
    const a = localHand(from);
    pts = pts.map((p, i) => p.map((v, k) => a[i][k] + (v - a[i][k]) * blend));
  }
  const [pcx, pcy] = palmOf(pts);
  const mirror = side === 'left' ? -1 : 1;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return pts.map(([lx, ly, lz]) => {
    const dx = (lx - pcx) * mirror;
    const dy = -(ly - pcy); // 화면은 y 가 아래로 증가
    return {
      x: x + size * (dx * c - dy * s),
      y: y + size * (dx * s + dy * c),
      z: lz * size,
    };
  });
}

// ---------------------------------------------------------------- 얼굴

/** 자주 쓰는 얼굴 랜드마크 번호 (MediaPipe Face Mesh 478점 기준) */
export const FACE = Object.freeze({
  FOREHEAD: 10,
  CHIN: 152,
  NOSE_TIP: 1,
  BETWEEN_EYES: 168,
  UPPER_LIP: 13,
  LOWER_LIP: 14,
  MOUTH_RIGHT: 61, // 본인 기준 오른쪽 입꼬리
  MOUTH_LEFT: 291,
  RIGHT_EYE_OUTER: 33,
  RIGHT_EYE_INNER: 133,
  LEFT_EYE_OUTER: 263,
  LEFT_EYE_INNER: 362,
  RIGHT_EYE_TOP: 159,
  RIGHT_EYE_BOTTOM: 145,
  LEFT_EYE_TOP: 386,
  LEFT_EYE_BOTTOM: 374,
  RIGHT_CHEEK: 234,
  LEFT_CHEEK: 454,
  RIGHT_BROW: 105,
  LEFT_BROW: 334,
});

// 거울 화면 기준 로컬 좌표 (x 오른쪽, y 아래, 단위 = 이마~턱 길이). 본인 오른쪽 = 화면 오른쪽.
const FACE_POINTS = {
  [FACE.FOREHEAD]: [0, -0.5, -0.05],
  [FACE.CHIN]: [0, 0.5, -0.02],
  [FACE.NOSE_TIP]: [0, 0.05, -0.18],
  [FACE.BETWEEN_EYES]: [0, -0.15, -0.08],
  [FACE.UPPER_LIP]: [0, 0.24, -0.1],
  [FACE.LOWER_LIP]: [0, 0.26, -0.1],
  [FACE.MOUTH_RIGHT]: [0.15, 0.25, -0.06],
  [FACE.MOUTH_LEFT]: [-0.15, 0.25, -0.06],
  [FACE.RIGHT_EYE_OUTER]: [0.3, -0.12, -0.02],
  [FACE.RIGHT_EYE_INNER]: [0.1, -0.12, -0.05],
  [FACE.LEFT_EYE_OUTER]: [-0.3, -0.12, -0.02],
  [FACE.LEFT_EYE_INNER]: [-0.1, -0.12, -0.05],
  [FACE.RIGHT_EYE_TOP]: [0.2, -0.15, -0.04],
  [FACE.RIGHT_EYE_BOTTOM]: [0.2, -0.09, -0.04],
  [FACE.LEFT_EYE_TOP]: [-0.2, -0.15, -0.04],
  [FACE.LEFT_EYE_BOTTOM]: [-0.2, -0.09, -0.04],
  [FACE.RIGHT_CHEEK]: [0.42, 0.0, 0.1],
  [FACE.LEFT_CHEEK]: [-0.42, 0.0, 0.1],
  [FACE.RIGHT_BROW]: [0.2, -0.25, -0.06],
  [FACE.LEFT_BROW]: [-0.2, -0.25, -0.06],
};

/**
 * 화면 px 좌표의 얼굴 랜드마크 478개를 만든다. 주요 점만 정확하고 나머지는 얼굴 타원 안에 흩뿌린다.
 * @param {object} o
 * @param {number} o.x 얼굴 중심 x
 * @param {number} o.y 얼굴 중심 y
 * @param {number} [o.size=260] 이마~턱 길이 (px)
 * @param {number} [o.roll=0] 기울기 (라디안, 양수면 시계 방향)
 * @param {number} [o.mouthOpen=0] 0..1
 */
export function synthFace({ x, y, size = 260, roll = 0, mouthOpen = 0 }) {
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  const out = new Array(478);
  const place = (lx, ly, lz) => ({
    x: x + size * (lx * c - ly * s),
    y: y + size * (lx * s + ly * c),
    z: lz * size,
  });
  for (let i = 0; i < 478; i++) {
    const key = FACE_POINTS[i];
    if (key) {
      let [lx, ly, lz] = key;
      if (i === FACE.LOWER_LIP) ly += mouthOpen * 0.12;
      out[i] = place(lx, ly, lz);
    } else {
      // 결정적인 의사 난수로 얼굴 타원 안에 배치
      const a = i * 2.39996323;
      const r = Math.sqrt(((i * 7919) % 478) / 478);
      out[i] = place(Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.48, 0);
    }
  }
  return out;
}

/** 연습 모드 얼굴의 블렌드셰이프 (입김 불기 등) */
export function synthBlendshapes({ blow = 0, mouthOpen = 0, smile = 0 } = {}) {
  return {
    mouthPucker: blow * 0.9,
    mouthFunnel: blow * 0.6,
    cheekPuff: blow * 0.5,
    jawOpen: mouthOpen,
    mouthSmileLeft: smile,
    mouthSmileRight: smile,
    eyeBlinkLeft: 0,
    eyeBlinkRight: 0,
  };
}
