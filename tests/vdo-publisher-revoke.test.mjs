import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('VDO revocation stops cloned media before delayed SDK cleanup and leaves source capture alive', async () => {
  const source = (await readFile(new URL('../src/transports/vdo-screen-publisher.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace('export function createVdoScreenPublisher', 'function createVdoScreenPublisher');
  let sourceStops = 0, cloneStops = 0, finishClose;
  const clone = { kind: 'video', readyState: 'live', stop: () => cloneStops++ };
  const capture = { active: true, getTracks: () => [{ kind: 'video', readyState: 'live', clone: () => clone, stop: () => sourceStops++ }] };
  const sdkClose = new Promise(resolve => { finishClose = resolve; });
  const create = vm.runInNewContext(source + ';createVdoScreenPublisher;', {
    crypto, DOMException, MediaStream: class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } },
    createVdoTransport: () => ({ publish: async () => {}, close: () => sdkClose }),
    createVdoPublisherDiagnostics: () => ({ start() {}, stop() {}, snapshot() {} }),
  });
  const publisher = create(capture); await publisher.ready;
  const closing = publisher.close();
  assert.equal(cloneStops, 1); assert.equal(sourceStops, 0);
  assert.equal(publisher.close(), closing);
  finishClose(); await closing;
  assert.equal(sourceStops, 0);
});
