// 오프라인 전시용 준비: MediaPipe 라이브러리와 인식 모델을 vendor/ 폴더에 내려받는다.
// 사용법: npm install && npm run setup
// 이후 인터넷 없이도 손/얼굴 인식이 동작한다. (앱은 vendor/ 가 있으면 자동으로 그것을 사용)
import { mkdir, copyFile, readdir, writeFile, stat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 학교·기관 네트워크처럼 프록시를 거쳐야 하면, Node 의 fetch 가 프록시를 쓰도록 다시 실행한다 (Node 22.21+/24+)
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.npm_config_https_proxy || process.env.npm_config_proxy;
if (proxy && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy },
  });
  process.exit(r.status ?? 1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const out = join(root, 'vendor');
const MODELS = {
  'hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'face_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

async function main() {
  if (!(await stat(pkg).catch(() => null))) {
    console.error('먼저 npm install 을 실행해 주세요.');
    process.exit(1);
  }
  await mkdir(join(out, 'mediapipe', 'wasm'), { recursive: true });
  await mkdir(join(out, 'models'), { recursive: true });
  await copyFile(join(pkg, 'vision_bundle.mjs'), join(out, 'mediapipe', 'vision_bundle.mjs'));
  for (const f of await readdir(join(pkg, 'wasm'))) {
    await copyFile(join(pkg, 'wasm', f), join(out, 'mediapipe', 'wasm', f));
  }
  console.log('✔ MediaPipe 라이브러리 복사 완료');
  for (const [name, url] of Object.entries(MODELS)) {
    const dest = join(out, 'models', name);
    if (await stat(dest).catch(() => null)) {
      console.log(`✔ ${name} (이미 있음)`);
      continue;
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${name} 다운로드 실패: ${r.status}`);
    // 다 받은 뒤 이름을 바꿔서, 중간에 끊겨도 반쪽짜리 파일이 남지 않게 한다
    await writeFile(`${dest}.part`, Buffer.from(await r.arrayBuffer()));
    await rename(`${dest}.part`, dest);
    console.log(`✔ ${name} 다운로드 완료`);
  }
  console.log('\n준비 끝! npm start 로 실행하세요.');
}

main().catch((e) => {
  console.error(e);
  console.error('\n모델을 내려받지 못했어요. 인터넷(또는 프록시 설정)을 확인하거나, 아래 파일을 직접 받아 vendor/models/ 에 넣어 주세요:');
  for (const [name, url] of Object.entries(MODELS)) console.error(`  ${name}  ←  ${url}`);
  process.exit(1);
});
