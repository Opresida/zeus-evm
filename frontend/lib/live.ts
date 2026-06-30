import { usd } from "./viewModel";
import { uptimeFromSec } from "./viewModel";
import type { EventRow, LiveSnapshot, ServiceStatusRow, TxRow, WalletSnapshotRow, ZeusEvent } from "./types";

const TX_TYPES = new Set(["tx.confirmed", "tx.reverted_on_chain", "tx.reverted_pre_dispatch"]);

/** Mapeia o `protocol` de um evento tx.* para o motor (item 4 — mini-cards). */
const MOTOR_BY_PROTOCOL: Record<string, string> = {
  "aave-v3": "motor1",
  "compound-v3": "motor1",
  "morpho-blue": "motor1",
  "moonwell": "motor1",
  arb: "motor2",
  backrun: "motor3",
};
const MOTOR_LABEL: Record<string, string> = {
  motor1: "M1 · Liquidações",
  motor2: "M2 · Arbitragem",
  motor3: "M3 · Backrun",
};
function motorOf(protocol: string | null): string | null {
  if (!protocol) return null;
  return MOTOR_BY_PROTOCOL[protocol] ?? (protocol.startsWith("backrun") ? "motor3" : null);
}

function hhmm(ts: string) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function ago(ts: string) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  return sec < 60 ? sec + "s" : sec < 3600 ? Math.floor(sec / 60) + "m" : Math.floor(sec / 3600) + "h";
}
function colorFor(type: string): string {
  if (type === "tx.confirmed" || type === "gas.recovered" || type.endsWith(".boot")) return "var(--green)";
  if (type.startsWith("tx.reverted") || type === "gas.alert" || type.includes("kill_switch")) return "var(--red)";
  if (type.startsWith("backrun") || type === "whale.swap_detected") return "var(--cyan)";
  return "var(--gold)";
}

function rowToTx(r: EventRow): TxRow {
  const st: TxRow["st"] = r.type === "tx.confirmed" ? "ok" : r.type === "tx.reverted_on_chain" ? "rev" : "pre";
  const net = r.net_profit_usd ?? (st === "rev" ? -(r.gas_usd ?? 0) : 0);
  return {
    st,
    protocol: r.protocol || "—",
    pair: r.pair || (r.payload?.pair as string) || "—",
    net,
    gas: r.gas_usd ?? 0,
    drift: r.profit_delta_bps ?? 0,
    hash: r.tx_hash,
    mode: (r.mode || "main").slice(0, 4),
    time: hhmm(r.ts),
    reason: (r.payload?.reason as string) || undefined,
    venue: (r.payload?.swapVenue as string) || undefined,
  };
}

function tickerText(r: EventRow): string {
  const p = r.protocol ? " · " + r.protocol : "";
  if (r.type === "tx.confirmed") return `tx.confirmed${p} · ${usd(r.net_profit_usd ?? 0)} net`;
  if (r.type === "tx.reverted_on_chain") return `tx.reverted_on_chain${p} · −$${(r.gas_usd ?? 0).toFixed(2)} gás`;
  if (r.type === "backrun.dispatched") return `backrun.dispatched${r.pair ? " · " + r.pair : ""}`;
  if (r.type === "whale.swap_detected") return `whale.swap_detected${p}`;
  const ev = r.payload as ZeusEvent;
  return `${r.type}${p}${ev?.reason ? " · " + ev.reason : ""}`;
}

