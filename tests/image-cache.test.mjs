import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { MAX_IMAGE_CACHE_BYTES, readImageDimensions } from '../src/image-policy.js';

// Exercise the actual hook callbacks with deterministic React state and ObjectURLs.
const source = await readFile(new URL('../src/useRoom.js', import.meta.url), 'utf8');
const callbacks = source.slice(source.indexOf('  const revokeImageUrl ='), source.indexOf('  const mergeMessages ='));
function harness(messages = []) {
  const revoked = [];
  const imageUrlsRef = { current: new Map() }, imageUrlSizesRef = { current: new Map() };
  const imageCacheBytesRef = { current: 0 }, messagesRef = { current: messages };
  const api = vm.runInNewContext(callbacks + ';({storeImageUrl,revokeImageUrl});', {
    useCallback: fn => fn,
    URL: { revokeObjectURL: url => revoked.push(url) },
    MAX_IMAGE_CACHE_BYTES, imageUrlsRef, imageUrlSizesRef, imageCacheBytesRef, messagesRef,
    setMessages: update => { messagesRef.current = update(messagesRef.current); },
  });
  return { ...api, revoked, imageUrlsRef, imageCacheBytesRef, messagesRef };
}

test('cache accepts newer images after reaching its cap and clears evicted message URLs', () => {
  const h = harness([{ id: '0', objectUrl: 'blob:0' }, { id: 'batch', images: [{ id: '1', objectUrl: 'blob:1' }] }]);
  for (let i = 0; i < 14; i++) assert.equal(h.storeImageUrl(String(i), `blob:${i}`, 10 * 1024 * 1024), true);
  assert.equal(h.imageCacheBytesRef.current, 120 * 1024 * 1024);
  assert.deepEqual(h.revoked, ['blob:0', 'blob:1']);
  assert.equal(h.messagesRef.current[0].objectUrl, undefined);
  assert.equal(h.messagesRef.current[1].images[0].objectUrl, undefined);
  assert.equal(h.imageUrlsRef.current.get('13'), 'blob:13');
});

test('replacing and recalling an image keep accounting correct', () => {
  const h = harness();
  h.storeImageUrl('a', 'blob:old', 60);
  h.storeImageUrl('a', 'blob:new', 20);
  assert.equal(h.imageCacheBytesRef.current, 20);
  assert.deepEqual(h.revoked, ['blob:old']);
  h.revokeImageUrl('a'); h.revokeImageUrl('a');
  assert.equal(h.imageCacheBytesRef.current, 0);
  assert.deepEqual(h.revoked, ['blob:old', 'blob:new']);
});

test('an oversized item does not evict valid cached images or lose an existing copy', () => {
  const h = harness();
  h.storeImageUrl('a', 'blob:a', 10);
  assert.equal(h.storeImageUrl('a', 'blob:too-big', MAX_IMAGE_CACHE_BYTES + 1), false);
  assert.equal(h.imageUrlsRef.current.get('a'), 'blob:a');
  assert.equal(h.imageCacheBytesRef.current, 10);
  assert.deepEqual(h.revoked, []);
});

test('receive header assembly retains JPEG dimensions after large metadata, within the upload cap', () => {
  const headerSource = source.slice(source.indexOf('const MAX_IMAGE_HEADER_BYTES'), source.indexOf('export default'));
  const assemble = vm.runInNewContext(headerSource + ';imageHeaderBytes;', { Uint8Array });
  const app = Buffer.alloc(65537);
  app.set([255, 225, 255, 255]);
  const bytes = Buffer.concat([
    Buffer.from([255, 216]), ...Array(5).fill(app),
    Buffer.from([255, 192, 0, 11, 8, 0, 100, 0, 200, 1, 1, 17, 0]),
  ]);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
    chunks.push(Uint8Array.from(bytes.subarray(offset, offset + 48 * 1024)).buffer);
  }
  const assembled = assemble(chunks);
  assert.equal(assembled.byteLength, bytes.length);
  assert.deepEqual(readImageDimensions('image/jpeg', assembled), { width: 200, height: 100 });
  assert.equal(assemble([new ArrayBuffer(11 * 1024 * 1024)]).byteLength, 10 * 1024 * 1024);
});
