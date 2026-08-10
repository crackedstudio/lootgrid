import { MATH, RACE } from '../config';
import { hash, seededStream } from '../hash';
import type { Difficulty } from '../types';
import type { GameModule, StepResult } from './types';

export interface MathQuestion {
  q: string;
  options: number[];
  answer: number;
}

export interface MathSpec {
  count: number;
  limitMs: number;
}

export interface MathSecret {
  questions: MathQuestion[];
}

export interface MathState {
  index: number;
  lastServedAt: number | null;
}

export interface MathInput {
  kind: string;
  value?: unknown;
}

const RANGE: Record<Difficulty, number> = { easy: 6, med: 12, hard: 20 };

function makeQuestion(rnd: () => number, max: number): MathQuestion {
  const ops = ['+', '-', '×'] as const;
  const op = ops[Math.floor(rnd() * ops.length)]!;

  let a = Math.floor(rnd() * max) + 1;
  let b = Math.floor(rnd() * max) + 1;
  let answer: number;

  if (op === '+') {
    answer = a + b;
  } else if (op === '-') {
    // Keep it non-negative; subtracting into the negatives is a different skill
    // and quietly harder, which would make difficulty inconsistent between blocks.
    if (b > a) [a, b] = [b, a];
    answer = a - b;
  } else {
    const m = Math.min(9, max);
    a = Math.floor(rnd() * m) + 1;
    b = Math.floor(rnd() * m) + 1;
    answer = a * b;
  }

  const options = new Set<number>([answer]);
  let guard = 0;
  while (options.size < 4 && guard++ < 50) {
    const delta = Math.floor(rnd() * 11) - 5;
    const candidate = answer + delta;
    if (delta !== 0 && candidate >= 0) options.add(candidate);
  }
  while (options.size < 4) options.add(answer + options.size);

  const shuffled = [...options];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  return { q: `${a} ${op} ${b}`, options: shuffled, answer };
}

const publicQuestion = (q: MathQuestion) => ({ q: q.q, options: q.options });

/**
 * The only one of the four where secrecy is actually available, so it is used:
 * answers stay on the server, and question N+1 is issued only once N is right.
 * That forces a real round trip per question, so the measured time contains
 * network reality rather than a batch the client precomputed.
 */
export const mathModule: GameModule<MathSpec, MathSecret, MathState, MathInput> = {
  type: 'math',

  generate(seed, difficulty) {
    const rnd = seededStream(hash(seed, 'math'));
    const max = RANGE[difficulty] ?? RANGE.med;
    const questions = Array.from({ length: MATH.count }, () => makeQuestion(rnd, max));
    return {
      spec: { count: MATH.count, limitMs: MATH.limitMs },
      secret: { questions },
      limitMs: MATH.limitMs,
    };
  },

  publicSpec(spec, secret) {
    return {
      count: spec.count,
      limitMs: spec.limitMs,
      index: 0,
      question: publicQuestion(secret.questions[0]!),
    };
  },

  init() {
    return { index: 0, lastServedAt: null };
  },

  step({ spec, secret, state, timing }, input): StepResult {
    if (timing.sinceStart > spec.limitMs + RACE.latencyGraceMs) {
      return { kind: 'reject', reason: 'too_slow', fatal: true };
    }
    if (input.kind !== 'answer') return { kind: 'reject', reason: 'bad_input', fatal: true };

    const question = secret.questions[state.index];
    if (!question) return { kind: 'reject', reason: 'no_question', fatal: true };

    // Reading the question and four options cannot happen faster than this.
    const elapsedOnThis = state.lastServedAt === null ? timing.sinceStart : timing.sinceStart - state.lastServedAt;
    if (elapsedOnThis < MATH.minAnswerMs) {
      return { kind: 'reject', reason: 'answered_too_fast', fatal: true };
    }
    if (elapsedOnThis > MATH.maxAnswerMs) {
      return { kind: 'reject', reason: 'answered_too_slow', fatal: true };
    }

    if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
      return { kind: 'reject', reason: 'bad_answer', fatal: true };
    }
    // One wrong answer ends it — this is a race, not a quiz you can grind.
    if (input.value !== question.answer) {
      return { kind: 'reject', reason: 'wrong_answer', fatal: true };
    }

    state.index += 1;
    state.lastServedAt = timing.sinceStart;

    if (state.index >= spec.count) return { kind: 'complete' };

    return {
      kind: 'progress',
      emit: { index: state.index, question: publicQuestion(secret.questions[state.index]!) },
    };
  },

  progress(state, spec) {
    return Math.min(100, Math.round((state.index / spec.count) * 100));
  },
};
