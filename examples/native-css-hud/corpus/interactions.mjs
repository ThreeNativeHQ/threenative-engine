// The Core HUD interaction corpus. Each scenario = a fixture tree + stylesheet (same shape as
// fixtures.mjs) and a script of input steps and observations. Chromium runs the script to produce the
// expected observation list; the native engine runs the same script and must produce the same list.
//
// Steps:    {t:"key", key:"Tab", shift?}  {t:"pointer", type:"move|down|up|cancel", x, y, pointerType?}
//           {t:"wheel", x, y, dx?, dy}    {t:"advance", ms}   {t:"env", dark?, reducedMotion?}
// Observe:  {obs:"focus"}                 -> data-n of the focused element, or 0
//           {obs:"clicks"}                -> data-n of every clicked listener so far, in order
//           {obs:"scroll", n}             -> [scrollLeft, scrollTop] of element n
//           {obs:"pixel", x, y}           -> [r, g, b] the viewer sees at that point (over #18181b)
// Time is virtual on both sides: `advance` moves the animation clock; nothing waits on a wall clock.

const h = (tag, attrs = {}, ...children) => ({ tag, attrs, children });
const t = (text) => ({ text });
const BASE =
  "html,body{margin:0;padding:0}body{font-family:Noto;font-size:16px;line-height:24px;color:#fff;background:#18181b}";

const btn = (label, attrs = {}) => h("button", { type: "button", class: "b", ...attrs }, t(label));

