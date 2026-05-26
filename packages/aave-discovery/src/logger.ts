/**
 * Logger injetável (pino-compatible) pra package reusável.
 * Apps consumidores passam o pino deles; se `undefined`, usa no-op silencioso.
 */

export interface LoggerLike {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  /** Pino: fatal é o nível mais alto, usado pra incidentes que param o bot (ex: kill switch). */
  fatal(obj: object | string, msg?: string): void;
}

const NOOP = () => {};

export const NOOP_LOGGER: LoggerLike = {
  info: NOOP,
  warn: NOOP,
  debug: NOOP,
  error: NOOP,
  fatal: NOOP,
};
