"use client";
import { css } from "@/lib/css";
import type { ScreenProps } from "./shared";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px;";
const kmono = "font:600 10px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);";

export function Wallet({ vm }: ScreenProps) {
  const { gas, runwayDays, wallet, walletHist, gasAlerts } = vm;
  return (
    <section>
      <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Carteira & Gás</h1>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 20px;")}>
        Saldo, runway estimado e custo de gás acumulado
      </p>

      <div className="z-grid-4" style={css("display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:14px;")}>
        <div style={css(card + "padding:18px 20px;")}>
          <span style={css(kmono)}>Saldo atual</span>
          <div style={css("font:600 26px/1 'IBM Plex Mono'; color:var(--text); margin-top:11px;")}>
            {gas.eth}
            <span style={css("font-size:14px; color:var(--muted);")}> ETH</span>
          </div>
          <div style={css("font:500 12px/1 'IBM Plex Mono'; color:var(--muted); margin-top:8px;")}>{gas.usd}</div>
        </div>
        <div style={css(card + "padding:18px 20px;")}>
          <span style={css(kmono)}>Runway estimado</span>
          <div style={css("font:600 26px/1 'IBM Plex Mono'; color:var(--gold); margin-top:11px;")}>
            {runwayDays}
            <span style={css("font-size:14px; color:var(--muted);")}> dias</span>
          </div>
          <div style={css("font:500 12px/1 'IBM Plex Mono'; color:var(--muted); margin-top:8px;")}>ao ritmo atual</div>
        </div>
        <div style={css(card + "padding:18px 20px;")}>
          <span style={css(kmono)}>Gás · 24h</span>
          <div style={css("font:600 26px/1 'IBM Plex Mono'; color:var(--red); margin-top:11px;")}>{wallet.gas24h}</div>
          <div style={css("font:500 12px/1 'IBM Plex Mono'; color:var(--muted); margin-top:8px;")}>{wallet.gas24hEth} ETH</div>
        </div>
        <div style={css(card + "padding:18px 20px;")}>
          <span style={css(kmono)}>Gás acumulado · 30d</span>
          <div style={css("font:600 26px/1 'IBM Plex Mono'; color:var(--text2); margin-top:11px;")}>{wallet.gas30d}</div>
          <div style={css("font:500 12px/1 'IBM Plex Mono'; color:var(--muted); margin-top:8px;")}>{wallet.gas30dPct} do lucro bruto</div>
        </div>
      </div>

      <div style={css(card + "padding:20px 22px; margin-bottom:14px;")}>
        <div style={css("display:flex; justify-content:space-between; align-items:center;")}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>
            Histórico de saldo · 30 dias (ETH)
          </span>
          <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>2 reabastecimentos no período</span>
        </div>
        <div style={css("display:flex; align-items:flex-end; gap:4px; height:130px; margin-top:18px;")}>
          {walletHist.map((w, i) => (
            <div key={i} style={css("flex:1; display:flex; flex-direction:column; justify-content:flex-end; height:100%;")}>
              <div style={{ ...css("border-radius:2px 2px 0 0; min-height:2px;"), height: `${w.pct}%`, background: w.color }} />
            </div>
          ))}
        </div>
      </div>

      <div style={css(card + "padding:18px 20px;")}>
        <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Alertas de gás baixo</span>
        <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
          {gasAlerts.map((ga, i) => (
            <div key={i} style={css("display:flex; align-items:center; gap:12px; padding:11px 0; border-bottom:1px solid var(--border);")}>
              <span style={{ ...css("width:7px; height:7px; border-radius:50%; flex:none;"), background: ga.color }} />
              <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted); width:90px; flex:none;")}>{ga.time}</span>
              <span style={css("font:500 12.5px/1.3 'IBM Plex Sans'; color:var(--text2); flex:1;")}>{ga.text}</span>
              <span style={{ ...css("font:600 11.5px/1 'IBM Plex Mono';"), color: ga.color }}>{ga.tag}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
