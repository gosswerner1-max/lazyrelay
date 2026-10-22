import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

// Motion engines for the new home page, ported from the approved staged page. Every engine:
//  - does nothing when the visitor asks for reduced motion (and when matchMedia does not exist),
//  - writes only compositor friendly values (transform, opacity, CSS variables that feed a transform),
//  - starts on mount and removes every listener, observer, timer and frame on unmount,
//  - runs only while its element is on screen where that makes sense (beams, proof, actions).
// Engine state lives in data attributes, never in className, so a React re-render cannot wipe it.

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const WIDE_QUERY = "(min-width: 981px)";

function mq(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/** Missing matchMedia counts as reduced motion: no engine starts in an environment that cannot tell us the preference. */
export function readReducedMotion(): boolean {
  const list = mq(REDUCE_QUERY);
  return list ? list.matches : true;
}

function subscribeReduced(onChange: () => void): () => void {
  const list = mq(REDUCE_QUERY);
  if (!list || typeof list.addEventListener !== "function") return () => {};
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

/** The visitor's reduced-motion setting. Hydrates as false (the markup is the same either way), then follows the setting. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, readReducedMotion, () => false);
}

/** True once the element has been on screen (stays true), or while it is on screen when `once` is false. Always false with reduced motion handled by the caller. */
export function useOnScreen(ref: RefObject<Element | null>, enabled: boolean, once = true): boolean {
  const [seen, setSeen] = useState(false);
  // Without IntersectionObserver there is nothing to wait for, so the element counts as seen.
  const unsupported = typeof IntersectionObserver === "undefined";
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || unsupported) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            setSeen(true);
            if (once) io.disconnect();
          } else if (!once) {
            setSeen(false);
          }
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enabled, once, unsupported]);
  return seen || (enabled && unsupported);
}

type Cleanup = () => void;

function listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, options?: AddEventListenerOptions): Cleanup {
  target.addEventListener(type, fn as EventListener, options);
  return () => target.removeEventListener(type, fn as EventListener, options);
}

