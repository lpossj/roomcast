let context;
function soundContext() {
  const Constructor = window.AudioContext || window.webkitAudioContext;
  if (!Constructor) return null;
  if (!context || context.state === 'closed') context = new Constructor({ latencyHint: 'interactive' });
  return context;
}
function withSoundContext(play) {
  try {
    const active = soundContext();
    if (!active) return;
    if (active.state === 'running') { play(active); return; }
    // Safari requires resume() to be called before yielding the user gesture.
    void active.resume().then(() => { if (active.state === 'running') play(active); }).catch(() => {});
  } catch {}
}
const tones = { join: [523, 659, 784], leave: [659, 523], kick: [220, 165, 110], watch: [784, 1047] };
export function unlockSounds() {
  withSoundContext(() => {});
}
export function playSound(kind) {
  withSoundContext(context => {
      for (const [index, frequency] of (tones[kind] || []).entries()) {
        const oscillator = context.createOscillator(), gain = context.createGain();
        const start = context.currentTime + index * 0.11;
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.09, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.start(start); oscillator.stop(start + 0.15);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      }
  });
}

export function playPop() {
  withSoundContext(context => {
      const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime;
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(650, start); oscillator.frequency.exponentialRampToValueAtTime(150, start + 0.09);
      gain.gain.setValueAtTime(0.001, start); gain.gain.exponentialRampToValueAtTime(0.1, start + 0.008); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.11);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + 0.12);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  });
}
