// 실제 사진으로 만든 손/얼굴 랜드마크 테스트 데이터 만들기.
//   node scripts/make-real-fixtures.mjs
// MediaPipe 공식 테스트 사진(storage.googleapis.com/mediapipe-assets)을 내려받아, vendor/ 의 인식기로
// 헤드리스 Chromium 에서 랜드마크를 뽑고 tests/fixtures/real-landmarks.json 에 저장한다 (사진은 저장하지 않음).
// 필요: npm run setup (vendor/), Playwright + Chromium.

import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = 'https://storage.googleapis.com/mediapipe-assets/';
/** 사진 이름 → 사진 속 손들이 가져야 할 손 모양 */
export const IMAGES = {
  'victory.jpg': { hands: ['v'] },
  'pointing_up.jpg': { hands: ['point'] },
  'pointing_up_rotated.jpg': { hands: ['point'] },
  'fist.jpg': { hands: ['fist'] },
  'thumb_up.jpg': { hands: ['fist'] }, // 엄지는 보지 않으므로 '엄지 척'은 주먹으로 본다
  'left_hands.jpg': { hands: ['open', 'open'] },
  'right_hands.jpg': { hands: ['open', 'open'] },
  'left_hands_rotated.jpg': { hands: ['open', 'open'] },
  'right_hands_rotated.jpg': { hands: ['open', 'open'] },
  'portrait.jpg': { hands: [], faces: 1 },
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.jpg': 'image/jpeg' };

async function main() {
  if (!(await stat(join(root, 'vendor', 'models', 'hand_landmarker.task')).catch(() => null))) {
    console.error('먼저 npm run setup 을 실행해 주세요.');
    process.exit(1);
  }
  const images = {};
  for (const name of Object.keys(IMAGES)) {
    const r = await fetch(BASE + name);
    if (!r.ok) throw new Error(`${name}: ${r.status}`);
    images[name] = Buffer.from(await r.arrayBuffer());
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/img/')) {
      const buf = images[url.pathname.slice(5)];
      res.writeHead(buf ? 200 : 404, { 'Content-Type': 'image/jpeg' });
      return res.end(buf);
    }
    if (url.pathname === '/blank.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><body></body>');
    }
    try {
      const p = normalize(join(root, decodeURIComponent(url.pathname)));
      if (!p.startsWith(root)) throw new Error();
      const body = await readFile(p);
      res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.goto(`${base}/blank.html`);
  const out = await page.evaluate(async (names) => {
    const mod = await import('/vendor/mediapipe/vision_bundle.mjs');
    const fileset = await mod.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
    const hands = await mod.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/vendor/models/hand_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numHands: 4,
    });
    const faces = await mod.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/vendor/models/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 2,
      outputFaceBlendshapes: true,
    });
    const result = {};
    for (const name of names) {
      const img = new Image();
      img.src = `/img/${name}`;
      await img.decode();
      const h = hands.detect(img);
      const f = faces.detect(img);
      const r2 = (v) => Math.round(v * 1e5) / 1e5;
      result[name] = {
        width: img.naturalWidth,
        height: img.naturalHeight,
        hands: h.landmarks.map((lm, i) => ({
          handedness: (h.handedness[i] || [])[0]?.categoryName || null,
          lm: lm.map((p) => [r2(p.x), r2(p.y), r2(p.z)]),
        })),
        faces: f.faceLandmarks.map((lm, i) => {
          const blend = {};
          for (const c of f.faceBlendshapes?.[i]?.categories || []) blend[c.categoryName] = r2(c.score);
          return { lm: lm.map((p) => [r2(p.x), r2(p.y), r2(p.z)]), blend };
        }),
      };
    }
    return result;
  }, Object.keys(IMAGES));
  await browser.close();
  server.close();
  for (const [name, r] of Object.entries(out)) r.expect = IMAGES[name];
  await mkdir(join(root, 'tests', 'fixtures'), { recursive: true });
  const file = join(root, 'tests', 'fixtures', 'real-landmarks.json');
  await writeFile(file, JSON.stringify({ source: BASE, generatedBy: 'scripts/make-real-fixtures.mjs', images: out }));
  for (const [name, r] of Object.entries(out)) console.log(`${name}: 손 ${r.hands.length}개, 얼굴 ${r.faces.length}개`);
  console.log(`저장: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
