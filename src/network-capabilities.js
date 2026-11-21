import { NETWORK_PROTOCOL, commonNetworkCapabilities } from '../server/network-capabilities.mjs';

import { nativeAvailable } from './transports/native-endpoint.js';
export function localNetworkCapabilities({ mediaIceRestart = true } = {}) {
  return { version: NETWORK_PROTOCOL, features: {
    enhancedIce: true, natPrediction: true, browserWebRtc: true, optionalTurn: true, signedRoomControl: true,
    nativeUdpMux: nativeAvailable(), nativeSocketPreparation: nativeAvailable(),
    mediaIceRestart,
  } };
}

export function negotiateNetwork(remote) {
  return commonNetworkCapabilities(localNetworkCapabilities(), remote);
}
