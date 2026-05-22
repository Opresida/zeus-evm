import pino from 'pino';
import { loadConfig } from './config';

const env = loadConfig();

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
    : undefined,
  base: { app: 'zeus-evm-detector' },
});
