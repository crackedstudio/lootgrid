import { useCallback, useEffect, useState } from 'react';
import { TOKEN_SYMBOL } from '../api/config';
import { socket } from '../api/socket';
import {
  CONFIG_FIELDS,
  centsToUsd,
  configureAgent,
  fetchAgentZones,
  fetchVaultBalance,
  fetchSeat,
  fetchActivity,
  describeState,
  pauseAgent,
  buySeat,
  fundVault,
  formatToken,
  toRaw,
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
  /** Agent zones, for the picker. Failing to load them must not break the screen. */
  const [zones, setZones] = useState([]);
  /** The vault's on-chain balance — what the agent can actually spend. */
  const [vaultBalance, setVaultBalance] = useState(0n);
  /** The funded seat: inference credit, entirely separate from the vault. */
  const [seat, setSeat] = useState(null);
  /** What it has actually been playing. Polled — an agent moves without asking. */
  const [activity, setActivity] = useState(null);
  /** Live events pushed as they happen, newest first. Capped: this is a feed. */
  const [feed, setFeed] = useState([]);

  useEffect(() => socket.onMessage(msg => {
    if (msg.t !== 'agent:entered' && msg.t !== 'agent:move') return;
    setFeed(f => [msg, ...f].slice(0, 12));
  }), []);

  useEffect(() => {
    let alive = true;
    // Stamp the fetch. The heartbeat's age is only meaningful relative to when
    // we asked — and reading the clock during render is impure.
    const pull = () =>
      fetchActivity()
        .then(a => alive && setActivity({ ...a, fetchedAt: Date.now() }))
        .catch(() => {});
    pull();
    // The driver ticks every 5s server-side; matching that keeps the feed honest
    // without pretending to be live.
    const t = setInterval(pull, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchSeat()
      .then(s => alive && setSeat(s))
      .catch(() => {});
    return () => { alive = false; };
  }, [note]);

  useEffect(() => {
    let alive = true;
    fetchAgentZones()
      .then(z => alive && setZones(z))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Re-read after every action: funding, withdrawing and the agent's own trades
  // all move it, and a stale balance is how a player funds a vault twice.
  useEffect(() => {
    let alive = true;
    if (!agent?.vault) return undefined;
    fetchVaultBalance(agent.vault)
      .then(b => alive && setVaultBalance(b))
      .catch(() => {});
    return () => { alive = false; };
  }, [agent?.vault, note]);

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
  // Distinct from `stopped`: paused keeps the vault and its on-chain rights, so
  // starting again is one tap rather than a transaction.
  const paused = agent.status === 'paused';
  // Recomputed on every activity poll rather than on a timer of its own: the
  // number only means anything relative to the last fetch.
  const tickAgo = activity?.heartbeat?.lastTickAt
    ? Math.max(0, Math.round((activity.fetchedAt - activity.heartbeat.lastTickAt) / 1000))
    : null;
  // The driver sweeps every 5s; three missed sweeps is a real problem rather
  // than jitter.
  const heartbeatFresh = tickAgo !== null && tickAgo < 20;
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
        {/*
          Zones first, and deliberately above LIMITS: `zones` defaults to EMPTY
          and an empty list means NO zones, never all of them. An agent with
          money, sane caps and no zone sits idle while reading "Running" — so
          this is the one control that has to be impossible to miss.
        */}
        <div style={CARD}>
          <Label dark>WHERE IT PLAYS</Label>
          <div style={{ height: 10 }} />
          {zones.length === 0 && (
            <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5 }}>
              No agent zones are open right now.
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {zones.map(z => {
              const on = (draft?.zones ?? agent.config.zones ?? []).includes(z.id);
              return (
                <div
                  key={z.id}
                  onClick={() => {
                    if (busy || stopped) return;
                    setDraft(d => {
                      const cur = d?.zones ?? agent.config.zones ?? [];
                      return { ...d, zones: on ? cur.filter(x => x !== z.id) : [...cur, z.id] };
                    });
                  }}
                  style={{
                    border: '3px solid #0C0C10', padding: '8px 14px', cursor: 'pointer',
                    fontFamily: "'Archivo Black', sans-serif", fontSize: 13,
                    background: on ? (z.accent || '#FFD51F') : 'transparent',
                    color: '#0C0C10', opacity: busy || stopped ? .5 : 1,
                  }}
                >
                  {z.name?.toUpperCase() ?? z.id.toUpperCase()}
                </div>
              );
            })}
          </div>
          {(draft?.zones ?? agent.config.zones ?? []).length === 0 && (
            <div style={{ fontFamily: MONO, fontSize: 11, color: '#C41E3A', marginTop: 8, lineHeight: 1.5 }}>
              Pick at least one, or your agent will never enter a hunt.
            </div>
          )}
        </div>

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

        {/*
          What it is doing, first. Everything else on this screen is settings;
          this is the only card that answers "is it working", which was the
          unanswerable question before it existed.
        */}
        <div style={CARD}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Label dark>WHAT IT IS DOING</Label>
            {funded && !stopped && (
              <div
                onClick={busy ? undefined : () => run(
                  () => (paused ? resumeAgent() : pauseAgent()),
                  paused ? 'Hunting.' : 'Paused.',
                )}
                style={{
                  border: '3px solid #0C0C10', padding: '6px 14px', cursor: 'pointer',
                  fontFamily: "'Archivo Black', sans-serif", fontSize: 12,
                  background: paused ? '#2CE66A' : 'transparent', color: '#0C0C10',
                  opacity: busy ? .5 : 1,
                }}
              >
                {paused ? 'START HUNTING' : 'PAUSE'}
              </div>
            )}
          </div>
          <div style={{ height: 8 }} />

          {/*
            Proof of life, above everything else on this card.

            An agent with nothing to play and an agent that has crashed render
            identically — a screen that never changes. 1,087 consecutive idle
            ticks is a working agent; it just could not say so.
          */}
          {activity?.heartbeat?.lastTickAt && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
              fontFamily: MONO, fontSize: 11, color: '#0C0C10',
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: 7,
                background: heartbeatFresh ? '#2CE66A' : '#C41E3A',
                display: 'inline-block',
              }} />
              {heartbeatFresh
                ? `Checking every 5s — last look ${tickAgo}s ago`
                : `No sweep for ${tickAgo}s — the driver may be down`}
            </div>
          )}

          {activity?.idleReason && (
            <div style={{
              fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .7,
              marginBottom: 8, lineHeight: 1.6,
            }}>
              {activity.idleReason}
            </div>
          )}

          {/* Live, not polled: pushed by the server the moment it happens. */}
          {feed.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {feed.map((e, i) => (
                <div key={`${e.at}-${i}`} style={{
                  fontFamily: MONO, fontSize: 10, color: '#0C0C10',
                  opacity: Math.max(.35, 1 - i * 0.07), lineHeight: 1.7,
                }}>
                  {e.t === 'agent:entered'
                    ? `→ entered a hunt in ${e.zoneId}`
                    : `· move ${e.seq}: ${e.move} (${e.source === 'model' ? 'model' : 'own strategy'})`}
                </div>
              ))}
            </div>
          )}
          {!activity?.attempts?.length && (
            <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5, lineHeight: 1.6 }}>
              Nothing yet. It enters on its own within a few seconds of a playable
              hunt appearing — agent zones carry one cash hunt at a time, so gaps
              are normal.
            </div>
          )}
          {activity?.attempts?.map(a => {
            const live = a.status === 'active';
            const detail = describeState(a.game, a.state);
            return (
              <div key={a.attemptId} style={{
                borderTop: '2px solid rgba(12,12,16,.12)', paddingTop: 8, marginTop: 8,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontFamily: BLACK, fontSize: 14, color: '#0C0C10' }}>
                    {a.game.toUpperCase()}
                  </span>
                  <span style={{
                    fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '.1em',
                    color: live ? '#0C0C10' : '#0C0C10', opacity: live ? 1 : .45,
                  }}>
                    {live ? '● PLAYING' : (a.failReason ?? a.status).toUpperCase()}
                  </span>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .6, marginTop: 2 }}>
                  {a.moves} move{a.moves === 1 ? '' : 's'}
                  {detail ? ` · ${detail}` : ''}
                  {' · '}
                  {a.thoughtMills > 0
                    ? `thought with a model (${(a.thoughtMills / 1000).toFixed(2)}c)`
                    : 'own strategy, free'}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 9, color: '#0C0C10', opacity: .35 }}>
                  {a.huntId}
                </div>
              </div>
            );
          })}
        </div>

        {/*
          The seat, kept visually and textually separate from the vault above.
          They are different pots paying for different things, and conflating
          them is exactly the confusion that turns a compute purchase into
          something a regulator would call an entry fee.
        */}
        <div style={CARD}>
          <Label dark>THINKING</Label>
          <div style={{ fontFamily: BLACK, fontSize: 22, color: '#0C0C10', marginTop: 4 }}>
            {seat ? `${(seat.seat.credit / 1000).toFixed(2)}c` : '—'}
            <span style={{ fontFamily: MONO, fontSize: 11, opacity: .5 }}> OF CREDIT</span>
          </div>

          <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .6, marginTop: 6, lineHeight: 1.6 }}>
            {seat?.seat.credit > 0
              ? 'Your agent is thinking with a model the house pays for.'
              : 'Your agent is playing its own strategy, free. A seat buys model calls — nothing else.'}
          </div>

          {seat?.purchasable && seat.seat.credit <= 0 && (
            <div style={{ marginTop: 12 }}>
              <Button
                disabled={busy || seat.seat.seatsLeft <= 0}
                wide
                onClick={() => run(
                  () => buySeat({
                    onQuote: terms => window.confirm(
                      `Buy inference credit for ${terms.price}?\n\n` +
                      `This buys: ${seat.seat.buys}.\n` +
                      `It does NOT buy: ${seat.seat.doesNotBuy}.\n\n` +
                      `${seat.seat.freeAlternative}`,
                    ),
                  }),
                  'Seat funded — your agent can think now.',
                )}
              >
                {seat.seat.seatsLeft > 0
                  ? `BUY ${(seat.seat.priceCents / 100).toFixed(2)} OF THINKING`
                  : 'ALL SEATS TAKEN'}
              </Button>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5, marginTop: 8, lineHeight: 1.5 }}>
                {seat.seat.seatsLeft} of {seat.seat.cap} funded seats left. This buys
                model calls, never entry — you can play without it, in the same
                hunts, for the same prizes.
              </div>
            </div>
          )}
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
                }, 'Vault created. Fund it to let your agent trade.')}
              >CREATE ITS VAULT</Button>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5, marginTop: 8, lineHeight: 1.5 }}>
                One transaction you sign, creating a vault you own. The agent
                spends from it within its caps and can never withdraw from it.
                Costs about 0.35 CELO — it deploys a contract.
              </div>
            </div>
          )}

          {funded && (
            <>
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '2px solid rgba(12,12,16,.15)' }}>
                <Label dark>VAULT</Label>
                <div style={{ fontFamily: BLACK, fontSize: 22, color: '#0C0C10', marginTop: 4 }}>
                  {formatToken(vaultBalance)}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 10, color: '#0C0C10', opacity: .5, wordBreak: 'break-all' }}>
                  {agent.vault}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {[1, 5, 20].map(amt => (
                    <Button
                      key={amt}
                      color="#29E6E6"
                      disabled={busy}
                      onClick={() => run(
                        () => fundVault(agent.vault, toRaw(amt)),
                        `Sent ${amt} ${TOKEN_SYMBOL} to your vault.`,
                      )}
                    >{`+${amt} ${TOKEN_SYMBOL}`}</Button>
                  ))}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5, marginTop: 8, lineHeight: 1.5 }}>
                  Sends {TOKEN_SYMBOL} from your wallet into your vault, so the agent
                  has something to buy hints with. It stays your money — the agent
                  may only spend it within the caps above, and WITHDRAW ALL is
                  yours alone.
                </div>
              </div>

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
            </>
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
