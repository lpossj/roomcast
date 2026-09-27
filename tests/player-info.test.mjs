import assert from 'node:assert/strict';
import test from 'node:test';
import { playerInfo } from '../src/player-info.js';

test('player information uses existing metrics and the three actual media labels', () => {
  const metrics = { width: 1920, height: 1080, fps: 59.7, bitrate: 12345.4, route: 'P2P直连' };
  assert.deepEqual(playerInfo(metrics), { resolution: '1920×1080', fps: '60 FPS', bitrate: '12345 Kbps', route: 'P2P' });
  assert.equal(playerInfo({ ...metrics, route: 'VDO' }).route, 'VDO');
  assert.equal(playerInfo({ ...metrics, route: 'TURN连接中' }).route, 'TURN');
  assert.equal(playerInfo({ ...metrics, source: 'capture' }).route, '—');
  assert.deepEqual(playerInfo({ width: NaN, fps: Infinity }), { resolution: '—', fps: '— FPS', bitrate: '— Kbps', route: '—' });
  assert.equal(metrics.route, 'P2P直连');
});
