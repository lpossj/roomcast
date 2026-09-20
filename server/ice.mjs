import { createHmac } from 'node:crypto';

export function clientIceServers(config, memberId, now = Date.now()) {
  if (!config.turnSharedSecret || !config.turnUrls?.length) return config.iceServers;
  const username = `${Math.floor(now / 1000) + 86400}:${memberId}`;
  const credential = createHmac('sha1', config.turnSharedSecret).update(username).digest('base64');
  return [{ urls: config.turnUrls, username, credential }];
}
