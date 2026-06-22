import Mascot from './Mascot';

function RivalBars({ rivals, showRivals, lostTo }) {
  if (!showRivals && !lostTo) return null;
  return (
    <div style={{ padding: '10px 0', borderBottom: '2px solid rgba(245,239,227,.12)', marginBottom: 12 }}>
      <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .5, marginBottom: 8 }}>
        {rivals.length} RIVALS CHASING
      </div>
      {rivals.map(r => (
        <div key={r.handle} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: r.color, width: 52, flexShrink: 0 }}>{r.handle}</div>
          <div style={{ flex: 1, height: 8, background: 'rgba(245,239,227,.1)', border: '1.5px solid #0C0C10', overflow: 'hidden' }}>
            <div style={{ height: '100%', background: r.color, width: `${r.pct}%`, transition: 'width .2s linear' }} />
          </div>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color: r.color, width: 32, textAlign: 'right', flexShrink: 0 }}>{r.pct}%</div>
        </div>
      ))}
    </div>
  );
}

function TimerBar({ pct, timeLabel }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: 'var(--cream)', opacity: .55 }}>TIME</div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 14, color: pct < 30 ? '#FF3D3D' : '#FF7A1A' }}>{timeLabel}</div>
      </div>
      <div style={{ height: 8, border: '2px solid #0C0C10', background: 'rgba(245,239,227,.1)', overflow: 'hidden' }}>
        <div style={{ height: '100%', background: pct < 30 ? '#FF3D3D' : '#FF7A1A', width: `${pct}%`, transition: 'width .1s linear' }} />
      </div>
    </div>
  );
}

/* -------- TAP GAME -------- */
function TapGame({ state, onTap }) {
  const { mgTaps, mgTarget, mgTime, mgFail } = state;
  const segs = 14;
  const pct = (mgTaps / mgTarget) * 100;
  const timePct = (mgTime / 6.0) * 100;

  return (
    <>
      <TimerBar pct={timePct} timeLabel={`${mgTime.toFixed(1)}s`} />
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: 'var(--cream)', opacity: .6 }}>
          {mgFail ? 'TOO SLOW — TRY THE NEXT ONE' : 'MASH TO CRACK IT'}
        </div>
      </div>
      {/* progress segs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, justifyContent: 'center' }}>
        {Array.from({ length: segs }).map((_, i) => (
          <div key={i} style={{ width: 16, height: 22, border: '2px solid #0C0C10', background: i < Math.round((mgTaps / mgTarget) * segs) ? '#FFD51F' : 'rgba(245,239,227,.08)' }} />
        ))}
      </div>
      {/* big tap button */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
        <div
          onClick={!mgFail ? onTap : undefined}
          style={{
            width: 190, height: 190,
            background: mgFail ? 'var(--card)' : '#FFD51F',
            border: '5px solid #0C0C10',
            boxShadow: mgFail ? '8px 8px 0 rgba(12,12,16,.3)' : '10px 10px 0 #0C0C10',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: mgFail ? 'not-allowed' : 'pointer',
            userSelect: 'none',
            animation: mgFail ? 'lg-shake .4s ease' : undefined,
            transition: 'background .2s',
          }}
        >
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 38, color: '#0C0C10' }}>
            {mgFail ? '✗' : '👊'}
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'center', fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#FFD51F' }}>
        {mgTaps} / {mgTarget} TAPS
      </div>
    </>
  );
}

/* -------- MEMORY GAME -------- */
const MEM_COLORS = ['#FF3D3D', '#FFD51F', '#2CE66A', '#2F6BFF'];

function MemGame({ state, onPad }) {
  const { memSeq, memInput, memPhase, memLit, mgFail } = state;

  return (
    <>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .6 }}>
          {memPhase === 'watch' ? 'WATCH THE SEQUENCE' : mgFail ? 'WRONG ORDER — FAILED' : `REPEAT: ${memInput}/${memSeq.length}`}
        </div>
      </div>
      {/* dots progress */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 28 }}>
        {memSeq.map((_, i) => (
          <div key={i} style={{ width: 12, height: 12, border: '2.5px solid var(--cream)', background: i < memInput ? '#FFD51F' : 'transparent' }} />
        ))}
      </div>
      {/* 2×2 pads */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, maxWidth: 220, margin: '0 auto 24px' }}>
        {MEM_COLORS.map((color, i) => (
          <div
            key={i}
            onClick={() => memPhase === 'input' && !mgFail && onPad(i)}
            style={{
              height: 90, background: memLit === i ? color : `${color}33`,
              border: `3px solid ${memLit === i ? color : '#0C0C10'}`,
              boxShadow: memLit === i ? `0 0 18px ${color}88` : 'none',
              cursor: memPhase === 'input' && !mgFail ? 'pointer' : 'default',
              transition: 'all .08s',
            }}
          />
        ))}
      </div>
    </>
  );
}

