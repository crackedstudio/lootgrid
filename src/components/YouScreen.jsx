import { PROFILE_FINDS } from '../data/gameData';
import { IconSvg } from './Mascot';

const ICON_PATHS = {
  found:  ['M12 2 L15.09 8.26 L22 9.27 L17 14.14 L18.18 21.02 L12 17.77 L5.82 21.02 L7 14.14 L2 9.27 L8.91 8.26 Z'],
  clue:   ['M21 10 C21 17 12 23 12 23 C12 23 3 17 3 10 C3 6.13 7.02 3 12 3 C16.97 3 21 6.13 21 10 Z', 'M12 7 L12 13', 'M12 16 L12 17'],
  puzzle: ['M12 3 L20 7 L20 17 L12 21 L4 17 L4 7 Z', 'M12 8 L16 10 L12 12 L8 10 Z'],
};

export default function YouScreen({ state }) {
  const handle = state?.player?.handle ?? '@…';
  const energy = state?.energy ?? { value: 0, max: 12 };

  return (
    <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      {/* profile header */}
      <div style={{ flexShrink: 0, padding: '20px 16px 16px', borderBottom: '3px solid #0C0C10', background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 54, height: 54, border: '3px solid #0C0C10', background: '#FFD51F', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Archivo Black', sans-serif", fontSize: 22, color: '#0C0C10', boxShadow: '4px 4px 0 #0C0C10' }}>
            @
          </div>
          <div>
            {/* Real handle from the server session. */}
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 20, color: '#0C0C10', lineHeight: 1 }}>{handle}</div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color: '#0C0C10', opacity: .55, marginTop: 4 }}>HUNTER</div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 20, color: '#0C0C10' }}>⚡ {energy.value}/{energy.max}</div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, color: '#0C0C10', opacity: .5, marginTop: 2 }}>ENERGY</div>
          </div>
        </div>

        {/* stats row */}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          {[['141', 'FINDS'], ['$642', 'WON'], ['9', 'XP SOLVES']].map(([val, lbl]) => (
            <div key={lbl} style={{ flex: 1, border: '2px solid #0C0C10', padding: '10px 8px', textAlign: 'center' }}>
              <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 18, color: '#0C0C10' }}>{val}</div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: '#0C0C10', opacity: .5, marginTop: 3 }}>{lbl}</div>
            </div>
          ))}
        </div>
      </div>

      {/* activity feed */}
      <div style={{ flex: 1, padding: '16px 16px 24px' }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: 'var(--cream)', opacity: .55, marginBottom: 14 }}>RECENT ACTIVITY</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {PROFILE_FINDS.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 13px', border: '3px solid #0C0C10', background: 'var(--card)', boxShadow: '4px 4px 0 #0C0C10' }}>
              <div style={{
                width: 40, height: 40, flexShrink: 0, border: '3px solid #0C0C10', background: f.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <IconSvg paths={ICON_PATHS[f.type] || ICON_PATHS.found} color={f.type === 'found' ? '#0C0C10' : '#F5EFE3'} strokeWidth={2.4} size={18} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 12, fontWeight: 700, color: '#0C0C10' }}>{f.label}</div>
                <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color: '#0C0C10', opacity: .5, marginTop: 3 }}>{f.meta}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
