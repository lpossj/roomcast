const DNS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeWorkerOrigin(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return ''; }
  if (url.href.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return '';
  const ipLiteral = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.includes(':') || url.hostname.startsWith('[');
  if (ipLiteral || !DNS_HOST.test(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local')) return '';
  return url.origin;
}

// A hidden saved key may only be reused for the same valid origin. Otherwise an
// endpoint edit could forward a key the renderer is not allowed to read.
export function normalizeRelaySettings(next = {}, previous = {}) {
  const endpoint = String(next.endpoint || '').trim().slice(0, 2048);
  const origin = normalizeWorkerOrigin(endpoint);
  const sameOrigin = origin && origin === normalizeWorkerOrigin(previous.endpoint);
  const accessKey = String(next.accessKey || (sameOrigin ? previous.accessKey : '') || '').slice(0, 512);
  return { enabled: next.enabled === true, endpoint, accessKey };
}

