/**
 * Vitest globalSetup — carrega .env da raiz do repo pra todos os testes.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

export default function setup() {
  // ../../.env (relativo a packages/dex-adapters/tests/)
  loadEnv({ path: resolve(__dirname, '../../../.env') });
}
