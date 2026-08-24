import { useCallback, useEffect, useState } from 'react';
import { fetchAgent, resumeAgent, configureAgent, statusLabel } from '../api/agent';
import { socket } from '../api/socket';

/**
 * Turn your agent loose on the zone you are standing in.
 *
 * ─────────────────────────── why it belongs here ───────────────────────────
 *
 * The AGENT tab is where an agent is *configured* — caps, budget, vault. This is
 * where the decision actually occurs to a player: they walk into a lattice and
 * either want their agent working it or they do not. Making them leave, find a
 * zone list, tick a checkbox and come back is the same decision routed through
 * three screens.
 *
 * It writes the same two things the AGENT tab does — `zones` and `status` — so
 * there is no second source of truth about what the agent is doing.
 *
 * Renders nothing on a human zone: agents cannot enter one, and a control that
 * silently does nothing is worse than no control.
 */
export default function AgentZoneBar({ zone }) {
  const [agent, setAgent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(() => {
    fetchAgent().then(setAgent).catch(() => setAgent(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  // The agent moves without being asked, so the bar has to hear about it.
  useEffect(() => socket.onMessage(msg => {
    if (msg.t === 'agent:entered' && msg.zoneId === zone?.id) setNote('entered a hunt here');
    if (msg.t === 'agent:move') setNote(`move ${msg.seq}: ${msg.move}`);
  }), [zone?.id]);

  if (!zone || zone.kind !== 'agent' || !agent) return null;

  const here = (agent.config?.zones ?? []).includes(zone.id);
  const running = agent.status === 'active';
  const on = here && running;
  const noVault = !agent.vault;

  const toggle = async () => {
    setBusy(true);
    try {
      if (on) {
        // Leaving the zone list rather than pausing globally: a player turning
        // it off HERE means "not this zone", not "stop everywhere".
        await configureAgent({ zones: (agent.config.zones ?? []).filter(z => z !== zone.id) });
      } else {
        if (!here) {
          await configureAgent({ zones: [...(agent.config.zones ?? []), zone.id] });
        }
        if (!running) await resumeAgent();
      }
      load();
    } catch (err) {
      setNote(err?.code ?? err?.message ?? 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
      background: on ? '#2CE66A' : 'rgba(12,12,16,.75)',
      borderBottom: '3px solid #0C0C10',
    }}>
      <span style={{
        fontFamily: "'Space Mono', monospace", fontSize: 10, fontWeight: 700,
        letterSpacing: '.1em', color: on ? '#0C0C10' : 'var(--cream)', flex: 1,
      }}>
        {noVault
          ? 'AGENT — NO VAULT YET'
          : on
            ? `AGENT HUNTING HERE${note ? ` · ${note}` : ''}`
            : `AGENT ${statusLabel(agent).toUpperCase()}`}
      </span>

      <div
        onClick={busy || noVault ? undefined : toggle}
        style={{
          border: `3px solid ${on ? '#0C0C10' : 'var(--cream)'}`,
          padding: '5px 12px', cursor: noVault ? 'not-allowed' : 'pointer',
          fontFamily: "'Archivo Black', sans-serif", fontSize: 11,
          color: on ? '#0C0C10' : 'var(--cream)',
          opacity: busy || noVault ? .5 : 1,
        }}
      >
        {noVault ? 'SET UP FIRST' : on ? 'TURN OFF' : 'TURN ON'}
      </div>
    </div>
  );
}
