// 동물 귀 놀이에 나오는 동물들. 모양·색·흔들림·울음소리를 숫자로만 정해 둔다 (DOM 의존성 없음).
//
// 귀 하나는 '뿌리 → 끝' 으로 뻗은 중심선을 따라 폭(profile)을 주어 그린다.
//   s = 0 뿌리, s = 1 귀 끝.  profile(s) 는 0..1, 실제 반폭 = profile(s) * halfWidth * 얼굴 크기.
// 길이·폭은 얼굴 크기(S, 볼 사이 너비 정도) 배수다.
// place: 머리 타원 위에서 귀가 붙는 자리 (정수리에서 옆으로 벌어진 각도, 라디안)
// tilt : 머리 위쪽 방향에서 바깥으로 기운 각도 (라디안, 강아지처럼 1.6 넘으면 아래로 처진 귀)

/** 둥근 귀 (곰, 판다): 반지름 1 원의 중심이 뿌리에서 c 만큼 위에 있다. */
function roundProfile(c) {
  const total = c + 1;
  return (s) => {
    const y = s * total - c;
    return Math.sqrt(Math.max(0, 1 - y * y));
  };
}

/** 삼각 귀 (고양이, 여우): 끝으로 갈수록 좁아지고 끝이 살짝 둥글다. */
function pointyProfile(power, bulge) {
  return (s) => Math.pow(Math.max(0, 1 - s), power) * (1 + bulge * Math.sin(Math.PI * s));
}

const ROUND = roundProfile(0.42);

/**
 * @typedef {object} Animal
 * @property {string} id
 * @property {string} name   아이에게 보여 줄 이름
 * @property {string} emoji
 * @property {number} place, tilt, length, halfWidth
 * @property {number} [curl] 끝으로 갈수록 바깥·아래로 휘는 정도 (강아지처럼 축 처진 귀)
 * @property {(s:number)=>number} profile
 * @property {{k:number, end:number, shift?:number}} inner  안쪽 귀: 바깥 폭의 k 배, s=end 에서 끝남
 * @property {object} colors
 * @property {object} phys   흔들림: stiffness, damping, drive(가속 반응), couple(기울기 관성), gravity, rigid(통째 회전), bend(휘어짐)
 * @property {'flick'|'flop'|'wiggle'|'shake'} twitch  가끔 귀를 움찔하는 방식
 * @property {{side:number, at:number, angle:number}|null} kink  한쪽 귀 끝이 접힘 (토끼)
 * @property {boolean} [tufts] 안쪽 귀 뿌리에 하얀 털 몇 가닥 (고양이, 여우)
 * @property {string} extras 얼굴 장식 종류
 * @property {object[]} voice  울음소리 (sound.tone / sound.noise 인자)
 */

