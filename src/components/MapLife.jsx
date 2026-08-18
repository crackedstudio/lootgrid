import Mascot from './Mascot';

/**
 * The crowd on the board.
 *
 * Mounted once and then never re-rendered: `useCharacterSim` moves these by
 * writing `transform` onto the elements directly, because putting eleven
 * position updates a second through React would re-render the tile grid with
 * them. Everything the sim needs to find is marked with a `data-` attribute
 * rather than a class, so styling and behaviour cannot collide.
 *
 * `pointerEvents: none` throughout — the characters are scenery, and a hunter
 * standing on a tile must never be able to eat the tap meant for it.
 */
export default function MapLife({ cast }) {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
      {cast.map(c => (
        <div
          key={c.id}
          id={`lgc-${c.id}`}
          style={{
            position: 'absolute', top: 0, left: 0,
            // Sits above its own coordinate rather than beside it, so a
            // character standing on a tile looks like it is standing *on* it.
            marginLeft: -11, marginTop: -30,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            willChange: 'transform',
          }}
        >
          <div data-face style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div data-body>
              <Mascot color={c.color} mole={c.mole} size={21} />
            </div>
          </div>
          {/* Dust, shown only while digging. Three motes on staggered delays —
              cheaper and more legible at this size than a particle system. */}
          <div data-dust style={{ display: 'flex', gap: 2, height: 4, opacity: 0, transition: 'opacity .15s' }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: 3, height: 3, background: '#0C0C10',
                animation: `lg-dust .6s ease-out ${i * 0.18}s infinite`,
              }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