// 1. Scroll entrances. Blocks entering in the same moment are staggered 90ms apart (at most 6 steps); they rise and fade in CSS.
function revealEngine(root: HTMLElement, reduce: boolean): Cleanup {
  const items = Array.from(root.querySelectorAll<HTMLElement>(".lv2-rv"));
  const show = (el: HTMLElement) => el.setAttribute("data-in", "");
  if (reduce || typeof IntersectionObserver === "undefined") {
    items.forEach(show);
    return () => {};
  }
  const timers = new Set<number>();
  const io = new IntersectionObserver(
    (entries) => {
      const batch = entries
        .filter((en) => en.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left);
      batch.forEach((en, k) => {
        const el = en.target as HTMLElement;
        el.style.transitionDelay = `${Math.min(k, 6) * 90}ms`;
        show(el);
        const t = window.setTimeout(() => {
          el.style.transitionDelay = "";
          timers.delete(t);
        }, 1500);
        timers.add(t);
        io.unobserve(el);
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
  );
  items.forEach((el) => io.observe(el));
  return () => {
    io.disconnect();
    timers.forEach((t) => window.clearTimeout(t));
  };
}

// 2. Cursor glow, specular sheen and 3D tilt share one pointer reading, so light and lean always agree.
const MAX_TILT = 6; // degrees: the card leans, it does not flip

function pointerEngine(root: HTMLElement, orb: HTMLElement | null, reduce: boolean): Cleanup {
  const fine = mq(FINE_POINTER_QUERY)?.matches ?? false;
  if (reduce || !fine || !orb) return () => {};
  const cleanups: Cleanup[] = [];
  let tx = -999;
  let ty = -999;
  let cx = -999;
  let cy = -999;
  let run = 0;
  const follow = () => {
    cx += (tx - cx) * 0.14;
    cy += (ty - cy) * 0.14;
    orb.style.transform = `translate3d(${cx.toFixed(1)}px,${cy.toFixed(1)}px,0)`;
    run = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.5 ? requestAnimationFrame(follow) : 0;
  };
  cleanups.push(
    listen(window, "pointermove", (e) => {
      tx = e.clientX;
      ty = e.clientY;
      if (cx === -999) {
        cx = tx;
        cy = ty;
      }
      if (!run) run = requestAnimationFrame(follow);
    }, { passive: true }),
  );
  cleanups.push(() => {
    if (run) cancelAnimationFrame(run);
  });

  root.querySelectorAll<HTMLElement>(".lv2-g, .lv2-rp").forEach((tile) => {
    const tiltable = !tile.classList.contains("notilt");
    let raf = 0;
    let px = 0;
    let py = 0;
    let w = 1;
    let h = 1;
    const move = (e: PointerEvent) => {
      const r = tile.getBoundingClientRect();
      w = r.width || 1;
      h = r.height || 1;
      px = e.clientX - r.left;
      py = e.clientY - r.top;
      tile.setAttribute("data-lit", "");
      if (tiltable) tile.setAttribute("data-tilting", "");
      if (!raf) {
        raf = requestAnimationFrame(() => {
          tile.style.setProperty("--gx", `${px.toFixed(0)}px`);
          tile.style.setProperty("--gy", `${py.toFixed(0)}px`);
          if (tiltable) {
            // The card leans toward the cursor: the top edge dips when the cursor is high, the right edge when it is right.
            const nx = (px / w) * 2 - 1;
            const ny = (py / h) * 2 - 1;
            tile.style.setProperty("--rx", `${(-ny * MAX_TILT).toFixed(2)}deg`);
            tile.style.setProperty("--ry", `${(nx * MAX_TILT).toFixed(2)}deg`);
          }
          raf = 0;
        });
      }
    };
    const leave = () => {
      tile.removeAttribute("data-lit");
      tile.removeAttribute("data-tilting");
      tile.style.setProperty("--rx", "0deg");
      tile.style.setProperty("--ry", "0deg");
    };
    tile.addEventListener("pointermove", move);
    tile.addEventListener("pointerleave", leave);
    cleanups.push(() => {
      tile.removeEventListener("pointermove", move);
      tile.removeEventListener("pointerleave", leave);
      if (raf) cancelAnimationFrame(raf);
    });
  });
  return () => cleanups.forEach((c) => c());
}

// 3. Pointer depth: each hero layer drifts a different distance, so the stack reads as floating in 3D.
function depthEngine(root: HTMLElement, reduce: boolean): Cleanup {
  if (reduce || !(mq(WIDE_QUERY)?.matches ?? false)) return () => {};
  const cleanups: Cleanup[] = [];
  root.querySelectorAll<HTMLElement>("[data-depth-root]").forEach((stack) => {
    const layers = Array.from(stack.querySelectorAll<HTMLElement>("[data-depth]"));
    let raf = 0;
    let nx = 0;
    let ny = 0;
    const move = (e: PointerEvent) => {
      const r = stack.getBoundingClientRect();
      nx = ((e.clientX - r.left) / (r.width || 1) - 0.5) * 2;
      ny = ((e.clientY - r.top) / (r.height || 1) - 0.5) * 2;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          layers.forEach((l) => {
            const d = parseFloat(l.getAttribute("data-depth") ?? "0");
            l.style.setProperty("--px", `${(nx * d).toFixed(1)}px`);
            l.style.setProperty("--py", `${(ny * d).toFixed(1)}px`);
          });
          raf = 0;
        });
      }
    };
    const leave = () => {
      layers.forEach((l) => {
        l.style.setProperty("--px", "0px");
        l.style.setProperty("--py", "0px");
      });
    };
    stack.addEventListener("pointermove", move);
    stack.addEventListener("pointerleave", leave);
    cleanups.push(() => {
      stack.removeEventListener("pointermove", move);
      stack.removeEventListener("pointerleave", leave);
      if (raf) cancelAnimationFrame(raf);
    });
  });
  return () => cleanups.forEach((c) => c());
}

// 4. Border beams: each tile gets its own start angle and speed, and only runs while it is on screen.
function beamEngine(root: HTMLElement, reduce: boolean): Cleanup {
  const tiles = Array.from(root.querySelectorAll<HTMLElement>(".lv2-g, .lv2-rp"));
  tiles.forEach((t, i) => {
    t.style.setProperty("--bd", `${(-(i * 1.7) % 9).toFixed(1)}s`);
    t.style.setProperty("--bt", `${7 + (i % 4) * 1.5}s`);
  });
  if (reduce || typeof IntersectionObserver === "undefined") return () => {};
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const el = en.target as HTMLElement;
        if (en.isIntersecting) el.setAttribute("data-on-screen", "");
        else el.removeAttribute("data-on-screen");
      }
    },
    { threshold: 0 },
  );
  tiles.forEach((t) => io.observe(t));
  return () => io.disconnect();
}

