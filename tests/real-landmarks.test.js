// 실제 사진(MediaPipe 공식 테스트 사진)에서 뽑은 랜드마크로 손 모양 판별을 검증한다.
// 데이터 다시 만들기: node scripts/make-real-fixtures.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Viewport } from '../src/core/viewport.js';
import { HandTracker } from '../src/core/handtracker.js';
import { FaceTracker } from '../src/core/facetracker.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/real-landmarks.json', import.meta.url), 'utf8'));

function toScreen(r, W, H) {
  const vp = new Viewport();
  vp.resize(W, H);
  vp.setSource(r.width, r.height, true);
  return {
    hands: r.hands.map((h) => ({ lm: h.lm.map(([x, y, z]) => vp.toScreen(x, y, z)), side: h.handedness === 'Left' ? 'right' : 'left' })),
    faces: r.faces.map((f) => ({ lm: f.lm.map(([x, y, z]) => vp.toScreen(x, y, z)), blend: f.blend })),
  };
}

for (const [name, r] of Object.entries(fx.images)) {
  if (!r.expect.hands.length) continue;
  test(`실제 사진 ${name}: ${r.expect.hands.join(', ')}`, () => {
    for (const [W, H] of [[1280, 720], [720, 1280], [1920, 1080]]) {
      const det = toScreen(r, W, H);
      const tr = new HandTracker();
      let hands = [];
      for (let i = 0; i < 8; i++) hands = tr.update(det.hands, i / 30);
      assert.deepEqual(hands.map((h) => h.pose).sort(), [...r.expect.hands].sort(), `${W}x${H}`);
    }
  });
}

test('실제 사진 portrait.jpg: 얼굴 크기, 정수리, 거울 화면의 눈 방향', () => {
  const r = fx.images['portrait.jpg'];
  const det = toScreen(r, 1280, 720);
  const f = new FaceTracker().update(det.faces, 0)[0];
  assert.ok(Math.abs(f.roll) < 0.1, `roll ${f.roll}`);
  assert.ok(Math.abs(f.yaw) < 0.2, `yaw ${f.yaw}`);
  assert.ok(f.rightEye.x > f.leftEye.x, '거울 화면에서 본인 오른눈은 화면 오른쪽');
  assert.ok(f.size > f.width * 0.95 && f.size < f.width * 1.3, `size ${f.size} width ${f.width}`);
  assert.ok(f.headTop.y < f.forehead.y - 0.35 * f.size, '정수리는 이마보다 충분히 위');
  assert.ok(f.blow < 0.3, '입김 부는 얼굴이 아님');
});
