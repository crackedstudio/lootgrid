import { useState } from 'react';

function ChipRow({ options, active, color, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {options.map(opt => {
        const isActive = active === opt.v;
        return (
          <div
            key={opt.v}
            onClick={() => onChange(opt.v)}
            style={{
              border: `2.5px solid ${isActive ? color : '#0C0C10'}`,
              background: isActive ? color : 'transparent',
              padding: '6px 12px',
              fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
              color: isActive ? '#0C0C10' : 'var(--cream)',
              cursor: 'pointer', transition: 'all .12s',
            }}
          >{opt.l}</div>
        );
      })}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: '.16em', color: 'var(--cream)', opacity: .55, marginBottom: 10 }}>{label}</div>
      {children}
    </div>
  );
}

export default function HuntsScreen() {
  const [prize, setPrize] = useState('10.00');
  const [token, setToken] = useState('USDm');
  const [diff, setDiff] = useState('med');
  const [dur, setDur] = useState('24h');

  return (
    <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flexShrink: 0, padding: '16px 16px 14px', borderBottom: '3px solid #0C0C10', background: 'var(--card)' }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: '.18em', color: '#0C0C10', opacity: .55 }}>CREATE</div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 22, color: '#0C0C10', lineHeight: 1, marginTop: 2 }}>A HUNT</div>
      </div>

      <div style={{ flex: 1, padding: 16 }}>
        {/* Say plainly that this doesn't do anything yet, rather than fake an
            escrow step that moves no money. */}
        <div style={{
          border: '3px solid #FF7A1A', background: 'rgba(255,122,26,.1)', padding: '12px 14px',
          marginBottom: 20, fontFamily: "'Space Grotesk', sans-serif", fontSize: 12,
          lineHeight: 1.5, color: 'var(--cream)',
        }}>
          <strong style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 12 }}>NOT LIVE YET</strong><br />
          Creating a hunt needs the escrow contract, which isn't deployed. Nothing here
          locks funds or publishes anything — the grid is stocked by the server for now.
        </div>

        <div style={{ border: '4px solid #FFD51F', padding: '18px 20px', marginBottom: 24, display: 'flex', alignItems: 'baseline', gap: 10, opacity: .6 }}>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 46, color: 'var(--cream)', lineHeight: 1 }}>${prize}</div>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#FFD51F' }}>{token}</div>
        </div>

        <div style={{ opacity: .6, pointerEvents: 'none' }}>
          <Field label="PRIZE AMOUNT">
            <ChipRow options={[{l:'$1',v:'1.00'},{l:'$5',v:'5.00'},{l:'$10',v:'10.00'},{l:'$25',v:'25.00'},{l:'$50',v:'50.00'}]} active={prize} color="#FF7A1A" onChange={setPrize} />
          </Field>

          {/* USDm/USDC/USDT — CELO is gone: a prize in a volatile asset makes the
              advertised dollar figure wrong by the time somebody wins it. */}
          <Field label="TOKEN">
            <ChipRow options={[{l:'USDm',v:'USDm'},{l:'USDC',v:'USDC'},{l:'USDT',v:'USDT'}]} active={token} color="#0C0C10" onChange={setToken} />
          </Field>

          <Field label="DIFFICULTY">
            <ChipRow options={[{l:'EASY',v:'easy'},{l:'MED',v:'med'},{l:'HARD',v:'hard'}]} active={diff} color="#8A3DFF" onChange={setDiff} />
          </Field>

          <Field label="DURATION">
            <ChipRow options={[{l:'6h',v:'6h'},{l:'24h',v:'24h'},{l:'3 DAYS',v:'3d'}]} active={dur} color="#29E6E6" onChange={setDur} />
          </Field>
        </div>

        <div style={{
          border: '4px solid #0C0C10', background: 'rgba(245,239,227,.1)',
          padding: 16, textAlign: 'center',
          fontFamily: "'Archivo Black', sans-serif", fontSize: 16,
          color: 'rgba(245,239,227,.3)', cursor: 'not-allowed', marginBottom: 24,
        }}>
          PUBLISH TO THE GRID
        </div>
      </div>
    </div>
  );
}