/** @type {Animal[]} */
export const ANIMALS = [
  {
    id: 'cat',
    name: '고양이',
    emoji: '🐱',
    place: 0.66,
    tilt: 0.3,
    length: 0.44,
    halfWidth: 0.18,
    profile: pointyProfile(0.78, 0.12),
    inner: { k: 0.56, end: 0.8 },
    colors: {
      fur: ['#f0a35e', '#f6b878', '#ffd2a1'],
      inner: ['#ffc4d3', '#ff94b4'],
      outline: '#a8592a',
      tuft: '#fff6ee',
      accent: '#ff8fb1',
    },
    phys: { stiffness: 210, damping: 13, drive: 0.55, couple: 0.35, gravity: 0, rigid: 1, bend: 0.2 },
    twitch: 'flick',
    kink: null,
    tufts: true,
    extras: 'cat',
    voice: [
      { type: 'triangle', freq: 620, to: 920, dur: 0.12, gain: 0.13 },
      { type: 'triangle', freq: 920, to: 520, dur: 0.28, gain: 0.13, delay: 0.11 },
    ],
  },
  {
    id: 'rabbit',
    name: '토끼',
    emoji: '🐰',
    place: 0.36,
    tilt: 0.16,
    length: 0.8,
    halfWidth: 0.128,
    profile: (s) => Math.pow(Math.sin(Math.PI * (0.17 + 0.83 * Math.min(1, Math.max(0, s)))), 0.62),
    inner: { k: 0.52, end: 0.86 },
    colors: {
      fur: ['#eee3ea', '#fbf6f9', '#ffffff'],
      inner: ['#ffd0de', '#ff9ebc'],
      outline: '#b28a9c',
      tuft: '#ffffff',
      accent: '#ff9ebc',
    },
    phys: { stiffness: 85, damping: 6.5, drive: 1.0, couple: 0.65, gravity: 16, rigid: 0.55, bend: 0.85 },
    twitch: 'flop',
    kink: { side: 1, at: 0.58, angle: 0.55 },
    extras: 'rabbit',
    voice: [
      { type: 'sine', freq: 820, to: 1650, dur: 0.07, gain: 0.17 },
      { type: 'sine', freq: 950, to: 1900, dur: 0.07, gain: 0.15, delay: 0.1 },
    ],
  },
  {
    id: 'bear',
    name: '곰돌이',
    emoji: '🐻',
    place: 0.72,
    tilt: 0.55,
    length: 0.2 * 1.42,
    halfWidth: 0.2,
    profile: ROUND,
    inner: { k: 0.6, end: 0.84, shift: 0.06 },
    colors: {
      fur: ['#8a5531', '#a56a3e', '#b97d4c'],
      inner: ['#f0c89e', '#dca87a'],
      outline: '#5b3418',
      tuft: '#f6dcc0',
      accent: '#c98a55',
    },
    phys: { stiffness: 240, damping: 15, drive: 0.35, couple: 0.25, gravity: 0, rigid: 1, bend: 0 },
    twitch: 'wiggle',
    kink: null,
    extras: 'bear',
    voice: [
      { type: 'sine', freq: 230, to: 150, dur: 0.32, gain: 0.3 },
      { type: 'triangle', freq: 460, to: 300, dur: 0.26, gain: 0.08 },
    ],
  },
  {
    id: 'fox',
    name: '여우',
    emoji: '🦊',
    place: 0.6,
    tilt: 0.32,
    length: 0.48,
    halfWidth: 0.17,
    profile: pointyProfile(0.9, 0.16),
    inner: { k: 0.55, end: 0.7 },
    colors: {
      fur: ['#e8681f', '#f47d2c', '#ff9a45'],
      tip: '#3d2418',
      inner: ['#fffaf2', '#f6e2cc'],
      outline: '#9c3f0e',
      tuft: '#ffffff',
      accent: '#ff8a3d',
    },
    phys: { stiffness: 190, damping: 12, drive: 0.6, couple: 0.35, gravity: 0, rigid: 1, bend: 0.22 },
    twitch: 'flick',
    kink: null,
    tufts: true,
    extras: 'fox',
    voice: [
      { type: 'triangle', freq: 1000, to: 1500, dur: 0.06, gain: 0.12 },
      { type: 'triangle', freq: 1500, to: 900, dur: 0.12, gain: 0.12, delay: 0.07 },
    ],
  },
  {
    id: 'dog',
    name: '강아지',
    emoji: '🐶',
    place: 1.05,
    tilt: 2.62,
    curl: 0.3,
    length: 0.64,
    halfWidth: 0.185,
    profile: (s) => (0.72 + 0.36 * s) * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, s), 3.2))),
    inner: { k: 0.58, end: 0.82, shift: 0.04 },
    colors: {
      fur: ['#8d5428', '#a8693a', '#bf8250'],
      inner: ['#7a4521', '#6a3a1b'],
      outline: '#4e2a12',
      tuft: '#e9c39c',
      accent: '#c98a55',
    },
    phys: { stiffness: 70, damping: 5.5, drive: 1.15, couple: 0.75, gravity: 40, rigid: 0.7, bend: 0.75 },
    twitch: 'shake',
    kink: null,
    extras: 'dog',
    voice: [
      { type: 'square', freq: 360, to: 180, dur: 0.09, gain: 0.07 },
      { kind: 'noise', freq: 650, q: 0.8, dur: 0.07, gain: 0.12, type: 'lowpass' },
      { type: 'square', freq: 380, to: 190, dur: 0.09, gain: 0.07, delay: 0.17 },
      { kind: 'noise', freq: 650, q: 0.8, dur: 0.07, gain: 0.12, type: 'lowpass', delay: 0.17 },
    ],
  },
  {
    id: 'panda',
    name: '판다',
    emoji: '🐼',
    place: 0.72,
    tilt: 0.55,
    length: 0.19 * 1.42,
    halfWidth: 0.19,
    profile: ROUND,
    inner: { k: 0.58, end: 0.82, shift: 0.06 },
    colors: {
      fur: ['#1a1a1f', '#26262d', '#3a3a44'],
      inner: ['#55555f', '#3e3e47'],
      outline: '#000000',
      tuft: '#ffffff',
      accent: '#3a3a44',
      rim: 'rgba(255,255,255,0.75)',
    },
    phys: { stiffness: 240, damping: 15, drive: 0.35, couple: 0.25, gravity: 0, rigid: 1, bend: 0 },
    twitch: 'wiggle',
    kink: null,
    extras: 'panda',
    voice: [
      { type: 'sine', freq: 480, to: 760, dur: 0.14, gain: 0.2 },
      { type: 'sine', freq: 760, to: 580, dur: 0.18, gain: 0.18, delay: 0.13 },
    ],
  },
];

export const ANIMAL_IDS = Object.freeze(ANIMALS.map((a) => a.id));

/** 다음 동물 번호 (끝까지 가면 처음으로) */
export function nextAnimal(index) {
  if (!(index >= 0)) return 0;
  return (index + 1) % ANIMALS.length;
}

/**
 * 처음 귀가 생기는 얼굴에 줄 동물: 다른 얼굴들이 아직 안 쓰는 동물 중 앞쪽 것.
 * 여러 아이가 함께 있으면 서로 다른 동물이 나와서 더 재미있다.
 * @param {number[]} used 다른 얼굴들이 지금 쓰는 동물 번호
 */
export function firstAnimal(used = []) {
  for (let i = 0; i < ANIMALS.length; i++) if (!used.includes(i)) return i;
  return 0;
}

/** 귀 끝까지 포함한 대략적 높이 (얼굴 크기 배수) — 이름표 위치 등에 사용 */
export function earReach(animal) {
  return Math.max(0.1, animal.length * Math.cos(Math.min(animal.tilt + (animal.curl || 0) * 0.5, 1.5)));
}
