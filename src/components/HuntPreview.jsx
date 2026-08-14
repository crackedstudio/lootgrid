import Mascot from './Mascot';

/**
 * The price, shown before the wallet is ever prompted.
 *
 * A 402 arrives mid-entry, so this appears in place of the enter button and the
 * request waits on the answer. Two things it must say plainly: what the fee is,
 * and that energy would have covered it — the free route exists and a player
 * who does not know that has effectively been charged for nothing.
 */
function PaymentStep({ quote, onPay, onClose }) {
  return (
    <>
      <div style={{
        border: '3px solid #FFD51F', background: 'rgba(255,213,31,.1)',
        padding: '14px 16px', marginBottom: 16,
      }}>
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.14em', color: '#FFD51F' }}>
          ENTRY FEE
        </div>
        <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 34, lineHeight: 1.1, color: 'var(--cream)', marginTop: 4 }}>
          {quote.price}
        </div>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 12, lineHeight: 1.5, color: 'var(--cream)', opacity: .7, marginTop: 8 }}>
          Your energy is spent, so this hunt costs money to enter. One signature —
          no gas, and nothing leaves your wallet until the payment settles.
        </div>
      </div>

      <div onClick={onPay} style={{
        border: '4px solid #0C0C10', background: '#2CE66A',
        boxShadow: '5px 5px 0 #0C0C10', padding: 16, textAlign: 'center',
        fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10', cursor: 'pointer',
      }}>
        → PAY {quote.price} AND ENTER
      </div>

      <div onClick={onClose} style={{
        marginTop: 12, textAlign: 'center', fontFamily: "'Space Mono', monospace",
        fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
        color: 'var(--cream)', opacity: .5, cursor: 'pointer',
      }}>
        NO THANKS — WAIT FOR ENERGY
      </div>
    </>
  );
}

export default function HuntPreview({ hunt, onConfirm, onClose, onPay }) {
  if (!hunt) return null;
  const isCash = hunt.kind === 'cash';
  const cost = isCash ? 3 : 2;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 65, background: 'rgba(12,12,16,.88)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div style={{
        width: '100%', background: 'var(--deep)', border: '4px solid #0C0C10',
        borderBottom: 'none', padding: '26px 22px 28px',
        animation: 'lg-rise .25s ease-out',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.16em', color: 'var(--cream)', opacity: .55 }}>
            {isCash ? 'TREASURE HUNT' : 'PUZZLE HUNT'}
          </div>
          <div onClick={onClose} style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700, color: 'var(--cream)', opacity: .5, cursor: 'pointer' }}>✕ CLOSE</div>
        </div>

        <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 22 }}>
          <div style={{ animation: 'lg-bob 1.4s ease-in-out infinite' }}>
            <Mascot color={isCash ? '#FFD51F' : '#8A3DFF'} mole size={62} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 28, lineHeight: 1, color: isCash ? '#FFD51F' : '#8A3DFF' }}>
              {hunt.prizeLabel}
            </div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: 'var(--cream)', opacity: .55, marginTop: 6 }}>
              {isCash ? 'PRE-FUNDED PRIZE' : 'PUZZLE REWARD'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
          <div style={{ flex: 1, border: '2px solid rgba(245,239,227,.15)', padding: '10px 12px' }}>
            {/* Real, from the server — how many people have a live attempt open. */}
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: 'var(--cream)' }}>{hunt.chasers ?? 0}</div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: 'var(--cream)', opacity: .45, marginTop: 4 }}>CHASING NOW</div>
          </div>
          <div style={{ flex: 1, border: '2px solid rgba(245,239,227,.15)', padding: '10px 12px' }}>
            <div style={{ fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#FF3D3D' }}>{cost}⚡</div>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, fontWeight: 700, color: 'var(--cream)', opacity: .45, marginTop: 4 }}>COST</div>
          </div>
        </div>

        {/* You don't learn which game it is until you commit — knowing in advance
            would let you warm up for one and skip the others. */}
        <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color: 'var(--cream)', opacity: .4, marginBottom: 18, lineHeight: 1.5 }}>
          The challenge is fixed to this block — everyone racing it plays the same game.
        </div>

        {hunt.quote ? (
          <PaymentStep quote={hunt.quote} onPay={onPay} onClose={onClose} />
        ) : (
          <div onClick={onConfirm} style={{
            border: '4px solid #0C0C10', background: isCash ? '#FFD51F' : '#8A3DFF',
            boxShadow: '5px 5px 0 #0C0C10', padding: '16px', textAlign: 'center',
            fontFamily: "'Archivo Black', sans-serif", fontSize: 17, color: '#0C0C10', cursor: 'pointer',
          }}>
            {isCash ? '→ ENTER HUNT' : '→ SOLVE PUZZLE'}
          </div>
        )}
      </div>
    </div>
  );
}
