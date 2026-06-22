"use client";
import { css } from "@/lib/css";
import type { ScreenProps } from "./shared";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:18px 20px;";
const kicker = "font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.08em; text-transform:uppercase; color:var(--muted);";
const big = "font:600 30px/1 'IBM Plex Mono'; margin-top:12px; letter-spacing:-.01em;";

export function Home({ vm }: ScreenProps) {
  const { k, gas, runwayDays, adaptiveEv, motors, insights, ticker, pnl14 } = vm;
  return (
    <section>
      <div style={css("display:flex; align-items:flex-end; justify-content:space-between; margin-bottom:22px;")}>
        <div>
          <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0; letter-spacing:-.01em;")}>Visão geral</h1>
          <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 0;")}>
            Estado consolidado dos três motores · atualizado em tempo real
          </p>
        </div>
        <span style={css("display:flex; align-items:center; gap:7px; font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>
          <span style={css("width:6px; height:6px; border-radius:50%; background:var(--green); animation:zpulse 2.2s infinite;")} />
          LIVE · {vm.clock}
        </span>
      </div>

      {/* KPI row */}
      <div className="z-grid-4" style={css("display:grid; grid-template-columns:repeat(4,1fr); gap:14px;")}>
        <div style={css(card)}>
          <span style={css(kicker)}>Net PnL · Hoje</span>
          <div className="z-kpi-num" style={css(big + "color:var(--green);")}>{k.today}</div>
          <div style={css("font:500 11.5px/1 'IBM Plex Mono'; color:var(--muted); margin-top:9px;")}>realizado · {k.todayTx} ops</div>
        </div>
        <div style={css(card)}>
          <span style={css(kicker)}>Net PnL · 7d</span>
          <div className="z-kpi-num" style={css(big + "color:var(--green);")}>{k.w7}</div>
          <div style={css("font:500 11.5px/1 'IBM Plex Mono'; color:var(--green); margin-top:9px;")}>▲ {k.w7delta} vs sem. ant.</div>
        </div>
        <div style={css(card)}>
          <span style={css(kicker)}>Net PnL · 30d</span>
          <div className="z-kpi-num" style={css(big + "color:var(--green);")}>{k.m30}</div>
          <div style={css("font:500 11.5px/1 'IBM Plex Mono'; color:var(--muted); margin-top:9px;")}>projeção mês · {k.proj}</div>
        </div>
        <div style={css(card)}>
          <span style={css(kicker)}>Win rate · Hoje</span>
          <div className="z-kpi-num" style={css(big + "color:var(--text);")}>{k.winRate}</div>
          <div style={css("font:500 11.5px/1 'IBM Plex Mono'; color:var(--muted); margin-top:9px;")}>
            <span style={{ color: "var(--green)" }}>{k.ok} ok</span> · <span style={{ color: "var(--red)" }}>{k.fail} falhas</span>
          </div>
        </div>
      </div>

      {/* chart + gas + status */}
      <div className="z-grid-row2" style={css("display:grid; grid-template-columns:1.6fr 1fr 1fr; gap:14px; margin-top:14px;")}>
        <div style={css(card)}>
          <div style={css("display:flex; justify-content:space-between; align-items:center;")}>
            <span style={css(kicker)}>Net PnL · últimos 14 dias</span>
            <span style={css("font:600 12px/1 'IBM Plex Mono'; color:var(--green);")}>{k.w14sum}</span>
          </div>
          <div className="z-chart" style={css("display:flex; align-items:flex-end; gap:5px; height:118px; margin-top:18px;")}>
            {pnl14.map((b, i) => (
              <div
                key={i}
                title={b.label}
                style={css("flex:1; display:flex; flex-direction:column; justify-content:flex-end; height:100%;")}
              >
                <div style={{ ...css("border-radius:2px 2px 0 0; min-height:3px;"), height: `${b.pct}%`, background: b.color }} />
              </div>
            ))}
          </div>
        </div>
        <div style={css(card + "display:flex; flex-direction:column;")}>
          <span style={css(kicker)}>Gás na carteira</span>
          <div style={css("font:600 28px/1 'IBM Plex Mono'; color:var(--text); margin-top:12px;")}>
            {gas.eth}
            <span style={css("font-size:15px; color:var(--muted);")}> ETH</span>
          </div>
          <div style={css("font:500 12px/1 'IBM Plex Mono'; color:var(--muted); margin-top:8px;")}>≈ {gas.usd}</div>
          <div style={{ flex: 1 }} />
          <div style={css("display:flex; justify-content:space-between; align-items:center; margin-top:14px; padding-top:12px; border-top:1px solid var(--border);")}>
            <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>runway</span>
            <span style={css("font:600 14px/1 'IBM Plex Mono'; color:var(--gold);")}>{runwayDays} dias</span>
          </div>
        </div>
        <div style={css(card + "display:flex; flex-direction:column;")}>
          <span style={css(kicker)}>Status do bot</span>
          <div style={css("display:flex; align-items:center; gap:9px; margin-top:14px;")}>
            <span style={css("width:9px; height:9px; border-radius:50%; background:var(--green);")} />
            <span style={css("font:600 18px/1 'IBM Plex Sans'; color:var(--text);")}>Running</span>
          </div>
          <div style={css("display:flex; flex-direction:column; gap:9px; margin-top:16px;")}>
            <div style={css("display:flex; justify-content:space-between; font:500 11.5px/1 'IBM Plex Mono';")}>
              <span style={{ color: "var(--muted)" }}>kill switch</span>
              <span style={{ color: "var(--green)" }}>armado · ok</span>
            </div>
            <div style={css("display:flex; justify-content:space-between; font:500 11.5px/1 'IBM Plex Mono';")}>
              <span style={{ color: "var(--muted)" }}>cooldown</span>
              <span style={{ color: "var(--text2)" }}>inativo</span>
            </div>
            <div style={css("display:flex; justify-content:space-between; font:500 11.5px/1 'IBM Plex Mono';")}>
              <span style={{ color: "var(--muted)" }}>min EV adaptativo</span>
              <span style={{ color: "var(--gold)" }}>{adaptiveEv}</span>
            </div>
          </div>
        </div>
      </div>

      {/* motors */}
      <div className="z-grid-3" style={css("display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-top:14px;")}>
        {motors.map((m) => (
          <div key={m.tag} style={css(card)}>
            <div style={css("display:flex; align-items:center; justify-content:space-between;")}>
              <span style={css("font:600 11px/1 'IBM Plex Mono'; letter-spacing:.05em; color:var(--gold);")}>{m.tag}</span>
              <span style={css("font:500 10.5px/1 'IBM Plex Mono'; color:var(--muted);")}>{m.share} do lucro</span>
            </div>
            <div style={css("font:600 15px/1.2 'IBM Plex Sans'; color:var(--text); margin-top:9px;")}>{m.name}</div>
            <div style={css("display:flex; align-items:baseline; justify-content:space-between; margin-top:14px;")}>
              <span style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--green);")}>{m.pnl}</span>
              <span style={css("font:500 12px/1 'IBM Plex Mono'; color:var(--muted);")}>{m.ops} ops</span>
            </div>
            <div style={css("height:5px; border-radius:3px; background:var(--bg2); margin-top:14px; overflow:hidden;")}>
              <div style={{ ...css("height:100%; background:var(--gold);"), width: `${m.barPct}%` }} />
            </div>
          </div>
        ))}
      </div>

      {/* insights + ticker */}
      <div className="z-grid-2" style={css("display:grid; grid-template-columns:1.3fr 1fr; gap:14px; margin-top:14px;")}>
        <div style={css(card)}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.08em; text-transform:uppercase; color:var(--cyan);")}>Insights & anomalias</span>
          <div style={css("display:flex; flex-direction:column; gap:11px; margin-top:16px;")}>
            {insights.map((ins, i) => (
              <div key={i} style={css("display:flex; gap:11px; align-items:flex-start;")}>
                <span style={{ ...css("width:6px; height:6px; border-radius:50%; margin-top:6px; flex:none;"), background: ins.color }} />
                <span style={css("font:400 13px/1.45 'IBM Plex Sans'; color:var(--text2); min-width:0; overflow-wrap:anywhere;")}>{ins.text}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={css(card)}>
          <div style={css("display:flex; align-items:center; justify-content:space-between;")}>
            <span style={css(kicker)}>Eventos ao vivo</span>
            <span style={css("width:6px; height:6px; border-radius:50%; background:var(--green); animation:zpulse 2.2s infinite;")} />
          </div>
          <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
            {ticker.map((e, i) => (
              <div key={i} style={css("display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--border);")}>
                <span style={css("font:500 10px/1 'IBM Plex Mono'; color:var(--muted); width:42px; flex:none;")}>{e.time}</span>
                <span style={{ ...css("width:6px; height:6px; border-radius:50%; flex:none;"), background: e.color }} />
                <span style={css("font:500 12px/1.3 'IBM Plex Mono'; color:var(--text2); flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;")}>{e.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
