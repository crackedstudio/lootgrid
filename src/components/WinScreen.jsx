import Mascot, { Coin } from './Mascot';
import { SPEC9 } from '../data/gameData';

function Confetti() {
  const pieces = Array.from({ length: 18 }).map((_, i) => ({
    color: SPEC9[i % SPEC9.length],
    left: `${5 + (i * 5.5) % 90}%`,
    delay: `${(i * 0.18) % 2.5}s`,
    dur: `${1.8 + (i % 5) * 0.4}s`,
    size: 6 + (i % 4) * 3,
  }));

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 1 }}>
      {pieces.map((p, i) => (
        <div key={i} style={{
          position: 'absolute', top: 0, left: p.left,
          width: p.size, height: p.size, background: p.color,
          animation: `lg-confetti ${p.dur} ${p.delay} linear infinite`,
        }} />
      ))}
    </div>
  );
}

export default function WinScreen({ state, onShare, onBackToMap }) {
  const { winData, shared } = state;
  const w = winData || {};
  const isCash = (w.kind || 'cash') === 'cash';

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 70, background: '#0C0C10',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '28px 22px', overflow: 'hidden',
    }}>
      <Confetti />

      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {/* mascot */}
        <div style={{ animation: 'lg-cheer 1s ease-in-out infinite', marginBottom: 8 }}>
          <Mascot color={isCash ? '#FFD51F' : '#8A3DFF'} mole size={62} />
        </div>

        {/* kick label */}
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.18em', color: isCash ? '#FFD51F' : '#8A3DFF', marginBottom: 10 }}>
          {isCash ? 'FIRST TO CRACK IT' : 'PUZZLE SOLVED · PURE SKILL'}
        </div>

        {/* win card */}
        <div style={{
          background: 'var(--card)', border: `4px solid ${isCash ? '#FFD51F' : '#8A3DFF'}`,
          boxShadow: `9px 9px 0 ${isCash ? '#FF3BBD' : '#29E6E6'}`,
          padding: '20px 26px 24px', width: 300,
          animation: 'lg-pop .42s ease-out both',
        }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: '#0C0C10', opacity: .55 }}>
            {isCash ? 'YOU WON' : 'YOU EARNED'}
          </div>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 44, lineHeight: 1, color: '#0C0C10', marginTop: 4, marginBottom: 16 }}>
            {w.prize || '$0.00'}
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
            <div style={{ flex: 1, border: '2px solid #0C0C10', padding: '10px 12px' }}>
              <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10' }}>
                {isCash ? `${w.beat || 0} players` : `${w.steps || 4} steps`}
              </div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: '#0C0C10', opacity: .5, marginTop: 4 }}>
                {isCash ? 'YOU BEAT' : 'SEQUENCE'}
              </div>
            </div>
            <div style={{ flex: 1, border: '2px solid #0C0C10', padding: '10px 12px' }}>
              <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10' }}>{w.creator || '@creator'}</div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: '#0C0C10', opacity: .5, marginTop: 4 }}>CREATOR</div>
            </div>
          </div>

          {isCash && (
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color: '#0C0C10', opacity: .45 }}>
              TX: {w.tx || '0x000…00'}
            </div>
          )}
        </div>

        {/* share button */}
        <div
          onClick={onShare}
          style={{
            marginTop: 18, width: 300, border: '4px solid #0C0C10',
            background: shared ? '#2CE66A' : '#FFD51F',
            boxShadow: '6px 6px 0 #FF3BBD', padding: 16, textAlign: 'center',
            fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10',
            cursor: 'pointer', transition: 'background .2s',
          }}
        >
          {shared ? 'SHARED ✓ — NICE ONE' : 'SHARE THE WIN'}
        </div>

        <div
          onClick={onBackToMap}
          style={{
            marginTop: 14, fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
            color: 'var(--cream)', opacity: .55, cursor: 'pointer', letterSpacing: '.08em',
          }}
        >← BACK TO GRID</div>
      </div>
    </div>
  );
}
