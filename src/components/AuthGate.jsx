import { useEffect, useState } from 'react';
import Mascot from './Mascot';
import {
  connectWallet,
  bindSessionKey,
  isAuthenticated,
  isBoundOnChain,
  getPlayerId,
  getSessionAccount,
  resetPlayerId,
  listWallets,
} from '../api/session';

/**
 * The login, such as it is.
 *
 * Two steps, and the second one costs gas exactly once. The wallet connects,
 * then sends a transaction saying "this browser's key speaks for me". After
 * that the wallet is never needed again for gameplay — every request is signed
 * locally by the session key, which is the only way a tap-to-dig game can work
 * on a wallet that cannot sign messages.
 *
 * Blocks the app because there is nothing to show without it: with AUTH_MODE=
 * chain the server rejects every unsigned request, so an unauthenticated UI
 * would be a screen of failed calls.
 */

const BTN = {
  border: '4px solid #0C0C10', background: '#FFD51F', boxShadow: '5px 5px 0 #FF3BBD',
  padding: '14px 26px', fontFamily: "'Archivo Black', sans-serif", fontSize: 15,
  color: '#0C0C10', cursor: 'pointer', textAlign: 'center',
};
const NOTE = {
  fontFamily: "'Space Mono', monospace", fontSize: 11, color: 'var(--cream)',
  opacity: .45, textAlign: 'center', lineHeight: 1.6, maxWidth: 300,
};

export default function AuthGate({ children }) {
  const [phase, setPhase] = useState('checking'); // checking|connect|bind|ready
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [wallets, setWallets] = useState([]);

  // EIP-6963 providers announce on an event, so the list is empty on the first
  // render and populated a tick later. Re-read shortly after mount rather than
  // rendering "no wallet found" at somebody who has three installed.
  useEffect(() => {
    const t = setTimeout(() => setWallets(listWallets()), 300);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    (async () => {
      if (!isAuthenticated()) return setPhase('connect');
      try {
        setPhase((await isBoundOnChain()) ? 'ready' : 'bind');
      } catch {
        // An RPC hiccup must not strand the player on a blank gate; let them
        // retry the bind rather than guessing that it worked.
        setPhase('bind');
      }
    })();
  }, []);

  const run = (fn, next) => async (...args) => {
    setBusy(true); setError(null);
    try {
      await fn(...args);
      setPhase(next);
    } catch (e) {
      // Wallet rejections are ordinary, not faults. Show what happened and let
      // them try again.
      setError(e?.shortMessage || e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'ready') return children;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 96, background: '#0C0C10',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: 28, gap: 14,
    }}>
      <div style={{ animation: 'lg-bob 1.6s ease-in-out infinite' }}>
        <Mascot color="#FFD51F" size={64} />
      </div>

      <div style={{
        fontFamily: "'Archivo Black', sans-serif", fontSize: 26, lineHeight: 1.1,
        color: 'var(--cream)', textAlign: 'center',
      }}>
        {phase === 'checking' ? 'CHECKING…' : phase === 'connect' ? 'CONNECT WALLET' : 'ONE-TIME SETUP'}
      </div>

      <div style={{
        fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, lineHeight: 1.5,
        color: 'var(--cream)', opacity: .72, textAlign: 'center', maxWidth: 300,
      }}>
        {phase === 'checking' && 'Looking for your session key.'}
        {phase === 'connect' && (wallets.length > 1
          ? 'LOOTGRID plays as your wallet. Choose which one.'
          : 'LOOTGRID plays as your wallet. Connect one to begin. Celo will be added automatically if your wallet does not have it.')}
        {phase === 'bind' &&
          'Register this device once, on-chain. After this you never sign again — digging stays a single tap.'}
      </div>

      {phase === 'connect' && (
        wallets.length > 1 ? (
          // More than one wallet installed: let them pick, because `window.
          // ethereum` would otherwise hand them whichever extension loaded last.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 300 }}>
            {wallets.map(w => (
              <div key={w.rdns} style={{ ...BTN, opacity: busy ? .5 : 1,
                     display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}
                   onClick={busy ? undefined : () => run(connectWallet, 'bind')(w.rdns)}>
                {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
                {w.name.toUpperCase()}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...BTN, opacity: busy ? .5 : 1 }}
               onClick={busy ? undefined : () => run(connectWallet, 'bind')(wallets[0]?.rdns)}>
            {busy ? 'CONNECTING…' : wallets[0] ? `CONNECT ${wallets[0].name.toUpperCase()}` : 'CONNECT'}
          </div>
        )
      )}

      {phase === 'bind' && (
        <>
          <div style={{ ...BTN, opacity: busy ? .5 : 1 }}
               onClick={busy ? undefined : run(bindSessionKey, 'ready')}>
            {busy ? 'CONFIRM IN WALLET…' : 'REGISTER DEVICE'}
          </div>
          <div style={NOTE}>
            wallet&nbsp;&nbsp;{getPlayerId()?.slice(0, 10)}…<br />
            this device&nbsp;&nbsp;{getSessionAccount().address.slice(0, 10)}…
          </div>
          <div style={{ ...NOTE, opacity: .3, cursor: 'pointer' }}
               onClick={() => { resetPlayerId(); setPhase('connect'); }}>
            use a different wallet
          </div>
        </>
      )}

      {error && (
        <div style={{
          fontFamily: "'Space Mono', monospace", fontSize: 11, lineHeight: 1.5,
          color: '#FF3D3D', border: '2px solid #FF3D3D', padding: '8px 10px',
          maxWidth: 300, textAlign: 'center', marginTop: 4,
        }}>
          {error}
        </div>
      )}
    </div>
  );
}
