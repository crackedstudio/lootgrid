import Mascot from './Mascot';

/**
 * Hard-fails when the referee is unreachable.
 *
 * There is deliberately no offline mode. A client that quietly falls back to
 * fake local state looks identical to a working one, which makes it impossible
 * to tell whether the server is actually doing anything.
 */
export default function ConnectionGate({ fatal, status }) {
  if (!fatal && status !== 'offline') return null;

  const offline = !fatal && status === 'offline';

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 95, background: '#0C0C10',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 28, gap: 14,
    }}>
      <div style={{ animation: 'lg-bob 1.6s ease-in-out infinite' }}>
        <Mascot color="#FF3D3D" mole size={64} />
      </div>

      <div style={{
        fontFamily: "'Archivo Black', sans-serif", fontSize: 26, lineHeight: 1.1,
        color: 'var(--cream)', textAlign: 'center',
      }}>
        {offline ? 'RECONNECTING…' : 'GRID UNREACHABLE'}
      </div>

      <div style={{
        fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, lineHeight: 1.5,
        color: 'var(--cream)', opacity: .72, textAlign: 'center', maxWidth: 280,
      }}>
        {offline
          ? 'Lost the connection to the grid. Trying to get back in.'
          : 'The LOOTGRID server is not responding. The map, your energy and every race live there — there is nothing to play without it.'}
      </div>

      {fatal && (
        <>
          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 9, fontWeight: 700,
            letterSpacing: '.12em', color: '#FF3D3D', border: '2px solid #FF3D3D',
            padding: '6px 10px', marginTop: 4,
          }}>
            {fatal.code}
          </div>

          <div
            onClick={() => window.location.reload()}
            style={{
              marginTop: 10, border: '4px solid #0C0C10', background: '#FFD51F',
              boxShadow: '5px 5px 0 #FF3BBD', padding: '14px 26px',
              fontFamily: "'Archivo Black', sans-serif", fontSize: 15, color: '#0C0C10',
              cursor: 'pointer',
            }}
          >
            TRY AGAIN
          </div>

          <div style={{
            fontFamily: "'Space Mono', monospace", fontSize: 9, color: 'var(--cream)',
            opacity: .4, marginTop: 8, textAlign: 'center', lineHeight: 1.6,
          }}>
            start the referee with:<br />cd server && npm run dev
          </div>
        </>
      )}
    </div>
  );
}
