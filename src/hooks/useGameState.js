import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, ApiError } from '../api/http';
import { fetchHints } from '../api/hints';
import { buyItem, fetchShop, spendRefillCredit } from '../api/shop';
import { enterHunt } from '../api/entry';
import { publishEntry, publishWin } from '../api/records';
import { createSender, socket } from '../api/socket';
import { ONB_CARDS } from '../data/gameData';

/** Display-only: the server is authoritative and corrects us on every response. */
const REGEN_MS = 360000;
/**
 * Mirrors ENERGY.costFog and SURVEY.cost on the server.
 *
 * Used only to refuse an action the server would refuse anyway, so a stale
 * value costs a wasted round trip and never a wrong charge — the server is
 * authoritative and returns the true balance with every response.
 */
const DIG_COST = 2;
const SURVEY_COST = 6;

const INITIAL = {
  view: 'home',
  onbStep: 0,
  mapZone: null,
  /** Hints the player holds. Directions toward a hunt — some of them lie. */
  hints: [],
  /** The empty-bar screen's payload, or null. See fetchStuck. */
  stuck: null,
  /** { catalogue, entitlements, pass } once loaded. */
  shop: null,
  /** True while a purchase is in flight, so the button cannot be double-tapped. */
  buying: false,
  /** Survey readings by cell key. Kept so several can be compared at once. */
  surveys: {},
  /** Tap a tile to survey it rather than dig it. */
  surveyMode: false,
  /** Total XP. Paid by puzzle tiles and by the treasures that carry no cash. */
  xp: 0,
  /**
   * Entries left today, and standing.
   *
   * `/me` has returned both since phase 5 — "the two currencies, side by side
   * on purpose" — and the client stored neither, so the one boundary the whole
   * design rests on (money buys looking, never a chance at a prize) was
   * invisible to the only person it is meant to reassure.
   */
  keys: null,
  rank: null,

  // session
  status: 'connecting', // connecting | online | offline
  fatal: null, // { code, message } — unrecoverable, blocks the app
  player: null,
  energy: { value: 0, max: 40, nextRegenMs: 0 },

  // world (all of it from the server; the client has no map of its own)
  zones: [],
  grid: null, // { cols, rows, epoch, reveals: {}, hunts: [] }

  // hunt flow
  huntPreview: null,
  attempt: null, // { attemptId, gameType, spec, limitMs }
  game: null, // per-game render state
  rivals: [],
  chasers: 0,

  // outcomes
  outcome: null, // pending | won | lost | failed
  failReason: null,
  lostTo: null,
  winData: null,
  shared: false,

  /** True while a 402 is waiting on the player to accept a price. */
  paying: false,

  /** Hunt id whose Director transcript is open, or null. */
  transcriptFor: null,

  showToast: false,
  toastText: '',

  /**
   * Energy-cost numbers floating off the tile that was just tapped, and the
   * set of cells uncovered during this session.
   *
   * Both exist to answer the same question — *did my tap register?* — which
   * the shipped build could not answer for as long as the round-trip took.
   * `digging` holds the cells with a request in flight, so the board can show
   * the dig starting rather than waiting for permission to have started.
   */
  floats: [],
  justOpened: {},
  digging: {},
};

const cellKey = (r, c) => `${r},${c}`;

/**
 * A short buzz, where the device supports one.
 *
 * Guarded rather than assumed: `vibrate` is absent on iOS Safari and can be
 * blocked by a user gesture policy, and a missing haptic must never be the
 * reason an action fails.
 */
function buzz(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* haptics are a nicety; never let one break a dig */
  }
}

/** Fresh render state for whichever game the block handed us. */
function initGame(gameType, spec, huntId) {
  switch (gameType) {
    case 'crack':
      // `huntId` rides along so the panel can filter to hints about THIS hunt.
      // A hint about another treasure says nothing about these six doors.
      return { picked: null, doors: spec.candidates.length, huntId };
    case 'tap':
      return { taps: 0, target: spec.target, remainingMs: spec.limitMs };
    case 'sequence':
      return { next: 1, tapped: [], tiles: spec.tiles, n: spec.n };
    case 'memory':
      return { phase: 'watch', lit: -1, index: 0, sequence: spec.sequence, padCount: spec.padCount };
    case 'math':
      // `maxAnswerMs` is per-question, not per-attempt: the Director may make a
      // round shorter than the last one, and it has to be shown. A clock that
      // silently tightened would be the Director taking a prize away.
      return {
        index: 0,
        count: spec.count,
        question: spec.question,
        picked: null,
        maxAnswerMs: spec.maxAnswerMs,
      };
    default:
      return {};
  }
}

