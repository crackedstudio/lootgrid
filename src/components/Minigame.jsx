import Mascot from './Mascot';

/** Server reason codes → player-facing copy. The UI switches on the code, never on prose. */
const FAIL_COPY = {
  too_slow: 'TOO SLOW',
  timeout: 'RAN OUT OF TIME',
  answered_too_slow: 'TOO SLOW',
  timing_too_regular: "THAT DIDN'T LOOK HUMAN",
  insufficient_variance: "THAT DIDN'T LOOK HUMAN",
  interval_floor: 'TOO FAST TO BE REAL',
  answered_too_fast: 'TOO FAST TO BE REAL',
  input_before_playback_end: 'YOU JUMPED THE SEQUENCE',
  wrong_answer: 'WRONG ANSWER',
  wrong_order: 'WRONG ORDER',
  seq_gap: 'CONNECTION PROBLEM',
  client_ahead_of_server: 'CONNECTION PROBLEM',
  client_time_went_backwards: 'CONNECTION PROBLEM',
};

const TITLES = {
  tap: 'TAP CHALLENGE',
  memory: 'MEMORY DIG',
  math: 'MATH DASH',
  sequence: 'SEQUENCE DIG',
};

/* -------- real rivals -------- */
function RivalBars({ rivals, chasers }) {
  if (rivals.length === 0) {
    return (
      <div style={{ padding: '10px 0', borderBottom: '2px solid rgba(245,239,227,.12)', marginBottom: 12 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .45 }}>
          {chasers > 1 ? `${chasers - 1} RIVALS CHASING` : "YOU'RE ALONE ON THIS ONE"}
        </div>
      </div>
    );
  }

  const colors = ['#FF3D3D', '#29E6E6', '#B7FF3B', '#2F6BFF', '#FF7A1A'];
  return (
    <div style={{ padding: '10px 0', borderBottom: '2px solid rgba(245,239,227,.12)', marginBottom: 12 }}>
      <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .5, marginBottom: 8 }}>
        {rivals.length} RIVAL{rivals.length === 1 ? '' : 'S'} CHASING
      </div>
      {rivals.map((r, i) => {
        const color = colors[i % colors.length];
        return (
          <div key={r.handle} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color, width: 58, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.handle}</div>
            <div style={{ flex: 1, height: 8, background: 'rgba(245,239,227,.1)', border: '1.5px solid #0C0C10', overflow: 'hidden' }}>
              <div style={{ height: '100%', background: color, width: `${r.pct}%`, transition: 'width .2s linear' }} />
            </div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color, width: 32, textAlign: 'right', flexShrink: 0 }}>{r.pct}%</div>
          </div>
        );
      })}
    </div>
  );
}

function TimerBar({ pct, label }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: 'var(--cream)', opacity: .55 }}>TIME</div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 14, color: pct < 30 ? '#FF3D3D' : '#FF7A1A' }}>{label}</div>
      </div>
      <div style={{ height: 8, border: '2px solid #0C0C10', background: 'rgba(245,239,227,.1)', overflow: 'hidden' }}>
        <div style={{ height: '100%', background: pct < 30 ? '#FF3D3D' : '#FF7A1A', width: `${pct}%`, transition: 'width .1s linear' }} />
      </div>
    </div>
  );
}

