import { BOARD_DATA } from '../data/gameData';

export default function BoardScreen({ state, onTabDaily, onTabAll }) {
  const { boardTab } = state;
  const rows = boardTab === 'daily' ? BOARD_DATA.daily : BOARD_DATA.all;

  const tabStyle = (active) => ({
    flex: 1, padding: 10, textAlign: 'center', cursor: 'pointer',
    border: '3px solid #0C0C10',
    background: active ? '#0C0C10' : 'var(--card)',
    color: active ? '#F5EFE3' : '#0C0C10',
    fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 700,
  });

  const medalColor = (rank) => {
    if (rank === 1) return '#FFD51F';
    if (rank === 2) return '#CFC7B6';
    if (rank === 3) return '#FF7A1A';
    return 'var(--card)';
  };

  return (
    <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      {/* header */}
      <div style={{
        flexShrink: 0, padding: '16px 16px 14px', borderBottom: '3px solid #0C0C10',
        background: 'var(--card)',
      }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.18em', color: '#0C0C10', opacity: .55 }}>RANKINGS</div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 22, color: '#0C0C10', lineHeight: 1, marginTop: 2 }}>THE BOARD</div>
      </div>

      {/* tabs */}
      <div style={{ display: 'flex', borderBottom: '3px solid #0C0C10', flexShrink: 0 }}>
        <div style={tabStyle(boardTab === 'daily')} onClick={onTabDaily}>DAILY</div>
        <div style={{ ...tabStyle(boardTab === 'all'), borderLeft: 'none' }} onClick={onTabAll}>ALL TIME</div>
      </div>

      {/* rows */}
      <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map(row => (
          <div key={row.rank} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '12px 13px',
            border: '3px solid #0C0C10',
            background: row.you ? '#FFD51F' : 'var(--card)',
            boxShadow: row.you ? '5px 5px 0 #FF3BBD' : '4px 4px 0 #0C0C10',
          }}>
            <div style={{
              width: 34, height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '3px solid #0C0C10', background: medalColor(row.rank),
              fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10',
            }}>{row.rank}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, fontWeight: 700, color: '#0C0C10', display: 'flex', alignItems: 'center', gap: 6 }}>
                {row.handle}
                {row.you && <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, background: '#0C0C10', color: '#FFD51F', padding: '1px 5px' }}>YOU</span>}
              </div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color: '#0C0C10', opacity: .55, marginTop: 2 }}>{row.finds} finds</div>
            </div>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 16, color: '#0C0C10', textAlign: 'right' }}>{row.won}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
