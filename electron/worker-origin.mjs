const LEGACY_WORKERS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.workers\.dev$/i;
const DNS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeWorkerOrigin(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return ''; }
  if (url.href.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return '';
  const ipLiteral = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.includes(':') || url.hostname.startsWith('[');
  if (ipLiteral || !DNS_HOST.test(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local')) return '';
  return url.origin;
}

export function trustedWorkerOrigin(value, configuredEndpoint = '') {
  const origin = normalizeWorkerOrigin(value);
  if (!origin) return '';
  const hostname = new URL(origin).hostname;
  if (LEGACY_WORKERS_HOST.test(hostname)) return origin;
  const configured = normalizeWorkerOrigin(configuredEndpoint);
  return configured && configured === origin ? origin : '';
}

export function validPublicInviteLink(value, configuredEndpoint = '') {
  let url;
  try { url = new URL(String(value || '')); } catch { return false; }
  if (!trustedWorkerOrigin(url.origin, configuredEndpoint) || url.username || url.password || url.search) return false;
  if (!/^\/join\/[A-F0-9]{8}$/.test(url.pathname)) return false;
  return /^#j=[A-Za-z0-9_-]{43}$/.test(url.hash);
}