/* -------- TAP -------- */
function TapGame({ game, spec, locked, onTap }) {
  const segs = 14;
  const timePct = (game.remainingMs / spec.limitMs) * 100;
  const filled = Math.round((game.taps / game.target) * segs);

  return (
    <>
      <TimerBar pct={timePct} label={`${(game.remainingMs / 1000).toFixed(1)}s`} />
      <div style={{ textAlign: 'center', marginBottom: 20, fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: 'var(--cream)', opacity: .6 }}>
        MASH TO CRACK IT
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, justifyContent: 'center' }}>
        {Array.from({ length: segs }).map((_, i) => (
          <div key={i} style={{ width: 16, height: 22, border: '2px solid #0C0C10', background: i < filled ? '#FFD51F' : 'rgba(245,239,227,.08)' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
        <div
          onPointerDown={locked ? undefined : onTap}
          style={{
            width: 190, height: 190,
            background: locked ? 'var(--card)' : '#FFD51F',
            border: '5px solid #0C0C10',
            boxShadow: locked ? '8px 8px 0 rgba(12,12,16,.3)' : '10px 10px 0 #0C0C10',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: locked ? 'not-allowed' : 'pointer',
            userSelect: 'none', touchAction: 'manipulation',
            fontFamily: "'Archivo Black', sans-serif", fontSize: 38, color: '#0C0C10',
          }}
        >
          👊
        </div>
      </div>
      <div style={{ textAlign: 'center', fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#FFD51F' }}>
        {game.taps} / {game.target} TAPS
      </div>
    </>
  );
}

/* -------- MEMORY -------- */
const MEM_COLORS = ['#FF3D3D', '#FFD51F', '#2CE66A', '#2F6BFF'];

function MemGame({ game, locked, onPad }) {
  const active = game.phase === 'input' && !locked;
  return (
    <>
      <div style={{ textAlign: 'center', marginBottom: 16, fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .6 }}>
        {game.phase === 'watch' ? 'WATCH THE SEQUENCE' : `REPEAT: ${game.index}/${game.sequence.length}`}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 28 }}>
        {game.sequence.map((_, i) => (
          <div key={i} style={{ width: 12, height: 12, border: '2.5px solid var(--cream)', background: i < game.index ? '#FFD51F' : 'transparent' }} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, maxWidth: 220, margin: '0 auto 24px' }}>
        {MEM_COLORS.slice(0, game.padCount).map((color, i) => (
          <div
            key={i}
            onPointerDown={active ? () => onPad(i) : undefined}
            style={{
              height: 90, background: game.lit === i ? color : `${color}33`,
              border: `3px solid ${game.lit === i ? color : '#0C0C10'}`,
              boxShadow: game.lit === i ? `0 0 18px ${color}88` : 'none',
              cursor: active ? 'pointer' : 'default',
              touchAction: 'manipulation', transition: 'all .08s',
            }}
          />
        ))}
      </div>
    </>
  );
}

/* -------- MATH -------- */
function MathGame({ game, locked, onPick }) {
  return (
    <>
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .55, marginBottom: 8 }}>
          SOLVE {game.count} IN A ROW
        </div>
        {/* Per question, not per attempt — a directed round can be shorter than
            the one before it, and a player racing a clock is owed the number. */}
        {game.maxAnswerMs != null && (
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: '#FFD51F', opacity: .8, marginBottom: 8 }}>
            {(game.maxAnswerMs / 1000).toFixed(1)}s PER QUESTION
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 16 }}>
          {Array.from({ length: game.count }).map((_, i) => (
            <div key={i} style={{ width: 16, height: 16, border: '2.5px solid var(--cream)', background: i < game.index ? '#2CE66A' : 'transparent' }} />
          ))}
        </div>
      </div>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 52, lineHeight: 1, color: 'var(--cream)', letterSpacing: '-.02em' }}>
          {game.question.q}
        </div>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: 'var(--cream)', opacity: .4, marginTop: 8 }}>=  ?</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, maxWidth: 240, margin: '0 auto 20px' }}>
        {game.question.options.map(opt => {
          // The answer lives on the server, so the client cannot colour a pick
          // right or wrong — only show which one is awaiting a verdict.
          const picked = game.picked === opt;
          return (
            <div
              key={opt}
              onPointerDown={locked || game.picked !== null ? undefined : () => onPick(opt)}
              style={{
                padding: '18px 12px', textAlign: 'center',
                background: picked ? '#FFD51F' : 'rgba(245,239,227,.08)',
                border: `3px solid ${picked ? '#FFD51F' : '#0C0C10'}`,
                fontFamily: "'Archivo Black', sans-serif", fontSize: 22,
                color: picked ? '#0C0C10' : 'var(--cream)',
                cursor: locked || game.picked !== null ? 'default' : 'pointer',
                touchAction: 'manipulation', transition: 'all .12s',
              }}
            >{opt}</div>
          );
        })}
      </div>
    </>
  );
}

