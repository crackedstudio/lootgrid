import { useCallback, useEffect, useState } from 'react';
import {
  CONFIG_FIELDS,
  centsToUsd,
  configureAgent,
  fetchAgent,
  fetchLedger,
  millsToUsd,
  resumeAgent,
  sendPrepared,
  setupAgent,
  statusLabel,
  stopAgent,
  vaultAction,
} from '../api/agent';

/**
 * The agent screen.
 *
 * ─────────────────────────── what this screen owes the player ───────────────
 *
 * An agent is a program spending their money while they are not watching. Three
 * things therefore have to be true of every pixel here:
 *
 *   1. **The limits are visible before the money is.** Caps come first, balance
 *      second. A screen that leads with a deposit button is a screen that
 *      encourages funding something whose bounds you have not read.
 *   2. **Stop is never more than one tap away**, at the top, in red, on every
 *      tab — not buried behind a settings accordion.
 *   3. **It never claims more than it has done.** Stopping the agent server-side
 *      is instant; revoking its on-chain spending rights is a transaction the
 *      player has to send, and until it lands this screen says so.
 *
 * The configuration is numbers only. There is no "strategy notes" box and there
 * must never be one: it would be a string the player controls reaching a model
 * that can spend their money — the same hole the A2A protocol and the hint
 * schema are shaped to avoid.
 */

const MONO = "'Space Mono', monospace";
const BLACK = "'Archivo Black', sans-serif";
const CARD = { border: '3px solid #0C0C10', background: 'var(--card)', padding: 14, marginBottom: 12 };

function Label({ children, dark }) {
  return (
    <div style={{
      fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '.16em',
      color: dark ? '#0C0C10' : 'var(--cream)', opacity: .55,
    }}>{children}</div>
  );
}

function Button({ children, onClick, color = '#FFD51F', disabled, wide }) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        border: `3px solid ${disabled ? 'rgba(12,12,16,.3)' : '#0C0C10'}`,
        background: disabled ? 'transparent' : color,
        padding: '10px 12px', textAlign: 'center',
        fontFamily: BLACK, fontSize: 12, color: disabled ? 'rgba(12,12,16,.35)' : '#0C0C10',
        cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none',
        flex: wide ? '1 1 100%' : 1,
      }}
    >{children}</div>
  );
}

/** A bounded number. The only kind of instruction an agent takes. */
function Knob({ field, value, onChange, disabled }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Label dark>{field.label}</Label>
        <div style={{ fontFamily: BLACK, fontSize: 14, color: '#0C0C10' }}>
          {value}{field.unit ?? ''}
        </div>
      </div>
      <input
        type="range"
        min={field.min}
        max={field.max}
        value={value}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#8A3DFF', marginTop: 6 }}
      />
      {field.help && (
        <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5 }}>
          {field.help}
        </div>
      )}
    </div>
  );
}

