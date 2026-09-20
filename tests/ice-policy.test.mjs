import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateStage, containsTurn, createRoomcastPeerConnection, installIcePolicy, mediaIceServers, prioritizeCandidate, turnIceServers } from '../src/ice-policy.js';

const v6 = 'candidate:1 1 udp 2122260223 2001:db8::1 5000 typ host';
const v4 = 'candidate:2 1 udp 2122260223 192.0.2.1 5000 typ srflx raddr 10.0.0.1 rport 5000';
const relay = 'candidate:3 1 udp 2122260223 2001:db8::2 6000 typ relay';
test('IPv6 direct precedes IPv4 direct and IPv6 TURN is still last', () => {
  assert.equal(candidateStage(v6), 'ipv6'); assert.equal(candidateStage(v4), 'ipv4'); assert.equal(candidateStage(relay), 'relay');
  const priorities = [v6, v4, relay].map(value => Number(prioritizeCandidate(value).split(' ')[3]));
  assert.ok(priorities[0] > priorities[1] && priorities[1] > priorities[2]);
  assert.match(prioritizeCandidate(v4), /raddr 10.0.0.1 rport 5000$/);
});
class FakePC {
  constructor(config) { this.config = config; this.signalingState = 'stable'; this.received = []; }
  setConfiguration(config) { this.config = config; }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  async addIceCandidate(candidate) { this.received.push(candidate); }
  close() { this.signalingState = 'closed'; }
}
test('SDP and trickled candidates retain IPv4 and relay fallback with all policy', async () => {
  const target = { RTCPeerConnection: FakePC }; installIcePolicy(target);
  const pc = new target.RTCPeerConnection({ roomcastIcePolicy: true, iceTransportPolicy: 'relay' });
  assert.equal(pc.config.iceTransportPolicy, 'all');
  await pc.setRemoteDescription({ type: 'offer', sdp: `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\na=${v6}\r\na=${v4}\r\na=end-of-candidates\r\n` });
  assert.doesNotMatch(pc.remoteDescription.sdp, /candidate/);
  assert.equal(pc.received.length, 3);
  assert.equal(candidateStage(pc.received[0].candidate), 'ipv6');
  assert.equal(candidateStage(pc.received[1].candidate), 'ipv4');
  assert.equal(pc.received[2], null);
  const pending = pc.addIceCandidate({ candidate: relay, sdpMid: 'video' });
  await pending;
  assert.equal(pc.received.length, 4); assert.equal(candidateStage(pc.received[3].candidate), 'relay');
  assert.equal(pc.received[3].sdpMid, 'video'); pc.close();
});
test('closing cancels deferred ICE candidates', async () => {
  const target = { RTCPeerConnection: FakePC }; installIcePolicy(target);
  const pc = new target.RTCPeerConnection({ roomcastIcePolicy: true });
  const pending = pc.addIceCandidate({ candidate: relay });
  pc.close(); await pending;
  assert.equal(pc.received.length, 0); assert.equal(pc.roomcastCandidateTimers.size, 0);
});

test('global wrapper leaves unrelated peer connections untouched', async () => {
  const target = { RTCPeerConnection: FakePC }; installIcePolicy(target);
  const pc = new target.RTCPeerConnection({ iceTransportPolicy: 'relay' });
  await pc.setRemoteDescription({ type: 'offer', sdp: `v=0\r\na=${v6}\r\na=end-of-candidates\r\n` });
  assert.equal(pc.config.iceTransportPolicy, 'relay');
  assert.match(pc.remoteDescription.sdp, /candidate:/);
  assert.equal(pc.received.length, 0);
});

test('control ICE may contain TURN while media ICE is strictly STUN-only', () => {
  const control = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'] , username: 'u', credential: 'p' },
  ];
  assert.equal(containsTurn(control), true);
  const media = mediaIceServers(control);
  assert.equal(containsTurn(media), false);
  assert.deepEqual(media, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
});


test('TURN media servers contain relay URLs only and preserve credentials', () => {
  const mixed = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:turn.example.com:3478?transport=udp',
        'turns:turn.example.com:443?transport=tcp',
        'stun:ignored.example.com:3478',
      ],
      username: 'u',
      credential: 'p',
    },
  ];

  assert.deepEqual(turnIceServers(mixed), [{
    urls: [
      'turn:turn.example.com:3478?transport=udp',
      'turns:turn.example.com:443?transport=tcp',
    ],
    username: 'u',
    credential: 'p',
  }]);
});

test('final TURN Roomcast peer connection is truly relay-only', () => {
  const target = { RTCPeerConnection: FakePC };
  installIcePolicy(target);

  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = target.RTCPeerConnection;

  try {
    const pc = createRoomcastPeerConnection({
      iceServers: [{
        urls: 'turn:turn.example.com:3478',
        username: 'u',
        credential: 'p',
      }],
      iceTransportPolicy: 'relay',
    });

    assert.equal(pc.config.iceTransportPolicy, 'relay');
    assert.equal(pc.roomcastIcePolicyEnabled, false);
  } finally {
    globalThis.RTCPeerConnection = previous;
  }
});
