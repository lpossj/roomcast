export const PEER_AUTH_PROTOCOL = 2;
export const PEER_AUTH_TIMEOUT_MS = 8_000;
export const MAX_UNAUTHENTICATED_PEERS = 6;

const ROOM_ID = /^[A-F0-9]{8}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function randomPeerAuthNonce() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function authMessage({ roomId, nonce, mode }) {
  if (!ROOM_ID.test(roomId || '') || !NONCE.test(nonce || '') || mode !== 'invite') throw new Error('P2P 鉴权参数无效。');
  return new TextEncoder().encode(`roomcast-peer-auth-v${PEER_AUTH_PROTOCOL}\n${roomId}\n${mode}\n${nonce}`);
}

async function hmacKey(secret, usage) {
  if (typeof secret !== 'string' || !secret || secret.length > 128) throw new Error('P2P 鉴权密钥无效。');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

export async function createPeerAuthProof(secret, challenge) {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), authMessage(challenge));
  return base64Url(new Uint8Array(signature));
}

export async function verifyPeerAuthProof(secret, challenge, proof) {
  if (!PROOF.test(proof || '')) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), fromBase64Url(proof), authMessage(challenge));
  } catch {
    return false;
  }
}
