// Shared by ordinary room/media ICE and the VDO direct lane. Native ICE gathers
// these candidates without waiting for an application-level reachability probe.
// Tencent/Xiaomi match MCTier's ScreenShareService at 7bf1dd361c2e854a89910c1116af1e7acfef3ba8.
// Public availability is not guaranteed. Keep Cloudflare for compatibility;
// removing the first two entries restores Roomcast's previous STUN default.
export const DEFAULT_STUN_ICE = Object.freeze([
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]);
