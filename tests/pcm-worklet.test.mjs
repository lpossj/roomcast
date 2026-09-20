import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function createProcessor() {
  const source = await readFile(new URL('../public/roomcast-pcm-worklet.js', import.meta.url), 'utf8');
  let Processor;
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null }; } }
  const context = vm.createContext({
    AudioWorkletProcessor,
    registerProcessor(name, value) { assert.equal(name, 'roomcast-pcm-playout'); Processor = value; },
    Float32Array,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Math,
  });
  vm.runInContext(source, context, { filename: 'roomcast-pcm-worklet.js' });
  return new Processor();
}

function stereoFrame(left, right) {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, left, true);
  view.setInt16(2, right, true);
  return bytes;
}

function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((sum, item) => sum + item.byteLength, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

test('PCM worklet preserves stereo frame bytes across IPC chunk boundaries', async () => {
  const processor = await createProcessor();
  processor.startFrames = 1;
  const frame = stereoFrame(16384, -16384);
  processor.handleMessage({ type: 'pcm-s16le', buffer: frame.slice(0, 3).buffer });
  assert.equal(processor.count, 0);
  processor.handleMessage({ type: 'pcm-s16le', buffer: frame.slice(3).buffer });
  assert.equal(processor.count, 1);
  const left = new Float32Array(1), right = new Float32Array(1);
  processor.rampFrames = 0;
  processor.process([], [[left, right]]);
  assert.ok(Math.abs(left[0] - 0.5) < 0.001);
  assert.ok(Math.abs(right[0] + 0.5) < 0.001);
});

test('PCM worklet waits for prebuffer after underrun instead of hard-cutting scheduled sources', async () => {
  const processor = await createProcessor();
  processor.startFrames = 4;
  const frames = concat(stereoFrame(1000, 1000), stereoFrame(1000, 1000));
  processor.handleMessage({ type: 'pcm-s16le', buffer: frames.buffer });
  const left = new Float32Array(4), right = new Float32Array(4);
  processor.process([], [[left, right]]);
  assert.deepEqual([...left], [0, 0, 0, 0]);
  assert.equal(processor.count, 2);
});

test('PCM worklet bounds stale backlog and keeps the newest audio window', async () => {
  const processor = await createProcessor();
  processor.maxQueuedFrames = 4;
  processor.targetQueuedFrames = 2;
  const frames = concat(
    stereoFrame(1000, 1000), stereoFrame(2000, 2000), stereoFrame(3000, 3000),
    stereoFrame(4000, 4000), stereoFrame(5000, 5000), stereoFrame(6000, 6000),
  );
  processor.handleMessage({ type: 'pcm-s16le', buffer: frames.buffer });
  assert.equal(processor.count, 2);
  assert.ok(Math.abs(processor.left[0] - 5000 / 32768) < 0.001);
  assert.ok(Math.abs(processor.left[1] - 6000 / 32768) < 0.001);
});
