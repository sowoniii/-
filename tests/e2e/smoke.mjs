// 브라우저 자동 점검 (Playwright + Chromium).
//   node tests/e2e/smoke.mjs            모든 놀이를 연습 모드(가짜 손)로 점검 + 실제 인식기 로딩 점검
//   node tests/e2e/smoke.mjs bubbles    특정 놀이만
//   SKIP_CAMERA=1 node tests/e2e/smoke.mjs   실제 카메라/인식기 점검 생략
//
// 기본(카메라 화면만)으로 시나리오를 돌리고, 그동안 어떤 캔버스에도 글자(fillText/strokeText)가 그려지지 않았는지 확인한다.
// 끝에 ?ui (메뉴·버튼·안내가 있는 화면)도 놀이마다 한 번씩 열어 본다.
//
// 각 놀이의 시나리오는 tests/e2e/scenarios/<놀이id>.mjs 에 있다:
//   export default async function scenario(t) { await t.sim({hands:[...]}); await t.wait(500); t.assert(...); await t.shot('name'); }
// 스크린샷은 test-results/ 에 저장된다.

import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const outDir = join(root, 'test-results');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };

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

const W = 1280;
const H = 720;

async function launch() {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** 카메라 화면만 모드에서 캔버스에 글자를 그리면 센다 (안내 글자·점수·이름표가 남아 있는지 잡아낸다) */
function countCanvasText() {
  window.__canvasText = [];
  for (const proto of [CanvasRenderingContext2D.prototype, window.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean)) {
    for (const name of ['fillText', 'strokeText']) {
      const orig = proto[name];
      proto[name] = function (text, ...rest) {
        if (document.body?.classList.contains('clean') && window.__canvasText.length < 50) window.__canvasText.push(String(text));
        return orig.call(this, text, ...rest);
      };
    }
  }
}

async function runScenario(browser, base, id) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = collectErrors(page);
  await page.addInitScript(countCanvasText);
  await page.goto(`${base}/?sim&mode=${id}`);
  await page.waitForFunction(() => window.handplay?.app?.mode && window.handplay.sim, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  const failures = [];
  const t = {
    page,
    W,
    H,
    id,
    /** 가짜 손/얼굴/마이크 설정 */
    sim: (s) => page.evaluate((s) => window.handplay.sim.set(s), s),
    wait: (ms) => page.waitForTimeout(ms),
    /** 화면이 n 프레임 더 그려질 때까지 기다린다 (느린 헤드리스 브라우저에서도 믿을 수 있는 대기) */
    frames: (n = 1) =>
      page.evaluate(
        (n) =>
          new Promise((ok) => {
            const end = window.handplay.app.frameCount + n;
            const tick = () => (window.handplay.app.frameCount >= end ? ok() : requestAnimationFrame(tick));
            requestAnimationFrame(tick);
          }),
        n,
      ),
    /** 놀이 시간(app.clock, frame.dt 의 합)으로 sec 초 기다린다 */
    clockWait: (sec) =>
      page.evaluate(
        (sec) =>
          new Promise((ok) => {
            const end = window.handplay.app.clock + sec;
            const tick = () => (window.handplay.app.clock >= end ? ok() : requestAnimationFrame(tick));
            requestAnimationFrame(tick);
          }),
        sec,
      ),
    /** state() 가 조건을 만족할 때까지 기다린다. 만족하면 그 state, 시간 초과면 null */
    async until(pred, timeoutMs = 15000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const st = await page.evaluate(() => window.handplay.app.mode.state?.() ?? null);
        if (st && pred(st)) return st;
        await page.waitForTimeout(60);
      }
      return null;
    },
    /** 손을 from→to 로 여러 프레임에 걸쳐 움직인다. hand 는 sim hand 객체(위치 제외), others 는 함께 둘 다른 손들.
     *  한 걸음마다 최소 한 프레임이 그려지므로 느린 환경에서도 손이 순간이동하지 않는다. */
    async move(hand, from, to, ms = 600, others = [], index = 0) {
      const steps = Math.max(2, Math.round(ms / 33));
      for (let i = 0; i <= steps; i++) {
        const k = i / steps;
        const h = { ...hand, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
        const hands = [...others];
        hands.splice(index, 0, h);
        await page.evaluate((hs) => window.handplay.sim.set({ hands: hs }), hands);
        await Promise.all([t.frames(1), page.waitForTimeout(33)]);
      }
    },
    /** 여러 손을 동시에 움직인다. paths: [{hand, from, to}] */
    async moveMany(paths, ms = 600) {
      const steps = Math.max(2, Math.round(ms / 33));
      for (let i = 0; i <= steps; i++) {
        const k = i / steps;
        const hands = paths.map(({ hand, from, to }) => ({ ...hand, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }));
        await page.evaluate((hs) => window.handplay.sim.set({ hands: hs }), hands);
        await Promise.all([t.frames(1), page.waitForTimeout(33)]);
      }
    },
    /** 모드 인스턴스의 state() 결과 */
    state: () => page.evaluate(() => window.handplay.app.mode.state?.() ?? null),
    async shot(name) {
      await page.screenshot({ path: join(outDir, `${id}-${name}.png`) });
    },
    assert(cond, msg) {
      if (!cond) failures.push(msg);
    },
  };
  let scenario = null;
  const file = join(root, 'tests', 'e2e', 'scenarios', `${id}.mjs`);
  if (await stat(file).catch(() => null)) scenario = (await import(pathToFileURL(file).href)).default;
  try {
    if (scenario) await scenario(t);
    else await t.shot('idle');
  } catch (e) {
    failures.push(`시나리오 오류: ${e.stack || e.message}`);
  }
  const texts = await page.evaluate(() => window.__canvasText);
  if (texts.length) failures.push(`카메라 화면만 모드에서 캔버스에 글자를 그림: ${JSON.stringify([...new Set(texts)].slice(0, 12))}`);
  const visibleUi = await page.evaluate(() =>
    ['hud', 'start', 'status'].filter((id) => {
      const el = document.getElementById(id);
      return el && getComputedStyle(el).display !== 'none' && !el.hidden;
    }),
  );
  if (visibleUi.length) failures.push(`카메라 화면만 모드에서 UI 가 보임: ${visibleUi.join(', ')}`);
  await page.close();
  return { id, errors, failures };
}

/** ?ui: 메뉴·버튼·안내가 있는 예전 화면도 잘 열리는지 */
async function uiCheck(browser, base, id) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = collectErrors(page);
  const failures = [];
  await page.goto(`${base}/?sim&ui&mode=${id}`);
  await page.waitForFunction(() => window.handplay?.app?.mode, null, { timeout: 10000 });
  await page.evaluate(() => window.handplay.sim.set({ hands: [{ x: 640, y: 420, size: 150, pose: 'open' }] }));
  await page.waitForTimeout(800);
  const s = await page.evaluate(() => ({
    hud: getComputedStyle(document.getElementById('hud')).display !== 'none',
    bar: document.querySelectorAll('.mode-btn').length,
    hint: document.getElementById('hint').textContent,
  }));
  if (!s.hud || s.bar !== 5 || !s.hint) failures.push(`?ui 화면이 이상함: ${JSON.stringify(s)}`);
  await page.screenshot({ path: join(outDir, `${id}-ui.png`) });
  await page.close();
  return { id: `${id} (?ui)`, errors, failures };
}

