/* Buzz, the PrintBee support bee: a floating animated bee and a chat sheet for the customer site only.
 *
 * Added to the customer pages and the phone tab shell (never to the admin, warehouse or Bee Runner portals). The widget lives
 * once, in the top document; pages shown inside the tab shell only expose PrintBeeBuzz.open(), which asks the top document.
 * Every piece of text, from the customer or from Buzz, is set with textContent, never as HTML.
 *
 * Look: claymorphism. Three elevations only: the sheet (3), bubbles, cards and the header chip (2), chips and buttons (1). Each is the
 * same four layers: a warm outer shadow, a white top-left highlight, a soft inner shadow and an inner highlight.
 */
(() => {
  'use strict';
  const isTop = window.parent === window;
  if (!isTop) {
    window.PrintBeeBuzz = {open: options => { try { return Boolean(window.top.PrintBeeBuzz && window.top.PrintBeeBuzz.open(options)); } catch { return false; } }};
    return;
  }
  if (window.PrintBeeBuzz) return;

  const CHIPS = [
    {label: 'Check my order', text: 'Where is my order?'},
    {label: 'Pricing', text: 'How much does printing cost?'},
    {label: 'Upload help', text: 'What files can I upload and what are the limits?'},
    {label: 'Payment issue', text: 'I have a payment problem.'},
    {label: 'Talk to a human', human: true},
  ];
  const state = {sessionId: null, orderNumber: null, busy: false, ticketOffered: false};

  const style = document.createElement('style');
  style.textContent = `
  /* ---- tokens: cream #FFF8E8, white, honey #F5C542, deep honey #B9831A, ink #2A2112, muted #7A6A4A ---- */
  .buzz-root { --bz-cream: #FFF8E8; --bz-white: #FFFFFF; --bz-honey: #F5C542; --bz-deep: #B9831A; --bz-link: #7A5208; --bz-ink: #2A2112; --bz-muted: #7A6A4A; --bz-on-honey: #2A2112;
    --bz-sunken: #FBEFCF; --bz-bubble-you: linear-gradient(145deg, #FFE394 0%, #F5C542 58%, #EBB32C 100%); --bz-lift: 0px; --bz-fab: 108px; --bz-pad: 68px;
    --bz-s3: 0 12px 28px rgba(185,131,26,.22), -6px -6px 14px #FFFFFF, inset 0 -4px 8px rgba(185,131,26,.08), inset 3px 3px 6px rgba(255,255,255,.9);
    --bz-s2: 0 7px 16px rgba(185,131,26,.17), -4px -4px 10px rgba(255,255,255,.95), inset 0 -3px 6px rgba(185,131,26,.08), inset 2px 2px 5px rgba(255,255,255,.9);
    --bz-s1: 0 4px 10px rgba(185,131,26,.18), -3px -3px 7px rgba(255,255,255,.95), inset 0 -2px 4px rgba(185,131,26,.10), inset 2px 2px 4px rgba(255,255,255,.9);
    --bz-press: inset 0 3px 8px rgba(185,131,26,.32), inset 0 -2px 4px rgba(255,255,255,.7);
    --bz-sink: inset 3px 3px 7px rgba(185,131,26,.16), inset -3px -3px 7px rgba(255,255,255,.9);
    --bz-ring: 0 0 0 3px rgba(245,197,66,.6);
    font-family: Manrope, system-ui, sans-serif; color: var(--bz-ink); }
  [data-theme="dark"] .buzz-root { --bz-cream: #211A0E; --bz-white: #2E2414; --bz-honey: #F5C542; --bz-deep: #FFCB5C; --bz-link: #FFCB5C; --bz-ink: #FFF3D6; --bz-muted: #D3BE93; --bz-sunken: #19130A;
    --bz-s3: 0 14px 30px rgba(0,0,0,.55), -4px -4px 12px rgba(255,226,150,.04), inset 0 -4px 8px rgba(0,0,0,.28), inset 2px 2px 6px rgba(255,226,150,.07);
    --bz-s2: 0 8px 18px rgba(0,0,0,.45), -3px -3px 9px rgba(255,226,150,.04), inset 0 -3px 6px rgba(0,0,0,.25), inset 2px 2px 5px rgba(255,226,150,.07);
    --bz-s1: 0 5px 11px rgba(0,0,0,.45), -2px -2px 6px rgba(255,226,150,.04), inset 0 -2px 4px rgba(0,0,0,.25), inset 2px 2px 4px rgba(255,226,150,.08);
    --bz-press: inset 0 3px 8px rgba(0,0,0,.5), inset 0 -2px 4px rgba(255,226,150,.05);
    --bz-sink: inset 3px 3px 7px rgba(0,0,0,.45), inset -2px -2px 6px rgba(255,226,150,.04);
    --bz-ring: 0 0 0 3px rgba(245,197,66,.5); }

  /* ---- the launcher: a round clay badge with the bee floating above it and a soft contact shadow on the badge ----
     Layers, bottom to top: glow, badge, shadow, the still bee (shown while the 3D bee loads, or instead of it when 3D is not possible), the 3D bee.
     The still pictures and the 3D bee share one box and one anchor, so swapping between them never jumps. */
  .buzz-fab { position: fixed; z-index: 80; right: max(16px, env(safe-area-inset-right)); bottom: calc(var(--bz-lift) + max(18px, env(safe-area-inset-bottom)));
    width: var(--bz-fab); height: var(--bz-fab); min-width: 56px; min-height: 56px; padding: 0; border: 0; border-radius: 50%; display: block; cursor: pointer; background: transparent; outline: none;
    transition: transform .2s cubic-bezier(.34,1.5,.64,1); -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
  .buzz-fab:hover { transform: translateY(-3px); }
  .buzz-fab:active { transform: scale(.96); transition-duration: .08s; }
  .buzz-fab .buzz-pad, .buzz-fab .buzz-glow { display: none; }      /* no yellow round behind the bee: just the bee and its soft contact shadow */
  .buzz-glow { position: absolute; left: 50%; bottom: -6px; width: 130%; height: 78%; margin-left: -65%; border-radius: 50%; pointer-events: none; opacity: .75; transition: opacity .3s ease;
    background: radial-gradient(ellipse at center, rgba(255,190,50,.30) 0%, rgba(255,196,70,.13) 45%, rgba(255,200,80,0) 72%); }
  [data-theme="dark"] .buzz-glow { background: radial-gradient(ellipse at center, rgba(255,176,40,.24) 0%, rgba(255,176,40,.10) 45%, rgba(255,176,40,0) 72%); }
  .buzz-fab:hover .buzz-glow { opacity: 1; }
  .buzz-pad { position: absolute; left: 50%; bottom: 4px; width: var(--bz-pad); height: var(--bz-pad); margin-left: calc(var(--bz-pad) / -2); border-radius: 50%; pointer-events: none;
    background: radial-gradient(circle at 34% 26%, #FFF3C2 0%, #FFDF86 46%, #F2BD3E 100%);
    box-shadow: 0 9px 16px -4px rgba(185,131,26,.34), 0 3px 6px rgba(185,131,26,.18), -3px -3px 8px rgba(255,255,255,.9), inset 3px 3px 6px rgba(255,255,255,.9), inset -3px -5px 9px rgba(185,131,26,.22);
    transition: box-shadow .2s ease; }
  [data-theme="dark"] .buzz-pad { background: radial-gradient(circle at 34% 26%, #8A6522 0%, #634617 52%, #47330F 100%);
    box-shadow: 0 9px 16px -4px rgba(0,0,0,.6), 0 3px 6px rgba(0,0,0,.35), -2px -2px 6px rgba(255,226,150,.05), inset 2px 2px 5px rgba(255,226,150,.16), inset -3px -5px 9px rgba(0,0,0,.4); }
  .buzz-fab:hover .buzz-pad { box-shadow: 0 13px 20px -4px rgba(185,131,26,.38), 0 4px 8px rgba(185,131,26,.2), -3px -3px 8px rgba(255,255,255,.9), inset 3px 3px 6px rgba(255,255,255,.9), inset -3px -5px 9px rgba(185,131,26,.22); }
  [data-theme="dark"] .buzz-fab:hover .buzz-pad { box-shadow: 0 13px 20px -4px rgba(0,0,0,.65), 0 4px 8px rgba(0,0,0,.4), inset 2px 2px 5px rgba(255,226,150,.2), inset -3px -5px 9px rgba(0,0,0,.4); }
  .buzz-fab:active .buzz-pad { box-shadow: 0 4px 8px -3px rgba(185,131,26,.3), inset 0 3px 8px rgba(185,131,26,.3), inset 0 -2px 4px rgba(255,255,255,.7); }
  .buzz-fab:focus-visible .buzz-pad { box-shadow: 0 0 0 3px var(--bz-white), 0 0 0 6px var(--bz-deep), 0 9px 16px -4px rgba(185,131,26,.34); }
  /* the contact shadow: it squashes and fades a little as the bee floats up (the 3D bee sets --lift every frame, the still bee uses the same 3 second loop) */
  .buzz-shadow { position: absolute; left: 50%; bottom: 9px; width: calc(var(--bz-pad) * .74); height: 13px; margin-left: calc(var(--bz-pad) * -.37); border-radius: 50%; pointer-events: none;
    background: radial-gradient(ellipse at center, rgba(120,80,10,.28) 0%, rgba(120,80,10,.16) 46%, rgba(120,80,10,0) 74%); filter: blur(1.5px);
    transform: scale(calc(1 - var(--lift, 0) * .16), calc(1 - var(--lift, 0) * .2)); opacity: calc(1 - var(--lift, 0) * .3); }
  [data-theme="dark"] .buzz-shadow { background: radial-gradient(ellipse at center, rgba(0,0,0,.5) 0%, rgba(0,0,0,.28) 46%, rgba(0,0,0,0) 74%); }
  .buzz-still { position: absolute; inset: 0; pointer-events: none; transition: opacity .12s ease; }
  .buzz-pose { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; transition: opacity .18s ease; filter: drop-shadow(0 2px 2px rgba(120,80,10,.24)); }
  .buzz-pose.wave { opacity: 0; }
  .buzz-fab:hover .buzz-still .idle, .buzz-fab:focus-visible .buzz-still .idle { opacity: 0; }
  .buzz-fab:hover .buzz-still .wave, .buzz-fab:focus-visible .buzz-still .wave { opacity: 1; }
  .buzz-canvas { position: absolute; top: -40px; left: -14px; width: calc(100% + 28px); height: calc(100% + 52px); display: block; pointer-events: none; opacity: 0; filter: drop-shadow(0 2px 2px rgba(120,80,10,.24)); }
  .buzz-fab[data-state="ready"] .buzz-canvas { opacity: 1; }          /* no fade: a half-see-through bee looks like a smudge */
  .buzz-fab[data-state="ready"] .buzz-still { opacity: 0; }
  .buzz-fab[data-state="ready"] .buzz-shadow { transition: none; }
  .buzz-fab[data-state="fallback"] .buzz-still { animation: buzz-bob 3s ease-in-out infinite; }
  .buzz-fab[data-state="fallback"] .buzz-shadow { animation: buzz-shadow 3s ease-in-out infinite; }
  .buzz-fab[hidden] { display: none; }

  /* ---- tooltip: a white clay bubble centred on the bee's face, one tail, always on screen ---- */
  .buzz-tip { position: fixed; z-index: 79; right: calc(max(16px, env(safe-area-inset-right)) + var(--bz-fab) * .76 + 22px); bottom: calc(var(--bz-lift) + max(18px, env(safe-area-inset-bottom)) + var(--bz-fab) * .59);
    translate: 0 50%; width: max-content; max-width: calc(100vw - max(16px, env(safe-area-inset-right)) - var(--bz-fab) * .76 - 22px - 16px); box-sizing: border-box; padding: 12px 18px; border-radius: 22px; background: var(--bz-white); color: var(--bz-ink);
    font: 700 15px/1.2 Manrope, system-ui, sans-serif; text-align: center; pointer-events: none;
    box-shadow: 0 10px 22px rgba(185,131,26,.22), inset 3px 3px 6px rgba(255,255,255,.95), inset -3px -4px 8px rgba(185,131,26,.10);
    opacity: 0; transform: translateX(10px) scale(.9); transform-origin: right center; transition: opacity .15s ease, transform .22s cubic-bezier(.34,1.56,.64,1); }
  .buzz-tip::after { content: ""; position: absolute; right: -7px; top: 50%; width: 16px; height: 16px; background: var(--bz-white); border-radius: 4px; transform: translateY(-50%) rotate(45deg);
    box-shadow: 4px -4px 8px rgba(185,131,26,.10); }
  [data-theme="dark"] .buzz-tip { box-shadow: 0 10px 22px rgba(0,0,0,.5), inset 2px 2px 5px rgba(255,226,150,.08), inset -3px -4px 8px rgba(0,0,0,.3); }
  [data-theme="dark"] .buzz-tip::after { box-shadow: 4px -4px 8px rgba(0,0,0,.25); }
  .buzz-tip.is-on { opacity: 1; transform: none; }

  /* ---- the sheet: 380px card anchored to the bee on desktop, full screen on phones ---- */
  .buzz-sheet { position: fixed; z-index: 85; right: max(16px, env(safe-area-inset-right)); bottom: calc(var(--bz-lift) + max(16px, env(safe-area-inset-bottom)));
    width: min(380px, calc(100vw - 32px)); height: min(660px, calc(100dvh - var(--bz-lift) - 40px)); display: flex; flex-direction: column; overflow: hidden;
    border-radius: 28px; background: var(--bz-cream); color: var(--bz-ink); box-shadow: var(--bz-s3);
    opacity: 0; transform: translateY(18px) scale(.96); transform-origin: bottom right; transition: opacity .22s ease, transform .22s cubic-bezier(.34,1.45,.64,1); }
  .buzz-sheet.is-open { opacity: 1; transform: none; }
  .buzz-sheet[hidden] { display: none; }
  @media (max-width: 600px) {
    .buzz-root { --bz-fab: 96px; --bz-pad: 64px; }
    .buzz-sheet { left: 0; right: 0; bottom: auto; top: var(--buzz-vt, 0px); width: auto; height: var(--buzz-vh, 100dvh); border-radius: 0; box-shadow: none; transform: translateY(24px); transform-origin: bottom center;
      padding-bottom: env(safe-area-inset-bottom); }
    .buzz-sheet.kb-open { padding-bottom: 0; }
    .buzz-sheet.kb-open .buzz-chips { display: none; }
  }

  .buzz-head { flex: none; display: flex; align-items: center; gap: 12px; padding: calc(12px + env(safe-area-inset-top)) 12px 12px 16px; }
  /* the header badge: the same clay badge as the launcher; the bee on it leans in toward the chat while Buzz is typing (same box, same anchor) */
  .buzz-avatar { position: relative; flex: none; width: 44px; height: 44px; border-radius: 50%; background: radial-gradient(circle at 34% 26%, #FFF3C2 0%, #FFDF86 46%, #F2BD3E 100%); box-shadow: var(--bz-s2); }
  [data-theme="dark"] .buzz-avatar { background: radial-gradient(circle at 34% 26%, #8A6522 0%, #634617 52%, #47330F 100%); }
  .buzz-avatar img { position: absolute; left: -7px; top: -9px; width: 58px; height: 58px; object-fit: contain; display: block; transition: opacity .18s ease; filter: drop-shadow(0 1px 1px rgba(120,80,10,.28)); }
  .buzz-avatar .typing { opacity: 0; }
  .buzz-sheet.is-typing .buzz-avatar .idle { opacity: 0; }
  .buzz-sheet.is-typing .buzz-avatar .typing { opacity: 1; }
  .buzz-headtext { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
  .buzz-head h2 { margin: 0; font-size: 16px; line-height: 1.2; font-weight: 800; letter-spacing: -.005em; }
  .buzz-ai { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font: 800 11px/1.5 Manrope, system-ui, sans-serif; color: var(--bz-ink); background: var(--bz-sunken); box-shadow: var(--bz-sink); }
  .buzz-ai::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--bz-honey); box-shadow: 0 0 0 2px rgba(245,197,66,.28); }
  .buzz-close { flex: none; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; display: grid; place-items: center; font-size: 24px; line-height: 1; color: var(--bz-ink);
    background: var(--bz-white); box-shadow: var(--bz-s1); transition: transform .12s ease, box-shadow .12s ease; }
  .buzz-close:active, .buzz-chip:active, .buzz-btn:active, .buzz-thumb:active { transform: scale(.97); box-shadow: var(--bz-press); }
  .buzz-notice { flex: none; margin: 0 16px; padding: 8px 14px; border-radius: 999px; font: 600 12px/1.35 Manrope, system-ui, sans-serif; text-align: center; color: var(--bz-muted);
    background: var(--bz-sunken); box-shadow: var(--bz-sink); }
  .buzz-context { flex: none; display: flex; align-items: center; gap: 8px; margin: 10px 16px 0; padding: 4px 4px 4px 14px; border-radius: 999px; font-size: 13px; font-weight: 700; background: var(--bz-white); box-shadow: var(--bz-s1); }
  .buzz-context[hidden] { display: none; }
  .buzz-context span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .buzz-context button { flex: none; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; background: var(--bz-sunken); color: inherit; font-size: 18px; line-height: 1; box-shadow: var(--bz-sink); }

  /* ---- the conversation: a thin honey scrollbar whose space is always kept, so nothing jumps ---- */
  .buzz-log { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px 12px 12px 16px; display: flex; flex-direction: column; overscroll-behavior: contain;
    scrollbar-width: thin; scrollbar-color: var(--bz-honey) transparent; scrollbar-gutter: stable; }
  .buzz-log::-webkit-scrollbar { width: 8px; }
  .buzz-log::-webkit-scrollbar-track { background: transparent; margin: 8px 0; }
  .buzz-log::-webkit-scrollbar-thumb { background: var(--bz-honey); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
  .buzz-log::-webkit-scrollbar-thumb:hover { background: var(--bz-deep); background-clip: padding-box; border: 2px solid transparent; }
  .buzz-msg { max-width: 82%; margin-top: 16px; display: flex; flex-direction: column; gap: 6px; }
  .buzz-msg:first-child { margin-top: 0; }
  .buzz-msg.grouped { margin-top: 8px; }
  .buzz-msg p { margin: 0; padding: 11px 15px; border-radius: 20px; font-size: 15px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; cursor: default; }
  .buzz-msg.bee { align-self: flex-start; }
  .buzz-msg.bee p { background: var(--bz-white); color: var(--bz-ink); border-bottom-left-radius: 7px; box-shadow: var(--bz-s2); }
  .buzz-msg.you { align-self: flex-end; align-items: flex-end; }
  .buzz-msg.you p { background: var(--bz-bubble-you); color: var(--bz-on-honey); font-weight: 600; border-bottom-right-radius: 7px; box-shadow: var(--bz-s2); }
  .buzz-msg.problem p { background: color-mix(in srgb, #D64545 14%, var(--bz-white)); }
  .buzz-meta { display: none; padding: 0 6px; font: 600 12px/1.2 Manrope, system-ui, sans-serif; color: var(--bz-muted); }
  .buzz-msg.show-time .buzz-meta { display: block; }
  .buzz-thumbs { display: flex; gap: 8px; padding-left: 4px; }
  .buzz-thumb { width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; display: grid; place-items: center; color: var(--bz-muted); background: var(--bz-white); box-shadow: var(--bz-s1); transition: transform .12s ease, box-shadow .12s ease; }
  .buzz-thumb svg { width: 17px; height: 17px; }
  .buzz-thumb[aria-pressed="true"] { background: var(--bz-bubble-you); color: var(--bz-on-honey); }
  .buzz-card { align-self: stretch; margin-top: 8px; padding: 16px; border-radius: 24px; display: grid; gap: 10px; background: var(--bz-white); box-shadow: var(--bz-s2); }
  .buzz-card h3 { margin: 0; font-size: 15px; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
  .buzz-pill { padding: 3px 11px; border-radius: 999px; font-size: 12px; font-weight: 800; background: var(--bz-bubble-you); color: var(--bz-on-honey); white-space: nowrap; box-shadow: var(--bz-s1); }
  .buzz-pill.urgent { background: #D64545; color: #fff; }
  .buzz-card p { margin: 0; font-size: 14px; line-height: 1.4; color: var(--bz-muted); overflow-wrap: anywhere; }
  .buzz-card .quote { color: var(--bz-ink); padding: 10px 12px; border-radius: 16px; background: var(--bz-sunken); box-shadow: var(--bz-sink); }
  .buzz-card ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 5px; font-size: 13px; color: var(--bz-muted); }
  .buzz-card li::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--bz-honey); }
  .buzz-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .buzz-btn { min-height: 44px; padding: 0 18px; border: 0; border-radius: 999px; cursor: pointer; font: 800 14px Manrope, system-ui, sans-serif; text-decoration: none; display: inline-flex; align-items: center;
    background: var(--bz-white); color: var(--bz-link); box-shadow: var(--bz-s1); transition: transform .12s ease, box-shadow .12s ease; }
  .buzz-btn.primary { background: var(--bz-bubble-you); color: var(--bz-on-honey); }
  .buzz-btn:disabled { opacity: .55; cursor: default; box-shadow: var(--bz-sink); }

  /* ---- typing: wing-flap dots ---- */
  .buzz-typing { align-self: flex-start; margin-top: 16px; display: flex; align-items: center; gap: 9px; padding: 9px 16px 9px 12px; border-radius: 20px; border-bottom-left-radius: 7px; background: var(--bz-white); box-shadow: var(--bz-s2); }
  .buzz-typing svg { width: 30px; height: 21px; flex: none; }
  .buzz-wing { transform-box: fill-box; transform-origin: 50% 100%; animation: buzz-flap .22s ease-in-out infinite alternate; }
  .buzz-wing.b { animation-delay: .11s; }
  .buzz-dots { display: inline-flex; gap: 5px; align-items: center; }
  .buzz-dots i { width: 7px; height: 7px; border-radius: 50%; background: var(--bz-honey); box-shadow: inset 0 -1px 2px rgba(185,131,26,.45); animation: buzz-dot 1s ease-in-out infinite; }
  .buzz-dots i:nth-child(2) { animation-delay: .15s; }
  .buzz-dots i:nth-child(3) { animation-delay: .3s; }
  .buzz-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

  /* ---- quick replies: wrap onto rows, 16px from each edge, never cut off ---- */
  .buzz-chips { flex: none; display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px 6px; }
  .buzz-chip { min-height: 40px; padding: 0 13px; border: 0; border-radius: 999px; cursor: pointer; font: 700 13px Manrope, system-ui, sans-serif; color: var(--bz-link); background: var(--bz-white);
    box-shadow: var(--bz-s1); transition: transform .12s ease, box-shadow .12s ease; }
  .buzz-chip:disabled { opacity: .55; cursor: default; }

  /* ---- the input row: 48px input and a 48px round send button with an even 12px gap ---- */
  .buzz-form { flex: none; display: flex; align-items: center; gap: 12px; padding: 10px 16px 16px; }
  .buzz-input { flex: 1; min-width: 0; height: 48px; padding: 0 18px; border: 0; border-radius: 999px; font: 600 16px Manrope, system-ui, sans-serif; color: var(--bz-ink); background: var(--bz-sunken); box-shadow: var(--bz-sink);
    outline: none; transition: box-shadow .15s ease; }
  .buzz-input::placeholder { color: var(--bz-muted); opacity: 1; }
  .buzz-input:focus-visible, .buzz-input:focus { outline: none; }
  .buzz-input:focus-visible { box-shadow: var(--bz-sink), var(--bz-ring); }
  .buzz-send { flex: none; width: 48px; height: 48px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; display: grid; place-items: center; color: var(--bz-on-honey); background: var(--bz-bubble-you);
    box-shadow: var(--bz-s1); transition: transform .14s cubic-bezier(.34,1.5,.64,1), box-shadow .14s ease, opacity .15s ease; }
  .buzz-send:active:not(:disabled) { transform: scale(.92); box-shadow: var(--bz-press); }
  .buzz-send:disabled { opacity: .5; cursor: default; box-shadow: var(--bz-sink); }
  .buzz-send svg { width: 21px; height: 21px; }

  .buzz-close:focus-visible, .buzz-chip:focus-visible, .buzz-send:focus-visible, .buzz-btn:focus-visible, .buzz-thumb:focus-visible, .buzz-context button:focus-visible { outline: 3px solid var(--bz-deep); outline-offset: 3px; }
  html.buzz-open { overflow: hidden; }
  @keyframes buzz-bob { 0%, 100% { translate: 0 0; } 50% { translate: 0 -3px; } }
  @keyframes buzz-shadow { 0%, 100% { transform: scale(1, 1); opacity: 1; } 50% { transform: scale(.84, .8); opacity: .7; } }
  @keyframes buzz-flap { from { transform: scaleY(.25); } to { transform: scaleY(1); } }
  @keyframes buzz-dot { 0%, 60%, 100% { transform: translateY(0); opacity: .55; } 30% { transform: translateY(-4px); opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .buzz-wing, .buzz-still, .buzz-shadow, .buzz-dots i { animation: none !important; }
    .buzz-sheet, .buzz-canvas, .buzz-still, .buzz-pose, .buzz-fab, .buzz-pad, .buzz-close, .buzz-chip, .buzz-btn, .buzz-thumb, .buzz-send { transition: none; }
    .buzz-tip { transition: opacity .15s ease; transform: none; }            /* no spring and no slide: it just fades in and out */
    .buzz-fab:hover { transform: none; }
    .buzz-sheet { transform: none; }
  }`;
  document.head.append(style);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = (paths, extra = {}) => {
    const node = document.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', ...extra})) node.setAttribute(key, value);
    for (const d of paths) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); node.append(path); }
    return node;
  };
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key in node && key !== 'list') node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  };

  const root = el('div', {className: 'buzz-root'});
  // The still bee pictures (idle, wave, typing): one transparent picture per pose, each made at 108, 216 and 324 px (1x, 2x, 3x), all the same canvas.
  const picture = (kind, className, size) => el('img', {className, alt: '', width: size, height: size, decoding: 'async', src: `/buzz-bee-${kind}-1x.webp?v=6`,
    srcset: `/buzz-bee-${kind}-1x.webp?v=6 1x, /buzz-bee-${kind}-2x.webp?v=6 2x, /buzz-bee-${kind}-3x.webp?v=6 3x`});
  const canvas = el('canvas', {className: 'buzz-canvas', 'aria-hidden': 'true'});
  const fab = el('button', {type: 'button', className: 'buzz-fab', 'aria-label': 'Chat with Buzz, PrintBee support', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    'aria-describedby': 'buzz-tip'},
    el('span', {className: 'buzz-glow', 'aria-hidden': 'true'}), el('span', {className: 'buzz-pad', 'aria-hidden': 'true'}), el('span', {className: 'buzz-shadow', 'aria-hidden': 'true'}),
    el('span', {className: 'buzz-still', 'aria-hidden': 'true'}, picture('idle', 'buzz-pose idle', 108), picture('wave', 'buzz-pose wave', 108)), canvas);
  fab.dataset.state = 'loading';          // loading (the still bee) -> ready (the 3D bee, in exactly the same place) or fallback (the still bee, floating)
  const tip = el('div', {className: 'buzz-tip', id: 'buzz-tip', role: 'tooltip', text: 'Need help? Buzz me!'});
  const title = el('h2', {id: 'buzz-title', text: 'Buzz - PrintBee support'});
  const close = el('button', {type: 'button', className: 'buzz-close', 'aria-label': 'Close chat', text: '×'});
  const notice = el('p', {className: 'buzz-notice', 'aria-label': "AI assistant. Please don't share personal or payment details.", text: "Please don't share personal or payment details."});
  const contextText = el('span');
  const contextClear = el('button', {type: 'button', 'aria-label': 'Stop talking about this order', text: '×'});
  const context = el('div', {className: 'buzz-context', hidden: true}, contextText, contextClear);
  const log = el('div', {className: 'buzz-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Conversation with Buzz'});
  const chips = el('div', {className: 'buzz-chips', role: 'group', 'aria-label': 'Quick questions'});
  const input = el('input', {type: 'text', className: 'buzz-input', maxLength: 800, autocomplete: 'off', enterKeyHint: 'send', placeholder: 'Ask Buzz about PrintBee', 'aria-label': 'Message Buzz'});
  const send = el('button', {type: 'submit', className: 'buzz-send', 'aria-label': 'Send message', disabled: true}, svg(['M4 12l16-8-6 16-3-6z']));
  const form = el('form', {className: 'buzz-form'}, input, send);
  const sheet = el('section', {className: 'buzz-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'buzz-title', hidden: true},
    el('header', {className: 'buzz-head'},
      el('span', {className: 'buzz-avatar', 'aria-hidden': 'true'}, picture('idle', 'idle', 58), picture('typing', 'typing', 58)),
      el('div', {className: 'buzz-headtext'}, title, el('span', {className: 'buzz-ai', text: 'AI assistant'})), close),
    notice, context, log, chips, form);
  root.append(fab, tip, sheet);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let bee = null;                         // the 3D bee controller, once it has loaded

  // ---- keeping the bee clear of the phone dock, the checkout bar and the address Save bar ----
  const AVOID = '.bottom-nav, .checkout-bar, .address-save';
  function bottomBars() {
    const found = [];
    const scan = (doc, dx, dy) => {
      for (const node of doc.querySelectorAll(AVOID)) {
        const box = node.getBoundingClientRect();
        const style = (doc.defaultView || window).getComputedStyle(node);
        if (box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') found.push({top: box.top + dy, bottom: box.bottom + dy, left: box.left + dx});
      }
    };
    scan(document, 0, 0);
    for (const frame of document.querySelectorAll('iframe')) {            // the phone tab shell shows each page inside an iframe
      try {
        const box = frame.getBoundingClientRect();
        if (box.width > 0 && box.height > 0 && frame.contentDocument) scan(frame.contentDocument, box.left, box.top);
      } catch { /* a frame from another site: nothing to look at */ }
    }
    return found;
  }
  function place() {
    let lift = 0;
    for (const bar of bottomBars()) if (bar.top < innerHeight && bar.bottom > innerHeight - 6) lift = Math.max(lift, innerHeight - bar.top);
    root.style.setProperty('--bz-lift', Math.round(lift) + 'px');
  }
  let placing = 0;
  const placeSoon = () => { if (!placing) placing = requestAnimationFrame(() => { placing = 0; place(); }); };

  // ---- messages: grouped by sender (8px inside a group, 16px between groups), time on tap ----
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const clock = () => new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  function bubble(who, text, extra = '') {
    const previous = log.lastElementChild;
    const grouped = previous && previous.classList.contains('buzz-msg') && previous.classList.contains(who) && !previous.classList.contains('problem');
    const words = el('p', {text, title: 'Tap to show the time'});
    const wrap = el('div', {className: `buzz-msg ${who} ${extra} ${grouped ? 'grouped' : ''}`.replace(/\s+/g, ' ').trim()}, words, el('small', {className: 'buzz-meta', text: clock()}));
    words.addEventListener('click', () => wrap.classList.toggle('show-time'));
    log.append(wrap);
    scroll();
    return wrap;
  }
  function thumbs(wrap, messageId) {
    const up = el('button', {type: 'button', className: 'buzz-thumb', 'aria-label': 'This helped', 'aria-pressed': 'false'}, svg(['M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1 6.5a2 2 0 0 1-2 1.7H7']));
    const down = el('button', {type: 'button', className: 'buzz-thumb', 'aria-label': 'This did not help', 'aria-pressed': 'false'}, svg(['M7 13V4H4v9zM7 13l4 8c1.5 0 2.5-1 2.5-2.5V15h5.2a2 2 0 0 0 2-2.3l-1-6.5A2 2 0 0 0 17.7 4.5H7']));
    const rate = async (button, other, rating) => {
      button.setAttribute('aria-pressed', 'true');
      other.setAttribute('aria-pressed', 'false');
      try {
        const result = await call('/api/support/chat/feedback', {sessionId: state.sessionId, messageId, rating});
        if (result.offerTicket) offerTicket();
      } catch { /* the thumb is only a hint; nothing to tell the customer */ }
    };
    up.addEventListener('click', () => rate(up, down, 1));
    down.addEventListener('click', () => rate(down, up, -1));
    wrap.append(el('div', {className: 'buzz-thumbs'}, up, down));
  }
  function offerTicket() {
    if (state.ticketOffered) return;
    state.ticketOffered = true;
    const button = el('button', {type: 'button', className: 'buzz-btn primary', text: 'Create a ticket'});
    button.addEventListener('click', () => { button.disabled = true; humanTicket().finally(() => { state.ticketOffered = false; }); });
    log.append(el('div', {className: 'buzz-msg bee'}, el('p', {text: 'Sorry I have not been much help. I can hand this to a person.'}), el('div', {className: 'buzz-actions'}, button)));
    scroll();
  }
  const when = seconds => new Date(seconds * 1000).toLocaleString(undefined, {day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'});
  function orderCard(order) {
    const card = el('div', {className: 'buzz-card'}, el('h3', {}, el('span', {text: order.order_number}), el('span', {className: 'buzz-pill', text: order.status_label})));
    if (order.eta_minutes) card.append(el('p', {text: `About ${order.eta_minutes} min to your door.`}));
    if (order.timeline && order.timeline.length) card.append(el('ul', {}, ...order.timeline.map(step => el('li', {text: `${step.event} (${when(step.at)})`}))));
    const actions = el('div', {className: 'buzz-actions'}, el('a', {className: 'buzz-btn', href: '/orders/' + encodeURIComponent(order.id), target: '_top', text: 'Track order'}));
    card.append(actions);
    log.append(card);
    scroll();
  }
  function draftCard(draft) {
    const card = el('div', {className: 'buzz-card', 'aria-label': 'Ticket draft'}, el('h3', {}, el('span', {text: 'Ticket draft'}),
      el('span', {className: 'buzz-pill' + (draft.escalation ? ' urgent' : ''), text: draft.escalation ? 'Urgent' : draft.categoryLabel})));
    card.append(el('p', {text: draft.subject}));
    card.append(el('p', {className: 'quote', text: draft.message}));
    if (draft.orderNumber) card.append(el('p', {text: 'Order ' + draft.orderNumber}));
    const confirm = el('button', {type: 'button', className: 'buzz-btn primary', text: 'Confirm and send'});
    const cancel = el('button', {type: 'button', className: 'buzz-btn', text: 'Not now'});
    const actions = el('div', {className: 'buzz-actions'}, confirm, cancel);
    card.append(actions);
    cancel.addEventListener('click', () => { card.remove(); bubble('bee', 'No problem. I did not send anything.'); });
    confirm.addEventListener('click', async () => {
      confirm.disabled = cancel.disabled = true;
      try {
        const result = await call('/api/support/chat', {action: 'confirm', sessionId: state.sessionId, draftId: draft.id}, {'Idempotency-Key': `buzz-${draft.id}-confirm`});
        actions.replaceChildren(el('a', {className: 'buzz-btn primary', href: '/help.html#/ticket/' + result.ticket.id, target: '_top', text: 'Open ' + result.ticket.number}));
        bubble('bee', result.reply);
      } catch (error) {
        confirm.disabled = cancel.disabled = false;
        bubble('bee', error.message, 'problem');
      }
    });
    log.append(card);
    scroll();
  }
  function typing(on) {
    sheet.classList.toggle('is-typing', on);                 // the bee in the header leans in while Buzz is typing
    const existing = log.querySelector('.buzz-typing');
    if (!on) { if (existing) existing.remove(); return; }
    if (existing) return;
    const wings = document.createElementNS(ns, 'svg');
    wings.setAttribute('viewBox', '0 0 32 22');
    wings.setAttribute('aria-hidden', 'true');
    const make = (name, attrs) => { const node = document.createElementNS(ns, name); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };
    wings.append(make('ellipse', {class: 'buzz-wing', cx: 11, cy: 8, rx: 5, ry: 7, fill: '#bfe3ff', opacity: '.9'}), make('ellipse', {class: 'buzz-wing b', cx: 19, cy: 8, rx: 5, ry: 7, fill: '#bfe3ff', opacity: '.9'}),
      make('ellipse', {cx: 15, cy: 15, rx: 9, ry: 5.5, fill: '#f5c542'}), make('path', {d: 'M11 10.5v9M15 10v10M19 10.5v9', stroke: '#2a2112', 'stroke-width': 1.8, 'stroke-linecap': 'round'}));
    log.append(el('div', {className: 'buzz-typing', role: 'status'}, wings, el('span', {className: 'buzz-dots', 'aria-hidden': 'true'}, el('i'), el('i'), el('i')), el('span', {className: 'buzz-sr', text: 'Buzz is typing'})));
    scroll();
  }

  // ---- talking to the server ----
  async function call(path, body, headers = {}) {
    let response;
    try {
      response = await fetch(path, {method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)});
    } catch { throw new Error('I could not reach PrintBee. Check your connection and try again.'); }
    let data = {};
    try { data = await response.json(); } catch { /* not JSON */ }
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }
  const syncSend = () => { send.disabled = state.busy || !input.value.trim(); };
  function busy(on) {
    state.busy = on;
    input.disabled = on;
    for (const chip of chips.children) chip.disabled = on;
    syncSend();
  }
  function show(result) {
    state.sessionId = result.sessionId || state.sessionId;
    const wrap = bubble('bee', result.reply);
    if (result.messageId) thumbs(wrap, result.messageId);
    if (result.orderCard) orderCard(result.orderCard);
    if (result.draft && !result.draft.created) draftCard(result.draft);
    if (result.offerTicket && !result.draft) offerTicket();
  }
  async function run(request, shownText) {
    if (state.busy) return;
    if (shownText) bubble('you', shownText);
    busy(true);
    typing(true);
    try { show(await request()); }
    catch (error) { bubble('bee', error.message, 'problem'); }
    finally { typing(false); busy(false); if (!sheet.hidden) input.focus(); }
  }
  const ask = text => run(() => call('/api/support/chat', {message: text, sessionId: state.sessionId, orderNumber: state.orderNumber}), text);
  const humanTicket = () => run(() => call('/api/support/chat', {action: 'human', sessionId: state.sessionId, orderNumber: state.orderNumber}), 'I would like to talk to a person.');

  // ---- on phones the sheet follows the visible screen, so the input stays above the on-screen keyboard ----
  const phone = matchMedia('(max-width: 600px)');
  function fitViewport() {
    const vv = window.visualViewport;
    if (sheet.hidden || !vv) return;
    if (phone.matches) {
      const keyboard = innerHeight - vv.height > 120;
      sheet.style.setProperty('--buzz-vh', Math.round(vv.height) + 'px');
      sheet.style.setProperty('--buzz-vt', Math.round(vv.offsetTop) + 'px');
      sheet.classList.toggle('kb-open', keyboard);
      if (keyboard) scroll();
    } else {
      sheet.style.removeProperty('--buzz-vh');
      sheet.style.removeProperty('--buzz-vt');
      sheet.classList.remove('kb-open');
    }
  }
  if (window.visualViewport) { visualViewport.addEventListener('resize', fitViewport); visualViewport.addEventListener('scroll', fitViewport); }

  // ---- opening, closing, focus ----
  function setOrder(number) {
    state.orderNumber = number || null;
    context.hidden = !number;
    contextText.textContent = number ? 'About order ' + number : '';
  }
  function focusables() { return [...sheet.querySelectorAll('button, a[href], input')].filter(node => !node.disabled && node.offsetParent !== null); }
  function open(options = {}) {
    if (typeof options.orderNumber === 'string' && /^[A-Za-z0-9-]{3,40}$/.test(options.orderNumber)) setOrder(options.orderNumber.toUpperCase());
    clearTimeout(closeTimer);
    sheet.hidden = false;
    fitViewport();
    void sheet.offsetWidth;                 // so the opening transition starts from the hidden look
    sheet.classList.add('is-open');
    fab.hidden = true;
    hideTip();
    if (bee) bee.show(false);
    fab.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('buzz-open');
    input.focus({preventScroll: true});
    if (options.orderNumber && !log.querySelector('.buzz-asked-' + state.orderNumber)) {
      const marker = el('span', {className: 'buzz-asked-' + state.orderNumber, hidden: true});
      log.append(marker);
      bubble('bee', `Hi! I see you want help with order ${state.orderNumber}. What is going on?`);
    }
    return true;
  }
  let closeTimer = 0;
  function shut() {
    sheet.classList.remove('is-open');      // fades and slides away, then is taken out of the page
    closeTimer = setTimeout(() => { sheet.hidden = true; sheet.classList.remove('kb-open'); }, REDUCED ? 0 : 240);
    fab.hidden = false;
    fab.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('buzz-open');
    fab.focus({preventScroll: true});
    if (bee) { bee.show(true); bee.greet(); }
    placeSoon();
  }

  // ---- the bee: tooltip, hover look, click fly ----
  // The hello bubble pops in once per visit: 3 seconds after the bee is on screen. It goes away after 6 seconds or at the first interaction
  // (a tap, a key press, a scroll), and once it has gone it is not shown again in this session. Hovering the bee, or tabbing to it, still shows it.
  const TIP_KEY = 'buzz-tip-dismissed';
  let tipTimer = 0, introTimer = 0, introActive = false;
  const tipDismissed = () => { try { return sessionStorage.getItem(TIP_KEY) === '1'; } catch { return false; } };
  const dismissTip = () => { try { sessionStorage.setItem(TIP_KEY, '1'); } catch { /* private window: it simply may show again */ } };
  function showTip(ms = 6000) { clearTimeout(tipTimer); if (!fab.hidden && sheet.hidden) { tip.classList.add('is-on'); tipTimer = setTimeout(hideTip, ms); } }
  function hideTip() { clearTimeout(tipTimer); tip.classList.remove('is-on'); if (introActive) { introActive = false; dismissTip(); } }
  let flying = false;
  fab.addEventListener('click', () => {
    if (flying) return;
    if (!bee || REDUCED) { open(); return; }
    flying = true;
    hideTip();
    bee.poke();                              // a quick flying loop, then the chat opens
    setTimeout(() => { flying = false; open(); }, 380);
  });
  fab.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') { showTip(); if (bee) bee.hover(true); } });
  fab.addEventListener('pointerleave', () => { hideTip(); if (bee) bee.hover(false); });
  fab.addEventListener('pointermove', event => {
    if (!bee || event.pointerType !== 'mouse') return;
    const box = fab.getBoundingClientRect();
    bee.look((event.clientX - box.left - box.width / 2) / (box.width / 2), (event.clientY - box.top - box.height / 2) / (box.height / 2));
  });
  fab.addEventListener('focus', () => { if (fab.matches(':focus-visible')) showTip(); });
  fab.addEventListener('blur', hideTip);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && tip.classList.contains('is-on')) hideTip(); });
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {         // the first interaction puts the hello away, or stops it from ever popping up
    addEventListener(type, () => {
      if (introActive) hideTip();
      else if (type !== 'scroll' && introTimer) { clearTimeout(introTimer); introTimer = 0; dismissTip(); }
    }, {passive: true, capture: true});
  }

  // ---- loading the 3D bee only when the page is idle (and not on a slow or data-saving connection) ----
  function loadBee() {
    const link = navigator.connection;
    if (link && (link.saveData || /(^|-)2g$/.test(link.effectiveType || ''))) { fab.dataset.state = 'fallback'; introTip(); return; }
    const giveUp = setTimeout(() => { if (fab.dataset.state === 'loading') { fab.dataset.state = 'fallback'; introTip(); } }, 7000);
    import('/buzz-bee3d.js?v=15')
      .then(module => module.createBee(canvas, {reducedMotion: REDUCED, scale: 0.86, onFrame: lift => fab.style.setProperty('--lift', lift.toFixed(3))}))
      .then(created => {
        clearTimeout(giveUp);
        bee = created;
        fab.dataset.state = 'ready';
        created.show(!fab.hidden);
        introTip();
      })
      .catch(() => { clearTimeout(giveUp); if (fab.dataset.state !== 'ready') { fab.dataset.state = 'fallback'; introTip(); } });   // no WebGL, or the files could not load
  }
  function introTip() {                      // pops in 3 seconds after the bee is on screen, unless it was dismissed earlier in this session
    if (tipDismissed() || introTimer) return;
    introTimer = setTimeout(() => {
      introTimer = 0;
      if (sheet.hidden && !fab.hidden && !tipDismissed()) { introActive = true; showTip(6000); if (bee && !REDUCED) bee.greet(); }
    }, 3000);
  }
  const startLoading = () => (window.requestIdleCallback ? requestIdleCallback(loadBee, {timeout: 3000}) : setTimeout(loadBee, 1200));
  if (document.readyState === 'complete') startLoading(); else addEventListener('load', startLoading, {once: true});
  close.addEventListener('click', shut);
  contextClear.addEventListener('click', () => { setOrder(null); input.focus(); });
  sheet.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); shut(); return; }
    if (event.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  input.addEventListener('input', syncSend);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = '';
    syncSend();
    ask(text);
  });
  for (const chip of CHIPS) {
    const button = el('button', {type: 'button', className: 'buzz-chip', text: chip.label});
    button.addEventListener('click', () => (chip.human ? humanTicket() : ask(chip.text)));
    chips.append(button);
  }

  bubble('bee', 'Hi, I am Buzz, PrintBee’s helper bee. Ask me about prices, uploads or your orders, or tap a quick question below.');

  const mount = () => {
    document.body.append(root);
    place();
    // The phone dock is created by another script after this one, so look again as the page settles and when it resizes.
    for (const event of ['load', 'resize', 'orientationchange', 'pageshow']) addEventListener(event, place);
    addEventListener('resize', fitViewport);
    addEventListener('scroll', placeSoon, {passive: true});                // a sticky bar can slide under the bee as the page scrolls
    setInterval(() => { if (!document.hidden && sheet.hidden) place(); }, 1500);
  };
  window.PrintBeeBuzz = {open};
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
