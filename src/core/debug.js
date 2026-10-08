// 개발자용 화면 표시 (D 키): 손 뼈대, 손 모양 이름, 얼굴 주요 점, FPS, 마이크 크기.

import { HAND_CONNECTIONS } from './gestures.js';

const POSE_LABEL = { open: '🖐 펼침', fist: '✊ 주먹', v: '✌️ 브이', point: '👆 가리킴', pinch: '🤏 집기', other: '· 기타' };

export function drawDebug(ctx, frame, info) {
  ctx.save();
  ctx.lineWidth = 2;
  for (const h of frame.hands) {
    ctx.strokeStyle = h.stale ? 'rgba(255,255,255,0.35)' : 'rgba(0,255,170,0.9)';
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(h.lm[a].x, h.lm[a].y);
      ctx.lineTo(h.lm[b].x, h.lm[b].y);
    }
    ctx.stroke();
    ctx.fillStyle = '#ff3d7f';
    for (const p of h.lm) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const label = `#${h.id} ${h.side === 'left' ? '왼손' : '오른손'} ${POSE_LABEL[h.pose] || h.pose}`;
    const ext = h.ext.map((v) => v.toFixed(1)).join(' ');
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(h.palm.x - 4, h.palm.y + h.size * 0.5 - 16, 210, 40);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, h.palm.x, h.palm.y + h.size * 0.5);
    ctx.font = '12px monospace';
    ctx.fillText(`펴짐 ${ext}  집기 ${h.pinchDist.toFixed(2)}`, h.palm.x, h.palm.y + h.size * 0.5 + 18);
  }
  for (const f of frame.faces) {
    ctx.fillStyle = '#ffd400';
    for (const p of Object.values(f.key)) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = '#ffd400';
    ctx.beginPath();
    ctx.arc(f.headTop.x, f.headTop.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = '12px monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText(`얼굴 #${f.id} 기울기 ${(f.roll * 57.3).toFixed(0)}° 입김 ${f.blow.toFixed(2)}`, f.chin.x - 60, f.chin.y + 20);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(8, frame.height - 74, 240, 66);
  ctx.fillStyle = '#fff';
  ctx.font = '13px monospace';
  ctx.fillText(`FPS ${info.fps.toFixed(0)}  인식 ${info.detectMs.toFixed(1)}ms`, 16, frame.height - 52);
  ctx.fillText(`손 ${frame.hands.length}  얼굴 ${frame.faces.length}  ${info.source}`, 16, frame.height - 34);
  ctx.fillText(`마이크 ${frame.mic.enabled ? '' : '(없음)'}`, 16, frame.height - 16);
  ctx.fillStyle = frame.mic.blowing ? '#00e5ff' : '#8aa';
  ctx.fillRect(110, frame.height - 26, 120 * frame.mic.level, 10);
  ctx.restore();
}
