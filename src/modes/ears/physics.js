// 동물 귀 흔들림 물리 (DOM 의존성 없음, node 에서 테스트).
//
// HeadMotion: 얼굴 위치·각도·크기를 부드럽게 따라가며 속도와 가속도를 구한다.
// EarSpring : 귀 하나를 '뿌리에 달린 용수철 막대'로 보고, 머리가 움직이면 귀 끝이 뒤처지며 출렁이게 한다.

import { damp, wrapAngle, clamp } from '../../core/math.js';

/** 각도 방향: 0 = 화면 위쪽, 양수 = 시계 방향. 방향 벡터 = (sin a, -cos a) */
export function dirOf(angle) {
  return { x: Math.sin(angle), y: -Math.cos(angle) };
}

export class HeadMotion {
  constructor({ posLambda = 30, angLambda = 24, sizeLambda = 7, yawLambda = 9 } = {}) {
    this.posLambda = posLambda;
    this.angLambda = angLambda;
    this.sizeLambda = sizeLambda;
    this.yawLambda = yawLambda;
    this.ready = false;
    this.x = 0;
    this.y = 0;
    this.ang = 0;
    this.size = 1;
    this.crown = 1;
    this.yaw = 0;
    // 속도·가속도 (가속도는 '얼굴 크기 / 초²' 단위라서 얼굴이 크든 작든 똑같이 출렁인다)
    this.vx = 0;
    this.vy = 0;
    this.ax = 0;
    this.ay = 0;
    this.av = 0;
    this.aa = 0;
  }

  /**
   * @param {{x:number, y:number, ang:number, size:number, crown:number, yaw:number}} target
   * @param {number} dt 초
   */
  update(target, dt) {
    if (!this.ready) {
      this.snap(target);
      return this;
    }
    if (!(dt > 0)) return this; // 같은 시각에 두 번 불리면 그대로
    // 인식이 잠깐 엉뚱한 곳으로 튀면(다른 얼굴과 바뀜 등) 출렁임 없이 바로 옮긴다
    const jump = Math.hypot(target.x - this.x, target.y - this.y);
    if (jump > this.size * 0.9 || Math.abs(target.size / this.size - 1) > 0.6) {
      this.snap(target);
      return this;
    }
    const px = this.x;
    const py = this.y;
    const pa = this.ang;
    this.x = damp(this.x, target.x, this.posLambda, dt);
    this.y = damp(this.y, target.y, this.posLambda, dt);
    this.ang = damp(this.ang, this.ang + wrapAngle(target.ang - this.ang), this.angLambda, dt);
    this.size = damp(this.size, target.size, this.sizeLambda, dt);
    this.crown = damp(this.crown, target.crown, this.sizeLambda, dt);
    this.yaw = damp(this.yaw, target.yaw, this.yawLambda, dt);

    const s = Math.max(1, this.size);
    const pvx = this.vx;
    const pvy = this.vy;
    const pav = this.av;
    this.vx = damp(this.vx, (this.x - px) / dt / s, 18, dt);
    this.vy = damp(this.vy, (this.y - py) / dt / s, 18, dt);
    this.av = damp(this.av, (this.ang - pa) / dt, 18, dt);
    const lim = 60;
    this.ax = clamp(damp(this.ax, (this.vx - pvx) / dt, 14, dt), -lim, lim);
    this.ay = clamp(damp(this.ay, (this.vy - pvy) / dt, 14, dt), -lim, lim);
    this.aa = clamp(damp(this.aa, (this.av - pav) / dt, 14, dt), -lim, lim);
    return this;
  }

  snap(target) {
    this.ready = true;
    this.x = target.x;
    this.y = target.y;
    this.ang = target.ang;
    this.size = Math.max(1, target.size);
    this.crown = target.crown;
    this.yaw = target.yaw || 0;
    this.vx = this.vy = this.ax = this.ay = this.av = this.aa = 0;
  }
}

export class EarSpring {
  /**
   * @param {object} phys 동물의 흔들림 값 (animals.js)
   */
  constructor(phys) {
    this.phys = phys;
    this.theta = 0; // 쉬는 자세에서 벗어난 각도 (라디안, 양수 = 시계 방향)
    this.omega = 0;
  }

  setPhys(phys) {
    this.phys = phys;
  }

  /** 툭 건드리기 (움찔, 변신할 때) */
  impulse(v) {
    this.omega += v;
  }

  /**
   * @param {number} dt
   * @param {{ax:number, ay:number, aa:number, ang:number}} head  머리 가속도(얼굴크기/초²), 각가속도, 현재 머리 각도
   * @param {number} rest 머리 기준 쉬는 각도 (오른쪽 귀 +, 왼쪽 귀 −)
   * @param {number} length 귀 길이 (얼굴 크기 배수)
   */
  step(dt, head, rest, length) {
    const p = this.phys;
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    const L = Math.max(0.1, length);
    const gRest = Math.sin(rest);
    for (let i = 0; i < steps; i++) {
      const psi = head.ang + rest + this.theta * p.rigid;
      // 머리가 가속하면 귀 끝은 반대쪽으로 밀린다 (관성). t = 귀가 시계 방향으로 돌 때 끝이 가는 방향
      const tx = Math.cos(psi);
      const ty = Math.sin(psi);
      const drive = (-(head.ax * tx + head.ay * ty) * 1.5 * p.drive) / L;
      // 처진 귀는 머리를 기울이면 땅 쪽으로 늘어진다 (똑바로 섰을 때 모양은 그대로)
      const grav = p.gravity * (Math.sin(psi) - gRest);
      const acc = -p.stiffness * this.theta - p.damping * this.omega + drive - p.couple * head.aa + grav;
      this.omega += acc * h;
      this.theta += this.omega * h;
    }
    if (!Number.isFinite(this.theta) || !Number.isFinite(this.omega)) {
      this.theta = 0;
      this.omega = 0;
    }
    this.theta = clamp(this.theta, -1.3, 1.3);
    this.omega = clamp(this.omega, -40, 40);
    return this.theta;
  }
}

/**
 * 뾱! 하고 나타나는 크기 애니메이션 (넘쳤다가 돌아오는 용수철).
 * 0 → 1 로 가면서 1.2 정도까지 넘친다.
 */
export class PopSpring {
  constructor(value = 0, { stiffness = 300, damping = 14 } = {}) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }
  step(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const f = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += f * h;
      this.value += this.velocity * h;
    }
    if (this.value < 0) {
      this.value = 0;
      if (this.velocity < 0) this.velocity = 0;
    }
    return this.value;
  }
}
