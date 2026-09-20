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
