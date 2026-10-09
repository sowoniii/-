# 놀이(모드) 만들기 안내

놀이 하나 = `src/modes/<id>.js` 파일 하나. 공통 엔진(`src/core/*`)이 카메라, 손/얼굴 인식, 화면 그리기를 맡고,
놀이는 **매 프레임 받은 손·얼굴 정보로 상태를 바꾸고 그리기만** 하면 된다.

## 모듈 모양

```js
export default {
  id: 'bubbles',            // URL ?mode=bubbles, 바꾸지 말 것
  title: '비눗방울',         // 버튼 이름
  emoji: '🫧',
  color: '#4fc3f7',         // 놀이 대표 색
  description: '…',         // 시작 화면 카드 설명 (한두 문장)
  hint: '…',                // 놀이 중 위쪽 말풍선 기본 문구
  needs: { face: false, mic: false },   // face: true 면 얼굴 인식이 켜진다
  create(app) {             // 놀이에 들어올 때마다 새로 만든다 (상태 초기화)
    return {
      enter() {},                   // 선택: 시작할 때
      update(frame) {},             // 매 프레임: 상태 갱신
      drawGL(stage, frame) {},      // 선택: WebGL 무대 조작 (격자 변형, 영상 조각 그리기)
      draw(ctx, frame) {},          // 매 프레임: 2D 효과 그리기 (영상 위에 덮임)
      resize(width, height) {},     // 선택: 창 크기 바뀜
      exit() {},                    // 선택: 다른 놀이로 바뀔 때 (소리 끄기 등)
      state() {},                   // 선택: 자동 테스트용 요약 (JSON 으로 바꿀 수 있는 값)
    };
  },
};
```

호출 순서(매 프레임): `update` → `drawGL` → (WebGL 무대 렌더) → `draw` → UI.
`draw` 의 ctx 는 이미 기기 픽셀 비율이 적용되어 있어 **화면 CSS px 로 그리면 된다**. save/restore 는 엔진이 감싼다.

## 좌표

모든 좌표는 **화면 CSS px** (왼쪽 위 0,0). 영상은 거울처럼 좌우가 뒤집혀 보이고, 손/얼굴 좌표도 이미 화면에
보이는 위치로 바뀌어 있다. (아이가 오른손을 들면 화면 오른쪽에 보인다)

## frame

| 필드 | 설명 |
|---|---|
| `t`, `dt` | 초 단위 실제 시각, 지난 프레임 이후 시간(최대 0.05 — 느린 기기에서는 놀이 시간이 천천히 간다) |
| `realDt` | 지난 프레임 이후 실제 시간(최대 0.25). 손 위치로 속도를 잴 때는 `t`/`realDt` 기준이 맞다 |
| `frame` | 프레임 번호 (`app.frameCount`) |
| `width`, `height` | 화면 크기 |
| `hands` | `Hand[]` (아래) — 여러 아이의 손이 동시에 들어올 수 있다 (기본 최대 4개) |
| `faces` | `Face[]` — `needs.face` 일 때만 채워진다 |
| `mic` | `{ enabled, level 0..1, blowing, strength 0..1, candidate, flatness }` 마이크 입김 감지. 앱이 잡음 같은 효과음(`pop`, `whoosh`, `noise`, noise loop)을 내는 동안은 입김으로 치지 않는다 |

### Hand (`src/core/handtracker.js`)

같은 손이면 프레임이 바뀌어도 **같은 객체**다 (`id` 로 놀이별 상태를 붙여 두기 좋다).

- `id`, `side` ('left'|'right', 추정치), `stale` (잠깐 놓쳐서 마지막 위치를 유지 중 — 최대 0.2초)
- `lm[21]` 부드럽게 만든 랜드마크 `{x,y,z}` (0 손목, 4 엄지끝, 8 검지끝, 12 중지끝, 16 약지끝, 20 새끼끝, 5/9/13/17 손가락 뿌리)
- `size` 손 크기 px (손목→중지 뿌리). 거리 판정은 이 값에 비례하게 하면 아이·어른·거리와 상관없이 잘 맞는다.
- `palm` 손바닥 중심, `tips[5]` 손가락 끝, `ext[5]` 손가락별 펴짐 0..1, `extended[5]`, `openness` 네 손가락 평균 펴짐
- `pose`: `'open'` 활짝 | `'fist'` 주먹 | `'v'` 브이 | `'point'` 검지만 | `'pinch'` 엄지-검지 집기 | `'other'`
  (몇 프레임 연속이어야 바뀌도록 안정화되어 있다)
- `started` / `ended`: 이번 프레임에 시작된/끝난 pose 이름 (한 프레임만 값이 있고 나머지는 null)
- `poseTime` 현재 pose 유지 시간, `prevPose`
- `pinchDist` (엄지-검지 끝 거리 / size), `pinchPoint` (두 끝의 중간점)
- `velocity` 손바닥 속도 px/s (잠깐 놓쳤다 돌아와도 튀지 않게 실제 경과 시간으로 잰다), `age` 추적된 시간
- `frames` 실제로 검출된 횟수. 막 나타난 손은 몇 프레임 동안 pose 가 'other' 이므로, 새 손을 믿기 전에 3~5 이상인지 볼 것

### Face (`src/core/facetracker.js`)

- `headTop` 정수리 추정 위치, `forehead`, `chin`, `nose`, `mouth`, `leftEye`, `rightEye`, `center`
- `roll` 기울기(라디안, 화면 기준 시계방향 +), `up` (턱→이마 단위벡터), `yaw` -1..1
- `size` 안정된 얼굴 크기 px (양쪽 볼 사이 3D 거리 — 말하거나 고개를 돌려도 거의 그대로). 크기 기준은 이것을 쓸 것
- `width`, `height` 화면에 보이는 얼굴 너비/높이 px (`height` 는 입을 벌리면 커진다)
- `mouthOpen` 0..1, `blow` 입김 부는 입 모양 0..1, `blend` 블렌드셰이프 점수
- `key[번호]` 주요 랜드마크 (번호는 `FACE` 상수, `src/core/synth.js`), `lm` 478개 원본

