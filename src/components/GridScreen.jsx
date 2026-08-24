import { useEffect, useRef, useState } from 'react';
import AgentZoneBar from './AgentZoneBar';
import { candidates, describe, reliabilityPct, tierLabel } from '../api/hints';
import Coach from './Coach';
import MapLife from './MapLife';
import { useCharacterSim } from '../hooks/useCharacterSim';
import { Coin, CoverDome, Dome, HuntTile, LockIcon, TypeGlyph } from './TileArt';

const TILE_SIZE = 54;
const GAP = 8;

/**
 * What the bar buys, in the units the header prints.
 *
 * Mirrors the costs the server enforces (see useGameState). Kept here so the
 * legend cannot quietly drift from the notches drawn on the bar — if a cost
 * changes, both move together or neither does.
 */
const DIG_COST = 2;
const SURVEY_COST = 6;
const REGEN_MINUTES = 6;

/** Stable empty list, so the crowd sim is not handed a fresh array every render. */
const EMPTY_TARGETS = [];

/**
 * Survey readings, coldest to warmest.
 *
 * A deliberate ramp rather than the tile-type palette: a reading describes the
 * ground around a cell, not what is under it, and the two must not be confused
 * at a glance.
 */
const BAND_COLORS = {
  burning: '#FF3D3D',
  hot:     '#FF7A1A',
  warm:    '#FFD51F',
  cool:    '#29E6E6',
  cold:    '#3A4A6A',
};

/**
 * The design's type palette, restored.
 *
 * The shipped build had mystery on #8A3DFF — the same purple as an XP hunt
 * dome — and puzzle on lime. The design separates them: puzzle *is* the purple
 * family (a puzzle tile and an XP hunt are the same kind of thing), and mystery
 * gets pink, which nothing else on the board uses.
 *
 * `empty` is not listed: an emptied tile is drawn as turned earth, not as a
 * coloured card. See TileCell.
 */
/**
 * The walkthrough's marker colour.
 *
 * Deliberately not any of `TYPE_COLORS` below. It was cyan, which is also what
 * a `clue` tile fills with — so the first thing the walkthrough teaches you to
 * dig turned solid cyan directly beside a cyan-ringed target, and the finished
 * tile was the louder of the two. A marker has to be a colour the board cannot
 * produce on its own.
 */
const MARK = '#2CE66A';

const TYPE_COLORS = {
  clue:    '#29E6E6',
  trap:    '#FF3D3D',
  mystery: '#FF3BBD',
  puzzle:  '#8A3DFF',
  found:   '#FFD51F',
};

/**
 * The ink each glyph is drawn in, once the tile is open. Clue is the only
 * light-backed type, so it is the only one that takes dark ink.
 */
const GLYPH_INK = {
  clue: '#0C0C10',
  empty: 'rgba(12,12,16,.3)',
};

/**
 * A tile, drawn the way LOOTGRID.dc.html draws it.
 *
 * Four states, and each one is a different *object* rather than a different
 * fill: undug ground is a mound, a live hunt is a lit dome wearing a padlock
 * and a price ribbon, an opened find is a coin in a hole, and an ordinary
 * reveal is a flat card carrying its type glyph.
 *
 * `justOpened` drives the entrance animation and is true only for a tile this
 * session uncovered, so the board does not re-animate itself every time React
 * re-renders it. `digging` is true while the open request is in flight — the
 * tile sits pressed into the ground until the server says what was under it,
 * which is the visible half of the optimistic dig.
 */
