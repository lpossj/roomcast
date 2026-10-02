let context;
const tones = { join: [523, 659, 784], leave: [659, 523], kick: [220, 165, 110], watch: [784, 1047] };
export function unlockSounds() {
  try { context ||= new AudioContext(); void context.resume().catch(() => {}); } catch {}
}
export function playSound(kind) {
  try {
    context ||= new AudioContext();
    void context.resume().then(() => {
      if (context.state !== 'running') return;
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
    }).catch(() => {});
  } catch {}
}

export function playPop() {
  try {
    context ||= new AudioContext({ latencyHint: 'interactive' });
    void context.resume().then(() => {
      if (context.state !== 'running') return;
      const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime;
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(650, start); oscillator.frequency.exponentialRampToValueAtTime(150, start + 0.09);
      gain.gain.setValueAtTime(0.001, start); gain.gain.exponentialRampToValueAtTime(0.1, start + 0.008); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.11);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + 0.12);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }).catch(() => {});
  } catch {}
}
