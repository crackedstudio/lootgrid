import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from './logger';

/**
 * Passing our own pino instance to Fastify specialises the instance type over
 * that logger, so the stock `FastifyInstance` no longer matches. Naming the
 * shape once here keeps every consumer honest instead of scattering `any`.
 */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  Logger
>;
