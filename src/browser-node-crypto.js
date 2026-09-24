import { sha256 } from '@noble/hashes/sha2.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

export class Buffer extends Uint8Array {
  static from(value, encoding, length) {
    if (typeof value === 'string') {
      if (encoding === 'hex') return new Buffer(value.match(/.{1,2}/g)?.map(pair => parseInt(pair, 16)) || []);
      if (encoding === 'base64' || encoding === 'base64url') {
        const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
        return new Buffer(Uint8Array.from(raw, character => character.charCodeAt(0)));
      }
      return new Buffer(encoder.encode(value));
    }
    if (value instanceof ArrayBuffer) {
      const offset = Number.isInteger(encoding) ? encoding : 0;
      return new Buffer(value.slice(offset, offset + (length ?? value.byteLength - offset)));
    }
    return new Buffer(value);
  }
  static isBuffer(value) { return value instanceof Buffer; }
  static byteLength(value) { return encoder.encode(String(value)).length; }
  toString(encoding = 'utf8') {
    if (encoding === 'hex') return hex(this);
    if (encoding === 'base64' || encoding === 'base64url') {
      const encoded = btoa(String.fromCharCode(...this));
      return encoding === 'base64url' ? encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : encoded;
    }
    if (encoding === 'ascii') return String.fromCharCode(...this);
    return decoder.decode(this);
  }
  subarray(start, end) { return new Buffer(super.subarray(start, end)); }
  equals(other) { return other?.length === this.length && this.every((byte, index) => byte === other[index]); }
}

export const randomBytes = size => Buffer.from(crypto.getRandomValues(new Uint8Array(size)));
export const randomUUID = () => crypto.randomUUID();
export const timingSafeEqual = (left, right) => {
  if (left.length !== right.length) throw new Error('Byte lengths differ');
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left[index] ^ right[index];
  return different === 0;
};
export const createHash = name => {
  if (name !== 'sha256') throw new Error('Unsupported digest');
  let value;
  return {
    update(input) { value = typeof input === 'string' ? encoder.encode(input) : input; return this; },
    digest(encoding) { const result = Buffer.from(sha256(value)); return encoding ? result.toString(encoding) : result; },
  };
};
export const scrypt = (password, salt, keyLength, callback) => {
  scryptAsync(password, salt, { N: 16384, r: 8, p: 1, dkLen: keyLength }).then(value => callback(null, Buffer.from(value)), callback);
};
export const promisify = callbackFunction => (...args) => new Promise((resolve, reject) => {
  callbackFunction(...args, (error, value) => error ? reject(error) : resolve(value));
});
