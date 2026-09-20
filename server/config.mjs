import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig(overrides = {}) {
  const rootDir = overrides.rootDir || process.env.ROOMCAST_DATA_DIR || projectDir;
  dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });
  const port = Number(process.env.PORT || 3210);
  const turn = process.env.TURN_URL?.trim();
  return {
    rootDir, staticDir: path.join(projectDir, 'dist'), host: process.env.HOST || '127.0.0.1', port,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    iceServers: turn ? [{ urls: turn, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' }] : [{ urls: 'stun:stun.cloudflare.com:3478' }],
    peerServer: process.env.PEER_SERVER_URL || '',
    turnUrls: (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
    turnSharedSecret: process.env.TURN_SHARED_SECRET || '',
    createKey: process.env.SERVER_CREATE_KEY || '',
    tlsCert: process.env.TLS_CERT || '', tlsKey: process.env.TLS_KEY || '',
    ...overrides,
  };
}
export function addresses(port, secure = false) {
  const ips = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  const priority = ip => ip.startsWith('100.') ? 2 : 1;
  ips.sort((a, b) => priority(b) - priority(a));
  return [...new Set(ips)].map(ip => `${secure ? 'https' : 'http'}://${ip}:${port}`);
}
export const isLoopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
export function isLoopbackHost(host) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${host}`).hostname); } catch { return false; }
}
