// Apply candidate ordering only to explicitly marked Roomcast connections.
import { isCampusCandidate } from './campus-session.js';
import { DEFAULT_STUN_ICE } from '../server/stun-servers.mjs';
import { recordFailure } from './lifecycle-diagnostics.js';
export { DEFAULT_STUN_ICE } from '../server/stun-servers.mjs';
// Native ICE still validates/nominates pairs; never remove IPv4 or force relay.
export const ICE_DELAYS = { ipv6: 0, ipv4: 450, relay: 2400 };

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
      this.roomcastRemoteCandidates = [];
      this.roomcastIceStarted = 0;
      this.addEventListener('icecandidate', event => {
        if (!this.roomcastCampus && isCampusCandidate(event.candidate?.candidate)) event.stopImmediatePropagation();
      });
    }
    get localDescription() {
      const description = super.localDescription;
      if (!description?.sdp) return description;
      const sdp = this.roomcastCampus ? description.sdp : stripCampusCandidates(description.sdp);
      return sdp === description.sdp ? description : new RTCSessionDescription({ type: description.type, sdp });
    }
    setConfiguration(config) {
      if (this.roomcastCampus) {
        this.roomcastIcePolicyEnabled = false;
        const nativeConfig = { ...config };
        delete nativeConfig.roomcastIcePolicy;
        return super.setConfiguration(nativeConfig);
      }
      if (!this.roomcastIcePolicyEnabled && config?.roomcastIcePolicy !== true) return super.setConfiguration(config);
      this.roomcastIcePolicyEnabled = true;
      const nativeConfig = { ...config };
      delete nativeConfig.roomcastIcePolicy;
      return super.setConfiguration({ ...nativeConfig, iceTransportPolicy: 'all' });
    }
    roomcastOperationError(operation, cause) {
      if (cause?.roomcastPeerConnection === this && cause.roomcastOperation) return cause;
      const name = cause?.name || 'Error';
      recordFailure(operation, cause, { pc: this });
      console.warn('[Roomcast WebRTC]', { operation, name, signalingState: this.signalingState, iceConnectionState: this.iceConnectionState });
      return Object.assign(new Error(cause?.message || 'WebRTC operation failed.'), {
        name,
        roomcastOperation: operation,
        roomcastErrorName: name,
        roomcastPeerConnection: this,
        cause,
      });
    }
    async createOffer(options) {
      try { return await super.createOffer(options); }
      catch (error) { throw this.roomcastOperationError('createOffer', error); }
    }
    async createAnswer(options) {
      try { return await super.createAnswer(options); }
      catch (error) { throw this.roomcastOperationError('createAnswer', error); }
    }
    async setLocalDescription(description) {
      if (this.roomcastCampusPreparation) {
        try { await this.roomcastCampusPreparation; }
        catch (error) { throw this.roomcastOperationError('prepareCampus', error); }
      }
      if (!this.roomcastCampus && description?.sdp) description = { type: description.type, sdp: stripCampusCandidates(description.sdp) };
      try { return await super.setLocalDescription(description); }
      catch (error) { throw this.roomcastOperationError('setLocalDescription', error); }
    }
    async setRemoteDescription(description) {
      // PeerJS emits its incoming connection synchronously after constructing
      // this PC. Allow the receiver to mark the independently authorized retry.
      await Promise.resolve();
      if (!this.roomcastCampus && description?.sdp) description = { type: description.type, sdp: stripCampusCandidates(description.sdp) };
      const deferred = [];
      let endOfCandidates = false;
      if (this.roomcastIcePolicyEnabled && description?.sdp) {
        this.roomcastIceStarted = performance.now();
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
        description = { type: description.type, sdp };
      }
      try { await super.setRemoteDescription(description); }
      catch (error) {
        const failure = this.roomcastOperationError('setRemoteDescription', error);
        for (const pending of this.roomcastRemoteCandidates.splice(0)) pending.reject(failure);
        throw failure;
      }
      // Wait only for the native SDP operation; awaiting this override here
      // would deadlock its own deferred candidates. Rollback has no remote SDP.
      if (this.remoteDescription) {
        for (const pending of this.roomcastRemoteCandidates.splice(0)) {
          this.addIceCandidate(pending.candidate).then(pending.resolve, pending.reject);
        }
      }
      await Promise.allSettled(deferred.map(candidate => this.addIceCandidate(candidate)));
      if (endOfCandidates) await Promise.allSettled([this.addIceCandidate(null)]);
    }
    async addIceCandidate(candidate) {
      try {
        if (!this.roomcastCampus && isCampusCandidate(candidate?.candidate)) return;
        if (this.signalingState === 'closed') return;
        if (!this.remoteDescription) {
          return await new Promise((resolve, reject) => this.roomcastRemoteCandidates.push({ candidate, resolve, reject }));
        }
        if (!this.roomcastIcePolicyEnabled) return await super.addIceCandidate(candidate);
        const value = candidate?.toJSON ? candidate.toJSON() : candidate;
        if (!value?.candidate) {
          return await Promise.all([...this.roomcastCandidatePromises]).then(() => this.signalingState === 'closed' ? undefined : super.addIceCandidate(null));
        }
        if (!this.roomcastIceStarted) this.roomcastIceStarted = performance.now();
        const stage = candidateStage(value.candidate);
        const delay = Math.max(0, ICE_DELAYS[stage] - (performance.now() - this.roomcastIceStarted));
        const normalized = { ...value, candidate: prioritizeCandidate(value.candidate) };
        if (!delay) return await super.addIceCandidate(normalized);
        const pending = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.roomcastCandidateTimers.delete(timer);
            if (this.signalingState === 'closed') return resolve();
            try { super.addIceCandidate(normalized).then(resolve, reject); }
            catch (error) { reject(error); }
          }, delay);
          this.roomcastCandidateTimers.set(timer, resolve);
        });
        this.roomcastCandidatePromises.add(pending);
        pending.then(
          () => this.roomcastCandidatePromises.delete(pending),
          () => this.roomcastCandidatePromises.delete(pending),
        );
        return await pending;
      } catch (error) {
        throw this.roomcastOperationError('addIceCandidate', error);
      }
    }
    close() {
      for (const pending of this.roomcastRemoteCandidates.splice(0)) pending.resolve();
      for (const [timer, resolve] of this.roomcastCandidateTimers) { clearTimeout(timer); resolve(); }
      this.roomcastCandidateTimers.clear();
      super.close();
      const cleanup = this.roomcastCampusCleanup;
      this.roomcastCampusCleanup = null;
      cleanup?.();
    }
  }
  target.RTCPeerConnection = PreferredPeerConnection;
}

function stripCampusCandidates(sdp) {
  return sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || !isCampusCandidate(line.slice(2))).join('\r\n');
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
