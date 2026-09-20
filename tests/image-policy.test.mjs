import assert from 'node:assert/strict';
import test from 'node:test';
import {
  imageDimensionsAllowed,
  imageMagicMatches,
  readImageDimensions,
} from '../src/image-policy.js';

function writeAscii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function png(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeAscii(bytes, 12, 'IHDR');
  bytes[16] = width >>> 24;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = height >>> 24;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function gif(width, height) {
  const bytes = new Uint8Array(10);
  writeAscii(bytes, 0, 'GIF89a');
  bytes[6] = width & 0xff;
  bytes[7] = (width >>> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >>> 8) & 0xff;
  return bytes;
}

function jpeg(width, height) {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  bytes[7] = (height >>> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >>> 8) & 0xff;
  bytes[10] = width & 0xff;
  return bytes;
}

function webpVp8l(width, height) {
  const bytes = new Uint8Array(25);
  writeAscii(bytes, 0, 'RIFF');
  writeAscii(bytes, 8, 'WEBP');
  writeAscii(bytes, 12, 'VP8L');
  bytes[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  bytes[21] = bits & 0xff;
  bytes[22] = (bits >>> 8) & 0xff;
  bytes[23] = (bits >>> 16) & 0xff;
  bytes[24] = (bits >>> 24) & 0xff;
  return bytes;
}

function webpVp8(width, height) {
  const bytes = new Uint8Array(30);
  writeAscii(bytes, 0, 'RIFF');
  writeAscii(bytes, 8, 'WEBP');
  writeAscii(bytes, 12, 'VP8 ');
  bytes.set([0x9d, 0x01, 0x2a], 23);
  bytes[26] = width & 0xff;
  bytes[27] = (width >>> 8) & 0x3f;
  bytes[28] = height & 0xff;
  bytes[29] = (height >>> 8) & 0x3f;
  return bytes;
}

function webpVp8x(width, height) {
  const bytes = new Uint8Array(30);
  writeAscii(bytes, 0, 'RIFF');
  writeAscii(bytes, 8, 'WEBP');
  writeAscii(bytes, 12, 'VP8X');
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >>> 8) & 0xff;
  bytes[26] = (w >>> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >>> 8) & 0xff;
  bytes[29] = (h >>> 16) & 0xff;
  return bytes;
}

test('image magic matches the declared MIME type and rejects forged input', () => {
  assert.equal(imageMagicMatches('image/png', png(1280, 720)), true);
  assert.equal(imageMagicMatches('image/gif', gif(1280, 720)), true);
  assert.equal(imageMagicMatches('image/jpeg', jpeg(1280, 720)), true);
  assert.equal(imageMagicMatches('image/webp', webpVp8(1280, 720)), true);
  assert.equal(imageMagicMatches('image/png', gif(1280, 720)), false);
  assert.equal(imageMagicMatches('image/png', new Uint8Array([0x89, 0x50])), false);
});

test('image dimensions are read from PNG, GIF, JPEG and WebP headers', () => {
  assert.deepEqual(readImageDimensions('image/png', png(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(readImageDimensions('image/gif', gif(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(readImageDimensions('image/jpeg', jpeg(3840, 2160)), { width: 3840, height: 2160 });
  assert.deepEqual(readImageDimensions('image/webp', webpVp8l(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(readImageDimensions('image/webp', webpVp8(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(readImageDimensions('image/webp', webpVp8x(1920, 1080)), { width: 1920, height: 1080 });
  assert.equal(readImageDimensions('image/png', new Uint8Array(4)), null);
});

test('image dimensions reject decompression-bomb sizes', () => {
  assert.equal(imageDimensionsAllowed(1920, 1080), true);
  assert.equal(imageDimensionsAllowed(8192, 4096), true);
  assert.equal(imageDimensionsAllowed(8192, 8192), false);
  assert.equal(imageDimensionsAllowed(9000, 100), false);
  assert.equal(imageDimensionsAllowed(0, 100), false);
  assert.equal(imageDimensionsAllowed(100.5, 100), false);
});