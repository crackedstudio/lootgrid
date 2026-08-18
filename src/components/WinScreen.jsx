import { useCallback, useEffect, useState } from 'react';
import Mascot from './Mascot';
import { SPEC9 } from '../data/gameData';
import {
  claimPrize,
  fetchPrizeBalance,
  formatWait,
  secondsUntilCollectable,
  withdrawPrize,
} from '../api/prizes';

function Confetti() {
  const pieces = Array.from({ length: 18 }).map((_, i) => ({
    color: SPEC9[i % SPEC9.length],
    left: `${5 + (i * 5.5) % 90}%`,
    delay: `${(i * 0.18) % 2.5}s`,
    dur: `${1.8 + (i % 5) * 0.4}s`,
    size: 6 + (i % 4) * 3,
  }));

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 1 }}>
      {pieces.map((p, i) => (
        <div key={i} style={{
          position: 'absolute', top: 0, left: p.left,
          width: p.size, height: p.size, background: p.color,
          animation: `lg-confetti ${p.dur} ${p.delay} linear infinite`,
        }} />
      ))}
    </div>
  );
}

/**
 * Claim, then collect.
 *
 * Two steps because the escrow pays by pull: `claim` credits the pot against
 * the referee's signature, and `withdraw` moves the tokens once the challenge
 * window has elapsed. The wait is shown rather than hidden — it is the window
 * in which a payout signed by a leaked key can still be stopped, and a button
 * that reverts teaches a player the app is broken.
 *
 * The balance is read from the chain, never assumed. The server signs the
 * attestation but never sees the transaction, so only the contract knows
 * whether the claim actually landed.
 */
