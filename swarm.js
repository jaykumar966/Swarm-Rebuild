// Swarm Rebuild — wipes the page and lets a swarm of multiplayer cursors rebuild it.
// Single dependency-free content script. Injecting it again while it runs toggles it off.
(() => {
  "use strict";
  if (window.__pageSwarm) {
    try { window.__pageSwarm.destroy(); } catch (_) {}
    return;
  }

  const SHOT = window.__pageSwarmShot || null;
  window.__pageSwarmShot = undefined;
  // Optional embed settings (used by the website, ignored by the extension):
  //   rating: false        → hide the rating prompt and ★ Rate button
  //   autoLiveAfter: ms    → fade back to the real page this long after the build finishes
  //   screens: n           → only rebuild the first n screen-heights (everything unlocks at once)
  const OPTS = window.__pageSwarmOptions || {};

  // ───────────────────────── constants & helpers ─────────────────────────
  const COLORS = ["#F24822", "#A259FF", "#1ABCFE", "#0ACF83", "#FF7262", "#FFC700", "#FF8A00", "#E040FB",
    "#00C2A8", "#5B6CFF", "#FF4F8B", "#2EC4B6"];
  const NAMES = ["Ava", "Kai", "Mo", "Lena", "Jun", "Rio", "Sam", "Noor", "Eli", "Tess", "Ravi", "Ivy", "Zed",
    "Mila", "Oz", "Pia", "Taro", "Uma", "Vik", "Wren", "Yara", "Leo", "Nia", "Ash"];
  const MAX_LAYERS = 3500;
  const MAX_SPAN = 40000;
  const BASE_AGENTS = 8;
  const MAX_AGENTS = 24;
  const CANCEL = Symbol("cancel");
  const TAU = Math.PI * 2;
  const NS = "http://www.w3.org/2000/svg";
  const TOP_Z = 2147480000;

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
  const px = (v) => parseFloat(v) || 0;
  const noop = () => {};

  function mk(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function place(el, x, y, w, h) {
    const s = el.style;
    s.left = x + "px";
    s.top = y + "px";
    if (w != null) s.width = w + "px";
    if (h != null) s.height = h + "px";
  }
  function alphaOf(c) {
    if (!c || c === "transparent" || c === "none") return 0;
    let m = c.match(/\/\s*([\d.]+)(%?)\s*\)\s*$/);
    if (m) return m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    m = c.match(/^rgba\(([^)]*)\)/);
    if (m) {
      const p = m[1].split(",");
      if (p.length === 4) return parseFloat(p[3]);
    }
    return 1;
  }
  function scrollToInstant(x, y) {
    try { window.scrollTo({ left: x, top: y, behavior: "instant" }); } catch (_) { window.scrollTo(x, y); }
  }
  function scrollByInstant(x, y) {
    try { window.scrollBy({ left: x, top: y, behavior: "instant" }); } catch (_) { window.scrollBy(x, y); }
  }

  // ───────────────────────── state, virtual clock, tweens ─────────────────────────
  const S = {
    alive: true, gen: 0, speed: 1, tour: false, tourAcc: 0, phase: "boot", vt: 0,
    mouse: { x: innerWidth / 2, y: innerHeight / 2 }, done: 0, firstOpen: 0,
    docH: 0, docW: 0, bg: "#fff", bodyIsCanvas: false, vw0: innerWidth,
  };
  let timers = [];
  let tweens = [];
  let agents = [];
  let tasks = [];
  let guides = [];
  let shotImg = null;


  function wait(ms) {
    const g = S.gen;
    return new Promise((res, rej) => timers.push({ at: S.vt + ms, res, rej, g }));
  }
  function tween(ms, fn) {
    const g = S.gen;
    return new Promise((res, rej) => {
      fn(0);
      tweens.push({ t0: S.vt, d: Math.max(1, ms), fn, res, rej, g });
    });
  }
  function cancelAll() {
    const t = timers, w = tweens;
    timers = [];
    tweens = [];
    t.forEach((x) => x.rej(CANCEL));
    w.forEach((x) => x.rej(CANCEL));
  }

  // ───────────────────────── sound (Web Audio, synthesized) ─────────────────────────
  const sound = (() => {
    let ctx = null, out = null, noiseBuf = null, on = true, lastSlot = -1;
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
    function init() {
      if (ctx) return;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        out = ctx.createGain();
        out.gain.value = 0.55;
        const comp = ctx.createDynamicsCompressor();
        out.connect(comp);
        comp.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.6), ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      } catch (_) { ctx = null; }
    }
    const ready = () => on && ctx && ctx.state === "running";
    function pan(p) {
      const n = ctx.createStereoPanner();
      n.pan.value = clamp(p || 0, -1, 1) * 0.7;
      n.connect(out);
      return n;
    }
    function noise(t, dur, freq, q, gain, dest, type = "bandpass") {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(dest);
      s.start(t, Math.random() * 0.4);
      s.stop(t + dur + 0.02);
    }
    function tone(t, freq, dur, gain, type, dest, attack = 0.004) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dest);
      o.start(t);
      o.stop(t + dur + 0.05);
      return o;
    }
    return {
      init,
      get locked() { return !ctx || ctx.state !== "running"; },
      get on() { return on; },
      unlock() { init(); if (ctx && ctx.state !== "running") ctx.resume().catch(noop); },
      toggle() { on = !on; if (on) this.unlock(); },
      click(p, v = 1) {
        if (!ready()) return;
        const t = ctx.currentTime, d = pan(p);
        noise(t, 0.022, 3400, 1.3, 0.32 * v, d);
        tone(t, 150, 0.04, 0.22 * v, "sine", d);
      },
      key(p, space) {
        if (!ready()) return;
        const t = ctx.currentTime, d = pan(p);
        noise(t, 0.016, space ? 2100 : 4000 + Math.random() * 900, 1.6, 0.2, d);
        tone(t, space ? 92 : 150 + Math.random() * 35, 0.05, 0.16, "triangle", d);
      },
      snap(p) {
        if (!ready()) return;
        const t = ctx.currentTime, d = pan(p);
        noise(t, 0.012, 6500, 2, 0.35, d);
        tone(t, 1900, 0.03, 0.05, "sine", d);
      },
      tick(level, p) {
        if (!ready()) return;
        const t = ctx.currentTime;
        tone(t, 520 + level * 760, 0.06, 0.06, "sine", pan(p));
      },
      note(area, xr, p) {
        if (!ready() || Math.random() < 0.35) return;
        const slot = Math.ceil(ctx.currentTime / 0.125);
        if (slot <= lastSlot) return;
        lastSlot = slot;
        const t = slot * 0.125;
        const PENTA = [0, 2, 4, 7, 9];
        const oct = area > 250000 ? 0 : area > 25000 ? 1 : 2;
        const f = mtof(52 + oct * 12 + PENTA[Math.floor(clamp(xr, 0, 0.999) * 5)]);
        const d = pan(p);
        tone(t, f, 1.3, 0.065, "sine", d, 0.003);
        tone(t, f * 2.005, 0.6, 0.022, "sine", d, 0.003);
        tone(t, f * 3.01, 0.3, 0.008, "sine", d, 0.002);
      },
      swell() {
        if (!ready()) return;
        const t = ctx.currentTime;
        const s = ctx.createBufferSource();
        s.buffer = noiseBuf; s.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.setValueAtTime(180, t);
        f.frequency.exponentialRampToValueAtTime(3200, t + 1.1);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.1, t + 0.7);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
        s.connect(f); f.connect(g); g.connect(out);
        s.start(t); s.stop(t + 1.6);
      },
      arp() {
        if (!ready()) return;
        const t = ctx.currentTime;
        [64, 68, 71, 76, 80].forEach((m, i) => tone(t + i * 0.07, mtof(m), 0.6, 0.05, "sine", out));
      },
      chord() {
        if (!ready()) return;
        const t = ctx.currentTime + 0.05;
        [52, 59, 64, 68, 71].forEach((m) => {
          tone(t, mtof(m), 2.8, 0.045, "sine", out, 0.08);
          tone(t, mtof(m) * 2.003, 1.6, 0.012, "sine", out, 0.08);
        });
      },
      sweep() {
        if (!ready()) return;
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(900, t);
        o.frequency.exponentialRampToValueAtTime(140, t + 0.6);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.07, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
        o.connect(g); g.connect(out);
        o.start(t); o.stop(t + 0.7);
      },
      close() { try { ctx && ctx.close(); } catch (_) {} },
    };
  })();

  // ───────────────────────── overlay DOM (isolated in a shadow root) ─────────────────────────
  const CSS = `
:host{all:initial}
.stage{position:fixed;inset:0;overflow:hidden;opacity:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;user-select:none;cursor:default;contain:strict;transition:opacity .6s ease}
.bg{position:absolute;inset:0}
.world{position:absolute;left:0;top:0;isolation:isolate}
.L{position:absolute;margin:0;box-sizing:border-box}
.media{overflow:hidden}
.ph{position:absolute;box-sizing:border-box;background:rgba(127,127,140,.14);outline:1px solid var(--c);z-index:${TOP_Z}}
.badge{position:absolute;left:50%;top:100%;margin-top:6px;transform:translateX(-50%);padding:2px 6px;border-radius:4px;background:var(--c);color:#fff;font:600 10.5px/15px Inter,system-ui,sans-serif;white-space:nowrap}
.tbox{position:absolute;box-sizing:border-box;outline:1px solid var(--c);z-index:${TOP_Z};pointer-events:none;transition:opacity .25s}
.caret{display:inline-block;width:0;height:1.05em;border-left:2px solid var(--c);margin-right:-2px;vertical-align:-.15em;animation:pswBlink 1s steps(1) infinite}
@keyframes pswBlink{50%{opacity:0}}
.sel{position:absolute;box-sizing:border-box;outline:1.5px solid var(--c);z-index:${TOP_Z + 1};pointer-events:none}
.sel i{position:absolute;width:7px;height:7px;background:#fff;border:1px solid var(--c);box-sizing:border-box}
.sel i:nth-child(1){left:-4px;top:-4px}.sel i:nth-child(2){right:-4px;top:-4px}.sel i:nth-child(3){left:-4px;bottom:-4px}.sel i:nth-child(4){right:-4px;bottom:-4px}
.ghost{position:absolute;opacity:.92;z-index:${TOP_Z - 1}}
.meas{position:absolute;background:#F24822;z-index:${TOP_Z + 2}}
.mlab{position:absolute;padding:1px 5px;border-radius:3px;background:#F24822;color:#fff;font:600 10px/14px Inter,system-ui,sans-serif;z-index:${TOP_Z + 3};transform:translate(-50%,-50%);white-space:nowrap}
.anchor{position:absolute;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;background:#fff;border:1.5px solid var(--c);box-sizing:border-box;z-index:${TOP_Z + 2}}
.guide{position:absolute;top:0;width:1px;background:#F24822;opacity:.45;z-index:${TOP_Z};pointer-events:none;transition:opacity .7s}
.fx{position:absolute;inset:0;pointer-events:none;z-index:3}
.fx .guide{height:100%;opacity:.45}
.fx .mlab{transform:translate(8px,-50%)}
.rulers{position:absolute;inset:0;pointer-events:none;z-index:4}
.rt,.rl{position:absolute;background-color:#fff;transition:transform .45s cubic-bezier(.2,.8,.2,1)}
.rt{left:0;right:0;top:0;height:18px;border-bottom:1px solid #e3e3e3;background-image:repeating-linear-gradient(90deg,#bbb 0 1px,transparent 1px 10px),repeating-linear-gradient(90deg,#888 0 1px,transparent 1px 100px);background-size:100% 5px,100% 10px;background-repeat:repeat-x;background-position:0 100%,0 100%;transform:translateY(-100%)}
.rl{left:0;top:0;bottom:0;width:18px;border-right:1px solid #e3e3e3;background-image:repeating-linear-gradient(180deg,#bbb 0 1px,transparent 1px 10px),repeating-linear-gradient(180deg,#888 0 1px,transparent 1px 100px);background-size:5px 100%,10px 100%;background-repeat:repeat-y;background-position:100% 0,100% 0;transform:translateX(-100%)}
.rulers.on .rt,.rulers.on .rl{transform:none}
.cursors{position:absolute;inset:0;pointer-events:none;z-index:6}
.cursor{position:absolute;left:0;top:0;will-change:transform}
.cursor .icon{transition:transform .08s;transform-origin:0 0;transform:scale(.72)}
.cursor.down .icon{transform:scale(.62)}
.cursor .icon svg{filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
.cursor .tag{position:absolute;left:10px;top:13px;padding:1px 5px 2px;border-radius:2px 6px 6px 6px;background:var(--c);color:#fff;font:600 9px/11px Inter,system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.18)}
.cursor[data-tool="cross"] .tag,.cursor[data-tool="ibeam"] .tag{left:9px;top:8px}
.logo{position:absolute;display:flex;align-items:center;justify-content:center;transform:translate(-50%,-50%) scale(.6);opacity:0;transition:transform .6s cubic-bezier(.2,.9,.3,1.3),opacity .5s}
.logo.on{transform:translate(-50%,-50%) scale(1);opacity:1}
.logo img,.logo svg{max-width:100%;max-height:100%;display:block}
.logo .letter{width:64px;height:64px;border-radius:16px;background:#111;color:#fff;font:700 30px/64px Inter,system-ui,sans-serif;text-align:center}
.bar{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:5px;background:rgba(30,30,32,.95);color:#eee;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.28),0 0 0 1px rgba(255,255,255,.06);font:500 12px/1 Inter,system-ui,sans-serif;z-index:7;white-space:nowrap;max-width:calc(100vw - 24px);overflow-x:auto;scrollbar-width:none}
.bar button{all:unset;cursor:pointer;padding:7px 10px;border-radius:8px;color:#ddd;font:inherit}
.bar button:hover{background:rgba(255,255,255,.1);color:#fff}
.bar button.on{background:#0d99ff;color:#fff}
.bar button.cta{background:#fff;color:#111;font-weight:600}
.bar button.cta:hover{background:#e9e9e9;color:#111}
.bar button.star{color:#FFC700}
.bar .sep{width:1px;height:18px;background:rgba(255,255,255,.14);margin:0 4px}
.bar .prog{display:flex;align-items:center;gap:8px;padding:0 8px 0 6px}
.bar .ptxt{min-width:74px}
.bar .track{width:64px;height:4px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden}
.bar .fill{height:100%;width:0;background:linear-gradient(90deg,#0acf83,#1abcfe,#a259ff);transition:width .2s}
.bar .dot{width:8px;height:8px;border-radius:50%;background:#0acf83;box-shadow:0 0 0 3px rgba(10,207,131,.22)}
.rate{position:absolute;left:50%;bottom:70px;transform:translate(-50%,10px);opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;background:#1e1e20;color:#eee;border-radius:14px;padding:16px 18px 12px;box-shadow:0 12px 36px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.07);font:500 13px/1.4 Inter,system-ui,sans-serif;text-align:center;z-index:8;min-width:250px}
.rate.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}
.rate h4{margin:0 0 4px;font:600 15px/1.3 Inter,system-ui,sans-serif;color:#fff}
.rate p{margin:0 0 10px;color:#aaa;font-size:12px}
.rate .stars{display:flex;justify-content:center;gap:4px;margin-bottom:8px}
.rate .stars button{all:unset;cursor:pointer;font-size:28px;line-height:1;color:#555;transition:transform .12s,color .12s}
.rate .stars button.lit{color:#FFC700}
.rate .stars button:hover{transform:scale(1.15)}
.rate .later{all:unset;cursor:pointer;color:#888;font-size:12px;padding:4px 8px;border-radius:6px}
.rate .later:hover{color:#ddd;background:rgba(255,255,255,.08)}
.hide{display:none!important}
`;

  const host = document.createElement("page-swarm-root");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;display:block;";
  const shadow = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  const stage = mk("div", "stage");
  const bgEl = mk("div", "bg");
  const docWorld = mk("div", "world doc");
  const fixedWorld = mk("div", "world fixed");
  const fx = mk("div", "fx");
  const rulers = mk("div", "rulers");
  rulers.append(mk("div", "rt"), mk("div", "rl"));
  const cursorsEl = mk("div", "cursors");
  stage.append(bgEl, docWorld, fixedWorld, fx, rulers, cursorsEl);
  shadow.append(styleEl, stage);

  const world = (frame) => (frame === "fixed" ? fixedWorld : docWorld);

  // ───────────────────────── cursor tool icons ─────────────────────────
  function svgIcon(w, h, ox, oy, shapes) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("width", w);
    s.setAttribute("height", h);
    s.setAttribute("viewBox", `0 0 ${w} ${h}`);
    s.style.cssText = `display:block;margin:${-oy}px 0 0 ${-ox}px;overflow:visible`;
    for (const [tag, attrs] of shapes) {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      s.append(e);
    }
    return s;
  }
  const ARROW = "M1.5 1.5v15.6l4.3-4 2.9 6.5 2.8-1.2-2.8-6.4h6z";
  const IBEAM = "M2 1.5h3l1 1 1-1h3M6 2.5v17M2 20.5h3l1-1 1 1h3";
  const TOOLS = {
    arrow: (c) => svgIcon(20, 22, 1.5, 1.5, [["path", { d: ARROW, fill: c, stroke: "#fff", "stroke-width": 1.5, "stroke-linejoin": "round" }]]),
    dup: (c) => svgIcon(24, 24, 1.5, 1.5, [
      ["path", { d: ARROW, fill: c, stroke: "#fff", "stroke-width": 1.5, "stroke-linejoin": "round" }],
      ["circle", { cx: 17.5, cy: 18.5, r: 5, fill: "#fff", stroke: "#222", "stroke-width": 1 }],
      ["path", { d: "M17.5 16v5M15 18.5h5", stroke: "#222", "stroke-width": 1.4 }],
    ]),
    cross: () => svgIcon(21, 21, 10.5, 10.5, [
      ["path", { d: "M10.5 1v19M1 10.5h19", stroke: "#fff", "stroke-width": 3.4, "stroke-linecap": "round" }],
      ["path", { d: "M10.5 1.8v17.4M1.8 10.5h17.4", stroke: "#111", "stroke-width": 1.3 }],
    ]),
    ibeam: () => svgIcon(12, 22, 6, 11, [
      ["path", { d: IBEAM, fill: "none", stroke: "#fff", "stroke-width": 3.2, "stroke-linecap": "round", "stroke-linejoin": "round" }],
      ["path", { d: IBEAM, fill: "none", stroke: "#111", "stroke-width": 1.3, "stroke-linecap": "round", "stroke-linejoin": "round" }],
    ]),
    pen: () => svgIcon(22, 22, 1.5, 1.5, [
      ["path", { d: "M1.5 1.5l5 13.5 3.2-3.2 6.3 6.3 2.4-2.4-6.3-6.3 3.2-3.2z", fill: "#111", stroke: "#fff", "stroke-width": 1.4, "stroke-linejoin": "round" }],
      ["circle", { cx: 7.6, cy: 7.6, r: 1.4, fill: "#fff" }],
    ]),
  };

  // ───────────────────────── agents ─────────────────────────
  let agentSeq = 0;
  class Agent {
    constructor(x, y, frame) {
      const i = agentSeq++;
      this.i = i;
      this.color = COLORS[i % COLORS.length];
      this.name = NAMES[i % NAMES.length];
      this.x = x; this.y = y;
      this.frame = frame || "fixed";
      this.vx = 0; this.vy = 0;
      this.tool = "";
      this.el = mk("div", "cursor");
      this.el.style.setProperty("--c", this.color);
      this.icon = mk("div", "icon");
      const tag = mk("div", "tag");
      tag.textContent = this.name;
      this.el.append(this.icon, tag);
      cursorsEl.append(this.el);
      this.setTool("arrow");
      this.render();
    }
    setTool(t) {
      if (t === this.tool) return;
      this.tool = t;
      this.icon.replaceChildren(TOOLS[t](this.color));
      this.el.dataset.tool = t;
    }
    screen() {
      return this.frame === "doc" ? { x: this.x - scrollX, y: this.y - scrollY } : { x: this.x, y: this.y };
    }
    setFrame(f) {
      if (f === this.frame) return;
      const p = this.screen();
      if (f === "doc") { this.x = p.x + scrollX; this.y = p.y + scrollY; } else { this.x = p.x; this.y = p.y; }
      this.frame = f;
    }
    pan() { return clamp((this.screen().x / innerWidth) * 2 - 1, -1, 1); }
    async moveTo(x, y, frame = "doc", mul = 1) {
      this.setFrame(frame);
      const x0 = this.x, y0 = this.y;
      const d = Math.hypot(x - x0, y - y0);
      if (d < 0.5) return;
      const dur = clamp(160 + Math.sqrt(d) * 22, 180, 950) / mul;
      const bend = (Math.random() - 0.5) * Math.min(d * 0.25, 80);
      const nx = -(y - y0) / d, ny = (x - x0) / d;
      const cx = (x0 + x) / 2 + nx * bend, cy = (y0 + y) / 2 + ny * bend;
      await tween(dur, (p) => {
        const t = ease(p), u = 1 - t;
        this.x = u * u * x0 + 2 * u * t * cx + t * t * x;
        this.y = u * u * y0 + 2 * u * t * cy + t * t * y;
      });
    }
    down() { this.el.classList.add("down"); sound.click(this.pan()); }
    up() { this.el.classList.remove("down"); sound.click(this.pan(), 0.45); }
    render() {
      const p = this.screen();
      this.el.style.transform = `translate(${p.x}px,${p.y}px)`;
    }
    remove() { this.el.remove(); }
  }
  // convert a screen point into a frame's coordinates
  const toFrame = (sx, sy, frame) => (frame === "doc" ? { x: sx + scrollX, y: sy + scrollY } : { x: sx, y: sy });

  // ───────────────────────── snapshot: DOM → blueprint ─────────────────────────
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "HEAD", "TITLE", "BR", "WBR",
    "SOURCE", "TRACK", "PARAM", "AREA", "MAP", "DATALIST", "OPTION", "OPTGROUP", "PAGE-SWARM-ROOT"]);
  const MEDIA_TAGS = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "EMBED", "OBJECT"]);
  const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
  const BLOCKISH = new Set([...MEDIA_TAGS, ...FORM_TAGS, "PICTURE", "BUTTON"]);
  const TP = ["color", "fontFamily", "fontWeight", "fontStyle", "fontStretch", "fontVariantCaps", "fontVariantNumeric",
    "fontVariantLigatures", "fontFeatureSettings", "fontVariationSettings", "letterSpacing", "wordSpacing",
    "textTransform", "textDecorationLine", "textDecorationColor", "textDecorationStyle", "textDecorationThickness",
    "textUnderlineOffset", "textShadow", "webkitTextFillColor", "webkitTextStrokeWidth", "webkitTextStrokeColor",
    "fontKerning", "textRendering"];
  const SIDES = ["Top", "Right", "Bottom", "Left"];

  function textStyle(c, st, parentPx) {
    for (const p of TP) { const v = c[p]; if (v) st[p] = v; }
    const fs = px(c.fontSize) || 16;
    st.fontSize = parentPx ? (fs / parentPx).toFixed(4) + "em" : fs + "px";
    st.lineHeight = c.lineHeight === "normal" ? "normal" : (px(c.lineHeight) / fs).toFixed(4);
    if (c.whiteSpace) st.whiteSpace = c.whiteSpace;
  }
  function inlineBox(c, st) {
    if (alphaOf(c.backgroundColor) > 0) st.backgroundColor = c.backgroundColor;
    if (c.backgroundImage && c.backgroundImage !== "none") {
      st.backgroundImage = c.backgroundImage;
      st.backgroundSize = c.backgroundSize;
      st.backgroundPosition = c.backgroundPosition;
      st.backgroundRepeat = c.backgroundRepeat;
      if (c.backgroundClip === "text" || c.webkitBackgroundClip === "text") {
        st.webkitBackgroundClip = "text";
        st.backgroundClip = "text";
      }
    }
    for (const s of SIDES) {
      const pv = c["padding" + s];
      if (pv && pv !== "0px") st["padding" + s] = pv;
      if (px(c["border" + s + "Width"]) > 0 && c["border" + s + "Style"] !== "none")
        st["border" + s] = `${c["border" + s + "Width"]} ${c["border" + s + "Style"]} ${c["border" + s + "Color"]}`;
      const m = c["margin" + s];
      if (m && m !== "0px") st["margin" + s] = m;
    }
    if (c.borderRadius && c.borderRadius !== "0px") st.borderRadius = c.borderRadius;
    if (c.verticalAlign && c.verticalAlign !== "baseline") st.verticalAlign = c.verticalAlign;
  }
  function ownerStyle(c, st) {
    textStyle(c, st, 0);
    st.boxSizing = "border-box";
    st.padding = `${c.paddingTop} ${c.paddingRight} ${c.paddingBottom} ${c.paddingLeft}`;
    st.borderStyle = "solid";
    st.borderColor = "transparent";
    st.borderWidth = `${c.borderTopWidth} ${c.borderRightWidth} ${c.borderBottomWidth} ${c.borderLeftWidth}`;
    for (const p of ["textAlign", "textIndent", "wordBreak", "overflowWrap", "hyphens", "direction", "tabSize",
      "textAlignLast", "writingMode", "unicodeBidi"]) if (c[p]) st[p] = c[p];
    const d = c.display || "block";
    if (d.includes("flex") || d.includes("grid")) {
      st.display = d.includes("grid") ? "grid" : "flex";
      for (const p of ["flexDirection", "flexWrap", "justifyContent", "alignItems", "alignContent", "rowGap",
        "columnGap", "gridTemplateColumns", "gridTemplateRows", "gridAutoFlow", "gridAutoColumns", "gridAutoRows",
        "justifyItems"]) if (c[p]) st[p] = c[p];
    } else if (d === "list-item") {
      st.display = "list-item";
      st.listStyleType = c.listStyleType;
      st.listStylePosition = c.listStylePosition;
      if (c.listStyleImage && c.listStyleImage !== "none") st.listStyleImage = c.listStyleImage;
    } else if (d === "table-cell") {
      st.display = "flex";
      st.flexDirection = "column";
      st.justifyContent = c.verticalAlign === "middle" ? "center" : c.verticalAlign === "bottom" ? "flex-end" : "flex-start";
    } else st.display = "block";
    if (c.overflowX !== "visible" || c.overflowY !== "visible") {
      st.overflow = "hidden";
      if (c.textOverflow) st.textOverflow = c.textOverflow;
    }
    if (c.webkitLineClamp && c.webkitLineClamp !== "none") {
      st.display = "-webkit-box";
      st.webkitBoxOrient = "vertical";
      st.webkitLineClamp = c.webkitLineClamp;
      st.overflow = "hidden";
    }
    if (c.backgroundClip === "text" || c.webkitBackgroundClip === "text") {
      st.backgroundImage = c.backgroundImage;
      st.backgroundColor = c.backgroundColor;
      st.backgroundSize = c.backgroundSize;
      st.backgroundPosition = c.backgroundPosition;
      st.backgroundRepeat = c.backgroundRepeat;
      st.webkitBackgroundClip = "text";
      st.backgroundClip = "text";
    }
    if (px(c.opacity) < 1) st.opacity = c.opacity;
  }
  function pseudoText(el, which) {
    let p;
    try { p = getComputedStyle(el, which); } catch (_) { return null; }
    const ct = p.content;
    if (!ct || ct === "none" || ct === "normal" || p.display === "none") return null;
    if (p.position === "absolute" || p.position === "fixed") return null;
    const m = ct.match(/^"([\s\S]*)"$/);
    if (!m || !m[1] || !m[1].trim()) return null;
    return { p, text: m[1].replace(/\\"/g, '"') };
  }
  function ownsText(el, depth = 0) {
    if (pseudoText(el, "::before") || pseudoText(el, "::after")) return true;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { if (/\S/.test(n.nodeValue)) return true; }
      else if (n.nodeType === 1 && depth < 6 && !SKIP.has(n.tagName) && !BLOCKISH.has(n.tagName) && !(n instanceof SVGElement)) {
        const d = getComputedStyle(n).display;
        if ((d === "inline" || d === "contents") && ownsText(n, depth + 1)) return true;
      }
    }
    return false;
  }
  function spacer(n, c) {
    const r = n.getBoundingClientRect();
    const s = document.createElement("span");
    const inl = (c.display || "").startsWith("inline");
    s.style.cssText = `display:${inl ? "inline-block" : "block"};width:${r.width}px;height:${r.height}px;` +
      `margin:${c.marginTop} ${c.marginRight} ${c.marginBottom} ${c.marginLeft};vertical-align:${c.verticalAlign};` +
      `float:${c.cssFloat};flex:none;visibility:hidden;align-self:${c.alignSelf};order:${c.order};` +
      `grid-column:${c.gridColumnStart} / ${c.gridColumnEnd};grid-row:${c.gridRowStart} / ${c.gridRowEnd};`;
    return s;
  }
  function addPseudo(el, which, dst, parentPx) {
    const ps = pseudoText(el, which);
    if (!ps) return;
    const s = document.createElement("span");
    textStyle(ps.p, s.style, parentPx);
    inlineBox(ps.p, s.style);
    if (ps.p.display !== "inline") s.style.display = "inline-block";
    s.textContent = ps.text;
    dst.append(s);
  }
  // Rebuilds an element's inline flow as plain spans; non-inline children become invisible spacers.
  function cloneInto(src, dst, parentPx, blocks, pre) {
    addPseudo(src, "::before", dst, parentPx);
    for (const n of src.childNodes) {
      if (n.nodeType === 3) {
        const v = pre ? n.nodeValue : n.nodeValue.replace(/[\t\n\r ]+/g, " ");
        if (v) dst.append(document.createTextNode(v));
      } else if (n.nodeType === 1) {
        const t = n.tagName;
        if (t === "BR") { dst.append(document.createElement("br")); continue; }
        if (SKIP.has(t)) continue;
        const c = getComputedStyle(n);
        if (c.display === "none") continue;
        if (c.display === "contents" && !BLOCKISH.has(t)) { cloneInto(n, dst, parentPx, blocks, pre); continue; }
        if (c.display === "inline" && !BLOCKISH.has(t) && !(n instanceof SVGElement) && !n.shadowRoot) {
          const sp = document.createElement("span");
          textStyle(c, sp.style, parentPx);
          inlineBox(c, sp.style);
          cloneInto(n, sp, px(c.fontSize) || parentPx, blocks, pre);
          dst.append(sp);
        } else {
          blocks.push(n);
          if (c.position === "absolute" || c.position === "fixed") continue;
          dst.append(spacer(n, c));
        }
      }
    }
    addPseudo(src, "::after", dst, parentPx);
  }
  function cloneSvg(el) {
    const c = el.cloneNode(true);
    const src = el.querySelectorAll("*"), dst = c.querySelectorAll("*");
    if (src.length <= 600) {
      for (let i = 0; i < src.length; i++) {
        const s = src[i], d = dst[i];
        if (!(s instanceof SVGElement) || !d) continue;
        const k = getComputedStyle(s);
        const st = d.style;
        if (k.fill && !k.fill.startsWith("url")) st.fill = k.fill;
        if (k.stroke && !k.stroke.startsWith("url")) st.stroke = k.stroke;
        st.strokeWidth = k.strokeWidth;
        st.opacity = k.opacity;
        st.fillOpacity = k.fillOpacity;
        st.strokeOpacity = k.strokeOpacity;
        if (k.display === "none") st.display = "none";
      }
    }
    const ks = getComputedStyle(el);
    if (ks.fill && !ks.fill.startsWith("url")) c.style.fill = ks.fill;
    if (ks.stroke && !ks.stroke.startsWith("url")) c.style.stroke = ks.stroke;
    c.style.color = ks.color;
    const defs = document.createElementNS(NS, "defs");
    const seen = new Set();
    for (const u of c.querySelectorAll("use")) {
      const h = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
      if (!h.startsWith("#") || seen.has(h)) continue;
      seen.add(h);
      try {
        if (!c.querySelector(h)) {
          const ref = document.getElementById(h.slice(1));
          if (ref) defs.append(ref.cloneNode(true));
        }
      } catch (_) {}
    }
    if (defs.childNodes.length) c.prepend(defs);
    c.removeAttribute("class");
    return c;
  }
  function rectStyle(cs, skipBg) {
    const st = {};
    let vis = false;
    const clipText = cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text";
    if (!skipBg && !clipText) {
      if (alphaOf(cs.backgroundColor) > 0) { st.backgroundColor = cs.backgroundColor; vis = true; }
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        st.backgroundImage = cs.backgroundImage;
        st.backgroundSize = cs.backgroundSize;
        st.backgroundPosition = cs.backgroundPosition;
        st.backgroundRepeat = cs.backgroundRepeat;
        st.backgroundOrigin = cs.backgroundOrigin;
        st.backgroundClip = cs.backgroundClip;
        vis = true;
      }
    }
    if (cs.boxShadow && cs.boxShadow !== "none") { st.boxShadow = cs.boxShadow; vis = true; }
    if (cs.backdropFilter && cs.backdropFilter !== "none") {
      st.backdropFilter = cs.backdropFilter;
      st.webkitBackdropFilter = cs.backdropFilter;
      vis = true;
    }
    const sides = SIDES.map((s) => ({ s, w: px(cs["border" + s + "Width"]), st: cs["border" + s + "Style"], c: cs["border" + s + "Color"] }))
      .filter((o) => o.w > 0 && o.st !== "none" && o.st !== "hidden" && alphaOf(o.c) > 0);
    const rounded = cs.borderRadius && cs.borderRadius !== "0px";
    const lines = [];
    if (sides.length === 4 || (sides.length && (vis || rounded))) {
      for (const o of sides) st["border" + o.s] = `${o.w}px ${o.st} ${o.c}`;
      vis = true;
    } else lines.push(...sides);
    if (!vis && !lines.length) return null;
    if (vis) {
      if (rounded) st.borderRadius = cs.borderRadius;
      if (px(cs.opacity) < 1) st.opacity = cs.opacity;
      if (cs.filter && cs.filter !== "none") st.filter = cs.filter;
    }
    return { style: vis ? st : null, lines };
  }
  function lineBox(o, b) {
    switch (o.s) {
      case "Top": return { x: b.x, y: b.y, w: b.w, h: o.w, dir: "h" };
      case "Bottom": return { x: b.x, y: b.y + b.h - o.w, w: b.w, h: o.w, dir: "h" };
      case "Left": return { x: b.x, y: b.y, w: o.w, h: b.h, dir: "v" };
      default: return { x: b.x + b.w - o.w, y: b.y, w: o.w, h: b.h, dir: "v" };
    }
  }

  function snapshot() {
    const sx = scrollX, sy = scrollY, vw = innerWidth, vh = innerHeight;
    const de = document.documentElement, body = document.body;
    const docW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0, vw);
    const docH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0, vh);
    const yMin = Math.max(0, sy - 8000);
    const yMax = OPTS.screens > 0 ? sy + vh * OPTS.screens : yMin + MAX_SPAN;
    S.docW = docW;
    S.docH = Math.min(docH, yMax);
    const layers = [], subs = [];
    let order = 0;

    const box = (r, fixed) => ({ x: r.left + (fixed ? 0 : sx), y: r.top + (fixed ? 0 : sy), w: r.width, h: r.height });
    const kidsOf = (el) => (el.shadowRoot ? [...el.shadowRoot.children] : [...el.children]);
    function put(L, ctx) {
      if (layers.length >= MAX_LAYERS) return null;
      L.id = layers.length;
      L.z = ++order;
      L.sub = ctx.sub || null;
      if (ctx.sub) ctx.sub.layers.push(L);
      layers.push(L);
      return L;
    }

    function mediaOf(el, tag, cs, r) {
      const radius = cs.borderRadius;
      if (tag === "IMG") {
        const src = el.currentSrc || el.src;
        if (!src) return null;
        return { kind: "media", type: "img", src, fit: cs.objectFit, pos: cs.objectPosition, radius, filter: cs.filter, opacity: px(cs.opacity) };
      }
      if (el instanceof SVGSVGElement) return { kind: "media", type: "svg", svg: cloneSvg(el), color: cs.color, radius };
      let crop = null, src = null;
      if (shotImg) {
        const l = Math.max(0, r.left), t = Math.max(0, r.top);
        const rr = Math.min(vw, r.right), bb = Math.min(vh, r.bottom);
        if (rr - l > 4 && bb - t > 4) crop = { l, t, w: rr - l, h: bb - t, ox: l - r.left, oy: t - r.top };
      }
      if (!crop && tag === "CANVAS") {
        try { src = el.toDataURL(); if (src.length < 300) src = null; } catch (_) { src = null; }
      }
      if (!crop && !src && tag === "VIDEO" && el.poster) src = el.poster;
      return { kind: "media", type: "box", src, crop, radius, label: tag.toLowerCase() };
    }

    function formLayers(el, tag, cs, b, frame, ctx) {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "hidden" || b.w < 2 || b.h < 2) return;
      if (tag === "INPUT" && (type === "checkbox" || type === "radio")) {
        const ac = cs.accentColor && cs.accentColor !== "auto" ? cs.accentColor : "#0075ff";
        put({ kind: "rect", frame, ...b, parent: ctx.parent, style: {
          border: "1.5px solid " + (el.checked ? ac : "#767676"),
          borderRadius: type === "radio" ? "50%" : "3px",
          backgroundColor: el.checked ? ac : "#fff",
          boxShadow: el.checked && type === "radio" ? "inset 0 0 0 3px #fff" : "none",
        } }, ctx);
        return;
      }
      const rs = rectStyle(cs);
      let pid = ctx.parent;
      if (rs && rs.style) { const L = put({ kind: "rect", style: rs.style, frame, ...b, parent: ctx.parent }, ctx); if (L) pid = L.id; }
      let text = "", ph = false;
      if (tag === "SELECT") text = el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : "";
      else if (type === "password") text = "•".repeat((el.value || "").length);
      else if (!/^(file|color|range|image)$/.test(type)) text = el.value || "";
      if (!text && el.placeholder) { text = el.placeholder; ph = true; }
      if (!text.trim()) return;
      const node = document.createElement("div");
      ownerStyle(cs, node.style);
      if (ph) {
        try { const pc = getComputedStyle(el, "::placeholder").color; node.style.color = pc; node.style.webkitTextFillColor = pc; } catch (_) {}
      }
      node.textContent = text;
      if (tag !== "TEXTAREA") {
        node.style.display = "flex";
        node.style.alignItems = "center";
        node.style.whiteSpace = "pre";
        node.style.overflow = "hidden";
        if (/^(submit|button|reset)$/.test(type)) node.style.justifyContent = "center";
      } else {
        node.style.overflow = "hidden";
        node.style.whiteSpace = "pre-wrap";
      }
      put({ kind: "text", node, fs: px(cs.fontSize) || 13, cx: b.x + px(cs.paddingLeft) + px(cs.borderLeftWidth), frame, ...b, parent: pid }, ctx);
    }

    function walk(el, ctx) {
      if (layers.length >= MAX_LAYERS || el === host) return;
      const tag = el.tagName;
      if (SKIP.has(tag)) return;
      if (tag === "SLOT") { walkList(el.assignedElements({ flatten: true }), ctx); return; }
      const cs = getComputedStyle(el);
      const disp = cs.display;
      if (disp === "none") return;
      if (disp === "contents") { walkList(kidsOf(el), ctx); return; }
      if (px(cs.opacity) < 0.02) return;
      const fixed = ctx.fixed || cs.position === "fixed";
      const r = el.getBoundingClientRect();
      const b = box(r, fixed);
      const frame = fixed ? "fixed" : "doc";
      let clip = fixed && !ctx.fixed ? null : ctx.clip;
      if (b.w > 0 && b.h > 0) {
        if (!fixed && (b.y > yMax || b.y + b.h < yMin)) return;
        if (clip && (b.x >= clip.x2 || b.y >= clip.y2 || b.x + b.w <= clip.x1 || b.y + b.h <= clip.y1)) return;
        if (b.x >= docW + 1 || b.x + b.w <= 0) return;
      }
      const vis = cs.visibility === "visible";
      if (MEDIA_TAGS.has(tag) || el instanceof SVGSVGElement) {
        if (vis && b.w >= 2 && b.h >= 2) {
          const m = mediaOf(el, tag, cs, r);
          if (m) put({ ...m, frame, ...b, parent: ctx.parent }, ctx);
        }
        return;
      }
      if (FORM_TAGS.has(tag)) { if (vis) formLayers(el, tag, cs, b, frame, ctx); return; }
      let pid = ctx.parent;
      if (vis && b.w >= 1 && b.h >= 1) {
        const rs = rectStyle(cs, el === body && S.bodyIsCanvas);
        if (rs) {
          if (rs.style) { const L = put({ kind: "rect", style: rs.style, frame, ...b, parent: ctx.parent }, ctx); if (L) pid = L.id; }
          for (const o of rs.lines) put({ kind: "line", frame, ...lineBox(o, b), color: o.c, lstyle: o.st, thick: o.w, parent: pid }, ctx);
        }
      }
      if ((cs.overflowX !== "visible" || cs.overflowY !== "visible") && el !== body && b.w > 0) {
        const c = { x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h };
        clip = clip ? { x1: Math.max(clip.x1, c.x1), y1: Math.max(clip.y1, c.y1), x2: Math.min(clip.x2, c.x2), y2: Math.min(clip.y2, c.y2) } : c;
      }
      const nctx = { fixed, clip, parent: pid, sub: ctx.sub };
      let kids;
      if (!el.shadowRoot && vis && ownsText(el)) {
        const blocks = [];
        const node = document.createElement("div");
        ownerStyle(cs, node.style);
        const pre = /^(pre|break-spaces)/.test(cs.whiteSpace);
        cloneInto(el, node, px(cs.fontSize) || 16, blocks, pre);
        if (node.textContent.replace(/\s+/g, "").length > 0) {
          put({ kind: "text", node, fs: px(cs.fontSize) || 16, cx: b.x + px(cs.paddingLeft) + px(cs.borderLeftWidth), frame, ...b, parent: pid }, nctx);
        }
        kids = blocks;
      } else kids = kidsOf(el);
      walkList(kids, nctx);
    }

    // walks siblings; detects repeated siblings (nav links, cards, rows) → master + duplicates
    function walkList(list, ctx) {
      let groups = null;
      if (!ctx.sub && list.length >= 3) {
        const map = new Map();
        for (const c of list) {
          if (c.nodeType !== 1 || SKIP.has(c.tagName)) continue;
          const r = c.getBoundingClientRect();
          if (r.width < 16 || r.height < 10) continue;
          const cls = typeof c.className === "string" ? c.className.trim() : "";
          const k = c.tagName + "|" + cls + "|" + Math.round(r.width / 6) + "|" + Math.round(r.height / 6);
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(c);
        }
        for (const arr of map.values()) {
          if (arr.length < 3) continue;
          groups = groups || new Map();
          const master = { isMaster: true, layers: [] };
          arr.forEach((c, i) => groups.set(c, i === 0 ? master : { isMaster: false, master, layers: [] }));
        }
      }
      for (const c of list) {
        if (!c || c.nodeType !== 1) continue;
        const g = groups && groups.get(c);
        if (g) {
          const fixed = ctx.fixed || getComputedStyle(c).position === "fixed";
          Object.assign(g, box(c.getBoundingClientRect(), fixed), { frame: fixed ? "fixed" : "doc" });
          subs.push(g);
          walk(c, { ...ctx, sub: g });
        } else walk(c, ctx);
      }
    }

    if (body) walk(body, { fixed: false, clip: null, parent: -1, sub: null });
    return { layers, subs };
  }

  function makeGuides(layers) {
    const map = new Map();
    for (const L of layers) {
      if (L.kind !== "text" || L.frame !== "doc" || (L.sub && !L.sub.isMaster)) continue;
      const k = Math.round(L.cx);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(L);
    }
    const ranked = [...map.entries()].filter(([, a]) => a.length >= 4).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
    const out = [];
    for (const [x, arr] of ranked) {
      if (out.length >= 5 || out.some((g) => Math.abs(g.x - x) < 10)) continue;
      const g = { id: out.length, x, y: Math.min(...arr.map((l) => l.y)), y1: Math.max(...arr.map((l) => l.y + l.h)), el: null, task: null };
      out.push(g);
      arr.forEach((l) => { l.guide = g.id; });
    }
    return out;
  }

  function buildTasks(layers, subs, gs) {
    const list = [];
    const byLayer = new Map();
    for (const g of gs) {
      const t = { kind: "guide", guide: g, frame: "doc", x: g.x, y: g.y - 12, deps: [] };
      g.task = t;
      list.push(t);
    }
    for (const L of layers) {
      if (L.sub && !L.sub.isMaster) continue;
      const t = { kind: L.kind, layer: L, frame: L.frame, x: L.x, y: L.y, deps: [] };
      list.push(t);
      byLayer.set(L.id, t);
    }
    for (const D of subs) {
      if (D.isMaster || !D.layers.length) continue;
      const own = new Set(D.layers.map((l) => l.id));
      const t = { kind: "dup", sub: D, frame: D.frame, x: D.x, y: D.y, deps: [] };
      for (const L of D.master.layers) { const mt = byLayer.get(L.id); if (mt) t.deps.push(mt); }
      for (const L of D.layers) {
        if (L.parent != null && L.parent >= 0 && !own.has(L.parent) && byLayer.has(L.parent)) {
          const pt = byLayer.get(L.parent);
          if (!t.deps.includes(pt)) t.deps.push(pt);
        }
      }
      list.push(t);
    }
    for (const t of list) {
      if (!t.layer) continue;
      const p = t.layer.parent;
      if (p != null && p >= 0 && byLayer.has(p)) t.deps.push(byLayer.get(p));
      if (t.layer.guide != null && gs[t.layer.guide]) t.deps.push(gs[t.layer.guide].task);
    }
    list.sort((a, b) => (a.frame === b.frame ? a.y - b.y || a.x - b.x : a.frame === "fixed" ? -1 : 1));
    list.forEach((t) => { t.state = "ready"; t.el = null; t.els = null; });
    return list;
  }

  // ───────────────────────── rendering layers ─────────────────────────
  function renderMedia(L) {
    const el = mk("div", "L media");
    if (L.radius && L.radius !== "0px") el.style.borderRadius = L.radius;
    if (L.type === "img") {
      const im = document.createElement("img");
      im.src = L.src;
      im.alt = "";
      im.draggable = false;
      im.style.cssText = `display:block;width:100%;height:100%;object-fit:${L.fit || "fill"};object-position:${L.pos || "50% 50%"};`;
      if (L.filter && L.filter !== "none") im.style.filter = L.filter;
      if (L.opacity < 1) el.style.opacity = L.opacity;
      el.append(im);
    } else if (L.type === "svg") {
      const s = L.svg.cloneNode(true);
      s.style.display = "block";
      s.style.width = "100%";
      s.style.height = "100%";
      el.style.color = L.color;
      el.style.overflow = "visible";
      el.append(s);
    } else {
      el.style.background = "repeating-linear-gradient(45deg,#ececf0 0 10px,#e3e3e9 10px 20px)";
      if (L.crop && shotImg) {
        const k = shotImg.naturalWidth / S.vw0;
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(L.crop.w * k));
        cv.height = Math.max(1, Math.round(L.crop.h * k));
        try { cv.getContext("2d").drawImage(shotImg, L.crop.l * k, L.crop.t * k, L.crop.w * k, L.crop.h * k, 0, 0, cv.width, cv.height); } catch (_) {}
        cv.style.cssText = `position:absolute;left:${L.crop.ox}px;top:${L.crop.oy}px;width:${L.crop.w}px;height:${L.crop.h}px`;
        el.append(cv);
      } else if (L.src) {
        const im = document.createElement("img");
        im.src = L.src;
        im.style.cssText = "display:block;width:100%;height:100%;object-fit:cover";
        el.append(im);
      }
    }
    return el;
  }
  function renderLayer(L, dx = 0, dy = 0) {
    let el;
    if (L.kind === "rect") {
      el = mk("div", "L");
      Object.assign(el.style, L.style);
    } else if (L.kind === "line") {
      el = mk("div", "L");
      if (L.lstyle === "solid" || L.lstyle === "double" || L.lstyle === "groove" || L.lstyle === "ridge" || L.lstyle === "inset" || L.lstyle === "outset") el.style.background = L.color;
      else el.style[L.dir === "h" ? "borderTop" : "borderLeft"] = `${L.thick}px ${L.lstyle} ${L.color}`;
    } else if (L.kind === "text") {
      el = L.node.cloneNode(true);
      el.classList.add("L");
    } else el = renderMedia(L);
    el.style.position = "absolute";
    el.style.left = L.x + dx + "px";
    el.style.top = L.y + dy + "px";
    el.style.width = L.w + "px";
    el.style.height = L.h + "px";
    el.style.zIndex = L.z;
    return el;
  }
  function textNodes(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) if (n.nodeValue) out.push(n);
    return out;
  }

  // ───────────────────────── task scripts ─────────────────────────
  // Each script gets (agent, task, tmp): tmp collects helper elements that are removed afterwards.

  async function dragBox(a, L, tmp, label) {
    const C = world(L.frame);
    a.setTool("cross");
    await a.moveTo(L.x, L.y, L.frame);
    a.down();
    const ph = mk("div", "ph");
    ph.style.setProperty("--c", a.color);
    place(ph, L.x, L.y, 0, 0);
    let badge = null;
    if (label) { badge = mk("div", "badge"); ph.append(badge); }
    C.append(ph);
    tmp.push(ph);
    const maxCursorY = L.frame === "doc" ? Math.max(L.y + 30, scrollY + innerHeight - 50) : innerHeight - 50;
    const ey = Math.min(L.y + L.h, maxCursorY);
    await tween(clamp(260 + Math.sqrt(L.w * L.h) * 1.1, 300, 1100), (p) => {
      const e = easeOut(p);
      const w = L.w * e, h = L.h * e;
      ph.style.width = w + "px";
      ph.style.height = h + "px";
      a.x = L.x + w;
      a.y = lerp(L.y, ey, e);
      if (badge) badge.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    });
    a.up();
    sound.note(L.w * L.h, (L.x - (L.frame === "doc" ? scrollX : 0)) / innerWidth, a.pan());
    return ph;
  }

  async function doRect(a, t, tmp) {
    const L = t.layer;
    const ph = await dragBox(a, L, tmp, true);
    const el = renderLayer(L);
    el.style.opacity = "0";
    world(L.frame).append(el);
    t.el = el;
    const op = L.style && L.style.opacity ? parseFloat(L.style.opacity) : 1;
    await tween(260, (p) => { el.style.opacity = String(p * op); ph.style.opacity = String(1 - p); });
    el.style.opacity = L.style && L.style.opacity ? L.style.opacity : "";
    a.setTool("arrow");
  }

  async function doMedia(a, t, tmp) {
    const L = t.layer;
    const ph = await dragBox(a, L, tmp, true);
    const el = renderLayer(L);
    el.style.clipPath = "inset(0 0 100% 0)";
    world(L.frame).append(el);
    t.el = el;
    await tween(clamp(L.h * 1.2, 300, 700), (p) => {
      el.style.clipPath = `inset(0 0 ${(1 - ease(p)) * 100}% 0)`;
      ph.style.opacity = String(1 - p);
    });
    el.style.clipPath = "";
    a.setTool("arrow");
  }

  async function doLine(a, t, tmp) {
    const L = t.layer, C = world(L.frame);
    const horiz = L.dir === "h";
    const x1 = L.x, y1 = L.y, x2 = horiz ? L.x + L.w : L.x, y2 = horiz ? L.y : L.y + L.h;
    a.setTool("pen");
    await a.moveTo(x1, y1, L.frame);
    a.down(); a.up();
    const mkAnchor = (x, y) => { const d = mk("div", "anchor"); d.style.setProperty("--c", a.color); place(d, x, y); C.append(d); tmp.push(d); return d; };
    mkAnchor(x1, y1);
    const el = renderLayer(L);
    C.append(el);
    t.el = el;
    const len = horiz ? L.w : L.h;
    await tween(clamp(len * 0.7, 200, 850), (p) => {
      const e = ease(p);
      if (horiz) el.style.width = L.w * e + "px"; else el.style.height = L.h * e + "px";
      a.x = lerp(x1, x2, e);
      a.y = lerp(y1, y2, e);
    });
    a.down(); a.up();
    mkAnchor(x2, y2);
    await wait(160);
    a.setTool("arrow");
  }

  // types the text inside `el` (already in the DOM) with a blinking caret
  async function typeText(a, L, el, dur) {
    const nodes = textNodes(el);
    const full = nodes.map((n) => n.nodeValue);
    nodes.forEach((n) => { n.nodeValue = ""; });
    const N = full.reduce((s, v) => s + v.length, 0);
    const caret = mk("span", "caret");
    caret.style.setProperty("--c", a.color);
    if (nodes[0]) nodes[0].after(caret); else el.append(caret);
    a.setTool("ibeam");
    let typed = 0, lastKey = -1e9, frameN = 0;
    await tween(dur, (p) => {
      const target = Math.round(p * N);
      if (target === typed) return;
      let rem = target, cur = 0;
      for (let i = 0; i < nodes.length; i++) {
        const take = Math.min(full[i].length, rem);
        if (nodes[i].nodeValue.length !== take) nodes[i].nodeValue = full[i].slice(0, take);
        if (take > 0) cur = i;
        rem -= take;
      }
      if (nodes[cur] && caret.previousSibling !== nodes[cur]) nodes[cur].after(caret);
      if (S.vt - lastKey > 38) {
        lastKey = S.vt;
        const all = full.join("");
        sound.key(a.pan(), /\s/.test(all[target - 1] || ""));
      }
      typed = target;
      if ((frameN++ & 1) === 0) {
        const cr = caret.getBoundingClientRect();
        const q = toFrame(cr.right + 2, cr.top + cr.height * 0.55, L.frame);
        a.x = q.x;
        a.y = q.y;
      }
    });
    nodes.forEach((n, i) => { n.nodeValue = full[i]; });
    caret.remove();
  }

  async function doText(a, t, tmp) {
    const L = t.layer, C = world(L.frame);
    const off = L.guide != null ? 14 : 0;
    a.setTool("cross");
    await a.moveTo(L.x + off, L.y, L.frame);
    a.down();
    const tb = mk("div", "tbox");
    tb.style.setProperty("--c", a.color);
    place(tb, L.x + off, L.y, 0, 0);
    C.append(tb);
    tmp.push(tb);
    const w = Math.max(L.w, 8), h = Math.max(L.h, 8);
    await tween(clamp(160 + Math.sqrt(w * h) * 0.6, 180, 450), (p) => {
      const e = easeOut(p);
      tb.style.width = w * e + "px";
      tb.style.height = h * e + "px";
      a.x = L.x + off + w * e;
      a.y = L.y + Math.min(h, innerHeight * 0.6) * e;
    });
    a.up();
    const el = renderLayer(L, off, 0);
    C.append(el);
    t.el = el;
    const big = L.fs >= 28;
    if (big) el.style.fontSize = "18px";
    const N = el.textContent.length;
    await typeText(a, L, el, clamp(N * 24, 220, 2400));
    if (big) {
      const steps = Math.min(6, Math.max(2, Math.ceil((L.fs - 18) / 8)));
      for (let i = 1; i <= steps; i++) {
        el.style.fontSize = 18 + ((L.fs - 18) * i) / steps + "px";
        sound.tick(i / steps, a.pan());
        await wait(75);
      }
      el.style.fontSize = L.fs + "px";
    }
    if (off) {
      await wait(90);
      sound.snap(a.pan());
      const ax = a.x;
      await tween(150, (p) => {
        const e = easeOut(p);
        el.style.left = L.x + off * (1 - e) + "px";
        tb.style.left = L.x + off * (1 - e) + "px";
        a.x = ax - off * e;
      });
    }
    tb.style.opacity = "0";
    await wait(120);
    a.setTool("arrow");
  }

  function showRulers() { rulers.classList.add("on"); }

  async function doGuide(a, t, tmp) {
    const G = t.guide;
    showRulers();
    const sy0 = clamp(G.y - scrollY, 80, innerHeight - 120);
    await a.moveTo(9, sy0, "fixed");
    a.down();
    const line = mk("div", "guide");
    line.style.left = "9px";
    const lab = mk("div", "mlab");
    fx.append(line, lab);
    tmp.push(line, lab);
    const startX = 9;
    await tween(clamp(Math.abs(G.x - scrollX - startX) * 1.1, 260, 850), (p) => {
      const e = ease(p);
      const x = startX + (G.x - scrollX - startX) * e;
      line.style.left = x + "px";
      a.x = x;
      lab.style.left = x + "px";
      lab.style.top = a.y + 26 + "px";
      lab.textContent = String(Math.round(x + scrollX));
    });
    a.up();
    sound.snap(a.pan());
    placeGuide(G);
    a.setTool("arrow");
  }

  // A dropped guide only covers the text it aligns, then fades away so no long red line stays on the page.
  function placeGuide(G) {
    const g = mk("div", "guide");
    g.style.left = G.x + "px";
    g.style.top = Math.max(0, G.y - 16) + "px";
    g.style.height = clamp(G.y1 - G.y + 32, 40, Math.min(420, innerHeight * 0.5)) + "px";
    docWorld.append(g);
    G.el = g;
    setTimeout(() => { g.style.opacity = "0"; }, 1400);
    setTimeout(() => g.remove(), 2200);
  }

  async function doDup(a, t, tmp) {
    const D = t.sub, M = D.master, C = world(D.frame);
    await a.moveTo(M.x + Math.min(14, M.w / 2), M.y + Math.min(14, M.h / 2), D.frame);
    const sel = mk("div", "sel");
    sel.style.setProperty("--c", a.color);
    sel.append(mk("i"), mk("i"), mk("i"), mk("i"));
    place(sel, M.x, M.y, M.w, M.h);
    C.append(sel);
    tmp.push(sel);
    sound.click(a.pan(), 0.6);
    await wait(140);
    a.setTool("dup");
    a.down();
    const ghost = mk("div", "ghost");
    place(ghost, M.x, M.y, M.w, M.h);
    for (const L of M.layers) ghost.append(renderLayer(L, -M.x, -M.y));
    C.append(ghost);
    tmp.push(ghost);
    const meas = mk("div", "meas"), mlab = mk("div", "mlab");
    C.append(meas, mlab);
    tmp.push(meas, mlab);
    const horiz = D.x >= M.x + M.w - 2;
    const ax = a.x - M.x, ay = a.y - M.y;
    await tween(clamp(Math.hypot(D.x - M.x, D.y - M.y) * 0.9, 260, 900), (p) => {
      const e = ease(p);
      const gx = lerp(M.x, D.x, e), gy = lerp(M.y, D.y, e);
      place(ghost, gx, gy);
      place(sel, gx, gy);
      a.x = gx + ax;
      a.y = gy + ay;
      let gap;
      if (horiz) {
        gap = gx - (M.x + M.w);
        place(meas, M.x + M.w, gy + M.h / 2, Math.max(0, gap), 1);
        place(mlab, M.x + M.w + gap / 2, gy + M.h / 2 - 9);
      } else {
        gap = gy - (M.y + M.h);
        place(meas, gx + M.w / 2, M.y + M.h, 1, Math.max(0, gap));
        place(mlab, gx + M.w / 2 + 18, M.y + M.h + gap / 2);
      }
      const show = gap > 1;
      meas.style.display = mlab.style.display = show ? "" : "none";
      mlab.textContent = String(Math.round(gap));
    });
    a.up();
    meas.remove(); mlab.remove();
    const els = D.layers.map((L) => {
      const el = renderLayer(L);
      const saved = L.kind === "text" ? textNodes(el).map((n) => [n, n.nodeValue]) : [];
      saved.forEach(([n]) => { n.nodeValue = ""; });
      el.style.opacity = "0";
      C.append(el);
      return [L, el, saved];
    });
    t.els = els.map((x) => x[1]);
    await tween(180, (p) => {
      for (const [L, el] of els) el.style.opacity = String(p * (L.style && L.style.opacity ? parseFloat(L.style.opacity) : 1));
      ghost.style.opacity = String(1 - p);
    });
    sel.remove();
    for (const [L, el, saved] of els) {
      el.style.opacity = L.style && L.style.opacity ? L.style.opacity : "";
      saved.forEach(([n, v]) => { n.nodeValue = v; });
    }
    // retype each text in the copy
    for (const [L, el] of els) {
      if (L.kind !== "text") continue;
      await typeText(a, L, el, clamp(el.textContent.length * 11, 120, 800));
    }
    a.setTool("arrow");
  }

  const RUN = { rect: doRect, media: doMedia, line: doLine, text: doText, guide: doGuide, dup: doDup };

  function forceFinish(t) {
    if (t.layer) {
      if (t.el) t.el.remove();
      t.el = renderLayer(t.layer);
      world(t.layer.frame).append(t.el);
    } else if (t.kind === "dup") {
      (t.els || []).forEach((e) => e.remove());
      t.els = t.sub.layers.map((L) => { const e = renderLayer(L); world(L.frame).append(e); return e; });
    } else if (t.kind === "guide" && !t.guide.el) {
      placeGuide(t.guide);
    }
  }

  // ───────────────────────── scheduling ─────────────────────────
  const depsDone = (t) => t.deps.every((d) => d.state === "done");

  function pickTask(a) {
    const atBottom = scrollY + innerHeight >= S.docH - 4;
    const limit = atBottom || OPTS.screens > 0 ? Infinity : scrollY + innerHeight * 1.15;
    const ap = a.screen();
    let best = null, bs = Infinity, scanned = 0;
    for (let i = S.firstOpen; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.state === "done") { if (i === S.firstOpen) S.firstOpen++; continue; }
      if (t.frame === "doc" && t.y > limit) break;
      if (t.state !== "ready" || !depsDone(t)) continue;
      const tx = t.frame === "doc" ? t.x - scrollX : t.x;
      const ty = t.frame === "doc" ? t.y - scrollY : t.y;
      const score = (t.frame === "fixed" ? -5000 : 0) + Math.max(ty, -200) + Math.hypot(tx - ap.x, ty - ap.y) * 0.6 + (ty < -50 ? 800 : 0);
      if (score < bs) { bs = score; best = t; }
      if (++scanned > 400) break;
    }
    return best;
  }

  async function idle(a) {
    a.setTool("arrow");
    await a.moveTo(scrollX + rnd(innerWidth * 0.15, innerWidth * 0.85), scrollY + rnd(innerHeight * 0.2, innerHeight * 0.75), "doc", 0.6);
    await wait(rnd(150, 450));
  }

  async function agentLoop(a) {
    const g = S.gen;
    while (S.alive && g === S.gen && S.phase === "build") {
      const t = pickTask(a);
      if (!t) {
        if (S.done >= tasks.length) break;
        try { await idle(a); } catch (e) { return; }
        continue;
      }
      t.state = "taken";
      const tmp = [];
      try {
        await RUN[t.kind](a, t, tmp);
      } catch (e) {
        if (e === CANCEL || g !== S.gen) return;
        console.warn("[Swarm Rebuild]", e);
        forceFinish(t);
      } finally {
        tmp.forEach((el) => el.remove());
      }
      if (g !== S.gen) return;
      t.state = "done";
      S.done++;
      a.setTool("arrow");
      if (S.done >= tasks.length) finish();
    }
  }

  let lastSpawn = 0;
  function spawnAgent() {
    const side = Math.random() < 0.5;
    const a = new Agent(side ? (Math.random() < 0.5 ? -30 : innerWidth + 30) : rnd(0, innerWidth), side ? rnd(0, innerHeight) : innerHeight + 30, "fixed");
    agents.push(a);
    if (S.phase === "build") agentLoop(a).catch(noop);
    return a;
  }

  function tourStep(dt) {
    if (!S.tour) return;
    const maxY = document.documentElement.scrollHeight - innerHeight;
    if (scrollY >= maxY - 1) return;
    let fy = Infinity;
    for (let i = S.firstOpen; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.state !== "done" && t.frame === "doc") { fy = t.y; break; }
    }
    const target = fy === Infinity ? maxY : fy - innerHeight * 0.3;
    const gap = target - scrollY;
    if (gap <= 2) return;
    S.tourAcc += Math.min(gap * 0.03 + 0.4, 5) * S.speed * (dt / 16);
    if (S.tourAcc >= 1) {
      const step = Math.floor(S.tourAcc);
      S.tourAcc -= step;
      scrollByInstant(0, step);
    }
  }

  // ───────────────────────── intro / finale ─────────────────────────
  // The extension's own icon, drawn as inline SVG so no page CSP can block it.
  function brandIcon(size) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("width", size);
    s.setAttribute("height", size);
    s.setAttribute("viewBox", "0 0 128 128");
    s.style.cssText = "display:block;filter:drop-shadow(0 10px 24px rgba(40,20,80,.35))";
    const el = (tag, attrs, parent = s) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      parent.append(e);
      return e;
    };
    const defs = el("defs", {});
    const grad = el("linearGradient", { id: "swarmBrandGrad", x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    el("stop", { offset: "0", "stop-color": "#1e1e28" }, grad);
    el("stop", { offset: "1", "stop-color": "#3c285a" }, grad);
    el("rect", { x: 4, y: 4, width: 120, height: 120, rx: 28, fill: "url(#swarmBrandGrad)" });
    el("rect", { x: 28, y: 30, width: 64, height: 50, fill: "none", stroke: "#1abcfe", "stroke-width": 5, "stroke-dasharray": "11 6" });
    const ARROW_PTS = "M0 0V15.6L4.3 11.6L7.2 18.1L10 16.9L7.2 10.5H13.2Z";
    for (const [x, y, k, c] of [[20, 82, 2, "#A259FF"], [84, 70, 2, "#0ACF83"], [54, 48, 2.9, "#F24822"]]) {
      el("path", { d: ARROW_PTS, fill: c, stroke: "#fff", "stroke-width": 1.3, "stroke-linejoin": "round", transform: `translate(${x} ${y}) scale(${k})` });
    }
    return s;
  }

  async function intro() {
    S.phase = "intro";
    const g = S.gen;
    const cx = innerWidth / 2, cy = innerHeight / 2 - 20;
    const logo = mk("div", "logo");
    place(logo, cx, cy, 76, 76);
    logo.append(brandIcon(76));
    fx.append(logo);
    requestAnimationFrame(() => logo.classList.add("on"));
    sound.swell();
    const n = BASE_AGENTS;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU + rnd(-0.3, 0.3);
      const R = Math.max(innerWidth, innerHeight) * 0.7;
      agents.push(new Agent(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, "fixed"));
    }
    const R = 74;
    await Promise.all(agents.map((a, i) => a.moveTo(cx + Math.cos((i / n) * TAU) * R, cy + Math.sin((i / n) * TAU) * R, "fixed", 0.75)));
    await tween(1700, (p) => {
      agents.forEach((a, i) => {
        const ang = (i / n) * TAU + ease(p) * TAU * 0.9;
        const r = R + Math.sin(p * TAU + i) * 8;
        a.x = cx + Math.cos(ang) * r;
        a.y = cy + Math.sin(ang) * r;
      });
    });
    if (g !== S.gen) return;
    logo.classList.remove("on");
    setTimeout(() => logo.remove(), 600);
    sound.arp();
    S.phase = "build";
    if (!tasks.length) { finish(); return; }
    agents.forEach((a) => agentLoop(a).catch(noop));
  }

  function finish() {
    if (S.phase !== "build") return;
    S.phase = "done";
    S.tour = false;
    sound.chord();
    rulers.classList.remove("on");
    guides.forEach((G) => { if (G.el) G.el.style.opacity = "0"; });
    agents.forEach((a) => { a.setFrame("fixed"); a.setTool("arrow"); a.vx = rnd(-2, 2); a.vy = rnd(-2, 2); });
    if (OPTS.rating !== false) rating.onFinish();
    if (OPTS.autoLiveAfter > 0) {
      const g = S.gen;
      setTimeout(() => { if (S.alive && S.gen === g && S.phase === "done" && !rating.open) goLive(); }, OPTS.autoLiveAfter);
    }
  }

  function flock(dt) {
    const k = dt / 16;
    const m = S.mouse;
    for (const a of agents) {
      let ax = 0, ay = 0;
      const dx = m.x - a.x, dy = m.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const want = 60 + (a.i % 5) * 14;
      ax += (dx / d) * (d - want) * 0.0035;
      ay += (dy / d) * (d - want) * 0.0035;
      ax += (-dy / d) * 0.05;
      ay += (dx / d) * 0.05;
      let avx = 0, avy = 0, cnt = 0;
      for (const b of agents) {
        if (b === a) continue;
        const ex = a.x - b.x, ey = a.y - b.y;
        const e2 = ex * ex + ey * ey;
        if (e2 > 0 && e2 < 1100) { const e = Math.sqrt(e2); ax += (ex / e) * 0.09; ay += (ey / e) * 0.09; }
        if (e2 < 6400) { avx += b.vx; avy += b.vy; cnt++; }
      }
      if (cnt) { ax += (avx / cnt - a.vx) * 0.02; ay += (avy / cnt - a.vy) * 0.02; }
      a.vx = (a.vx + ax * k) * 0.95;
      a.vy = (a.vy + ay * k) * 0.95;
      const sp = Math.hypot(a.vx, a.vy);
      if (sp > 7) { a.vx *= 7 / sp; a.vy *= 7 / sp; }
      a.x += a.vx * k;
      a.y += a.vy * k;
    }
  }

  // ───────────────────────── rating prompt ─────────────────────────
  const rating = (() => {
    const box = mk("div", "rate");
    const h = mk("h4"); h.textContent = "Enjoying Swarm Rebuild?";
    const p = mk("p"); p.textContent = "Tap a star to rate it. It really helps!";
    const stars = mk("div", "stars");
    const later = mk("button", "later"); later.textContent = "Not now";
    const feedback = mk("button", "later"); feedback.textContent = "Send feedback";
    const actions = mk("div");
    actions.append(later, feedback);
    box.append(h, p, stars, actions);
    feedback.addEventListener("click", (e) => {
      e.stopPropagation();
      try { chrome.runtime.sendMessage({ type: "swarm:feedback" }, () => void chrome.runtime.lastError); } catch (_) {}
      hide();
    });
    const btns = [1, 2, 3, 4, 5].map((n) => {
      const b = mk("button");
      b.textContent = "★";
      b.title = n + (n === 1 ? " star" : " stars");
      b.addEventListener("mouseenter", () => btns.forEach((x, i) => x.classList.toggle("lit", i < n)));
      b.addEventListener("click", (e) => { e.stopPropagation(); rate(n); });
      stars.append(b);
      return b;
    });
    stars.addEventListener("mouseleave", () => btns.forEach((x) => x.classList.remove("lit")));
    later.addEventListener("click", (e) => { e.stopPropagation(); dismiss(); });

    const KEY = "pageSwarmRating";
    const store = (() => { try { return chrome.storage && chrome.storage.local; } catch (_) { return null; } })();
    let data = { runs: 0, rated: false, stars: 0, dismissed: 0, lastAsk: 0 };
    const load = () => new Promise((res) => {
      if (!store) return res();
      try { store.get(KEY, (v) => { if (v && v[KEY]) data = { ...data, ...v[KEY] }; res(); }); } catch (_) { res(); }
    });
    const save = () => { try { store && store.set({ [KEY]: data }); } catch (_) {} };
    const show = () => { box.classList.add("on"); data.lastAsk = data.runs; save(); updateBar(true); };
    const hide = () => { box.classList.remove("on"); updateBar(true); };

    function rate(n) {
      data.rated = true;
      data.stars = n;
      save();
      btns.forEach((x, i) => x.classList.toggle("lit", i < n));
      // Every rating goes to the same place (the store review page), whatever the stars.
      h.textContent = "Thank you! 💛";
      p.textContent = "Opening the Chrome Web Store so you can post your review…";
      stars.style.pointerEvents = "none";
      later.textContent = "Close";
      try { chrome.runtime.sendMessage({ type: "swarm:rate", stars: n }, () => void chrome.runtime.lastError); } catch (_) {}
      setTimeout(hide, 2200);
    }
    function dismiss() {
      if (!data.rated) { data.dismissed++; save(); }
      hide();
    }
    return {
      el: box,
      get open() { return box.classList.contains("on"); },
      get rated() { return data.rated; },
      async onFinish() {
        await load();
        data.runs++;
        save();
        // auto-ask after the 3rd finished rebuild, then every 5 more, at most 3 times
        if (!data.rated && data.dismissed < 3 && data.runs >= 3 && data.runs - data.lastAsk >= (data.lastAsk ? 5 : 3)) {
          setTimeout(() => { if (S.alive && S.phase === "done") show(); }, 1600);
        }
      },
      toggle() { if (box.classList.contains("on")) hide(); else show(); },
      hide,
    };
  })();
  stage.append(rating.el);

  // ───────────────────────── toolbar ─────────────────────────
  const bar = mk("div", "bar");
  function btn(label, fn, cls) {
    const b = mk("button", cls || "");
    b.textContent = label;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); updateBar(true); });
    return b;
  }
  const sep = () => mk("div", "sep");
  const prog = mk("div", "prog");
  const dot = mk("div", "dot");
  const ptxt = mk("span", "ptxt");
  const track = mk("div", "track");
  const fill = mk("div", "fill");
  track.append(fill);
  prog.append(dot, ptxt, track);
  const bTour = btn("Tour", () => { S.tour = !S.tour; S.tourAcc = 0; });
  const bSpeeds = [1, 2, 3].map((v) => btn(v + "×", () => { S.speed = v; savePrefs(); }));
  const bSound = btn("", () => { if (sound.locked) sound.unlock(); else { sound.toggle(); savePrefs(); } });
  bTour.title = "Auto-scroll (T)";
  bSpeeds.forEach((b, i) => { b.title = `Speed ${i + 1}× (${i + 1})`; });
  const bRate = btn("★ Rate", () => rating.toggle(), "star");
  const bLive = btn("Go live", goLive, "cta");
  const bReplay = btn("Replay", replay);
  const bClose = btn("✕", destroy);
  bClose.title = "Exit (Esc)";
  bar.append(prog, sep(), bTour, ...bSpeeds, sep(), bSound, ...(OPTS.rating === false ? [] : [bRate]), bLive, bReplay, sep(), bClose);
  stage.append(bar);

  let barSig = "";
  function updateBar(force) {
    const total = tasks.length || 1;
    const pct = S.phase === "done" ? 100 : Math.floor((S.done / total) * 100);
    const done = S.phase === "done";
    const sig = [S.phase, pct, S.tour, S.speed, sound.locked, sound.on, rating.open].join("|");
    if (!force && sig === barSig) return;
    barSig = sig;
    ptxt.textContent = S.phase === "boot" ? "Clearing…" : S.phase === "intro" ? "Gathering…" : done ? "Rebuilt ✓" : `Building ${pct}%`;
    fill.style.width = pct + "%";
    track.classList.toggle("hide", done);
    bTour.classList.toggle("on", S.tour);
    bTour.classList.toggle("hide", done);
    bSpeeds.forEach((b, i) => b.classList.toggle("on", S.speed === i + 1));
    bSound.textContent = sound.locked ? "Tap for sound" : sound.on ? "🔊" : "🔇";
    bSound.title = "Sound (M)";
    bLive.classList.toggle("hide", !done);
    bReplay.classList.toggle("hide", !done);
    bRate.classList.toggle("hide", !done);
    bRate.classList.toggle("on", rating.open);
  }

  // ───────────────────────── main loop ─────────────────────────
  let last = performance.now();
  let lastScrollY = scrollY;
  let scrollVel = 0;
  function frame(now) {
    if (!S.alive) return;
    const dt = Math.min(64, now - last);
    last = now;
    S.vt += dt * S.speed;
    if (timers.length) {
      const due = [];
      timers = timers.filter((t) => (t.at <= S.vt ? (due.push(t), false) : true));
      due.forEach((t) => (t.g === S.gen ? t.res() : t.rej(CANCEL)));
    }
    if (tweens.length) {
      const fin = [];
      for (const tw of tweens) {
        if (tw.g !== S.gen) { fin.push(tw); continue; }
        const p = clamp((S.vt - tw.t0) / tw.d);
        try { tw.fn(p); } catch (_) {}
        if (p >= 1) fin.push(tw);
      }
      if (fin.length) {
        tweens = tweens.filter((t) => !fin.includes(t));
        fin.forEach((t) => (t.g === S.gen ? t.res() : t.rej(CANCEL)));
      }
    }
    const sy = scrollY;
    const dy = sy - lastScrollY;
    lastScrollY = sy;
    scrollVel = scrollVel * 0.9 + (Math.abs(dy) / Math.max(dt, 1)) * 0.1;
    if (S.phase === "build") {
      if (scrollVel > 1.1 && agents.length < MAX_AGENTS && now - lastSpawn > 220) { spawnAgent(); lastSpawn = now; }
      tourStep(dt);
    }
    docWorld.style.transform = `translate(${-scrollX}px,${-sy}px)`;
    if (S.phase === "done") flock(dt);
    for (const a of agents) a.render();
    updateBar(false);
    requestAnimationFrame(frame);
  }

  // ───────────────────────── lifecycle ─────────────────────────
  function onWheel(e) {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    scrollByInstant(e.deltaX * k, e.deltaY * k);
  }
  function onMove(e) { S.mouse = { x: e.clientX, y: e.clientY }; }
  function onDown() { sound.unlock(); }
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (rating.open) rating.hide(); else destroy();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = e.key.toLowerCase();
    let used = true;
    if (k === "m") { if (sound.locked) sound.unlock(); else sound.toggle(); savePrefs(); }
    else if (k === "1" || k === "2" || k === "3") { S.speed = +k; savePrefs(); }
    else if (k === "t" && S.phase === "build") { S.tour = !S.tour; S.tourAcc = 0; }
    else if (k === "r" && S.phase === "done") replay();
    else if (k === "l" && S.phase === "done") goLive();
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); updateBar(true); }
  }

  // speed + mute are remembered between runs (local only)
  const PREFS_KEY = "pageSwarmPrefs";
  function savePrefs() {
    try { chrome.storage.local.set({ [PREFS_KEY]: { speed: S.speed, muted: !sound.on } }); } catch (_) {}
  }
  function loadPrefs() {
    return new Promise((res) => {
      try {
        chrome.storage.local.get(PREFS_KEY, (v) => {
          const p = v && v[PREFS_KEY];
          if (p) {
            if ([1, 2, 3].includes(p.speed)) S.speed = p.speed;
            if (p.muted && sound.on) sound.toggle();
          }
          res();
        });
      } catch (_) { res(); }
    });
  }

  function destroy() {
    if (!S.alive) return;
    S.alive = false;
    S.gen++;
    cancelAll();
    host.removeEventListener("wheel", onWheel);
    host.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("keydown", onKey, true);
    host.remove();
    setTimeout(() => sound.close(), 900);
    if (window.__pageSwarm === api) window.__pageSwarm = undefined;
  }
  function goLive() {
    if (!S.alive) return;
    sound.sweep();
    S.phase = "leaving";
    stage.style.transition = "opacity .5s ease";
    stage.style.opacity = "0";
    setTimeout(destroy, 520);
  }
  function replay() {
    S.gen++;
    cancelAll();
    rating.hide();
    docWorld.replaceChildren();
    fixedWorld.replaceChildren();
    fx.replaceChildren();
    rulers.classList.remove("on");
    agents.forEach((a) => a.remove());
    agents = [];
    agentSeq = 0;
    tasks.forEach((t) => { t.state = "ready"; t.el = null; t.els = null; });
    guides.forEach((G) => { G.el = null; });
    S.done = 0;
    S.firstOpen = 0;
    intro().catch(noop);
  }

  const api = { destroy };
  window.__pageSwarm = api;

  async function start() {
    const de = document.documentElement, body = document.body;
    const hcs = getComputedStyle(de), bcs = body ? getComputedStyle(body) : null;
    if (alphaOf(hcs.backgroundColor) > 0) {
      S.bg = hcs.backgroundColor;
      S.bodyIsCanvas = !!bcs && (alphaOf(bcs.backgroundColor) === 0 || bcs.backgroundColor === hcs.backgroundColor) && bcs.backgroundImage === "none";
    } else if (bcs && alphaOf(bcs.backgroundColor) > 0) {
      S.bg = bcs.backgroundColor;
      S.bodyIsCanvas = bcs.backgroundImage === "none";
    } else {
      S.bg = /dark/.test(hcs.colorScheme || "") && matchMedia("(prefers-color-scheme: dark)").matches ? "#121212" : "#ffffff";
    }
    bgEl.style.background = S.bg;
    docWorld.style.width = "1px";
    docWorld.style.height = "1px";

    (document.documentElement || document.body).appendChild(host);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("keydown", onKey, true);
    sound.init();
    sound.unlock();
    loadPrefs().then(() => updateBar(true));
    bLive.title = "Back to the real page (L)";
    bReplay.title = "Build it again (R)";
    updateBar(true);
    requestAnimationFrame(frame);
    requestAnimationFrame(() => { stage.style.opacity = "1"; });

    if (SHOT) {
      shotImg = new Image();
      shotImg.src = SHOT;
      try { await shotImg.decode(); } catch (_) { shotImg = null; }
    }
    await sleepReal(650);
    if (!S.alive) return;
    await warmUp();
    if (!S.alive) return;
    const { layers, subs } = snapshot();
    guides = makeGuides(layers);
    tasks = buildTasks(layers, subs, guides);
    docWorld.style.width = S.docW + "px";
    docWorld.style.height = S.docH + "px";
    await intro();
  }

  // a quick hidden scroll pass so lazy images and reveal-on-scroll content exist before the snapshot
  async function warmUp() {
    const x0 = scrollX, y0 = scrollY;
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { try { i.loading = "eager"; } catch (_) {} });
    const H = Math.min(document.documentElement.scrollHeight, MAX_SPAN);
    const step = innerHeight * 0.9;
    if (H > innerHeight * 1.5) {
      for (let y = 0, n = 0; y < H && n < 30; y += step, n++) {
        scrollToInstant(x0, y);
        await sleepReal(35);
        if (!S.alive) return;
      }
      scrollToInstant(x0, y0);
      await sleepReal(140);
    }
    const pending = [...document.images].filter((i) => !i.complete).slice(0, 60);
    if (pending.length) {
      await Promise.race([
        Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }))),
        sleepReal(800),
      ]);
    }
    lastScrollY = scrollY;
  }

  start().catch((e) => {
    if (e !== CANCEL) console.warn("[Swarm Rebuild]", e);
  });
})();
