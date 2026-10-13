let active = null;
let prefix = '';

export async function configureCampusSession(room, secret) {
  room.campusSecret = secret || '';
  prefix = '';
  if (!secret) return;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`roomcast-campus-v1:${room.roomId}:${secret}`)));
  prefix = `172.${20 + digest[16] % 8}.${digest[17]}.`;
}

export function isCampusAddress(address) {
  // A reserved subnet alone must not filter or label an ordinary LAN address.
  // Startup rejects physical-network overlap before an active virtual session exists.
  return !!active && !!prefix && typeof address === 'string' && address.startsWith(prefix);
}

export function isCampusCandidate(candidate = '') {
  return isCampusAddress(candidate.trim().split(/\s+/)[4]);
}

export function campusStatsRoute(report, fallback = '路线检测中') {
  let pair;
  for (const item of report.values()) {
    if (item.type === 'transport' && item.selectedCandidatePairId) { pair = report.get(item.selectedCandidatePairId); break; }
  }
  if (!pair) for (const item of report.values()) {
    if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) { pair = item; break; }
  }
  if (!pair) return fallback === 'EasyTier' ? '路线检测中' : fallback;
  const local = report.get(pair.localCandidateId);
  const remote = report.get(pair.remoteCandidateId);
  if (isCampusAddress(local?.address || local?.ip) || isCampusAddress(remote?.address || remote?.ip)) return 'EasyTier虚拟网';
  if (fallback === 'EasyTier') return '路线检测中';
  return [local, remote].some(item => item?.candidateType === 'relay') ? 'TURN中继' : 'P2P直连';
}

async function startCampusSession(room) {
  if (active?.room === room) return active.result;
  if (room.campusStarting) return room.campusStarting;
  if (room.closed || !room.campusSecret || !window.roomcast?.startCampusNetwork) throw new Error('EasyTier 需要双方使用支持此功能的桌面端邀请。');
  const lease = crypto.randomUUID();
  room.campusLease = lease;
  room.campusUnsubscribe = window.roomcast.onCampusEnded(endedLease => {
    if (endedLease !== lease) return;
    if (active?.lease === lease) active = null;
    for (const pc of [...(room.campusConnections || [])]) {
      pc.close();
      pc.dispatchEvent(new Event('iceconnectionstatechange'));
      pc.dispatchEvent(new Event('connectionstatechange'));
    }
  });
  const starting = window.roomcast.startCampusNetwork({ lease, roomId: room.roomId, secret: room.campusSecret }).then(async result => {
    if (room.closed || room.campusLease !== lease || !room.campusConnections?.size) {
      await window.roomcast.stopCampusNetwork(lease);
      throw new Error('EasyTier 已取消。');
    }
    active = { room, lease, result };
    return result;
  }).catch(async error => {
    if (room.campusLease === lease) {
      room.campusUnsubscribe?.();
      room.campusUnsubscribe = null;
      room.campusLease = null;
    }
    await window.roomcast.stopCampusNetwork(lease).catch(() => {});
    throw error;
  }).finally(() => { if (room.campusStarting === starting) room.campusStarting = null; });
  room.campusStarting = starting;
  return starting;
}

// Installed synchronously before PeerJS's asynchronous offer/answer reaches
// setLocalDescription. Only this connection waits; no global ICE configuration.
export function prepareCampusConnection(room, pc) {
  pc.roomcastCampus = true;
  room.campusConnections ||= new Set();
  room.campusConnections.add(pc);
  pc.roomcastCampusCleanup = () => {
    room.campusConnections.delete(pc);
    if (!room.campusConnections.size) stopCampusSession(room);
  };
  const ready = startCampusSession(room).then(result => {
    if (room.closed || pc.signalingState === 'closed') throw new Error('EasyTier 已取消。');
    pc.setConfiguration({ ...pc.getConfiguration(), iceServers: [result.iceServer], iceTransportPolicy: 'relay', roomcastIcePolicy: false });
  }).catch(error => { pc.close(); throw error; });
  pc.roomcastCampusPreparation = ready;
  ready.catch(() => {});
  return ready;
}

export function stopCampusSession(room) {
  room.campusUnsubscribe?.();
  room.campusUnsubscribe = null;
  if (active?.room === room) active = null;
  const lease = room.campusLease;
  room.campusLease = null;
  if (lease) void window.roomcast?.stopCampusNetwork(lease).catch(() => {});
}

const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const message = (room, peer, value) => new TextEncoder().encode(`roomcast-easytier-fallback-v1\n${room.roomId}\n${peer}\n${value.at}\n${value.nonce}`);
const key = (room, usage) => crypto.subtle.importKey('raw', new TextEncoder().encode(room.campusSecret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function campusRequestProof(room) {
  const value = { at: Date.now(), nonce: encode(crypto.getRandomValues(new Uint8Array(24))) };
  value.proof = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(room, 'sign'), message(room, room.peer.id, value))));
  return value;
}

export async function verifyCampusRequest(room, peer, value) {
  if (!room.campusSecret || !window.roomcast?.startCampusNetwork || !Number.isSafeInteger(value?.at)
    || Math.abs(Date.now() - value.at) > 120000 || !/^[A-Za-z0-9_-]{32}$/.test(value?.nonce || '') || !/^[A-Za-z0-9_-]{43}$/.test(value?.proof || '')) return false;
  room.campusNonces ||= new Map();
  for (const [nonce, at] of room.campusNonces) if (Date.now() - at > 120000) room.campusNonces.delete(nonce);
  if (room.campusNonces.has(value.nonce) || room.campusNonces.size >= 64) return false;
  try {
    const bytes = Uint8Array.from(atob(value.proof.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', await key(room, 'verify'), bytes, message(room, peer, value));
    if (!valid || room.campusNonces.has(value.nonce)) return false;
    room.campusNonces.set(value.nonce, Date.now());
    return true;
  } catch { return false; }
}