function PrizeClaim({ huntId }) {
  const [balance, setBalance] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | claiming | collecting
  const [error, setError] = useState(null);
  const [, tick] = useState(0);

  const load = useCallback(
    () => fetchPrizeBalance().then(setBalance).catch(() => setBalance(null)),
    [],
  );

  useEffect(() => {
    let alive = true;
    fetchPrizeBalance()
      .then(b => alive && setBalance(b))
      .catch(() => alive && setBalance(null));
    return () => {
      alive = false;
    };
  }, []);

  // Re-render while the window counts down, so the button enables itself
  // instead of demanding the player guess when to try again.
  const waiting = balance ? secondsUntilCollectable(balance) : 0;
  useEffect(() => {
    if (waiting <= 0) return undefined;
    const timer = setInterval(() => tick(n => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);

  // Payouts are switched off server-side. Say nothing rather than offer a
  // button that cannot work.
  if (!balance) return null;

  const owed = BigInt(balance.owed ?? '0');
  const run = async (next, fn) => {
    setPhase(next);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      // A failure here costs the player their prize, so it is shown. This is
      // the opposite rule from publishing a record, which fails silently.
      setError(err?.code || err?.message || 'that did not work');
    } finally {
      setPhase('idle');
    }
  };

  const label = () => {
    if (phase === 'claiming') return 'CLAIMING…';
    if (phase === 'collecting') return 'COLLECTING…';
    if (owed === 0n) return 'CLAIM YOUR PRIZE';
    if (waiting > 0) return `COLLECT IN ${formatWait(waiting)}`;
    return 'COLLECT IT';
  };

  const ready = owed > 0n && waiting <= 0;
  const disabled = phase !== 'idle' || (owed > 0n && waiting > 0);

  return (
    <>
      <div
        onClick={
          disabled
            ? undefined
            : () =>
                owed === 0n
                  ? run('claiming', () => claimPrize(huntId))
                  : run('collecting', () => withdrawPrize(balance))
        }
        style={{
          marginTop: 14, width: 300, border: '4px solid #0C0C10',
          background: disabled ? 'rgba(245,239,227,.35)' : ready ? '#2CE66A' : '#FFD51F',
          boxShadow: '6px 6px 0 #29E6E6', padding: 16, textAlign: 'center',
          fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10',
          cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background .2s',
        }}
      >
        {label()}
      </div>

      {owed > 0n && waiting > 0 && (
        <div style={{
          marginTop: 8, width: 300, fontFamily: "'Space Mono', monospace", fontSize: 11,
          lineHeight: 1.5, color: 'var(--cream)', opacity: .55, textAlign: 'center',
        }}>
          CLAIMED. THE ESCROW HOLDS IT FOR A SHORT WINDOW BEFORE IT CAN BE MOVED.
        </div>
      )}

      {error && (
        <div style={{
          marginTop: 8, width: 300, fontFamily: "'Space Mono', monospace", fontSize: 11,
          fontWeight: 700, color: '#FF3D3D', textAlign: 'center',
        }}>{error}</div>
      )}
    </>
  );
}

export default function WinScreen({ state, onShare, onBackToMap, onShowTranscript }) {
  const { winData, shared } = state;
  if (!winData) return null;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 70, background: '#0C0C10',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '28px 22px', overflow: 'hidden',
    }}>
      <Confetti />

      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ animation: 'lg-cheer 1s ease-in-out infinite', marginBottom: 8 }}>
          <Mascot color="#FFD51F" mole size={62} />
        </div>

        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: '.18em', color: '#FFD51F', marginBottom: 10 }}>
          FIRST TO CRACK IT
        </div>

        <div style={{
          background: 'var(--card)', border: '4px solid #FFD51F',
          boxShadow: '9px 9px 0 #FF3BBD',
          padding: '20px 26px 24px', width: 300,
          animation: 'lg-pop .42s ease-out both',
        }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: '#0C0C10', opacity: .55 }}>
            YOU WON
          </div>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 44, lineHeight: 1, color: '#0C0C10', marginTop: 4, marginBottom: 16 }}>
            {winData.prize || '—'}
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
            <div style={{ flex: 1, border: '2px solid #0C0C10', padding: '10px 12px' }}>
              {/* Server-measured, from the spec being sent to your final input. */}
              <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10' }}>
                {(winData.elapsedMs / 1000).toFixed(2)}s
              </div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, color: '#0C0C10', opacity: .5, marginTop: 4 }}>YOUR TIME</div>
            </div>
            <div style={{ flex: 1, border: '2px solid #0C0C10', padding: '10px 12px' }}>
              <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10' }}>
                {winData.beat} rival{winData.beat === 1 ? '' : 's'}
              </div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, color: '#0C0C10', opacity: .5, marginTop: 4 }}>YOU BEAT</div>
            </div>
          </div>

          {/* The salt reveal: proof the block was where the server committed it,
              rather than moved to wherever a favoured player happened to dig. */}
          {winData.reveal && (
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#0C0C10', opacity: .45, lineHeight: 1.5 }}>
              VERIFIED r{winData.reveal.r},c{winData.reveal.c}<br />
              SALT {String(winData.reveal.salt).slice(0, 16)}…
            </div>
          )}
        </div>

        {winData.huntId && <PrizeClaim huntId={winData.huntId} />}

        <div
          onClick={onShare}
          style={{
            marginTop: 14, width: 300, border: '4px solid #0C0C10',
            background: shared ? '#2CE66A' : '#FFD51F',
            boxShadow: '6px 6px 0 #FF3BBD', padding: 16, textAlign: 'center',
            fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10',
            cursor: 'pointer', transition: 'background .2s',
          }}
        >
          {shared ? 'SHARED ✓ — NICE ONE' : 'SHARE THE WIN'}
        </div>

        {winData.huntId && onShowTranscript && (
          <div
            onClick={onShowTranscript}
            style={{
              marginTop: 12, fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700,
              color: 'var(--cream)', opacity: .6, cursor: 'pointer', letterSpacing: '.08em',
              textDecoration: 'underline',
            }}
          >HOW THIS HUNT WAS RUN →</div>
        )}

        <div
          onClick={onBackToMap}
          style={{
            marginTop: 14, fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
            color: 'var(--cream)', opacity: .55, cursor: 'pointer', letterSpacing: '.08em',
          }}
        >← BACK TO GRID</div>
      </div>
    </div>
  );
}
