import { SPEC9, ZONES, COLS } from '../data/gameData';

const TILE_SIZE = 54;
const GAP = 8;

const TYPE_COLORS = {
  empty:   '#0C0C10',
  clue:    '#29E6E6',
  trap:    '#FF3D3D',
  mystery: '#8A3DFF',
  puzzle:  '#B7FF3B',
  found:   '#FFD51F',
  treasure:'transparent',
  puzzleHunt:'transparent',
};

function TileCell({ cell, onClick }) {
  const isHidden = !cell.opened && !cell.treasure && !cell.puzzle;
  const isTreasure = cell.treasure && !cell.opened;
  const isPuzzleHunt = cell.puzzle && !cell.opened;

  let bg = '#1A1815';
  let border = '2px solid #0C0C10';
  let content = null;

  if (cell.opened) {
    bg = TYPE_COLORS[cell.type] || '#0C0C10';
    if (cell.type === 'found') {
      content = (
        <div style={{ fontSize: 9, fontFamily: "'Space Mono', monospace", fontWeight: 700, color: '#0C0C10', textAlign: 'center', lineHeight: 1.2, padding: 2 }}>
          {cell.prize || 'FOUND'}
        </div>
      );
    }
  } else if (isTreasure) {
    bg = '#0C0C10';
    border = '2px solid #FFD51F';
    content = (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexWrap: 'wrap', overflow: 'hidden' }}>
        {SPEC9.map((c, i) => <div key={i} style={{ flex: '1 0 33%', background: c, opacity: .7 }} />)}
      </div>
    );
  } else if (isPuzzleHunt) {
    bg = '#0C0C10';
    border = '2px solid #8A3DFF';
    content = (
      <div style={{
        width: '100%', height: '100%',
        background: 'repeating-linear-gradient(45deg, #8A3DFF22, #8A3DFF22 4px, transparent 4px, transparent 8px)',
      }} />
    );
  }

  return (
    <div
      onClick={() => onClick(cell)}
      style={{
        width: TILE_SIZE, height: TILE_SIZE,
        background: bg, border,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: (!cell.opened || isTreasure || isPuzzleHunt) ? 'pointer' : 'default',
        position: 'relative', overflow: 'hidden',
        transition: 'transform .08s',
        flexShrink: 0,
      }}
    >
      {content}
      {!cell.opened && !isTreasure && !isPuzzleHunt && (
        <div style={{ position: 'absolute', inset: 0, background: '#1A1815', opacity: .95 }} />
      )}
    </div>
  );
}

export default function GridScreen({ state, gridCells, onGoHome, onBackZones, onTile }) {
  const { mapZone, energy, energyMax, floats, showToast, toastText } = state;
  const zone = ZONES.find(z => z.id === mapZone) || ZONES[0];

  const energyCells = Array.from({ length: energyMax }).map((_, i) => ({
    filled: i < energy,
    color: i < energy ? '#FFD51F' : '#0C0C10',
  }));

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
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10', lineHeight: 1, marginTop: 2 }}>{zone.name}</div>
          </div>
        </div>
        {/* energy bar */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: '#0C0C10', opacity: .5 }}>ENERGY</div>
          <div style={{ display: 'flex', gap: 3 }}>
            {energyCells.map((c, i) => (
              <div key={i} style={{ width: 14, height: 14, border: '2px solid #0C0C10', background: c.color }} />
            ))}
          </div>
        </div>
      </div>

      {/* zone accent stripe */}
      <div style={{ height: 4, background: zone.accent, flexShrink: 0 }} />

      {/* scrollable grid */}
      <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {/* floating cost labels */}
        {floats.map(f => (
          <div key={f.id} style={{
            position: 'absolute', left: f.x, top: f.y, zIndex: 50,
            fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
            color: '#FFD51F', pointerEvents: 'none',
            animation: 'lg-costfloat .75s ease-out forwards',
            transform: 'translate(-50%, 0)',
          }}>-{f.amt}⚡</div>
        ))}

        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${COLS}, ${TILE_SIZE}px)`,
          gap: GAP,
          padding: '18px 16px 22px',
          width: 'max-content',
        }}>
          {gridCells.map(cell => (
            <TileCell key={cell.id} cell={cell} onClick={onTile} />
          ))}
        </div>
      </div>

      {/* toast */}
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