/* -------- MATH GAME -------- */
function MathGame({ state, onPick }) {
  const { mathQ, mathOpts, mathAns, mathPick, mathStreak, mgFail } = state;

  return (
    <>
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .55, marginBottom: 8 }}>
          SOLVE 3 IN A ROW
        </div>
        {/* streak dots */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 16 }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ width: 16, height: 16, border: '2.5px solid var(--cream)', background: i < mathStreak ? '#2CE66A' : 'transparent' }} />
          ))}
        </div>
      </div>
      {/* question */}
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 52, lineHeight: 1, color: 'var(--cream)', letterSpacing: '-.02em' }}>{mathQ}</div>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, color: 'var(--cream)', opacity: .4, marginTop: 8 }}>=  ?</div>
      </div>
      {/* answer grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, maxWidth: 240, margin: '0 auto 20px' }}>
        {mathOpts.map((opt, i) => {
          const isCorrect = opt === mathAns;
          const isPicked = opt === mathPick;
          const showResult = mathPick !== -1;
          let bg = 'rgba(245,239,227,.08)';
          let border = '3px solid #0C0C10';
          if (showResult && isPicked) {
            bg = isCorrect ? '#2CE66A' : '#FF3D3D';
            border = `3px solid ${isCorrect ? '#2CE66A' : '#FF3D3D'}`;
          }
          return (
            <div
              key={i}
              onClick={() => !showResult && !mgFail && onPick(opt)}
              style={{
                padding: '18px 12px', textAlign: 'center', background: bg, border,
                fontFamily: "'Archivo Black', sans-serif", fontSize: 22, color: 'var(--cream)',
                cursor: !showResult && !mgFail ? 'pointer' : 'default',
                transition: 'all .12s',
              }}
            >{opt}</div>
          );
        })}
      </div>
      {mgFail && (
        <div style={{ textAlign: 'center', fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, color: '#FF3D3D' }}>
          WRONG ANSWER — HUNT FAILED
        </div>
      )}
    </>
  );
}

/* -------- SEQUENCE GAME -------- */
function SeqGame({ state, onTap }) {
  const { seqTiles, seqNext, seqN, mgFail } = state;

  return (
    <>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .55 }}>
          TAP IN ORDER: 1 → {seqN}
        </div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 26, color: 'var(--cream)', marginTop: 6 }}>
          NEXT: {mgFail ? '✗' : seqNext}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', margin: '16px 0 24px' }}>
        {seqTiles.map(tile => (
          <div
            key={tile.id}
            onClick={() => !mgFail && !tile.tapped && onTap(tile)}
            style={{
              width: 72, height: 72,
              background: tile.tapped ? '#2CE66A' : tile.color,
              border: `4px solid #0C0C10`,
              boxShadow: tile.tapped ? 'none' : '4px 4px 0 #0C0C10',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: "'Archivo Black', sans-serif", fontSize: 26, color: '#0C0C10',
              cursor: !tile.tapped && !mgFail ? 'pointer' : 'default',
              opacity: tile.tapped ? .5 : 1,
              transition: 'all .12s',
            }}
          >
            {tile.tapped ? '✓' : tile.id}
          </div>
        ))}
      </div>
      {mgFail && (
        <div style={{ textAlign: 'center', fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, color: '#FF3D3D' }}>
          WRONG ORDER — HUNT FAILED
        </div>
      )}
    </>
  );
}

/* -------- MAIN MINIGAME OVERLAY -------- */
export default function Minigame({ state, onMgTap, onMemPad, onMathPick, onSeqTap }) {
  const { mgType, rivals, showRivals, lostTo } = state;

  const title = { tap: 'TAP CHALLENGE', memory: 'MEMORY DIG', math: 'MATH DASH', sequence: 'SEQUENCE DIG' }[mgType] || 'CHALLENGE';

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 68, background: 'var(--deep)',
      display: 'flex', flexDirection: 'column', padding: '20px 20px 24px',
      animation: 'lg-pop .25s ease-out',
    }}>
      {/* title + mascot */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ animation: 'lg-bob 1.4s ease-in-out infinite' }}>
          <Mascot color={mgType === 'memory' ? '#8A3DFF' : '#FFD51F'} mole size={30} />
        </div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 20, color: 'var(--cream)' }}>{title}</div>
      </div>

      <RivalBars rivals={rivals} showRivals={showRivals} lostTo={lostTo} />

      {lostTo && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
        }}>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 24, color: '#FF3D3D', textAlign: 'center' }}>
            {lostTo} GOT THERE FIRST
          </div>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, color: 'var(--cream)', opacity: .7, textAlign: 'center' }}>
            Better luck on the next hunt.
          </div>
        </div>
      )}

      {!lostTo && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          {mgType === 'tap'      && <TapGame  state={state} onTap={onMgTap} />}
          {mgType === 'memory'   && <MemGame  state={state} onPad={onMemPad} />}
          {mgType === 'math'     && <MathGame state={state} onPick={onMathPick} />}
          {mgType === 'sequence' && <SeqGame  state={state} onTap={onSeqTap} />}
        </div>
      )}
    </div>
  );
}
