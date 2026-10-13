export const P2P_CONNECT_TIMEOUT_MS = 20_000;
export const MEDIA_FIRST_FRAME_TIMEOUT_MS = 8_000;
export const MEDIA_DISCONNECT_GRACE_MS = 8_000;
// Keep Windows permission/driver preparation separate from media establishment.
export const CAMPUS_LOCAL_TIMEOUT_MS = 110_000;
export const CAMPUS_ANSWER_TIMEOUT_MS = 115_000;
export const CAMPUS_TOTAL_TIMEOUT_MS = 220_000;

// loadeddata means a decoded current frame exists; ICE/ontrack alone do not.
export function watchPlayableFrame(video, ready) {
  let disposed = false;

  const check = () => {
    if (!disposed && video.readyState >= 2 && video.videoWidth > 0) {
      disposed = true;
      video.removeEventListener('loadeddata', check);
      video.removeEventListener('canplay', check);
      ready();
    }
  };

  video.addEventListener('loadeddata', check);
  video.addEventListener('canplay', check);
  check();

  return () => {
    disposed = true;
    video.removeEventListener('loadeddata', check);
    video.removeEventListener('canplay', check);
  };
}
