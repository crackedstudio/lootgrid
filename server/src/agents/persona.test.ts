import { describe, expect, it } from 'vitest';
import { LIMITS, defaultConfig, type AgentConfig } from './config';
import { effective, personaFor, readyAt } from './persona';

/**
 * Character, and the ceiling it may not cross.
 *
 * Two things are being asserted here and only one of them is about flavour.
 * The variety tests say agents differ from each other; the ceiling tests say
 * that difference is never a way to spend more of somebody's money than they
 * agreed to. The second set is the one that matters — a persona is a lens over
 * the owner's config, and a lens that magnified would be a spending exploit
 * dressed as personality.
 */

const addr = (n: number): string =>
  `0x${n.toString(16).padStart(40, '0')}`;

const someAgents = Array.from({ length: 400 }, (_, i) => addr(i + 1));

describe('a persona is derived, not stored', () => {
  it('gives the same agent the same character every time', () => {
    for (const id of someAgents.slice(0, 50)) {
      expect(personaFor(id)).toEqual(personaFor(id));
    }
  });

  it('does not care how the address was capitalised', () => {
    const id = addr(0xabc);
    expect(personaFor(id.toUpperCase().replace('0X', '0x'))).toEqual(personaFor(id));
  });

  it('gives different agents different characters', () => {
    // Not a uniformity claim — just that this is not a constant function
    // wearing a hash. A handful of collisions across 400 is expected and fine.
    const callsigns = new Set(someAgents.map(id => personaFor(id).callsign));
    expect(callsigns.size).toBeGreaterThan(200);
  });

  it('spreads each trait across its range rather than clustering', () => {
    for (const axis of ['boldness', 'patience', 'thrift', 'chattiness', 'nerve'] as const) {
      const values = someAgents.map(id => personaFor(id)[axis]);
      expect(Math.min(...values)).toBeLessThan(15);
      expect(Math.max(...values)).toBeGreaterThan(85);
      // Every trait is a number in range, always.
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('names agents from the house list, never from anything a player typed', () => {
    // Structural: a callsign is WORD-NN and the word half is upper-case ASCII.
    // Anything a player could influence would not survive this shape.
    for (const id of someAgents.slice(0, 100)) {
      expect(personaFor(id).callsign).toMatch(/^[A-Z]+-\d{2}$/);
    }
  });
});

describe('the owner’s config is a ceiling', () => {
  const configs: AgentConfig[] = [
    defaultConfig(),
    { ...defaultConfig(), maxHintPriceCents: 1, dailyBudgetCents: 1, aggression: 0 },
    { ...defaultConfig(), maxHintPriceCents: 500, dailyBudgetCents: 5000, aggression: 100 },
    { ...defaultConfig(), maxHintPriceCents: 7, dailyBudgetCents: 13, aggression: 55 },
  ];

  it('never widens a spending limit, for any agent against any config', () => {
    // The load-bearing property, checked exhaustively rather than by example:
    // if this can be violated by any of 400 personas against any of these
    // configs, personality has become a way to spend more than was authorised.
    for (const config of configs) {
      for (const id of someAgents) {
        const out = effective(config, personaFor(id));
        expect(out.maxHintPriceCents).toBeLessThanOrEqual(config.maxHintPriceCents);
        expect(out.dailyBudgetCents).toBeLessThanOrEqual(config.dailyBudgetCents);
        expect(out.aggression).toBeLessThanOrEqual(config.aggression);
      }
    }
  });

  it('never narrows a limit to zero, which would read as a broken agent', () => {
    for (const config of configs) {
      for (const id of someAgents.slice(0, 100)) {
        const out = effective(config, personaFor(id));
        expect(out.maxHintPriceCents).toBeGreaterThanOrEqual(1);
        expect(out.dailyBudgetCents).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('keeps every value inside the schema’s own bounds', () => {
    for (const id of someAgents.slice(0, 100)) {
      const out = effective(defaultConfig(), personaFor(id));
      expect(out.aggression).toBeGreaterThanOrEqual(LIMITS.aggression.min);
      expect(out.aggression).toBeLessThanOrEqual(LIMITS.aggression.max);
    }
  });

  it('leaves zones exactly alone', () => {
    // Which zones an agent may enter is a permission, not a temperament. A
    // personality that wandered into an excluded zone would be a bug in a
    // costume, so this is asserted rather than assumed.
    const config = { ...defaultConfig(), zones: ['zone-a', 'zone-b'] };
    for (const id of someAgents.slice(0, 100)) {
      expect(effective(config, personaFor(id)).zones).toEqual(['zone-a', 'zone-b']);
    }
  });

  it('bolder agents use more of the same ceiling than timid ones', () => {
    // The flavour claim, stated as an ordering rather than a magnitude.
    const config = { ...defaultConfig(), dailyBudgetCents: 1000 };
    const bold = { ...personaFor(addr(1)), boldness: 100 };
    const timid = { ...personaFor(addr(1)), boldness: 0 };

    expect(effective(config, bold).dailyBudgetCents).toBeGreaterThan(
      effective(config, timid).dailyBudgetCents,
    );
  });
});

describe('cadence', () => {
  it('makes an impatient agent ready more often than a patient one', () => {
    const id = addr(7);
    const impatient = { ...personaFor(id), patience: 0 };
    const patient = { ...personaFor(id), patience: 100 };

    const count = (p: typeof impatient) =>
      Array.from({ length: 100 }, (_, t) => readyAt(id, p, t)).filter(Boolean).length;

    expect(count(impatient)).toBe(100); // period 1 — every tick
    expect(count(patient)).toBeLessThan(30); // period 5 — one in five
    expect(count(patient)).toBeGreaterThan(0); // but never never
  });

  it('gives every agent a turn eventually', () => {
    // No address may be starved: an agent that is never ready is an agent that
    // never plays, and it would look exactly like a broken driver.
    for (const id of someAgents.slice(0, 200)) {
      const persona = personaFor(id);
      const ready = Array.from({ length: 10 }, (_, t) => readyAt(id, persona, t));
      expect(ready.some(Boolean)).toBe(true);
    }
  });

  it('keeps an agent’s rhythm stable across restarts', () => {
    // Derived from the address, so a redeploy does not reshuffle everyone's
    // cadence — which would read as jitter rather than as character.
    const id = addr(42);
    const persona = personaFor(id);
    const first = Array.from({ length: 20 }, (_, t) => readyAt(id, persona, t));
    const second = Array.from({ length: 20 }, (_, t) => readyAt(id, persona, t));
    expect(first).toEqual(second);
  });
});
