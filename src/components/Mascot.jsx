const K = '#0C0C10';
const W = '#FFFAF4';

function pixel(r, c, color, sz) {
  return (
    <rect
      key={`${r}-${c}`}
      x={c * sz}
      y={r * sz}
      width={sz}
      height={sz}
      fill={color}
    />
  );
}

const HUNTER_MAP = {
  '.': null, 'K': K, 'S': '#CC9944', 'W': W, 'P': '#FF3BBD',
};
const MOLE_MAP = {
  '.': null, 'K': K, 'S': '#B87A3C', 'W': W, 'P': '#FF3BBD',
};

const HUNTER_SPR = [
  '..KKK..',
  '.KKKKK.',
  '.KSSSK.',
  '.KWSWK.',
  '.KSSSK.',
  '.KKSKK.',
  '.K.K.K.',
];
const MOLE_SPR = [
  '..KKK..',
  '.KSSSK.',
  '.KWSWK.',
  '.KSPSK.',
  '.KSSSK.',
  '.KKSKK.',
  '.K...K.',
];

export default function Mascot({ color = '#FFD51F', mole = false, size = 64 }) {
  const spr = mole ? MOLE_SPR : HUNTER_SPR;
  const colorMap = mole ? { ...MOLE_MAP, S: color === '#FFD51F' ? '#B87A3C' : color } : { ...HUNTER_MAP, S: color === '#2CE66A' ? '#1AAD50' : '#CC9944' };
  const cols = spr[0].length;
  const rows = spr.length;
  const px = Math.floor(size / cols);
  const w = cols * px;
  const h = rows * px;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ imageRendering: 'pixelated', display: 'block' }}>
      {/* body color bg */}
      <rect width={w} height={h} fill="transparent" />
      {spr.map((row, r) =>
        row.split('').map((ch, c) => {
          let fill = colorMap[ch];
          if (ch === 'S') fill = color;
          if (!fill || fill === null) return null;
          return pixel(r, c, fill, px);
        })
      )}
    </svg>
  );
}

export function Coin({ color = '#FFD51F', size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="10" fill={color} stroke={K} strokeWidth="2.5" />
      <circle cx="12" cy="12" r="5" fill="none" stroke={K} strokeWidth="2" opacity=".35" />
    </svg>
  );
}

export function IconSvg({ paths, color = '#F5EFE3', strokeWidth = 2.5, size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
