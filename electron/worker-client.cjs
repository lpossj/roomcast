async function workerRequest(active, pathname, payload, { admin = true, fetchImpl = fetch, timeoutMs = 12_000, retries = 1 } = {}) {
  if (!active?.workerUrl) throw new Error('未配置稳定公网入口 Worker。');
  const endpoint = new URL(pathname, active.workerUrl).href;
  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers.Authorization = `Bearer ${active.accessKey}`;
  const maxRetries = Math.min(1, Math.max(0, Number.isInteger(retries) ? retries : 0));
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
      let value = {};
      try { value = await response.json(); } catch { }
      if (response.ok) return value;
      const failure = new Error(`稳定公网入口更新失败（HTTP ${response.status}）。`);
      if (response.status < 500 || attempt >= maxRetries) throw failure;
      lastError = failure;
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (attempt < maxRetries && (timeout || error?.name === 'TypeError' || /HTTP 5\d\d/.test(error?.message || ''))) {
        lastError = error;
        continue;
      }
      if (timeout) throw new Error(`Cloudflare Worker 请求超时${attempt ? '（已重试 1 次）' : ''}，请检查网络或 Worker 状态。`);
      if (error?.name === 'TypeError') throw new Error(`Cloudflare Worker 网络请求失败${attempt ? '（已重试 1 次）' : ''}，请检查网络连接。`);
      throw error;
    }
  }
  throw lastError || new Error('Cloudflare Worker 请求失败。');
}

function createChromiumSessionFetch(electronSession) {
  if (!electronSession || typeof electronSession.fetch !== 'function' || typeof electronSession.forceReloadProxyConfig !== 'function') throw new Error('Electron Chromium session 不可用。');
  return async (input, init) => {
    // Re-read Windows proxy/PAC state for every bounded Worker operation so a
    // runtime FlClash/enterprise-proxy toggle does not require restarting Roomcast.
    await electronSession.forceReloadProxyConfig();
    if (typeof electronSession.resolveProxy === 'function') await electronSession.resolveProxy(String(input));
    return electronSession.fetch(input, init);
  };
}

module.exports = { createChromiumSessionFetch, workerRequest };