async function cameraCheck(browser, base) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = collectErrors(page);
  await page.goto(`${base}/?autostart&mode=ears`);
  const failures = [];
  try {
    await page.waitForFunction(() => window.handplay?.app?.tracker?.hands, null, { timeout: 60000 });
    await page.waitForFunction(() => window.handplay?.app?.tracker?.face, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => ({ src: window.handplay.app.tracker.source, mode: window.handplay.app.modeDef.id }));
    if (s.src !== 'local') failures.push(`vendor 모델이 아닌 ${s.src} 에서 불러옴`);
    for (const id of ['bubbles', 'frost', 'stretch', 'warp']) {
      await page.evaluate((id) => window.handplay.switchMode(id), id);
      await page.waitForTimeout(700);
    }
    await page.screenshot({ path: join(outDir, 'camera-fake.png') });
  } catch (e) {
    failures.push(`실제 인식기 로딩 실패: ${e.message}`);
  }
  await page.close();
  // 가짜 카메라 + 소프트웨어 GPU 환경의 알려진 경고는 무시
  const real = errors.filter((e) => !/GL_|WebGL|gpu|GPU|INFO:|XNNPACK|OpenGL|swiftshader|Graph successfully|landmark_projection/i.test(e));
  return { id: 'camera', errors: real, failures };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = await serve();
  const base = `http://localhost:${server.address().port}`;
  const browser = await launch();
  const only = process.argv[2];
  const ids = only && only !== 'camera' ? [only] : ['bubbles', 'frost', 'ears', 'stretch', 'warp'];
  const results = [];
  if (only !== 'camera') for (const id of ids) results.push(await runScenario(browser, base, id));
  if (only !== 'camera') for (const id of ids) results.push(await uiCheck(browser, base, id));
  if ((!only || only === 'camera') && !process.env.SKIP_CAMERA) results.push(await cameraCheck(browser, base));
  await browser.close();
  server.close();
  let failed = false;
  for (const r of results) {
    const bad = r.errors.length + r.failures.length;
    console.log(`${bad ? '✗' : '✓'} ${r.id}`);
    for (const e of r.errors) console.log(`    오류: ${e}`);
    for (const f of r.failures) console.log(`    실패: ${f}`);
    if (bad) failed = true;
  }
  console.log(`스크린샷: ${outDir}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
