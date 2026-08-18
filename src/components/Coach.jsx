import { useState } from 'react';

/**
 * The walkthrough, on screen.
 *
 * ─────────────────────────── what was actually wrong ────────────────────────
 *
 * The server has sent a `copy` string with every step since phase 6. The client
 * read `state.grid.tutorial.step` into a variable called `pointer`, used it to
 * draw a ring around one tile, and **threw the copy away**. So a new player got
 * a highlighted tile on a 3,600-tile board and no sentence telling them why.
 *
 * ─────────────────────────── why a bar and not a modal ─────────────────────
 *
 * Most steps are an instruction to touch a specific tile, so the board has to
 * stay visible and tappable underneath. A modal that has to be dismissed before
 * you can obey it teaches dismissal.
 */

const TONE = {
  dig: '#FF7A1A',
  hint: '#FFD51F',
  survey: '#29E6E6',
  reading: '#29E6E6',
  find: '#2CE66A',
  energy: '#FFD51F',
  race: '#FF3BBD',
  enter: '#8A3DFF',
};

/** What the highlighted HUD chip is called, so the copy can point at it by name. */
const POINTS_AT = {
  energy: 'the bar, top right',
  keys: 'your keys, top right',
  hints: 'the hints strip, under the header',
  survey: 'the SURVEY toggle',
};

/** The survey scale, hottest first. Mirrors SURVEY.bands on the server. */
const BANDS = [
  { name: 'burning', color: '#FF3D3D' },
  { name: 'hot', color: '#FF7A1A' },
  { name: 'warm', color: '#FFD51F' },
  { name: 'cool', color: '#29E6E6' },
  { name: 'cold', color: '#3A4A6A' },
];

const DIG_COST = 2;
const SURVEY_COST = 6;
const REGEN_MS = 360_000;

