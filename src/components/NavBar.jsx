import { IconSvg } from './Mascot';

/*
  ─────────────────────────── four tabs, not six ───────────────────────────

  The design shipped MAP · CREATE · BOARD · YOU. We had added MARKET and AGENT,
  which cost us in two ways: six tabs on a 360px phone squeezes every label to
  8px, and two of the six are places a new player has no reason to stand.

  AGENT in particular is the layer PLAIN_BRIEFING_V4.md explicitly says is "not
  something to put in front of someone who opened MiniPay to check their
  balance." It is a good story and a bad first impression, so it lives behind
  YOU now rather than on the bar.

  MARKET stays reachable the same way. Neither screen is deleted and neither
  route changed — see YouScreen, which links to both. `NAV_VIEWS` still lists
  every view the bar should remain visible on, so navigating into MARKET from
  YOU does not make the bar vanish underneath you.
*/
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

/**
 * Views the bar stays visible on. Wider than NAV_ITEMS on purpose: market and
 * agent no longer have a tab, but they are still app screens and stranding a
 * player on one with no way back would be worse than the crowding we just fixed.
 */
const NAV_VIEWS = ['map', 'market', 'agent', 'hunts', 'board', 'you'];

export default function NavBar({ view, onNav }) {
  if (!NAV_VIEWS.includes(view)) return null;

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
            className="lg-press"
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
            {/* Four tabs leave room for type that can actually be read. */}
            <div style={{
              fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
              letterSpacing: '.1em', color: isActive ? '#FFD51F' : '#0C0C10',
            }}>{item.label}</div>
          </div>
        );
      })}
    </div>
  );
}
