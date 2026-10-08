// TODO: 구현 예정
export default {
  id: 'ears',
  title: '동물 귀',
  emoji: '🐰',
  color: '#f48fb1',
  description: '브이(✌️)를 하면 머리 위에 고양이·토끼 귀가 뿅! 하고 나와요.',
  hint: '브이 ✌️ 를 해 보세요!',
  needs: { face: true, mic: false },
  create(app) {
    return {
      enter() {},
      update(frame) {},
      draw(ctx, frame) {},
      exit() {},
    };
  },
};
