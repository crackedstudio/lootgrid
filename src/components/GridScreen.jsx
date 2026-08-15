import { useState } from 'react';
import { SPEC9 } from '../data/gameData';
import { candidates, describe, reliabilityPct, tierLabel } from '../api/hints';

const TILE_SIZE = 54;
const GAP = 8;

const TYPE_COLORS = {
  empty:   '#0C0C10',
  clue:    '#29E6E6',
  trap:    '#FF3D3D',
  mystery: '#8A3DFF',
  puzzle:  '#B7FF3B',
  found:   '#FFD51F',
};

function TileCell({ cell, onClick, dimmed }) {
  const { opened, hunt, reveal } = cell;

  let bg = '#1A1815';
  let border = '2px solid #0C0C10';
  let content = null;

  if (hunt) {
    bg = '#0C0C10';
    const isCash = hunt.kind === 'cash';
    border = `2px solid ${isCash ? '#FFD51F' : '#8A3DFF'}`;
    content = isCash ? (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexWrap: 'wrap', overflow: 'hidden' }}>
        {SPEC9.map((c, i) => <div key={i} style={{ flex: '1 0 33%', background: c, opacity: .7 }} />)}
      </div>
    ) : (
      <div style={{
        width: '100%', height: '100%',
        background: 'repeating-linear-gradient(45deg, #8A3DFF22, #8A3DFF22 4px, transparent 4px, transparent 8px)',
      }} />
    );
  } else if (opened) {
    bg = TYPE_COLORS[reveal.type] || '#0C0C10';
  }

  return (
    <div
      onClick={() => onClick(cell)}
      title={opened ? `${reveal.type} · ${reveal.byHandle}` : undefined}
      style={{
        width: TILE_SIZE, height: TILE_SIZE,
        background: bg, border,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: opened ? 'default' : 'pointer',
        position: 'relative', overflow: 'hidden',
        transition: 'transform .08s, opacity .15s',
        flexShrink: 0,
        // Ruled out by an active hint. Dimmed rather than blocked: the hint may
        // be lying, and a player who wants to dig here must stay free to.
        opacity: dimmed ? 0.25 : 1,
      }}
    >
      {content}
    </div>
  );
}

