export const P2P_CONNECT_TIMEOUT_MS = 20_000;

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
