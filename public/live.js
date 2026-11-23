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

  async start(sessionId, initData, voice = "", topic = "") {
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

    // 🔇 Exo himoyasi: Sado gapirayotganda (va undan keyin qisqa vaqt) telefon karnayidan chiqqan
    // ovoz mikrofonga qaytib tushadi — Gemini uni o'quvchi gapi deb o'ylab, Sado'ni to'xtatib,
    // salomlashishni qayta boshlardi. Shu paytda va mikrofon o'chiq bo'lsa jimlik yuboramiz:
    // oqim uzilmaydi, Gemini esa o'quvchi gapi tugaganini to'g'ri aniqlaydi.
    const sendPcm = (buf) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const echo = this.speaking(0.35);
      this.ws.send(this.muted || echo ? new ArrayBuffer(buf.byteLength) : buf);
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
      `api/live?session=${encodeURIComponent(sessionId)}&init=${encodeURIComponent(initData || "")}&voice=${encodeURIComponent(voice)}&topic=${encodeURIComponent(topic)}`,
      location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.lastMsg = Date.now();
    this.ws.onmessage = (e) => {
      this.lastMsg = Date.now(); // 💓 serverdan har qanday xabar — aloqa tirik
      if (typeof e.data !== "string") return this.play(e.data);
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === "ka") return; // faqat "tirikman" signali
      if (m.type === "interrupted") this.flush();
      if (m.type === "turn" || m.type === "interrupted") this.dropping = false; // keyingi javob yana eshitiladi
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
    if (this.stopped || this.dropping || !ab.byteLength) return;
    const ctx = this.ctx;
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    const pcm = new Int16Array(ab);
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.out);
    this.voiceFrames = 0; // Sado javob beryapti
    const at = Math.max(ctx.currentTime + 0.04, this.playhead);
    s.start(at);
    this.playhead = at + buf.duration;
    this.sources.add(s);
    s.onended = () => this.sources.delete(s);
  }

  // 🔊 Sado hozir gapiryaptimi: ijro tugashi kerak bo'lgan vaqt bo'yicha (o'chib qolgan "onended"ga
  // bog'liq emas). Ovoz tizimi to'xtab qolsa — gapirmayapti deb hisoblaymiz, aks holda mikrofon
  // abadiy "jim" yuborib, suhbat qotib qolardi.
  speaking(tail = 0) {
    if (this.ctx.state !== "running") return false;
    return this.ctx.currentTime < this.playhead + tail;
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

  // ✋ O'quvchi Sado'ni to'xtatdi: ovoz darhol o'chadi, shu javobning qolgan qismi tashlanadi,
  // mikrofon esa darhol ochiladi (exo himoyasi kutmaydi)
  interrupt() {
    if (!this.speaking()) return false;
    this.dropping = true;
    this.flush();
    this.playhead = this.ctx.currentTime - 1;
    return true;
  }

  loop() {
    if (this.stopped) return;
    // Telefon ovoz tizimini to'xtatib qo'ysa (ruxsat oynasi, boshqa ilova) — qayta yoqamiz
    if (this.ctx.state === "suspended" && !this.resuming) {
      this.resuming = true;
      this.ctx.resume().catch(() => {}).finally(() => (this.resuming = false));
    }
    // Bir soniyadan ko'p to'xtab qolsa — o'quvchidan ekranga bosishni so'raymiz (telefon faqat bosish bilan ruxsat beradi)
    if (this.ctx.state !== "running") {
      this.pausedSince ||= performance.now();
      if (performance.now() - this.pausedSince > 1000) {
        if (!this.pauseCounted) { this.pauses = (this.pauses || 0) + 1; this.pauseCounted = true; }
        this.onState("paused", 0);
        this.raf = requestAnimationFrame(this.loop);
        return;
      }
    } else { this.pausedSince = 0; this.pauseCounted = false; }
    const speaking = this.speaking();
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
    // 🗣 O'quvchi ovozini sezdik (keyin Sado javob bermasa — eslatamiz)
    if (!speaking && level > 0.3) { this.voiceFrames = (this.voiceFrames || 0) + 1; this.voiceAt = Date.now(); }
    this.onState(speaking ? "speaking" : "listening", level);
    this.raf = requestAnimationFrame(this.loop);
  }

  // 🤫 Uzoq jimlik: Sado'dan yordam so'rash
  nudge() {
    try { this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "nudge" })); return true; } catch { return false; }
  }

  // 🗣 O'quvchi gapirdi, lekin javob kelmadi — Sado'dan javob berishni so'rash
  poke() {
    try { this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "poke" })); return true; } catch { return false; }
  }

  // 🔀 Erkin suhbatda mavzuni almashtirish so'rovi
  newTopic() {
    try { this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "newtopic" })); return true; } catch { return false; }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    // 🩺 Telefon tomonidan qisqa hisobot (statistika uchun): ovoz necha marta to'xtagan, oxirgi xabar qachon
    const diag = {
      paused: this.pauses || 0,
      silentSec: Math.round((Date.now() - (this.lastMsg || Date.now())) / 1000),
      ctx: this.ctx?.state || "",
      dev: /iPhone|iPad/.test(navigator.userAgent) ? "iOS" : /Android/.test(navigator.userAgent) ? "Android" : "boshqa",
      tg: Boolean(window.Telegram?.WebApp?.initData),
    };
    try { this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "end", diag })); } catch {}
    try { this.ws?.close(); } catch {}
    this.flush();
    try { this.src?.disconnect(); this.node?.disconnect(); this.sink?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
