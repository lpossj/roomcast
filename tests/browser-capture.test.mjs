import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCapabilities, normalizeBrowserShareSettings } from '../src/browser-capabilities.js';
import { startCameraCapture } from '../src/browser-capture.js';
import { startIntegratedCapture } from '../src/lib.js';

const scope = () => ({ isSecureContext: true, RTCPeerConnection() {}, WebSocket() {}, crypto: { getRandomValues() {}, subtle: {} }, navigator: { mediaDevices: { getUserMedia() {}, getDisplayMedia() {} } } });
test('browser capabilities hide unsupported, insecure, policy-blocked and denied camera entries', () => {
  assert.deepEqual(browserCapabilities(scope()), { host: true, screen: true, camera: true, microphone: true });
  assert.deepEqual(browserCapabilities({ ...scope(), isSecureContext: false }), { host: false, screen: false, camera: false, microphone: false });
  const phone = scope(); delete phone.navigator.mediaDevices.getDisplayMedia;
  assert.equal(browserCapabilities(phone).screen, false);
  assert.equal(browserCapabilities(phone).camera, true);
  assert.equal(browserCapabilities(phone, 'denied').camera, false);
  phone.document = { permissionsPolicy: { allowsFeature: feature => !['camera', 'microphone'].includes(feature) } };
  assert.equal(browserCapabilities(phone).camera, false);
  assert.equal(browserCapabilities(phone).microphone, false);
  assert.equal(browserCapabilities({ ...scope(), WebSocket: undefined }).host, false);
});
test('browser settings discard native application audio and choose only supported sources', () => {
  const caps = browserCapabilities(scope());
  const previous = { captureBackend: 'obs', sourceType: 'window', audioSourceId: '123', audioMode: 'exclude-microphone' };
  const screen = normalizeBrowserShareSettings(previous, caps);
  assert.equal(screen.sourceType, 'monitor'); assert.equal(screen.sourceId, 'browser');
  assert.equal(screen.audioMode, 'microphone'); assert.equal(screen.audioSourceId, '');
  const camera = normalizeBrowserShareSettings({ ...previous, audioMode: 'system-microphone' }, { ...caps, screen: false });
  assert.equal(camera.sourceType, 'camera'); assert.equal(camera.audioMode, 'microphone');
  assert.equal(normalizeBrowserShareSettings(camera, { ...caps, camera: false, microphone: false }).audioMode, 'none');
  assert.equal(normalizeBrowserShareSettings(previous, { ...caps, screen: false, camera: false }).sourceId, '');
});

function install(t, devices) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const view = scope(); view.navigator.mediaDevices = devices;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: view });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: view.navigator });
  t.after(() => { for (const [key, previous] of [['window', oldWindow], ['navigator', oldNavigator]]) {
    if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key];
  } });
}
function streamFixture({ video = true } = {}) {
  const videoTrack = { contentHint: '', stopped: false, stop() { this.stopped = true; }, async applyConstraints(value) { this.constraints = value; } };
  const audioTrack = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  return { videoTrack, audioTrack, stream: { getTracks: () => video ? [videoTrack, audioTrack] : [audioTrack], getVideoTracks: () => video ? [videoTrack] : [], getAudioTracks: () => [audioTrack] } };
}
test('camera request starts immediately, uses device ideals, mutes microphone and cleans up every track', async t => {
  const fixture = streamFixture(); let requested;
  install(t, { getUserMedia(options) { requested = options; return Promise.resolve(fixture.stream); } });
  const pending = startCameraCapture({ width: 1280, height: 720, fps: 30, facingMode: 'environment', microphone: true, microphoneMuted: true });
  assert.equal(requested.video.facingMode.ideal, 'environment');
  assert.deepEqual(requested.video.frameRate, { ideal: 30, max: 30 });
  const stream = await pending;
  assert.equal(fixture.audioTrack.enabled, false); assert.equal(fixture.videoTrack.contentHint, 'motion');
  stream.roomcastCleanup(); stream.roomcastCleanup();
  assert.equal(fixture.audioTrack.stopped, true); assert.equal(fixture.videoTrack.stopped, true);
});
test('camera refusal and missing video cannot leave partial tracks running', async t => {
  const fixture = streamFixture({ video: false }); let rejected = false;
  install(t, { getUserMedia() { return rejected ? Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) : Promise.resolve(fixture.stream); } });
  await assert.rejects(startCameraCapture(), /未获得摄像头/);
  assert.equal(fixture.audioTrack.stopped, true);
  rejected = true; await assert.rejects(startCameraCapture(), /权限未开启/);
});
test('browser display capture publishes native tracks without canvas-only Chromium requirements', async t => {
  const fixture = streamFixture(); let requested;
  install(t, { getDisplayMedia(options) { requested = options; return Promise.resolve(fixture.stream); } });
  const pending = startIntegratedCapture({ fps: 60, systemAudio: true });
  assert.equal(requested.audio, true);
  const stream = await pending;
  assert.equal(stream, fixture.stream); assert.deepEqual(fixture.videoTrack.constraints.frameRate, { ideal: 60, max: 60 });
  stream.roomcastCleanup(); assert.equal(fixture.videoTrack.stopped, true); assert.equal(fixture.audioTrack.stopped, true);
});