// 5. Ticker: pointing at (or focusing) a logo eases both lanes to a stop in about 0.4 s; leaving eases them back.
// Time based easing (time constant 90 ms), so it takes the same time at any frame rate.
function tickerEngine(root: HTMLElement, reduce: boolean): Cleanup {
  if (reduce) return () => {};
  const cleanups: Cleanup[] = [];
  root.querySelectorAll<HTMLElement>(".lv2-tick").forEach((tick) => {
    const anims = Array.from(tick.querySelectorAll<HTMLElement>(".lv2-lane"))
      .map((lane) => (typeof lane.getAnimations === "function" ? lane.getAnimations()[0] : undefined))
      .filter((a): a is Animation => Boolean(a));
    if (!anims.length) return;
    let rate = 1;
    let target = 1;
    let run = 0;
    let lastT = 0;
    const step = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000));
      lastT = now;
      rate += (target - rate) * (1 - Math.exp(-dt / 0.09));
      if (Math.abs(target - rate) < 0.004) rate = target;
      anims.forEach((a) => {
        a.playbackRate = rate || 0.0001;
      });
      run = rate === target ? 0 : requestAnimationFrame(step);
    };
    const go = (t: number) => {
      target = t;
      if (!run) {
        lastT = performance.now();
        run = requestAnimationFrame(step);
      }
    };
    const over = (e: Event) => {
      if ((e.target as Element).closest?.(".lv2-ic")) go(0);
    };
    const out = (e: PointerEvent) => {
      const next = e.relatedTarget as Element | null;
      if (!next?.closest?.(".lv2-ic")) go(1);
    };
    const focusOut = () => go(1);
    tick.addEventListener("pointerover", over);
    tick.addEventListener("pointerout", out);
    tick.addEventListener("focusin", over);
    tick.addEventListener("focusout", focusOut);
    cleanups.push(() => {
      tick.removeEventListener("pointerover", over);
      tick.removeEventListener("pointerout", out);
      tick.removeEventListener("focusin", over);
      tick.removeEventListener("focusout", focusOut);
      if (run) cancelAnimationFrame(run);
    });
  });
  return () => cleanups.forEach((c) => c());
}

// 6. Live canvas: drifting nodes that gather toward the cursor and link up. Palette: orange (#ff5630 family) and deep teal.
const ORANGE = "255,86,48";
const TEAL_DEEP = "13,43,42";
const TEAL_TINT = "64,176,166";
const LINK = 130;
const REACH = 230;
const PULL = 0.095;

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hot: boolean;
  ph: number;
}

