const { createHash, hkdfSync, randomInt } = require('node:crypto');

const PORTS = Object.freeze({ min: 50000, max: 50255 });
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const LEASE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// Public discovery nodes; users never share a global Roomcast network password.
const PEERS = Object.freeze(['tcp://easytier.weiai.org.cn:11010', 'tcp://225284.xyz:11010']);

function campusRequest(value) {
  if (!value || typeof value.roomId !== 'string' || typeof value.secret !== 'string' || typeof value.lease !== 'string'
    || !/^[A-F0-9]{8}$/.test(value.roomId) || !SECRET.test(value.secret) || !LEASE.test(value.lease)) {
    throw new Error('校园互联邀请信息无效。');
  }
  const seed = Buffer.from(value.secret, 'base64url');
  if (seed.length !== 32 || seed.toString('base64url') !== value.secret) throw new Error('校园互联密钥无效。');
  const digest = createHash('sha256').update(`roomcast-campus-v1:${value.roomId}:${value.secret}`).digest();
  const network = `roomcast-${digest.subarray(0, 16).toString('hex')}`;
  const secret = Buffer.from(hkdfSync('sha256', seed, Buffer.from(value.roomId), Buffer.from('roomcast/easytier/v1'), 32)).toString('hex');
  return { lease: value.lease, network, secret, prefix: `172.${20 + digest[16] % 8}.${digest[17]}`, device: `Roomcast-${value.lease.slice(0, 8)}` };
}

function campusConfig(value) {
  const rules = [1, 2].map(chain => `
[[acl.acl_v1.chains]]
name = "roomcast-${chain}"
chain_type = ${chain}
enabled = true
default_action = 2
[[acl.acl_v1.chains.rules]]
name = "roomcast-webrtc"
priority = 1000
enabled = true
protocol = 2
ports = ["${PORTS.min}-${PORTS.max}"]
source_ips = ["${value.prefix}.0/24"]
destination_ips = ["${value.prefix}.0/24"]
action = 1
`).join('');
  return `instance_name = "${value.device}"
hostname = "${value.device}"
ipv4 = "${value.prefix}.${randomInt(2, 254)}/24"
dhcp = true
listeners = ["udp://0.0.0.0:0", "tcp://0.0.0.0:0"]
proxy_network = []
exit_nodes = []
routes = []
${PEERS.map(uri => `[[peer]]\nuri = "${uri}"`).join('\n')}
[network_identity]
network_name = "${value.network}"
network_secret = "${value.secret}"
[flags]
dev_name = "${value.device}"
# Prefer datagrams for real-time media; direct-connect still falls back to TCP.
default_protocol = "udp"
enable_encryption = true
encryption_algorithm = "aes-256-gcm"
disable_upnp = true
enable_ipv6 = true
enable_exit_node = false
accept_dns = false
no_tun = false
relay_network_whitelist = "${value.network}"
${rules}
[[acl.acl_v1.chains]]
name = "roomcast-no-forward"
chain_type = 3
enabled = true
default_action = 2
`;
}

module.exports = { PORTS, LEASE, campusRequest, campusConfig };
