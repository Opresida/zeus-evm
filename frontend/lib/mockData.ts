import type { TxRow, Competition, CombatBundle, LiveAutomations } from "./types";

// ===== Dados representativos portados de ZEUS Command.dc.html =====
// Servem de fallback (modo demo) e definem o layout exato do painel.

export const MOCK = {
  botStatus: "RUNNING",
  runwayDays: "6.2",
  adaptiveEv: "$4.20",
  gas: { eth: "0.412", usd: 1340 },

  k: {
    today: 1284.5,
    todayTx: 53,
    w7: 8940.2,
    w7delta: "+18.4%",
    m30: 34210.75,
    proj: 41800,
    winRate: "88.7%",
    ok: 47,
    fail: 6,
    w14sum: 15820,
  },

  raw14: [620, 880, -210, 1140, 760, 1320, 410, 980, -160, 1450, 720, 1180, 540, 1284],

  motors: [
    { tag: "M1", name: "Liquidações", pnl: 4120, ops: 18, share: "12%", barPct: "12" },
    { tag: "M2", name: "Arbitragem", pnl: 21480, ops: 312, share: "63%", barPct: "63" },
    { tag: "M3", name: "Backrun", pnl: 8610, ops: 64, share: "25%", barPct: "25" },
  ],

  strategyStats: [
    { strategy: "classic-liq" as const, candidates24h: 34, candidateProfitUsd24h: 412.5, executed24h: 9, netUsd24h: 128.3 },
    { strategy: "pre-liq" as const, candidates24h: 21, candidateProfitUsd24h: 689.2, executed24h: 6, netUsd24h: 241.7 },
    { strategy: "filler" as const, candidates24h: 58, candidateProfitUsd24h: 173.9, executed24h: 12, netUsd24h: 47.1 },
    { strategy: "arb" as const, candidates24h: 47, candidateProfitUsd24h: 318.4, executed24h: 0, netUsd24h: 0 },
  ],

  // Porteiro de tokens (tela "Tokens") — semente que mostra a política POR MOTOR no dia 1:
  // o mesmo LSD (cbETH) entra no M1 (é colateral) mas é rejeitado no M2 (sem edge de arb).
  vettedUniverse: [
    { token: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH", motor: "motor1" as const, verdict: "pass" as const, reason: "entrou: tem saída na Aerodrome, liquidez ok ($1,2M), passou no exame de segurança", exitDex: "Aerodrome volatile", liquidityUsd: 1_200_000, locked: false },
    { token: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH", motor: "motor2" as const, verdict: "reject" as const, reason: "rejeitado: seguro, mas sem edge de arbitragem (não vale a pena pro arb)", exitDex: "Aerodrome volatile", liquidityUsd: 1_200_000, locked: false },
    { token: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", symbol: "DEGEN", motor: "motor2" as const, verdict: "pass" as const, reason: "entrou: tem saída na UniV3 0.3%, liquidez ok ($380k), passou no exame de segurança", exitDex: "UniV3 0.3%", liquidityUsd: 380_000, locked: true, lockPct: 88, locker: "UniCrypt", unlockIso: "2027-03-01T00:00:00Z" },
    { token: "0x00000000000000000000000000000000deadbeef", symbol: "SCAM", motor: "motor2" as const, verdict: "reject" as const, reason: "saiu: é honeypot (não dá pra vender) — bloqueado", liquidityUsd: 0, locked: false },
    { token: "0x00000000000000000000000000000000feed0001", symbol: "NEWCOIN", motor: "motor2" as const, verdict: "reject" as const, reason: "rejeitado: não deu pra confirmar segurança (GoPlus fora) — por precaução não entra", liquidityUsd: 95_000, locked: false, partial: true },
  ],
  tokenLog: [
    { time: "14:32", symbol: "DEGEN", motor: "M2", action: "entrou", reason: "entrou: tem saída na UniV3 0.3%, liquidez ok ($380k), passou no exame de segurança", color: "var(--green)" },
    { time: "14:30", symbol: "SCAM", motor: "M2", action: "saiu", reason: "saiu: é honeypot (não dá pra vender) — bloqueado", color: "var(--red)" },
    { time: "14:18", symbol: "PEPE", motor: "M2", action: "saiu", reason: "saiu: liquidez abaixo do piso ($12k)", color: "var(--red)" },
  ],

  insights: [
    { color: "var(--gold)", text: "Motor 2 (Arbitragem) respondeu por 63% do lucro hoje — concentração acima da média semanal." },
    { color: "var(--red)", text: "Drift do Morpho subiu ~300 bps nas últimas 2h; calibração de EV sugerida." },
    { color: "var(--cyan)", text: "Perdemos 4 corridas seguidas para o builder bob-the-builder.eth — considere subir o bribe em WETH/USDC." },
    { color: "var(--gold)", text: "Gás com 6.2 dias de runway — acima do limiar de alerta (3 dias)." },
  ],

  ticker: [
    { color: "var(--green)", text: "tx.confirmed · Morpho · +$94.20 net", t: 2 },
    { color: "var(--cyan)", text: "backrun.dispatched · AERO/WETH", t: 9 },
    { color: "var(--green)", text: "tx.confirmed · Aave V3 · +$211.80 net", t: 18 },
    { color: "var(--red)", text: "tx.reverted_on_chain · Compound · −3.10 gás", t: 27 },
    { color: "var(--cyan)", text: "whale.swap_detected · 412 WETH", t: 41 },
    { color: "var(--green)", text: "tx.confirmed · Moonwell · +$57.40 net", t: 58 },
  ],

  allRows: [
    { st: "ok", protocol: "Aave V3", pair: "WETH/USDC", net: 211.8, gas: 8.4, drift: -12, hash: "0x8f2a91c4", mode: "main", time: "14:42" },
    { st: "ok", protocol: "Morpho Blue", pair: "cbETH/WETH", net: 94.2, gas: 5.1, drift: 6, hash: "0x1d77e0ab", mode: "main", time: "14:40" },
    { st: "rev", protocol: "Compound V3", pair: "USDC/USDbC", net: -3.1, gas: 3.1, drift: 0, hash: "0x4b09fa21", mode: "main", time: "14:36" },
    { st: "ok", protocol: "Moonwell", pair: "WETH/DAI", net: 57.4, gas: 4.8, drift: -4, hash: "0xa7c3210d", mode: "main", time: "14:31" },
    { st: "ok", protocol: "Aerodrome", pair: "AERO/WETH", net: 128.9, gas: 6.2, drift: 9, hash: "0xe51b88f0", mode: "main", time: "14:27" },
    { st: "pre", protocol: "Seamless", pair: "WETH/USDC", net: 0, gas: 0, drift: 0, hash: null, mode: "main", time: "14:22", reason: "min EV não atingido" },
    { st: "ok", protocol: "Aave V3", pair: "cbETH/USDC", net: 342.1, gas: 9.7, drift: -18, hash: "0x90fd14ce", mode: "main", time: "14:18" },
    { st: "rev", protocol: "Morpho Blue", pair: "WETH/USDC", net: -4.4, gas: 4.4, drift: 0, hash: "0x33ab7e92", mode: "main", time: "14:11" },
    { st: "ok", protocol: "Uniswap V3", pair: "WETH/USDC", net: 76.3, gas: 5.5, drift: 3, hash: "0xc8e201bb", mode: "main", time: "14:04" },
    { st: "pre", protocol: "Compound V3", pair: "USDbC/USDC", net: 0, gas: 0, drift: 0, hash: null, mode: "main", time: "13:58", reason: "gás acima do EV líquido" },
    { st: "ok", protocol: "Moonwell", pair: "WETH/USDC", net: 188.6, gas: 7.1, drift: -8, hash: "0x2f6d99a1", mode: "main", time: "13:51" },
    { st: "ok", protocol: "Aerodrome", pair: "AERO/USDC", net: 41.2, gas: 3.9, drift: 2, hash: "0x7ba4c310", mode: "main", time: "13:44" },
  ] as TxRow[],

  pnlSeries: {
    daily: [0, 620, 1480, 1270, 2410, 3170, 4150, 4560, 5540, 5380, 6830, 7550, 8730, 9270, 10554],
    weekly: [0, 8940, 17200, 24800, 34210],
    monthly: [0, 9800, 19400, 28700, 34210],
  } as Record<string, number[]>,
  expSeries: {
    daily: [0, 700, 1620, 1480, 2680, 3520, 4600, 5060, 6150, 6020, 7600, 8400, 9700, 10350, 11800],
    weekly: [0, 9900, 18800, 27200, 37600],
    monthly: [0, 10600, 21000, 31000, 37600],
  } as Record<string, number[]>,

  motorBreak: [
    { name: "M2 Arbitragem", val: 21480, pct: "63" },
    { name: "M3 Backrun", val: 8610, pct: "25" },
    { name: "M1 Liquidações", val: 4120, pct: "12" },
  ],
  protoBreak: [
    { name: "Aave V3", val: 11240, pct: "90" },
    { name: "Morpho Blue", val: 8930, pct: "72" },
    { name: "Aerodrome", val: 6410, pct: "52" },
    { name: "Moonwell", val: 4870, pct: "39" },
    { name: "Compound V3", val: 2760, pct: "22" },
  ],

  wallet: { gas24h: 214, gas24hEth: "0.066", gas30d: 4180, gas30dPct: "11%" },
  whRaw: [0.62, 0.59, 0.55, 0.51, 0.47, 0.43, 0.4, 0.8, 0.76, 0.71, 0.67, 0.63, 0.58, 0.54, 0.5, 0.46, 0.42, 0.38, 0.78, 0.74, 0.69, 0.65, 0.61, 0.57, 0.52, 0.48, 0.45, 0.43, 0.41, 0.412],
  gasAlerts: [
    { color: "var(--red)", time: "hoje 03:12", text: "Saldo cruzou 3 dias de runway — push enviado", tag: "CRITICAL" },
    { color: "var(--gold)", time: "ontem 21:40", text: "Saldo abaixo de 0.45 ETH", tag: "WARN" },
    { color: "var(--green)", time: "ontem 09:05", text: "Reabastecido +0.40 ETH · gas.recovered", tag: "RECOVERED" },
  ],

  bribe: [
    { pct: "P50", gwei: "0.18", note: "mediana" },
    { pct: "P75", gwei: "0.42", note: "disputado" },
    { pct: "P95", gwei: "1.30", note: "guerra de bribe" },
  ],
  ourBribe: "0.24 gwei",
  driftAlarms: [
    { color: "var(--red)", text: "Morpho Blue · drift sustentado há 2h08m", bps: "+312" },
    { color: "var(--gold)", text: "Aave V3 · drift acima do limiar", bps: "+148" },
    { color: "var(--green)", text: "Aerodrome · dentro da faixa", bps: "+22" },
  ],
  competitors: [
    { name: "bob-the-builder.eth", won: 41, lost: 12, bribe: "0.51 gwei", kind: "builder" },
    { name: "0x9a3f…c102", won: 28, lost: 33, bribe: "0.33 gwei", kind: "searcher" },
    { name: "flashbots-rpc", won: 19, lost: 51, bribe: "0.28 gwei", kind: "relay" },
    { name: "0x4b71…ee90", won: 14, lost: 22, bribe: "0.44 gwei", kind: "searcher" },
    { name: "0xc0ff…ee01", won: 7, lost: 9, bribe: "0.19 gwei", kind: "sybil?" },
  ],
  postmortem: [
    { time: "14:33", text: "Morpho · perdemos para bob-the-builder.eth", pos: "pos #2" },
    { time: "14:20", text: "Aave V3 · perdemos para 0x9a3c…d21f · 0.42 gwei", pos: "—" }, // vencedor sem alias → endereço curto
    { time: "14:05", text: "Compound · perdemos para desconhecido", pos: "—" }, // sem alias nem endereço, só evidência de derrota
    { time: "13:50", text: "Aave V3 · incluído 1 bloco depois", pos: "pos #5" },
    { time: "13:12", text: "WETH/USDC · bribe insuficiente (−0.27 gwei)", pos: "pos #3" },
    { time: "12:47", text: "Aerodrome · reorg desfez inclusão", pos: "reorg" },
  ],
  calib: [
    { time: "hoje 11:34", effect: "min EV $3.60 → $4.80 (faria)", text: "auto-ajuste observando (ligar via ADAPTIVE_THRESHOLDS_ENABLED)" },
    { time: "hoje 11:20", effect: "win-rate +4.2%", text: "min EV elevado de $3.60 → $4.20 após sequência de reverts" },
    { time: "ontem 18:05", effect: "gás −9%", text: "priority fee teto reduzido em pares de baixa disputa" },
    { time: "ontem 07:30", effect: "win-rate +2.1%", text: "cooldown de falhas encurtado de 90s → 60s" },
    { time: "2d atrás", effect: "neutro", text: "whitelist de protocolos: + Seamless" },
  ],
  edgePairs: [
    { pair: "WETH/USDC", edge: "92%", pct: "92", note: "persistente · 14d" },
    { pair: "cbETH/WETH", edge: "78%", pct: "78", note: "persistente · 9d" },
    { pair: "AERO/WETH", edge: "64%", pct: "64", note: "volátil" },
    { pair: "WETH/DAI", edge: "51%", pct: "51", note: "intermitente" },
  ],
  // Espelha o AO VIVO (item 4): builders dominantes (do topByCompetitorVolume) + posição no bloco.
  competition: {
    topBuilders: [
      { alias: "beaverbuild", blocks: 412, competitorTxs: 189, ourTxs: 6 },
      { alias: "Titan Builder", blocks: 298, competitorTxs: 141, ourTxs: 3 },
      { alias: "0x9a3c…d21f", blocks: 87, competitorTxs: 44, ourTxs: 0 },
    ],
    position: { samples: 24, bottom10pctPct: 33, top10pctPct: 12, avgRelative: 0.58 },
  } as Competition | null,
  // Taxa de erro real (KPI Saúde) — espelha o AO VIVO: falhas vs total de ops (6/477 ≈ 1.3%).
  errorMetrics: { failedOps: 6, totalOps: 477 } as { failedOps: number; totalOps: number } | null,
  // Chave-mestra — pacote de combate ACESO (demonstra o "uma chave liga tudo"). Espelha o AO VIVO.
  // 🟢 CANÁRIO — espelha o estado de DRY_RUN (o que aparece no boot): avaliação (Piso de EV + Slippage) VERDE;
  // execução (Bribe + Wallet-pool) CINZA até ligar o TX. Se no DRY_RUN real não bater isto → bug.
  combatBundle: { executionLive: false, adaptive: true, competitiveBribe: false, slippagePerDex: true, walletPoolReady: 22, walletPoolActive: false } as CombatBundle | null,
  combatBundleM1: { executionLive: false, adaptive: true, competitiveBribe: false, slippagePerDex: true, walletPoolReady: 0, walletPoolActive: false } as CombatBundle | null,
  // Automações Leva 3 (observe-first) — mock espelha o AO VIVO: gás calibrado, 1 token sob pressão, 1 pool degradando.
  automations: {
    gasCalibration: { samples: 42, observedP50Usd: 0.04, observedP95Usd: 0.06, configuredUsd: 0.5, driftPct: -0.88, wouldAdjustToUsd: 0.06, applied: false },
    quarantine: [{ token: "cbETH→USDC", symbol: "cbETH", failures: 3, wouldQuarantine: false }],
    poolDepth: { tracked: 58, degraded: [{ poolKey: "WETH/USDC:aero", label: "WETH/USDC", nowUsd: 62000, refUsd: 100000, dropPct: 0.38 }] },
    scanThrottle: { currentMs: 2000, recommendedMs: 3400, reason: "sem edge ativo — desaceleraria (economia RPC)", applied: false },
    revetDynamic: { currentMs: 600000, recommendedMs: 420000, reason: "2 tokens rejeitados — re-vet mais cedo", applied: false },
    flashHealth: { samples: 30, morphoPct: 0.8, balancerPct: 0.13, aavePct: 0.07, freeSharePct: 0.93, degraded: false, summary: "93% em fontes 0% (Morpho/Balancer) — saudável" },
    relayLatency: { samples: 0, currentP95Ms: 0, baselineP95Ms: 0, ratio: 1, degraded: false, summary: "sem amostra de dispatch" },
    // #12 walletRebalance omitido no mock: o pool só existe fora do dryrun (honesto).
  } as LiveAutomations | null,
  // Radar de descoberta (item 4) — espelha o AO VIVO: mostra o motor mais fresco (aqui, Motor 2 / arb).
  discovery: { service: "Motor 2", positions: 58, dispatched: 3, rejected: 12, ago: "8s" } as
    | { service: string; positions: number; dispatched: number; rejected: number; ago: string }
    | null,

  // Espelha EXATAMENTE o AO VIVO: componentes reais dos 2 motores, rotulados M1·/M2· (o live.ts prefixa por motor).
  // Só há 2 estados reais (READY/DOWN via ok:boolean) — sem "DEGRADED". Snapshot de bot saudável.
  components: [
    { name: "M1 · rpc / Base", status: "READY", color: "var(--green)", detail: "bloco há 2s" },
    { name: "M1 · auto-pause", status: "READY", color: "var(--green)", detail: "ativo" },
    { name: "M1 · gás-reserva", status: "READY", color: "var(--green)", detail: "0.0842 ETH" },
    { name: "M1 · reorg", status: "READY", color: "var(--green)", detail: "0 na janela" },
    { name: "M1 · kill-switch", status: "READY", color: "var(--green)", detail: "ok" },
    { name: "M1 · porteiro-tokens", status: "READY", color: "var(--green)", detail: "checado há 48s" },
    { name: "M2 · rpc / Base", status: "READY", color: "var(--green)", detail: "bloco há 2s" },
    { name: "M2 · auto-pause", status: "READY", color: "var(--green)", detail: "ativo" },
    { name: "M2 · gás-reserva", status: "READY", color: "var(--green)", detail: "0.0842 ETH" },
    { name: "M2 · reorg", status: "READY", color: "var(--green)", detail: "0 na janela" },
    { name: "M2 · perda 24h", status: "READY", color: "var(--green)", detail: "ok" },
    { name: "M2 · porteiro-tokens", status: "READY", color: "var(--green)", detail: "checado há 51s" },
  ],
  cooldowns: [
    { scope: "Motor 1 · Liquidações", state: "ATIVO", color: "var(--gold)", reason: "3 falhas consecutivas · expira em 00:42" },
    { scope: "Motor 2 · Arbitragem", state: "OK", color: "var(--green)", reason: "sem falhas em sequência" },
    { scope: "Auto-pause global", state: "INATIVO", color: "var(--green)", reason: "última pausa há 6h · oracle stale" },
  ],
  latP50: [128, 135, 142, 138, 150, 162, 144, 139, 152, 148, 160, 143, 137, 145, 158, 166, 149, 141, 136, 144, 151, 147, 142, 142],
  latP95: [360, 372, 410, 395, 430, 470, 420, 388, 440, 415, 455, 402, 378, 410, 448, 468, 422, 395, 372, 408, 430, 418, 405, 410],
  ks: { loss: -420, limit: 2000, pct: "21", last: "há 6 dias · oracle stale" },
  eventLog: [
    { time: "14:42", color: "var(--green)", type: "zeus.heartbeat", text: "Heartbeat ok · gás 0.412 ETH · uptime 3d 07h" },
    { time: "14:31", color: "var(--gold)", type: "reorg", text: "Reorg profundidade 1 · tx reanexada no bloco seguinte" },
    { time: "13:42", color: "var(--gold)", type: "cooldown_activated", text: "Cooldown M1 ativado · 3 falhas consecutivas · 60s" },
    { time: "12:47", color: "var(--red)", type: "reorg", text: "Reorg profundidade 2 · inclusão desfeita em AERO/WETH" },
    { time: "11:20", color: "var(--cyan)", type: "auto-calibração", text: "min EV ajustado $3.60 → $4.20 após sequência de reverts" },
    { time: "09:05", color: "var(--green)", type: "liquidator.boot", text: "Serviço liquidator reiniciado · readyz ok em 1.8s" },
    { time: "03:12", color: "var(--red)", type: "gas.alert", text: "Gás cruzou 3 dias de runway · push crítico enviado" },
  ],

  repByPeriod: {
    daily: { net: 1284.5, win: "88.7%", ops: "53", gas: 214, drift: "−118bps", bestMotor: "M2 Arbitragem", range: "22 jun 2026", label: "Diário" },
    weekly: { net: 8940.2, win: "86.1%", ops: "371", gas: 1480, drift: "−132bps", bestMotor: "M2 Arbitragem", range: "16–22 jun 2026", label: "Semanal" },
    monthly: { net: 34210.75, win: "85.4%", ops: "1.642", gas: 4180, drift: "−141bps", bestMotor: "M2 Arbitragem", range: "jun 2026", label: "Mensal" },
  } as Record<string, { net: number; win: string; ops: string; gas: number; drift: string; bestMotor: string; range: string; label: string }>,

  notifMeta: [
    ["kill", "Kill switch acionado", "sempre"],
    ["gas", "Gás crítico (<3d runway)", "<3 dias"],
    ["cooldown", "Cooldown ativado", "3 falhas"],
    ["drift", "Drift sustentado", ">200 bps / 2h"],
    ["bigtx", "Tx confirmada acima de valor", ">$500"],
  ] as [string, string, string][],
  notifDefault: { kill: true, gas: true, cooldown: true, drift: true, bigtx: false } as Record<string, boolean>,
  chanMeta: [
    ["push", "Web Push (PWA)", "instalável"],
    ["email", "Email (Resend)", "digest diário"],
  ] as [string, string, string][],
  chanDefault: { push: true, email: true } as Record<string, boolean>,
};

/**
 * Fallback do MODO AO VIVO (demo OFF): mesma forma do MOCK, mas com valores VAZIOS/zerados.
 * Assim, todo card sem dado real fica visivelmente vazio ("—" / 0 / lista vazia) em vez de mostrar
 * um número falso. As `*Meta` (config de notificação/canais e labels de período) ficam do MOCK —
 * são estrutura de UI, não métrica. Arrays de série/lista ficam `[]` (gráficos/listas renderizam vazio).
 */
export const EMPTY: typeof MOCK = {
  botStatus: "—",
  runwayDays: "—",
  adaptiveEv: "—",
  gas: { eth: "—", usd: 0 },
  k: { today: 0, todayTx: 0, w7: 0, w7delta: "—", m30: 0, proj: 0, winRate: "—", ok: 0, fail: 0, w14sum: 0 },
  raw14: [],
  motors: [],
  strategyStats: [],
  vettedUniverse: [],
  tokenLog: [],
  insights: [],
  ticker: [],
  allRows: [],
  pnlSeries: { daily: [], weekly: [], monthly: [] },
  expSeries: { daily: [], weekly: [], monthly: [] },
  motorBreak: [],
  protoBreak: [],
  wallet: { gas24h: 0, gas24hEth: "—", gas30d: 0, gas30dPct: "—" },
  whRaw: [],
  gasAlerts: [],
  bribe: [],
  ourBribe: "—",
  driftAlarms: [],
  competitors: [],
  postmortem: [],
  calib: [],
  edgePairs: [],
  competition: null,
  errorMetrics: null,
  combatBundle: null,
  combatBundleM1: null,
  automations: null,
  discovery: null,
  components: [],
  cooldowns: [],
  latP50: [],
  latP95: [],
  ks: { loss: 0, limit: 0, pct: "0", last: "—" },
  eventLog: [],
  repByPeriod: {
    daily: { net: 0, win: "—", ops: "0", gas: 0, drift: "—", bestMotor: "—", range: "—", label: "Diário" },
    weekly: { net: 0, win: "—", ops: "0", gas: 0, drift: "—", bestMotor: "—", range: "—", label: "Semanal" },
    monthly: { net: 0, win: "—", ops: "0", gas: 0, drift: "—", bestMotor: "—", range: "—", label: "Mensal" },
  },
  notifMeta: MOCK.notifMeta,
  notifDefault: MOCK.notifDefault,
  chanMeta: MOCK.chanMeta,
  chanDefault: MOCK.chanDefault,
};
