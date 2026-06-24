// ===== Fase 3 — Insights & anomalias GERADOS =====
// Regras simples e determinísticas sobre os dados REAIS das Fases 1/2 (sem chamada de IA, sem
// estado): concentração de motor, drift sustentado, kill switch, runway de gás, competidor dominante,
// win-rate baixo. O painel consome no card "Insights & anomalias" (Home) quando em modo LIVE.
// Pura/testável → vive fora do viewModel pra ter cobertura própria.

export interface InsightSignals {
  /** Lucro por motor (raw USD) — concentração. */
  motorBreak?: { name: string; val: number; pct: string }[];
  /** Drift médio realizado-vs-esperado (bps). */
  driftBps?: number;
  /** Estado do kill switch (perda 24h vs limite). */
  killSwitch?: { loss24hUsd: number; limitUsd: number; triggered: boolean };
  /** Runway de gás em dias (NaN/undefined = ignora a regra). */
  runwayDays?: number;
  /** Competidores observados (alias/categoria/ameaça). */
  competitors?: { alias: string; category: string; threat: number }[];
  /** Win-rate em % (0..100). */
  winRatePct?: number;
}

export interface Insight {
  color: string;
  text: string;
}

/**
 * Veredito do NOSSO bribe vs o mercado (p50/p75/p95). Determinístico. Substitui a frase fixa do card
 * de market-bribe — "conforme a realidade". Sem dado suficiente → neutro (não inventa).
 */
export function bribeVerdict(
  our?: number,
  p50?: number,
  p75?: number,
  p95?: number,
): { text: string; color: string } {
  if (our == null || !Number.isFinite(our) || p75 == null || !Number.isFinite(p75)) {
    return { text: "sem dado de mercado suficiente ainda.", color: "var(--muted)" };
  }
  if (p95 != null && our >= p95) {
    return { text: "no topo do mercado (≥ p95) — ganhando a maioria das corridas.", color: "var(--green)" };
  }
  if (our >= p75) {
    return { text: "competitivo (entre p75 e p95).", color: "var(--green)" };
  }
  if (p50 != null && our >= p50) {
    return { text: "mediano (entre p50 e p75) — pode subir em pares disputados.", color: "var(--gold)" };
  }
  return { text: "abaixo do p50 — provavelmente perdendo corridas; considere subir.", color: "var(--red)" };
}

/**
 * Gera os insights a partir dos sinais reais. Determinístico (mesma entrada → mesma saída) e sem
 * efeitos colaterais. Lista vazia = nenhum sinal cruzou o limiar (estado saudável / sem dados ainda).
 */
export function generateInsights(s: InsightSignals): Insight[] {
  const out: Insight[] = [];

  // 1) Concentração de motor — um motor responde por >=55% do lucro do período.
  const mb = (s.motorBreak ?? []).filter((m) => m.val > 0);
  const totalNet = mb.reduce((sum, m) => sum + m.val, 0);
  if (totalNet > 0) {
    const top = [...mb].sort((a, b) => b.val - a.val)[0];
    const share = Math.round((top.val / totalNet) * 100);
    if (share >= 55) {
      out.push({ color: "var(--gold)", text: `${top.name} respondeu por ${share}% do lucro no período — concentração acima do saudável.` });
    }
  }

  // 2) Drift sustentado — |drift médio| >= 150 bps sugere calibração de EV.
  if (s.driftBps != null && Number.isFinite(s.driftBps) && Math.abs(s.driftBps) >= 150) {
    out.push({ color: "var(--red)", text: `Drift médio em ${Math.round(s.driftBps)} bps — execução fora do esperado; calibração de EV sugerida.` });
  }

  // 3) Kill switch — disparado (crítico) ou perda 24h >= 50% do limite (atenção).
  if (s.killSwitch && s.killSwitch.limitUsd > 0) {
    if (s.killSwitch.triggered) {
      out.push({ color: "var(--red)", text: `Kill switch DISPARADO — perda 24h atingiu o limite de $${s.killSwitch.limitUsd}.` });
    } else {
      const pct = (Math.abs(s.killSwitch.loss24hUsd) / s.killSwitch.limitUsd) * 100;
      if (pct >= 50) {
        out.push({ color: "var(--gold)", text: `Perda 24h em ${pct.toFixed(0)}% do limite do kill switch — atenção.` });
      }
    }
  }

  // 4) Runway de gás — abaixo de 3 dias é alerta.
  if (s.runwayDays != null && Number.isFinite(s.runwayDays) && s.runwayDays < 3) {
    out.push({ color: "var(--red)", text: `Gás com ${s.runwayDays.toFixed(1)} dias de runway — abaixo do limiar de alerta (3 dias).` });
  }

  // 5) Competidor dominante — ameaça >= 0.7.
  const comp = (s.competitors ?? []).filter((c) => c.threat >= 0.7).sort((a, b) => b.threat - a.threat)[0];
  if (comp) {
    out.push({ color: "var(--cyan)", text: `Competidor ${comp.alias} (${comp.category}) com ameaça alta — avalie subir o bribe nos pares disputados.` });
  }

  // 6) Win-rate baixo — abaixo de 50%.
  if (s.winRatePct != null && Number.isFinite(s.winRatePct) && s.winRatePct > 0 && s.winRatePct < 50) {
    out.push({ color: "var(--gold)", text: `Win-rate em ${s.winRatePct.toFixed(0)}% — abaixo de 50%; revisar gates de EV.` });
  }

  return out;
}
