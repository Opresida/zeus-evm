"use client";
import { css } from "@/lib/css";
import type { ScreenProps } from "./shared";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:18px 20px;";
const COMPGRID = "display:grid; grid-template-columns:1.4fr 90px 90px 1fr 90px; gap:0;";

export function Intelligence({ vm }: ScreenProps) {
  const { bribe, ourBribe, bribeNote, bribeAutoEnabled, gasEscalation, edgeShift, driftAlarms, intelLive, competitors, postmortem, calib, edgePairs, competition, automations } = vm;
  const fmt = (v: number | undefined, suf = "") => (v != null && Number.isFinite(v) ? `${v}${suf}` : "—");
  return (
    <section>
      <div style={css("display:flex; align-items:center; gap:10px;")}>
        <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Inteligência</h1>
        <span style={css("font:600 9.5px/1 'IBM Plex Mono'; letter-spacing:.1em; color:var(--gold); border:1px solid var(--goldsoft); background:var(--goldsoft); padding:5px 9px; border-radius:6px;")}>
          EDGE
        </span>
      </div>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 20px;")}>
        Competidores, market-bribe, drift sustentado, post-mortem e auto-calibração
      </p>

      {/* Faixa AO VIVO (item 3): agregados reais do heartbeat do bot. Os painéis abaixo seguem mock
          enquanto não há ponte do DuckDB (perfis detalhados/post-mortem). */}
      {intelLive && (
        <div style={css(card + "margin-bottom:14px; border-color:var(--goldsoft);")}>
          <div style={css("display:flex; align-items:center; gap:8px; margin-bottom:14px;")}>
            <span style={css("width:7px;height:7px;border-radius:50%;background:var(--green);")} />
            <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Inteligência ao vivo (do bot)</span>
          </div>
          <div className="z-grid-4" style={css("display:grid; grid-template-columns:repeat(4,1fr); gap:14px;")}>
            <div><div style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--text);")}>{fmt(intelLive.marketBribeP50Gwei)}<span style={css("font-size:11px;color:var(--muted);")}> gwei</span></div><span style={css("font:500 10px/1.2 'IBM Plex Mono'; color:var(--muted);")}>market-bribe p50</span></div>
            <div><div style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--gold);")}>{fmt(intelLive.marketBribeP95Gwei)}<span style={css("font-size:11px;color:var(--muted);")}> gwei</span></div><span style={css("font:500 10px/1.2 'IBM Plex Mono'; color:var(--muted);")}>market-bribe p95</span></div>
            <div><div style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--text);")}>{fmt(intelLive.competitorsActive)}</div><span style={css("font:500 10px/1.2 'IBM Plex Mono'; color:var(--muted);")}>competidores ativos</span></div>
            <div><div style={{ ...css("font:600 22px/1 'IBM Plex Mono';"), color: Math.abs(intelLive.driftBps ?? 0) >= 100 ? "var(--red)" : "var(--text)" }}>{fmt(intelLive.driftBps, "bps")}</div><span style={css("font:500 10px/1.2 'IBM Plex Mono'; color:var(--muted);")}>drift médio</span></div>
          </div>
        </div>
      )}

      <div className="z-grid-2" style={css("display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;")}>
        <div style={css(card)}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>
            Market-bribe · priority fee (gwei)
          </span>
          <p style={css("font:400 12px/1.4 'IBM Plex Sans'; color:var(--muted); margin:8px 0 18px;")}>Quanto o mercado paga pra ganhar a corrida</p>
          <div style={css("display:flex; gap:14px;")}>
            {bribe.map((br, i) => (
              <div key={i} style={css("flex:1; background:var(--bg2); border:1px solid var(--border); border-radius:9px; padding:14px;")}>
                <span style={css("font:600 11px/1 'IBM Plex Mono'; color:var(--gold);")}>{br.pct}</span>
                <div style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--text); margin-top:10px;")}>{br.gwei}</div>
                <div style={css("font:500 10.5px/1 'IBM Plex Mono'; color:var(--muted); margin-top:6px;")}>{br.note}</div>
              </div>
            ))}
          </div>
          <div style={css(`margin-top:16px; padding:12px 14px; background:var(--goldsoft); border-radius:9px; font:500 12px/1.4 'IBM Plex Sans'; color:${bribeNote.color};`)}>
            Nosso bribe atual: {ourBribe} — {bribeNote.text}
          </div>
          {bribeAutoEnabled && (
            <div style={css(`margin-top:10px; padding:12px 14px; background:var(--greensoft, rgba(34,197,94,.12)); border:1px solid ${bribeAutoEnabled.color}; border-radius:9px; font:600 12px/1.4 'IBM Plex Sans'; color:${bribeAutoEnabled.color};`)}>
              {bribeAutoEnabled.text}
            </div>
          )}
          {gasEscalation && (
            <div style={css(`margin-top:10px; padding:12px 14px; background:var(--goldsoft, rgba(208,162,21,.12)); border:1px solid ${gasEscalation.color}; border-radius:9px; font:600 12px/1.4 'IBM Plex Sans'; color:${gasEscalation.color};`)}>
              {gasEscalation.text}
            </div>
          )}
          {edgeShift && (
            <div style={css(`margin-top:10px; padding:12px 14px; background:var(--redsoft, rgba(239,68,68,.1)); border:1px solid ${edgeShift.color}; border-radius:9px; font:600 12px/1.4 'IBM Plex Sans'; color:${edgeShift.color};`)}>
              {edgeShift.text}
            </div>
          )}
        </div>
        <div style={css(card)}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--red);")}>Alarme · drift sustentado</span>
          <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
            {driftAlarms.map((d, i) => (
              <div key={i} style={css("display:flex; align-items:center; gap:12px; padding:11px 0; border-bottom:1px solid var(--border);")}>
                <span style={{ ...css("width:7px; height:7px; border-radius:50%; flex:none;"), background: d.color }} />
                <span style={css("font:500 12.5px/1.3 'IBM Plex Sans'; color:var(--text2); flex:1;")}>{d.text}</span>
                <span style={{ ...css("font:600 12px/1 'IBM Plex Mono';"), color: d.color }}>{d.bps}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={css(card + "margin-bottom:14px;")}>
        <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Competidores ativos</span>
        <div className="z-txtable">
          <div className="z-txgrid">
            <div className="z-card-hide" style={css(COMPGRID + "padding:12px 0 10px; border-bottom:1px solid var(--border); margin-top:8px;")}>
              {["Builder / searcher", "Ganhou", "Perdeu", "Bribe médio", "Tipo"].map((h, i) => (
                <span key={i} style={css("font:600 9.5px/1 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>
                  {h}
                </span>
              ))}
            </div>
            {competitors.map((c, i) => (
              <div key={i} className="z-card-row" style={css(COMPGRID + "padding:12px 0; border-bottom:1px solid var(--border); align-items:center;")}>
                <span data-label="Builder" style={css("font:500 12.5px/1 'IBM Plex Mono'; color:var(--text);")}>{c.name}</span>
                <span data-label="Ganhou" style={css("font:600 12px/1 'IBM Plex Mono'; color:var(--red);")}>{c.won}</span>
                <span data-label="Perdeu" style={css("font:600 12px/1 'IBM Plex Mono'; color:var(--green);")}>{c.lost}</span>
                <span data-label="Bribe" style={css("font:500 12px/1 'IBM Plex Mono'; color:var(--text2);")}>{c.bribe}</span>
                <span data-label="Tipo" style={css("font:500 10.5px/1 'IBM Plex Mono'; color:var(--muted); text-transform:uppercase;")}>{c.kind}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="z-grid-2" style={css("display:grid; grid-template-columns:1fr 1fr; gap:14px;")}>
        <div style={css(card)}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Post-mortem · corridas perdidas</span>
          <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
            {postmortem.map((pm, i) => (
              <div key={i} style={css("display:flex; align-items:center; gap:11px; padding:10px 0; border-bottom:1px solid var(--border);")}>
                <span style={css("font:500 10px/1 'IBM Plex Mono'; color:var(--muted); width:48px; flex:none;")}>{pm.time}</span>
                <span style={css("font:500 12px/1.3 'IBM Plex Sans'; color:var(--text2); flex:1;")}>{pm.text}</span>
                <span style={css("font:600 10.5px/1 'IBM Plex Mono'; color:var(--gold);")}>{pm.pos}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={css(card)}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--cyan);")}>Auto-calibração · &quot;o que mudou&quot;</span>
          <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
            {calib.map((cb, i) => (
              <div key={i} style={css("padding:11px 0; border-bottom:1px solid var(--border);")}>
                <div style={css("display:flex; justify-content:space-between; align-items:center;")}>
                  <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>{cb.time}</span>
                  <span style={css("font:600 11px/1 'IBM Plex Mono'; color:var(--cyan);")}>{cb.effect}</span>
                </div>
                <div style={css("font:500 12.5px/1.4 'IBM Plex Sans'; color:var(--text2); margin-top:6px;")}>{cb.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={css(card + "margin-top:14px;")}>
        <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>
          Ranking de pares com edge (persistência)
        </span>
        <div style={css("display:flex; gap:12px; margin-top:16px; flex-wrap:wrap;")}>
          {edgePairs.map((ep, i) => (
            <div key={i} style={css("flex:1; min-width:150px; background:var(--bg2); border:1px solid var(--border); border-radius:9px; padding:14px;")}>
              <div style={css("display:flex; justify-content:space-between; align-items:center;")}>
                <span style={css("font:600 13px/1 'IBM Plex Mono'; color:var(--text);")}>{ep.pair}</span>
                <span style={css("font:600 11px/1 'IBM Plex Mono'; color:var(--green);")}>{ep.edge}</span>
              </div>
              <div style={css("height:5px; border-radius:3px; background:var(--border); margin-top:12px; overflow:hidden;")}>
                <div style={{ ...css("height:100%; background:var(--green);"), width: `${ep.pct}%` }} />
              </div>
              <div style={css("font:500 10.5px/1 'IBM Plex Mono'; color:var(--muted); margin-top:9px;")}>{ep.note}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Item 4 — Diagnóstico de concorrência: quem controla o blockspace + nossa posição no bloco */}
      {competition && (
        <div style={css(card + "margin-top:14px;")}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>
            Diagnóstico de concorrência · quem controla o blockspace
          </span>
          <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
            {competition.builders.length ? (
              competition.builders.map((b, i) => (
                <div key={i} className="z-card-row" style={css("display:flex; align-items:center; gap:12px; padding:11px 0; border-bottom:1px solid var(--border);")}>
                  <span data-label="Builder" style={css("font:600 12px/1.3 'IBM Plex Mono'; color:var(--text); flex:1;")}>{b.alias}</span>
                  <span data-label="Blocos" style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>{b.blocks} blocos</span>
                  <span data-label="Tx concorrentes" style={css("font:600 11px/1 'IBM Plex Mono'; color:var(--gold);")}>{b.competitorTxs} tx rivais</span>
                  <span data-label="Nossas tx" style={css("font:600 11px/1 'IBM Plex Mono'; color:var(--cyan);")}>{b.ourTxs} nossas</span>
                </div>
              ))
            ) : (
              <div style={css("font:500 12px/1.4 'IBM Plex Mono'; color:var(--muted);")}>nenhum builder observado ainda</div>
            )}
          </div>
          <div style={{ ...css("margin-top:14px; padding:12px 14px; border-radius:9px; font:500 12px/1.4 'IBM Plex Sans';"), background: "var(--bg2)", color: competition.hasPosition ? "var(--text2)" : "var(--muted)" }}>
            📍 {competition.positionText}
          </div>
        </div>
      )}

      {/* Automações "vivas" Leva 3 (observe-first) — #9 calibração de gás · #7 quarentena · #8 pool depth. */}
      {automations && (
        <div style={css(card + "margin-top:16px;")}>
          <span style={css("font:700 11px/1 'IBM Plex Mono'; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted);")}>
            Automações vivas · observando (o que fariam)
          </span>
          <div style={css("display:grid; gap:10px; margin-top:12px;")}>
            {/* #9 calibração de gás */}
            {automations.gasCalibration && automations.gasCalibration.samples > 0 && (
              <div style={css("padding:11px 13px; background:var(--bg2); border-radius:9px; font:500 12px/1.5 'IBM Plex Sans';")}>
                <b>⛽ Calibração de gás</b> — config diz <b>${automations.gasCalibration.configuredUsd.toFixed(2)}</b>,
                real (p95) <b>${automations.gasCalibration.observedP95Usd.toFixed(3)}</b>
                {" "}({(automations.gasCalibration.driftPct * 100).toFixed(0)}%).{" "}
                {automations.gasCalibration.applied
                  ? <span style={css("color:var(--green);")}>injetando o calibrado ✓</span>
                  : <span style={css("color:var(--muted);")}>ajustaria p/ ${automations.gasCalibration.wouldAdjustToUsd.toFixed(3)} (ligar GAS_CALIBRATION_ENABLED)</span>}
              </div>
            )}
            {/* #7 quarentena de token */}
            {automations.quarantine && automations.quarantine.length > 0 && (
              <div style={css("padding:11px 13px; background:var(--bg2); border-radius:9px; font:500 12px/1.5 'IBM Plex Sans';")}>
                <b>🚫 Quarentena de token</b> — {automations.quarantine.map((q, i) => (
                  <span key={i} style={{ color: q.wouldQuarantine ? "var(--red, #e5484d)" : "var(--text2)" }}>
                    {i > 0 ? " · " : " "}{q.symbol ?? q.token} ({q.failures} falhas{q.wouldQuarantine ? " → quarentenaria" : ""})
                  </span>
                ))}
              </div>
            )}
            {/* #8 pool depth */}
            {automations.poolDepth && (
              <div style={css("padding:11px 13px; background:var(--bg2); border-radius:9px; font:500 12px/1.5 'IBM Plex Sans';")}>
                <b>🌊 Profundidade de pool</b> — {automations.poolDepth.tracked} pools vigiados.{" "}
                {automations.poolDepth.degraded.length === 0
                  ? <span style={css("color:var(--muted);")}>nenhum degradando</span>
                  : automations.poolDepth.degraded.map((d, i) => (
                      <span key={i} style={css("color:var(--red, #e5484d);")}>
                        {i > 0 ? " · " : " "}{d.label ?? d.poolKey} caiu {(d.dropPct * 100).toFixed(0)}%
                      </span>
                    ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