export default function GridScreen({ state, onBackZones, onTile }) {
  const { grid, energy, showToast, toastText, zones, mapZone, hints = [] } = state;
  const zone = zones.find(z => z.id === mapZone);

  // Which hints the player is currently trusting. View state, not game state —
  // the server neither knows nor cares which ones you believe.
  const [active, setActive] = useState(() => new Set());
  const toggle = id =>
    setActive(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!grid) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface)', fontFamily: "'Space Mono', monospace",
        fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .6,
      }}>
        LOADING GRID…
      </div>
    );
  }

  // Cells are derived from what the server told us: a live hunt, an uncovered
  // reveal, or fog. Anything absent from the payload stays fog — the client has
  // no way to know what is under it.
  const huntAt = new Map(grid.hunts.map(h => [`${h.r},${h.c}`, h]));
  const cells = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const key = `${r},${c}`;
      const reveal = grid.reveals[key];
      cells.push({ id: key, r, c, reveal, opened: !!reveal, hunt: huntAt.get(key) });
    }
  }

  const energyCells = Array.from({ length: energy.max }).map((_, i) => ({
    color: i < energy.value ? '#FFD51F' : '#0C0C10',
  }));

  // Hints for this zone only — one from another map tells you nothing here.
  const zoneHints = hints.filter(h => h.zoneId === mapZone);
  const activePayloads = zoneHints.filter(h => active.has(h.id)).map(h => h.payload);
  // Intersecting is the game: one hint is weak and might be a lie, several that
  // agree are worth digging on. An empty set means they contradict each other,
  // which is information too — at least one of them is false.
  const candidateSet = activePayloads.length ? candidates(activePayloads, grid.rows, grid.cols) : null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)', overflow: 'hidden', position: 'relative' }}>
      {/* header */}
      <div style={{
        flexShrink: 0, padding: '14px 16px 12px', borderBottom: '3px solid #0C0C10',
        background: 'var(--card)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div onClick={onBackZones} style={{
            width: 34, height: 34, background: '#FFD51F', border: '3px solid #0C0C10',
            boxShadow: '3px 3px 0 #0C0C10', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontFamily: "'Archivo Black', sans-serif",
            fontSize: 15, color: '#0C0C10', cursor: 'pointer',
          }}>←</div>
          <div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: '#0C0C10', opacity: .55 }}>HUNTING IN</div>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10', lineHeight: 1, marginTop: 2 }}>
              {zone?.name ?? '…'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: '#0C0C10', opacity: .5 }}>ENERGY</div>
          <div style={{ display: 'flex', gap: 3 }}>
            {energyCells.map((c, i) => (
              <div key={i} style={{ width: 14, height: 14, border: '2px solid #0C0C10', background: c.color }} />
            ))}
          </div>
        </div>
      </div>

      <div style={{ height: 4, background: zone?.accent ?? '#FF7A1A', flexShrink: 0 }} />

      {/* Hints. Tap to trust one and watch the map narrow; tap again to doubt it. */}
      {zoneHints.length > 0 && (
        <div style={{
          flexShrink: 0, padding: '8px 12px', background: '#0C0C10',
          borderBottom: '3px solid #0C0C10', display: 'flex', gap: 8,
          overflowX: 'auto', alignItems: 'center',
        }}>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
            letterSpacing: '.14em', color: '#FFD51F', flexShrink: 0, opacity: .8,
          }}>
            {candidateSet ? `${candidateSet.size} LEFT` : `${zoneHints.length} HINT${zoneHints.length > 1 ? 'S' : ''}`}
          </div>

          {zoneHints.map(h => {
            const on = active.has(h.id);
            const pct = reliabilityPct(h);
            return (
              <div
                key={h.id}
                onClick={() => toggle(h.id)}
                title={`${tierLabel(h.tier)} · about ${pct}% of these are true`}
                style={{
                  flexShrink: 0, cursor: 'pointer', padding: '5px 9px',
                  background: on ? '#FFD51F' : '#1A1815',
                  border: `2px solid ${on ? '#FFD51F' : '#3A352C'}`,
                  color: on ? '#0C0C10' : 'var(--cream)',
                  fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
                  lineHeight: 1.35, maxWidth: 190, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                <div>{describe(h.payload)}</div>
                {/* The odds, always visible. A sharp hint is close to a coin
                    flip and the player is entitled to know before digging. */}
                <div style={{ opacity: .65, fontSize: 8, letterSpacing: '.08em' }}>
                  {tierLabel(h.tier).toUpperCase()} · {pct}% RELIABLE
                </div>
              </div>
            );
          })}
        </div>
      )}

      {candidateSet?.size === 0 && (
        <div style={{
          flexShrink: 0, padding: '6px 12px', background: '#FF3D3D',
          fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
          color: '#0C0C10', letterSpacing: '.1em',
        }}>
          THESE HINTS CONTRADICT — AT LEAST ONE IS LYING
        </div>
      )}

      {/* scrollable grid */}
      <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${grid.cols}, ${TILE_SIZE}px)`,
          gap: GAP,
          padding: '18px 16px 22px',
          width: 'max-content',
        }}>
          {cells.map(cell => (
            <TileCell
              key={cell.id}
              cell={cell}
              onClick={onTile}
              dimmed={candidateSet !== null && !candidateSet.has(`${cell.r}:${cell.c}`)}
            />
          ))}
        </div>
      </div>

      {showToast && (
        <div style={{
          position: 'absolute', bottom: 70, left: '50%', transform: 'translateX(-50%)',
          background: '#0C0C10', border: '2px solid #FFD51F', padding: '8px 16px',
          fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, color: '#FFD51F',
          whiteSpace: 'nowrap', zIndex: 80, animation: 'lg-pop .2s ease-out',
        }}>{toastText}</div>
      )}
    </div>
  );
}
