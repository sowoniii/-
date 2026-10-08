// TODO: 구현 예정
export default {
  id: 'bubbles',
  title: '비눗방울',
  emoji: '🫧',
  color: '#4fc3f7',
  description: '손바닥을 활짝 펴면 비눗방울이 나와요. 콕 찌르거나 꽉 잡아서 터뜨려요!',
  hint: '손바닥을 활짝 펴 보세요 🖐️',
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
