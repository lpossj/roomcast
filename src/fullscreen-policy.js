// Fullscreen capability policy.
//
// Desktop, Android and iPadOS expose the Element Fullscreen API, so the player container
// can go fullscreen and keep Roomcast's own controls. iPhone Safari implements no element
// fullscreen at all, and awaiting `undefined` from an optional call used to make the
// fullscreen button silently do nothing; the native video player is the only route there
// and it reports through webkit events rather than `fullscreenchange`.

export const FULLSCREEN_ELEMENT = 'element';
export const FULLSCREEN_VIDEO = 'video';
export const FULLSCREEN_UNSUPPORTED = 'unsupported';

export function pickFullscreenMode({ elementFullscreen = false, videoFullscreen = false } = {}) {
  if (elementFullscreen) return FULLSCREEN_ELEMENT;
  if (videoFullscreen) return FULLSCREEN_VIDEO;
  return FULLSCREEN_UNSUPPORTED;
}
