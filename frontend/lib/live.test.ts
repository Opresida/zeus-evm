import { describe, expect, it } from "vitest";
import { deriveSnapshot } from "./live";
import type { EventRow, ServiceStatusRow, ZeusEvent } from "./types";

const now = () => new Date().toISOString();

function row(partial: Partial<EventRow> & { type: string }): EventRow {
  return {
    id: 1,
    type: partial.type,
    severity: "info",
    ts: partial.ts ?? now(),
    chain: "Base",
    mode: "mainnet",
    protocol: partial.protocol ?? null,
    pair: partial.pair ?? null,
    tx_hash: partial.tx_hash ?? null,
    borrower: null,
    profit_usd: partial.profit_usd ?? null,
    gas_usd: partial.gas_usd ?? null,
    net_profit_usd: partial.net_profit_usd ?? null,
    profit_delta_bps: partial.profit_delta_bps ?? null,
    block_number: null,
    payload: (partial.payload ?? {}) as ZeusEvent,
  };
}

function status(partial: Partial<ServiceStatusRow> & { service: string }): ServiceStatusRow {
  return {
    service: partial.service,
    chain: "Base",
    mode: "mainnet",
    uptime_sec: partial.uptime_sec ?? 100,
    gas_reserve_eth: partial.gas_reserve_eth ?? null,
    gas_reserve_usd: partial.gas_reserve_usd ?? null,
    adaptive_min_ev_usd: null,
    auto_paused: partial.auto_paused ?? false,
    motor_stats: partial.motor_stats ?? null,
    discovery: partial.discovery ?? null,
    intel: partial.intel ?? null,
    health: partial.health ?? null,
    competitors: partial.competitors ?? null,
    edge_pairs: partial.edge_pairs ?? null,
    cooldowns: partial.cooldowns ?? null,
    kill_switch: partial.kill_switch ?? null,
    latency: partial.latency ?? null,
    reorgs: partial.reorgs ?? null,
    updated_at: partial.updated_at ?? now(),
  };
}