function canvasEngine(cv: HTMLCanvasElement | null, reduce: boolean): Cleanup {
  const ctx = cv?.getContext("2d");
  if (!cv || !ctx) return () => {};
  const canvas = cv;
  const g = ctx;
  const fine = mq(FINE_POINTER_QUERY)?.matches ?? false;
  const cleanups: Cleanup[] = [];
  const mouse = { x: -9999, y: -9999, on: false };
  const nodes: Node[] = [];
  let W = 0;
  let H = 0;
  let dpr = 1;
  let last = performance.now();
  let raf = 0;
  const t0 = performance.now();

  const spawn = (): Node => {
    const a = Math.random() * Math.PI * 2;
    const s = 0.12 + Math.random() * 0.22;
    return { x: Math.random() * W, y: Math.random() * H, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 1.5 + Math.random() * 2.1, hot: Math.random() < 0.34, ph: Math.random() * 6.28 };
  };
  const size = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.max(28, Math.min(86, Math.round((W * H) / 17000)));
    while (nodes.length < n) nodes.push(spawn());
    nodes.length = n;
  };
  const bloom = (x: number, y: number, rad: number, rgb: string, a: number) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, `rgba(${rgb},${a})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  };
  const frame = (now: number) => {
    const dt = Math.max(0.2, Math.min(2.5, (now - last) / 16.67 || 1));
    last = now;
    const tt = (now - t0) / 1000;
    const doc = Math.max(1, document.documentElement.scrollHeight - H);
    const p = Math.min(1, Math.max(0, window.scrollY / doc));
    g.clearRect(0, 0, W, H);
    g.globalCompositeOperation = "lighter";
    // Behind-the-glass accents: deep teal and orange fields on slow sine paths, parallaxing at a fraction of scroll speed.
    bloom(W * (0.2 + 0.08 * Math.sin(tt / 9)), H * (0.1 + 0.07 * Math.cos(tt / 11)) - p * 260, Math.max(W, H) * 0.62, TEAL_DEEP, 0.95);
    bloom(W * (0.85 + 0.06 * Math.cos(tt / 13)), H * (0.55 + 0.08 * Math.sin(tt / 8)) - p * 420, Math.max(W, H) * 0.55, TEAL_DEEP, 0.85);
    bloom(W * (0.5 + 0.12 * Math.sin(tt / 15)), H * (0.0 + 0.05 * Math.sin(tt / 7)) - p * 150, Math.max(W, H) * 0.45, ORANGE, 0.13);
    bloom(W * (0.12 + 0.06 * Math.cos(tt / 10)), H * (0.95 + 0.04 * Math.sin(tt / 12)) - p * 520, Math.max(W, H) * 0.4, ORANGE, 0.08);
    g.globalCompositeOperation = "source-over";

    for (const a of nodes) {
      a.vx += Math.cos(tt * 0.4 + a.ph) * 0.0016 * dt;
      a.vy += Math.sin(tt * 0.33 + a.ph * 1.7) * 0.0016 * dt;
      if (mouse.on) {
        const dx = mouse.x - a.x;
        const dy = mouse.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < REACH && d > 1) {
          // Gather: pull in until about 70px from the cursor, push back out inside that, so nodes settle into a halo.
          const f = (d > 70 ? (1 - d / REACH) * PULL : -(1 - d / 70) * PULL * 1.6) * dt;
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
          a.vx *= 0.95;
          a.vy *= 0.95;
        }
      }
      a.vx *= 0.985;
      a.vy *= 0.985;
      const sp = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
      if (sp < 0.09) {
        a.vx *= 1.04;
        a.vy *= 1.04;
      } else if (sp > 1.4) {
        a.vx *= 0.9;
        a.vy *= 0.9;
      }
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      if (a.x < -10) a.x = W + 10;
      else if (a.x > W + 10) a.x = -10;
      if (a.y < -10) a.y = H + 10;
      else if (a.y > H + 10) a.y = -10;
    }
    g.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx > LINK || dx < -LINK || dy > LINK || dy < -LINK) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= LINK) continue;
        let al = (1 - d / LINK) * 0.34;
        if (mouse.on) {
          const mx = (a.x + b.x) / 2 - mouse.x;
          const my = (a.y + b.y) / 2 - mouse.y;
          const md = Math.sqrt(mx * mx + my * my);
          if (md < REACH) al += (1 - md / REACH) * 0.5;
        }
        g.strokeStyle = `rgba(${a.hot && b.hot ? ORANGE : TEAL_TINT},${al.toFixed(3)})`;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
      }
    }
    if (mouse.on) {
      for (const a of nodes) {
        const dx = mouse.x - a.x;
        const dy = mouse.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < REACH) {
          g.strokeStyle = `rgba(${ORANGE},${((1 - d / REACH) * 0.75).toFixed(3)})`;
          g.beginPath();
          g.moveTo(mouse.x, mouse.y);
          g.lineTo(a.x, a.y);
          g.stroke();
        }
      }
    }
    for (const a of nodes) {
      const pulse = 0.7 + 0.3 * Math.sin(tt * 1.3 + a.ph);
      g.fillStyle = `rgba(${a.hot ? ORANGE : TEAL_TINT},${(0.95 * pulse).toFixed(3)})`;
      g.beginPath();
      g.arc(a.x, a.y, a.r, 0, 6.2832);
      g.fill();
    }
    if (mouse.on) {
      // Small reticle at the cursor: the point the field gathers around.
      g.strokeStyle = `rgba(${ORANGE},0.55)`;
      g.beginPath();
      g.arc(mouse.x, mouse.y, 7, 0, 6.2832);
      g.stroke();
      g.fillStyle = `rgba(${ORANGE},0.9)`;
      g.beginPath();
      g.arc(mouse.x, mouse.y, 2, 0, 6.2832);
      g.fill();
    }
    raf = reduce ? 0 : requestAnimationFrame(frame);
  };

  size();
  cleanups.push(
    listen(window, "resize", () => {
      size();
      if (reduce) frame(performance.now());
    }, { passive: true }),
  );
  if (!reduce && fine) {
    cleanups.push(
      listen(window, "pointermove", (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        mouse.on = true;
      }, { passive: true }),
    );
    const onLeave = () => {
      mouse.on = false;
    };
    document.addEventListener("pointerleave", onLeave);
    cleanups.push(() => document.removeEventListener("pointerleave", onLeave));
    cleanups.push(listen(window, "blur", onLeave));
  }
  if (!reduce) {
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  if (reduce) frame(last);
  else raf = requestAnimationFrame(frame);
  return () => {
    if (raf) cancelAnimationFrame(raf);
    cleanups.forEach((c) => c());
  };
}

/** Starts every engine for the page and stops them all on unmount. */
export function useLandingEngines(rootRef: RefObject<HTMLElement | null>, canvasRef: RefObject<HTMLCanvasElement | null>, orbRef: RefObject<HTMLElement | null>): void {
  const reduce = useReducedMotion();
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const stops = [
      revealEngine(root, reduce),
      pointerEngine(root, orbRef.current, reduce),
      depthEngine(root, reduce),
      beamEngine(root, reduce),
      tickerEngine(root, reduce),
      canvasEngine(canvasRef.current, reduce),
    ];
    return () => stops.forEach((stop) => stop());
  }, [rootRef, canvasRef, orbRef, reduce]);
}
