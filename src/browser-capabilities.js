function policyAllows(document, feature) {
  const policy = document?.permissionsPolicy || document?.featurePolicy;
  try { return !policy?.allowsFeature || policy.allowsFeature(feature); }
  catch { return true; }
}

export function browserCapabilities(scope = globalThis, cameraPermission = 'prompt') {
  const secure = scope.isSecureContext === true;
  const media = scope.navigator?.mediaDevices;
  const capture = secure && typeof media?.getUserMedia === 'function';
  return {
    host: secure && typeof scope.RTCPeerConnection === 'function' && typeof scope.WebSocket === 'function'
      && typeof scope.crypto?.getRandomValues === 'function' && Boolean(scope.crypto?.subtle),
    screen: secure && typeof media?.getDisplayMedia === 'function' && policyAllows(scope.document, 'display-capture'),
    camera: capture && cameraPermission !== 'denied' && policyAllows(scope.document, 'camera'),
    microphone: capture && policyAllows(scope.document, 'microphone'),
  };
}

export function normalizeBrowserShareSettings(settings, capabilities) {
  const camera = capabilities.camera && (settings.sourceType === 'camera' || !capabilities.screen);
  const sourceType = camera ? 'camera' : 'monitor';
  const microphone = capabilities.microphone && (settings.audioMode === 'microphone' || String(settings.audioMode).endsWith('-microphone'));
  // Old desktop-only app/exclusion preferences must not block browser publishing.
  const system = !camera && capabilities.screen && ['system', 'system-microphone'].includes(settings.audioMode);
  return { ...settings, captureBackend: 'native', sourceType, sourceId: camera ? 'camera' : capabilities.screen ? 'browser' : '',
    audioSourceId: '', audioMode: system ? microphone ? 'system-microphone' : 'system' : microphone ? 'microphone' : 'none',
    systemAudio: system, microphone };
}
