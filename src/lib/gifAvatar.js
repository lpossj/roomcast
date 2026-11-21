import { MAX_AVATAR_LENGTH } from '../../server/avatar-policy.mjs';

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 15-bit median-cut quantizer reserving index 255 for transparency.
 */
function quantizeFrameRgba(rgba, pixelCount) {
  const counts = new Uint32Array(32768);
  const keys = [];

  for (let i = 0; i < pixelCount; i += 1) {
    const off = i * 4;
    if (rgba[off + 3] < 128) continue;
    const key = ((rgba[off] >> 3) << 10) | ((rgba[off + 1] >> 3) << 5) | (rgba[off + 2] >> 3);
    if (counts[key] === 0) keys.push(key);
    counts[key] += 1;
  }

  const palette = new Uint8Array(256 * 3);
  const keyToIndex = new Uint8Array(32768);

  if (keys.length === 0) {
    return { palette, indices: new Uint8Array(pixelCount).fill(255) };
  }

  const boxes = [keys];
  while (boxes.length < 255) {
    let bestIdx = -1;
    let bestScore = 0;
    let bestChannel = 0;

    for (let b = 0; b < boxes.length; b += 1) {
      const box = boxes[b];
      if (box.length <= 1) continue;
      let rMin = 31, rMax = 0, gMin = 31, gMax = 0, bMin = 31, bMax = 0;
      for (let i = 0; i < box.length; i += 1) {
        const k = box[i];
        const r = (k >> 10) & 31;
        const g = (k >> 5) & 31;
        const bl = k & 31;
        if (r < rMin) rMin = r; if (r > rMax) rMax = r;
        if (g < gMin) gMin = g; if (g > gMax) gMax = g;
        if (bl < bMin) bMin = bl; if (bl > bMax) bMax = bl;
      }
      const rSpan = rMax - rMin;
      const gSpan = gMax - gMin;
      const bSpan = bMax - bMin;
      const span = Math.max(rSpan, gSpan, bSpan);
      if (span > bestScore) {
        bestScore = span;
        bestIdx = b;
        bestChannel = span === rSpan ? 0 : span === gSpan ? 1 : 2;
      }
    }

    if (bestIdx === -1 || bestScore === 0) break;
    const target = boxes[bestIdx];
    const shift = bestChannel === 0 ? 10 : bestChannel === 1 ? 5 : 0;
    target.sort((a, b) => ((a >> shift) & 31) - ((b >> shift) & 31));
    const mid = Math.max(1, target.length >> 1);
    boxes.splice(bestIdx, 1, target.slice(0, mid), target.slice(mid));
  }

  for (let b = 0; b < boxes.length; b += 1) {
    const box = boxes[b];
    let rSum = 0, gSum = 0, bSum = 0, total = 0;
    for (let i = 0; i < box.length; i += 1) {
      const k = box[i];
      const c = counts[k];
      rSum += (((k >> 10) & 31) * 255 / 31) * c;
      gSum += (((k >> 5) & 31) * 255 / 31) * c;
      bSum += ((k & 31) * 255 / 31) * c;
      total += c;
      keyToIndex[k] = b;
    }
    if (total > 0) {
      palette[b * 3] = Math.round(rSum / total);
      palette[b * 3 + 1] = Math.round(gSum / total);
      palette[b * 3 + 2] = Math.round(bSum / total);
    }
  }

  const indices = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const off = i * 4;
    if (rgba[off + 3] < 128) {
      indices[i] = 255;
    } else {
      const key = ((rgba[off] >> 3) << 10) | ((rgba[off + 1] >> 3) << 5) | (rgba[off + 2] >> 3);
      indices[i] = keyToIndex[key];
    }
  }

  return { palette, indices };
}

function lzwEncode(indices) {
  const clearCode = 256;
  const eoiCode = 257;
  const out = [];
  let bitBuf = 0;
  let bitLen = 0;

  const emit = (code, size) => {
    bitBuf |= code << bitLen;
    bitLen += size;
    while (bitLen >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitLen -= 8;
    }
  };

  let codeSize = 9;
  let nextCode = 258;
  let limit = 512;
  const reset = () => {
    codeSize = 9;
    nextCode = 258;
    limit = 512;
  };
  let dict = new Map();

  emit(clearCode, codeSize);
  let prefix = indices[0];

  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const pair = (prefix << 8) | k;
    const hit = dict.get(pair);
    if (hit !== undefined) {
      prefix = hit;
    } else {
      emit(prefix, codeSize);
      if (nextCode < 4096) {
        dict.set(pair, nextCode);
        nextCode += 1;
        if (nextCode > limit && codeSize < 12) {
          codeSize += 1;
          limit <<= 1;
        }
      } else {
        emit(clearCode, codeSize);
        dict = new Map();
        reset();
      }
      prefix = k;
    }
  }

  emit(prefix, codeSize);
  emit(eoiCode, codeSize);
  if (bitLen > 0) out.push(bitBuf & 0xff);

  return new Uint8Array(out);
}

/**
 * Encodes RGBA frames into a looping animated GIF89a byte array.
 */
