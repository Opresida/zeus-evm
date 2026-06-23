/**
 * Testes do payload do heartbeat (cobertura do Frontend — Motor 1, itens 2/3/4).
 * `buildHeartbeatPayload` é PURO → testável sem subir o app.
 */

import { describe, expect, it } from 'vitest';
import { buildHeartbeatPayload, compactIntel, type HeartbeatInput } from '../src/heartbeat';

const base: HeartbeatInput = {
  service: 'liquidator',
  chain: 'Base',
  mode: 'dryrun',
  timestamp: '2026-06-23T12:00:00.000Z',
  uptimeSec: 3600,
  gasReserveEth: 0.42,
  gasReserveUsd: 1500,
  autoPaused: false,
  motorTag: 'motor1',
  ops: 17,
  netPnl24hUsd: 128.5,
};

describe('buildHeartbeatPayload', () => {
  it('monta o evento base com motorStats (ops/PnL reais)', () => {
    const hb = buildHeartbeatPayload(base);
    expect(hb.type).toBe('zeus.heartbeat');
    expect(hb.service).toBe('liquidator');
    expect(hb.autoPaused).toBe(false);
    expect(hb.motorStats).toEqual([{ tag: 'motor1', ops: 17, netPnl24hUsd: 128.5 }]);
    // sem discovery/intel quando não passados → blocos omitidos (payload enxuto)
    expect(hb.discovery).toBeUndefined();
    expect(hb.intel).toBeUndefined();
  });

  it('inclui discovery (pulso do radar) quando presente', () => {
    const hb = buildHeartbeatPayload({
      ...base,
      discovery: { positions: 15, dispatched: 1, rejected: 2, atIso: base.timestamp },
    });
    expect(hb.discovery).toEqual({ positions: 15, dispatched: 1, rejected: 2, atIso: base.timestamp });
  });

  it('inclui intel quando presente', () => {
    const hb = buildHeartbeatPayload({ ...base, intel: { marketBribeP50Gwei: 0.01, driftBps: -118 } });
    expect(hb.intel).toEqual({ marketBribeP50Gwei: 0.01, driftBps: -118 });
  });
});

describe('compactIntel (fail-safe contra undefined/NaN)', () => {
  it('mantém só campos finitos', () => {
    expect(compactIntel({ marketBribeP50Gwei: 0.01, marketBribeP95Gwei: undefined, driftBps: -50 })).toEqual({
      marketBribeP50Gwei: 0.01,
      driftBps: -50,
    });
  });

  it('descarta NaN/Infinity', () => {
    expect(compactIntel({ marketBribeP50Gwei: NaN, driftBps: Infinity })).toBeUndefined();
  });

  it('retorna undefined quando nada sobra (heartbeat omite o bloco)', () => {
    expect(compactIntel({})).toBeUndefined();
    expect(compactIntel({ competitorsActive: undefined })).toBeUndefined();
  });
});
