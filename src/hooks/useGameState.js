import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, ApiError } from '../api/http';
import { fetchHints } from '../api/hints';
import { enterHunt } from '../api/entry';
import { publishEntry, publishWin } from '../api/records';
import { createSender, socket } from '../api/socket';
import { ONB_CARDS } from '../data/gameData';

/** Display-only: the server is authoritative and corrects us on every response. */
const REGEN_MS = 9000;

const INITIAL = {
  view: 'home',
  onbStep: 0,
  mapZone: null,
  /** Hints the player holds. Directions toward a hunt — some of them lie. */
  hints: [],

  // session
  status: 'connecting', // connecting | online | offline
  fatal: null, // { code, message } — unrecoverable, blocks the app
  player: null,
  energy: { value: 0, max: 12, nextRegenMs: 0 },

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

  boardTab: 'daily',
  showToast: false,
  toastText: '',
};

const cellKey = (r, c) => `${r},${c}`;

/** Fresh render state for whichever game the block handed us. */
function initGame(gameType, spec) {
  switch (gameType) {
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

  const clearMemTimers = useCallback(() => {
    memTimers.current.forEach(clearTimeout);
    memTimers.current = [];
  }, []);

  // ---------------------------------------------------------------- boot

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [me, zones] = await Promise.all([get('/me'), get('/zones')]);
        if (cancelled) return;
        set({ player: { playerId: me.playerId, handle: me.handle }, energy: me.energy, zones: zones.zones });
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
          return set(s => (s.grid ? { grid: { ...s.grid, hunts: msg.hunts } } : null));

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

  const onTile = useCallback(
    async cell => {
      const s = stateRef.current;
      if (!s.grid || cell.opened) return;

      if (cell.hunt) {
        const cost = cell.hunt.kind === 'cash' ? 3 : 2;
        if (s.energy.value < cost) return toast(`NEED ${cost} ENERGY TO HUNT`);
        return set({ huntPreview: cell.hunt });
      }

      if (s.energy.value < 1) return toast('OUT OF ENERGY — REGENERATING');

      try {
        const res = await post(`/zones/${s.mapZone}/tiles/${cell.r}/${cell.c}/open`);
        set(prev => ({
          energy: res.energy,
          grid: prev.grid
            ? { ...prev.grid, reveals: { ...prev.grid.reveals, [cellKey(cell.r, cell.c)]: res.cell } }
            : null,
        }));
        // A reveal can pay out a hint. Prepend so the newest is first, and
        // guard against a duplicate if the same grant arrives twice.
        if (res.hint) {
          set(prev => ({
            hints: prev.hints.some(h => h.id === res.hint.id)
              ? prev.hints
              : [res.hint, ...prev.hints],
          }));
          toast('HINT FOUND');
        }
        if (res.alreadyOpen) toast('SOMEONE BEAT YOU TO IT');
      } catch (err) {
        if (err.code === 'insufficient_energy') {
          if (err.body?.details) set({ energy: err.body.details });
          return toast('OUT OF ENERGY — REGENERATING');
        }
        toast('COULD NOT OPEN TILE');
      }
    },
    [set, toast],
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
        game: initGame(res.gameType, res.spec),
        rivals: [],
        outcome: null,
        failReason: null,
        lostTo: null,
        winData: null,
        shared: false,
      });
    } catch (err) {
      set({ huntPreview: null, paying: false });
      if (err.code === 'no_wallet') return toast('NO WALLET TO PAY WITH');
      if (err.code === 'signature_refused') return toast('PAYMENT CANCELLED');
      if (err.status === 402) return toast('PAYMENT WAS REFUSED');
      if (err.code === 'insufficient_energy') return toast('NOT ENOUGH ENERGY');
      if (err.code === 'already_attempted') return toast('YOU ALREADY TRIED THIS ONE');
      if (err.code === 'hunt_not_live') return toast('ALREADY CRACKED');
      toast('COULD NOT ENTER HUNT');
    }
  }, [set, toast]);

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
    closeHunt,
    confirmHunt,
    acceptQuote,
    exitMinigame,
    onMgTap,
    onSeqTap,
    onMemPad,
    onMathPick,
    setField,
    doShare,
    toast,
  };
}
