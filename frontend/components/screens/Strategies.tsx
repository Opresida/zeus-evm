"use client";
import { css } from "@/lib/css";
import type { ScreenProps } from "./shared";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:18px 20px;";
const kicker = "font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);";

/**
 * Tela "Estratégias" — compara as 3 estratégias de lucro: liquidação clássica × pré-liquidação Morpho ×
 * filler UniswapX. Mostra CANDIDATOS (o que cada uma lucraria — vale em DRY_RUN) e RESULTADOS (o que
 * executou de verdade). Responde direto: "quem dá mais lucro quando rodar".
 * Dados via heartbeat → service_status.strategy_stats. Em modo DEMO usa o mock.
 */
export function Strategies({ vm }: ScreenProps) {
  const { strategyCards, strategyWinner } = vm;
  const anyExecuted = strategyCards.some((s) => s.executed > 0);

  return (
    <section>
      <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Estratégias</h1>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 20px;")}>
        Candidatos × resultados (24h) — qual estratégia dá mais lucro: clássica, pré-liquidação, filler ou arb cross-DEX.
        {!anyExecuted && " Em DRY_RUN, os candidatos mostram o POTENCIAL (nada foi enviado ainda)."}
      </p>

      <div className="z-grid-3" style={css("display:grid; grid-template-columns:repeat(3,1fr); gap:14px;")}>
        {strategyCards.map((s) => {
          const win = s.strategy === strategyWinner;
          return (
            <div
              key={s.strategy}
              style={css(card + `${win ? "border-color:var(--green, #4cc08a);" : ""}`)}
            >
              <div style={css("display:flex; align-items:center; gap:9px;")}>
                <span style={css("font:600 18px/1;")}>{s.icon}</span>
                <span style={css("font:600 14px/1.2 'IBM Plex Sans'; color:var(--text); flex:1;")}>{s.name}</span>
                {win && (
                  <span style={css("font:600 9px/1 'IBM Plex Mono'; letter-spacing:.06em; text-transform:uppercase; color:var(--green, #4cc08a); border:1px solid var(--green, #4cc08a); border-radius:6px; padding:3px 6px;")}>
                    {anyExecuted ? "+ lucro" : "+ potencial"}
                  </span>
                )}
              </div>

              <div style={css("display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:16px;")}>
                <div>
                  <span style={css(kicker)}>Candidatos</span>
                  <div style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--cyan, #56b6c2); margin-top:7px;")}>{s.candidates}</div>
                  <div style={css("font:500 10.5px/1 'IBM Plex Mono'; color:var(--muted); margin-top:6px;")}>
                    potencial {s.candidateUsd}
                  </div>
                </div>
                <div>
                  <span style={css(kicker)}>Executados</span>
                  <div style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--gold); margin-top:7px;")}>{s.executed}</div>
                  <div style={css("font:500 10.5px/1 'IBM Plex Mono'; color:var(--muted); margin-top:6px;")}>
                    {s.candidates > 0 ? `${Math.round((s.executed / s.candidates) * 100)}% dos candidatos` : "—"}
                  </div>
                </div>
              </div>

              <div style={css("height:1px; background:var(--border); margin:16px 0;")} />

              <div style={css("display:flex; align-items:baseline; justify-content:space-between;")}>
                <div>
                  <span style={css(kicker)}>Net realizado</span>
                  <div style={css("font:600 20px/1 'IBM Plex Mono'; color:var(--green, #4cc08a); margin-top:7px;")}>{s.netUsd}</div>
                </div>
                <span style={css("font:500 10.5px/1 'IBM Plex Mono'; color:var(--muted);")}>
                  avg {anyExecuted ? s.avgExec : s.avgCand}/op
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tabela comparativa — ranking pelo que importa (realizado se houve execução, senão potencial) */}
      <div style={css(card + "margin-top:14px;")}>
        <span style={css(kicker)}>Comparativo (ordenado por {anyExecuted ? "lucro realizado" : "potencial dos candidatos"})</span>
        <div style={css("display:grid; grid-template-columns:1.4fr 90px 110px 90px 110px; gap:0; margin-top:14px;")}>
          {["Estratégia", "Candidatos", "Potencial $", "Exec.", "Net $"].map((h, i) => (
            <span key={i} style={css("font:600 9.5px/1 'IBM Plex Mono'; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding-bottom:10px; border-bottom:1px solid var(--border);")}>{h}</span>
          ))}
          {[...strategyCards]
            .sort((a, b) => (anyExecuted ? b.netUsdRaw - a.netUsdRaw : b.candidateUsdRaw - a.candidateUsdRaw))
            .map((s) => (
              <div key={s.strategy} style={css("display:contents;")}>
                <span style={css("font:500 12.5px/1.3 'IBM Plex Sans'; color:var(--text2, var(--text)); padding:12px 0; border-bottom:1px solid var(--border);")}>
                  {s.icon} {s.name}
                </span>
                <span style={css("font:600 12px/1 'IBM Plex Mono'; color:var(--cyan, #56b6c2); padding:12px 0; border-bottom:1px solid var(--border);")}>{s.candidates}</span>
                <span style={css("font:600 12px/1 'IBM Plex Mono'; color:var(--muted); padding:12px 0; border-bottom:1px solid var(--border);")}>{s.candidateUsd}</span>
                <span style={css("font:600 12px/1 'IBM Plex Mono'; color:var(--gold); padding:12px 0; border-bottom:1px solid var(--border);")}>{s.executed}</span>
                <span style={css(`font:600 12px/1 'IBM Plex Mono'; color:${s.netUsdRaw >= 0 ? "var(--green, #4cc08a)" : "var(--red)"}; padding:12px 0; border-bottom:1px solid var(--border);`)}>{s.netUsd}</span>
              </div>
            ))}
        </div>
        <p style={css("font:400 11px/1.5 'IBM Plex Sans'; color:var(--muted); margin:14px 0 0;")}>
          Candidatos = oportunidades lucrativas vistas (o bot calcula e simula). Executados = enviadas de
          verdade (0 em DRY_RUN). Net = lucro líquido realizado. O destaque verde é quem lidera.
        </p>
      </div>
    </section>
  );
}
