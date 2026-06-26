"use client";
import { css } from "@/lib/css";
import type { ScreenProps } from "./shared";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:18px 20px;";

export function Health({ vm }: ScreenProps) {
  const { healthKpis, latP50Path, latP95Path, ks, components, cooldowns, eventLog, discovery, failures } = vm;
  return (
    <section>
      <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Saúde & Auto-ajuste</h1>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 20px;")}>
        Prontidão dos componentes, cooldowns, reorgs e latência de dispatch
      </p>

      <div className="z-grid-6" style={css("display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin-bottom:14px;")}>
        {healthKpis.map((kp, i) => (
          <div key={i} style={css("background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:16px 16px;")}>
            <span style={css("font:600 9.5px/1.2 'IBM Plex Mono'; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); display:block;")}>
              {kp.label}
            </span>
            {kp.isStatus && (
              <div style={css("display:flex; align-items:center; gap:7px; margin-top:13px;")}>
                <span style={{ ...css("width:8px;height:8px;border-radius:50%;"), background: kp.dot }} />
                <span style={css("font:600 16px/1 'IBM Plex Sans'; color:var(--text);")}>{kp.big}</span>
              </div>
            )}
            {kp.isVal && (
              <div className="z-kpi-num" style={{ ...css("font:600 20px/1 'IBM Plex Mono'; margin-top:13px;"), color: kp.color }}>
                {kp.big}
                <span style={css("font-size:12px; color:var(--muted);")}>{kp.unit}</span>
              </div>
            )}
            <span style={css("font:500 10px/1.3 'IBM Plex Mono'; color:var(--muted); margin-top:9px; display:block;")}>{kp.sub}</span>
          </div>
        ))}
      </div>

      <div className="z-grid-row2" style={css("display:grid; grid-template-columns:1.5fr 1fr; gap:14px; margin-bottom:14px;")}>
        <div style={css(card)}>
          <div style={css("display:flex; gap:18px; align-items:center; flex-wrap:wrap;")}>
            <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Latência de dispatch · 24h</span>
            <span style={css("display:flex; align-items:center; gap:6px; font:500 11px/1 'IBM Plex Mono'; color:var(--text2);")}>
              <span style={css("width:14px; height:2px; background:var(--green);")} />p50
            </span>
            <span style={css("display:flex; align-items:center; gap:6px; font:500 11px/1 'IBM Plex Mono'; color:var(--text2);")}>
              <span style={css("width:14px; height:2px; background:var(--gold);")} />p95
            </span>
          </div>
          <svg viewBox="0 0 600 150" preserveAspectRatio="none" style={{ width: "100%", height: 150, display: "block", marginTop: 16 }}>
            <line x1="8" y1="8" x2="592" y2="8" stroke="var(--border)" strokeWidth="1" />
            <line x1="8" y1="79" x2="592" y2="79" stroke="var(--border)" strokeWidth="1" />
            <line x1="8" y1="142" x2="592" y2="142" stroke="var(--border)" strokeWidth="1" />
            <path d={latP95Path} fill="none" stroke="var(--gold)" strokeWidth="2" />
            <path d={latP50Path} fill="none" stroke="var(--green)" strokeWidth="2" />
          </svg>
        </div>
        <div style={css(card + "display:flex; flex-direction:column;")}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Kill switch · perda em 24h</span>
          <div style={css("font:600 28px/1 'IBM Plex Mono'; color:var(--red); margin-top:14px;")}>{ks.loss}</div>
          <div style={css("font:500 11.5px/1 'IBM Plex Mono'; color:var(--muted); margin-top:9px;")}>
            limite: {ks.limit} · {ks.pct}% consumido
          </div>
          <div style={css("height:8px; border-radius:5px; background:var(--bg2); overflow:hidden; margin-top:14px;")}>
            <div style={{ ...css("height:100%; background:var(--green);"), width: `${ks.pct}%` }} />
          </div>
          <div style={{ flex: 1 }} />
          <div style={css("display:flex; justify-content:space-between; align-items:center; margin-top:16px; padding-top:13px; border-top:1px solid var(--border);")}>
            <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>último acionamento</span>
            <span style={css("font:600 11.5px/1 'IBM Plex Mono'; color:var(--text2);")}>{ks.last}</span>
          </div>
        </div>
      </div>

      <div className="z-grid-row2" style={css("display:grid; grid-template-columns:1.2fr 1fr; gap:14px;")}>
        <div style={css(card)}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Prontidão dos componentes (/readyz)</span>
          <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
            {components.map((cp, i) => (
              <div key={i} style={css("display:flex; align-items:center; gap:12px; padding:11px 0; border-bottom:1px solid var(--border);")}>
                <span style={{ ...css("width:8px; height:8px; border-radius:50%; flex:none;"), background: cp.color }} />
                <span style={css("font:500 13px/1 'IBM Plex Sans'; color:var(--text2); flex:1;")}>{cp.name}</span>
                <span style={{ ...css("font:600 11px/1 'IBM Plex Mono';"), color: cp.color }}>{cp.status}</span>
                <span style={css("font:500 10.5px/1 'IBM Plex Mono'; color:var(--muted); width:70px; text-align:right;")}>{cp.detail}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={css(card)}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Cooldowns & auto-pause</span>
          <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
            {cooldowns.map((cd, i) => (
              <div key={i} style={css("padding:11px 0; border-bottom:1px solid var(--border);")}>
                <div style={css("display:flex; justify-content:space-between; align-items:center;")}>
                  <span style={css("font:600 12px/1 'IBM Plex Sans'; color:var(--text2);")}>{cd.scope}</span>
                  <span style={{ ...css("font:600 11px/1 'IBM Plex Mono';"), color: cd.color }}>{cd.state}</span>
                </div>
                <div style={css("font:500 11.5px/1.4 'IBM Plex Mono'; color:var(--muted); margin-top:6px;")}>{cd.reason}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Radar de descoberta (item 2) + Falhas recentes (item 1) */}
      <div className="z-grid-row2" style={css("display:grid; grid-template-columns:1fr 1.2fr; gap:14px; margin-top:14px;")}>
        <div style={css(card)}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Radar de descoberta</span>
          {discovery ? (
            <div style={css("margin-top:14px;")}>
              <div style={css("display:flex; align-items:center; gap:8px;")}>
                <span style={css("width:8px;height:8px;border-radius:50%;background:var(--green);")} />
                <span style={css("font:600 15px/1 'IBM Plex Sans'; color:var(--text);")}>Scanner vivo</span>
                <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>· {discovery.service} · há {discovery.ago}</span>
              </div>
              <div style={css("display:flex; gap:22px; margin-top:16px;")}>
                <div><div style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--text);")}>{discovery.positions}</div><span style={css("font:500 10px/1.2 'IBM Plex Mono'; color:var(--muted);")}>posições vistas</span></div>
                <div><div style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--green);")}>{discovery.dispatched}</div><span style={css("font:500 10px/1.2 'IBM Plex Mono'; color:var(--muted);")}>despachadas</span></div>
                <div><div style={css("font:600 22px/1 'IBM Plex Mono'; color:var(--text2);")}>{discovery.rejected}</div><span style={css("font:500 10px/1.2 'IBM Plex Mono'; color:var(--muted);")}>rejeitadas</span></div>
              </div>
            </div>
          ) : (
            <div style={css("font:500 12px/1.4 'IBM Plex Mono'; color:var(--muted); margin-top:14px;")}>sem heartbeat de descoberta ainda</div>
          )}
        </div>
        <div style={css(card)}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Falhas recentes</span>
          <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
            {failures.length ? (
              failures.map((f, i) => (
                <div key={i} style={css("display:flex; align-items:center; gap:12px; padding:11px 0; border-bottom:1px solid var(--border);")}>
                  <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted); width:46px; flex:none;")}>{f.time}</span>
                  <span style={{ ...css("width:7px; height:7px; border-radius:50%; flex:none;"), background: f.color }} />
                  <span style={css("font:600 11px/1 'IBM Plex Mono'; color:var(--text2); width:96px; flex:none;")}>{f.protocol}</span>
                  <span style={css("font:400 12px/1.3 'IBM Plex Sans'; color:var(--text2); flex:1;")}>{f.category} · {f.detail}</span>
                </div>
              ))
            ) : (
              <div style={css("font:500 12px/1.4 'IBM Plex Mono'; color:var(--muted);")}>sem falhas recentes 🎉</div>
            )}
          </div>
        </div>
      </div>

      <div style={css(card + "margin-top:14px;")}>
        <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Registro de eventos do sistema</span>
        <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
          {eventLog.map((el, i) => (
            <div key={i} className="z-evrow" style={css("display:flex; align-items:center; gap:14px; padding:11px 0; border-bottom:1px solid var(--border);")}>
              <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted); width:46px; flex:none;")}>{el.time}</span>
              <span style={{ ...css("width:7px; height:7px; border-radius:50%; flex:none;"), background: el.color }} />
              <span className="z-evtype" style={css("font:600 10.5px/1 'IBM Plex Mono'; color:var(--text2); width:170px; flex:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;")}>
                {el.type}
              </span>
              <span className="z-evtext" style={css("font:400 12.5px/1.3 'IBM Plex Sans'; color:var(--text2); flex:1;")}>{el.text}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
