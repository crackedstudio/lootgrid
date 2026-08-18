/**
 * The tile vocabulary from LOOTGRID.dc.html, ported.
 *
 * The design draws a tile as a lit 3D object sitting in a hole: a radial
 * gradient, a specular highlight, an inset shade and a hard offset shadow.
 * The first implementation flattened every one of these to a solid rectangle,
 * which cost two things at once —
 *
 *   1. the look. A flat #8A3DFF square is not a buried thing.
 *   2. the *encoding*. Colour became the only channel, and the survey ramp
 *      (burning/hot/warm = red/orange/yellow) plus the type palette (trap red
 *      vs found yellow) are exactly the pairs that collapse for the ~8% of men
 *      with a red-green deficiency. The design had already solved this with a
 *      distinct glyph per type; the glyphs were dropped with the domes.
 *
 * So every helper here carries shape as well as hue. `iconFor` is the
 * colour-blind fix and the art direction at the same time, which is why it is
 * worth porting faithfully rather than approximating.
 */

const INK = '#0C0C10';

/** Lighten (amt > 0) or darken (amt < 0) a hex colour. Design's `shade`. */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v =>
    Math.max(0, Math.min(255, Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt)))),
  );
  return `#${ch.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function Svg({ paths, color, width = 3, size = 22 }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color}
      strokeWidth={width} strokeLinecap="square" strokeLinejoin="miter"
      style={{ display: 'block' }}
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/**
 * One glyph per tile type — the redundant encoding that makes the board
 * readable without colour. Shapes are deliberately far apart in silhouette:
 * a cross, a diamond, a divided square, a warning triangle, a burst, a dash.
 */
export function TypeGlyph({ type, color, size = 22 }) {
  switch (type) {
    case 'found':
    case 'treasure':
      return <Svg paths={['M5 5 L19 19', 'M19 5 L5 19']} color={color} width={3.6} size={size} />;
    case 'clue':
      return <Svg paths={['M12 3 L21 12 L12 21 L3 12 Z']} color={color} size={size} />;
    case 'puzzle':
      return <Svg paths={['M4 4 H20 V20 H4 Z', 'M12 4 V20', 'M4 12 H20']} color={color} width={2.6} size={size} />;
    case 'trap':
      return <Svg paths={['M12 4 L21 19 L3 19 Z', 'M12 10 V14']} color={color} size={size} />;
    case 'mystery':
      return <Svg paths={['M12 4 V20', 'M4 12 H20', 'M6 6 L18 18', 'M18 6 L6 18']} color={color} width={2.4} size={size} />;
    default:
      return <Svg paths={['M8 12 H16']} color={color} width={2.6} size={Math.round(size * 0.82)} />;
  }
}

/** The padlock that sits on an un-entered hunt dome. */
export function LockIcon({ size = 15 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="square" style={{ display: 'block' }}>
      <rect x="5" y="11" width="14" height="9" fill={INK} stroke="none" />
      <path d="M8 11 V8 a4 4 0 0 1 8 0 V11" />
    </svg>
  );
}

/**
 * A lit dome. The specular dot at 20%/16% is what reads as "round" — without
 * it a radial gradient is just a soft circle.
 *
 * `spectrum` swaps the fill for the SPEC9 conic sweep, reserved for cash
 * hunts: the one tile on the board that is worth money looks like nothing else
 * on the board.
 */
export function Dome({ color, spectrum = false, icon = null, pct = 64 }) {
  const bg = spectrum
    ? 'conic-gradient(from 210deg,#FF3D3D,#FF7A1A,#FFD51F,#B7FF3B,#2CE66A,#29E6E6,#2F6BFF,#8A3DFF,#FF3BBD,#FF3D3D)'
    : `radial-gradient(circle at 34% 30%, ${shade(color, 0.55)}, ${color} 58%, ${shade(color, -0.28)})`;

  return (
    <div style={{
      width: `${pct}%`, height: `${pct}%`, borderRadius: '50%', background: bg,
      border: `2.5px solid ${INK}`, boxShadow: 'inset -2px -3px 0 rgba(12,12,16,.22)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
    }}>
      <div style={{
        position: 'absolute', top: '16%', left: '20%', width: '26%', height: '18%',
        borderRadius: '50%', background: '#FFFAF4', opacity: 0.7,
      }} />
      {icon}
    </div>
  );
}

/**
 * Undug ground: a mound of earth with a "?" cut into it.
 *
 * This is the single most repeated object in the game — 3,600 of them on a
 * fresh board — and in the design it is the thing that makes the map look like
 * a place rather than a spreadsheet.
 */
export function CoverDome() {
  return (
    <div style={{
      width: '58%', height: '58%', borderRadius: '50%',
      background: 'radial-gradient(circle at 36% 30%, #7A5740, #3E2A1C 62%, #241710)',
      border: `2.5px solid ${INK}`, boxShadow: 'inset -2px -3px 0 rgba(0,0,0,.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 13, color: 'rgba(245,239,227,.45)' }}>?</div>
    </div>
  );
}

/** A minted coin, for a find that paid out. */
export function Coin({ color = '#FFD51F', size = 22 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `radial-gradient(circle at 34% 30%, ${shade(color, 0.58)}, ${color} 60%, ${shade(color, -0.3)})`,
      border: `2.5px solid ${INK}`, boxShadow: `1.5px 2px 0 ${INK}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Archivo Black', sans-serif", fontSize: Math.round(size * 0.52),
      color: 'rgba(12,12,16,.65)',
    }}>$</div>
  );
}

/**
 * A hunt dome plus the ribbon naming its prize.
 *
 * The ribbon is the design's answer to a question the shipped board could not
 * answer at all: *is this one worth chasing?* A cash tile and an XP tile
 * differed only by border colour, so the choice carried no information until
 * after it had been paid for.
 */
export function HuntTile({ children, tag, tagColor }) {
  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex',
      alignItems: 'center', justifyContent: 'center', position: 'relative',
    }}>
      {children}
      {tag && (
        <div style={{
          position: 'absolute', bottom: -7, left: '50%', transform: 'translateX(-50%)',
          background: INK, color: tagColor, fontFamily: "'Archivo Black', sans-serif",
          fontSize: 11, lineHeight: '13px', padding: '0 5px',
          border: `2px solid ${tagColor}`, whiteSpace: 'nowrap', zIndex: 2,
        }}>{tag}</div>
      )}
    </div>
  );
}
