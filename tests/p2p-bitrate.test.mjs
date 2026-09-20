import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/p2p.js', import.meta.url), 'utf8');
const start = source.indexOf('function lockVideoBitrate(');
const end = source.indexOf('\nconst withTimeout', start);
assert.ok(start >= 0 && end > start);
const applyBitrate = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
const audio = 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1';
const video = 'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 profile-level-id=42e01f;packetization-mode=1;x-google-min-bitrate=4500;x-google-max-bitrate=4500\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtpmap:98 VP8/90000\r\na=framerate:60\r\na=rtcp-fb:96 nack\r\na=rtcp-fb:96 nack pli';

test('P2P bitrate caps preserve codec, RTX, feedback, audio and FPS without a congestion floor', () => {
  const result = applyBitrate(`${audio}\r\n${video}`, 8000);
  assert.ok(result.startsWith(`${audio}\r\n`));
  assert.doesNotMatch(result, /x-google-min-bitrate/i);
  assert.match(result, /b=AS:8000\r\nb=TIAS:8000000/);
  assert.match(result, /profile-level-id=42e01f;packetization-mode=1;x-google-start-bitrate=8000;x-google-max-bitrate=8000/);
  assert.match(result, /a=fmtp:97 apt=96/);
  assert.match(result, /a=fmtp:98 x-google-start-bitrate=8000;x-google-max-bitrate=8000/);
  assert.match(result, /a=framerate:60/);
  assert.match(result, /a=rtcp-fb:96 nack\r\na=rtcp-fb:96 nack pli/);
});

test('reapplying the bitrate target does not duplicate controls or revive stale limits', () => {
  const first = applyBitrate(video, 4500);
  assert.equal(applyBitrate(first, 4500), first);
  const changed = applyBitrate(first, 12000);
  assert.doesNotMatch(changed, /4500|min-bitrate/);
  assert.equal((changed.match(/x-google-max-bitrate=12000/g) || []).length, 2);
  assert.equal((changed.match(/b=AS:/g) || []).length, 1);
});

test('an SDP without video remains unchanged', () => {
  assert.equal(applyBitrate(audio, 8000), audio);
});
