import pino from 'pino';
import { loadConfig } from './config';

const env = loadConfig();
const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { app: 'zeus-evm-liquidator', mode: env.LIQUIDATOR_MODE },
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined,
});
