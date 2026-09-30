import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { imageDimensionsAllowed, imageMagicMatches, readImageDimensions } from '../src/image-policy.js';

const source = await readFile(new URL('../src/useRoom.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
const gif = Uint8Array.from([71, 73, 70, 56, 57, 97, 10, 0, 10, 0]);
const file = () => Object.assign(new Blob([gif], { type: 'image/gif' }), { name: 'picture.gif' });

function receiver() {
  const incomingImagesRef = { current: new Map() }, stored = [];
  const helpers = source.slice(source.indexOf('  const discardIncomingImage ='), source.indexOf('  const clearMessages ='));
  const callbacks = source.slice(source.indexOf('  const receiveImageStart ='), source.indexOf('  const receiveRoom ='));
  const header = source.slice(source.indexOf('const MAX_IMAGE_HEADER_BYTES'), source.indexOf('export default'));
  const api = vm.runInNewContext(`${header}\n${helpers}\n${callbacks}\n;({receiveImageStart,receiveImageChunk,receiveImageComplete,receiveImageAbort,discardIncomingImage});`, {
    useCallback: fn => fn, incomingImagesRef, setTimeout, clearTimeout, Uint8Array, ArrayBuffer, Blob,
    imageDimensionsAllowed, imageMagicMatches, readImageDimensions,
    URL: { createObjectURL: () => 'blob:received', revokeObjectURL() {} }, revokeImageUrl() {},
    storeImageUrl: (...args) => { stored.push(args); return true; }, setMessages: update => update([]),
    messagesRef: { current: [] }, errorRef: { current: message => assert.fail(message) },
  });
  return { ...api, incomingImagesRef, stored };
}

test('receiver accepts simultaneous senders within the room cap and expires unfinished images', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = receiver();
  for (let i = 0; i < 19; i++) h.receiveImageStart({ messageId: String(i), mime: 'image/gif', size: gif.length });
  assert.equal(h.incomingImagesRef.current.size, 18);
  h.receiveImageStart({ messageId: '0', mime: 'image/gif', size: gif.length });
  t.mock.timers.tick(59_999); assert.equal(h.incomingImagesRef.current.size, 18);
  t.mock.timers.tick(1); assert.equal(h.incomingImagesRef.current.size, 0);
  h.receiveImageStart({ messageId: 'new', mime: 'image/gif', size: gif.length });
  assert.equal(h.incomingImagesRef.current.size, 1);
  h.receiveImageAbort({ messageId: 'new' });
});

test('completion, abort and invalid chunks release receiver buffers and timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = receiver();
  for (const id of ['complete', 'abort', 'invalid']) h.receiveImageStart({ messageId: id, mime: 'image/gif', size: gif.length });
  h.receiveImageChunk({ messageId: 'complete', index: 0, data: gif.buffer });
  h.receiveImageComplete({ messageId: 'complete' });
  assert.equal(h.stored.length, 1);
  h.receiveImageAbort({ messageId: 'abort' });
  h.receiveImageChunk({ messageId: 'invalid', index: 1, data: gif.buffer });
  assert.equal(h.incomingImagesRef.current.size, 0);
  t.mock.timers.tick(60_000); assert.equal(h.incomingImagesRef.current.size, 0);
});

function sender(ackImpl) {
  const socketRef = { current: { connected: true, id: 'old' } }, merged = [], urls = [];
  const callbacks = source.slice(source.indexOf('  const sendImage ='), source.indexOf('  useEffect(', source.indexOf('  const sendImages =')));
  const api = vm.runInNewContext(`${callbacks};({sendImage,sendImages});`, {
    useCallback: fn => fn, socketRef, Blob, Uint8Array, setTimeout, crypto,
    ack: (...args) => ackImpl(...args), mergeMessages: value => merged.push(value), storeImageUrl: () => true,
    revokeImageUrl() {}, URL: { createObjectURL: value => { urls.push(value); return 'blob:sent'; }, revokeObjectURL() {} },
  });
  return { ...api, socketRef, merged, urls };
}

test('changing rooms while reading the image header sends no data to the next room', async () => {
  const header = deferred(), calls = [];
  const h = sender((...args) => calls.push(args));
  const image = file(); image.slice = () => ({ arrayBuffer: () => header.promise });
  const pending = h.sendImage(image);
  h.socketRef.current = { connected: true, id: 'new' };
  header.resolve(gif.buffer);
  await assert.rejects(pending, /房间连接已变化/);
  assert.equal(calls.length, 0); assert.equal(h.urls.length, 0);
});

test('late upload completion cannot update the next room or continue a multi-image batch', async () => {
  const calls = [];
  let h;
  h = sender(async (socket, event) => {
    calls.push([socket.id, event]);
    if (event === 'image:init') return { uploadId: 'upload' };
    if (event === 'image:complete') {
      h.socketRef.current = { connected: true, id: 'new' };
      return { imageId: 'old-image', message: { id: 'old-message', seq: 1 } };
    }
    return {};
  });
  await assert.rejects(h.sendImages([file(), file()]), /房间连接已变化/);
  assert.equal(calls.filter(([, event]) => event === 'image:init').length, 1);
  assert.ok(calls.every(([id]) => id === 'old'));
  assert.equal(h.merged.length, 0); assert.equal(h.urls.length, 0);
});

test('image preparation finishing after departure does not add previews to the next room', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const block = app.slice(app.indexOf('  const stageImages ='), app.indexOf('  const chooseImage ='));
  const shrink = deferred(), socketRef = { current: { id: 'old' } }, roomAction = { current: 1 }, activeRoomId = { current: 'old' };
  let added = 0, urls = 0;
  const stageImages = vm.runInNewContext(`${block};stageImages;`, {
    useCallback: fn => fn, room: { id: 'old' }, socketRef, roomAction, activeRoomId, sendingImage: false,
    pendingImagesRef: { current: [] }, MAX_CHAT_IMAGES: 4, notify() {}, shrinkForSharing: () => shrink.promise,
    setPendingImages: () => added++, URL: { createObjectURL: () => { urls++; } },
  });
  stageImages([file()]); socketRef.current = { id: 'new' }; roomAction.current++; activeRoomId.current = 'new';
  shrink.resolve(file()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(added, 0); assert.equal(urls, 0);
});
