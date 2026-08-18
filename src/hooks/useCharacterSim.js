import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * ─────────────────────────── the living map ───────────────────────────
 *
 * LOOTGRID.dc.html runs a small crowd of hunters over the board: they wander,
 * drop into a dig with dust coming off the hole, sprint at a treasure when one
 * goes live, scatter out of the way when you dig near them, and cheer when
 * somebody wins. It is the single thing that makes the map read as a *place*
 * rather than a spreadsheet, and it was the largest piece of the design that
 * never made it into the build.
 *
 * Two things are load-bearing about how it is implemented:
 *
 *   1. **Transforms are written straight to the DOM.** The sim ticks eleven
 *      times a second; putting seven characters' positions through React state
 *      would re-render the tile grid at 11Hz, and the tile grid is thousands of
 *      nodes. The characters are mounted once and then moved by
 *      `element.style.transform`, which never touches React at all.
 *
 *   2. **Only the viewport is simulated.** The design's board was 12x18 and
 *      fit on roughly two screens, so seven characters were always more or less
 *      in view. Ours is 60x60 — about eighty screens — so a crowd scattered
 *      over the whole board would be invisible essentially always. Characters
 *      are kept inside a box tracking the scroll position, and re-anchored when
 *      the player travels far enough that they would be left behind.
 *
 * The whole thing is decoration and must behave like it: it reads nothing,
 * writes nothing, and blocks nothing. `enabled: false` unmounts it cleanly.
 */

const TICK_MS = 90;

/** How far outside the visible box a character may drift before it is recalled. */
const LEASH = 260;

const CAST = [
  { id: 'c1', mole: true,  color: '#B87A3C', label: null },
  { id: 'c2', mole: false, color: '#CC9944', label: null },
  { id: 'c3', mole: true,  color: '#8A6A4A', label: null },
  { id: 'c4', mole: false, color: '#A88C55', label: null },
  { id: 'c5', mole: true,  color: '#C08A4E', label: null },
];

/** Stable default, so the targets effect does not fire on every render. */
const EMPTY = [];

function rand(a, b) {
  return a + Math.random() * (b - a);
}

/**
 * @param {object}  opts
 * @param {boolean} opts.enabled     false unmounts the crowd entirely
 * @param {object}  opts.scrollRef   the scrolling dig-view container
 * @param {number}  opts.tileSize
 * @param {number}  opts.gap
 * @param {number}  opts.rows
 * @param {number}  opts.cols
 * @param {number}  opts.padL        grid padding, so cell centres line up
 * @param {number}  opts.padT
 * @param {Array}   opts.targets     live hunts, as [{ r, c }] — what a racer runs at
 */
