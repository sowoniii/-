// TODO: 구현 예정
export default {
  id: 'stretch',
  title: '늘어나는 손가락',
  emoji: '👆',
  color: '#ffb74d',
  description: '한 손가락을 펴고, 다른 손으로 손가락 끝을 집어서 쭈욱 당겨 봐요.',
  hint: '한 손은 검지를 펴고 👆 다른 손으로 끝을 집어 당겨요 🤏',
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