export function useGameState() {
  const [state, setState] = useState(INITIAL);
  const senderRef = useRef(null);
  const memTimers = useRef([]);
  const toastTimer = useRef(null);
  // Event handlers and socket callbacks read the latest state without having to
  // be re-created on every change. Written in an effect rather than during
  // render — mutating a ref mid-render is not safe under concurrent rendering,
  // and every reader here runs after commit anyway.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const set = useCallback(patch => {
    setState(s => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  }, []);

  const toast = useCallback(
    text => {
      set({ showToast: true, toastText: text });
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => set({ showToast: false }), 1600);
    },
    [set],
  );

  /**
   * Throw a `−N ⚡` off a tile, the design's `spendFloat`.
   *
   * Fired on touch, not on response. If the server later refuses the dig the
   * float has already gone; that is the right trade, because the alternative
   * is showing nothing at all for the length of a round-trip and a refused dig
   * is rare next to a slow one.
   */
  const spendFloat = useCallback(
    (r, c, amt) => {
      const id = `fl${Date.now()}${Math.random()}`;
      set(s => ({ floats: [...s.floats, { id, r, c, amt }] }));
      setTimeout(() => set(s => ({ floats: s.floats.filter(f => f.id !== id) })), 750);
    },
    [set],
  );

  const clearMemTimers = useCallback(() => {
    memTimers.current.forEach(clearTimeout);
    memTimers.current = [];
  }, []);

  // ---------------------------------------------------------------- boot

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // The shop rides along at boot rather than being fetched when the shop
        // screen opens. The offer that matters is the one on the empty-bar
        // screen, and that moment must not wait on a round trip — it arrives
        // exactly when the player has just been stopped.
        const [me, zones, shop] = await Promise.all([get('/me'), get('/zones'), fetchShop().catch(() => null)]);
        if (cancelled) return;
        set({
          player: { playerId: me.playerId, handle: me.handle },
          energy: me.energy,
          zones: zones.zones,
          xp: me.xp ?? 0,
          keys: me.keys ?? null,
          rank: me.rank ?? null,
          shop,
        });
        socket.connect();
      } catch (err) {
        if (cancelled) return;
        // No offline fallback, on purpose. Falling back to fake local state is
        // precisely how you end up unable to tell whether the server is working.
        set({
          fatal: {
            code: err instanceof ApiError ? err.code : 'unknown',
            message: 'Cannot reach the LOOTGRID server.',
          },
        });
      }
    })();

    const offStatus = socket.onStatus(status => set({ status }));
    return () => {
      cancelled = true;
      offStatus();
      socket.disconnect();
    };
  }, [set]);

  // ---------------------------------------------------------------- socket events

  useEffect(() => {
    const off = socket.onMessage(msg => {
      switch (msg.t) {
        case 'energy':
          return set({ energy: { value: msg.value, max: msg.max, nextRegenMs: msg.nextRegenMs } });

        // Your own dig, and only ever your own. This used to be broadcast to
        // everyone in the zone, which is how a player who spent nothing learned
        // where treasure was not. The fog is private now — the server sends
        // this to the opener alone.
        case 'tile:revealed':
          return set(s =>
            s.grid
              ? {
                  grid: {
                    ...s.grid,
                    reveals: { ...s.grid.reveals, [cellKey(msg.r, msg.c)]: msg },
                  },
                }
              : null,
          );

        /**
         * The map was torn up and reprinted.
         *
         * Everything on screen now describes an epoch that no longer exists —
         * the fog, the hunts, and the tile types underneath them. Clear it
         * immediately rather than waiting for the refetch, so nobody spends
         * energy tapping a map that is already gone.
         */
        case 'zone:rotated': {
          if (stateRef.current.mapZone !== msg.zoneId) return;
          set(s =>
            s.grid ? { grid: { ...s.grid, epoch: msg.epoch, reveals: {}, hunts: [] } } : null,
          );
          get(`/zones/${msg.zoneId}/grid`)
            .then(grid => {
              const reveals = {};
              for (const cell of grid.reveals) reveals[cellKey(cell.r, cell.c)] = cell;
              set(s => (s.mapZone === msg.zoneId ? { grid: { ...grid, reveals } } : null));
            })
            .catch(() => {});
          return;
        }

        case 'zone:hunts':
          // Merge, never replace. The broadcast is a room message so it can only
          // carry treasures that have gone public — a hunt this player dug up
          // during its head start, and the tutorial's reserved one, are theirs
          // alone and are not in it. Assigning `msg.hunts` wholesale would wipe
          // both off their map.
          return set(s => {
            if (!s.grid) return null;
            const broadcast = new Set(msg.hunts.map(h => h.id));
            const mine = s.grid.hunts.filter(
              h => !broadcast.has(h.id) && (h.ownerId || (h.publicAt ?? 0) > Date.now()),
            );
            return { grid: { ...s.grid, hunts: [...msg.hunts, ...mine] } };
          });

        case 'hunt:closed':
        case 'hunt:expired':
          return set(s =>
            s.grid
              ? { grid: { ...s.grid, hunts: s.grid.hunts.filter(h => h.id !== msg.huntId) } }
              : null,
          );

        case 'hunt:chasers':
          return set({ chasers: msg.count });

        // Real rivals. `startRivals()` used to invent these on a timer, which
        // meant losing a race to a simulation.
        case 'progress':
          return set(s => ({
            rivals: msg.players
              .filter(p => p.h !== s.player?.handle)
              .map(p => ({ handle: p.h, pct: p.pct })),
          }));

        case 'game:update':
          // Math Dash issues question N+1 only once N is answered correctly.
          return set(s =>
            s.game
              ? {
                  game: {
                    ...s.game,
                    index: msg.data.index,
                    question: msg.data.question,
                    picked: null,
                    // Carried through so a directed round's clock is visible.
                    // Falls back to the one already on screen: an older server
                    // that does not send it must not blank the display.
                    maxAnswerMs: msg.data.maxAnswerMs ?? s.game.maxAnswerMs,
                  },
                }
              : null,
          );

        case 'attempt:complete':
          return set({ outcome: 'pending' });

        case 'attempt:failed':
          return set({ outcome: 'failed', failReason: msg.reason, rivals: [] });

        case 'attempt:lost':
          return set({ outcome: 'lost', lostTo: msg.winner });

        case 'hunt:resolved': {
          const s = stateRef.current;
          if (!s.attempt) return;
          if (msg.winner === s.player?.handle) {
            // Publish the win to the chain, paid for by the winner. Deliberately
            // not awaited: the prize screen must render now, and a record that
            // never lands costs nothing but the public log entry.
            void publishWin(s.huntId);

            return set({
              outcome: 'won',
              winData: {
                // Carried so the win screen can claim against it. The prize is
                // held in escrow per hunt, so without the id there is nothing to
                // claim — which is exactly how the payout path came to be
                // unreachable from the UI.
                huntId: s.huntId,
                prize: s.huntPrize || '',
                elapsedMs: msg.elapsedMs,
                beat: Math.max(0, (s.rivals?.length ?? 0)),
                reveal: msg.reveal,
              },
            });
          }
          return set({ outcome: 'lost', lostTo: msg.winner });
        }

        default:
          return undefined;
      }
    });
    return off;
  }, [set]);

  // ---------------------------------------------------------------- local energy tick (display only)

  useEffect(() => {
    const id = setInterval(() => {
      set(s => {
        if (s.energy.value >= s.energy.max) return null;
        const next = s.energy.nextRegenMs - 1000;
        if (next > 0) return { energy: { ...s.energy, nextRegenMs: next } };
        return { energy: { ...s.energy, value: Math.min(s.energy.max, s.energy.value + 1), nextRegenMs: REGEN_MS } };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [set]);

  // ---------------------------------------------------------------- tap countdown (display only)

  useEffect(() => {
    if (state.attempt?.gameType !== 'tap' || state.outcome) return undefined;
    const id = setInterval(() => {
      set(s => (s.game ? { game: { ...s.game, remainingMs: Math.max(0, s.game.remainingMs - 100) } } : null));
    }, 100);
    return () => clearInterval(id);
  }, [state.attempt?.gameType, state.outcome, set]);

  // ---------------------------------------------------------------- memory playback

  useEffect(() => {
    if (state.attempt?.gameType !== 'memory' || state.game?.phase !== 'watch') return undefined;
    clearMemTimers();

    const { sequence } = state.attempt.spec;
    const { stepMs, leadMs, playbackMs } = state.attempt.spec;

    sequence.forEach((pad, i) => {
      memTimers.current.push(setTimeout(() => set(s => ({ game: { ...s.game, lit: pad } })), leadMs + i * stepMs));
      memTimers.current.push(
        setTimeout(() => set(s => ({ game: { ...s.game, lit: -1 } })), leadMs + i * stepMs + stepMs * 0.55),
      );
    });
    memTimers.current.push(
      setTimeout(() => set(s => ({ game: { ...s.game, phase: 'input', lit: -1 } })), playbackMs),
    );

    return clearMemTimers;
  }, [state.attempt, state.game?.phase, set, clearMemTimers]);

  // ---------------------------------------------------------------- navigation

  const setView = useCallback(v => set({ view: v }), [set]);
  const nextOnb = useCallback(
    () => set(s => (s.onbStep >= ONB_CARDS.length - 1 ? { view: 'map' } : { onbStep: s.onbStep + 1 })),
    [set],
  );
  const skipOnb = useCallback(() => set({ view: 'map' }), [set]);
  const setField = useCallback((k, v) => set({ [k]: v }), [set]);

  const enterZone = useCallback(
    async zoneId => {
      try {
        const grid = await get(`/zones/${zoneId}/grid`);
        const reveals = {};
        for (const cell of grid.reveals) reveals[cellKey(cell.r, cell.c)] = cell;
        set({ mapZone: zoneId, grid: { ...grid, reveals } });
        socket.join(`zone:${zoneId}`);
        // Best-effort: an empty hint strip is a worse map, never a broken one.
        fetchHints().then(hints => set({ hints })).catch(() => {});
      } catch {
        toast('COULD NOT LOAD ZONE');
      }
    },
    [set, toast],
  );

  const backZones = useCallback(() => {
    const zoneId = stateRef.current.mapZone;
    if (zoneId) socket.leave(`zone:${zoneId}`);
    set({ mapZone: null, grid: null });
  }, [set]);

  // ---------------------------------------------------------------- tiles

  /**
   * Re-read the first-run script's current step.
   *
   * Best-effort: a tutorial pointer that fails to refresh is a missing hint
   * arrow, never a broken board.
   */
  const refreshTutorial = useCallback(async () => {
    const zoneId = stateRef.current.mapZone;
    if (!zoneId) return;
    try {
      const g = await get(`/zones/${zoneId}/grid`);
      set(s => (s.grid && s.mapZone === zoneId ? { grid: { ...s.grid, tutorial: g.tutorial } } : null));
    } catch {
      /* ignore */
    }
  }, [set]);

  /**
   * What to do when the bar is empty.
   *
   * The highest-intent moment in the session, and it used to be dead air. Asked
   * for when the player actually runs out rather than polled, so it costs
   * nothing until it matters.
   */
  const fetchStuck = useCallback(async () => {
    const zoneId = stateRef.current.mapZone;
    if (!zoneId) return;
    try {
      set({ stuck: await get(`/zones/${zoneId}/stuck`) });
    } catch {
      /* ignore */
    }
  }, [set]);

  const dismissStuck = useCallback(() => set({ stuck: null }), [set]);

  /**
   * "Got it" on a walkthrough step that has no tap.
   *
   * Four of the eight steps teach something with no control attached — what a
   * hint is, what a survey band means, what energy is, what a key is. The
   * server decides whether the current step was one that could be acknowledged,
   * so this cannot skip a step that needs a real dig.
   */
  const ackTutorial = useCallback(async () => {
    const zoneId = stateRef.current.mapZone;
    if (!zoneId) return;
    try {
      const res = await post(`/zones/${zoneId}/tutorial/ack`);
      set(s => (s.grid && s.mapZone === zoneId ? { grid: { ...s.grid, tutorial: res.tutorial } } : null));
    } catch {
      /* a coach mark that will not advance is not worth an error toast */
    }
  }, [set]);

  const loadShop = useCallback(async () => {
    try {
      set({ shop: await fetchShop() });
    } catch {
      toast('SHOP UNAVAILABLE');
    }
  }, [set, toast]);

  /**
   * Buy something.
   *
   * The 402 path is the server's; if payment is switched off the purchase
   * completes directly. Either way the response carries the resulting energy
   * and entitlements, so nothing here has to guess at what the player now has.
   */
  const buy = useCallback(
    async sku => {
      if (stateRef.current.buying) return;
      set({ buying: true });
      try {
        const res = await buyItem(sku);
        set(s => ({
          energy: res.energy ?? s.energy,
          shop: s.shop ? { ...s.shop, entitlements: res.entitlements } : s.shop,
          // A purchase that filled the bar ends the stuck screen — the thing
          // that was blocking them is no longer true.
          stuck: res.energy && res.energy.value > 0 ? null : s.stuck,
        }));
        toast('PURCHASED');
      } catch (err) {
        if (err.status === 402) return toast('PAYMENT REQUIRED');
        if (err.code === 'no_such_item') return toast('NO LONGER SOLD');
        toast('PURCHASE FAILED');
      } finally {
        set({ buying: false });
      }
    },
    [set, toast],
  );

  /** Spend a banked refill. The cheapest way out of an empty bar. */
  const spendRefill = useCallback(async () => {
    try {
      const res = await spendRefillCredit();
      set({ energy: res.energy, stuck: null });
      toast('BAR REFILLED');
    } catch {
      toast('NO REFILLS BANKED');
    }
  }, [set, toast]);

  /**
   * Survey a cell: spend energy to learn how close the nearest treasure is.
   *
   * Uncovers nothing, which is why it is a separate action rather than a mode
   * of digging. Readings accumulate on the grid so several can be compared —
   * one reading is nearly useless and three around the same spot are the game.
   */
  const onSurvey = useCallback(
    async cell => {
      const s = stateRef.current;
      if (!s.mapZone) return;
      if (s.energy.value < SURVEY_COST) return toast(`NEED ${SURVEY_COST} ENERGY TO SURVEY`);

      try {
        const res = await post(`/zones/${s.mapZone}/survey/${cell.r}/${cell.c}`);
        set(prev => ({
          energy: res.energy,
          surveys: { ...prev.surveys, [cellKey(cell.r, cell.c)]: res.reading },
        }));
        toast(String(res.reading.band).toUpperCase());
        // A survey advances the walkthrough now. It used not to be able to:
        // surveys leave nothing on the map, and the server derived its position
        // from reveals, so the Survey step was unreachable. See migration 020.
        if (stateRef.current.grid?.tutorial?.step) void refreshTutorial();
      } catch (err) {
        if (err.code === 'insufficient_energy') {
          if (err.body?.details) set({ energy: err.body.details });
          return toast('OUT OF ENERGY — REGENERATING');
        }
        if (err.code === 'nothing_to_find') return toast('NOTHING LIVE IN THIS ZONE');
        toast('SURVEY FAILED');
      }
    },
    [set, toast, refreshTutorial],
  );

  /** Digging and surveying are different actions on the same tile. */
  const toggleSurveyMode = useCallback(
    () => set(s => ({ surveyMode: !s.surveyMode })),
    [set],
  );

  const onTile = useCallback(
    async cell => {
      const s = stateRef.current;
      if (!s.grid) return;

      // Survey reads the ground from a position, so it works on any cell —
      // already dug, or holding a hunt. Checked before the `opened` guard for
      // exactly that reason.
      if (s.surveyMode) return onSurvey(cell);

      if (cell.opened) return;

      // ─────────────────── tapping a treasure you can already see ──────────
      //
      // This used to open the preview straight from `cell.hunt` without asking
      // the server anything. Two problems with that, and the second is the one
      // that bit:
      //
      //   * the cached hunt can be stale — expired, or already won by somebody
      //     else — so the preview could offer an entry into a hunt that no
      //     longer exists, and the refusal only arrived after the player had
      //     committed to it;
      //   * it produced no server event, so the walkthrough's "both of them
      //     point here, dig it" step could never complete. The tutorial's
      //     treasure is on the player's own map from the start, so it arrives
      //     here as a known hunt rather than as fog, and the tap went nowhere
      //     the server could see. The coach repeated itself forever.
      //
      // Going through the open endpoint fixes both: it is the same call the
      // fog path makes, it costs no energy on a treasure cell, and the server
      // answers with the hunt as it is right now.
      if (cell.hunt && s.energy.value < (cell.hunt.kind === 'cash' ? 3 : 2)) {
        return toast(`NEED ${cell.hunt.kind === 'cash' ? 3 : 2} ENERGY TO HUNT`);
      }

      // A trap costs double, but its type is fog until it is opened — so this
      // checks the cheapest possible price and lets the server refuse the rest.
      if (!cell.hunt && s.energy.value < DIG_COST) return toast('OUT OF ENERGY — REGENERATING');

      /*
        ───────────────────────── the tap answers itself ─────────────────────

        Everything between here and the `await` runs in the same frame as the
        touch. It is the design's `onTile`, which was synchronous and so never
        had to think about this: it set `opened`, threw the cost float and
        decremented the bar on the spot.

        Making the board server-authoritative was right — the client must not
        know what is under a tile — but the feedback went out along with the
        authority, and a dig became a tap followed by up to a second of nothing
        on exactly the connections this game targets.

        So the split is: the client may assert *that* a dig started and *what
        it cost*, because it knows both of those, and stays silent about what
        was found, because it does not know that and must not guess.

        The energy shown is a floor rather than a prediction. DIG_COST is the
        cheapest a dig can be; a trap costs double and corrects upward when the
        server says so — a correction that lands as the penalty arriving, not
        as a number glitching.
      */
      const key = cellKey(cell.r, cell.c);
      const clearDigging = () => set(prev => {
        const digging = { ...prev.digging };
        delete digging[key];
        return { digging };
      });

      if (!cell.hunt) {
        buzz(10);
        spendFloat(cell.r, cell.c, DIG_COST);
        set(prev => ({
          digging: { ...prev.digging, [key]: true },
          energy: { ...prev.energy, value: Math.max(0, prev.energy.value - DIG_COST) },
        }));
      }

      try {
        const res = await post(`/zones/${s.mapZone}/tiles/${cell.r}/${cell.c}/open`);
        clearDigging();

        // ─────────────────────── you dug up a treasure ───────────────────────
        //
        // Treasure locations are no longer served with the map, so a hunt cell
        // arrives here as ordinary fog and the dig is what finds it. The
        // response is a hunt rather than a tile: nothing is revealed, no energy
        // is spent, and the treasure joins this player's map alone until its
        // head start runs out.
        if (res.found) {
          set(prev => {
            if (!prev.grid) return { energy: res.energy };
            const already = prev.grid.hunts.some(h => h.id === res.hunt.id);
            return {
              energy: res.energy,
              grid: already
                ? prev.grid
                : { ...prev.grid, hunts: [...prev.grid.hunts, res.hunt] },
            };
          });
          // Only announce a find when something was actually found. Tapping a
          // treasure already sitting on your map is navigation, not discovery,
          // and "TREASURE FOUND" every time you open the same one is noise.
          if (!cell.hunt) {
            // The best event in the game gets the only long pattern in it.
            if (!res.alreadyFound) buzz([40, 60, 120]);
            toast(res.alreadyFound ? 'ALREADY YOURS' : 'TREASURE FOUND — YOU FOUND IT FIRST');
          }
          // Straight into the preview: the head start is short and it is spent
          // deciding, not navigating back to a tile you just uncovered.
          set({ huntPreview: res.hunt });
          if (stateRef.current.grid?.tutorial?.step) void refreshTutorial();
          return;
        }

        set(prev => {
          if (!prev.grid) return { energy: res.energy };
          const reveals = { ...prev.grid.reveals, [cellKey(cell.r, cell.c)]: res.cell };
          // A mystery tile opens neighbours on the house.
          for (const b of res.bonus ?? []) reveals[cellKey(b.r, b.c)] = b;
          // Tiles uncovered this session animate in. Tracked separately from
          // the reveal itself so a re-render — or a reload that replays the
          // whole map — does not make eighty tiles pop at once.
          const justOpened = { ...prev.justOpened, [key]: true };
          for (const b of res.bonus ?? []) justOpened[cellKey(b.r, b.c)] = true;
          return { energy: res.energy, grid: { ...prev.grid, reveals }, justOpened };
        });

        // A reveal can pay out a hint. Prepend so the newest is first, and
        // guard against a duplicate if the same grant arrives twice.
        if (res.hint) {
          set(prev => ({
            hints: prev.hints.some(h => h.id === res.hint.id)
              ? prev.hints
              : [res.hint, ...prev.hints],
          }));
        }

        // Say what the tile actually did. The whole point of phase 3 is that
        // these labels stopped being decorative — a player who is not told
        // "that cost double" learns nothing from having paid it.
        //
        // The buzz carries the same distinction one beat earlier and without
        // reading: a trap stutters, a reward is a single clean pulse, an empty
        // tile says nothing at all. Silence for the common case is what keeps
        // the other two legible.
        if (res.cell.type === 'trap') {
          buzz([15, 40, 15]);
          // The extra energy a trap costs has already been taken by the server.
          // Show the difference so the penalty is visible where it was paid,
          // rather than only as a bar that moved further than expected.
          const extra = Math.max(0, s.energy.value - DIG_COST - (res.energy?.value ?? 0));
          if (extra > 0) spendFloat(cell.r, cell.c, extra);
          toast('TRAP — DOUBLE COST, AND THE HINT LIES');
        } else if (res.cell.type === 'clue') { buzz(25); toast('CLUE FOUND'); }
        else if (res.bonus?.length) { buzz(25); toast(`MYSTERY — ${res.bonus.length} FREE TILE`); }
        else if (res.xp) { buzz(25); toast(`PUZZLE — +${res.xp.gained} XP`); }
        else if (res.hint) { buzz(25); toast('HINT FOUND'); }

        if (res.xp) set({ xp: res.xp.total });
        if (res.alreadyOpen) toast('ALREADY OPEN');

        // Advance the first-run pointer. Derived server-side from what is
        // actually on the board, so it cannot drift out of step with the map —
        // the cost is one cheap request after a dig, and only while the script
        // is still running.
        if (stateRef.current.grid?.tutorial?.step) void refreshTutorial();
      } catch (err) {
        // The optimistic decrement has to be undone on every failure path, or
        // a flaky connection quietly bills the player for digs that never
        // happened. `res.energy` is authoritative on success; here there is no
        // response, so fall back to what the error carried and otherwise put
        // back exactly what was taken.
        clearDigging();
        if (!cell.hunt) {
          set(prev =>
            err.body?.details
              ? { energy: err.body.details }
              : { energy: { ...prev.energy, value: Math.min(prev.energy.max, prev.energy.value + DIG_COST) } },
          );
        }
        if (err.code === 'insufficient_energy') {
          void fetchStuck();
          return;
        }
        toast('COULD NOT OPEN TILE');
      }
    },
    [set, toast, onSurvey, fetchStuck, refreshTutorial, spendFloat],
  );

  /**
   * Resolves the promise `enterHunt` is waiting on while a price is shown.
   * Held in a ref because the answer arrives from a click, long after the
   * request that asked for it.
   */
  const quoteResolver = useRef(null);

  const settleQuote = useCallback(accepted => {
    const resolve = quoteResolver.current;
    quoteResolver.current = null;
    resolve?.(accepted);
  }, []);

  const acceptQuote = useCallback(() => settleQuote(true), [settleQuote]);

  const closeHunt = useCallback(() => {
    // Closing mid-quote is a decline, not a dangling promise.
    settleQuote(false);
    set({ huntPreview: null, paying: false });
  }, [set, settleQuote]);

  // ---------------------------------------------------------------- hunts

  const confirmHunt = useCallback(async () => {
    const hunt = stateRef.current.huntPreview;
    if (!hunt) return;

    try {
      // Pays only if the server asks, and only after the player has seen the
      // price. Energy is tried first server-side, so most entries never reach
      // the payment branch at all.
      const res = await enterHunt(hunt.id, {
        // The 402 arrives mid-flight, so the price is shown and the entry waits
        // on a promise the player resolves. Nobody should be charged by a screen
        // they have not read.
        onQuote: terms =>
          new Promise(resolve => {
            quoteResolver.current = resolve;
            set({ huntPreview: { ...hunt, quote: terms }, paying: true });
          }),
      });
      if (!res) return set({ huntPreview: null, paying: false });
      senderRef.current?.dispose();
      senderRef.current = createSender(res.attemptId);
      socket.join(`hunt:${hunt.id}`);

      // Same rule as the win: fire it off and start the game. The referee has
      // already accepted the entry; this only makes it public.
      void publishEntry(hunt.id);

      set({
        huntPreview: null,
        paying: false,
        energy: res.energy,
        huntId: hunt.id,
        huntPrize: hunt.prizeLabel,
        attempt: { attemptId: res.attemptId, gameType: res.gameType, spec: res.spec, limitMs: res.limitMs },
        game: initGame(res.gameType, res.spec, hunt.id),
        rivals: [],
        outcome: null,
        failReason: null,
        lostTo: null,
        winData: null,
        shared: false,
      });

      // Entering is the walkthrough's last step. Refreshed here so the coach
      // clears the moment the doors go up — the race is explained on the step
      // BEFORE this one, deliberately, because a card that needs reading while
      // a fifteen-second clock runs is a card that costs the player the hunt.
      if (stateRef.current.grid?.tutorial?.step) void refreshTutorial();
    } catch (err) {
      set({ huntPreview: null, paying: false });
      if (err.code === 'no_wallet') return toast('NO WALLET TO PAY WITH');
      if (err.code === 'signature_refused') return toast('PAYMENT CANCELLED');
      if (err.status === 402) return toast('PAYMENT WAS REFUSED');
      if (err.code === 'insufficient_energy') return toast('NOT ENOUGH ENERGY');
      if (err.code === 'already_attempted') return toast('YOU ALREADY TRIED THIS ONE');
      if (err.code === 'hunt_not_live') return toast('ALREADY CRACKED');

      // The money gate. Each refusal says what it is and what would fix it — a
      // player turned away with no reason assumes the game is rigged, and this
      // is the one moment where that assumption is most expensive.
      //
      // `shadow_banned` is deliberately absent: it arrives as `hunt_not_live`
      // above and must stay indistinguishable from a closed hunt.
      if (err.code === 'wallet_too_new') return toast('ACCOUNT TOO NEW FOR CASH HUNTS');
      if (err.code === 'rank_too_low') {
        const short = err.body?.details?.shortfall;
        if (short?.activeDays > 0) return toast(`PROSPECT ${short.activeDays} MORE DAY(S) FIRST`);
        if (short?.resolved > 0) return toast(`NEED ${short.resolved} MORE RESOLVED HINTS`);
        return toast('RANK TOO LOW FOR CASH HUNTS');
      }
      if (err.code === 'no_keys_left') return toast('NO KEYS LEFT TODAY — XP HUNTS ARE OPEN');
      if (err.code === 'not_your_hunt') return toast('THAT ONE IS SOMEBODY ELSE\u2019S');
      toast('COULD NOT ENTER HUNT');
    }
  }, [set, toast, refreshTutorial]);

  const exitMinigame = useCallback(() => {
    const s = stateRef.current;
    if (s.huntId) socket.leave(`hunt:${s.huntId}`);
    senderRef.current?.dispose();
    senderRef.current = null;
    clearMemTimers();
    set({
      attempt: null,
      game: null,
      rivals: [],
      chasers: 0,
      outcome: null,
      failReason: null,
      lostTo: null,
      huntId: null,
    });
  }, [set, clearMemTimers]);

  const backToMap = useCallback(() => {
    exitMinigame();
    set({ view: 'map', winData: null, shared: false });
  }, [exitMinigame, set]);

  // ---------------------------------------------------------------- game inputs
  // Local state moves optimistically so the UI feels instant; the server decides
  // pass and fail, and its verdict arrives over the socket.

  const onMgTap = useCallback(() => {
    const s = stateRef.current;
    if (!s.game || s.outcome) return;
    const taps = s.game.taps + 1;
    senderRef.current?.add('tap', undefined, taps >= s.game.target);
    set({ game: { ...s.game, taps } });
  }, [set]);

  /**
   * Commit a door.
   *
   * Optimistic like every other input, but final in a way the others are not:
   * one lock per attempt, and the server refuses a second. The pick is sent as
   * the cell rather than the index so the server validates against its own copy
   * of the doors rather than trusting a number the client chose.
   */
  const onCrackLock = useCallback(
    door => {
      const s = stateRef.current;
      if (!s.game || s.outcome || s.game.picked !== null) return;
      const cell = s.attempt?.spec?.candidates?.[door];
      if (!cell) return;
      senderRef.current?.add('lock', cell, true);
      set({ game: { ...s.game, picked: door } });
    },
    [set],
  );

  const onSeqTap = useCallback(
    tile => {
      const s = stateRef.current;
      if (!s.game || s.outcome || s.game.tapped.includes(tile.id)) return;
      senderRef.current?.add('tap', tile.id, tile.id === s.game.n);
      set({
        game:
          tile.id === s.game.next
            ? { ...s.game, next: s.game.next + 1, tapped: [...s.game.tapped, tile.id] }
            : s.game,
      });
    },
    [set],
  );

  const onMemPad = useCallback(
    pad => {
      const s = stateRef.current;
      if (!s.game || s.outcome || s.game.phase !== 'input') return;
      const index = s.game.index + 1;
      senderRef.current?.add('pad', pad, index >= s.game.sequence.length);
      set({ game: { ...s.game, index, lit: pad } });
      setTimeout(() => set(st => (st.game ? { game: { ...st.game, lit: -1 } } : null)), 140);
    },
    [set],
  );

  const onMathPick = useCallback(
    value => {
      const s = stateRef.current;
      if (!s.game || s.outcome || s.game.picked !== null) return;
      senderRef.current?.add('answer', value, true);
      set({ game: { ...s.game, picked: value } });
    },
    [set],
  );

  const doShare = useCallback(() => set({ shared: true }), [set]);

  return {
    state,
    setView,
    nextOnb,
    skipOnb,
    enterZone,
    backZones,
    backToMap,
    onTile,
    onSurvey,
    ackTutorial,
    dismissStuck,
    loadShop,
    buy,
    spendRefill,
    toggleSurveyMode,
    closeHunt,
    confirmHunt,
    acceptQuote,
    exitMinigame,
    onMgTap,
    onSeqTap,
    onMemPad,
    onMathPick,
    onCrackLock,
    setField,
    doShare,
    toast,
  };
}
