import { useEffect, useRef, useState } from 'react';
import { SPEC9 } from '../data/gameData';
import { candidates, describe, reliabilityPct, tierLabel } from '../api/hints';

const TILE_SIZE = 54;
const GAP = 8;

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

const TYPE_COLORS = {
  empty:   '#0C0C10',
  clue:    '#29E6E6',
  trap:    '#FF3D3D',
  mystery: '#8A3DFF',
  puzzle:  '#B7FF3B',
  found:   '#FFD51F',
};

function TileCell({ cell, onClick, dimmed, survey, pointed }) {
  const { opened, hunt, reveal } = cell;

  let bg = '#1A1815';
  let border = '2px solid #0C0C10';
  let content = null;

  if (hunt) {
    bg = '#0C0C10';
    const isCash = hunt.kind === 'cash';
    border = `2px solid ${isCash ? '#FFD51F' : '#8A3DFF'}`;
    content = isCash ? (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexWrap: 'wrap', overflow: 'hidden' }}>
        {SPEC9.map((c, i) => <div key={i} style={{ flex: '1 0 33%', background: c, opacity: .7 }} />)}
      </div>
    ) : (
      <div style={{
        width: '100%', height: '100%',
        background: 'repeating-linear-gradient(45deg, #8A3DFF22, #8A3DFF22 4px, transparent 4px, transparent 8px)',
      }} />
    );
  } else if (opened) {
    bg = TYPE_COLORS[reveal.type] || '#0C0C10';
  }

  return (
    <div
      onClick={() => onClick(cell)}
      title={
        [opened ? reveal.type : null, survey ? `survey: ${survey.band}` : null]
          .filter(Boolean)
          .join(' · ') || undefined
      }
      style={{
        width: TILE_SIZE, height: TILE_SIZE,
        background: bg,
        // The tutorial's pointer wins over the tile's own border, because an
        // instruction you cannot pick out of the board is not an instruction.
        border: pointed ? '3px solid #29E6E6' : border,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Always a pointer: even an opened tile can be surveyed.
        cursor: 'pointer',
        position: 'relative', overflow: 'hidden',
        transition: 'transform .08s, opacity .15s',
        flexShrink: 0,
        // Ruled out by an active hint. Dimmed rather than blocked: the hint may
        // be lying, and a player who wants to dig here must stay free to.
        opacity: dimmed ? 0.25 : 1,
      }}
    >
      {content}
      {survey && (
        /* A reading describes the ground around this cell, not what is under
           it — so it sits in the corner rather than filling the tile. */
        <div style={{
          position: 'absolute', top: 2, right: 2,
          width: 10, height: 10,
          background: BAND_COLORS[survey.band] || BAND_COLORS.cold,
          border: '1px solid #0C0C10',
        }} />
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

/** "3H 20M" / "8M". A bar that returns in four hours has to say so. */
function formatWait(ms) {
  if (!ms || ms <= 0) return 'READY';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}M`;
  return `${Math.floor(mins / 60)}H ${mins % 60}M`;
}

function OverviewCell({ cell, survey, candidate, pointed, onClick }) {
  const { opened, hunt, reveal } = cell;

  let bg = '#1A1815';
  if (candidate) bg = '#2A2A18';
  if (survey) bg = BAND_COLORS[survey.band] ?? bg;
  if (opened) bg = TYPE_COLORS[reveal.type] === '#0C0C10' ? '#2E2A24' : TYPE_COLORS[reveal.type];
  if (hunt) bg = hunt.kind === 'cash' ? '#FFD51F' : '#8A3DFF';

  return (
    <div
      onClick={onClick}
      style={{
        background: bg,
        cursor: 'pointer',
        // The tutorial pointer has to be findable at this size, so it is a ring
        // rather than a tint — a tint is invisible against five other tints.
        outline: pointed ? '2px solid #29E6E6' : 'none',
        outlineOffset: pointed ? -1 : 0,
      }}
    />
  );
}

export default function GridScreen({ state, onBackZones, onTile, onToggleSurvey, onDismissStuck, onBuy, onSpendRefill }) {
  const {
    grid, energy, showToast, toastText, zones, mapZone,
    hints = [], surveys = {}, surveyMode = false, stuck = null, shop = null,
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

  // Hints for this zone only — one from another map tells you nothing here.
  const zoneHints = hints.filter(h => h.zoneId === mapZone);
  const activePayloads = zoneHints.filter(h => active.has(h.id)).map(h => h.payload);
  // Intersecting is the game: one hint is weak and might be a lie, several that
  // agree are worth digging on. An empty set means they contradict each other,
  // which is information too — at least one of them is false.
  const candidateSet = activePayloads.length ? candidates(activePayloads, grid.rows, grid.cols) : null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)', overflow: 'hidden', position: 'relative' }}>
      {/* header */}
      <div style={{
        flexShrink: 0, padding: '14px 16px 12px', borderBottom: '3px solid #0C0C10',
        background: 'var(--card)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div onClick={onBackZones} style={{
            width: 34, height: 34, background: '#FFD51F', border: '3px solid #0C0C10',
            boxShadow: '3px 3px 0 #0C0C10', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontFamily: "'Archivo Black', sans-serif",
            fontSize: 15, color: '#0C0C10', cursor: 'pointer',
          }}>←</div>
          <div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: '#0C0C10', opacity: .55 }}>HUNTING IN</div>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10', lineHeight: 1, marginTop: 2 }}>
              {zone?.name ?? '…'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/*
            Survey toggle. Digging and surveying are different actions on the
            same tile, and which one a tap performs has to be visible before
            the tap — six energy is an expensive surprise.
          */}
          <div
            onClick={() => setView(v => (v === 'overview' ? 'dig' : 'overview'))}
            style={{
              padding: '5px 9px', background: 'transparent',
              border: '3px solid #0C0C10',
              fontFamily: "'Archivo Black', sans-serif", fontSize: 10,
              color: '#0C0C10', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {view === 'overview' ? 'DIG VIEW' : 'WHOLE MAP'}
          </div>

          <div
            onClick={onToggleSurvey}
            style={{
              padding: '5px 9px',
              background: surveyMode ? '#29E6E6' : 'transparent',
              border: '3px solid #0C0C10',
              boxShadow: surveyMode ? '3px 3px 0 #0C0C10' : 'none',
              fontFamily: "'Archivo Black', sans-serif", fontSize: 10,
              color: '#0C0C10', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {surveyMode ? 'SURVEY 6\u26A1' : 'DIG 2\u26A1'}
          </div>

          {/*
            A bar and a number, not one pip per point. The pip row was written
            for a 12-point bar; at 40 it is ~680px and runs off the side of
            every phone this is built for.
          */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: '#0C0C10', opacity: .5 }}>
              ENERGY {energy.value}/{energy.max}
            </div>
            <div style={{ width: 78, height: 12, border: '2px solid #0C0C10', background: '#0C0C10' }}>
              <div style={{
                width: `${Math.round((energy.value / Math.max(1, energy.max)) * 100)}%`,
                height: '100%', background: '#FFD51F',
              }} />
            </div>
          </div>
        </div>
      </div>

      <div style={{ height: 4, background: zone?.accent ?? '#FF7A1A', flexShrink: 0 }} />

      {/* Hints. Tap to trust one and watch the map narrow; tap again to doubt it. */}
      {zoneHints.length > 0 && (
        <div style={{
          flexShrink: 0, padding: '8px 12px', background: '#0C0C10',
          borderBottom: '3px solid #0C0C10', display: 'flex', gap: 8,
          overflowX: 'auto', alignItems: 'center',
        }}>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
            letterSpacing: '.14em', color: '#FFD51F', flexShrink: 0, opacity: .8,
          }}>
            {candidateSet ? `${candidateSet.size} LEFT` : `${zoneHints.length} HINT${zoneHints.length > 1 ? 'S' : ''}`}
          </div>

          {zoneHints.map(h => {
            const on = active.has(h.id);
            const pct = reliabilityPct(h);
            return (
              <div
                key={h.id}
                onClick={() => toggle(h.id)}
                title={`${tierLabel(h.tier)} · about ${pct}% of these are true`}
                style={{
                  flexShrink: 0, cursor: 'pointer', padding: '5px 9px',
                  background: on ? '#FFD51F' : '#1A1815',
                  border: `2px solid ${on ? '#FFD51F' : '#3A352C'}`,
                  color: on ? '#0C0C10' : 'var(--cream)',
                  fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
                  lineHeight: 1.35, maxWidth: 190, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                <div>{describe(h.payload)}</div>
                {/* The odds, always visible. A sharp hint is close to a coin
                    flip and the player is entitled to know before digging. */}
                <div style={{ opacity: .65, fontSize: 8, letterSpacing: '.08em' }}>
                  {tierLabel(h.tier).toUpperCase()} · {pct}% RELIABLE
                </div>
              </div>
            );
          })}
        </div>
      )}

      {candidateSet?.size === 0 && (
        <div style={{
          flexShrink: 0, padding: '6px 12px', background: '#FF3D3D',
          fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
          color: '#0C0C10', letterSpacing: '.1em',
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
                onClick={onTile}
                survey={surveys[`${cell.r},${cell.c}`]}
                pointed={pointer?.r === cell.r && pointer?.c === cell.c}
                dimmed={candidateSet !== null && !candidateSet.has(`${cell.r}:${cell.c}`)}
              />
            ))}
          </div>
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
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: 'var(--cream)', opacity: .55, marginTop: 4 }}>
                NEAREST TREASURE, FROM WHERE YOU LEFT OFF
              </div>
            </div>
          )}

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#FFD51F' }}>
              {formatWait(stuck.msUntilPlayable)}
            </div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: 'var(--cream)', opacity: .55, marginTop: 4 }}>
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
