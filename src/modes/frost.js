// TODO: 구현 예정
export default {
  id: 'frost',
  title: '입김 그림',
  emoji: '🌬️',
  color: '#80deea',
  description: '화면에 후~ 입김을 불어 김을 서리게 하고, 손가락으로 그림을 그려요.',
  hint: '화면에 대고 후~ 불어 보세요 🌬️',
  needs: { face: true, mic: true },
  create(app) {
    return {
      enter() {},
      update(frame) {},
      draw(ctx, frame) {},
      exit() {},
    };
  },
};
