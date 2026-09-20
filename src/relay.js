export const RELAY_STORAGE_KEY = 'roomcast.relaySettings';
import { loadPreference, savePreference } from './preferences.js';
import { normalizeWorkerOrigin } from '../electron/worker-origin.mjs';

const base64UrlEncode = text => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlDecode = value => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
};

export function loadRelaySettings() {
  try {
    const value = loadPreference('relaySettings', {}, RELAY_STORAGE_KEY);
    return { enabled: value.enabled === true, endpoint: String(value.endpoint || ''), accessKey: String(value.accessKey || '') };
  } catch { return { enabled: false, endpoint: '', accessKey: '' }; }
}

export function saveRelaySettings(value) {
  savePreference('relaySettings', { enabled: value.enabled === true, endpoint: String(value.endpoint || '').trim(), accessKey: String(value.accessKey || '') });
}

function sanitizeIceServers(value) {
  if (!Array.isArray(value)) throw new Error('中继服务没有返回 ICE 服务器列表。');
  const clean = [];
  for (const item of value.slice(0, 8)) {
    const priority = url => /^stun:/i.test(url) ? 0 : /^turn:/i.test(url) && !/transport=tcp/i.test(url) ? 1 : /^turn:/i.test(url) ? 2 : 3;
    const urls = (Array.isArray(item?.urls) ? item.urls : [item?.urls]).filter(url => typeof url === 'string' && /^(stun|turn|turns):/i.test(url) && url.length <= 512).sort((left, right) => priority(left) - priority(right));
    if (!urls.length) continue;
    const server = { urls: urls.length === 1 ? urls[0] : urls };
    if (urls.some(url => /^turns?:/i.test(url))) {
      if (typeof item.username !== 'string' || typeof item.credential !== 'string' || item.username.length > 512 || item.credential.length > 512) continue;
      server.username = item.username; server.credential = item.credential;
    }
    clean.push(server);
  }
  if (!clean.some(item => (Array.isArray(item.urls) ? item.urls : [item.urls]).some(url => /^turns?:/i.test(url)))) throw new Error('中继服务没有返回可用的 TURN 地址。');
  const priority = item => {
    const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
    return Math.min(...urls.map(url => /^stun:/i.test(url) ? 0 : /^turn:/i.test(url) && !/transport=tcp/i.test(url) ? 1 : /^turn:/i.test(url) ? 2 : 3));
  };
  return clean.sort((left, right) => priority(left) - priority(right));
}

export async function fetchRelayIce(settings, fetcher = fetch) {
  if (!settings?.enabled) return [];
  const origin = normalizeWorkerOrigin(settings.endpoint);
  if (!origin) throw new Error('Worker 地址必须是无账号、端口、路径、查询或片段的 HTTPS 域名。');
  if (typeof window !== 'undefined' && window.roomcast?.fetchRelayIce) {
    const result = await window.roomcast.fetchRelayIce({ endpoint: origin });
    return sanitizeIceServers(result.iceServers);
  }
  if (!settings.accessKey) throw new Error('请填写 Worker 访问密钥。');
  const response = await fetcher(origin, { method: 'POST', headers: { Authorization: `Bearer ${settings.accessKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 3600 }), signal: AbortSignal.timeout(12000), cache: 'no-store' });
  if (!response.ok) throw new Error(`中继凭据获取失败（HTTP ${response.status}）。`);
  const data = await response.json();
  return sanitizeIceServers(data.iceServers || data);
}

export async function optionalRelayIce({ settings, encoded = '', fetcher } = {}) {
  try {
    // A relay embedded in a Roomcast invite is the room owner's explicit TURN
    // policy for this room. The joining client must be able to use those
    // short-lived credentials without configuring its own Worker/access key.
    if (encoded) {
      return {
        iceServers: decodeRelayInvite(encoded),
        unavailable: false,
      };
    }

    // With no room-provided relay credentials, local TURN OFF remains
    // authoritative: do not contact the Worker's credentials endpoint.
    if (settings?.enabled !== true) {
      return {
        iceServers: [],
        unavailable: false,
      };
    }

    return {
      iceServers: await fetchRelayIce(settings, fetcher),
      unavailable: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'TURN 不可用。';
    return { iceServers: [], unavailable: true, reason: message.slice(0, 300) };
  }
}

export function encodeRelayInvite(iceServers) {
  const turn = sanitizeIceServers(iceServers);
  const encoded = base64UrlEncode(JSON.stringify({ v: 1, iceServers: turn }));
  if (encoded.length > 6000) throw new Error('中继邀请信息过长。');
  return encoded;
}

export function decodeRelayInvite(value) {
  if (!/^[A-Za-z0-9_-]{1,6000}$/.test(value || '')) throw new Error('邀请链接中的中继配置无效。');
  let data;
  try { data = JSON.parse(base64UrlDecode(value)); } catch { throw new Error('邀请链接中的中继配置已损坏。'); }
  if (data?.v !== 1) throw new Error('邀请链接中的中继配置版本不受支持。');
  return sanitizeIceServers(data.iceServers);
}