export function useCharacterSim({
  enabled,
  scrollRef,
  tileSize,
  gap,
  rows,
  cols,
  padL = 16,
  padT = 18,
  targets = [],
}) {
  // Both refs are filled from effects, never during render: the simulation is
  // mutable by nature, and assigning to it while rendering is what turns it
  // from "an imperative animation" into "state React thinks it owns".
  const chars = useRef(null);
  const targetsRef = useRef(EMPTY);

  useEffect(() => {
    targetsRef.current = targets;
  }, [targets]);

  const step = tileSize + gap;
  const boardW = padL + cols * step;
  const boardH = padT + rows * step;

  const cx = useCallback(c => padL + c * step + tileSize / 2, [padL, step, tileSize]);
  const cy = useCallback(r => padT + r * step + tileSize / 2, [padT, step, tileSize]);

  // The visible box in board coordinates. Everything below is clamped into it,
  // so the crowd is always where the player is looking.
  const viewBox = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return { x0: 0, y0: 0, x1: boardW, y1: boardH };
    return {
      x0: el.scrollLeft,
      y0: el.scrollTop,
      x1: el.scrollLeft + el.clientWidth,
      y1: el.scrollTop + el.clientHeight,
    };
  }, [scrollRef, boardW, boardH]);

  /**
   * Push everyone away from a cell. Called when the player digs: the crowd
   * getting out of the way is what makes a dig feel like it happened *to* the
   * world rather than to a data structure.
   */
  const scatterFrom = useCallback((r, c) => {
    if (!chars.current) return;
    const px = cx(c), py = cy(r);
    for (const ch of chars.current) {
      if (ch.x == null) continue;
      const dx = ch.x - px, dy = ch.y - py;
      const d = Math.hypot(dx, dy);
      if (d < 165) {
        const n = d || 1;
        ch.mode = 'scatter';
        ch.spd = 7;
        ch.timer = 13;
        ch.tx = ch.x + (dx / n) * 200;
        ch.ty = ch.y + (dy / n) * 200;
      }
    }
  }, [cx, cy]);

  /*
    The design also had a `cheerAll` here, fired when somebody won.

    Not ported, because in this build it could never be seen: our win screen is
    a full-screen overlay, so the map — and the crowd on it — is completely
    covered at exactly the moment they would be celebrating.

    The tick still handles a `cheer` mode and `lg-cheer` is still in the
    stylesheet, but nothing currently enters that mode. Both are left in place
    because the trigger is the only missing piece: if the win ever becomes a
    banner over a live board, this is three lines.
  */

  useEffect(() => {
    if (!enabled) return undefined;

    // Built here rather than during render. Positions are filled in on the
    // first tick, which is also what re-anchors them after a long scroll.
    if (!chars.current) {
      chars.current = CAST.map(c => ({
        ...c,
        x: null, y: null, tx: null, ty: null,
        mode: 'wander', timer: 0, face: 1, spd: 0,
      }));
    }

    const write = ch => {
      const el = document.getElementById(`lgc-${ch.id}`);
      if (!el) return;
      el.style.transform = `translate(${Math.round(ch.x)}px, ${Math.round(ch.y)}px)`;

      const face = el.querySelector('[data-face]');
      const body = el.querySelector('[data-body]');
      const dust = el.querySelector('[data-dust]');
      if (face) face.style.transform = `scaleX(${ch.face || 1})`;
      if (dust) dust.style.opacity = ch.mode === 'dig' ? '1' : '0';
      if (body) {
        let anim;
        if (ch.mode === 'dig') anim = 'lg-dig .5s ease-in-out infinite';
        else if (ch.mode === 'cheer') anim = 'lg-cheer .5s ease-in-out infinite';
        else if (ch.mode === 'scatter') anim = 'lg-bob .3s ease-in-out infinite';
        else anim = 'lg-bob 1.5s ease-in-out infinite';
        // Only touch the style when it actually changes: reassigning an
        // identical animation restarts it, which reads as a stutter.
        if (body.dataset.anim !== anim) {
          body.style.animation = anim;
          body.dataset.anim = anim;
        }
      }
    };

    const moveToward = (ch, spd) => {
      const dx = ch.tx - ch.x, dy = ch.ty - ch.y;
      const d = Math.hypot(dx, dy) || 1;
      const s = Math.min(spd, d);
      ch.x += (dx / d) * s;
      ch.y += (dy / d) * s;
      if (Math.abs(dx) > 0.5) ch.face = dx < 0 ? -1 : 1;
    };

    const distTo = ch => Math.hypot(ch.tx - ch.x, ch.ty - ch.y);

    let raceCount = 0;

    const id = setInterval(() => {
      const box = viewBox();
      const inView = (x, y) =>
        x > box.x0 - LEASH && x < box.x1 + LEASH && y > box.y0 - LEASH && y < box.y1 + LEASH;

      for (const ch of chars.current) {
        // First sight, or recalled after the player travelled: drop the
        // character somewhere sensible inside the current view.
        if (ch.x == null || !inView(ch.x, ch.y)) {
          ch.x = rand(box.x0 + 30, Math.max(box.x0 + 31, box.x1 - 30));
          ch.y = rand(box.y0 + 40, Math.max(box.y0 + 41, box.y1 - 30));
          ch.mode = 'wander';
          ch.tx = null;
          ch.face = 1;
        }

        ch.timer -= 1;

        if (ch.mode === 'wander') {
          if (ch.tx == null || ch.timer <= 0) {
            ch.tx = ch.x + rand(-1, 1) * step * 1.7;
            ch.ty = ch.y + rand(-1, 1) * step * 1.7;
            ch.timer = 16 + Math.floor(Math.random() * 22);
          }
          moveToward(ch, 1.7);
          if (distTo(ch) < 5 && Math.random() < 0.25) {
            ch.mode = 'dig';
            ch.timer = 14 + Math.floor(Math.random() * 16);
          }
        } else if (ch.mode === 'race') {
          moveToward(ch, 4.4);
          if (distTo(ch) < 7) {
            ch.mode = 'dig';
            ch.timer = 18 + Math.floor(Math.random() * 20);
          }
        } else if (ch.mode === 'scatter') {
          moveToward(ch, ch.spd || 6);
          ch.spd = (ch.spd || 6) * 0.88;
          if (ch.timer <= 0) { ch.mode = 'wander'; ch.tx = null; }
        } else if (ch.mode === 'dig' || ch.mode === 'cheer') {
          if (ch.timer <= 0) { ch.mode = 'wander'; ch.tx = null; }
        }

        // Stay on the board even when the view is at its edge.
        ch.x = Math.max(22, Math.min(boardW - 22, ch.x));
        ch.y = Math.max(28, Math.min(boardH - 18, ch.y));
        write(ch);
      }

      // Every few seconds, send an idle hunter at a live hunt that is actually
      // on screen. Someone breaking into a run is the map's way of saying a
      // treasure is live over there without printing a notification.
      raceCount += 1;
      if (raceCount % 30 === 0) {
        const visible = targetsRef.current.filter(t => inView(cx(t.c), cy(t.r)));
        const idle = chars.current.filter(c => c.mode === 'wander');
        if (visible.length && idle.length) {
          const runner = idle[Math.floor(Math.random() * idle.length)];
          const t = visible[Math.floor(Math.random() * visible.length)];
          runner.mode = 'race';
          runner.tx = cx(t.c);
          runner.ty = cy(t.r);
        }
      }
    }, TICK_MS);

    return () => clearInterval(id);
  }, [enabled, viewBox, step, boardW, boardH, cx, cy]);

  const cast = useMemo(() => CAST, []);
  return { cast, scatterFrom };
}
