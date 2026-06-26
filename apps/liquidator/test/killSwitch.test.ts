/**
 * Trava-mestra KILL_SWITCH (Fase 1) + correção do footgun booleano de env.
 *
 * Regra: LIQUIDATOR_MODE=mainnet (capital real) EXIGE KILL_SWITCH=false EXPLÍCITO — senão o
 * boot é recusado pela própria config. dryrun/testnet não têm capital real → livres.
 *
 * Bônus: prova que boolEnv parseia "false" como false (z.coerce.boolean faria Boolean("false")=true).
 */

import { describe, expect, it } from 'vitest';
import { envSchema } from '../src/config';

describe('KILL_SWITCH — trava-mestra de mainnet', () => {
  it('default (sem nada) → dryrun + KILL_SWITCH=true (travado), boot OK', () => {
    const r = envSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.LIQUIDATOR_MODE).toBe('dryrun');
      expect(r.data.KILL_SWITCH).toBe(true);
    }
  });

  it('mainnet SEM KILL_SWITCH (default true) → RECUSA boot', () => {
    const r = envSchema.safeParse({ LIQUIDATOR_MODE: 'mainnet' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain('KILL_SWITCH');
    }
  });

  it('mainnet + KILL_SWITCH="true" → RECUSA boot', () => {
    const r = envSchema.safeParse({ LIQUIDATOR_MODE: 'mainnet', KILL_SWITCH: 'true' });
    expect(r.success).toBe(false);
  });

  it('mainnet + KILL_SWITCH="false" EXPLÍCITO → boot LIBERADO', () => {
    const r = envSchema.safeParse({ LIQUIDATOR_MODE: 'mainnet', KILL_SWITCH: 'false' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.KILL_SWITCH).toBe(false);
  });

  it('dryrun + KILL_SWITCH="true" → OK (trava não afeta dryrun)', () => {
    expect(envSchema.safeParse({ LIQUIDATOR_MODE: 'dryrun', KILL_SWITCH: 'true' }).success).toBe(true);
  });

  it('testnet + KILL_SWITCH="true" → OK (só mainnet é gateado)', () => {
    expect(envSchema.safeParse({ LIQUIDATOR_MODE: 'testnet', KILL_SWITCH: 'true' }).success).toBe(true);
  });
});

describe('boolEnv — corrige o footgun do z.coerce.boolean', () => {
  it('"false" → false (z.coerce.boolean retornaria true!)', () => {
    const r = envSchema.safeParse({ MORPHO_PRELIQ_ENABLED: 'false' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.MORPHO_PRELIQ_ENABLED).toBe(false);
  });

  it('"true"/"1"/"yes" → true; "0"/"off"/"no" → false', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE']) {
      const r = envSchema.safeParse({ MORPHO_PRELIQ_ENABLED: v });
      expect(r.success && r.data.MORPHO_PRELIQ_ENABLED).toBe(true);
    }
    for (const v of ['false', '0', 'no', 'off', 'FALSE']) {
      const r = envSchema.safeParse({ MORPHO_PRELIQ_ENABLED: v });
      expect(r.success && r.data.MORPHO_PRELIQ_ENABLED).toBe(false);
    }
  });

  it('ausente → usa o default do campo', () => {
    const r = envSchema.safeParse({});
    expect(r.success && r.data.MORPHO_PRELIQ_ENABLED).toBe(false); // default false
    expect(r.success && r.data.MORPHO_ENABLED).toBe(true); // default true
  });
});
