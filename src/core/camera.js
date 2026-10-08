// 카메라(+가능하면 마이크) 열기.

const VIDEO = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
// 입김 소리는 잡음처럼 들리므로 브라우저의 잡음 제거/자동 음량을 꺼야 잘 잡힌다.
const AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/**
 * @param {HTMLVideoElement} video
 * @param {{audio?: boolean}} [opts]
 * @returns {Promise<{video: HTMLVideoElement, audioStream: MediaStream|null}>}
 */
export async function openCamera(video, { audio = true } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error('이 브라우저에서는 카메라를 사용할 수 없어요.');
    err.code = 'unsupported';
    throw err;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: audio ? AUDIO : false });
  } catch (e) {
    if (!audio) throw tag(e);
    // 마이크가 없거나 거부되어도 카메라만으로 계속한다.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: false });
    } catch (e2) {
      throw tag(e2);
    }
  }
  const videoTracks = stream.getVideoTracks();
  const audioTracks = stream.getAudioTracks();
  video.srcObject = new MediaStream(videoTracks);
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});
  if (video.readyState < 2) {
    await new Promise((resolve) => {
      const done = () => resolve();
      video.addEventListener('loadeddata', done, { once: true });
      setTimeout(done, 4000);
    });
  }
  return { video, audioStream: audioTracks.length ? new MediaStream(audioTracks) : null };
}

function tag(e) {
  const err = new Error(e?.message || String(e));
  err.name = e?.name || 'Error';
  err.code = e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'notfound' : 'error';
  return err;
}
