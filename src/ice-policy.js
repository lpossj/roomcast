// Apply candidate ordering only to explicitly marked Roomcast connections.
// Native ICE still validates/nominates pairs; never remove IPv4 or force relay.
export const ICE_DELAYS = { ipv6: 0, ipv4: 450, relay: 2400 };
export const DEFAULT_STUN_ICE = Object.freeze([{ urls: 'stun:stun.cloudflare.com:3478' }]);

const urlsOf = item => Array.isArray(item?.urls) ? item.urls : [item?.urls];

export function mediaIceServers(value = DEFAULT_STUN_ICE) {
  const stun = (Array.isArray(value) ? value : []).flatMap(item => {
    const urls = urlsOf(item).filter(url => typeof url === 'string' && /^stun:/i.test(url) && url.length <= 512);
    return urls.length ? [{ urls: urls.length === 1 ? urls[0] : urls }] : [];
  });
  return stun.length ? stun : [...DEFAULT_STUN_ICE];
}

export function turnIceServers(value = []) {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const urls = urlsOf(item).filter(
      url => typeof url === 'string'
        && /^turns?:/i.test(url)
        && url.length <= 512,
    );

    if (!urls.length) return [];

    const server = {
      urls: urls.length === 1 ? urls[0] : urls,
    };

    if (typeof item?.username === 'string') server.username = item.username;
    if (typeof item?.credential === 'string') server.credential = item.credential;

    return [server];
  });
}

export function containsTurn(value) {
  return (Array.isArray(value) ? value : []).some(item => urlsOf(item).some(url => typeof url === 'string' && /^turns?:/i.test(url)));
}
export function candidateStage(candidate = '') {
  const parts = candidate.replace(/^a=/, '').trim().split(/\s+/);
  if (parts[parts.indexOf('typ') + 1] === 'relay') return 'relay';
  return parts[4]?.includes(':') ? 'ipv6' : 'ipv4';
}
export function prioritizeCandidate(candidate) {
  const parts = candidate.trim().split(/\s+/);
  if (!/^candidate:/.test(parts[0]) || !Number.isFinite(Number(parts[3]))) return candidate;
  const stage = candidateStage(candidate);
  const preference = stage === 'ipv6' ? 126 : stage === 'ipv4' ? 110 : 0;
  parts[3] = String(preference * 16777216 + (Number(parts[3]) % 16777216));
  return parts.join(' ');
}
export function installIcePolicy(target = window) {
  const Native = target.RTCPeerConnection;
  if (!Native || Native.roomcastIcePolicy) return;
  class PreferredPeerConnection extends Native {
    static roomcastIcePolicy = true;
    constructor(config = {}, constraints) {
      const scoped = config?.roomcastIcePolicy === true;
      const nativeConfig = { ...config };
      delete nativeConfig.roomcastIcePolicy;
      super(scoped ? { ...nativeConfig, iceTransportPolicy: 'all' } : nativeConfig, constraints);
      this.roomcastIcePolicyEnabled = scoped;
      this.roomcastCandidateTimers = new Map();
      this.roomcastCandidatePromises = new Set();
      this.roomcastIceStarted = 0;
    }
    setConfiguration(config) {
      if (!this.roomcastIcePolicyEnabled && config?.roomcastIcePolicy !== true) return super.setConfiguration(config);
      this.roomcastIcePolicyEnabled = true;
      const nativeConfig = { ...config };
      delete nativeConfig.roomcastIcePolicy;
      return super.setConfiguration({ ...nativeConfig, iceTransportPolicy: 'all' });
    }
    async setRemoteDescription(description) {
      if (!this.roomcastIcePolicyEnabled || !description?.sdp) return super.setRemoteDescription(description);
      this.roomcastIceStarted = performance.now();
      const deferred = [];
      let endOfCandidates = false;
      const sections = description.sdp.split(/(?=^m=)/m);
      let index = -1;
      const sdp = sections.map(section => {
        if (section.startsWith('m=')) index++;
        const mid = section.match(/^a=mid:(.*)\r?$/m)?.[1]?.trim();
        return section.split(/\r?\n/).filter(line => {
          if (line === 'a=end-of-candidates') { endOfCandidates = true; return false; }
          if (!line.startsWith('a=candidate:')) return true;
          deferred.push({ candidate: prioritizeCandidate(line.slice(2)), sdpMid: mid ?? null, sdpMLineIndex: Math.max(0, index) });
          return false;
        }).join('\r\n');
      }).join('');
      await super.setRemoteDescription({ type: description.type, sdp });
      await Promise.all(deferred.map(candidate => this.addIceCandidate(candidate)));
      if (endOfCandidates) await this.addIceCandidate(null);
    }
    addIceCandidate(candidate) {
      if (!this.roomcastIcePolicyEnabled) return super.addIceCandidate(candidate);
      if (this.signalingState === 'closed') return Promise.resolve();
      const value = candidate?.toJSON ? candidate.toJSON() : candidate;
      if (!value?.candidate) {
        return Promise.all([...this.roomcastCandidatePromises]).then(() => this.signalingState === 'closed' ? undefined : super.addIceCandidate(null));
      }
      if (!this.roomcastIceStarted) this.roomcastIceStarted = performance.now();
      const stage = candidateStage(value.candidate);
      const delay = Math.max(0, ICE_DELAYS[stage] - (performance.now() - this.roomcastIceStarted));
      const normalized = { ...value, candidate: prioritizeCandidate(value.candidate) };
      if (!delay) return super.addIceCandidate(normalized);
      const pending = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.roomcastCandidateTimers.delete(timer);
          if (this.signalingState === 'closed') return resolve();
          super.addIceCandidate(normalized).then(resolve, reject);
        }, delay);
        this.roomcastCandidateTimers.set(timer, resolve);
      });
      this.roomcastCandidatePromises.add(pending);
      pending.then(
        () => this.roomcastCandidatePromises.delete(pending),
        () => this.roomcastCandidatePromises.delete(pending),
      );
      return pending;
    }
    close() {
      for (const [timer, resolve] of this.roomcastCandidateTimers) { clearTimeout(timer); resolve(); }
      this.roomcastCandidateTimers.clear();
      return super.close();
    }
  }
  target.RTCPeerConnection = PreferredPeerConnection;
}

export function createRoomcastPeerConnection(config = {}, constraints) {
  const relayOnly = config?.iceTransportPolicy === 'relay';

  // Direct attempts use Roomcast's IPv6 -> IPv4 candidate ordering.
  // The final TURN attempt must remain truly relay-only and must not inherit
  // the direct-attempt relay delay.
  return new RTCPeerConnection(
    {
      ...config,
      roomcastIcePolicy: !relayOnly,
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
    },
    constraints,
  );
}
