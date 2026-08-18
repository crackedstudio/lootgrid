import { useEffect, useState } from 'react';
import { fetchTranscript, verifyTranscript } from '../api/transcript';

/**
 * The Director's transcript, and the arithmetic that checks it.
 *
 * ─────────────────────────── why this screen exists ─────────────────────────
 *
 * v1 could promise something simple: the map was fixed before you played, and
 * here is the salt to prove it. A Director choosing rounds while the hunt runs
 * takes that away — the game is no longer decided in advance, so nothing
 * decided in advance can vouch for it.
 *
 * What replaces it is weaker and worth stating in the interface rather than in
 * a document nobody reads: every round is chained, the head is signed at
 * resolution, and anyone can recompute the chain. That proves there was **one
 * version of events, the same for every racer**. It does not prove the rounds
 * were kind.
 *
 * So this screen does the recomputation in the browser and reports what it
 * found. A verification the player has to take on trust is not a verification,
 * and telling them "verified" without doing the arithmetic would be worse than
 * showing nothing.
 */

const MONO = "'Space Mono', monospace";
const BLACK = "'Archivo Black', sans-serif";

const TWIST_COLOR = {
  none: '#0C0C10',
  fog: '#8A3DFF',
  decoys: '#FF7A1A',
  silence: '#29E6E6',
  haste: '#FF3D3D',
};

function Row({ entry }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
      borderBottom: '1px solid rgba(12,12,16,.12)',
    }}>
      <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: '#0C0C10', opacity: .5, width: 26 }}>
        {entry.round}
      </div>
      <div style={{ fontFamily: BLACK, fontSize: 14, color: '#0C0C10', width: 22 }}>
        {entry.directive.difficulty}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: '#0C0C10', flex: 1 }}>
        {entry.directive.roundType.toUpperCase()}
      </div>
      {entry.directive.twist !== 'none' && (
        <div style={{
          fontFamily: MONO, fontSize: 11, fontWeight: 700, padding: '2px 6px',
          border: `2px solid ${TWIST_COLOR[entry.directive.twist] ?? '#0C0C10'}`,
          color: TWIST_COLOR[entry.directive.twist] ?? '#0C0C10',
        }}>
          {entry.directive.twist.toUpperCase()}
        </div>
      )}
      <div style={{ fontFamily: MONO, fontSize: 7, color: '#0C0C10', opacity: .35 }}>
        {entry.hash.slice(0, 10)}
      </div>
    </div>
  );
}

export default function HuntTranscript({ huntId, onClose }) {
  const [data, setData] = useState(null);
  const [check, setCheck] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchTranscript(huntId)
      .then(async transcript => {
        if (!alive) return;
        setData(transcript);
        // Recomputed here, in the browser, from the published entries. This is
        // the whole point of the screen.
        setCheck(await verifyTranscript(transcript));
      })
      .catch(err => alive && setError(err?.code ?? 'unavailable'));
    return () => {
      alive = false;
    };
  }, [huntId]);

  const live = data && !data.salt;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 68, background: 'rgba(12,12,16,.9)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div style={{
        width: '100%', maxHeight: '86%', background: 'var(--card)',
        border: '4px solid #0C0C10', borderBottom: 'none',
        display: 'flex', flexDirection: 'column', animation: 'lg-rise .25s ease-out',
      }}>
        <div style={{ flexShrink: 0, padding: '16px 18px 12px', borderBottom: '3px solid #0C0C10' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '.16em', color: '#0C0C10', opacity: .55 }}>
              HOW THIS HUNT WAS RUN
            </div>
            <div onClick={onClose} style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: '#0C0C10', opacity: .5, cursor: 'pointer' }}>
              ✕ CLOSE
            </div>
          </div>
          <div style={{ fontFamily: BLACK, fontSize: 20, color: '#0C0C10', marginTop: 2 }}>
            {data ? `${data.rounds} ROUNDS` : 'LOADING…'}
          </div>
        </div>

        {error && (
          <div style={{ padding: 18, fontFamily: MONO, fontSize: 10, color: '#0C0C10' }}>
            {error === 'not_directed'
              ? 'This hunt ran on the fixed generator — there is nothing to show.'
              : 'Transcript unavailable.'}
          </div>
        )}

        {data && (
          <>
            {/* The verdict, before the detail. */}
            <div style={{
              flexShrink: 0, padding: '12px 18px', borderBottom: '3px solid #0C0C10',
              background: live ? 'rgba(255,213,31,.15)' : check?.ok ? 'rgba(44,230,106,.18)' : 'rgba(255,61,61,.18)',
            }}>
              <div style={{ fontFamily: BLACK, fontSize: 13, color: '#0C0C10' }}>
                {live
                  ? 'STILL RUNNING'
                  : check?.ok
                    ? 'CHAIN CHECKS OUT'
                    : 'CHAIN DOES NOT MATCH'}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.6, color: '#0C0C10', opacity: .75, marginTop: 6 }}>
                {live
                  ? 'The salt stays secret until the hunt ends — publishing it now would hand over the map. Come back afterwards to check the rounds.'
                  : check?.ok
                    ? 'Recomputed in your browser from the published rounds. This proves every racer got the same rounds, and that they were not rewritten afterwards. It does not prove they were kind.'
                    : 'The published rounds do not hash to the signed head. That should never happen — treat this hunt as disputed.'}
              </div>
            </div>

            <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', padding: '4px 18px 18px' }}>
              <div style={{ display: 'flex', gap: 10, padding: '10px 0 4px' }}>
                {['#', 'DIFF', 'ROUND', '', 'HASH'].map((h, i) => (
                  <div key={i} style={{
                    fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '.1em',
                    color: '#0C0C10', opacity: .4, width: i === 0 ? 26 : i === 1 ? 22 : undefined,
                    flex: i === 2 ? 1 : undefined,
                  }}>{h}</div>
                ))}
              </div>

              {data.entries.map(entry => <Row key={entry.round} entry={entry} />)}

              <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .45, marginTop: 14, lineHeight: 1.6, wordBreak: 'break-all' }}>
                HEAD {data.chainHead}
                {data.attestation && <><br />SIGNED BY THE REFEREE AT RESOLUTION</>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