/* -------- SEQUENCE -------- */
function SeqGame({ game, locked, onTap }) {
  return (
    <>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .55 }}>
          TAP IN ORDER: 1 → {game.n}
        </div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 26, color: 'var(--cream)', marginTop: 6 }}>
          NEXT: {game.next > game.n ? '✓' : game.next}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', margin: '16px 0 24px' }}>
        {game.tiles.map(tile => {
          const tapped = game.tapped.includes(tile.id);
          return (
            <div
              key={tile.id}
              onPointerDown={locked || tapped ? undefined : () => onTap(tile)}
              style={{
                width: 72, height: 72,
                background: tapped ? '#2CE66A' : tile.color,
                border: '4px solid #0C0C10',
                boxShadow: tapped ? 'none' : '4px 4px 0 #0C0C10',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: "'Archivo Black', sans-serif", fontSize: 26, color: '#0C0C10',
                cursor: locked || tapped ? 'default' : 'pointer',
                opacity: tapped ? .5 : 1,
                touchAction: 'manipulation', transition: 'all .12s',
              }}
            >
              {tapped ? '✓' : tile.id}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* -------- OVERLAY -------- */
export default function Minigame({ state, onMgTap, onMemPad, onMathPick, onSeqTap, onExit }) {
  const { attempt, game, rivals, chasers, outcome, failReason, lostTo } = state;
  if (!attempt || !game) return null;

  const title = TITLES[attempt.gameType] || 'CHALLENGE';
  // Locked as soon as the server has the last word — pending, lost or failed.
  const locked = outcome !== null;
  const isOver = outcome === 'failed' || outcome === 'lost';

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 68, background: 'var(--deep)',
      display: 'flex', flexDirection: 'column', padding: '20px 20px 24px',
      animation: 'lg-pop .25s ease-out',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ animation: 'lg-bob 1.4s ease-in-out infinite' }}>
          <Mascot color={attempt.gameType === 'memory' ? '#8A3DFF' : '#FFD51F'} mole size={30} />
        </div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 20, color: 'var(--cream)' }}>{title}</div>
      </div>

      <RivalBars rivals={rivals} chasers={chasers} />

      {outcome === 'pending' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 22, color: '#FFD51F', textAlign: 'center' }}>
            CRACKED IT
          </div>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, color: 'var(--cream)', opacity: .7, textAlign: 'center' }}>
            Checking if anyone beat you to it…
          </div>
        </div>
      )}

      {outcome === 'lost' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 24, color: '#FF3D3D', textAlign: 'center' }}>
            {lostTo || 'SOMEONE'} GOT THERE FIRST
          </div>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, color: 'var(--cream)', opacity: .7, textAlign: 'center' }}>
            Better luck on the next hunt.
          </div>
        </div>
      )}

      {outcome === 'failed' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 26, color: '#FF3D3D', textAlign: 'center', animation: 'lg-shake .4s ease' }}>
            {FAIL_COPY[failReason] || 'HUNT FAILED'}
          </div>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color: 'var(--cream)', opacity: .4 }}>
            {failReason}
          </div>
        </div>
      )}

      {outcome === null && (
        <div className="lg-scroll" style={{ flex: 1, overflow: 'auto' }}>
          {attempt.gameType === 'tap' && <TapGame game={game} spec={attempt.spec} locked={locked} onTap={onMgTap} />}
          {attempt.gameType === 'memory' && <MemGame game={game} locked={locked} onPad={onMemPad} />}
          {attempt.gameType === 'math' && <MathGame game={game} locked={locked} onPick={onMathPick} />}
          {attempt.gameType === 'sequence' && <SeqGame game={game} locked={locked} onTap={onSeqTap} />}
        </div>
      )}

      {isOver && (
        <div
          onClick={onExit}
          style={{
            flexShrink: 0, marginTop: 16,
            border: '4px solid #0C0C10', background: 'var(--card)',
            boxShadow: '5px 5px 0 #0C0C10', padding: 15, textAlign: 'center',
            fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10',
            cursor: 'pointer', animation: 'lg-rise .2s ease-out',
          }}
        >
          ← BACK TO GRID
        </div>
      )}
    </div>
  );
}
