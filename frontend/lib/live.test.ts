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
    strategy_stats: partial.strategy_stats ?? null,
    vetted_universe: partial.vetted_universe ?? null,
    competition: partial.competition ?? null,
    error_metrics: partial.error_metrics ?? null,
    combat_bundle: partial.combat_bundle ?? null,
    live_automations: partial.live_automations ?? null,
    vetting_enforce: partial.vetting_enforce ?? null,
    vetting_revet_at: partial.vetting_revet_at ?? null,
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

  it("item 2/4: discovery multi-motor — mais fresco vence, rotulado por motor", () => {
    const snap = deriveSnapshot([], [
      status({ service: "liquidator", discovery: { positions: 15, dispatched: 1, rejected: 2, atIso: now() }, updated_at: "2020-01-01T00:00:00Z" }),
      status({ service: "mis-scanner", discovery: { positions: 58, dispatched: 3, rejected: 12, atIso: now() }, updated_at: "2020-01-01T00:05:00Z" }),
    ]);
    // mis-scanner é mais fresco (updated_at maior) → radar mostra o Motor 2, rotulado.
    expect(snap.discovery).toMatchObject({ service: "Motor 2", positions: 58, dispatched: 3, rejected: 12 });
  });

  it("item 3: intel do service_status (market-bribe + drift)", () => {
    const snap = deriveSnapshot([], [
      status({ service: "liquidator", intel: { marketBribeP50Gwei: 0.01, marketBribeP95Gwei: 0.05, competitorsActive: 4, driftBps: -118 } }),
    ]);
    expect(snap.intel).toMatchObject({ marketBribeP50Gwei: 0.01, competitorsActive: 4, driftBps: -118 });
  });

  it("auto-liga da gorjeta (Motor 2): sobrepõe competitiveBribeAutoEnabled mesmo com intel do liquidator", () => {
    const snap = deriveSnapshot([], [
      status({ service: "liquidator", intel: { marketBribeP50Gwei: 0.01, competitorsActive: 4 } }),
      status({ service: "mis-scanner", intel: { competitiveBribeAutoEnabled: true, bribeAutoEnableReason: "5 corridas perdidas no gás na última 60 min" } }),
    ]);
    expect(snap.intel).toMatchObject({
      marketBribeP50Gwei: 0.01, // segue vindo do liquidator
      competitiveBribeAutoEnabled: true, // sobreposto do mis-scanner
      bribeAutoEnableReason: "5 corridas perdidas no gás na última 60 min",
    });
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
        health: { components: [
          { name: "rpc / Base", ok: false, detail: "sem resposta" }, // Fase 1: RPC caído → deve chegar como DOWN
          { name: "auto-pause", ok: true, detail: "ativo" },
          { name: "porteiro-tokens", ok: true, detail: "checado há 12s" }, // Fase 2: freshness do re-vet
        ] },
        competitors: [{ alias: "bob.eth", category: "mev_searcher", txs: 12, bribeGwei: 0.5, threat: 0.8 }],
        cooldowns: [{ label: "auto-pause", reason: "oracle stale", active: true }],
        kill_switch: { loss24hUsd: 40, limitUsd: 100, triggered: false },
      }),
      status({
        service: "mis-scanner",
        health: { components: [{ name: "rpc / Base", ok: true, warn: true, detail: "bloco há 20s (degradado)" }] }, // Fase 3 + #2: warn (degradado)
        edge_pairs: [{ pair: "WETH/USDC", score: 9.2, persistPct: "62%", avgBps: 18, samples: 30 }],
      }),
    ]);
    // Fase 3: componentes fundidos dos 2 motores, rotulados por motor (M1 primeiro, depois M2).
    expect(snap.health?.[0]).toMatchObject({ name: "M1 · rpc / Base", ok: false });
    expect(snap.health?.[1]).toMatchObject({ name: "M1 · auto-pause", ok: true });
    expect(snap.health?.[2]).toMatchObject({ name: "M1 · porteiro-tokens", ok: true });
    expect(snap.health?.[3]).toMatchObject({ name: "M2 · rpc / Base", ok: true, warn: true }); // Motor 2 visível + #2 estado degradado
    expect(snap.health).toHaveLength(4);
    expect(snap.competitors?.[0]).toMatchObject({ alias: "bob.eth", txs: 12 });
    expect(snap.cooldowns?.[0]).toMatchObject({ active: true });
    expect(snap.killSwitch).toMatchObject({ loss24hUsd: 40, limitUsd: 100 });
    expect(snap.edgePairs?.[0]).toMatchObject({ pair: "WETH/USDC", samples: 30 });
  });

  it("Fase 2b/E: post-mortem COM vencedor (alias, endereço curto, gorjeta) + log de calibration.applied", () => {
    const snap = deriveSnapshot([
      row({
        type: "failure.recorded",
        protocol: "morpho-blue",
        payload: { competitorAlias: "bob.eth", winnerPriorityFeeGwei: 0.51, our_tx_index: 3 } as ZeusEvent,
      }),
      // Fase E: vencedor SEM alias resolvido → mostra endereço curto (não some com a perda).
      row({
        type: "failure.recorded",
        protocol: "aave-v3",
        payload: { competitorSender: "0x9a3c00000000000000000000000000000000d21f" } as ZeusEvent,
      }),
      row({ type: "failure.recorded", protocol: "aave-v3", payload: { failureCategory: "reverted_on_chain" } as ZeusEvent }), // sem vencedor → não vira post-mortem
      row({
        type: "calibration.applied",
        payload: { oldThresholdUsd: 3.6, newThresholdUsd: 4.2, reason: "sequência de reverts" } as ZeusEvent,
      }),
      // #1 automação: observação ("o que faria") — deve aparecer com sufixo "(faria)".
      row({
        type: "calibration.applied",
        payload: { oldThresholdUsd: 3.6, newThresholdUsd: 4.8, applied: false } as ZeusEvent,
      }),
    ]);
    expect(snap.postmortem).toHaveLength(2); // a falha sem vencedor NÃO entra
    const texts = snap.postmortem!.map((p) => p.text).join(" | ");
    expect(texts).toContain("bob.eth");
    expect(texts).toContain("0.51 gwei"); // gorjeta do vencedor agora aparece
    expect(texts).toContain("0x9a3c…d21f"); // vencedor sem alias → endereço curto
    expect(snap.postmortem!.find((p) => p.text.includes("bob.eth"))?.pos).toBe("pos #3");
    expect(snap.calib).toHaveLength(2);
    expect(snap.calib!.some((c) => c.effect.includes("3.60") && c.effect.includes("4.20"))).toBe(true);
    // #1 automação: a calibração em modo observação aparece com "(faria)".
    expect(snap.calib!.some((c) => c.effect.includes("4.80") && c.effect.includes("(faria)"))).toBe(true);
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

  it("Tokens: funde vetted_universe dos 2 heartbeats por (token, motor) — LSD M1 pass + M2 reject", () => {
    const snap = deriveSnapshot([], [
      status({
        service: "liquidator",
        vetted_universe: [
          { token: "0xcbETH", symbol: "cbETH", motor: "motor1", verdict: "pass", reason: "entrou: colateral vendável", exitDex: "Aerodrome", liquidityUsd: 1_000_000, locked: false },
        ],
      }),
      status({
        service: "mis-scanner",
        vetted_universe: [
          { token: "0xcbETH", symbol: "cbETH", motor: "motor2", verdict: "reject", reason: "rejeitado: sem edge", liquidityUsd: 1_000_000, locked: false },
          { token: "0xSCAM", symbol: "SCAM", motor: "motor2", verdict: "reject", reason: "saiu: honeypot", liquidityUsd: 0, locked: false, partial: true }, // Fase A: dado incompleto
        ],
      }),
    ]);
    expect(snap.vettedUniverse).toHaveLength(3);
    const m1 = snap.vettedUniverse!.find((t) => t.symbol === "cbETH" && t.motor === "motor1");
    const m2 = snap.vettedUniverse!.find((t) => t.symbol === "cbETH" && t.motor === "motor2");
    expect(m1?.verdict).toBe("pass");
    expect(m1?.partial).toBe(false); // sem flag → false, nunca undefined
    expect(m2?.verdict).toBe("reject");
    // Fase A: o flag "dados parciais" flui do heartbeat até o snapshot (selo no painel).
    expect(snap.vettedUniverse!.find((t) => t.symbol === "SCAM")?.partial).toBe(true);
  });

  it("Chave-mestra: combat_bundle (Motor 2) flui do heartbeat pro snapshot", () => {
    const snap = deriveSnapshot([], [
      status({ service: "mis-scanner", combat_bundle: { executionLive: true, adaptive: true, competitiveBribe: true, slippagePerDex: true, walletPoolReady: 22, walletPoolActive: true } }),
    ]);
    expect(snap.combatBundle).toMatchObject({ executionLive: true, slippagePerDex: true, walletPoolReady: 22, walletPoolActive: true });
  });

  it("Chave-mestra: combat_bundle do Motor 1 (liquidator) flui pro snap.combatBundleM1 — painel mostra os 2 motores", () => {
    const snap = deriveSnapshot([], [
      status({ service: "mis-scanner", combat_bundle: { executionLive: true, adaptive: true, competitiveBribe: true, slippagePerDex: true, walletPoolReady: 22, walletPoolActive: true } }),
      status({ service: "liquidator", combat_bundle: { executionLive: true, adaptive: true, competitiveBribe: true, slippagePerDex: true, walletPoolReady: 0, walletPoolActive: false } }),
    ]);
    expect(snap.combatBundle).toMatchObject({ executionLive: true, walletPoolReady: 22 }); // M2
    expect(snap.combatBundleM1).toMatchObject({ executionLive: true, slippagePerDex: true, walletPoolActive: false }); // M1
  });

  it("#3+#6 automações: escalada de gás + edge sumindo fluem do intel pro snapshot", () => {
    const snap = deriveSnapshot([], [
      status({ service: "liquidator", intel: { marketBribeP95Gwei: 2.1, competitorsActive: 4, gasEscalationPct: 64, edgeShiftPct: 34 } }),
    ]);
    expect(snap.intel?.gasEscalationPct).toBe(64);
    expect(snap.intel?.edgeShiftPct).toBe(34);
  });

  it("Itens 1+3 (Saúde): taxa de erro + uptime reais fluem do heartbeat pro snapshot", () => {
    const snap = deriveSnapshot([], [
      status({ service: "liquidator", error_metrics: { failedOps: 6, totalOps: 477 }, uptime_sec: 12345 }),
    ]);
    expect(snap.errorMetrics).toMatchObject({ failedOps: 6, totalOps: 477 });
    expect(snap.uptimeSec).toBe(12345);
  });

  it("Item 4: diagnóstico de concorrência (builders + posição) flui do liquidator pro snapshot", () => {
    const snap = deriveSnapshot([], [
      status({
        service: "liquidator",
        competition: {
          topBuilders: [{ alias: "beaverbuild", blocks: 400, competitorTxs: 180, ourTxs: 5 }],
          position: { samples: 24, bottom10pctPct: 33, top10pctPct: 12, avgRelative: 0.58 },
        },
      }),
    ]);
    expect(snap.competition?.topBuilders[0]).toMatchObject({ alias: "beaverbuild", ourTxs: 5 });
    expect(snap.competition?.position.samples).toBe(24);
  });

  it("Tokens: lixo no jsonb (motor/verdict inválido) é descartado", () => {
    const snap = deriveSnapshot([], [
      status({
        service: "mis-scanner",
        // @ts-expect-error testando entrada malformada
        vetted_universe: [{ token: "0x1", symbol: "X", motor: "motorX", verdict: "talvez", reason: "", liquidityUsd: "lixo", locked: false }],
      }),
    ]);
    expect(snap.vettedUniverse).toBeUndefined();
  });

  it("Tokens: tokenLog dos eventos token.entered/token.exited com motivo PT-BR", () => {
    const snap = deriveSnapshot([
      row({ type: "token.entered", pair: "DEGEN", payload: { symbol: "DEGEN", motor: "motor2", reason: "entrou: saída na UniV3, liquidez ok" } as unknown as ZeusEvent }),
      row({ type: "token.exited", pair: "SCAM", payload: { symbol: "SCAM", motor: "motor2", reason: "saiu: honeypot" } as unknown as ZeusEvent }),
    ]);
    expect(snap.tokenLog).toHaveLength(2);
    expect(snap.tokenLog![0]).toMatchObject({ symbol: "DEGEN", action: "entrou", motor: "M2" });
    expect(snap.tokenLog![0].reason).toContain("entrou");
    expect(snap.tokenLog![1]).toMatchObject({ symbol: "SCAM", action: "saiu" });
  });

  it("Tokens: estado do filtro (vetting_enforce) do heartbeat → snap.vettingEnforce", () => {
    const snap = deriveSnapshot([], [
      status({ service: "mis-scanner", vetting_enforce: { motor2: true } }),
    ]);
    expect(snap.vettingEnforce).toMatchObject({ motor2: true });
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
