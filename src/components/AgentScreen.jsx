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
  describePersona,
  pauseAgent,
  buySeat,
  fundVault,
  formatToken,
  toRaw,
  attachVault,
  centsToRaw,
  fetchAgent,
  fetchLedger,
  fetchVaultCaps,
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
  /** The caps the vault enforces, which are not always the ones in the config. */
  const [vaultCaps, setVaultCaps] = useState(null);
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
  // Follows the vault the CHAIN knows about, which is not always the one the
  // server has recorded. A vault the player revoked, or one the server lost
  // track of, still holds their money — showing nothing there reads as "you
  // have no vault" to the one player who most needs to know they do.
  const vaultAddress = agent?.vault ?? agent?.vaultOnChain?.address ?? null;
  useEffect(() => {
    let alive = true;
    if (!vaultAddress) return undefined;
    fetchVaultBalance(vaultAddress)
      .then(b => alive && setVaultBalance(b))
      .catch(() => {});
    // Same read, same reason: the caps that bind live in the contract, and a
    // screen showing the config's caps as though they bind is showing a number
    // the chain has never agreed to.
    fetchVaultCaps(vaultAddress)
      .then(c => alive && setVaultCaps(c))
      .catch(() => {});
    return () => { alive = false; };
  }, [vaultAddress, note]);

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
  // What the factory says. `create` reverts `VaultExists()` for anybody who has
  // one, so this — not `funded` — is what decides whether creating is offered.
  const chainVault = agent.vaultOnChain;
  /** A vault that exists on chain but that this server cannot spend from. */
  const orphanVault = !funded && chainVault ? chainVault : null;
  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(agent.config);

  /**
   * Where the saved config and the vault disagree.
   *
   * Compared in RAW token units, using the same conversion the server encodes
   * `setCaps` with. Comparing in cents would need a division that truncates
   * whenever a cap was set outside this app, and a drift warning that cannot be
   * cleared is worse than none.
   *
   * `null` while the caps have not been read — unknown is not agreement.
   */
  const capsDrift = vaultCaps && (
    vaultCaps.perTx !== centsToRaw(agent.config.maxHintPriceCents)
    || vaultCaps.perDay !== centsToRaw(agent.config.dailyBudgetCents)
  );

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
                // Pushes the SAVED config, never the draft. Sending unsaved
                // edits on chain would just move the disagreement to the other
                // side — the vault ahead of the config instead of behind it —
                // and cost a transaction to do it. Save first, then push.
                disabled={busy || dirty || capsDrift === false}
                onClick={() => run(
                  () => vaultAction('setCaps', {
                    perTxCents: agent.config.maxHintPriceCents,
                    perDayCents: agent.config.dailyBudgetCents,
                  }),
                  'Caps updated on chain.',
                )}
              >PUSH CAPS ON CHAIN</Button>
            )}
          </div>

          {/*
            What the contract enforces, in the contract's own numbers.

            The driver already checks a trade against these before sending, so
            drift never costs gas — it costs trades. The agent silently skips
            anything above the vault's cap (`vault_cap` in the refusal metric)
            and says nothing, so until this was shown the only symptom of a
            config the vault never agreed to was an agent that did less than it
            was told to, for no visible reason.
          */}
          {funded && vaultCaps && (
            <div style={{
              marginTop: 10, paddingTop: 10,
              borderTop: '2px solid rgba(12,12,16,.15)',
            }}>
              <Label dark>{capsDrift ? 'ON CHAIN — DOES NOT MATCH' : 'ON CHAIN'}</Label>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', marginTop: 4, lineHeight: 1.6 }}>
                {formatToken(vaultCaps.perTx)} PER TRADE · {formatToken(vaultCaps.perDay)} PER DAY
              </div>
            </div>
          )}

          <div style={{
            fontFamily: MONO, fontSize: 11, marginTop: 8, lineHeight: 1.5,
            color: capsDrift ? '#B23A00' : '#0C0C10',
            opacity: capsDrift ? 1 : .5,
          }}>
            {capsDrift
              ? dirty
                ? 'Your vault enforces the caps above, not the ones set here. Save your limits, then push them on chain to make the two agree.'
                : 'Your vault enforces the caps above, not the ones set here. Until you push them, your agent silently skips any trade over the vault\u2019s cap \u2014 no error, no transaction, just an agent doing less than you told it to.'
              : 'Saving here stops bad trades early. The caps that actually bind live in your vault \u2014 push them to change what it can spend.'}
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

          {/*
            Who this agent is.

            Its callsign and traits are derived from its address on the server,
            so this is not a setting the owner can edit — which is the point. An
            owner watching a bot make choices they did not configure is owed an
            explanation, and "it is a cautious one" is the honest one.
          */}
          {activity?.persona && (
            <div style={{
              border: '2px solid #0C0C10', padding: '6px 8px', marginBottom: 8,
              background: '#F4F1E8',
            }}>
              <div style={{
                fontFamily: MONO, fontSize: 12, fontWeight: 700, color: '#0C0C10',
                letterSpacing: .5,
              }}>
                {activity.persona.callsign}
              </div>
              <div style={{
                fontFamily: MONO, fontSize: 10, color: '#0C0C10', opacity: .65,
                marginTop: 3, lineHeight: 1.6,
              }}>
                {describePersona(activity.persona)}
              </div>
            </div>
          )}

          {/*
            What it has said. Rendered by the server from the enums it actually
            sent — a model never wrote any of these words, which is what lets an
            agent have a voice without a rival's text reaching anyone's prompt.
          */}
          {activity?.said?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {activity.said.map((u, i) => (
                <div key={i} style={{
                  fontFamily: MONO, fontSize: 10, color: '#0C0C10',
                  opacity: Math.max(.4, 1 - i * 0.12), lineHeight: 1.7,
                }}>
                  <span style={{ fontWeight: 700 }}>{u.callsign}</span>{' '}&ldquo;{u.text}&rdquo;
                </div>
              ))}
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

          {/*
            Offered only when the chain agrees there is no vault. The factory
            allows exactly one per player and reverts `VaultExists()` on a
            second call, so showing this to somebody who already has one is
            showing them a button whose only outcome is a reverted transaction
            they paid gas for.
          */}
          {!funded && !orphanVault && (
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

          {/*
            You already have one. Two ways to get here, and the money is safe in
            both: the server lost track of a vault that exists, or you revoked
            the agent's rights on chain and the vault now names no spender.
            Either way it holds a real balance and a second one cannot be made,
            so the balance is shown and the create button is not.
          */}
          {orphanVault && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '2px solid rgba(12,12,16,.15)' }}>
              <Label dark>VAULT — ALREADY CREATED</Label>
              <div style={{ fontFamily: BLACK, fontSize: 22, color: '#0C0C10', marginTop: 4 }}>
                {formatToken(vaultBalance)}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#0C0C10', opacity: .5, wordBreak: 'break-all' }}>
                {orphanVault.address}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#0C0C10', opacity: .5, marginTop: 8, lineHeight: 1.5 }}>
                {orphanVault.spendable
                  ? 'This vault is yours and holds the balance above. It just is not connected here yet — reconnect it and your agent can spend again. Nothing to sign.'
                  : 'This vault is yours and holds the balance above, but it names no spender this server can use — which is what pressing stop on chain does. WITHDRAW ALL still works from your wallet, and it is yours alone.'}
              </div>
              {orphanVault.spendable && (
                <div style={{ marginTop: 10 }}>
                  <Button
                    disabled={busy}
                    wide
                    onClick={() => run(() => attachVault(), 'Vault reconnected.')}
                  >RECONNECT IT</Button>
                </div>
              )}
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
