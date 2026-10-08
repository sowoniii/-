// TODO: 구현 예정
export default {
  id: 'warp',
  title: '말랑 화면',
  emoji: '✊',
  color: '#b39ddb',
  description: '주먹을 꽉 쥐면 화면을 잡을 수 있어요. 당기고 비틀어 봐요!',
  hint: '주먹을 꽉 쥐어서 화면을 잡아 당겨요 ✊',
  needs: { face: false, mic: false },
  create(app) {
    return {
      enter() {},
      update(frame) {},
      draw(ctx, frame) {},
      exit() {},
    };
  },
};
