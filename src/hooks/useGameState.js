import { useState, useEffect, useRef, useCallback } from 'react';
import { buildGrid, ONB_CARDS } from '../data/gameData';

const INITIAL_STATE = {
  view: 'home',
  onbStep: 0,
  mapZone: null,
  liveLoot: 48217,
  liveHunters: 1204,
  energy: 9,
  energyMax: 12,
  boardTab: 'daily',
  showToast: false,
  toastText: '',
  huntPreview: null,
  showMinigame: false,
  mgType: 'tap',
  mgCell: null,
  mgTaps: 0,
  mgTarget: 14,
  mgTime: 6.0,
  mgFail: false,
  memSeq: [],
  memInput: 0,
  memPhase: 'watch',
  memLit: -1,
  mathQ: '',
  mathOpts: [],
  mathAns: 0,
  mathPick: -1,
  mathStreak: 0,
  seqTiles: [],
  seqNext: 1,
  seqN: 5,
  seqWrong: -1,
  showWin: false,
  winData: null,
  shared: false,
  rivals: [],
  showRivals: false,
  lostTo: null,
  floats: [],
  chPrize: '10.00',
  chToken: 'cUSD',
  chDiff: 'med',
  chDur: '24h',
  chDeposited: false,
};

export function useGameState(surface = 'terracotta', startEnergy = 9) {
  const [gridCells, setGridCells] = useState(() => buildGrid());
  const [state, setState] = useState({ ...INITIAL_STATE, energy: startEnergy });
  const toastTimer = useRef(null);
  const mgTimerRef = useRef(null);
  const regenRef = useRef(null);
  const liveRef = useRef(null);
  const memTimers = useRef([]);

  const set = useCallback((patch) => {
    setState(s => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  }, []);

  // energy regen
  useEffect(() => {
    regenRef.current = setInterval(() => {
      set(s => s.energy < s.energyMax ? { energy: s.energy + 1 } : null);
    }, 9000);
    return () => clearInterval(regenRef.current);
  }, [set]);

  // live counters
  useEffect(() => {
    liveRef.current = setInterval(() => {
      set(s => ({
        liveLoot: s.liveLoot + Math.floor(Math.random() * 46) + 4,
        liveHunters: 1180 + Math.floor(Math.random() * 70),
      }));
    }, 2200);
    return () => clearInterval(liveRef.current);
  }, [set]);

  const toast = useCallback((text) => {
    set({ showToast: true, toastText: text });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => set({ showToast: false }), 1500);
  }, [set]);

  // ---- navigation ----
  const setView = useCallback((view) => set({ view }), [set]);

  const nextOnb = useCallback(() => {
    set(s => {
      if (s.onbStep >= ONB_CARDS.length - 1) return { view: 'map' };
      return { onbStep: s.onbStep + 1 };
    });
  }, [set]);

  const skipOnb = useCallback(() => set({ view: 'map' }), [set]);

  const enterZone = useCallback((zoneId) => set({ mapZone: zoneId }), [set]);
  const backZones = useCallback(() => set({ mapZone: null }), [set]);
  const backToMap = useCallback(() => set({ view: 'map', showWin: false, winData: null, showMinigame: false, showRivals: false, lostTo: null }), [set]);

  // ---- grid tile tap ----
  const spendFloat = useCallback((cell, amt) => {
    const sz = 54, step = sz + 8, padL = 16, padT = 18;
    const x = padL + cell.c * step + sz / 2;
    const y = padT + cell.r * step + sz / 2;
    const id = 'fl' + Date.now() + Math.random();
    set(s => ({ floats: [...s.floats, { id, x, y, amt }] }));
    setTimeout(() => set(s => ({ floats: s.floats.filter(f => f.id !== id) })), 750);
  }, [set]);

  const openHunt = useCallback((cell) => set({ huntPreview: cell }), [set]);
  const closeHunt = useCallback(() => set({ huntPreview: null }), [set]);

  const onTile = useCallback((cell) => {
    if (cell.opened) return;
    if (cell.treasure || cell.puzzle) {
      const cost = cell.treasure ? 3 : 2;
      if (state.energy < cost) { toast(`NEED ${cost} ENERGY TO HUNT`); return; }
      openHunt(cell);
      return;
    }
    if (state.energy < 1) { toast('OUT OF ENERGY — REGENERATING'); return; }
    setGridCells(prev => prev.map(c => c.id === cell.id ? { ...c, opened: true, runtimeOpened: true } : c));
    spendFloat(cell, 1);
    set(s => ({ energy: s.energy - 1 }));
  }, [state.energy, toast, openHunt, spendFloat, set]);

  // ---- confirm hunt → start minigame ----
  const confirmHunt = useCallback(() => {
    const cell = state.huntPreview;
    if (!cell) return;
    const cost = cell.treasure ? 3 : 2;
    set(s => ({ huntPreview: null, energy: Math.max(0, s.energy - cost) }));
    spendFloat(cell, cost);
    if (cell.treasure) {
      const g = (cell.r + cell.c) % 3;
      if (g === 0) startTap(cell);
      else if (g === 1) startMath(cell);
      else startSequence(cell);
    } else {
      startMemory(cell);
    }
  }, [state.huntPreview, set, spendFloat]);

  // ---- rivals ----
  const startRivals = useCallback((cell) => {
    const pool = [['@maya','#FF3D3D'],['@deji','#29E6E6'],['@ama','#B7FF3B'],['@kofi','#2F6BFF'],['@zara','#FF7A1A']];
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    const n = Math.min(3, Math.max(2, Math.round((cell.beat || 10) / 14) + 2));
    const rivals = shuffled.slice(0, n).map(([handle, color]) => ({
      handle, color, pct: Math.floor(Math.random() * 30),
    }));
    set({ rivals, showRivals: true });

    const rivalTimer = setInterval(() => {
      set(s => {
        if (!s.showRivals) { clearInterval(rivalTimer); return null; }
        const updated = s.rivals.map(r => ({ ...r, pct: Math.min(100, r.pct + Math.floor(Math.random() * 8) + 2) }));
        const winner = updated.find(r => r.pct >= 100);
        if (winner) {
          clearInterval(rivalTimer);
          return { rivals: updated, showRivals: false, lostTo: winner.handle, showMinigame: false };
        }
        return { rivals: updated };
      });
    }, 280);
  }, [set]);

  // ---- tap minigame ----
  function startTap(cell) {
    set({ showMinigame: true, mgType: 'tap', mgCell: cell, mgTaps: 0, mgTarget: 14, mgTime: 6.0, mgFail: false });
    startRivals(cell);
    let time = 6.0;
    mgTimerRef.current = setInterval(() => {
      time -= 0.1;
      if (time <= 0) {
        clearInterval(mgTimerRef.current);
        set({ mgTime: 0, mgFail: true });
        return;
      }
      set({ mgTime: parseFloat(time.toFixed(1)) });
    }, 100);
  }

  const onMgTap = useCallback(() => {
    set(s => {
      if (s.mgFail || !s.showMinigame) return null;
      const newTaps = s.mgTaps + 1;
      if (newTaps >= s.mgTarget) {
        clearInterval(mgTimerRef.current);
        const cell = s.mgCell;
        const winData = { kind: 'cash', prize: cell?.prize || '$0.00', beat: cell?.beat || 0, creator: cell?.creator || '@anon', tx: '0x' + Math.random().toString(16).slice(2, 8) + '…' };
        if (cell) {
          setGridCells(prev => prev.map(c => c.id === cell.id ? { ...c, opened: true, type: 'found' } : c));
        }
        return { mgTaps: newTaps, showMinigame: false, showWin: true, winData, showRivals: false };
      }
      return { mgTaps: newTaps };
    });
  }, [set]);

  // ---- memory minigame ----
  const clearMem = useCallback(() => {
    memTimers.current.forEach(t => clearTimeout(t));
    memTimers.current = [];
  }, []);

  function startMemory(cell) {
    clearMem();
    const n = 4;
    const seq = Array.from({ length: n }, () => Math.floor(Math.random() * n));
    set({ showMinigame: true, mgType: 'memory', mgCell: cell, memSeq: seq, memInput: 0, memPhase: 'watch', memLit: -1, mgFail: false });
    startRivals(cell);
    seq.forEach((pad, i) => {
      const t1 = setTimeout(() => set({ memLit: pad }), i * 700 + 400);
      const t2 = setTimeout(() => set({ memLit: -1 }), i * 700 + 700);
      memTimers.current.push(t1, t2);
    });
    const done = setTimeout(() => set({ memPhase: 'input', memLit: -1 }), seq.length * 700 + 900);
    memTimers.current.push(done);
  }

  const onMemPad = useCallback((idx) => {
    set(s => {
      if (s.memPhase !== 'input' || s.mgFail) return null;
      if (idx !== s.memSeq[s.memInput]) {
        return { mgFail: true };
      }
      const next = s.memInput + 1;
      if (next >= s.memSeq.length) {
        const cell = s.mgCell;
        const winData = { kind: 'puzzle', prize: '+' + (cell?.xp || 80) + ' XP', steps: s.memSeq.length, creator: cell?.creator || '@anon' };
        if (cell) {
          setGridCells(prev => prev.map(c => c.id === cell.id ? { ...c, opened: true, type: 'found' } : c));
        }
        return { memInput: next, showMinigame: false, showWin: true, winData, showRivals: false };
      }
      return { memInput: next, memLit: idx };
    });
  }, [set]);

  // ---- math minigame ----
  function startMath(cell) {
    const q = generateMath();
    set({ showMinigame: true, mgType: 'math', mgCell: cell, ...q, mathStreak: 0, mathPick: -1, mgFail: false });
    startRivals(cell);
  }

  function generateMath() {
    const ops = ['+', '-', '×'];
    const op = ops[Math.floor(Math.random() * ops.length)];
    let a = Math.floor(Math.random() * 12) + 1;
    let b = Math.floor(Math.random() * 12) + 1;
    let ans;
    if (op === '+') ans = a + b;
    else if (op === '-') { ans = a - b; }
    else { a = Math.floor(Math.random() * 9) + 1; b = Math.floor(Math.random() * 9) + 1; ans = a * b; }
    const mathQ = `${a} ${op} ${b}`;
    const wrong = new Set([ans]);
    while (wrong.size < 4) wrong.add(ans + (Math.floor(Math.random() * 10) - 5));
    const mathOpts = [...wrong].sort(() => Math.random() - 0.5);
    return { mathQ, mathOpts, mathAns: ans, mathPick: -1 };
  }

  const onMathPick = useCallback((val) => {
    set(s => {
      const correct = val === s.mathAns;
      if (!correct) return { mathPick: val, mgFail: true };
      const streak = s.mathStreak + 1;
      if (streak >= 3) {
        const cell = s.mgCell;
        const winData = { kind: 'cash', prize: cell?.prize || '$0.00', beat: cell?.beat || 0, creator: cell?.creator || '@anon', tx: '0x' + Math.random().toString(16).slice(2, 8) + '…' };
        if (cell) {
          setGridCells(prev => prev.map(c => c.id === cell.id ? { ...c, opened: true, type: 'found' } : c));
        }
        return { mathPick: val, showMinigame: false, showWin: true, winData, showRivals: false };
      }
      const next = generateMath();
      return { mathPick: val, mathStreak: streak, ...next };
    });
  }, [set]);

  // ---- sequence minigame ----
  function startSequence(cell) {
    const n = 5;
    const tiles = Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      color: ['#FF3D3D','#FF7A1A','#FFD51F','#2CE66A','#29E6E6'][i],
      tapped: false,
    })).sort(() => Math.random() - 0.5);
    set({ showMinigame: true, mgType: 'sequence', mgCell: cell, seqTiles: tiles, seqNext: 1, seqN: n, seqWrong: -1, mgFail: false });
    startRivals(cell);
  }

  const onSeqTap = useCallback((tile) => {
    set(s => {
      if (s.mgFail || tile.tapped) return null;
      if (tile.id !== s.seqNext) {
        return { seqWrong: tile.id, mgFail: true };
      }
      const updated = s.seqTiles.map(t => t.id === tile.id ? { ...t, tapped: true } : t);
      const next = s.seqNext + 1;
      if (next > s.seqN) {
        const cell = s.mgCell;
        const winData = { kind: 'cash', prize: cell?.prize || '$0.00', beat: cell?.beat || 0, creator: cell?.creator || '@anon', tx: '0x' + Math.random().toString(16).slice(2, 8) + '…' };
        if (cell) {
          setGridCells(prev => prev.map(c => c.id === cell.id ? { ...c, opened: true, type: 'found' } : c));
        }
        return { seqTiles: updated, showMinigame: false, showWin: true, winData, showRivals: false };
      }
      return { seqTiles: updated, seqNext: next };
    });
  }, [set]);

  // ---- create hunt ----
  const depositEscrow = useCallback(() => set({ chDeposited: true }), [set]);
  const newHunt = useCallback(() => {
    set({ chDeposited: false });
    toast('HUNT PUBLISHED TO THE GRID');
  }, [set, toast]);

  const setField = useCallback((key, val) => set({ [key]: val }), [set]);

  const doShare = useCallback(() => set({ shared: true }), [set]);

  return {
    state,
    gridCells,
    // actions
    setView,
    nextOnb, skipOnb,
    enterZone, backZones, backToMap,
    onTile, openHunt, closeHunt, confirmHunt,
    onMgTap, onMemPad, onMathPick, onSeqTap,
    depositEscrow, newHunt,
    setField,
    doShare,
    toast,
  };
}
