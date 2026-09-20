export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
export const MAX_IMAGE_CACHE_BYTES = 128 * 1024 * 1024;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function ascii(bytes, offset, length) {
  if (offset + length > bytes.length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint16be(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint16le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32be(bytes, offset) {
  return (
    (bytes[offset] * 0x1000000)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]
  );
}

export function imageMagicMatches(mime, value) {
  const bytes = toBytes(value);
  if (!bytes || !IMAGE_TYPES.has(mime)) return false;

  if (mime === 'image/jpeg') {
    return bytes.length >= 3
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[2] === 0xff;
  }

  if (mime === 'image/png') {
    return bytes.length >= 8
      && bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a;
  }

  if (mime === 'image/gif') {
    return bytes.length >= 6
      && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6));
  }

  return bytes.length >= 12
    && ascii(bytes, 0, 4) === 'RIFF'
    && ascii(bytes, 8, 4) === 'WEBP';
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  return {
    width: uint32be(bytes, 16),
    height: uint32be(bytes, 20),
  };
}

function gifDimensions(bytes) {
  if (bytes.length < 10) return null;
  return {
    width: uint16le(bytes, 6),
    height: uint16le(bytes, 8),
  };
}

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let marker = bytes[offset + 1];
    offset += 2;

    while (marker === 0xff && offset < bytes.length) {
      marker = bytes[offset];
      offset += 1;
    }

    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 1 >= bytes.length) return null;

    const length = uint16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;

    if (SOF_MARKERS.has(marker)) {
      if (length < 7) return null;
      return {
        height: uint16be(bytes, offset + 3),
        width: uint16be(bytes, offset + 5),
      };
    }

    offset += length;
  }

  return null;
}

function webpDimensions(bytes) {
  if (bytes.length < 16) return null;
  const type = ascii(bytes, 12, 4);

  if (type === 'VP8X') {
    if (bytes.length < 30) return null;
    return {
      width: 1 + uint24le(bytes, 24),
      height: 1 + uint24le(bytes, 27),
    };
  }

  if (type === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = bytes[21]
      | (bytes[22] << 8)
      | (bytes[23] << 16)
      | (bytes[24] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }

  if (type === 'VP8 ') {
    if (
      bytes.length < 30
      || bytes[23] !== 0x9d
      || bytes[24] !== 0x01
      || bytes[25] !== 0x2a
    ) return null;
    return {
      width: uint16le(bytes, 26) & 0x3fff,
      height: uint16le(bytes, 28) & 0x3fff,
    };
  }

  return null;
}

export function readImageDimensions(mime, value) {
  const bytes = toBytes(value);
  if (!bytes || !imageMagicMatches(mime, bytes)) return null;

  if (mime === 'image/png') return pngDimensions(bytes);
  if (mime === 'image/gif') return gifDimensions(bytes);
  if (mime === 'image/jpeg') return jpegDimensions(bytes);
  if (mime === 'image/webp') return webpDimensions(bytes);
  return null;
}

export function imageDimensionsAllowed(width, height) {
  return Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && width >= 1
    && height >= 1
    && width <= MAX_IMAGE_DIMENSION
    && height <= MAX_IMAGE_DIMENSION
    && width * height <= MAX_IMAGE_PIXELS;
}