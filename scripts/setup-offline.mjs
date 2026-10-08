// 오프라인 전시용 준비: MediaPipe 라이브러리와 인식 모델을 vendor/ 폴더에 내려받는다.
// 사용법: npm install && npm run setup
// 이후 인터넷 없이도 손/얼굴 인식이 동작한다. (앱은 vendor/ 가 있으면 자동으로 그것을 사용)
import { mkdir, copyFile, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    await writeFile(dest, Buffer.from(await r.arrayBuffer()));
    console.log(`✔ ${name} 다운로드 완료`);
  }
  console.log('\n준비 끝! npm start 로 실행하세요.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