export default function AgentScreen() {
  const [agent, setAgent] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [draft, setDraft] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  /** Set when the agent is stopped here but not yet revoked on chain. */
  const [revokePending, setRevokePending] = useState(null);

  const load = useCallback(
    () => Promise.all([fetchAgent(), fetchLedger().catch(() => null)]),
    [],
  );

  const apply = useCallback(([a, l]) => {
    setAgent(a);
    setLedger(l);
    setDraft(d => d ?? { ...a.config });
  }, []);

  useEffect(() => {
    let alive = true;
    load()
      .then(data => alive && apply(data))
      .catch(err => alive && setNote(err?.code === 'agents_disabled' ? 'Agents are not open yet.' : err?.code))
      .finally(() => {});
    return () => {
      alive = false;
    };
  }, [load, apply]);

  const run = async (fn, ok) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (ok) setNote(ok);
      apply(await load());
    } catch (err) {
      // Money path: failures are shown, never swallowed.
      setNote(err?.code || err?.message || 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  if (!agent) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)' }}>
        <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: 'var(--cream)', opacity: .6 }}>
          {note ?? 'LOADING AGENT…'}
        </div>
      </div>
    );
  }

  const stopped = agent.status === 'killed';
  const funded = Boolean(agent.vault);
  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(agent.config);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '16px 16px 14px', borderBottom: '3px solid #0C0C10', background: 'var(--card)' }}>
        <Label dark>YOUR AGENT · {statusLabel(agent).toUpperCase()}</Label>
        <div style={{ fontFamily: BLACK, fontSize: 22, color: '#0C0C10', lineHeight: 1, marginTop: 2 }}>
          SPENDS, NEVER HOLDS
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5, marginTop: 6 }}>
          {agent.id}
        </div>
      </div>

      {/* Stop is at the top, in red, always reachable. */}
      {funded && !stopped && (
        <div
          onClick={busy ? undefined : () => run(async () => {
            const result = await stopAgent();
            setRevokePending(result.call ?? null);
          }, 'Stopped. Now revoke its spending rights on chain.')}
          style={{
            flexShrink: 0, padding: '12px 16px', background: '#FF3D3D',
            borderBottom: '3px solid #0C0C10', textAlign: 'center', cursor: 'pointer',
            fontFamily: BLACK, fontSize: 14, color: '#0C0C10',
          }}
        >
          ■ STOP THIS AGENT
        </div>
      )}

      {revokePending && (
        <div style={{
          flexShrink: 0, padding: '12px 16px', borderBottom: '3px solid #0C0C10',
          background: 'rgba(255,61,61,.14)',
        }}>
          <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.6, color: 'var(--cream)' }}>
            STOPPED HERE — <strong>NOT YET ON CHAIN</strong>. Until you send this,
            it can still spend within its caps.
          </div>
          <div style={{ display: 'flex', marginTop: 10 }}>
            <Button
              color="#FF3D3D"
              disabled={busy}
              onClick={() => run(async () => {
                // Revoke FIRST, then empty it. The other order leaves a window
                // in which the vault is refilled-by-nobody but still has a
                // spender, and this is the path that runs during an incident.
                await sendPrepared(revokePending);
                await vaultAction('withdrawAll').catch(() => {});
                setRevokePending(null);
              }, 'Revoked and withdrawn.')}
            >REVOKE + WITHDRAW EVERYTHING</Button>
          </div>
        </div>
      )}

      {note && (
        <div style={{
          flexShrink: 0, padding: '10px 14px', borderBottom: '3px solid #0C0C10',
          background: 'rgba(255,213,31,.14)', fontFamily: MONO, fontSize: 10,
          fontWeight: 700, color: 'var(--cream)',
        }}>{note}</div>
      )}

      <div className="lg-scroll" style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {/* Limits before money: read the bounds before funding the thing. */}
        <div style={CARD}>
          <Label dark>LIMITS</Label>
          <div style={{ height: 10 }} />
          {CONFIG_FIELDS.map(field => (
            <Knob
              key={field.key}
              field={field}
              value={draft?.[field.key] ?? agent.config[field.key]}
              disabled={busy || stopped}
              onChange={v => setDraft(d => ({ ...d, [field.key]: v }))}
            />
          ))}

          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              disabled={!dirty || busy}
              onClick={() => run(() => configureAgent(draft), 'Limits saved.')}
            >SAVE LIMITS</Button>
            {funded && (
              <Button
                color="#29E6E6"
                disabled={busy}
                onClick={() => run(
                  () => vaultAction('setCaps', {
                    perTxCents: draft.maxHintPriceCents,
                    perDayCents: draft.dailyBudgetCents,
                  }),
                  'Caps updated on chain.',
                )}
              >PUSH CAPS ON CHAIN</Button>
            )}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5, marginTop: 8, lineHeight: 1.5 }}>
            Saving here stops bad trades early. The caps that actually bind live
            in your vault — push them to change what it can spend.
          </div>
        </div>

        {/* Money second. */}
        <div style={CARD}>
          <Label dark>TODAY</Label>
          <div style={{ fontFamily: BLACK, fontSize: 26, color: '#0C0C10', marginTop: 4 }}>
            {millsToUsd(agent.remainingMills)}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5 }}>
            LEFT OF {centsToUsd(agent.config.dailyBudgetCents)} — HINTS AND THINKING TOGETHER
          </div>

          {!funded && (
            <div style={{ marginTop: 12 }}>
              <Button
                disabled={busy}
                wide
                onClick={() => run(async () => {
                  const { hash } = await setupAgent();
                  void hash;
                }, 'Agent bound and vault created. Fund it to let it trade.')}
              >CREATE ITS VAULT</Button>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5, marginTop: 8, lineHeight: 1.5 }}>
                Two transactions you sign: one binds the agent, one creates a
                vault you own. It can spend from that vault and never withdraw
                from it.
              </div>
            </div>
          )}

          {funded && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Button
                color="#2CE66A"
                disabled={busy}
                onClick={() => run(() => vaultAction('withdrawAll'), 'Withdrawn.')}
              >WITHDRAW ALL</Button>
              {stopped && (
                <Button
                  color="#B7FF3B"
                  disabled={busy}
                  onClick={() => run(() => resumeAgent(), 'Running again.')}
                >RESUME</Button>
              )}
            </div>
          )}
        </div>

        {ledger?.entries?.length > 0 && (
          <div style={CARD}>
            <Label dark>WHAT IT HAS SPENT</Label>
            <div style={{ height: 8 }} />
            {ledger.entries.slice(0, 12).map(entry => (
              <div key={entry.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .7 }}>
                  {entry.kind === 'hint' ? 'HINT' : 'THINKING'}
                  {entry.huntId ? ` · ${entry.huntId.slice(0, 14)}` : ''}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: '#0C0C10' }}>
                  {millsToUsd(entry.amountMills)}
                </div>
              </div>
            ))}
          </div>
        )}

        {!agent.inferenceLive && (
          <div style={{ ...CARD, borderColor: '#FF7A1A' }}>
            <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.6, color: '#0C0C10' }}>
              Thinking is switched off, so your agent plays a simple deterministic
              line instead of reasoning. It still competes; it just will not be
              clever, and it costs nothing while this is the case.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
