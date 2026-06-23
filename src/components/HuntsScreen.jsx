export default function HuntsScreen({ state, setField, onDeposit, onPublish }) {
  const { chPrize, chToken, chDiff, chDur, chDeposited } = state;

  function ChipRow({ field, options, active, color, onChange }) {
    return (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.map(opt => {
          const isActive = active === opt.v;
          return (
            <div
              key={opt.v}
              onClick={() => onChange(field, opt.v)}
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
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: 'var(--cream)', opacity: .55, marginBottom: 10 }}>{label}</div>
        {children}
      </div>
    );
  }

  return (
    <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      {/* header */}
      <div style={{ flexShrink: 0, padding: '16px 16px 14px', borderBottom: '3px solid #0C0C10', background: 'var(--card)' }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.18em', color: '#0C0C10', opacity: .55 }}>CREATE</div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 22, color: '#0C0C10', lineHeight: 1, marginTop: 2 }}>A HUNT</div>
      </div>

      <div style={{ flex: 1, padding: 16 }}>
        {/* prize display */}
        <div style={{ border: '4px solid #FFD51F', padding: '18px 20px', marginBottom: 24, display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 46, color: 'var(--cream)', lineHeight: 1 }}>${chPrize}</div>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#FFD51F' }}>{chToken}</div>
        </div>

        <Field label="PRIZE AMOUNT">
          <ChipRow field="chPrize" options={[{l:'$1',v:'1.00'},{l:'$5',v:'5.00'},{l:'$10',v:'10.00'},{l:'$25',v:'25.00'},{l:'$50',v:'50.00'}]} active={chPrize} color="#FF7A1A" onChange={setField} />
        </Field>

        <Field label="TOKEN">
          <ChipRow field="chToken" options={[{l:'cUSD',v:'cUSD'},{l:'USDT',v:'USDT'},{l:'CELO',v:'CELO'}]} active={chToken} color="#0C0C10" onChange={setField} />
        </Field>

        <Field label="DIFFICULTY">
          <ChipRow field="chDiff" options={[{l:'EASY',v:'easy'},{l:'MED',v:'med'},{l:'HARD',v:'hard'}]} active={chDiff} color="#8A3DFF" onChange={setField} />
        </Field>

        <Field label="DURATION">
          <ChipRow field="chDur" options={[{l:'6h',v:'6h'},{l:'24h',v:'24h'},{l:'3 DAYS',v:'3d'}]} active={chDur} color="#29E6E6" onChange={setField} />
        </Field>

        {/* escrow step */}
        <div style={{ border: '3px solid #0C0C10', background: chDeposited ? 'rgba(44,230,106,.12)' : 'rgba(245,239,227,.05)', padding: '16px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ width: 20, height: 20, border: '2.5px solid #0C0C10', background: chDeposited ? '#2CE66A' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Archivo Black', sans-serif", fontSize: 12, color: '#0C0C10' }}>
              {chDeposited ? '✓' : '1'}
            </div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)' }}>LOCK PRIZE IN ESCROW</div>
          </div>
          {!chDeposited && (
            <div onClick={onDeposit} style={{ border: '3px solid #0C0C10', background: '#FFD51F', boxShadow: '4px 4px 0 #0C0C10', padding: '12px', textAlign: 'center', fontFamily: "'Archivo Black', sans-serif", fontSize: 14, color: '#0C0C10', cursor: 'pointer' }}>
              LOCK ${chPrize} {chToken}
            </div>
          )}
          {chDeposited && (
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color: '#2CE66A', fontWeight: 700 }}>${chPrize} {chToken} locked on-chain ✓</div>
          )}
        </div>

        <div onClick={chDeposited ? onPublish : undefined} style={{
          border: '4px solid #0C0C10', background: chDeposited ? '#FF7A1A' : 'rgba(245,239,227,.1)',
          boxShadow: chDeposited ? '5px 5px 0 #0C0C10' : 'none',
          padding: 16, textAlign: 'center',
          fontFamily: "'Archivo Black', sans-serif", fontSize: 16,
          color: chDeposited ? '#0C0C10' : 'rgba(245,239,227,.3)',
          cursor: chDeposited ? 'pointer' : 'not-allowed',
          marginBottom: 24,
        }}>
          PUBLISH TO THE GRID
        </div>
      </div>
    </div>
  );
}
