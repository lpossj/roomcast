// Optional fields on existing messages. Unknown/missing versions keep legacy ICE.
export const NETWORK_PROTOCOL = 1;
export const NETWORK_FEATURES = Object.freeze([
  'enhancedIce', 'natPrediction', 'nativeUdpMux', 'nativeSocketPreparation', 'browserWebRtc', 'optionalTurn', 'mediaIceRestart',
]);

export function normalizeNetworkCapabilities(value) {
  if (!value || value.version !== NETWORK_PROTOCOL || !value.features || typeof value.features !== 'object') return null;
  return { version: NETWORK_PROTOCOL,
    features: Object.fromEntries(NETWORK_FEATURES.map(key => [key, value.features[key] === true])) };
}

export function commonNetworkCapabilities(local, remote) {
  const left = normalizeNetworkCapabilities(local);
  const right = normalizeNetworkCapabilities(remote);
  return { version: right ? NETWORK_PROTOCOL : 0, legacy: !right,
    features: Object.fromEntries(NETWORK_FEATURES.map(key => [key,
      key === 'browserWebRtc' && !right ? true : !!left?.features[key] && !!right?.features[key]])) };
}
