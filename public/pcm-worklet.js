// Mikrofon ovozini 16 kHz mono PCM16 ga aylantirib, ~100 ms bo'laklarda yuboradi.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.acc = 0;
    this.cnt = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.cnt));
        this.acc = 0;
        this.cnt = 0;
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.out.length) {
          const chunk = this.out.slice(0);
          this.port.postMessage(chunk.buffer, [chunk.buffer]);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
