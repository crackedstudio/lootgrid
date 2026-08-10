import Mascot, { Coin } from './Mascot';
import { HOME_COINS, SPEC9 } from '../data/gameData';

export default function HomeScreen({ state, onEnter, onSkipIntro }) {
  // Real figures from the referee, not decorative counters ticking upward.
  const { zones, status } = state;
  const liveHunts = zones.reduce((n, z) => n + (z.hunts ?? 0), 0);
  const online = status === 'online';

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 70, background: '#0C0C10',
      overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      {/* floating coins */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {HOME_COINS.map((coin, i) => (
          <div key={i} style={{
            position: 'absolute',
            left: coin.left, top: coin.top,
            opacity: 0.9,
            animation: `lg-float ${3 + (i % 4)}s ease-in-out ${coin.delay}s infinite`,
          }}>
            <Coin color={coin.color} size={coin.size} />
          </div>
        ))}
      </div>

      {/* dot grid */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: 'radial-gradient(rgba(245,239,227,.06) 1.4px, transparent 1.4px)',
        backgroundSize: '26px 26px',
      }} />

      {/* header */}
      <div style={{
        position: 'relative', flexShrink: 0, padding: '18px 18px 0',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 2,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 26, height: 26, background: '#FFD51F', border: '2px solid #0C0C10',
            boxShadow: '2px 2px 0 #07955F', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontFamily: "'Archivo Black', sans-serif", fontSize: 13, color: '#0C0C10',
          }}>L</div>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
            letterSpacing: '.18em', color: 'var(--cream)', opacity: .55,
          }}>CRACKED STUDIOS</div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          border: `2px solid ${online ? '#07955F' : '#FF7A1A'}`, padding: '3px 8px',
        }}>
          <div style={{ width: 7, height: 7, background: online ? '#07955F' : '#FF7A1A', animation: 'lg-bob 1s ease-in-out infinite' }} />
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: online ? '#07955F' : '#FF7A1A' }}>
            {online ? 'LIVE' : 'CONNECTING'}
          </div>
        </div>
      </div>

      {/* center hero */}
      <div style={{
        position: 'relative', flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: 18, zIndex: 2,
      }}>
        <div style={{ marginBottom: 4, animation: 'lg-cheer 1.1s ease-in-out infinite' }}>
          <Mascot color="#FFD51F" mole size={88} />
        </div>
        <div style={{
          fontFamily: "'Archivo Black', sans-serif", fontSize: 76, lineHeight: .8,
          color: 'var(--cream)', letterSpacing: '-.02em',
          textShadow: '0 5px 0 #0C0C10, 5px 5px 0 rgba(0,0,0,.45)',
        }}>LOOT</div>
        <div style={{
          fontFamily: "'Archivo Black', sans-serif", fontSize: 76, lineHeight: .82,
          letterSpacing: '-.02em',
          background: 'linear-gradient(90deg,#FF3D3D,#FF7A1A,#FFD51F,#2CE66A,#29E6E6,#2F6BFF,#8A3DFF,#FF3BBD)',
          WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
        }}>GRID</div>

        {/* spectrum strip */}
        <div style={{ display: 'flex', width: 232, height: 9, marginTop: 15, border: '2px solid #0C0C10' }}>
          {SPEC9.map((c, i) => <div key={i} style={{ flex: 1, background: c }} />)}
        </div>

        <div style={{
          fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600,
          lineHeight: 1.4, color: 'var(--cream)', opacity: .78, marginTop: 16,
          textAlign: 'center', maxWidth: 282,
        }}>
          A living map of real prizes someone else put up. Hunt them. Crack them. First to win, takes it.
        </div>
      </div>

      {/* live stats */}
      <div style={{
        position: 'relative', flexShrink: 0, margin: '0 18px',
        border: '3px solid #FFD51F', background: 'rgba(245,239,227,.05)',
        padding: '13px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 2,
      }}>
        <div>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, letterSpacing: '.14em', color: '#FFD51F' }}>HUNTS LIVE ON THE GRID</div>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 29, lineHeight: 1, color: 'var(--cream)', marginTop: 4 }}>
            {liveHunts}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 22, lineHeight: 1, color: '#2CE66A' }}>
            {zones.length}
          </div>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, letterSpacing: '.1em', color: 'var(--cream)', opacity: .5, marginTop: 4 }}>ZONES OPEN</div>
        </div>
      </div>

      {/* CTA */}
      <div style={{ position: 'relative', flexShrink: 0, padding: '16px 18px 22px', zIndex: 2 }}>
        <div
          onClick={onEnter}
          style={{
            border: '4px solid #0C0C10', background: '#FFD51F', boxShadow: '0 6px 0 #07955F',
            padding: 18, textAlign: 'center', fontFamily: "'Archivo Black', sans-serif",
            fontSize: 20, color: '#0C0C10', cursor: 'pointer',
            animation: 'lg-bob 2s ease-in-out infinite',
          }}
        >ENTER THE GRID →</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 13 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 7, height: 7, background: '#07955F' }} />
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: '#07955F' }}>powered by MiniPay</div>
          </div>
          <div onClick={onSkipIntro} style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: 'var(--cream)', opacity: .55, cursor: 'pointer' }}>
            skip intro →
          </div>
        </div>
      </div>
    </div>
  );
}
