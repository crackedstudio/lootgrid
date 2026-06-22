import Mascot from './Mascot';

export default function HuntPreview({ cell, onConfirm, onClose }) {
  if (!cell) return null;
  const isCash = cell.treasure;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 65, background: 'rgba(12,12,16,.88)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div style={{
        width: '100%', background: 'var(--deep)', border: '4px solid #0C0C10',
        borderBottom: 'none', padding: '26px 22px 28px',
        animation: 'lg-rise .25s ease-out',
      }}>
        {/* creator tag */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: 'var(--cream)', opacity: .55 }}>
            {isCash ? 'TREASURE HUNT' : 'PUZZLE HUNT'}
          </div>
          <div onClick={onClose} style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, color: 'var(--cream)', opacity: .5, cursor: 'pointer' }}>✕ CLOSE</div>
        </div>

        <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 22 }}>
          <div style={{ animation: 'lg-bob 1.4s ease-in-out infinite' }}>
            <Mascot color={isCash ? '#FFD51F' : '#8A3DFF'} mole size={62} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 28, lineHeight: 1, color: isCash ? '#FFD51F' : '#8A3DFF' }}>
              {isCash ? cell.prize : `+${cell.xp} XP`}
            </div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: 'var(--cream)', opacity: .55, marginTop: 6 }}>
              {isCash ? 'PRE-FUNDED PRIZE' : 'PUZZLE REWARD'}
            </div>
          </div>
        </div>

        {/* stats */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 22 }}>
          <div style={{ flex: 1, border: '2px solid rgba(245,239,227,.15)', padding: '10px 12px' }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: 'var(--cream)' }}>{cell.creator}</div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: 'var(--cream)', opacity: .45, marginTop: 4 }}>CREATOR</div>
          </div>
          <div style={{ flex: 1, border: '2px solid rgba(245,239,227,.15)', padding: '10px 12px' }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: 'var(--cream)' }}>{cell.beat} players</div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: 'var(--cream)', opacity: .45, marginTop: 4 }}>CHASING</div>
          </div>
          <div style={{ flex: 1, border: '2px solid rgba(245,239,227,.15)', padding: '10px 12px' }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#FF3D3D' }}>{isCash ? 3 : 2}⚡</div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: 'var(--cream)', opacity: .45, marginTop: 4 }}>COST</div>
          </div>
        </div>

        <div onClick={onConfirm} style={{
          border: '4px solid #0C0C10', background: isCash ? '#FFD51F' : '#8A3DFF',
          boxShadow: '5px 5px 0 #0C0C10', padding: '16px', textAlign: 'center',
          fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10', cursor: 'pointer',
        }}>
          {isCash ? '→ ENTER HUNT' : '→ SOLVE PUZZLE'}
        </div>
      </div>
    </div>
  );
}
