import { MOCK, EMPTY } from "./mockData";
import { generateInsights, bribeVerdict } from "./insights";
import type { LiveSnapshot, UiState } from "./types";

// ===== Helpers de formatação (portados do design) =====
function fmt(n: number, dec?: number) {
  const d = dec == null ? 2 : dec;
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function usd(n: number) {
  const s = n < 0 ? "−" : "+";
  return s + "$" + fmt(Math.abs(n));
}
export function usdp(n: number) {
  return "$" + fmt(Math.abs(n));
}
function col(n: number) {
  return n < 0 ? "var(--red)" : "var(--green)";
}

/** Constrói um path SVG a partir de uma série, normalizado num range comum. */
function pathFrom(vals: number[], gmin: number, grng: number, W: number, H: number, pad: number, close: boolean) {
  if (vals.length < 2) return ""; // sem dado suficiente (modo real vazio) → gráfico em branco
  const n = vals.length;
  const pts = vals.map((v, i) => [pad + (i / (n - 1)) * (W - pad * 2), H - pad - ((v - gmin) / grng) * (H - pad * 2)] as const);
  let d = "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L");
  if (close) d += ` L${(W - pad).toFixed(1)},${(H - pad).toFixed(1)} L${pad.toFixed(1)},${(H - pad).toFixed(1)} Z`;
  return d;
}