function TileCell({ cell, onClick, dimmed, survey, pointed, justOpened, digging }) {
  const { opened, hunt, reveal } = cell;

  let style = {
    background: '#3A2A1E',
    boxShadow: '4px 5px 0 #0C0C10',
    backgroundImage: 'repeating-linear-gradient(45deg, rgba(12,12,16,.16) 0 3px, transparent 3px 8px)',
  };
  let inner = <CoverDome />;

  if (digging && !opened) {
    // Pressed in and shadowless: the mound has been struck and is waiting to
    // give. Costs nothing, and it is the only thing on screen between the tap
    // and the answer.
    style = { ...style, boxShadow: 'none', transform: 'translate(3px, 4px) scale(.95)', filter: 'brightness(.8)' };
  }

  if (hunt) {
    const isCash = hunt.kind === 'cash';
    // A live hunt bobs. It is the only thing on the board that moves, which is
    // how you find one without reading anything.
    style = {
      background: isCash ? '#1A1820' : '#241833',
      boxShadow: '4px 6px 0 #0C0C10',
      animation: `lg-bob ${isCash ? 1.9 : 2.3}s ease-in-out infinite`,
    };
    inner = (
      <HuntTile tag={hunt.prizeLabel} tagColor={isCash ? '#FFD51F' : '#C79BFF'}>
        <Dome color={isCash ? '#FFD51F' : '#8A3DFF'} spectrum={isCash} icon={<LockIcon />} />
      </HuntTile>
    );
  } else if (opened) {
    const anim = justOpened ? 'lg-thwack .32s ease-out' : undefined;
    if (reveal.type === 'found') {
      style = { background: '#1A1820', boxShadow: '4px 6px 0 #0C0C10', animation: anim };
      inner = <Dome color="#FFD51F" icon={<Coin color="#FFD51F" size={22} />} />;
    } else if (reveal.type === 'empty') {
      // Dug earth reads light, not black. An emptied tile should look spent —
      // turned over and finished with — rather than like a hole in the screen.
      style = {
        background: '#EFE8DA', boxShadow: 'none',
        borderColor: 'rgba(12,12,16,.45)', animation: anim,
      };
      inner = <TypeGlyph type="empty" color={GLYPH_INK.empty} />;
    } else {
      style = { background: TYPE_COLORS[reveal.type] || '#FFFAF4', boxShadow: '4px 4px 0 #0C0C10', animation: anim };
      inner = <TypeGlyph type={reveal.type} color={GLYPH_INK[reveal.type] ?? '#F5EFE3'} />;
    }
  }

  return (
    <div
      className="lg-press"
      data-mark={pointed ? '1' : undefined}
      onClick={() => onClick(cell)}
      title={
        [opened ? reveal.type : null, survey ? `survey: ${survey.band}` : null]
          .filter(Boolean)
          .join(' · ') || undefined
      }
      style={{
        width: TILE_SIZE, height: TILE_SIZE,
        border: '3px solid #0C0C10',
        // The tutorial's pointer wins over the tile's own border, because an
        // instruction you cannot pick out of the board is not an instruction.
        // The border alone was legible but inert; `lg-tilepulse` below is what
        // makes the eye go there.
        ...(pointed ? { border: `3px solid ${MARK}`, zIndex: 2 } : null),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Always a pointer: even an opened tile can be surveyed.
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0, userSelect: 'none',
        // Ruled out by an active hint. Dimmed rather than blocked: the hint may
        // be lying, and a player who wants to dig here must stay free to.
        opacity: dimmed ? 0.25 : 1,
        ...style,
      }}
    >
      {inner}
      {/* The walkthrough's pulse. Its own element so it composes with the
          tile's drop shadow, dig press and hunt bob instead of replacing
          whichever of them is currently set. */}
      {pointed && <span className="lg-tilepulse" />}
      {survey && (
        /* A reading describes the ground around this cell, not what is under
           it — so it sits in the corner rather than filling the tile.

           Letter as well as colour: the warm three quarters of this ramp are
           red/orange/yellow, which is the exact triad a red-green deficiency
           collapses, and this pip is the output of the game's core mechanic. */
        <div style={{
          position: 'absolute', top: 2, right: 2,
          width: 12, height: 12,
          background: BAND_COLORS[survey.band] || BAND_COLORS.cold,
          border: '1px solid #0C0C10', zIndex: 3,
          fontFamily: "'Archivo Black', sans-serif", fontSize: 8, lineHeight: '10px',
          textAlign: 'center', color: '#0C0C10',
        }}>{String(survey.band)[0].toUpperCase()}</div>
      )}
    </div>
  );
}

/**
 * One tile in the whole-map view. A few pixels across, so colour is the only
 * language available and every choice here has to earn its place.
 *
 * Priority order matters: a hunt outranks a reveal outranks a survey reading
 * outranks hint candidacy. What you are looking for beats where you have been.
 */
/**
 * Prices are shown in cents at these amounts, not dollars.
 *
 * "$0.05" reads as a rounding error; "5c" reads as a price. The review's own
 * guidance goes further — anchor to a data bundle or a bus fare in local
 * currency — which needs a currency the server does not yet know.
 */
function formatPrice(cents) {
  return cents < 100 ? `${cents}\u00A2` : `$${(cents / 100).toFixed(2)}`;
}

