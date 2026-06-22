import { ZONES, SPEC9 } from '../data/gameData';

function ZonePreview({ zone }) {
  return (
    <div style={{ width: '100%', height: 64, display: 'flex', flexWrap: 'wrap', gap: 2, padding: 4 }}>
      {Array.from({ length: 18 }).map((_, i) => {
        const r = (i * 17 + zone.id.charCodeAt(0)) % 100;
        const color = r < 40 ? '#0C0C10' : r < 60 ? zone.accent : r < 75 ? 'var(--card)' : r < 88 ? '#FFD51F' : '#FF3BBD';
        return <div key={i} style={{ width: 10, height: 10, background: color, flex: 'none' }} />;
      })}
    </div>
  );
}

export default function ZoneScreen({ state, onGoHome, onEnterZone }) {
  const { energy, energyMax } = state;

  return (
    <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      {/* header */}
      <div style={{
        flexShrink: 0, padding: '16px 16px 14px', borderBottom: '3px solid #0C0C10',
        background: 'var(--card)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div
            onClick={onGoHome}
            style={{
              width: 34, height: 34, background: '#FFD51F', border: '3px solid #0C0C10',
              boxShadow: '3px 3px 0 #0C0C10', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10', cursor: 'pointer',
            }}
          >L</div>
          <div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.18em', color: '#0C0C10', opacity: .55 }}>PICK A GRID</div>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 20, color: '#0C0C10', lineHeight: 1, marginTop: 2 }}>THE WORLD</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, color: '#0C0C10' }}>⚡ {energy}/{energyMax}</div>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, color: '#0C0C10', opacity: .5, marginTop: 3 }}>YOUR ENERGY</div>
        </div>
      </div>

      {/* zone cards */}
      <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {ZONES.map(zone => (
          <div
            key={zone.id}
            onClick={() => onEnterZone(zone.id)}
            style={{ border: '3px solid #0C0C10', background: 'var(--card)', boxShadow: '5px 5px 0 #0C0C10', padding: 14, display: 'flex', flexDirection: 'column', gap: 12, cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', gap: 13, alignItems: 'stretch' }}>
              <div style={{ width: 84, flexShrink: 0, border: '2px solid #0C0C10', background: 'var(--deep)', padding: 5, display: 'flex', alignItems: 'center' }}>
                <ZonePreview zone={zone} />
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10', lineHeight: 1 }}>{zone.name}</div>
                  <div style={{
                    fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700,
                    letterSpacing: '.12em', color: '#0C0C10', background: zone.accent,
                    border: '2px solid #0C0C10', padding: '2px 6px', whiteSpace: 'nowrap',
                  }}>{zone.tag}</div>
                </div>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 12, color: '#0C0C10', opacity: .7, marginTop: 6, lineHeight: 1.4 }}>{zone.blurb}</div>
                <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
                  <div>
                    <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 16, color: '#0C0C10' }}>{zone.loot}</div>
                    <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: '#0C0C10', opacity: .5 }}>LIVE LOOT</div>
                  </div>
                  <div>
                    <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 16, color: '#0C0C10' }}>{zone.hunters}</div>
                    <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: '#0C0C10', opacity: .5 }}>HUNTERS</div>
                  </div>
                </div>
              </div>
            </div>
            <div style={{ height: 6, background: zone.accent, border: '2px solid #0C0C10' }} />
          </div>
        ))}
      </div>
    </div>
  );
}
