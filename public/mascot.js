// "Sado" maskoti: SVG, holatlar bo'yicha rang, ko'z va og'iz animatsiyasi.
// Holatlar: idle | listening | thinking | speaking ; kayfiyat: happy | neutral | curious | surprised

const COLORS = {
  idle: ["#2dd4bf", "#0ea5a4"],
  listening: ["#4ade80", "#16a34a"],
  thinking: ["#fbbf24", "#f59e0b"],
  speaking: ["#818cf8", "#4f46e5"],
};

let uid = 0;

export class Mascot {
  constructor(root) {
    const gid = `mg${++uid}`;
    this.root = root;
    this.state = "idle";
    this.mood = "neutral";
    this.level = 0; // 0..1 ovoz balandligi (gapirish yoki tinglash)
    this.smooth = 0;
    this.look = { x: 0, y: 0 };
    this.blink = 0;
    root.innerHTML = `
      <div class="mascot-glow"></div>
      <svg class="mascot-svg" viewBox="0 0 240 240" aria-hidden="true">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="m-c1" stop-color="${COLORS.idle[0]}"/>
            <stop offset="1" class="m-c2" stop-color="${COLORS.idle[1]}"/>
          </linearGradient>
        </defs>
        <ellipse class="m-shadow" cx="120" cy="222" rx="62" ry="9"/>
        <g class="m-bodywrap">
          <g class="m-sprout">
            <path d="M120 52 C120 40 120 34 121 26" stroke="url(#${gid})" stroke-width="6" stroke-linecap="round" fill="none"/>
            <path d="M121 30 C108 14 92 18 90 26 C100 34 112 34 121 30Z" fill="url(#${gid})"/>
            <path d="M121 28 C132 10 150 14 152 22 C142 32 130 32 121 28Z" fill="url(#${gid})"/>
          </g>
          <rect class="m-body" x="38" y="50" width="164" height="150" rx="62" fill="url(#${gid})"/>
          <rect x="52" y="64" width="136" height="122" rx="52" fill="#fff" opacity="0.96"/>
          <ellipse class="m-cheek" cx="74" cy="150" rx="11" ry="7"/>
          <ellipse class="m-cheek" cx="166" cy="150" rx="11" ry="7"/>
          <g class="m-eyes">
            <g class="m-eye" data-x="92"><ellipse class="m-eyeball" cx="92" cy="118" rx="13" ry="17"/><circle class="m-shine" cx="96" cy="111" r="4.5"/></g>
            <g class="m-eye" data-x="148"><ellipse class="m-eyeball" cx="148" cy="118" rx="13" ry="17"/><circle class="m-shine" cx="152" cy="111" r="4.5"/></g>
            <path class="m-happy" d="M78 122 Q92 104 106 122 M134 122 Q148 104 162 122" fill="none" stroke="#1e1b2e" stroke-width="7" stroke-linecap="round"/>
          </g>
          <path class="m-mouth" d="" fill="#1e1b2e"/>
          <g class="m-dots"><circle cx="186" cy="44" r="6"/><circle cx="204" cy="30" r="8"/><circle cx="222" cy="12" r="10"/></g>
        </g>
      </svg>`;
    this.svg = root.querySelector("svg");
    this.c1 = root.querySelector(".m-c1");
    this.c2 = root.querySelector(".m-c2");
    this.eyes = [...root.querySelectorAll(".m-eye")];
    this.mouth = root.querySelector(".m-mouth");
    this.bodyWrap = root.querySelector(".m-bodywrap");
    this.scheduleBlink();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.root.dataset.state = state;
    const [a, b] = COLORS[state] || COLORS.idle;
    this.c1.setAttribute("stop-color", a);
    this.c2.setAttribute("stop-color", b);
    this.root.style.setProperty("--glow", b);
    if (state !== "speaking") this.level = 0;
  }

  setMood(mood) {
    this.mood = mood;
    this.root.dataset.mood = mood;
    clearTimeout(this.moodTimer);
    if (mood !== "neutral") this.moodTimer = setTimeout(() => this.setMood("neutral"), 3500);
  }

  setLevel(v) {
    this.level = Math.max(0, Math.min(1, v));
  }

  scheduleBlink() {
    setTimeout(() => {
      this.blink = 1;
      setTimeout(() => (this.blink = 0), 140);
      this.scheduleBlink();
    }, 2200 + Math.random() * 2800);
  }

  loop(t) {
    this.smooth += (this.level - this.smooth) * 0.35;
    const lv = this.smooth;

    // Ko'z yo'nalishi
    let tx = 0, ty = 0;
    if (this.state === "thinking") { tx = 6; ty = -7; }
    else if (this.state === "listening") { tx = Math.sin(t / 900) * 2; ty = 1; }
    else if (this.state === "idle") { tx = Math.sin(t / 1700) * 4; }
    this.look.x += (tx - this.look.x) * 0.1;
    this.look.y += (ty - this.look.y) * 0.1;

    let sy = this.blink ? 0.1 : 1;
    if (this.mood === "surprised") sy *= 1.18;
    if (this.state === "listening") sy *= 1.06 + lv * 0.12;
    for (const eye of this.eyes) {
      const x = Number(eye.dataset.x);
      eye.setAttribute(
        "transform",
        `translate(${this.look.x} ${this.look.y}) translate(${x} 118) scale(1 ${sy}) translate(${-x} -118)`,
      );
    }

    // Og'iz
    const cx = 120 + this.look.x * 0.5;
    const y = 156;
    let open = 0, width = 18, smile = 4;
    if (this.state === "speaking") { open = 4 + lv * 22; width = 16 + lv * 6; smile = 2; }
    else if (this.state === "listening") { open = 2 + lv * 6; width = 12; smile = 2; }
    else if (this.state === "thinking") { open = 0; width = 10; smile = -2; }
    if (this.mood === "happy" && this.state !== "speaking") { smile = 10; open = Math.max(open, 6); width = 22; }
    if (this.mood === "surprised" && this.state !== "speaking") { open = 14; width = 10; smile = 0; }
    this.mouth.setAttribute(
      "d",
      `M${cx - width} ${y} Q${cx} ${y + smile} ${cx + width} ${y} Q${cx} ${y + smile + open * 1.6} ${cx - width} ${y}Z`,
    );

    // Tana: nafas olish va ovozga qarab cho'zilish
    const breathe = Math.sin(t / 650) * 0.015;
    const squash = this.state === "speaking" || this.state === "listening" ? lv * 0.06 : 0;
    const bob = this.state === "idle" ? Math.sin(t / 800) * 3 : this.state === "thinking" ? Math.sin(t / 300) * 1.5 : 0;
    this.bodyWrap.setAttribute(
      "transform",
      `translate(120 200) scale(${1 + squash - breathe} ${1 - squash * 0.6 + breathe}) translate(-120 -200) translate(0 ${bob})`,
    );
    this.root.style.setProperty("--lv", lv.toFixed(3));

    requestAnimationFrame(this.loop);
  }
}