/** Deriva o snapshot ao vivo a partir dos eventos (mais recente primeiro) + status dos serviços. */
export function deriveSnapshot(
  rows: EventRow[],
  statuses: ServiceStatusRow[] = [],
  walletSnaps: WalletSnapshotRow[] = [],
): LiveSnapshot {
  if (!rows.length && !statuses.length) return {};
  const snap: LiveSnapshot = {};

  // ----- transações -----
  const txRows = rows.filter((r) => TX_TYPES.has(r.type)).map(rowToTx);
  if (txRows.length) {
    snap.txRows = txRows;
    snap.txCounts = {
      all: txRows.length,
      ok: txRows.filter((t) => t.st === "ok").length,
      rev: txRows.filter((t) => t.st === "rev").length,
      pre: txRows.filter((t) => t.st === "pre").length,
    };
  }

  // ----- ticker (últimos 6 eventos relevantes) -----
  const tickerSrc = rows
    .filter((r) => r.type.startsWith("tx.") || r.type.startsWith("backrun") || r.type === "whale.swap_detected")
    .slice(0, 6);
  if (tickerSrc.length) {
    snap.ticker = tickerSrc.map((r) => ({ color: colorFor(r.type), text: tickerText(r), time: ago(r.ts) }));
  }

  // ----- KPIs do dia -----
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = rows.filter((r) => new Date(r.ts) >= startOfDay && (r.type === "tx.confirmed" || r.type === "tx.reverted_on_chain"));
  if (today.length) {
    const ok = today.filter((r) => r.type === "tx.confirmed").length;
    const fail = today.length - ok;
    const net = today.reduce((acc, r) => acc + (r.net_profit_usd ?? (r.type === "tx.reverted_on_chain" ? -(r.gas_usd ?? 0) : 0)), 0);
    snap.kpiToday = net;
    snap.kpiTodayTx = today.length;
    snap.kpiOk = ok;
    snap.kpiFail = fail;
    snap.kpiWinRate = ((ok / today.length) * 100).toFixed(1) + "%";
  }

  // ----- estado ao vivo a partir do service_status (heartbeat por serviço) -----
  const byService = (s: string) => statuses.find((x) => x.service === s);
  // Gás: vem do serviço que segura a wallet financiada (liquidator); fallback = qualquer um com gás.
  const gasSvc = byService("liquidator") ?? statuses.find((s) => s.gas_reserve_eth != null);
  if (gasSvc?.gas_reserve_eth != null) snap.gasEth = gasSvc.gas_reserve_eth.toFixed(3);
  if (gasSvc?.gas_reserve_usd != null)
    snap.gasUsd = "$" + gasSvc.gas_reserve_usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // EV adaptativo: do Motor 2 (mis-scanner).
  const mis = byService("mis-scanner");
  if (mis?.adaptive_min_ev_usd != null) snap.adaptiveEv = "$" + mis.adaptive_min_ev_usd.toFixed(2);
  // Estado REAL do bot: o toggle do Motor 2 (auto_paused = travado). Senão, qualquer serviço pausado.
  if (mis?.auto_paused != null) snap.botStatus = mis.auto_paused ? "TRAVADO" : "RUNNING";
  else if (statuses.some((s) => s.auto_paused)) snap.botStatus = "PAUSED";

  // Modo + chain REAIS (pro selo de modo na topbar): prefere o Motor 2 (arb), senão liquidator/qualquer.
  const primary = mis ?? byService("liquidator") ?? statuses.find((s) => s.mode);
  if (primary?.mode) snap.mode = primary.mode;
  if (primary?.chain) snap.chain = primary.chain;

  const gasEvt = rows.find((r) => r.type === "gas.alert" || r.type === "gas.recovered");
  if (gasEvt) {
    const p = gasEvt.payload as ZeusEvent;
    if (snap.gasEth == null && p.balanceEth != null) snap.gasEth = p.balanceEth.toFixed(3);
    if (snap.gasUsd == null && p.balanceUsd != null) snap.gasUsd = "$" + p.balanceUsd.toFixed(2);
  }

  // ----- log do sistema (heartbeat agora vem do service_status, não de events) -----
  const sysTypes = new Set([
    "failure.cooldown_activated",
    "failure.cooldown_expired",
    "gas.alert",
    "gas.recovered",
    "pnl.kill_switch_triggered",
    "liquidator.boot",
    "liquidator.shutdown",
  ]);
  const sysLines = rows
    .filter((r) => sysTypes.has(r.type))
    .slice(0, 6)
    .map((r) => {
      const p = r.payload as ZeusEvent;
      let text = (p?.reason as string) || "";
      if (r.type === "gas.alert") text = text || `Gás baixo · ${p.balanceEth?.toFixed(3) ?? "?"} ETH`;
      else if (r.type.includes("cooldown")) text = text || `Cooldown · ${p.consecutiveFailures ?? "?"} falhas · ${p.cooldownSec ?? "?"}s`;
      else if (r.type.includes("kill_switch")) text = text || `Kill switch · perda 24h ${usd(p.loss24hUsd ?? 0)}`;
      return { time: hhmm(r.ts), color: colorFor(r.type), type: r.type, text: text || r.type };
    });
  // Linha sintética de heartbeat (estado mais fresco) no topo do log.
  const freshest = statuses.slice().sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
  if (freshest) {
    sysLines.unshift({
      time: hhmm(freshest.updated_at),
      color: "var(--gold)",
      type: "zeus.heartbeat",
      text: `Heartbeat ${freshest.service} · gás ${freshest.gas_reserve_eth?.toFixed(3) ?? "?"} ETH · uptime ${uptimeFromSec(freshest.uptime_sec ?? 0)}`,
    });
  }
  if (sysLines.length) snap.eventLog = sysLines.slice(0, 7);

  // ----- inteligência: drift sustentado real (de pnl.reconciled) -----
  const recon = rows.filter((r) => r.type === "pnl.reconciled").slice(0, 6);
  if (recon.length) {
    snap.driftAlarms = recon.map((r) => {
      const p = r.payload as ZeusEvent;
      const bps = Number(p.profitDeltaBps ?? 0);
      const mag = Math.abs(bps);
      const color = mag >= 100 ? "var(--red)" : mag >= 30 ? "var(--gold)" : "var(--green)";
      const cause = (p.attributionCause as string) || "—";
      return { color, text: `${p.protocol ?? "—"} · ${cause}`, bps: `${bps > 0 ? "+" : ""}${bps}bps` };
    });
  }

  // ----- item 1: falhas recentes (failure.recorded) — categoria + quem nos ganhou -----
  const failRows = rows.filter((r) => r.type === "failure.recorded").slice(0, 6);
  if (failRows.length) {
    snap.failures = failRows.map((r) => {
      const p = r.payload as ZeusEvent;
      const category = (p.failureCategory as string) || "—";
      const winner = (p.competitorAlias as string) || "";
      const lost = p.gasUsdLost != null ? `−$${Number(p.gasUsdLost).toFixed(2)} gás` : "";
      const detail = [winner ? `perdeu p/ ${winner}` : "", lost, (p.reason as string) || ""].filter(Boolean).join(" · ");
      return {
        time: hhmm(r.ts),
        color: category.includes("reverted") || category.includes("lost") ? "var(--red)" : "var(--gold)",
        protocol: r.protocol || (p.protocol as string) || "—",
        category,
        detail: detail || category,
      };
    });
  }

  // ----- Fase 2b: post-mortem (corridas perdidas) — failure.recorded COM vencedor resolvido -----
  const lostRows = rows.filter((r) => r.type === "failure.recorded" && (r.payload as ZeusEvent)?.competitorAlias).slice(0, 6);
  if (lostRows.length) {
    snap.postmortem = lostRows.map((r) => {
      const p = r.payload as ZeusEvent;
      const alias = (p.competitorAlias as string) || "—";
      const gwei = p.winner_priority_fee_gwei != null ? ` · ${Number(p.winner_priority_fee_gwei).toFixed(2)} gwei` : "";
      const idx = p.our_tx_index != null ? `pos #${p.our_tx_index}` : p.is_bottom_10pct ? "fim do bloco" : "—";
      return {
        time: hhmm(r.ts),
        text: `${r.protocol || (p.protocol as string) || "—"} · perdemos para ${alias}${gwei}`,
        pos: idx,
      };
    });
  }

  // ----- Fase 2b: log de auto-calibração — calibration.applied -----
  const calibRows = rows.filter((r) => r.type === "calibration.applied").slice(0, 6);
  if (calibRows.length) {
    snap.calib = calibRows.map((r) => {
      const p = r.payload as ZeusEvent;
      const oldV = Number(p.oldThresholdUsd ?? 0);
      const newV = Number(p.newThresholdUsd ?? 0);
      return {
        time: hhmm(r.ts),
        effect: `min EV $${oldV.toFixed(2)} → $${newV.toFixed(2)}`,
        text: (p.reason as string) || "calibração aplicada",
      };
    });
  }

  // ----- item 2: pulso do radar (discovery, do heartbeat em service_status) -----
  // Prioriza o liquidator (motor que faz discovery); fallback = qualquer serviço com discovery.
  const discSvc = (byService("liquidator")?.discovery ? byService("liquidator") : statuses.find((s) => s.discovery))!;
  if (discSvc?.discovery) {
    const d = discSvc.discovery;
    snap.discovery = {
      service: discSvc.service,
      positions: d.positions,
      dispatched: d.dispatched,
      rejected: d.rejected,
      ago: ago(d.atIso),
    };
  }

  // ----- item 3: inteligência real (intel, do heartbeat) substitui o mock quando presente -----
  const intelSvc = byService("liquidator")?.intel ? byService("liquidator") : statuses.find((s) => s.intel);
  if (intelSvc?.intel) {
    snap.intel = { ...intelSvc.intel };
  }
  // O auto-liga da gorjeta competitiva é sinal do Motor 2 (mis-scanner). Se o intel exibido veio do
  // liquidator, ainda assim sobrepomos esse flag de qualquer serviço que o tenha ligado.
  const autoEnabledSvc = statuses.find((s) => s.intel?.competitiveBribeAutoEnabled);
  if (autoEnabledSvc?.intel?.competitiveBribeAutoEnabled) {
    snap.intel = {
      ...(snap.intel ?? {}),
      competitiveBribeAutoEnabled: true,
      bribeAutoEnableReason: autoEnabledSvc.intel.bribeAutoEnableReason,
    };
  }

  // ----- Comparativo por estratégia (tela "Estratégias") -----
  // Funde os 2 serviços: liquidator traz classic-liq + pre-liq; mis-scanner traz filler. Cada serviço
  // zera as estratégias que não rastreia → somar por chave dá o agregado correto.
  const STRATS = ["classic-liq", "pre-liq", "filler"] as const;
  const stratAcc: Record<string, { candidates24h: number; candidateProfitUsd24h: number; executed24h: number; netUsd24h: number }> = {};
  for (const k of STRATS) stratAcc[k] = { candidates24h: 0, candidateProfitUsd24h: 0, executed24h: 0, netUsd24h: 0 };
  let sawStrat = false;
  // Guarda de número finito: se o jsonb tiver lixo (string/NaN/null), soma 0 em vez de poluir o agregado com NaN.
  const fin = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const s of statuses) {
    for (const st of s.strategy_stats ?? []) {
      const a = stratAcc[st.strategy];
      if (!a) continue;
      sawStrat = true;
      a.candidates24h += fin(st.candidates24h);
      a.candidateProfitUsd24h += fin(st.candidateProfitUsd24h);
      a.executed24h += fin(st.executed24h);
      a.netUsd24h += fin(st.netUsd24h);
    }
  }
  if (sawStrat) snap.strategyStats = STRATS.map((strategy) => ({ strategy, ...stratAcc[strategy] }));

  // ----- Universo vetado (tela "Tokens") — funde os heartbeats por (token, motor) -----
  // liquidator traz motor1; mis-scanner traz motor2. Chave (token+motor) → último heartbeat ganha.
  const vettedByKey = new Map<string, NonNullable<LiveSnapshot["vettedUniverse"]>[number]>();
  for (const s of statuses) {
    for (const t of s.vetted_universe ?? []) {
      if (t.motor !== "motor1" && t.motor !== "motor2") continue;
      if (t.verdict !== "pass" && t.verdict !== "reject") continue;
      vettedByKey.set(`${(t.token || "").toLowerCase()}:${t.motor}`, {
        token: t.token,
        symbol: t.symbol,
        motor: t.motor,
        verdict: t.verdict,
        reason: t.reason ?? "",
        exitDex: t.exitDex ?? undefined,
        liquidityUsd: typeof t.liquidityUsd === "number" && Number.isFinite(t.liquidityUsd) ? t.liquidityUsd : 0,
        locked: Boolean(t.locked),
      });
    }
  }
  if (vettedByKey.size) snap.vettedUniverse = Array.from(vettedByKey.values());

  // ----- Log de entrou/saiu (tela "Tokens") — dos eventos token.entered/token.exited -----
  const tokenEvts = rows.filter((r) => r.type === "token.entered" || r.type === "token.exited").slice(0, 20);
  if (tokenEvts.length) {
    snap.tokenLog = tokenEvts.map((r) => {
      const p = r.payload as ZeusEvent;
      const entered = r.type === "token.entered";
      return {
        time: hhmm(r.ts),
        symbol: r.pair || (p.symbol as string) || "—",
        motor: (p.motor as string) === "motor1" ? "M1" : "M2",
        action: entered ? "entrou" : "saiu",
        reason: (p.reason as string) || "—",
        color: entered ? "var(--green)" : "var(--red)",
      };
    });
  }

  // ----- Fase 2: blocos extras do heartbeat (service_status jsonb) -----
  // health / competitors / cooldowns / kill_switch vêm do liquidator; edge_pairs do mis-scanner.
  const liq = byService("liquidator");
  const healthSvc = liq?.health ? liq : statuses.find((s) => s.health);
  if (healthSvc?.health?.components?.length) snap.health = healthSvc.health.components;

  const compSvc = liq?.competitors ? liq : statuses.find((s) => s.competitors);
  if (compSvc?.competitors?.length) snap.competitors = compSvc.competitors;

  const coolSvc = liq?.cooldowns ? liq : statuses.find((s) => s.cooldowns);
  if (coolSvc?.cooldowns?.length) snap.cooldowns = coolSvc.cooldowns;

  const ksSvc = liq?.kill_switch ? liq : statuses.find((s) => s.kill_switch);
  if (ksSvc?.kill_switch) snap.killSwitch = ksSvc.kill_switch;

  const edgeSvc = byService("mis-scanner")?.edge_pairs ? byService("mis-scanner") : statuses.find((s) => s.edge_pairs);
  if (edgeSvc?.edge_pairs?.length) snap.edgePairs = edgeSvc.edge_pairs;

  // Fase 2b — latência de dispatch (do liquidator; omitida enquanto não há dispatch real).
  const latSvc = liq?.latency ? liq : statuses.find((s) => s.latency);
  if (latSvc?.latency && latSvc.latency.samples > 0) snap.latency = latSvc.latency;

  // Motor 1 — resiliência de reorg (reorgs 24h + órfãs recuperadas).
  const reorgSvc = liq?.reorgs ? liq : statuses.find((s) => s.reorgs);
  if (reorgSvc?.reorgs) snap.reorgs = reorgSvc.reorgs;

  // Fase 2b — histórico de saldo 30d (de wallet_snapshots, ordenado asc por ts). Saldo em ETH
  // (mesma unidade do mock/gráfico de reserva de gás; cores do design assumem ETH).
  if (walletSnaps.length) {
    snap.whRaw = [...walletSnaps]
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
      .slice(-30)
      .map((w) => Number(w.balance_eth ?? 0));
  }

  // ----- item 4: mini-cards por motor (PnL + ops 24h, derivado dos eventos tx.*) -----
  const startMs = startOfDay.getTime() - 23 * 60 * 60 * 1000; // janela ~24h
  const acc: Record<string, { netUsd: number; ops: number }> = {};
  for (const r of rows) {
    if (r.type !== "tx.confirmed" && r.type !== "tx.reverted_on_chain") continue;
    if (new Date(r.ts).getTime() < startMs) continue;
    const motor = motorOf(r.protocol);
    if (!motor) continue;
    const a = (acc[motor] ??= { netUsd: 0, ops: 0 });
    a.netUsd += r.net_profit_usd ?? (r.type === "tx.reverted_on_chain" ? -(r.gas_usd ?? 0) : 0);
    a.ops += 1;
  }
  // Sempre mostra os 3 cards (M1/M2/M3); motores sem evento ainda ficam zerados (honesto).
  snap.motorCards = ["motor1", "motor2", "motor3"].map((tag) => ({
    tag,
    label: MOTOR_LABEL[tag] ?? tag,
    netUsd: acc[tag]?.netUsd ?? 0,
    ops: acc[tag]?.ops ?? 0,
  }));

  // ===== FASE 1: agregados de PnL / gás / relatórios (derivados dos events tx.*) =====
  const txAgg = rows.filter((r) => r.type === "tx.confirmed" || r.type === "tx.reverted_on_chain");
  const netOf = (r: EventRow) => r.net_profit_usd ?? (r.type === "tx.reverted_on_chain" ? -(r.gas_usd ?? 0) : 0);
  if (txAgg.length) {
    const nowMs = Date.now();
    const DAY = 86_400_000;
    const inWin = (ms: number) => txAgg.filter((r) => nowMs - new Date(r.ts).getTime() <= ms);
    const sumNet = (rs: EventRow[]) => rs.reduce((a, r) => a + netOf(r), 0);
    const sumGas = (rs: EventRow[]) => rs.reduce((a, r) => a + (r.gas_usd ?? 0), 0);

    snap.kpi7d = sumNet(inWin(7 * DAY));
    snap.kpi30d = sumNet(inWin(30 * DAY));
    snap.kpiProj = snap.kpi30d; // mês-a-mês (MTD) — projeção simples e honesta
    snap.gas24h = sumGas(inWin(DAY));
    snap.gas30d = sumGas(inWin(30 * DAY));
    const gross30 = inWin(30 * DAY).reduce((a, r) => a + (r.net_profit_usd != null ? r.net_profit_usd + (r.gas_usd ?? 0) : 0), 0);
    snap.gas30dPct = gross30 > 0 ? Math.round((snap.gas30d / gross30) * 100) + "%" : "—";

    // net por dia (p/ barras 14d + série cumulativa do gráfico de PnL)
    const day0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    const dayKey = (ts: string) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const byDay: Record<number, number> = {};
    for (const r of txAgg) byDay[dayKey(r.ts)] = (byDay[dayKey(r.ts)] ?? 0) + netOf(r);
    const raw14 = Array.from({ length: 14 }, (_, i) => byDay[day0 - (13 - i) * DAY] ?? 0);
    snap.raw14 = raw14;
    snap.kpiW14sum = raw14.reduce((a, b) => a + b, 0);

    // série diária cumulativa (realizado) p/ o gráfico realizado-vs-esperado
    let cum = 0;
    const realized = Array.from({ length: 15 }, (_, i) => (cum += byDay[day0 - (14 - i) * DAY] ?? 0));
    snap.pnlSeries = { daily: realized, weekly: [], monthly: [] };
    // esperado (de pnl.reconciled), série diária cumulativa
    const reconAll = rows.filter((r) => r.type === "pnl.reconciled");
    if (reconAll.length) {
      const expByDay: Record<number, number> = {};
      for (const r of reconAll) {
        const p = r.payload as Record<string, unknown>;
        expByDay[dayKey(r.ts)] = (expByDay[dayKey(r.ts)] ?? 0) + Number(p.expectedUsd ?? p.netProfitUsd ?? 0);
      }
      let cumE = 0;
      snap.expSeries = { daily: Array.from({ length: 15 }, (_, i) => (cumE += expByDay[day0 - (14 - i) * DAY] ?? 0)), weekly: [], monthly: [] };
    }

    // breakdown por motor / protocolo (net acumulado dos events carregados)
    const motorNet: Record<string, number> = {};
    const protoNet: Record<string, number> = {};
    for (const r of txAgg) {
      const n = netOf(r);
      const m = motorOf(r.protocol);
      if (m) motorNet[m] = (motorNet[m] ?? 0) + n;
      if (r.protocol) protoNet[r.protocol] = (protoNet[r.protocol] ?? 0) + n;
    }
    const mkBreak = (obj: Record<string, number>, labelFn: (k: string) => string) => {
      const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
      const max = Math.max(1, ...entries.map(([, v]) => Math.abs(v)));
      return entries.map(([k, v]) => ({ name: labelFn(k), val: v, pct: String(Math.round((Math.abs(v) / max) * 100)) }));
    };
    if (Object.keys(motorNet).length) snap.motorBreak = mkBreak(motorNet, (k) => MOTOR_LABEL[k] ?? k);
    if (Object.keys(protoNet).length) snap.protoBreak = mkBreak(protoNet, (k) => k);

    // relatórios por período (net / win / ops / gás / drift)
    const driftAvg = (rs: EventRow[]) => {
      const ds = rs.map((r) => r.profit_delta_bps ?? 0).filter((x) => x !== 0);
      return ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : 0;
    };
    const mkRep = (ms: number, label: string, range: string) => {
      const rs = inWin(ms);
      const ok = rs.filter((r) => r.type === "tx.confirmed").length;
      const mb: Record<string, number> = {};
      for (const r of rs) { const mm = motorOf(r.protocol); if (mm) mb[mm] = (mb[mm] ?? 0) + netOf(r); }
      const top = Object.entries(mb).sort((a, b) => b[1] - a[1])[0];
      return {
        net: sumNet(rs),
        win: rs.length ? ((ok / rs.length) * 100).toFixed(1) + "%" : "—",
        ops: String(rs.length),
        gas: sumGas(rs),
        drift: rs.length ? `${driftAvg(rs)}bps` : "—",
        bestMotor: top ? (MOTOR_LABEL[top[0]] ?? top[0]) : "—",
        range,
        label,
      };
    };
    snap.repByPeriod = {
      daily: mkRep(DAY, "Diário", "últimas 24h"),
      weekly: mkRep(7 * DAY, "Semanal", "últimos 7d"),
      monthly: mkRep(30 * DAY, "Mensal", "últimos 30d"),
    };
  }

  return snap;
}
