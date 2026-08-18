import { IconSvg } from './Mascot';

/*
  ─────────────────────────── real numbers only ───────────────────────────

  This screen used to print `141 FINDS / $642 WON / 9 XP SOLVES` for every
  player alive, three pixels from their real server handle, plus a hardcoded
  activity feed of things that never happened.

  That was the design prototype's placeholder data, copied across and shipped.
  In a prototype it is scaffolding; in a product where rank gates access to
  cash it is a trust problem, and a player who catches one invented number has
  no reason to believe the prize amounts either.

  So: everything here now comes from `/me`. Where the server has no answer, the
  screen says so rather than inventing one.
*/

const ICON_PATHS = {
  rank:   ['M12 3 L20 7 L20 17 L12 21 L4 17 L4 7 Z'],
  market: ['M4 10 L11 10 L9 7', 'M20 14 L13 14 L15 17'],
  agent:  ['M5 5 L19 5 L19 19 L5 19 Z', 'M12 10 A2 2 0 1 0 12 9.99', 'M9 15 C9 13.3 10.3 12.5 12 12.5 C13.7 12.5 15 13.3 15 15'],
};

/** Tier names as the player should read them, lowest to highest. */
const TIER_LABEL = {
  unranked: 'UNRANKED',
  prospector: 'PROSPECTOR',
  surveyor: 'SURVEYOR',
  cartographer: 'CARTOGRAPHER',
};

const TIER_COLOR = {
  unranked: '#7E766A',
  prospector: '#FFD51F',
  surveyor: '#29E6E6',
  cartographer: '#FF3BBD',
};

/**
 * What is still missing, in a sentence.
 *
 * The server already computes `shortfall` so a refusal can be specific — it was
 * being used only inside an error toast at the moment of rejection, which is
 * the worst possible time to learn about a requirement. Same numbers, shown
 * before they block anything.
 */
function shortfallLine(rank) {
  if (!rank?.nextTier) return 'Top rank. Nothing left to climb.';
  const s = rank.shortfall ?? {};
  const parts = [];
  if (s.resolved > 0) parts.push(`${s.resolved} more resolved hint${s.resolved === 1 ? '' : 's'}`);
  if (s.activeDays > 0) parts.push(`${s.activeDays} more active day${s.activeDays === 1 ? '' : 's'}`);
  if (s.accuracyBps > 0) parts.push(`${(s.accuracyBps / 100).toFixed(0)}% more accuracy`);
  if (parts.length === 0) return `Ready for ${TIER_LABEL[rank.nextTier] ?? rank.nextTier}.`;
  return `${parts.join(' · ')} to reach ${TIER_LABEL[rank.nextTier] ?? rank.nextTier}.`;
}

function Stat({ value, label, hint }) {
  return (
    <div style={{ flex: 1, border: '2px solid #0C0C10', padding: '10px 8px', textAlign: 'center' }}>
      <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 18, color: '#0C0C10' }}>{value}</div>
      <div style={{
        fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
        color: '#0C0C10', opacity: .6, marginTop: 3,
      }}>{label}</div>
      {hint && (
        <div style={{
          fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#0C0C10',
          opacity: .45, marginTop: 2,
        }}>{hint}</div>
      )}
    </div>
  );
}

function LinkRow({ paths, title, body, onClick }) {
  return (
    <div
      onClick={onClick}
      className="lg-press"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 13px',
        border: '3px solid #0C0C10', background: 'var(--card)',
        boxShadow: '4px 4px 0 #0C0C10', cursor: 'pointer',
      }}
    >
      <div style={{
        width: 40, height: 40, flexShrink: 0, border: '3px solid #0C0C10', background: '#FFD51F',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <IconSvg paths={paths} color="#0C0C10" strokeWidth={2.4} size={18} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 700, color: '#0C0C10' }}>{title}</div>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#0C0C10', opacity: .55, marginTop: 3 }}>{body}</div>
      </div>
      <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10', opacity: .5 }}>→</div>
    </div>
  );
}

