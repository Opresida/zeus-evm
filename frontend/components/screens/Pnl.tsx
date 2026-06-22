"use client";
import { css } from "@/lib/css";
import type { ScreenProps } from "./shared";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px;";
const kmono = "font:600 10px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);";

export function Pnl({ vm, actions }: ScreenProps) {
  const { periods, pnlk, pnlAreaPath, pnlExpectedPath, pnlLinePath, motorBreak, protoBreak } = vm;
  return (
    <section>
      <div style={css("display:flex; align-items:flex-end; justify-content:space-between; margin-bottom:20px;")}>
        <div>
          <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Lucro & PnL</h1>
          <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 0;")}>
            Realizado vs esperado · drift · breakdown por motor e protocolo
          </p>
        </div>
        <div style={css("display:flex; gap:6px; padding:4px; background:var(--panel); border:1px solid var(--border); border-radius:9px;")}>
          {periods.map((p) => (
            <button
              key={p.id}
              onClick={() => actions.setPeriod(p.id)}
              style={css(`padding:7px 16px; border-radius:6px; border:none; background:${p.bg}; color:${p.fg}; font:600 12px/1 'IBM Plex Mono'; cursor:pointer;`)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="z-grid-4" style={css("display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:14px;")}>
        <div style={css(card + "padding:16px 18px;")}>
          <span style={css(kmono)}>Realizado</span>
          <div className="z-kpi-num" style={css("font:600 24px/1 'IBM Plex Mono'; color:var(--green); margin-top:10px;")}>{pnlk.realized}</div>
        </div>
        <div style={css(card + "padding:16px 18px;")}>
          <span style={css(kmono)}>Esperado</span>
          <div className="z-kpi-num" style={css("font:600 24px/1 'IBM Plex Mono'; color:var(--text); margin-top:10px;")}>{pnlk.expected}</div>
        </div>
        <div style={css(card + "padding:16px 18px;")}>
          <span style={css(kmono)}>Drift médio</span>
          <div className="z-kpi-num" style={css("font:600 24px/1 'IBM Plex Mono'; color:var(--red); margin-top:10px;")}>{pnlk.drift}</div>
        </div>
        <div style={css(card + "padding:16px 18px;")}>
          <span style={css(kmono)}>Gás pago</span>
          <div className="z-kpi-num" style={css("font:600 24px/1 'IBM Plex Mono'; color:var(--text2); margin-top:10px;")}>{pnlk.gas}</div>
        </div>
      </div>

      <div style={css(card + "padding:20px 22px; margin-bottom:14px;")}>
        <div style={css("display:flex; gap:18px; align-items:center; margin-bottom:18px; flex-wrap:wrap;")}>
          <span style={css("font:600 11px/1.2 'IBM Plex Mono'; letter-spacing:.06em; text-transform:uppercase; color:var(--muted);")}>Realizado vs esperado</span>
          <span style={css("display:flex; align-items:center; gap:6px; font:500 11px/1 'IBM Plex Mono'; color:var(--text2);")}>
            <span style={css("width:14px; height:2px; background:var(--green);")} />realizado
          </span>
          <span style={css("display:flex; align-items:center; gap:6px; font:500 11px/1 'IBM Plex Mono'; color:var(--text2);")}>
            <span style={css("width:14px; height:2px; background:var(--muted); border-top:1px dashed var(--muted);")} />esperado
          </span>
        </div>
        <svg viewBox="0 0 600 200" preserveAspectRatio="none" style={{ width: "100%", height: 200, display: "block" }}>
          <path d={pnlAreaPath} fill="var(--greensoft)" opacity="0.6" />
          <path d={pnlExpectedPath} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="5 4" opacity="0.7" />
          <path d={pnlLinePath} fill="none" stroke="var(--green)" strokeWidth="2.2" />
        </svg>
      </div>

      <div className="z-grid-2" style={css("display:grid; grid-template-columns:1fr 1fr; gap:14px;")}>
        <div style={css(card + "padding:18px 20px;")}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Lucro por motor</span>
          <div style={css("display:flex; flex-direction:column; gap:14px; margin-top:18px;")}>
            {motorBreak.map((mb, i) => (
              <div key={i}>
                <div style={css("display:flex; justify-content:space-between; font:500 12px/1 'IBM Plex Mono'; margin-bottom:7px;")}>
                  <span style={{ color: "var(--text2)" }}>{mb.name}</span>
                  <span style={{ color: "var(--green)" }}>{mb.val}</span>
                </div>
                <div style={css("height:7px; border-radius:4px; background:var(--bg2); overflow:hidden;")}>
                  <div style={{ ...css("height:100%; background:var(--gold);"), width: `${mb.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={css(card + "padding:18px 20px;")}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);")}>Lucro por protocolo</span>
          <div style={css("display:flex; flex-direction:column; gap:14px; margin-top:18px;")}>
            {protoBreak.map((pb, i) => (
              <div key={i}>
                <div style={css("display:flex; justify-content:space-between; font:500 12px/1 'IBM Plex Mono'; margin-bottom:7px;")}>
                  <span style={{ color: "var(--text2)" }}>{pb.name}</span>
                  <span style={{ color: "var(--green)" }}>{pb.val}</span>
                </div>
                <div style={css("height:7px; border-radius:4px; background:var(--bg2); overflow:hidden;")}>
                  <div style={{ ...css("height:100%; background:var(--cyan);"), width: `${pb.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
