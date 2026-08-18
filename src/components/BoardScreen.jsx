/*
  ─────────────────────────── the board, honestly ───────────────────────────

  This screen rendered `BOARD_DATA` — seven invented handles with invented
  dollar totals, carried over from the design prototype and shipped as if real.
  One of the rows was even flagged `you: true`, so a brand-new player saw
  themselves ranked fifth with $12.00 won before they had dug a single tile.

  In a game where rank decides whether you may play for money, that is not
  set dressing. Once a player works out one number is fabricated, they have no
  reason to trust the prize amounts, the reliability percentages, or the claim
  that 70% of spend goes into the pot — which is the whole pitch.

  There is no leaderboard endpoint yet (see server/src/http.ts — nothing
  aggregates across players). So this says so, states what the board will rank
  by when it exists, and shows the player the one real standing we do have.
  Building the endpoint is tracked in docs/DESIGN_VS_BUILD.md §4.1.
*/

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

export default function BoardScreen({ state }) {
  const rank = state?.rank ?? null;
  const handle = state?.player?.handle ?? '@you';
  const tier = rank?.tier ?? 'unranked';
  const accuracy = rank && rank.resolved > 0 ? `${Math.round(rank.accuracyBps / 100)}%` : '—';

  return (
    <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flexShrink: 0, padding: '16px 16px 14px', borderBottom: '3px solid #0C0C10',
        background: 'var(--card)',
      }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: '.16em', color: '#0C0C10', opacity: .6 }}>RANKINGS</div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 22, color: '#0C0C10', lineHeight: 1, marginTop: 3 }}>THE BOARD</div>
      </div>

      <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* The one real row we have. */}
        <div>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
            letterSpacing: '.16em', color: 'var(--cream)', opacity: .6, marginBottom: 12,
          }}>YOU</div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px',
            border: '3px solid #0C0C10', background: '#FFD51F', boxShadow: '5px 5px 0 #FF3BBD',
          }}>
            <div style={{
              width: 40, height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '3px solid #0C0C10', background: TIER_COLOR[tier] ?? '#7E766A',
              fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10',
            }}>@</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, fontWeight: 700, color: '#0C0C10' }}>
                {handle}
              </div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#0C0C10', opacity: .6, marginTop: 3 }}>
                {TIER_LABEL[tier] ?? String(tier).toUpperCase()} · {rank?.resolved ?? 0} RESOLVED
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 18, color: '#0C0C10' }}>{accuracy}</div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#0C0C10', opacity: .55, marginTop: 2 }}>ACCURACY</div>
            </div>
          </div>
        </div>

        {/* And an honest account of the rest. */}
        <div>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
            letterSpacing: '.16em', color: 'var(--cream)', opacity: .6, marginBottom: 12,
          }}>EVERYONE ELSE</div>
          <div style={{
            border: '3px dashed rgba(245,239,227,.25)', padding: '22px 16px', textAlign: 'center',
          }}>
            <div style={{
              fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: 'var(--cream)', lineHeight: 1.2,
            }}>
              NOBODY HAS RANKED HERE YET
            </div>
            <div style={{
              fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600,
              color: 'var(--cream)', opacity: .65, lineHeight: 1.45, marginTop: 10,
            }}>
              Be first. The board ranks by how often your hints turn out true — not by
              how much you win, and not by how much you spend.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
