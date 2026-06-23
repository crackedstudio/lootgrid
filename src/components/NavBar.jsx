import { IconSvg } from './Mascot';

const NAV_ITEMS = [
  {
    id: 'map',
    label: 'MAP',
    paths: ['M4 5 L9 7 L15 5 L20 7 L20 19 L15 17 L9 19 L4 17 Z', 'M9 7 L9 19', 'M15 5 L15 17'],
  },
  {
    id: 'hunts',
    label: 'CREATE',
    paths: ['M12 5 L12 19', 'M5 12 L19 12'],
  },
  {
    id: 'board',
    label: 'BOARD',
    paths: ['M18 20 L18 10', 'M12 20 L12 4', 'M6 20 L6 14'],
  },
  {
    id: 'you',
    label: 'YOU',
    paths: ['M20 21 C20 18.8 17.3 17 14 17 C10.7 17 8 18.8 8 21', 'M14 13 C16.2 13 18 11.2 18 9 C18 6.8 16.2 5 14 5 C11.8 5 10 6.8 10 9 C10 11.2 11.8 13 14 13 Z'],
  },
];

export default function NavBar({ view, onNav }) {
  const activeViews = ['map', 'hunts', 'board', 'you'];
  if (!activeViews.includes(view)) return null;

  return (
    <div style={{
      flexShrink: 0, borderTop: '3px solid #0C0C10', background: 'var(--card)',
      display: 'flex', paddingBottom: 'env(safe-area-inset-bottom, 0)',
    }}>
      {NAV_ITEMS.map(item => {
        const isActive = view === item.id || (item.id === 'map' && view === 'map');
        return (
          <div
            key={item.id}
            onClick={() => onNav(item.id)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', padding: '10px 0 11px', cursor: 'pointer',
              borderRight: item.id !== 'you' ? '2px solid #0C0C10' : 'none',
              background: isActive ? '#0C0C10' : 'transparent',
              gap: 4,
            }}
          >
            <IconSvg
              paths={item.paths}
              color={isActive ? '#FFD51F' : '#0C0C10'}
              strokeWidth={2.2}
              size={22}
            />
            <div style={{
              fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700,
              letterSpacing: '.12em', color: isActive ? '#FFD51F' : '#0C0C10',
            }}>{item.label}</div>
          </div>
        );
      })}
    </div>
  );
}
