export const P2P_CONNECT_TIMEOUT_MS = 20_000;
export const MEDIA_FIRST_FRAME_TIMEOUT_MS = 8_000;
export const MEDIA_DISCONNECT_GRACE_MS = 8_000;
// Keep Windows permission/driver preparation separate from media establishment.
export const CAMPUS_LOCAL_TIMEOUT_MS = 110_000;
export const CAMPUS_ANSWER_TIMEOUT_MS = 115_000;
export const CAMPUS_TOTAL_TIMEOUT_MS = 220_000;

// loadeddata means a decoded current frame exists; ICE/ontrack alone do not.
export function watchPlayableFrame(video, ready, stream) {
  let disposed = false;
  // An audio track can trigger loadeddata before the first video track is
  // added to the playing stream. resize also fires when its dimensions arrive.
  const events = ['loadeddata', 'canplay', 'resize', 'playing'];
  const dispose = () => {
    disposed = true;
    for (const event of events) video.removeEventListener(event, check);
  };
  const check = () => {
    if (disposed || video.readyState < 2 || !video.videoWidth) return;
    if (!stream || (video.srcObject === stream && stream.getVideoTracks().length)) {
      dispose();
      ready();
    }
  };

  for (const event of events) video.addEventListener(event, check);
  check();
  return dispose;
}