export function uptimeFromSec(totalSec: number) {
  const dd = Math.floor(totalSec / 86400);
  const hh = Math.floor((totalSec % 86400) / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  return `${dd}d ${String(hh).padStart(2, "0")}h ${String(mm).padStart(2, "0")}m`;
}

export type ViewModel = ReturnType<typeof buildViewModel>;

/**
 * Porte de `renderVals()` do design. `live` (opcional) sobrescreve os campos
 * dinâmicos com dados reais derivados dos eventos do Supabase.
 */
export function buildViewModel(ui: UiState, live?: LiveSnapshot | null) {
  // demo = sem snapshot ao vivo (live == null). No modo AO VIVO usamos EMPTY como fallback → cards
  // sem dado real ficam vazios ("—"/0) em vez de mostrar mock. O Dashboard passa live=null no demo.
  const demo = live == null;
  const M = demo ? MOCK : EMPTY;
  const screen = ui.screen;

  // ---- uptime / clock (tick) ----
  const baseUp = 287400 + ui.tick;
  const uptime = demo ? uptimeFromSec(baseUp) : "—";
  const now = new Date();
  const clock =
    String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0");

  // ---- topbar / status ----
  const botStatus = live?.botStatus ?? M.botStatus;
  // Selo de MODO real (do heartbeat): DRY-RUN (observando) · ARMADO (travado) · LIVE (executando).
  const modeBadge = (() => {
    const m = (live?.mode || "").toLowerCase();
    const travado = live?.botStatus === "TRAVADO" || live?.botStatus === "PAUSED";
    if (m === "dryrun") return { label: "DRY-RUN", sub: "observando", color: "var(--cyan)" };
    if (m === "testnet") return { label: "TESTNET", sub: travado ? "travado" : "ativo", color: "var(--gold)" };
    if (m === "mainnet")
      return travado
        ? { label: "ARMADO", sub: "travado", color: "var(--gold)" }
        : { label: "LIVE", sub: "executando", color: "var(--green)" };
    return { label: demo ? "DEMO" : m ? m.toUpperCase() : "—", sub: "", color: "var(--muted)" };
  })();
  const chainLabel = (live?.chain || (demo ? "Base" : "—")).toUpperCase();
  const runwayDays = live?.runwayDays ?? M.runwayDays;
  const adaptiveEv = live?.adaptiveEv ?? M.adaptiveEv;
  const gas = { eth: live?.gasEth ?? M.gas.eth, usd: live?.gasUsd ?? usdp(M.gas.usd) };

  // ---- KPIs ----
  const k = {
    today: live?.kpiToday != null ? usd(live.kpiToday) : usd(M.k.today),
    todayTx: live?.kpiTodayTx ?? M.k.todayTx,
    w7: usd(live?.kpi7d ?? M.k.w7),
    w7delta: M.k.w7delta,
    m30: usd(live?.kpi30d ?? M.k.m30),
    proj: usd(live?.kpiProj ?? M.k.proj),
    winRate: live?.kpiWinRate ?? M.k.winRate,
    ok: live?.kpiOk ?? M.k.ok,
    fail: live?.kpiFail ?? M.k.fail,
    w14sum: usd(live?.kpiW14sum ?? M.k.w14sum),
  };

  // ---- 14d bars ----
  const raw14 = live?.raw14 ?? M.raw14;
  const max14 = Math.max(1, ...raw14.map(Math.abs));
  const pnl14 = raw14.map((v, i) => ({
    pct: ((Math.abs(v) / max14) * 100).toFixed(0),
    color: v < 0 ? "var(--red)" : i === raw14.length - 1 ? "var(--gold)" : "var(--green)",
    label: "D-" + (raw14.length - 1 - i) + ": " + usd(v),
  }));

  // ---- motors (item 4: mini-cards por motor) ----
  // Live derivado dos eventos tx.* quando há dados; senão o mock do design.
  const motors = (() => {
    if (!live?.motorCards) return M.motors.map((m) => ({ ...m, pnl: usd(m.pnl) }));
    const total = live.motorCards.reduce((s, x) => s + Math.max(0, x.netUsd), 0) || 1;
    const meta: Record<string, [string, string]> = {
      motor1: ["M1", "Liquidações"],
      motor2: ["M2", "Arbitragem"],
      motor3: ["M3", "Backrun"],
    };
    return live.motorCards.map((c) => {
      const [tag, name] = meta[c.tag] ?? [c.tag, c.tag];
      const share = Math.round((Math.max(0, c.netUsd) / total) * 100);
      return { tag, name, pnl: usd(c.netUsd), ops: c.ops, share: `${share}%`, barPct: String(share) };
    });
  })();

  // ---- Comparativo de estratégias (tela "Estratégias"): candidatos × resultados ----
  const STRAT_META: Record<string, [string, string]> = {
    "classic-liq": ["Liquidação Clássica", "⚡"],
    "pre-liq": ["Pré-liquidação Morpho", "🔮"],
    filler: ["Filler UniswapX", "🔀"],
    arb: ["Arb Cross-DEX", "⇄"],
  };
  const strategyCards = (live?.strategyStats ?? M.strategyStats ?? []).map((s) => {
    const [name, icon] = STRAT_META[s.strategy] ?? [s.strategy, "•"];
    const avgCand = s.candidates24h > 0 ? s.candidateProfitUsd24h / s.candidates24h : 0;
    const avgExec = s.executed24h > 0 ? s.netUsd24h / s.executed24h : 0;
    return {
      strategy: s.strategy,
      name,
      icon,
      candidates: s.candidates24h,
      candidateUsd: usd(s.candidateProfitUsd24h),
      candidateUsdRaw: s.candidateProfitUsd24h,
      executed: s.executed24h,
      netUsd: usd(s.netUsd24h),
      netUsdRaw: s.netUsd24h,
      avgCand: usd(avgCand),
      avgExec: usd(avgExec),
    };
  });
  // Vencedor: maior lucro REALIZADO se já houve execução; senão, maior POTENCIAL (candidatos do DRY_RUN).
  const strategyWinner = (() => {
    if (!strategyCards.length) return null;
    const anyExec = strategyCards.some((s) => s.executed > 0);
    const k = anyExec ? "netUsdRaw" : "candidateUsdRaw";
    return strategyCards.reduce((best, s) => ((s as never)[k] > (best as never)[k] ? s : best)).strategy;
  })();

  // ---- Universo vetado (tela "Tokens"): porteiro por token (entrou/saiu + motivo PT-BR) ----
  const tokenCards = (live?.vettedUniverse ?? M.vettedUniverse ?? []).map((t) => ({
    token: t.token,
    symbol: t.symbol,
    motor: t.motor,
    motorLabel: t.motor === "motor1" ? "M1 · Liquidação" : "M2 · Arb",
    verdict: t.verdict,
    pass: t.verdict === "pass",
    reason: t.reason,
    exitDex: t.exitDex ?? "—",
    liquidity: t.liquidityUsd ? usd(t.liquidityUsd) : "—",
    locked: t.locked,
    // Lock rico (Tier 0): "🔒 80% UniCrypt · até 03/27" — vira title (hover) na tela.
    lock: t.locked
      ? `${t.lockPct ? t.lockPct + "% " : ""}${t.locker ?? "travado"}${t.unlockIso ? " · até " + new Date(t.unlockIso).toLocaleDateString("pt-BR", { month: "2-digit", year: "2-digit" }) : ""}`
      : "",
    // Verdict feito com dados incompletos → selo "dados parciais" (o painel deixa de esconder a incerteza).
    partial: Boolean(t.partial),
  }));
  const tokenCounts = {
    total: tokenCards.length,
    pass: tokenCards.filter((t) => t.pass).length,
    reject: tokenCards.filter((t) => !t.pass).length,
  };

  // ---- Marco: "lucro provado" da arb de 2 pernas → hora de ligar a triangular ----
  // Gatilho REAL e conservador: lucro líquido ACUMULADO do Motor 2 (arb) >= limiar E nº de operações
  // confirmadas >= mínimo (pra um trade sortudo não disparar). Só no modo AO VIVO (não no demo).
  // Em DRY_RUN o netUsd do M2 fica 0 (não envia) → o aviso só aparece quando a arb faz dinheiro de verdade.
  const TRIANGULAR_PROVEN_PROFIT_USD = 50; // ajuste fino quando quiser ser mais/menos exigente
  const TRIANGULAR_MIN_OPS = 20;
  const triangularReady = (() => {
    if (demo || !live?.motorCards) return null;
    const m2 = live.motorCards.find((c) => c.tag === "motor2");
    if (!m2 || m2.netUsd < TRIANGULAR_PROVEN_PROFIT_USD || m2.ops < TRIANGULAR_MIN_OPS) return null;
    return {
      text: "Lucro provado, hora de implementar a ligação da arb triangular",
      detail: `Arb de 2 pernas acumulou ${usd(m2.netUsd)} líquidos em ${m2.ops} operações — edge confirmado.`,
    };
  })();

  // ---- ticker ----
  const ticker =
    live?.ticker ??
    M.ticker.map((e) => {
      const sec = e.t + (ui.tick % 60);
      const lbl = sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m";
      return { color: e.color, text: e.text, time: lbl };
    });

  // ---- transactions ----
  const stMeta: Record<string, { label: string; color: string }> = {
    ok: { label: "CONFIRMED", color: "var(--green)" },
    rev: { label: "REVERTED", color: "var(--red)" },
    pre: { label: "PRE-REJECT", color: "var(--gold)" },
  };
  const explorer = process.env.NEXT_PUBLIC_EXPLORER_URL || "https://basescan.org";
  const sourceRows = live?.txRows ?? M.allRows;
  const q = (ui.query || "").toLowerCase();
  let filtered = sourceRows.filter((r) => ui.txFilter === "all" || r.st === ui.txFilter);
  if (q) filtered = filtered.filter((r) => ((r.hash || "") + r.protocol + r.pair).toLowerCase().includes(q));
  const txRows = filtered.map((r) => ({
    time: r.time,
    statusLabel: stMeta[r.st].label,
    statusColor: stMeta[r.st].color,
    protocol: r.protocol,
    pair: r.pair,
    venue: r.venue, // DEX da troca (multi-DEX Motor 1) — só liquidações confirmadas têm
    net: r.st === "pre" ? "—" : usd(r.net),
    netColor: r.st === "pre" ? "var(--muted)" : col(r.net),
    gas: r.st === "pre" ? "—" : usdp(r.gas),
    drift: r.st === "pre" ? "—" : (r.drift > 0 ? "+" : "") + r.drift + "bps",
    driftColor: r.drift < -10 ? "var(--red)" : "var(--muted)",
    hashShort: r.hash ? r.hash + "…" : r.reason || "—",
    url: r.hash ? `${explorer}/tx/${r.hash}` : "#",
    mode: r.mode,
  }));
  const counts = live?.txCounts ?? {
    all: M.allRows.length,
    ok: M.allRows.filter((r) => r.st === "ok").length,
    rev: M.allRows.filter((r) => r.st === "rev").length,
    pre: M.allRows.filter((r) => r.st === "pre").length,
  };
  const filtDef: [UiState["txFilter"], string][] = [
    ["all", "Todas"],
    ["ok", "Confirmadas"],
    ["rev", "Revertidas"],
    ["pre", "Pré-rejeição"],
  ];
  const txFilters = filtDef.map(([id, label]) => ({
    id,
    label,
    count: counts[id],
    active: ui.txFilter === id,
    bg: ui.txFilter === id ? "var(--panel2)" : "transparent",
    fg: ui.txFilter === id ? "var(--text)" : "var(--muted)",
    border: ui.txFilter === id ? "var(--gold)" : "var(--border)",
  }));
  const txHeads = ["Hora", "Status", "Protocolo", "Par", "Net", "Gás", "Drift", "Hash", "Mode"];

  // ---- PnL ----
  const periodDef: [UiState["period"], string][] = [
    ["daily", "Diário"],
    ["weekly", "Semanal"],
    ["monthly", "Mensal"],
  ];
  const periods = periodDef.map(([id, label]) => ({
    id,
    label,
    active: ui.period === id,
    bg: ui.period === id ? "var(--gold)" : "transparent",
    fg: ui.period === id ? "var(--bg)" : "var(--muted)",
  }));
  const ser = (live?.pnlSeries ?? M.pnlSeries)[ui.period] ?? [];
  const expSer = (live?.expSeries ?? M.expSeries)[ui.period] ?? [];
  const allV = ser.concat(expSer);
  const gmin = Math.min(...allV);
  const gmax = Math.max(...allV);
  const grng = gmax - gmin || 1;
  const pnlLinePath = pathFrom(ser, gmin, grng, 600, 200, 12, false);
  const pnlAreaPath = pathFrom(ser, gmin, grng, 600, 200, 12, true);
  const pnlExpectedPath = pathFrom(expSer, gmin, grng, 600, 200, 12, false);
  const pnlk = {
    realized: ser.length ? usd(ser[ser.length - 1]) : "—",
    expected: expSer.length ? usd(expSer[expSer.length - 1]) : "—",
    drift: demo ? "−118 bps" : "—",
    gas: demo ? usdp(1420) : "—",
  };
  const motorBreak = (live?.motorBreak ?? M.motorBreak).map((m) => ({ ...m, val: usd(m.val) }));
  const protoBreak = (live?.protoBreak ?? M.protoBreak).map((p) => ({ ...p, val: usd(p.val) }));

  // ---- wallet ----
  const wallet = {
    gas24h: usdp(live?.gas24h ?? M.wallet.gas24h),
    gas24hEth: live?.gas24hEth ?? M.wallet.gas24hEth,
    gas30d: usdp(live?.gas30d ?? M.wallet.gas30d),
    gas30dPct: live?.gas30dPct ?? M.wallet.gas30dPct,
  };
  const whRaw = live?.whRaw?.length ? live.whRaw : M.whRaw;
  const whMax = Math.max(1e-9, ...whRaw);
  const walletHist = whRaw.map((v, i) => ({
    pct: ((v / whMax) * 100).toFixed(0),
    color: i === 7 || i === 18 ? "var(--gold)" : v < 0.45 ? "var(--red)" : "var(--cyan)",
  }));
  const gasAlerts = M.gasAlerts;

  // ---- intelligence ----
  // Inteligência AO VIVO (item 3): market-bribe/competidores/drift reais do heartbeat (null = só mock).
  const intelLive = live?.intel ?? null;
  // market-bribe real (P50/P75/P95) do heartbeat; senão o mock do design.
  const bribe =
    intelLive?.marketBribeP50Gwei != null
      ? [
          { pct: "P50", gwei: intelLive.marketBribeP50Gwei.toFixed(2), note: "mediana" },
          { pct: "P75", gwei: (intelLive.marketBribeP75Gwei ?? 0).toFixed(2), note: "disputado" },
          { pct: "P95", gwei: (intelLive.marketBribeP95Gwei ?? 0).toFixed(2), note: "guerra de bribe" },
        ]
      : M.bribe;
  // Nosso bribe (live do heartbeat ou mock no DEMO) + veredito dinâmico vs mercado (p50/p75/p95).
  const ourBribeGwei = intelLive?.ourBribeGwei;
  const ourBribe = demo ? M.ourBribe : ourBribeGwei != null ? `${ourBribeGwei} gwei` : "—";
  // Se o ZEUS auto-ajustou o bribe (competição), a mensagem AVISA isso; senão, veredito vs mercado.
  const bribeNote = demo
    ? { text: "abaixo do p75. Considere subir em pares disputados.", color: "var(--gold)" }
    : intelLive?.bribeAutoRaised
      ? {
          text:
            intelLive.bribeReason === "capped-by-profit"
              ? "ZEUS subiu o bribe AUTOMATICAMENTE até o limite do lucro (não dá pra pagar mais sem prejuízo)."
              : "ZEUS subiu o bribe AUTOMATICAMENTE pra ganhar a corrida — dentro do lucro.",
          color: "var(--green)",
        }
      : bribeVerdict(ourBribeGwei, intelLive?.marketBribeP50Gwei, intelLive?.marketBribeP75Gwei, intelLive?.marketBribeP95Gwei);
  // Banner "o ZEUS ligou sozinho" (nível-feature): só ao vivo, quando o detector ativou por gas_outbid.
  const bribeAutoEnabled =
    !demo && intelLive?.competitiveBribeAutoEnabled
      ? {
          text: `⚡ ZEUS ligou o bribe competitivo automaticamente — ${
            intelLive.bribeAutoEnableReason ?? "superados no gás"
          } (dentro do lucro, nunca no vermelho).`,
          color: "var(--green)",
        }
      : null;
  // drift real (pnl.reconciled) quando há eventos; senão o mock do design.
  const driftAlarms = live?.driftAlarms?.length ? live.driftAlarms : M.driftAlarms;
  // competidores reais do heartbeat. "won" = corridas que ele nos ganhou (wonVsUs, Fase 2b) quando há
  // execução real; cai em txs observadas no DRY_RUN. "lost" (vezes que ganhamos dele) não é rastreado.
  const competitors = live?.competitors?.length
    ? live.competitors.map((c) => ({
        name: c.alias,
        won: c.wonVsUs ?? c.txs,
        lost: 0,
        bribe: `${c.bribeGwei.toFixed(2)} gwei`,
        kind: c.category,
      }))
    : M.competitors;
  const postmortem = live?.postmortem?.length ? live.postmortem : M.postmortem;
  const calib = live?.calib?.length ? live.calib : M.calib;
  const edgePairs = live?.edgePairs?.length
    ? live.edgePairs.map((e) => ({
        pair: e.pair,
        edge: e.persistPct,
        pct: e.persistPct.replace("%", ""),
        note: `${e.avgBps} bps · ${e.samples} amostras`,
      }))
    : M.edgePairs;
  // Item 4 — diagnóstico de concorrência (builders dominantes + nossa posição no bloco).
  const competitionRaw = live?.competition ?? (demo ? M.competition : null);
  const competition = competitionRaw
    ? {
        builders: competitionRaw.topBuilders.map((b) => ({
          alias: b.alias,
          blocks: b.blocks,
          competitorTxs: b.competitorTxs,
          ourTxs: b.ourTxs,
        })),
        // Resumo honesto: sem execução ainda → 0 amostras → não afirma nada sobre posição.
        positionText:
          competitionRaw.position.samples > 0
            ? `${competitionRaw.position.bottom10pctPct}% das nossas tx caem no fundo do bloco · ${competitionRaw.position.samples} amostras`
            : "sem execução real ainda — posição no bloco fica pronta quando o bot enviar tx",
        hasPosition: competitionRaw.position.samples > 0,
      }
    : null;

  // ---- health ----
  const components = live?.health?.length
    ? live.health.map((c) => ({
        name: c.name,
        status: c.ok ? "READY" : "DOWN",
        color: c.ok ? "var(--green)" : "var(--red)",
        detail: c.detail ?? "",
      }))
    : M.components;
  const cooldowns = live?.cooldowns?.length
    ? live.cooldowns.map((c) => ({
        scope: c.label,
        state: c.active ? "ATIVO" : "OK",
        color: c.active ? "var(--gold)" : "var(--green)",
        reason: c.reason,
      }))
    : M.cooldowns;
  // Falhas recentes (item 1) + pulso do radar (item 2) — reais quando há eventos/heartbeat.
  const failures = live?.failures ?? [];
  const discovery = live?.discovery ?? null;
  const latAll = M.latP50.concat(M.latP95);
  const lmin = Math.min(...latAll);
  const lmax = Math.max(...latAll);
  const lrng = lmax - lmin || 1;
  const latP50Path = pathFrom(M.latP50, lmin, lrng, 600, 150, 8, false);
  const latP95Path = pathFrom(M.latP95, lmin, lrng, 600, 150, 8, false);
  const ksLive = live?.killSwitch ?? null;
  const ks = ksLive
    ? {
        loss: usd(-Math.abs(ksLive.loss24hUsd)),
        limit: usdp(ksLive.limitUsd),
        pct: ksLive.limitUsd > 0 ? ((Math.abs(ksLive.loss24hUsd) / ksLive.limitUsd) * 100).toFixed(0) : "0",
        last: ksLive.triggered ? "DISPARADO" : "—",
      }
    : { loss: usd(M.ks.loss), limit: usdp(M.ks.limit), pct: M.ks.pct, last: M.ks.last };
  const healthKpis = [
    {
      label: "Kill switch",
      isStatus: true,
      isVal: false,
      dot: ksLive ? (ksLive.triggered ? "var(--red)" : "var(--green)") : demo ? "var(--green)" : "var(--muted)",
      big: ksLive ? (ksLive.triggered ? "DISPARADO" : "Armado") : demo ? "Armado" : "—",
      unit: "",
      color: "var(--text)",
      sub: ksLive ? `limite 24h: ${usdp(ksLive.limitUsd)}` : demo ? "limite 24h: −$2.000" : "",
    },
    { label: "Uptime", isStatus: false, isVal: true, dot: "", big: uptime, unit: "", color: "var(--text)", sub: demo ? "sem restart" : "" },
    { label: "Dispatch p50", isStatus: false, isVal: true, dot: "", big: live?.latency ? String(live.latency.p50Ms) : demo ? "142" : "—", unit: live?.latency || demo ? "ms" : "", color: "var(--text)", sub: live?.latency ? `${live.latency.samples} amostras` : demo ? "alvo <200ms" : "" },
    { label: "Dispatch p95", isStatus: false, isVal: true, dot: "", big: live?.latency ? String(live.latency.p95Ms) : demo ? "410" : "—", unit: live?.latency || demo ? "ms" : "", color: "var(--gold)", sub: live?.latency ? "alvo <500ms" : demo ? "alvo <500ms" : "" },
    { label: "Reorgs · 24h", isStatus: false, isVal: true, dot: "", big: live?.reorgs ? String(live.reorgs.window24h) : demo ? "3" : "—", unit: "", color: "var(--text2)", sub: live?.reorgs ? `${live.reorgs.orphansRecovered} órfãs recuperadas` : demo ? "prof. máx. 2" : "" },
    { label: "Taxa de erro", isStatus: false, isVal: true, dot: "", big: demo ? "1.3%" : "—", unit: "", color: "var(--cyan)", sub: demo ? "6 de 477 ops" : "" },
  ];
  const eventLog = live?.eventLog ?? M.eventLog;

  // ---- reports ----
  const rp = (live?.repByPeriod ?? M.repByPeriod)[ui.period] ?? M.repByPeriod[ui.period];
  const rep = {
    net: usd(rp.net),
    win: rp.win,
    ops: rp.ops,
    gas: usdp(rp.gas),
    drift: rp.drift,
    bestMotor: rp.bestMotor,
    summary: demo
      ? `No período, o ZEUS executou ${rp.ops} operações com win-rate de ${rp.win}, gerando ${usd(rp.net)} líquidos na Base mainnet. O Motor 2 (Arbitragem) liderou a contribuição de lucro, enquanto o gás representou ${M.wallet.gas30dPct} do bruto. O drift médio de ${rp.drift} indica execução ligeiramente abaixo do esperado — atribuível a competição de bribe em WETH/USDC. Runway de gás saudável em ${runwayDays} dias.`
      : "Sem dados ainda — o resumo é gerado a partir dos eventos reais do bot.",
  };

  // ---- Fase 3: insights gerados (regras sobre os dados reais; em DEMO usa a narrativa do design) ----
  const insights = demo
    ? M.insights
    : generateInsights({
        motorBreak: live?.motorBreak,
        driftBps: live?.intel?.driftBps,
        killSwitch: ksLive ?? undefined,
        runwayDays: parseFloat(runwayDays),
        competitors: live?.competitors,
        winRatePct: parseFloat(String(k.winRate)),
      });

  // ---- settings ----
  const notif = ui.notif;
  const notifRules = M.notifMeta.map(([key, label, value]) => ({
    key,
    label,
    value,
    on: !!notif[key],
    trackBg: notif[key] ? "var(--green)" : "var(--border2)",
    knobLeft: notif[key] ? "21px" : "3px",
  }));
  const chans = ui.chans;
  const channels = M.chanMeta.map(([key, label, sub]) => ({
    key,
    label,
    sub,
    on: !!chans[key],
    trackBg: chans[key] ? "var(--green)" : "var(--border2)",
    knobLeft: chans[key] ? "21px" : "3px",
  }));

  return {
    uptime,
    clock,
    botStatus,
    modeBadge,
    chainLabel,
    runwayDays,
    adaptiveEv,
    triangularReady,
    gas,
    k,
    pnl14,
    motors,
    strategyCards,
    strategyWinner,
    tokenCards,
    tokenCounts,
    tokenLog: live?.tokenLog ?? M.tokenLog ?? [],
    vettingEnforce: live?.vettingEnforce ?? { motor1: false, motor2: false },
    vettingRevetAt: live?.vettingRevetAt,
    insights,
    ticker,
    txFilters,
    txHeads,
    txRows,
    periods,
    pnlk,
    pnlLinePath,
    pnlAreaPath,
    pnlExpectedPath,
    motorBreak,
    protoBreak,
    wallet,
    walletHist,
    gasAlerts,
    bribe,
    ourBribe,
    bribeNote,
    bribeAutoEnabled,
    driftAlarms,
    intelLive,
    failures,
    discovery,
    competitors,
    postmortem,
    calib,
    edgePairs,
    competition,
    components,
    cooldowns,
    healthKpis,
    latP50Path,
    latP95Path,
    ks,
    eventLog,
    rep,
    reportPeriodLabel: rp.label,
    reportRange: rp.range,
    notifRules,
    channels,
  };
}