export const INTERACTIONS = [
  {
    name: "focus-traversal-and-activation",
    size: [360, 220],
    css: `${BASE}
      .b{display:block;width:100px;height:30px;margin:4px;background:#334155;border:0;color:#fff}
      .b:focus-visible{background:#f59e0b}
      .b:disabled{background:#555}
      .t{width:100px;height:30px;margin:4px;background:#475569}
      .t:focus-visible{background:#10b981}`,
    tree: [
      btn("one"),
      btn("two", { disabled: "" }),
      btn("three"),
      h("div", { class: "t", tabindex: "0" }),
      h("div", { class: "t", tabindex: "-1" }),
      btn("four"),
    ],
    listen: [1, 3, 6],
    script: [
      { t: "key", key: "Tab" },
      { obs: "focus" },
      { t: "key", key: "Tab" },
      { obs: "focus" },
      { t: "key", key: "Enter" },
      { t: "key", key: " " },
      { obs: "clicks" },
      { obs: "pixel", x: 95, y: 76 },
      { t: "key", key: "Tab" },
      { obs: "focus" },
      { t: "key", key: "Tab" },
      { obs: "focus" },
      { t: "key", key: "Tab", shift: true },
      { obs: "focus" },
      { t: "key", key: "Tab" },
      { t: "key", key: "Enter" },
      { obs: "clicks" },
      // A click focuses the control it lands on, but a pointer focus is not a `:focus-visible`
      // one, so the button keeps its own colour rather than the amber ring.
      { t: "pointer", type: "down", x: 50, y: 20 },
      { t: "pointer", type: "up", x: 50, y: 20 },
      { obs: "clicks" },
      { obs: "focus" },
      { obs: "pixel", x: 50, y: 20 },
      // Tab off either end of the document takes focus out of it (activeElement becomes the
      // body, which is observed as 0), and the next Tab re-enters at the far end.
      { t: "key", key: "Tab" },
      { obs: "focus" },
      { t: "key", key: "Tab" },
      { t: "key", key: "Tab" },
      { t: "key", key: "Tab" },
      { obs: "focus" },
      { t: "key", key: "Tab" },
      { obs: "focus" },
      { t: "key", key: "Tab", shift: true },
      { obs: "focus" },
      { t: "key", key: "Tab", shift: true },
      { obs: "focus" },
    ],
  },
  {
    name: "nested-scroll",
    size: [320, 240],
    css: `${BASE}
      .outer{width:200px;height:120px;overflow:auto;background:#222;margin:10px}
      .inner{width:160px;height:60px;overflow:auto;background:#334;margin:10px}
      .pad{height:400px;background:linear-gradient(#456,#654)}
      .pad2{height:200px;background:linear-gradient(#654,#456)}`,
    tree: [
      h(
        "div",
        { class: "outer" },
        h("div", { class: "inner" }, h("div", { class: "pad2" })),
        h("div", { class: "pad" }),
      ),
    ],
    script: [
      { t: "wheel", x: 60, y: 40, dy: 50 },
      { obs: "scroll", n: 2 },
      { obs: "scroll", n: 1 },
      { t: "wheel", x: 60, y: 40, dy: 300 },
      { obs: "scroll", n: 2 },
      { obs: "scroll", n: 1 },
      { t: "wheel", x: 60, y: 40, dy: 300 },
      { obs: "scroll", n: 2 },
      { obs: "scroll", n: 1 },
    ],
  },
  {
    name: "clipped-hit-test",
    size: [200, 230],
    css: `${BASE}
      .clip{width:100px;height:50px;overflow:hidden;margin:10px;background:#222}
      .big{width:100px;height:100px;background:#0ea5e9}
      .rc{width:80px;height:80px;margin:70px 10px 10px;border-radius:40px;overflow:hidden;background:#222}
      .rc > div{width:80px;height:80px;background:#f97316}`,
    tree: [
      h("div", { class: "clip" }, h("div", { class: "big" })),
      h("div", { class: "rc" }, h("div")),
    ],
    listen: [2, 4],
    script: [
      { t: "pointer", type: "down", x: 50, y: 100 },
      { t: "pointer", type: "up", x: 50, y: 100 },
      { obs: "clicks" },
      { t: "pointer", type: "down", x: 50, y: 40 },
      { t: "pointer", type: "up", x: 50, y: 40 },
      { obs: "clicks" },
      { t: "pointer", type: "down", x: 12, y: 132 },
      { t: "pointer", type: "up", x: 12, y: 132 },
      { obs: "clicks" },
      { t: "pointer", type: "down", x: 50, y: 170 },
      { t: "pointer", type: "up", x: 50, y: 170 },
      { obs: "clicks" },
    ],
  },
  {
    name: "transitions-timing-and-interruption",
    size: [320, 200],
    css: `${BASE}
      .a{width:100px;height:40px;margin:10px;background:#0000ff;transition:background-color 200ms linear}
      .a:hover{background:#ff0000}
      .d{width:100px;height:40px;margin:10px;background:#0000ff;transition:background-color 200ms linear 100ms}
      .d:hover{background:#ff0000}
      .o{width:100px;height:40px;margin:10px;background:#00ff00;opacity:1;transition:opacity 200ms linear}
      .o:hover{opacity:.2}`,
    tree: [h("div", { class: "a" }), h("div", { class: "d" }), h("div", { class: "o" })],
    script: [
      { t: "pointer", type: "move", x: 50, y: 30 },
      { t: "advance", ms: 100 },
      { obs: "pixel", x: 50, y: 30 },
      { t: "advance", ms: 100 },
      { obs: "pixel", x: 50, y: 30 },
      { t: "pointer", type: "move", x: 250, y: 190 },
      { t: "advance", ms: 50 },
      { obs: "pixel", x: 50, y: 30 },
      { t: "advance", ms: 200 },
      { obs: "pixel", x: 50, y: 30 },
      { t: "pointer", type: "move", x: 50, y: 80 },
      { t: "advance", ms: 90 },
      { obs: "pixel", x: 50, y: 80 },
      { t: "advance", ms: 110 },
      { obs: "pixel", x: 50, y: 80 },
      { t: "pointer", type: "move", x: 50, y: 130 },
      { t: "advance", ms: 100 },
      { obs: "pixel", x: 50, y: 130 },
    ],
  },
  {
    name: "transform-hit-test-and-pointer-events",
    size: [320, 200],
    css: `${BASE}
      .m{position:absolute;left:10px;top:10px;width:80px;height:40px;background:#6366f1;transform:translate(120px,0)}
      .back{position:absolute;left:10px;top:100px;width:100px;height:60px;background:#22c55e}
      .front{position:absolute;left:10px;top:100px;width:100px;height:60px;pointer-events:none;background:#ef444480}`,
    tree: [h("div", { class: "m" }), h("div", { class: "back" }), h("div", { class: "front" })],
    listen: [1, 2],
    script: [
      { t: "pointer", type: "down", x: 20, y: 20 },
      { t: "pointer", type: "up", x: 20, y: 20 },
      { t: "pointer", type: "down", x: 150, y: 30 },
      { t: "pointer", type: "up", x: 150, y: 30 },
      { t: "pointer", type: "down", x: 50, y: 130 },
      { t: "pointer", type: "up", x: 50, y: 130 },
      { obs: "clicks" },
    ],
  },
  {
    name: "touch-hover-and-environment",
    // A touch-only device: (hover: none), so Tailwind's \`@media (hover:hover)\` hover rules must not
    // apply after a tap. Chromium is run with a touch, mobile profile for this scenario.
    touch: true,
    size: [320, 160],
    css: `${BASE}
      .h{width:100px;height:40px;margin:10px;background:#0000ff}
      @media (hover:hover){.h:hover{background:#ff0000}}
      .e{width:100px;height:40px;margin:10px;background:#00ff00}
      @media (prefers-color-scheme: dark){.e{background:#ff00ff}}
      .r{width:100px;height:40px;margin:10px;background:#0000ff;transition:background-color 200ms linear}
      .r:hover{background:#ff0000}
      @media (prefers-reduced-motion: reduce){.r{transition:none}}`,
    tree: [h("div", { class: "h" }), h("div", { class: "e" }), h("div", { class: "r" })],
    script: [
      { t: "pointer", type: "down", x: 50, y: 30, pointerType: "touch" },
      { t: "pointer", type: "up", x: 50, y: 30, pointerType: "touch" },
      { t: "advance", ms: 16 },
      { obs: "pixel", x: 50, y: 30 },
      { obs: "pixel", x: 50, y: 80 },
      { t: "env", dark: true },
      { obs: "pixel", x: 50, y: 80 },
      { t: "env", reducedMotion: true },
      { t: "pointer", type: "move", x: 50, y: 130 },
      { t: "advance", ms: 50 },
      { obs: "pixel", x: 50, y: 130 },
    ],
  },
  {
    name: "group-and-peer-variants",
    size: [320, 160],
    css: `${BASE}
      .col{display:flex;flex-direction:column;gap:10px;padding:10px}
      .grp{box-sizing:border-box;width:140px;height:50px;padding:15px;background:#222}
      .grp > .kid{width:60px;height:20px;background:#0000ff}
      .grp:hover > .kid{background:#ff0000}
      .p{display:block;width:100px;height:30px;border:0;background:#334155}
      .p:focus-visible ~ .q{background:#00ff00}
      .q{width:60px;height:20px;background:#7f1d1d}`,
    tree: [
      h(
        "div",
        { class: "col" },
        h("div", { class: "grp" }, h("div", { class: "kid" })),
        h("button", { type: "button", class: "p" }, t("p")),
        h("div", { class: "q" }),
      ),
    ],
    script: [
      { obs: "pixel", x: 50, y: 35 },
      { t: "pointer", type: "move", x: 100, y: 25 },
      { obs: "pixel", x: 50, y: 35 },
      { t: "pointer", type: "move", x: 300, y: 150 },
      { obs: "pixel", x: 50, y: 35 },
      { obs: "pixel", x: 40, y: 120 },
      { t: "key", key: "Tab" },
      { obs: "pixel", x: 40, y: 120 },
    ],
  },
  {
    name: "transform-transition",
    size: [320, 120],
    css: `${BASE}
      .m{position:absolute;left:10px;top:10px;width:40px;height:40px;background:#6366f1;transition:transform 200ms linear}
      .stage:hover .m{transform:translate(200px,0)}
      .stage{position:absolute;left:0;top:0;width:320px;height:120px}`,
    tree: [h("div", { class: "stage" }, h("div", { class: "m" }))],
    script: [
      { t: "pointer", type: "move", x: 160, y: 100 },
      { t: "advance", ms: 100 },
      { obs: "pixel", x: 110, y: 30 },
      { obs: "pixel", x: 30, y: 30 },
      { t: "advance", ms: 150 },
      { obs: "pixel", x: 230, y: 30 },
      { obs: "pixel", x: 30, y: 30 },
    ],
  },
];
