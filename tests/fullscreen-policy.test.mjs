import assert from 'node:assert/strict';
import test from 'node:test';
import { FULLSCREEN_ELEMENT, FULLSCREEN_UNSUPPORTED, FULLSCREEN_VIDEO, pickFullscreenMode } from '../src/fullscreen-policy.js';

test('fullscreen mode prefers element fullscreen and falls back to the video player', () => {
  // Desktop / Android / iPadOS: the container can go fullscreen and keep Roomcast's UI.
  assert.equal(pickFullscreenMode({ elementFullscreen: true, videoFullscreen: true }), FULLSCREEN_ELEMENT);
  assert.equal(pickFullscreenMode({ elementFullscreen: true, videoFullscreen: false }), FULLSCREEN_ELEMENT);

  // iPhone Safari: no element fullscreen, only the native video player. This is the case
  // that used to silently do nothing because `await undefined` resolves without error.
  assert.equal(pickFullscreenMode({ elementFullscreen: false, videoFullscreen: true }), FULLSCREEN_VIDEO);

  assert.equal(pickFullscreenMode({ elementFullscreen: false, videoFullscreen: false }), FULLSCREEN_UNSUPPORTED);
  assert.equal(pickFullscreenMode(), FULLSCREEN_UNSUPPORTED);
});