export function encodeAnimatedGif(frames, width, height) {
  const chunks = [];
  const push = arr => chunks.push(arr instanceof Uint8Array ? arr : new Uint8Array(arr));

  // Header + Logical Screen Descriptor (no GCT)
  push([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    width & 0xff, (width >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
    0x77, 0xff, 0x00,
  ]);

  // NETSCAPE2.0 infinite loop block
  push([
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01, 0x00, 0x00, 0x00,
  ]);

  const pixelCount = width * height;
  for (const frame of frames) {
    const delayCs = Math.max(2, Math.min(65535, Math.round(frame.delayCs || 8)));
    // Graphics Control Extension: disposal = 2 (restore background), transparent flag = 1, index = 255
    push([
      0x21, 0xf9, 0x04, 0x09,
      delayCs & 0xff, (delayCs >> 8) & 0xff,
      0xff, 0x00,
    ]);

    // Image Descriptor with Local Color Table (256 colors)
    push([
      0x2c,
      0x00, 0x00, 0x00, 0x00,
      width & 0xff, (width >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
      0x87,
    ]);

    const { palette, indices } = quantizeFrameRgba(frame.rgba, pixelCount);
    push(palette);

    const compressed = lzwEncode(indices);
    push([0x08]); // LZW minimum code size
    for (let offset = 0; offset < compressed.length; offset += 255) {
      const slice = compressed.subarray(offset, offset + 255);
      push([slice.length]);
      push(slice);
    }
    push([0x00]); // Sub-block terminator
  }

  push([0x3b]); // GIF Trailer

  let total = 0;
  for (const c of chunks) total += c.length;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    result.set(c, pos);
    pos += c.length;
  }
  return result;
}

function sampleFrameIndices(totalFrames, maxFrames) {
  if (totalFrames <= maxFrames) {
    return Array.from({ length: totalFrames }, (_, i) => i);
  }
  const picked = [];
  const step = totalFrames / maxFrames;
  for (let i = 0; i < maxFrames; i += 1) {
    picked.push(Math.min(totalFrames - 1, Math.floor(i * step)));
  }
  return picked;
}

/**
 * Decodes an oversized GIF via WebCodecs ImageDecoder and re-encodes it
 * into a compact square animated GIF data URL within maxBase64Length.
 */
export async function compressAnimatedGif(bytes, maxBase64Length = MAX_AVATAR_LENGTH) {
  if (typeof globalThis.ImageDecoder !== 'function') {
    throw new Error('GIF 动图体积过大，请先压缩至 120 KB 以内再上传。');
  }

  const decoder = new globalThis.ImageDecoder({
    data: bytes,
    type: 'image/gif',
  });

  try {
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const frameCount = Math.max(1, track?.frameCount || 1);

    const rawFrames = [];
    for (let i = 0; i < frameCount; i += 1) {
      const decoded = await decoder.decode({ frameIndex: i });
      const vf = decoded.image;
      const durationUs = Number(vf.duration || 0);
      rawFrames.push({
        vf,
        delayCs: durationUs > 0 ? Math.max(2, Math.round(durationUs / 10000)) : 8,
      });
    }

    const attempts = [
      { size: 96, maxFrames: 28 },
      { size: 80, maxFrames: 22 },
      { size: 64, maxFrames: 18 },
      { size: 52, maxFrames: 14 },
    ];

    try {
      for (const { size, maxFrames } of attempts) {
        const picked = sampleFrameIndices(rawFrames.length, maxFrames);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const frames = [];
        for (let idx = 0; idx < picked.length; idx += 1) {
          const start = picked[idx];
          const end = idx + 1 < picked.length ? picked[idx + 1] : rawFrames.length;
          let delayCs = 0;
          for (let j = start; j < end; j += 1) delayCs += rawFrames[j].delayCs;

          const { vf } = rawFrames[start];
          const vw = vf.displayWidth || vf.codedWidth || size;
          const vh = vf.displayHeight || vf.codedHeight || size;
          const edge = Math.min(vw, vh);
          const sx = Math.max(0, (vw - edge) / 2);
          const sy = Math.max(0, (vh - edge) / 2);

          ctx.clearRect(0, 0, size, size);
          ctx.drawImage(vf, sx, sy, edge, edge, 0, 0, size, size);
          const imgData = ctx.getImageData(0, 0, size, size);
          frames.push({ rgba: imgData.data, delayCs });
        }

        const gifBytes = encodeAnimatedGif(frames, size, size);
        const dataUrl = `data:image/gif;base64,${bytesToBase64(gifBytes)}`;
        if (dataUrl.length <= maxBase64Length) {
          return dataUrl;
        }
      }
    } finally {
      for (const item of rawFrames) {
        try { item.vf.close(); } catch { }
      }
    }
  } finally {
    try { decoder.close(); } catch { }
  }

  throw new Error('GIF 动图帧数或细节过多，压缩后仍超过约 120 KB 上限，请换一张更小的动图。');
}

export function fileBytesToGifDataUrl(bytes) {
  return `data:image/gif;base64,${bytesToBase64(bytes)}`;
}