/** "4:12" / "0:09" — the short form, for a countdown that is always on screen. */
function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "3H 20M" / "8M". A bar that returns in four hours has to say so. */
function formatWait(ms) {
  if (!ms || ms <= 0) return 'READY';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}M`;
  return `${Math.floor(mins / 60)}H ${mins % 60}M`;
}

function OverviewCell({ cell, survey, candidate, pointed, onClick }) {
  const { opened, hunt, reveal } = cell;

  let bg = '#3A2A1E';
  if (candidate) bg = '#5A4A28';
  if (survey) bg = BAND_COLORS[survey.band] ?? bg;
  // An opened `empty` has no entry in the palette on purpose — at this size it
  // reads as spent ground, the pale counterpart to the undug brown around it.
  if (opened) bg = TYPE_COLORS[reveal.type] ?? '#EFE8DA';
  if (hunt) bg = hunt.kind === 'cash' ? '#FFD51F' : '#8A3DFF';

  return (
    <div
      onClick={onClick}
      style={{
        // A pointed cell is filled, not outlined. A cell here is about six
        // pixels wide; a 2px ring inside one is a rendering artefact rather
        // than a mark. The thing that actually makes it findable is the beacon
        // drawn over the grid — see `lg-beacon` — and this is what that beacon
        // is pointing AT once the eye arrives.
        // Lime, not cyan. `TYPE_COLORS.clue` is #29E6E6 — the same cyan the
        // marker used — so the tile you had just dug filled solid cyan right
        // next to a cyan-ringed target, and the brighter of the two was the one
        // you were finished with. Lime appears nowhere in the tile palette.
        background: pointed ? MARK : bg,
        cursor: 'pointer',
      }}
    />
  );
}

export default function GridScreen({ state, onBackZones, onTile, onToggleSurvey, onDismissStuck, onBuy, onSpendRefill, onAckTutorial }) {
  const {
    grid, energy, showToast, toastText, zones, mapZone,
    hints = [], surveys = {}, surveyMode = false, stuck = null, shop = null, keys = null,
    floats = [], justOpened = {}, digging = {},
  } = state;


  const refillItem = shop?.catalogue?.find(i => i.sku === 'refill') ?? null;
  const refillsBanked =
    shop?.entitlements?.find(e => e.kind === 'refillCredits')?.remaining ?? 0;
  const zone = zones.find(z => z.id === mapZone);

  // Which hints the player is currently trusting. View state, not game state —
  // the server neither knows nor cares which ones you believe.
  const [active, setActive] = useState(() => new Set());

  // Navigate in the overview, play in the dig view. See the note by the grid.
  const [view, setView] = useState('overview');
  const [focus, setFocus] = useState(null);
  const digRef = useRef(null);

  // The tutorial's current step, if there is one. Pointed at in both views —
  // an instruction you cannot find on the map is not an instruction.
  const pointer = state.grid?.tutorial?.step ?? null;

  /*
    Put the player in the mode the current step is asking for.

    Found by walking the script: step 3 turns Survey on, and step 5 then says
    "both of them point here, dig it" — with Survey still on. A player who obeys
    literally surveys the treasure instead of digging it, at 6⚡ a tap, and the
    step never advances because a survey is not a dig. The board gives no sign
    anything is wrong; the coach just keeps repeating itself while the bar
    empties.

    Keyed on the step id rather than run on every render, so it fires once when
    the instruction changes and never fights a player who deliberately toggles
    the mode mid-step.
  */
  const modeSyncedFor = useRef(null);
  useEffect(() => {
    if (!pointer || modeSyncedFor.current === pointer.id) return;
    modeSyncedFor.current = pointer.id;
    const wantsSurvey = pointer.action === 'survey';
    if (wantsSurvey !== surveyMode) onToggleSurvey();
  }, [pointer, surveyMode, onToggleSurvey]);

  /*
    Park the walkthrough's target where the walkthrough can be read at the same
    time.

    The coach panel is anchored to the bottom and is tall — it has a paragraph
    in it — so it covers roughly the lower half of the board. "Tap the green
    tile" while sitting on top of the green tile is the same dead end as not
    marking it at all: the instruction is on screen, the thing it refers to is
    not, and there is nothing to tell you to scroll.

    So the target is scrolled to a third of the way down the viewport rather
    than the middle, which is the part of the board the panel never reaches.
  */
  useEffect(() => {
    if (view !== 'dig' || pointer?.r == null || pointer?.c == null) return;

    /*
      Scroll by asking the marked tile where it is, and keep asking until it
      exists.

      The obvious version — compute row × stride and assign scrollTop on the
      next animation frame — does not survive this component. StrictMode
      double-invokes the effect, so the cleanup cancels the pending frame
      before it runs, and the scroll silently never happens. Retrying against
      the real element sidesteps the whole question of which frame the 3,600
      tiles finish laying out on, and it cannot be defeated by an extra
      mount/unmount cycle.
    */
    let tries = 0;
    const timer = setInterval(() => {
      const box = digRef.current;
      const el = box?.querySelector('[data-mark="1"]');
      if (box && el) {
        // Moved by a delta on this container only, rather than with
        // `scrollIntoView` — which also scrolls every ancestor, and here it
        // scrolled the page far enough to tuck the tile up behind the header.
        const a = el.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        // Near the top of the board area, not centred: the coach panel is
        // anchored to the bottom and covers the lower half, so a centred tile
        // is a tile behind the instruction telling you to tap it.
        box.scrollTop += a.top - b.top - 16;
        box.scrollLeft += a.left - b.left - (box.clientWidth / 2 - TILE_SIZE / 2);
        clearInterval(timer);
      } else if (++tries > 20) {
        clearInterval(timer);
      }
    }, 50);
    return () => clearInterval(timer);
  }, [view, pointer?.r, pointer?.c]);

  // Jump the dig view to whatever was tapped on the overview. Without this,
  // switching views drops you at the top-left corner of a 3,240px board, which
  // is the problem the overview exists to solve.
  useEffect(() => {
    if (view !== 'dig' || !focus || !digRef.current) return;
    const el = digRef.current;
    const step = TILE_SIZE + GAP;
    el.scrollTo({
      left: Math.max(0, focus.c * step - el.clientWidth / 2 + TILE_SIZE / 2),
      top: Math.max(0, focus.r * step - el.clientHeight / 2 + TILE_SIZE / 2),
      behavior: 'instant',
    });
  }, [view, focus]);
  const toggle = id =>
    setActive(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /*
    The crowd, and the two events it reacts to.

    Only runs in the dig view: at overview zoom a tile is six pixels across and
    a 21px sprite would be a blob sitting on forty of them. Targets are the
    live hunts, so an idle hunter occasionally breaks into a run at one — which
    is how the map tells you a treasure is live over there without printing a
    notification at you.

    Called above the `!grid` guard and defaulted, because a hook that runs only
    once the grid has loaded is a hook that changes the hook count between
    renders — which React treats as a crash, not a preference.
  */
  const { cast, scatterFrom } = useCharacterSim({
    enabled: view === 'dig' && !!grid,
    scrollRef: digRef,
    tileSize: TILE_SIZE,
    gap: GAP,
    rows: grid?.rows ?? 0,
    cols: grid?.cols ?? 0,
    targets: grid?.hunts ?? EMPTY_TARGETS,
  });

  if (!grid) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface)', fontFamily: "'Space Mono', monospace",
        fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .6,
      }}>
        LOADING GRID…
      </div>
    );
  }

  // Cells are derived from what the server told us: a live hunt, an uncovered
  // reveal, or fog. Anything absent from the payload stays fog — the client has
  // no way to know what is under it.
  const huntAt = new Map(grid.hunts.map(h => [`${h.r},${h.c}`, h]));
  const cells = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const key = `${r},${c}`;
      const reveal = grid.reveals[key];
      cells.push({ id: key, r, c, reveal, opened: !!reveal, hunt: huntAt.get(key) });
    }
  }

  // The most recent survey reading, so the step that explains the scale can
  // show the player where THEY landed on it rather than describing it in the
  // abstract — they have just paid six energy for that number.
  const latestReading = Object.values(surveys).reduce(
    (newest, r) => (!newest || r.at > newest.at ? r : newest),
    null,
  );

  /*
    Dig, and get out of the way.

    The scatter fires on the tap rather than on the response: it is feedback
    about the swing, not about what was under the tile, and making the world
    flinch a round-trip after the spade lands would be worse than not doing it.
  */
  const handleTile = cell => {
    if (!surveyMode && !cell.opened && !cell.hunt) scatterFrom(cell.r, cell.c);
    onTile(cell);
  };

  // Hints for this zone only — one from another map tells you nothing here.
  const zoneHints = hints.filter(h => h.zoneId === mapZone);
  const activePayloads = zoneHints.filter(h => active.has(h.id)).map(h => h.payload);
  // Intersecting is the game: one hint is weak and might be a lie, several that
  // agree are worth digging on. An empty set means they contradict each other,
  // which is information too — at least one of them is false.
  const candidateSet = activePayloads.length ? candidates(activePayloads, grid.rows, grid.cols) : null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)', overflow: 'hidden', position: 'relative' }}>
      {/*
        Above the header on purpose. Walking into a lattice IS the moment a
        player decides whether their agent should work it; routing that decision
        through the AGENT tab and back is three screens for one choice. Renders
        nothing outside an agent zone.
      */}
      <AgentZoneBar zone={zone} />

      {/*
        header — two rows, not one.

        It was one row of six things (back, zone name, view toggle, dig/survey
        toggle, energy, keys) inside a 390px frame, and it overflowed: the
        energy readout was clipped and the keys chip sat 52px past the right
        edge, entirely off screen. Which meant the walkthrough's "your keys, top
        right" pointed at nothing, and a player checking whether they could
        afford a survey could not read the number.

        Identity and meters on top, controls beneath. The meters are the thing
        you read while deciding, and the controls are the thing you press after
        — so they do not need to share a line, and on this width they cannot.
      */}
      <div style={{
        flexShrink: 0, padding: '12px 14px 10px', borderBottom: '3px solid #0C0C10',
        background: 'var(--card)', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <div onClick={onBackZones} style={{
            width: 34, height: 34, background: '#FFD51F', border: '3px solid #0C0C10',
            boxShadow: '3px 3px 0 #0C0C10', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontFamily: "'Archivo Black', sans-serif",
            fontSize: 15, color: '#0C0C10', cursor: 'pointer',
          }}>←</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: '#0C0C10', opacity: .55 }}>HUNTING IN</div>
            <div style={{
              fontFamily: "'Archivo Black', sans-serif", fontSize: 16, color: '#0C0C10',
              lineHeight: 1, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {zone?.name ?? '…'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          {/*
            A bar and a number, not one pip per point. The pip row was written
            for a 12-point bar; at 40 it is ~680px and runs off the side of
            every phone this is built for.

            `lg-flash` when the walkthrough is pointing here. An instruction
            that names a thing on screen has to be able to make it findable, or
            "the bar, top left" is a puzzle rather than a direction.
          */}
          <div
            className={pointer?.highlight === 'energy' ? 'lg-flash' : undefined}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}
          >
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, color: '#0C0C10', opacity: .75 }}>
              ENERGY {energy.value}/{energy.max}
            </div>
            {/*
              Segmented by what a dig costs, not by the point.

              "20 of 40" is a number you have to divide before it means
              anything; a row of dig-shaped notches is a number you can count.
              The bar is the same width either way — the notches are drawn over
              the fill rather than beside it.
            */}
            <div style={{
              width: 92, height: 14, border: '2px solid #0C0C10', background: '#0C0C10',
              position: 'relative', overflow: 'hidden',
            }}>
              <div style={{
                width: `${Math.round((energy.value / Math.max(1, energy.max)) * 100)}%`,
                height: '100%', background: '#FFD51F',
                transition: 'width .2s cubic-bezier(.2,.8,.2,1)',
              }} />
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', pointerEvents: 'none',
              }}>
                {Array.from({ length: Math.floor(energy.max / DIG_COST) }).map((_, i) => (
                  <div key={i} style={{
                    flex: 1,
                    borderRight: i === Math.floor(energy.max / DIG_COST) - 1
                      ? 'none' : '1px solid rgba(12,12,16,.35)',
                  }} />
                ))}
              </div>
            </div>
            {/*
              When the next point lands.

              The countdown was already being ticked in state and shown nowhere
              — so a player at 4⚡ could not tell whether the next dig was thirty
              seconds or half an hour away, and "leave" is the safe answer to a
              question you cannot see. Costs nothing to answer it.
            */}
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, color: '#0C0C10', opacity: .55 }}>
              {energy.value >= energy.max ? 'FULL' : `+1 IN ${formatCountdown(energy.nextRegenMs)}`}
            </div>
          </div>

          {/*
            Keys, beside energy and never anywhere else.

            The two currencies are shown together because the boundary between
            them is the design: energy is the product and can be bought, keys
            are entries and cannot be, by anyone, at any price. Split across two
            screens that is a rule in a FAQ; side by side it is a fact about the
            game.
          */}
          {keys && (
            <div
              className={pointer?.highlight === 'keys' ? 'lg-flash' : undefined}
              title="Entries into cash hunts. Five a day, and nothing buys more."
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}
            >
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, color: '#0C0C10', opacity: .5 }}>
                KEYS
              </div>
              <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10', lineHeight: 1 }}>
                {keys.remaining}/{keys.perDay}
              </div>
            </div>
          )}
        </div>
      </div>

      {/*
        Row two: the two things a tap does.

        Which action a tap performs has to be readable before the tap — six
        energy is an expensive surprise — so the mode toggle says what it costs
        and is sized to be pressed rather than squeezed in beside a meter.
      */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          onClick={() => setView(v => (v === 'overview' ? 'dig' : 'overview'))}
          style={{
            flex: 1, textAlign: 'center',
            padding: '7px 9px', background: 'transparent',
            border: '3px solid #0C0C10',
            fontFamily: "'Archivo Black', sans-serif", fontSize: 11,
            color: '#0C0C10', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {view === 'overview' ? 'DIG VIEW' : 'WHOLE MAP'}
        </div>

        <div
          onClick={onToggleSurvey}
          className={pointer?.highlight === 'survey' && !surveyMode ? 'lg-flash' : undefined}
          style={{
            flex: 1, textAlign: 'center',
            padding: '7px 9px',
            background: surveyMode ? '#29E6E6' : 'transparent',
            border: '3px solid #0C0C10',
            boxShadow: surveyMode ? '3px 3px 0 #0C0C10' : 'none',
            fontFamily: "'Archivo Black', sans-serif", fontSize: 11,
            color: '#0C0C10', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {surveyMode ? 'SURVEY 6\u26A1' : 'DIG 2\u26A1'}
        </div>
      </div>

      {/*
        The economy, in one line, permanently.

        The design carried this and we dropped it: what a point buys and how
        fast points come back are the two facts every decision on this screen
        depends on, and neither was written down anywhere in the build. A
        player who has to infer the regen rate from watching the bar is a
        player who closes the app to find out.
      */}
      <div style={{
        fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
        color: '#0C0C10', opacity: .6, letterSpacing: '.02em',
      }}>
        {DIG_COST}⚡ DIG · {SURVEY_COST}⚡ SURVEY · 2–3⚡ ENTER · +1 PER {REGEN_MINUTES}MIN
      </div>
      </div>

      <div style={{ height: 4, background: zone?.accent ?? '#FF7A1A', flexShrink: 0 }} />

      {/*
        ─────────────────────────── the clue band ───────────────────────────

        The design gave the game's central mechanic a headline: a compass, a
        kicker, and one readable sentence saying where to go. We had replaced it
        with a horizontally-scrolling rail of 9px chips, each one `nowrap` and
        ellipsised — so the actual content of the deduction, the part the player
        is here to do, was the part being clipped.

        Two rows now. The band on top states the conclusion: how many cells are
        still standing, and what the trusted hints actually say, at a size that
        can be read while walking. The chips underneath keep what the design
        never had — published reliability, and the ability to doubt a hint by
        tapping it off.
      */}
      {zoneHints.length > 0 && (
        <div
          className={pointer?.highlight === 'hints' ? 'lg-flash' : undefined}
          style={{ flexShrink: 0, background: '#0C0C10', borderBottom: '3px solid #0C0C10' }}
        >
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 11, padding: '10px 12px 9px' }}>
            {/* The conclusion, at headline scale. This number is the whole
                point of holding hints and it was set at 9px. */}
            <div style={{
              flexShrink: 0, minWidth: 58, background: activePayloads.length ? '#29E6E6' : '#1A1815',
              border: '3px solid #0C0C10',
              boxShadow: activePayloads.length ? '3px 3px 0 #0C0C10' : 'none',
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', padding: '4px 6px',
            }}>
              <div style={{
                fontFamily: "'Archivo Black', sans-serif", fontSize: 22, lineHeight: 1,
                color: activePayloads.length ? '#0C0C10' : 'var(--cream)',
              }}>
                {candidateSet ? candidateSet.size : zoneHints.length}
              </div>
              <div style={{
                fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
                letterSpacing: '.1em', marginTop: 3,
                color: activePayloads.length ? '#0C0C10' : 'var(--cream)',
                opacity: activePayloads.length ? .7 : .55,
              }}>
                {candidateSet ? 'LEFT' : 'HELD'}
              </div>
            </div>

            {/* What the trusted hints say, in full and wrapped. */}
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{
                fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
                letterSpacing: '.12em', color: '#FFD51F', opacity: .8,
              }}>
                {activePayloads.length
                  ? `TRUSTING ${activePayloads.length} OF ${zoneHints.length}`
                  : 'NOTHING TRUSTED YET'}
              </div>
              <div style={{
                fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600,
                lineHeight: 1.3, color: 'var(--cream)', marginTop: 4,
              }}>
                {activePayloads.length
                  ? activePayloads.map(p => describe(p)).join(' · ')
                  : 'Tap a hint below to trust it. The map narrows to what your hints agree on.'}
              </div>
            </div>
          </div>

          <div style={{
            display: 'flex', gap: 8, overflowX: 'auto', alignItems: 'stretch',
            padding: '0 12px 10px',
          }}>
            {zoneHints.map(h => {
              const on = active.has(h.id);
              const pct = reliabilityPct(h);
              return (
                <div
                  key={h.id}
                  onClick={() => toggle(h.id)}
                  className="lg-press"
                  title={`${tierLabel(h.tier)} · about ${pct}% of these are true`}
                  style={{
                    flexShrink: 0, cursor: 'pointer', padding: '6px 9px',
                    background: on ? '#FFD51F' : '#1A1815',
                    border: `2px solid ${on ? '#FFD51F' : '#3A352C'}`,
                    color: on ? '#0C0C10' : 'var(--cream)',
                    fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
                    lineHeight: 1.3, maxWidth: 210,
                  }}
                >
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {describe(h.payload)}
                  </div>
                  {/* The odds, always visible. A sharp hint is close to a coin
                      flip and the player is entitled to know before digging. */}
                  <div style={{ opacity: .7, fontSize: 11, letterSpacing: '.04em', marginTop: 2 }}>
                    {tierLabel(h.tier).toUpperCase()} · {pct}%
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {candidateSet?.size === 0 && (
        <div style={{
          flexShrink: 0, padding: '7px 12px', background: '#FF3D3D',
          fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
          color: '#0C0C10', letterSpacing: '.06em',
        }}>
          THESE HINTS CONTRADICT — AT LEAST ONE IS LYING
        </div>
      )}

      {/*
        ─────────────────────────── two zoom levels ───────────────────────────

        A 60x60 board at a tappable tile size is about 3,240px across — nine
        screens wide and nine deep on the phones this is built for. The grid
        "scrolled", which is not a design: finding anything meant dragging blind
        across eighty-one screens with no idea where you had been.

        So there are two views and they do different jobs. OVERVIEW fits the
        whole map on one screen at a few pixels per tile: too small to tap, but
        it is the only place you can see where you have dug, where the hints
        point and where the treasure sheet says to look. DIG is the old board at
        full size, scrolled to wherever you tapped on the overview.

        Navigate in one, play in the other. Every map game of this size does
        this, and for the same reason.
      */}
      {view === 'overview' ? (
        <div style={{ flex: 1, overflow: 'hidden', padding: 10, display: 'flex' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
            gap: 1,
            width: '100%',
            aspectRatio: `${grid.cols} / ${grid.rows}`,
            alignSelf: 'center',
            border: '3px solid #0C0C10',
            background: '#0C0C10',
            position: 'relative',
          }}>
            {cells.map(cell => (
              <OverviewCell
                key={cell.id}
                cell={cell}
                survey={surveys[`${cell.r},${cell.c}`]}
                candidate={candidateSet !== null && candidateSet.has(`${cell.r}:${cell.c}`)}
                pointed={pointer?.r === cell.r && pointer?.c === cell.c}
                onClick={() => {
                  setFocus({ r: cell.r, c: cell.c });
                  setView('dig');
                }}
              />
            ))}

            {/*
              The beacon.

              Drawn over the grid rather than inside a cell, because a cell here
              is about six pixels: everything that fits in one is invisible
              against the other 3,599. Positioned by percentage off the same
              row/col the coach is quoting, so it cannot drift from the cell it
              marks even if the grid is resized.

              Only for steps that point at the map — the four that teach the HUD
              carry no cell, and a beacon on (null, null) would sit in the
              corner pointing at nothing.
            */}
            {pointer?.r != null && pointer?.c != null && (
              <div style={{
                position: 'absolute',
                left: `${((pointer.c + 0.5) / grid.cols) * 100}%`,
                top: `${((pointer.r + 0.5) / grid.rows) * 100}%`,
                pointerEvents: 'none',
              }}>
                <div className="lg-beacon" />
                <div className="lg-beacon lg-beacon-2" />
                <div className="lg-beacon-core" />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div ref={digRef} className="lg-scroll" style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${grid.cols}, ${TILE_SIZE}px)`,
            gap: GAP,
            padding: '18px 16px 22px',
            width: 'max-content',
          }}>
            {cells.map(cell => (
              <TileCell
                key={cell.id}
                cell={cell}
                onClick={handleTile}
                survey={surveys[`${cell.r},${cell.c}`]}
                pointed={pointer?.r === cell.r && pointer?.c === cell.c}
                dimmed={candidateSet !== null && !candidateSet.has(`${cell.r}:${cell.c}`)}
                justOpened={!!justOpened[cell.id]}
                digging={!!digging[cell.id]}
              />
            ))}
          </div>

          {/*
            The crowd. Inside the scrolled board rather than over the screen, so
            a hunter stays on the patch of map it was standing on when you
            scroll away from it. See useCharacterSim for why this is the largest
            piece of the design that had gone missing.
          */}
          <MapLife cast={cast} />

          {/*
            Cost floats, positioned in the same coordinate space as the board
            so a number rises off the tile that was actually tapped. The design
            computed these from padding + index * step; the arithmetic is
            unchanged because the grid geometry is.
          */}
          {floats.map(f => (
            <div
              key={f.id}
              style={{
                position: 'absolute', pointerEvents: 'none', zIndex: 9,
                left: 16 + f.c * (TILE_SIZE + GAP) + TILE_SIZE / 2,
                top: 18 + f.r * (TILE_SIZE + GAP) + TILE_SIZE / 2 - 12,
                transform: 'translate(-50%, 0)',
                fontFamily: "'Archivo Black', sans-serif", fontSize: 16,
                color: '#FFD51F', WebkitTextStroke: '2px #0C0C10',
                whiteSpace: 'nowrap', animation: 'lg-costfloat .75s ease-out forwards',
              }}
            >−{f.amt} ⚡</div>
          ))}
        </div>
      )}

      {/*
        ─────────────────────────── the empty bar ───────────────────────────

        The highest-intent moment in the session: someone who has been
        narrowing down a patch of map and has just been stopped. It used to be
        108 seconds of nothing — no prompt, no number, no reason to return —
        and phase 2 made it four hours, which turns a shrug into a departure.

        Two facts fix that, and neither costs the player anything: how close the
        nearest treasure is to where they were digging, and when they can dig
        again. A reason to come back, and a time to come back.

        The refill offer belongs here and does not exist yet — there is no shop
        until phase 7. This is the surface it will land on.
      */}
      {/*
        The walkthrough's current instruction.

        The server has sent a `copy` string with every step since phase 6 and
        this client read it into `pointer`, drew a ring on one tile, and threw
        the sentence away — which is why nobody ever saw a walkthrough. Below
        the stuck overlay in z-order deliberately: an empty bar is a harder
        stop than a lesson, and two panels at once is neither.
      */}
      {!stuck && (
        <Coach
          tutorial={grid.tutorial}
          surveyMode={surveyMode}
          energy={energy}
          reading={latestReading}
          onAck={onAckTutorial}
        />
      )}

      {stuck && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 70, background: 'rgba(12,12,16,.94)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 14, padding: 28,
        }}>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 22, color: 'var(--cream)', textAlign: 'center' }}>
            OUT OF ENERGY
          </div>

          {stuck.nearest && (
            <div style={{ textAlign: 'center' }}>
              <div style={{
                fontFamily: "'Archivo Black', sans-serif", fontSize: 30,
                color: BAND_COLORS[stuck.nearest.band] ?? '#FFD51F',
              }}>
                {String(stuck.nearest.band).toUpperCase()}
              </div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, color: 'var(--cream)', opacity: .55, marginTop: 4 }}>
                NEAREST TREASURE, FROM WHERE YOU LEFT OFF
              </div>
            </div>
          )}

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#FFD51F' }}>
              {formatWait(stuck.msUntilPlayable)}
            </div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, color: 'var(--cream)', opacity: .55, marginTop: 4 }}>
              UNTIL YOUR NEXT DIG
            </div>
          </div>

          {/*
            The offer, and only here.

            Never from a pop-up and never on a timer: the review is explicit
            that energy is offered when someone's bar hits empty MID-HUNT on a
            grid they have been narrowing down. That is the highest-intent
            moment in the session and it is the only one where an offer is
            help rather than interruption.

            A banked refill comes first when they have one — it is already paid
            for, and charging again for something they bought would be the kind
            of thing that loses a payer permanently.
          */}
          {refillsBanked > 0 ? (
            <div
              onClick={onSpendRefill}
              style={{
                marginTop: 6, padding: '11px 20px', background: '#29E6E6',
                border: '3px solid #0C0C10', boxShadow: '4px 4px 0 #0C0C10',
                fontFamily: "'Archivo Black', sans-serif", fontSize: 13,
                color: '#0C0C10', cursor: 'pointer',
              }}
            >
              USE A REFILL ({refillsBanked} LEFT)
            </div>
          ) : (
            refillItem && (
              <div
                onClick={() => onBuy(refillItem.sku)}
                style={{
                  marginTop: 6, padding: '11px 20px', background: '#FFD51F',
                  border: '3px solid #0C0C10', boxShadow: '4px 4px 0 #0C0C10',
                  fontFamily: "'Archivo Black', sans-serif", fontSize: 13,
                  color: '#0C0C10', cursor: 'pointer',
                }}
              >
                FILL IT NOW · {formatPrice(refillItem.priceCents)}
              </div>
            )
          )}

          <div
            onClick={onDismissStuck}
            style={{
              padding: '8px 16px', border: '2px solid rgba(245,239,227,.25)',
              fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
              color: 'var(--cream)', opacity: .7, cursor: 'pointer',
            }}
          >
            KEEP LOOKING FOR FREE
          </div>
        </div>
      )}

      {showToast && (
        <div style={{
          position: 'absolute', bottom: 70, left: '50%', transform: 'translateX(-50%)',
          background: '#0C0C10', border: '2px solid #FFD51F', padding: '8px 16px',
          fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, color: '#FFD51F',
          whiteSpace: 'nowrap', zIndex: 80, animation: 'lg-pop .2s ease-out',
        }}>{toastText}</div>
      )}
    </div>
  );
}