describe("deriveSnapshot — cobertura do Motor 1 (itens 1-4)", () => {
  it("item 1: failures de failure.recorded (categoria + quem ganhou)", () => {
    const rows = [
      row({
        type: "failure.recorded",
        protocol: "morpho-blue",
        gas_usd: 4.4,
        payload: { failureCategory: "reverted_on_chain", competitorAlias: "bob-the-builder.eth", gasUsdLost: 4.4 } as ZeusEvent,
      }),
    ];
    const snap = deriveSnapshot(rows);
    expect(snap.failures).toHaveLength(1);
    expect(snap.failures![0].protocol).toBe("morpho-blue");
    expect(snap.failures![0].category).toBe("reverted_on_chain");
    expect(snap.failures![0].detail).toContain("bob-the-builder.eth");
  });

  it("item 2: discovery do service_status do liquidator", () => {
    const snap = deriveSnapshot([], [
      status({ service: "liquidator", discovery: { positions: 15, dispatched: 1, rejected: 2, atIso: now() } }),
    ]);
    expect(snap.discovery).toMatchObject({ service: "liquidator", positions: 15, dispatched: 1, rejected: 2 });
  });

  it("item 3: intel do service_status (market-bribe + drift)", () => {
    const snap = deriveSnapshot([], [
      status({ service: "liquidator", intel: { marketBribeP50Gwei: 0.01, marketBribeP95Gwei: 0.05, competitorsActive: 4, driftBps: -118 } }),
    ]);
    expect(snap.intel).toMatchObject({ marketBribeP50Gwei: 0.01, competitorsActive: 4, driftBps: -118 });
  });

  it("item 4: motorCards somam PnL/ops por motor a partir dos eventos tx.*", () => {
    const rows = [
      row({ type: "tx.confirmed", protocol: "aave-v3", net_profit_usd: 100 }),
      row({ type: "tx.confirmed", protocol: "morpho-blue", net_profit_usd: 50 }),
      row({ type: "tx.confirmed", protocol: "arb", net_profit_usd: 30 }),
      row({ type: "tx.reverted_on_chain", protocol: "moonwell", gas_usd: 5 }),
    ];
    const snap = deriveSnapshot(rows);
    const byTag = Object.fromEntries((snap.motorCards ?? []).map((c) => [c.tag, c]));
    expect(byTag.motor1).toMatchObject({ netUsd: 145, ops: 3 }); // 100 + 50 - 5 (moonwell revert)
    expect(byTag.motor2).toMatchObject({ netUsd: 30, ops: 1 });
    expect(byTag.motor3).toMatchObject({ netUsd: 0, ops: 0 }); // sempre mostra os 3 (honesto)
  });

  it("Fase 1: agrega PnL/gás/relatórios por janela (7d/30d, 14d, breakdown, reports)", () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const rows = [
      row({ type: "tx.confirmed", protocol: "arb", net_profit_usd: 100, gas_usd: 2, ts: daysAgo(0) }),
      row({ type: "tx.confirmed", protocol: "aave-v3", net_profit_usd: 50, gas_usd: 1, ts: daysAgo(5) }),
      row({ type: "tx.confirmed", protocol: "arb", net_profit_usd: 20, gas_usd: 1, ts: daysAgo(20) }),
    ];
    const snap = deriveSnapshot(rows);
    expect(snap.kpi7d).toBeCloseTo(150); // hoje 100 + 5d 50
    expect(snap.kpi30d).toBeCloseTo(170); // + 20d 20
    expect(snap.gas24h).toBeCloseTo(2);
    expect(snap.gas30d).toBeCloseTo(4);
    expect(snap.raw14).toHaveLength(14);
    expect(snap.raw14![13]).toBeCloseTo(100); // hoje = última barra
    expect((snap.motorBreak ?? []).find((m) => m.name.includes("M2"))?.val).toBeCloseTo(120); // arb 100+20
    expect(snap.repByPeriod?.weekly.ops).toBe("2");
    expect(snap.repByPeriod?.monthly.ops).toBe("3");
  });

  it("Fase 2: blocos do heartbeat (health/competitors/cooldowns/kill_switch/edge_pairs)", () => {
    const snap = deriveSnapshot([], [
      status({
        service: "liquidator",
        health: { components: [{ name: "auto-pause", ok: true, detail: "ativo" }] },
        competitors: [{ alias: "bob.eth", category: "mev_searcher", txs: 12, bribeGwei: 0.5, threat: 0.8 }],
        cooldowns: [{ label: "auto-pause", reason: "oracle stale", active: true }],
        kill_switch: { loss24hUsd: 40, limitUsd: 100, triggered: false },
      }),
      status({
        service: "mis-scanner",
        edge_pairs: [{ pair: "WETH/USDC", score: 9.2, persistPct: "62%", avgBps: 18, samples: 30 }],
      }),
    ]);
    expect(snap.health?.[0]).toMatchObject({ name: "auto-pause", ok: true });
    expect(snap.competitors?.[0]).toMatchObject({ alias: "bob.eth", txs: 12 });
    expect(snap.cooldowns?.[0]).toMatchObject({ active: true });
    expect(snap.killSwitch).toMatchObject({ loss24hUsd: 40, limitUsd: 100 });
    expect(snap.edgePairs?.[0]).toMatchObject({ pair: "WETH/USDC", samples: 30 });
  });

  it("Fase 2b: post-mortem de failure.recorded COM vencedor + log de calibration.applied", () => {
    const snap = deriveSnapshot([
      row({
        type: "failure.recorded",
        protocol: "morpho-blue",
        payload: { competitorAlias: "bob.eth", winner_priority_fee_gwei: 0.51, our_tx_index: 3 } as ZeusEvent,
      }),
      row({ type: "failure.recorded", protocol: "aave-v3", payload: { failureCategory: "reverted_on_chain" } as ZeusEvent }), // sem vencedor → não vira post-mortem
      row({
        type: "calibration.applied",
        payload: { oldThresholdUsd: 3.6, newThresholdUsd: 4.2, reason: "sequência de reverts" } as ZeusEvent,
      }),
    ]);
    expect(snap.postmortem).toHaveLength(1);
    expect(snap.postmortem![0].text).toContain("bob.eth");
    expect(snap.postmortem![0].pos).toBe("pos #3");
    expect(snap.calib).toHaveLength(1);
    expect(snap.calib![0].effect).toContain("3.60");
    expect(snap.calib![0].effect).toContain("4.20");
  });

  it("Fase 2b: latência (service_status) + histórico de saldo (wallet_snapshots)", () => {
    const snap = deriveSnapshot(
      [],
      [status({ service: "liquidator", latency: { p50Ms: 142, p95Ms: 410, samples: 50 } })],
      [
        { id: 1, service: "liquidator", chain: "Base", ts: "2026-06-22T00:00:00Z", balance_eth: 0.5, balance_usd: 1600 },
        { id: 2, service: "liquidator", chain: "Base", ts: "2026-06-23T00:00:00Z", balance_eth: 0.42, balance_usd: 1340 },
      ],
    );
    expect(snap.latency).toMatchObject({ p50Ms: 142, p95Ms: 410, samples: 50 });
    expect(snap.whRaw).toEqual([0.5, 0.42]); // ordenado asc por ts, em ETH
  });

  it("Fase 2b: latência com samples=0 é ignorada (omite o bloco)", () => {
    const snap = deriveSnapshot([], [status({ service: "liquidator", latency: { p50Ms: 0, p95Ms: 0, samples: 0 } })]);
    expect(snap.latency).toBeUndefined();
  });

  it("Motor 1: resiliência de reorg (reorgs 24h + órfãs recuperadas) do service_status", () => {
    const snap = deriveSnapshot([], [
      status({ service: "liquidator", reorgs: { window24h: 2, orphansRecovered: 1, orphansDetected: 1 } }),
    ]);
    expect(snap.reorgs).toMatchObject({ window24h: 2, orphansRecovered: 1 });
  });

  it("venue do swap (multi-DEX Motor 1) entra no TxRow a partir do payload", () => {
    const rows = [
      row({ type: "tx.confirmed", protocol: "morpho-blue", net_profit_usd: 80, payload: { swapVenue: "slipstream" } as ZeusEvent }),
      row({ type: "tx.confirmed", protocol: "aave-v3", net_profit_usd: 50 }), // sem venue → undefined
    ];
    const snap = deriveSnapshot(rows);
    expect(snap.txRows?.[0].venue).toBe("slipstream");
    expect(snap.txRows?.[1].venue).toBeUndefined();
  });

  it("snapshot vazio → sem campos (cai no mock no viewModel)", () => {
    const snap = deriveSnapshot([], []);
    expect(snap.failures).toBeUndefined();
    expect(snap.discovery).toBeUndefined();
    expect(snap.motorCards).toBeUndefined();
    expect(snap.kpi7d).toBeUndefined();
    expect(snap.health).toBeUndefined();
    expect(snap.killSwitch).toBeUndefined();
  });
});
