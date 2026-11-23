// 📞 Jonli suhbat (telefon tomoni): mikrofon -> server -> Gemini Live -> Sado ovozi.
export class LiveCall {
  constructor({ ctx, outAnalyser, onEvent, onState }) {
    this.ctx = ctx;
    this.out = outAnalyser; // Sado ovozi shu orqali karnayga chiqadi (og'iz animatsiyasi uchun)
    this.onEvent = onEvent;
    this.onState = onState;
    this.sources = new Set();
    this.playhead = 0;
    this.stopped = false;
  }

  async start(sessionId, initData, voice = "") {
    const ctx = this.ctx;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.src = ctx.createMediaStreamSource(this.stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.src.connect(this.micAnalyser);

    // Ovozsiz "yutgich": qayta ishlash tugunlari ishlashi uchun grafikka ulangan bo'lishi kerak
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);

    const sendPcm = (buf) => {
      if (!this.muted && this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
    };
    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule("pcm-worklet.js?v=1");
      this.node = new AudioWorkletNode(ctx, "pcm-capture");
      this.node.port.onmessage = (e) => sendPcm(e.data);
    } else {
      // Eski brauzerlar uchun zaxira
      this.node = ctx.createScriptProcessor(4096, 1, 1);
      const ratio = ctx.sampleRate / 16000;
      this.node.onaudioprocess = (e) => {
        const inp = e.inputBuffer.getChannelData(0);
        const n = Math.floor(inp.length / ratio);
        const out = new Int16Array(n);
        for (let i = 0; i < n; i++) {
          const v = Math.max(-1, Math.min(1, inp[Math.floor(i * ratio)]));
          out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        sendPcm(out.buffer);
      };
    }
    this.src.connect(this.node);
    this.node.connect(this.sink);

    const url = new URL(
      `api/live?session=${encodeURIComponent(sessionId)}&init=${encodeURIComponent(initData || "")}&voice=${encodeURIComponent(voice)}`,
      location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => {
      if (typeof e.data !== "string") return this.play(e.data);
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === "interrupted") this.flush();
      this.onEvent(m);
    };
    this.ws.onclose = () => {
      if (!this.stopped) this.onEvent({ type: "closed", reason: "ulanish" });
    };

    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // 24 kHz PCM16 bo'lakni navbat bilan, uzilishsiz ijro etadi
  play(ab) {
    if (this.stopped || !ab.byteLength) return;
    const ctx = this.ctx;
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    const pcm = new Int16Array(ab);
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.out);
    const at = Math.max(ctx.currentTime + 0.04, this.playhead);
    s.start(at);
    this.playhead = at + buf.duration;
    this.sources.add(s);
    s.onended = () => this.sources.delete(s);
  }

  // Mikrofonni vaqtincha o'chirish/yoqish
  setMuted(m) {
    this.muted = m;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !m));
  }

  // O'quvchi gapini bo'lsa - Sado darhol jim bo'ladi
  flush() {
    for (const s of this.sources) {
      try { s.stop(); } catch {}
    }
    this.sources.clear();
    this.playhead = this.ctx.currentTime;
  }

  loop() {
    if (this.stopped) return;
    const speaking = this.sources.size > 0;
    if (!speaking && this.muted) {
      this.onState("muted", 0);
      this.raf = requestAnimationFrame(this.loop);
      return;
    }
    const an = speaking ? this.out : this.micAnalyser;
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const level = Math.min(1, Math.sqrt(sum / buf.length) * (speaking ? 6 : 9));
    this.onState(speaking ? "speaking" : "listening", level);
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    try { this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "end" })); } catch {}
    try { this.ws?.close(); } catch {}
    this.flush();
    try { this.src?.disconnect(); this.node?.disconnect(); this.sink?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