/** "12m" / "1h 04m". A bar that returns in four hours has to say so. */
function formatWait(ms) {
  if (!ms || ms <= 0) return 'now';
  const mins = Math.ceil(ms / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * Why the marked tile will not respond to a tap, if it will not.
 *
 * Every step that points at a tile has two silent preconditions: the toggle has
 * to be on the right action, and the bar has to cover it. Miss either and the
 * tap does nothing at all — no error, no movement, the same instruction still on
 * screen. There is no way to tell "wrong tile" from "wrong mode" from "cannot
 * afford it", so the honest reading of the screen is that the game is broken.
 */
function blockedBy(step, surveyMode, energy) {
  if (step.action === 'survey') {
    if (!surveyMode) return 'THE TOGGLE MUST SAY SURVEY 6⚡ — TAP IT';
    if (energy && energy.value < SURVEY_COST) {
      const wait = energy.nextRegenMs + (SURVEY_COST - energy.value - 1) * REGEN_MS;
      return `NEEDS 6⚡ · YOU HAVE ${energy.value} · BACK IN ${formatWait(wait)}`;
    }
  }
  if (step.action === 'dig' || step.action === 'enter') {
    if (surveyMode) return 'THE TOGGLE MUST SAY DIG 2⚡ — TAP IT';
    if (energy && energy.value < DIG_COST) {
      return `NEEDS 2⚡ · YOU HAVE ${energy.value} · BACK IN ${formatWait(energy.nextRegenMs)}`;
    }
  }
  return null;
}

/**
 * The survey scale, with the player's own reading marked on it.
 *
 * ─────────────────────────── why this replaced a paragraph ──────────────────
 *
 * This step used to be four lines naming the five bands in a row — abstract,
 * and arriving immediately after the player had just taken a reading whose
 * result the card never mentioned. It told them the scale exists without ever
 * telling them where on it they had landed, which is the one thing they had
 * just paid six energy to find out.
 *
 * So the scale is drawn, their band is marked on it, and the number they
 * actually got is the largest thing on the card.
 */
function BandScale({ band }) {
  return (
    <div style={{ marginTop: 12, marginBottom: 4 }}>
      <div style={{ display: 'flex', gap: 3 }}>
        {BANDS.map(b => {
          const mine = b.name === band;
          return (
            <div key={b.name} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{
                height: mine ? 20 : 11,
                background: b.color,
                border: '2px solid #0C0C10',
                boxShadow: mine ? '2px 2px 0 #0C0C10' : 'none',
                opacity: band && !mine ? 0.35 : 1,
                transition: 'all .2s',
              }} />
              <div style={{
                fontFamily: "'Space Mono', monospace",
                fontSize: 7,
                fontWeight: 700,
                letterSpacing: '.04em',
                marginTop: 4,
                color: 'var(--cream)',
                opacity: mine ? 1 : 0.4,
              }}>
                {b.name.toUpperCase()}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginTop: 6,
        fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
        letterSpacing: '.1em', color: 'var(--cream)', opacity: 0.45,
      }}>
        <span>ON TOP OF IT</span>
        <span>MILES AWAY</span>
      </div>
    </div>
  );
}

export default function Coach({ tutorial, surveyMode = false, energy = null, reading = null, onAck }) {
  // Collapsed, not hidden.
  //
  // "hide" used to set a flag that removed the walkthrough for the rest of the
  // session with no way to bring it back — one mis-tap and the only thing
  // explaining the game was gone for good. Collapsing leaves a bar you can
  // reopen, which is what someone who wants a clear look at the board actually
  // wants.
  const [open, setOpen] = useState(true);

  const step = tutorial?.step;
  if (!step) return null;

  const tone = TONE[step.id] ?? '#FFD51F';
  const needsAck = step.action === 'read';
  const at = POINTS_AT[step.highlight];
  const blocked = needsAck ? null : blockedBy(step, surveyMode, energy);
  const showScale = step.id === 'reading';

  const shell = {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 96,
    zIndex: 45,
    padding: '0 10px',
    pointerEvents: 'none',
  };

  if (!open) {
    return (
      <div style={shell}>
        <div
          onClick={() => setOpen(true)}
          style={{
            pointerEvents: 'auto',
            background: 'var(--deep)',
            border: '3px solid #0C0C10',
            borderTop: `6px solid ${tone}`,
            boxShadow: '5px 5px 0 #0C0C10',
            padding: '9px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            cursor: 'pointer',
          }}
        >
          <span style={{
            fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
            letterSpacing: '.14em', color: tone, flexShrink: 0,
          }}>
            {tutorial.index + 1}/{tutorial.total}
          </span>
          <span style={{
            fontFamily: "'Archivo Black', sans-serif", fontSize: 12, color: 'var(--cream)',
            flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {step.title}
          </span>
          <span style={{
            fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
            letterSpacing: '.1em', color: tone, flexShrink: 0,
          }}>
            SHOW ▲
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...shell, animation: 'lg-pop .22s ease-out' }}>
      <div
        style={{
          background: 'var(--deep)',
          border: '3px solid #0C0C10',
          borderTop: `8px solid ${tone}`,
          boxShadow: '5px 5px 0 #0C0C10',
          padding: '11px 13px 13px',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
            letterSpacing: '.14em', color: tone, flexShrink: 0,
          }}>
            {tutorial.index + 1}/{tutorial.total}
          </div>
          {/* Progress as ticks rather than a percentage — eight is few enough to
              count, and a filling row says "nearly there" without a number that
              invites someone to work out how long is left. */}
          <div style={{ display: 'flex', gap: 3, flex: 1 }}>
            {Array.from({ length: tutorial.total }, (_, i) => (
              <div key={i} style={{
                flex: 1, height: 4, border: '2px solid #0C0C10',
                background: i <= tutorial.index ? tone : 'transparent',
              }} />
            ))}
          </div>
          <div
            onClick={() => setOpen(false)}
            style={{
              fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
              letterSpacing: '.1em', color: 'var(--cream)', opacity: 0.5,
              cursor: 'pointer', flexShrink: 0,
            }}
          >
            HIDE ▼
          </div>
        </div>

        <div style={{
          fontFamily: "'Archivo Black', sans-serif", fontSize: 15, lineHeight: 1.1,
          color: 'var(--cream)', marginBottom: 6,
        }}>
          {step.title}
        </div>

        {/* The reading they just paid for, before any explanation of it. */}
        {showScale && reading && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <span style={{
              fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
              letterSpacing: '.12em', color: 'var(--cream)', opacity: 0.6,
            }}>
              YOU READ
            </span>
            <span style={{
              fontFamily: "'Archivo Black', sans-serif", fontSize: 22, lineHeight: 1,
              color: BANDS.find(b => b.name === reading.band)?.color ?? '#FFD51F',
            }}>
              {String(reading.band).toUpperCase()}
            </span>
          </div>
        )}

        <div style={{
          fontFamily: "'Space Grotesk', sans-serif", fontSize: 12.5, lineHeight: 1.45,
          color: 'var(--cream)', opacity: 0.78,
        }}>
          {step.copy}
        </div>

        {showScale && <BandScale band={reading?.band} />}

        {at && (
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
            letterSpacing: '.12em', color: tone, marginTop: 8,
          }}>
            ↑ {at.toUpperCase()}
          </div>
        )}

        {/* Loud, because it is the difference between "I am stuck" and "I know
            what to do next". Red rather than the step's tone: this is not part
            of the lesson, it is the reason the lesson is not proceeding. */}
        {blocked && (
          <div style={{
            marginTop: 10, padding: '7px 9px', background: '#FF3D3D',
            border: '3px solid #0C0C10', fontFamily: "'Space Mono', monospace",
            fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', color: '#0C0C10',
          }}>
            {blocked}
          </div>
        )}

        <div style={{ marginTop: 11 }}>
          {needsAck ? (
            <div
              onClick={onAck}
              style={{
                border: '3px solid #0C0C10', background: tone,
                boxShadow: '4px 4px 0 #0C0C10', padding: '10px 18px',
                fontFamily: "'Archivo Black', sans-serif", fontSize: 13,
                color: '#0C0C10', textAlign: 'center', cursor: 'pointer',
              }}
            >
              GOT IT
            </div>
          ) : (
            /* No button on a step that wants a tap on the board. The only way
               forward is to do the thing, which is the point of teaching by
               doing rather than by reading. */
            <div style={{
              fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
              letterSpacing: '.1em', color: tone,
            }}>
              {blocked
                ? 'THEN TAP THE GREEN TILE →'
                : step.action === 'survey'
                  ? 'SURVEY THE GREEN TILE →'
                  : 'TAP THE GREEN TILE →'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
