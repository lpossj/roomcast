class RoomcastPcmPlayoutProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 16384;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.count = 0;
    this.carry = new Uint8Array(0);
    this.started = false;
    this.startFrames = 1920; // 40 ms @ 48 kHz
    this.maxQueuedFrames = 12000; // 250 ms hard ceiling
    this.targetQueuedFrames = 5760; // keep newest ~120 ms after a stall
    this.rampFrames = 64;
    this.rampRemaining = 0;
    this.rampFromLeft = 0;
    this.rampFromRight = 0;
    this.lastLeft = 0;
    this.lastRight = 0;
    this.port.onmessage = event => this.handleMessage(event.data);
  }

  reset() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.count = 0;
    this.carry = new Uint8Array(0);
    this.started = false;
    this.rampRemaining = 0;
    this.rampFromLeft = 0;
    this.rampFromRight = 0;
    this.lastLeft = 0;
    this.lastRight = 0;
  }

  handleMessage(message) {
    if (message?.type === 'reset') {
      this.reset();
      return;
    }
    if (message?.type !== 'pcm-s16le' || !(message.buffer instanceof ArrayBuffer)) return;

    const incoming = new Uint8Array(message.buffer);
    if (!incoming.byteLength && !this.carry.byteLength) return;
    let bytes;
    if (this.carry.byteLength) {
      bytes = new Uint8Array(this.carry.byteLength + incoming.byteLength);
      bytes.set(this.carry, 0);
      bytes.set(incoming, this.carry.byteLength);
    } else bytes = incoming;

    const completeBytes = bytes.byteLength - (bytes.byteLength % 4);
    this.carry = completeBytes === bytes.byteLength ? new Uint8Array(0) : bytes.slice(completeBytes);
    let frameCount = completeBytes / 4;
    if (!frameCount) return;

    let firstFrame = 0;
    if (this.count + frameCount > this.maxQueuedFrames) {
      // Renderer/IPC stalled. Do not play hundreds of milliseconds of stale
      // audio and do not hard-stop a currently playing WebAudio node. Keep the
      // newest bounded window and cross-fade into it on the next render quantum.
      const keepFromIncoming = Math.min(frameCount, this.targetQueuedFrames);
      firstFrame = frameCount - keepFromIncoming;
      frameCount = keepFromIncoming;
      this.readIndex = 0;
      this.writeIndex = 0;
      this.count = 0;
      this.rampFromLeft = this.lastLeft;
      this.rampFromRight = this.lastRight;
      this.rampRemaining = this.rampFrames;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, completeBytes);
    for (let frame = firstFrame; frame < firstFrame + frameCount; frame++) {
      this.left[this.writeIndex] = view.getInt16(frame * 4, true) / 32768;
      this.right[this.writeIndex] = view.getInt16(frame * 4 + 2, true) / 32768;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      if (this.count < this.capacity) this.count += 1;
      else this.readIndex = (this.readIndex + 1) % this.capacity;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return true;
    const leftOut = output[0];
    const rightOut = output[1] || output[0];
    leftOut.fill(0);
    if (rightOut !== leftOut) rightOut.fill(0);

    if (!this.started) {
      if (this.count < this.startFrames) {
        this.lastLeft = 0;
        this.lastRight = 0;
        return true;
      }
      this.started = true;
      this.rampFromLeft = 0;
      this.rampFromRight = 0;
      this.rampRemaining = this.rampFrames;
    }

    const frames = leftOut.length;
    const availableAtStart = this.count;
    const willUnderrun = availableAtStart < frames;
    const fadeLength = willUnderrun ? Math.min(this.rampFrames, availableAtStart) : 0;
    const fadeStart = availableAtStart - fadeLength;
    let consumed = 0;

    for (let index = 0; index < frames; index++) {
      if (!this.count) {
        this.started = false;
        this.lastLeft = 0;
        this.lastRight = 0;
        break;
      }

      let left = this.left[this.readIndex];
      let right = this.right[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.capacity;
      this.count -= 1;

      if (this.rampRemaining > 0) {
        const progress = 1 - this.rampRemaining / this.rampFrames;
        left = this.rampFromLeft + (left - this.rampFromLeft) * progress;
        right = this.rampFromRight + (right - this.rampFromRight) * progress;
        this.rampRemaining -= 1;
      }

      if (fadeLength && consumed >= fadeStart) {
        const remaining = availableAtStart - consumed;
        const gain = Math.max(0, Math.min(1, remaining / fadeLength));
        left *= gain;
        right *= gain;
      }

      leftOut[index] = left;
      rightOut[index] = right;
      this.lastLeft = left;
      this.lastRight = right;
      consumed += 1;
    }

    return true;
  }
}

registerProcessor('roomcast-pcm-playout', RoomcastPcmPlayoutProcessor);
