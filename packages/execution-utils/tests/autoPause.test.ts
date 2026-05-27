/**
 * Smoke test do AutoPauseManager + ProcessCheck (Item 12 H7 + H10).
 */

import { describe, expect, it } from 'vitest';
import { AutoPauseManager, ProcessCheck } from '../src/health';

describe('AutoPauseManager — Item 12 H10', () => {
  it('inicia sem reasons → não pausa', () => {
    const m = new AutoPauseManager();
    expect(m.shouldPause()).toBe(false);
    expect(m.status().reasons).toHaveLength(0);
  });

  it('setReason critical → pausa', () => {
    const m = new AutoPauseManager();
    m.setReason('block_staleness', 'critical', '90s sem novo bloco');
    expect(m.shouldPause()).toBe(true);
    const status = m.status();
    expect(status.hard_pause).toBe(true);
    expect(status.reasons[0]?.source).toBe('block_staleness');
  });

  it('setReason warn → NÃO pausa (só monitora)', () => {
    const m = new AutoPauseManager();
    m.setReason('gas_reserve', 'warn', 'balance < $20');
    expect(m.shouldPause()).toBe(false);
    expect(m.status().reasons).toHaveLength(1);
    expect(m.status().hard_pause).toBe(false);
  });

  it('clearReason remove razão e libera pause se era único critical', () => {
    const m = new AutoPauseManager();
    m.setReason('block_staleness', 'critical', 'travou');
    expect(m.shouldPause()).toBe(true);

    m.clearReason('block_staleness');
    expect(m.shouldPause()).toBe(false);
  });

  it('múltiplos sources independentes', () => {
    const m = new AutoPauseManager();
    m.setReason('block_staleness', 'critical', 'a');
    m.setReason('pnl_kill', 'critical', 'b');
    m.setReason('gas_reserve', 'warn', 'c');

    expect(m.status().reasons).toHaveLength(3);
    expect(m.shouldPause()).toBe(true);

    m.clearReason('block_staleness');
    expect(m.shouldPause()).toBe(true); // ainda tem pnl_kill critical

    m.clearReason('pnl_kill');
    expect(m.shouldPause()).toBe(false); // só warn restante
  });

  it('summary é legível', () => {
    const m = new AutoPauseManager();
    m.setReason('staleness', 'critical', '90s');
    m.setReason('gas', 'warn', 'low');

    const sum = m.summary();
    expect(sum).toContain('staleness=critical');
    expect(sum).toContain('gas=warn');
  });

  it('summary vazio quando sem reasons', () => {
    const m = new AutoPauseManager();
    expect(m.summary()).toBe('no active pause reasons');
  });

  it('setReason em source existente atualiza severity sem duplicar', () => {
    const m = new AutoPauseManager();
    m.setReason('staleness', 'warn', 'starting');
    m.setReason('staleness', 'critical', 'getting worse');
    expect(m.status().reasons).toHaveLength(1);
    expect(m.status().reasons[0]?.severity).toBe('critical');
  });
});

describe('ProcessCheck — Item 12 H7', () => {
  it('snapshot retorna dados do process', async () => {
    const check = new ProcessCheck();
    check.start();

    // Aguarda 1 check completar
    await new Promise((r) => setTimeout(r, 100));

    const status = check.getStatus();
    expect(status.pid).toBe(process.pid);
    expect(status.uptime_sec).toBeGreaterThanOrEqual(0);
    expect(status.memory_mb.rss).toBeGreaterThan(0);
    expect(status.memory_mb.heap_used).toBeGreaterThan(0);
    // Em ambiente de teste lag deve ser baixo (≤ critical threshold)
    expect(status.event_loop_lag_ms).toBeLessThan(1000);

    check.stop();
  });

  it('status default = ok com thresholds normais', async () => {
    const check = new ProcessCheck({
      memoryWarnMb: 10_000, // bem alto
      memoryCriticalMb: 20_000,
      loopLagWarnMs: 10_000,
      loopLagCriticalMs: 30_000,
    });
    check.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(check.getStatus().status).toBe('ok');
    check.stop();
  });
});