export default function YouScreen({ state, onNav }) {
  const handle = state?.player?.handle ?? '@…';
  const energy = state?.energy ?? { value: 0, max: 40 };
  const keys = state?.keys ?? null;
  const rank = state?.rank ?? null;
  const xp = state?.xp ?? 0;

  const tier = rank?.tier ?? 'unranked';
  const accuracy = rank && rank.resolved > 0 ? `${Math.round(rank.accuracyBps / 100)}%` : '—';

  return (
    <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      {/* profile header */}
      <div style={{ flexShrink: 0, padding: '20px 16px 16px', borderBottom: '3px solid #0C0C10', background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 54, height: 54, border: '3px solid #0C0C10', background: '#FFD51F', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Archivo Black', sans-serif", fontSize: 22, color: '#0C0C10', boxShadow: '4px 4px 0 #0C0C10' }}>
            @
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 20, color: '#0C0C10', lineHeight: 1 }}>{handle}</div>
            <div style={{
              fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
              color: TIER_COLOR[tier] ?? '#0C0C10', marginTop: 5, letterSpacing: '.1em',
            }}>
              {TIER_LABEL[tier] ?? String(tier).toUpperCase()}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 20, color: '#0C0C10' }}>⚡ {energy.value}/{energy.max}</div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#0C0C10', opacity: .55, marginTop: 3 }}>ENERGY</div>
          </div>
        </div>

        {/* Real, from /me. Keys sit here as well as on the map because the rule
            they encode — five a day, unpurchasable — is a fact about the
            account, not about the current zone. */}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <Stat value={xp} label="XP" />
          <Stat value={rank?.resolved ?? 0} label="HINTS RESOLVED" />
          <Stat value={accuracy} label="ACCURACY" />
          {keys && <Stat value={`${keys.remaining}/${keys.perDay}`} label="KEYS TODAY" />}
        </div>
      </div>

      <div style={{ flex: 1, padding: '16px 16px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/*
          The ladder, finally on screen.

          Prospector rank has existed on the server since phase 5 and decides
          whether a player may enter a cash hunt. The app has never shown it —
          so the first time anyone learned it existed was a refusal toast at the
          moment they tried to play for money. That is the one place it should
          never have been introduced.
        */}
        <div>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
            letterSpacing: '.16em', color: 'var(--cream)', opacity: .6, marginBottom: 12,
          }}>YOUR STANDING</div>

          <div style={{ border: '3px solid #0C0C10', background: 'var(--card)', boxShadow: '4px 4px 0 #0C0C10', padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 40, height: 40, flexShrink: 0, border: '3px solid #0C0C10',
                background: TIER_COLOR[tier] ?? '#7E766A',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <IconSvg paths={ICON_PATHS.rank} color="#0C0C10" strokeWidth={2.4} size={18} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10', lineHeight: 1 }}>
                  {TIER_LABEL[tier] ?? String(tier).toUpperCase()}
                </div>
                <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#0C0C10', opacity: .6, marginTop: 4 }}>
                  {rank?.activeDays ?? 0} ACTIVE DAY{(rank?.activeDays ?? 0) === 1 ? '' : 'S'}
                </div>
              </div>
            </div>

            <div style={{
              fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600,
              color: '#0C0C10', lineHeight: 1.4, marginTop: 12,
            }}>
              {shortfallLine(rank)}
            </div>

            {/* Rank is earned by how often your hints turn out true — not by how
                much you have won. Worth saying on the screen that shows it. */}
            <div style={{
              fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#0C0C10',
              opacity: .5, lineHeight: 1.5, marginTop: 10,
              borderTop: '2px solid rgba(12,12,16,.15)', paddingTop: 10,
            }}>
              RANK COMES FROM HOW OFTEN YOUR HINTS TURN OUT TRUE. NOT FROM WHAT YOU WIN, AND NOT FROM WHAT YOU SPEND.
            </div>
          </div>
        </div>

        {/*
          Market and Agent lost their nav tabs to get the bar down to four, so
          they get proper doors here instead. Deliberately described rather than
          just named — "AGENT" on a tab bar told a new player nothing.
        */}
        {onNav && (
          <div>
            <div style={{
              fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
              letterSpacing: '.16em', color: 'var(--cream)', opacity: .6, marginBottom: 12,
            }}>MORE</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <LinkRow
                paths={ICON_PATHS.market}
                title="HINT MARKET"
                body="Buy and sell hints with other hunters"
                onClick={() => onNav('market')}
              />
              <LinkRow
                paths={ICON_PATHS.agent}
                title="AGENT"
                body="Let a bot hunt for you, inside limits you set"
                onClick={() => onNav('agent')}
              />
            </div>
          </div>
        )}

        {/*
          There is no activity endpoint. There used to be a feed here of four
          invented events; an empty state that admits the gap is worth more than
          a feed that lies, and it is the thing that tells us to go build it.
        */}
        <div>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
            letterSpacing: '.16em', color: 'var(--cream)', opacity: .6, marginBottom: 12,
          }}>RECENT ACTIVITY</div>
          <div style={{
            border: '3px dashed rgba(245,239,227,.25)', padding: '18px 14px',
            fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600,
            color: 'var(--cream)', opacity: .55, lineHeight: 1.45, textAlign: 'center',
          }}>
            Your finds and wins will show up here once you have some.
          </div>
        </div>
      </div>
    </div>
  );
}
