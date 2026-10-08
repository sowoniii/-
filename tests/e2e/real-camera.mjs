// 실제 사진을 '가짜 카메라'로 넣어 카메라 → MediaPipe → 손/얼굴 추적 → 놀이 까지 전체 경로를 점검한다.
//   node tests/e2e/real-camera.mjs
// 필요: npm run setup (vendor/), ffmpeg, Python3 + Pillow, Playwright + Chromium, 인터넷(사진 내려받기, 처음 한 번).
// 사진은 MediaPipe 공식 테스트 사진(storage.googleapis.com/mediapipe-assets)을 쓰고 test-results/real-camera/ 에 둔다.

import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const work = join(root, 'test-results', 'real-camera');
const BASE = 'https://storage.googleapis.com/mediapipe-assets/';
const PHOTOS = ['portrait.jpg', 'victory.jpg', 'right_hands.jpg', 'fist.jpg'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

// 1280x720 화면에 사진을 배치한다 (원본 그대로 — 앱이 거울처럼 뒤집어 보여 준다)
const COMPOSE = `
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
def canvas(): return Image.new('RGB', (1280, 720), (236, 232, 226))
def fit(im, h): return im.resize((round(im.width * h / im.height), h), Image.LANCZOS)
# 얼굴과 손이 실제처럼 비슷한 크기가 되도록 얼굴 쪽을 잘라 키우고, 브이 손을 얼굴 옆에 둔다
c = canvas(); p = fit(Image.open(src + '/portrait.jpg').crop((160, 0, 660, 500)), 720); c.paste(p, (40, 0))
v = fit(Image.open(src + '/victory.jpg'), 380); c.paste(v, (780, 180)); c.save(out + '/face_v.png')
c = canvas(); h = fit(Image.open(src + '/right_hands.jpg'), 600); c.paste(h, ((1280 - h.width) // 2, 60)); c.save(out + '/open.png')
c = canvas(); h = fit(Image.open(src + '/fist.jpg'), 560); c.paste(h, ((1280 - h.width) // 2, 80)); c.save(out + '/fist.png')
`;

const CASES = [
  {
    video: 'face_v',
    mode: 'ears',
    check: (s) => s.hands.includes('v') && s.faces === 1 && s.state?.withEars >= 1,
    want: '브이 손 + 얼굴 1개 → 동물 귀가 붙음',
  },
  {
    video: 'open',
    mode: 'bubbles',
    check: (s) => s.hands.filter((p) => p === 'open').length === 2 && s.state?.emitted > 0,
    want: '펼친 손 2개 → 비눗방울이 나옴',
  },
  {
    video: 'fist',
    mode: 'warp',
    check: (s) => s.hands.includes('fist') && s.state?.grabs >= 1,
    want: '주먹 → 화면을 잡음',
  },
];

async function prepare() {
  await mkdir(work, { recursive: true });
  for (const name of PHOTOS) {
    const dest = join(work, name);
    if (await stat(dest).catch(() => null)) continue;
    const r = await fetch(BASE + name);
    if (!r.ok) throw new Error(`${name}: ${r.status}`);
    await writeFile(dest, Buffer.from(await r.arrayBuffer()));
  }
  await writeFile(join(work, 'compose.py'), COMPOSE);
  execFileSync('python3', ['-I', join(work, 'compose.py'), work, work]);
  for (const c of CASES) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', join(work, `${c.video}.png`), '-t', '2', '-r', '10', '-pix_fmt', 'yuv420p', join(work, `${c.video}.y4m`)]);
  }
}

function serve() {
  return new Promise((ok) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://x');
        let p = normalize(join(root, decodeURIComponent(url.pathname)));
        if (!p.startsWith(root)) throw new Error('forbidden');
        if ((await stat(p).catch(() => null))?.isDirectory()) p = join(p, 'index.html');
        const body = await readFile(p);
        res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, () => ok(server));
  });
}

async function runCase(base, c) {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${join(work, `${c.video}.y4m`)}`,
      '--autoplay-policy=no-user-gesture-required',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?autostart&cpu&debug&mode=${c.mode}`);
  let last = null;
  let ok = false;
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    last = await page.evaluate(() => {
      const a = window.handplay?.app;
      if (!a?.tracker?.hands) return null;
      return { hands: a.hands.filter((h) => !h.stale).map((h) => h.pose), faces: a.faces.length, state: a.mode?.state?.() ?? null };
    });
    if (last && c.check(last)) {
      ok = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(root, 'test-results', `real-${c.video}-${c.mode}.png`) });
  await browser.close();
  return { ok, last, errors };
}

async function main() {
  await prepare();
  const server = await serve();
  const base = `http://localhost:${server.address().port}`;
  let failed = false;
  for (const c of CASES) {
    const r = await runCase(base, c);
    const bad = !r.ok || r.errors.length;
    if (bad) failed = true;
    const summary = r.last ? `손 [${r.last.hands.join(', ')}], 얼굴 ${r.last.faces}` : '인식기 준비 안 됨';
    console.log(`${bad ? '✗' : '✓'} ${c.video} → ${c.mode}: ${c.want}  (${summary})`);
    for (const e of r.errors) console.log(`    오류: ${e}`);
  }
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
