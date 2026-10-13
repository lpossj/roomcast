// This is a loopback-only ICE adapter, not a public TURN service. Its relay
// sockets can reach only this room's EasyTier subnet and existing UDP ACL.
import { parentPort, workerData } from 'node:worker_threads';
import { createServer } from 'turn-server';
import dgram from 'node:dgram';

const { address, username, credential } = workerData;
const prefix = address.slice(0, address.lastIndexOf('.') + 1);
const allowed = peer => {
  if (typeof peer?.ip !== 'string' || !peer.ip.startsWith(prefix)) return false;
  const host = Number(peer.ip.slice(prefix.length));
  return Number.isInteger(host) && host >= 2 && host <= 253 && peer.ip !== address;
};
const endpoint = peer => allowed(peer) && Number.isInteger(peer.port) && peer.port >= 50000 && peer.port <= 50255;
const udp = dgram.createSocket('udp4');
await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind({ address: '127.0.0.1', port: 0, exclusive: true }, resolve); });
const server = createServer({
  socket: udp,
  software: 'Roomcast local EasyTier adapter',
  auth: { mechanism: 'long-term', realm: 'roomcast-local', credentials: { [username]: credential } },
  relay: { ip: address, externalIp: address, portRange: [50000, 50255] },
  maxConnections: 64, userQuota: 64, totalQuota: 64,
  maxDataSize: 65535, maxPermissionsPerAllocation: 16, maxChannelsPerAllocation: 32,
  idleTimeout: 60000,
});
server.on('accept', (info, cb) => cb(info.source?.ip === '127.0.0.1'));
server.on('beforePermission', (info, cb) => cb(allowed(info.peer)));
for (const hook of ['beforeChannelBind', 'beforeRelay', 'beforeData']) {
  server.on(hook, (info, cb) => cb(endpoint(info.peer)));
}
server.on('beforeConnect', (_info, cb) => cb(false));
server.on('beforeAllocate', (info, cb) => cb(info.transport === 17 && info.requestedFamily !== 2));
server.on('error', () => { parentPort.postMessage({ error: true }); process.exit(1); });
udp.on('error', () => process.exit(1));
udp.on('message', (packet, remote) => { if (remote.address === '127.0.0.1') server.handlePacket(packet, remote); });
parentPort.postMessage({ port: udp.address().port });