## app (create 에 넘어오는 것)

- `app.clean` 이 true 이면 **카메라 화면만** 보여 주는 중이다 (기본값. `?ui` 로 열면 false).
  이때는 글자·점수·이름표·안내 표시(목표 고리, 시범 손, 손끝 커서, 잡기 고리 등)를 그리지 말고 놀이 효과
  (비눗방울, 김, 귀, 늘어난 손가락, 젤리 화면, 터지는 입자·반짝임)만 그린다. 그릴 때마다 확인할 것 (`U` 키로 바뀔 수 있다).
  `app.ui.hint/toast` 는 화면에 안 보일 뿐이니 그대로 불러도 된다. e2e 는 이 모드에서 캔버스에 글자를 그리면 실패한다.
- `app.width`, `app.height` 화면 크기, `app.dpr` 기기 픽셀 비율 (캐시 그림 해상도 정할 때)
- `app.clock` 놀이 시간(frame.dt 의 합), `app.frameCount`
- `app.sound` 효과음 (`src/core/sound.js`): `pop(pitch)`, `sparkle()`, `boing(pitch)`, `pip(pitch)`, `whoosh()`,
  `chime()`, `squeak(pitch)`, `tone({...})`, `noise({...})`, 이어지는 소리 `loop(id, {type, freq, gain})` / `stopLoop(id)`.
  놀이가 바뀌면 엔진이 모든 loop 를 끈다. 소리를 너무 자주 내지 않도록 놀이에서 간격을 조절할 것.
- `app.ui.hint(text|null)` 위쪽 안내 문구 바꾸기 (null = 기본 문구),
  `app.ui.toast(text, ms?, {x, y} | {position: 'top'|'bottom'|'center'})` 큰 글씨 (기본은 화면 가운데 — 얼굴을 가릴 수 있으니 위치를 고를 것)
- `app.getSource()` 현재 영상 (video 또는 연습용 canvas), `app.drawSource(ctx, w, h)` 화면과 똑같이 보이는 영상을
  임의 크기 2D 캔버스에 그린다 (작게 그려서 늘리면 흐림 효과)
- `app.viewport` 좌표 변환 (`toTexture(x, y)`), `app.isSim` 연습 모드 여부
- `app.stage` WebGL 무대 (아래)

## WebGL 무대 (`src/core/stage.js`)

영상은 화면보다 조금 넓은 격자(`stage.grid`) 위에 그려진다.

- `stage.grid.offset` (Float32Array, 정점마다 [dx, dy] px): 값을 바꾸면 그 부분 화면이 밀려난다. 정점 k 의
  원래 위치는 `grid.rest[k*2], grid.rest[k*2+1]`, 번호는 `grid.index(i, j)`, 크기 `grid.cols × grid.rows` 칸.
  창 크기가 바뀌면 격자가 새로 만들어지므로 offset 배열을 붙잡아 두지 말고 매번 `stage.grid` 로 접근할 것.
- `stage.drawPatch({ pos, src, alpha?, indices?, opacity?, tint? })`: 영상 조각 그리기. `src` 는 "일그러지기 전
  화면에서 그 위치에 보이던 영상"을 가져온다. 즉 src=손가락이 있던 곳, pos=늘어난 모양 → 손가락이 늘어나 보인다.
  `alpha` 로 가장자리를 부드럽게 할 수 있다. 격자 위에 덮어 그려진다.
- `stage.tint = [r, g, b, a]` 화면 전체 색 섞기 (놀이가 바뀌면 초기화)

## 연습 모드와 자동 테스트

- `?sim` 으로 열면 카메라 없이 가짜 손/얼굴이 나온다 (`src/core/sim.js`, 조작법은 파일 위 주석).
- 테스트에서는 `window.handplay.sim.set({ hands: [{x, y, size, angle, pose, side, visible}], faces: [{x, y, size, roll, yaw, blow, mouthOpen}], mic: {blowing, strength, level, enabled} })`.
- 연습 모드 만화 얼굴은 실제 사람 비율(정수리 = 이마 위로 볼 사이 거리의 약 0.4배)로 그려진다.
- `tests/e2e/scenarios/<id>.mjs` 시나리오를 만들면 `node tests/e2e/smoke.mjs <id>` 가 실행해 준다.
  헤드리스 브라우저는 몇 fps 밖에 안 나올 수 있으므로 고정 시간 대기 대신 `t.frames(n)`, `t.clockWait(sec)`,
  `t.until(state => 조건, ms)` 를 쓰고, 손은 `t.move` / `t.moveMany` 로 한 프레임씩 움직인다.
  스크린샷은 `test-results/<id>-*.png`. 콘솔 오류가 하나라도 있으면 실패.
- 순수 로직은 `tests/<id>.test.js` (node:test) 로 단위 테스트한다. `npm test` 로 전부 실행.

## 좋은 놀이의 조건

- 아이가 설명 없이도 바로 알 수 있게: 큰 반응, 밝은 색, 즐거운 소리, 따라 할 수 있는 안내 문구.
- 인식은 흔들리고 가끔 끊긴다: 한두 프레임 놓쳐도 놀이가 깨지지 않게 (stale, poseTime, 거리 여유 활용).
- 여러 아이가 동시에: 손/얼굴이 여러 개여도 각자 동작하게.
- 성능: 60fps 목표. 입자 수 상한을 두고, 매 프레임 큰 캔버스를 새로 만들지 않기.
