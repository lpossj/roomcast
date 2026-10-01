import { useEffect, useRef, useState } from 'react';
import { loadPreference, savePreference } from './preferences.js';
import { captureMicrophone, clampVolume, monitorMicrophone, normalizeVoiceSettings, RoomVoice } from './room-voice.js';

export default function useRoomVoice({ room, selfId, socket, config, devicePreferences }) {
  const [settings, setSettingsState] = useState(() => normalizeVoiceSettings(loadPreference('voiceSettings', {})));
  const [microphone, setMicrophone] = useState(false), [output, setOutput] = useState(false), [testing, setTesting] = useState(false);
  const [stream, setStream] = useState(null), [level, setLevel] = useState(0), [speaking, setSpeaking] = useState({}), [error, setError] = useState('');
  const [testSpeaking, setTestSpeaking] = useState(false);
  const [memberVolumes, setMemberVolumes] = useState({});
  const capture = useRef(null), mesh = useRef(null), settingsRef = useRef(settings), micRef = useRef(microphone);
  settingsRef.current = settings; micRef.current = microphone;
  const roomId = room?.id;
  const supported = room?.features?.voice === 1;
  const announcedMicrophone = room?.members.find(member => member.id === selfId)?.voiceEnabled === true;
  const voiceRevision = room?.members.find(member => member.id === selfId)?.voiceRevision || 0;
  const wantCapture = microphone || testing;
  const reportSpeaking = (id, value) => setSpeaking(old => old[id] === value ? old : { ...old, [id]: value });
  const setSettings = change => setSettingsState(old => {
    const next = normalizeVoiceSettings(typeof change === 'function' ? change(old) : change);
    savePreference('voiceSettings', next); return next;
  });
  useEffect(() => {
    setMicrophone(!!roomId && supported && settingsRef.current.defaultMicrophone);
    setOutput(!!roomId && settingsRef.current.defaultOutput);
    setSpeaking({});
    setMemberVolumes({});
  }, [roomId, selfId, supported]);
  useEffect(() => {
    if (!wantCapture) { setStream(null); setLevel(0); setTestSpeaking(false); reportSpeaking(selfId, false); return undefined; }
    let cancelled = false, resource;
    setError('');
    void captureMicrophone(devicePreferences.inputId, settingsRef.current.microphoneVolume, value => {
      if (cancelled) return;
      setLevel(value.level); setTestSpeaking(value.speaking); reportSpeaking(selfId, micRef.current && value.speaking);
    }).then(value => {
      if (cancelled) { value.stop(); return; }
      capture.current = resource = value; value.setVolume(settingsRef.current.microphoneVolume); setStream(value.stream);
      value.onEnded(() => { if (!cancelled) { setMicrophone(false); setTesting(false); setError('麦克风已断开，请检查设备后重新开启。'); } });
    }).catch(failure => {
      if (!cancelled) { setError(`无法使用麦克风：${failure.message}`); setMicrophone(false); setTesting(false); }
    });
    return () => { cancelled = true; resource?.stop(); if (capture.current === resource) capture.current = null; setStream(null); };
  }, [wantCapture, devicePreferences.inputId, selfId]);
  useEffect(() => { capture.current?.setVolume(settings.microphoneVolume); }, [settings.microphoneVolume]);
  useEffect(() => {
    if (!testing || !stream) return undefined;
    return monitorMicrophone(stream, devicePreferences.outputId, setError);
  }, [testing, stream, devicePreferences.outputId]);
  useEffect(() => {
    if (!supported || !roomId || !socket || !selfId) return undefined;
    const service = new RoomVoice({ socket, selfId, iceServers: config?.controlIceServers || config?.iceServers,
      onSpeaking: reportSpeaking, onError: setError });
    mesh.current = service;
    // Retry only when a connection failed or a member/profile changed; no capture retries.
    const retry = setInterval(() => service.update(service.room, service.localStream), 5000);
    return () => { clearInterval(retry); service.close(); if (mesh.current === service) mesh.current = null; };
  }, [roomId, selfId, socket, supported]);
  useEffect(() => { mesh.current?.update(room, microphone ? stream : null); }, [room, microphone, stream]);
  useEffect(() => { mesh.current?.setMemberVolumes(memberVolumes); }, [memberVolumes, roomId, socket, supported]);
  useEffect(() => {
    if (!socket || !roomId) return undefined;
    const muted = message => {
      if (message.memberId !== selfId) return;
      micRef.current = false; setMicrophone(false);
      mesh.current?.update(room, null);
      setError(`${message.by || '管理者'} 已关闭你的麦克风。`);
    };
    socket.on('voice:muted', muted);
    return () => socket.off('voice:muted', muted);
  }, [socket, roomId, selfId, room]);
  useEffect(() => {
    if (!supported || !roomId || !socket?.connected || !selfId) return undefined;
    // Publish only after capture succeeds; testing alone never opens the room mic.
    let cancelled = false;
    const enabled = !!(microphone && stream);
    if (enabled === announcedMicrophone) return undefined;
    socket.timeout(5000).emit('member:voice', { enabled, revision: voiceRevision }, (failure, result) => {
      if (!cancelled && (failure || !result?.ok)) { setError(result?.error || '麦克风状态同步失败。'); if (enabled) setMicrophone(false); }
    });
    return () => { cancelled = true; };
  }, [roomId, selfId, socket, microphone, stream, announcedMicrophone, voiceRevision, supported]);
  useEffect(() => {
    mesh.current?.setOutput({ enabled: output, volume: settings.outputVolume, deviceId: devicePreferences.outputId });
  }, [output, settings.outputVolume, devicePreferences.outputId, roomId, socket]);
  const setMemberVolume = (id, volume) => {
    if (id === selfId || !room?.members.some(member => member.id === id)) return;
    setMemberVolumes(old => ({ ...old, [id]: clampVolume(volume) }));
  };
  return { settings, setSettings, microphone, setMicrophone, output, setOutput, testing, setTesting, level, testSpeaking, speaking,
    memberVolumes, setMemberVolume, error, clearError: () => setError('') };
}
