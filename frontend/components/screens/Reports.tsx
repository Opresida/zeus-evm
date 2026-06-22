"use client";
import { css } from "@/lib/css";
import { Hover } from "@/components/ui";
import { MOCK } from "@/lib/mockData";
import type { ScreenProps } from "./shared";

function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function Reports({ vm, ui, actions }: ScreenProps) {
  const { periods, rep, reportPeriodLabel, reportRange } = vm;

  const exportCsv = () => {
    const head = "hora,status,protocolo,par,net_usd,gas_usd,drift_bps,hash,mode";
    const lines = MOCK.allRows.map((r) =>
      [r.time, r.st, r.protocol, r.pair, r.net, r.gas, r.drift, r.hash ?? "", r.mode].join(","),
    );
    const meta = `# ZEUS Command — relatório ${reportPeriodLabel} (${reportRange})\n# net=${rep.net} win=${rep.win} ops=${rep.ops} gas=${rep.gas} drift=${rep.drift}`;
    download(`zeus-${ui.period}-${reportRange.replace(/\s/g, "_")}.csv`, `${meta}\n${head}\n${lines.join("\n")}`, "text/csv");
  };

  return (
    <section>
      <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Relatórios</h1>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 20px;")}>
        Resumo executivo, transações e PnL do período — exportável em PDF e CSV
      </p>

      <div style={css("display:flex; align-items:center; gap:14px; margin-bottom:20px; flex-wrap:wrap;")}>
        <div style={css("display:flex; gap:6px; padding:4px; background:var(--panel); border:1px solid var(--border); border-radius:9px;")}>
          {periods.map((p) => (
            <button
              key={p.id}
              onClick={() => actions.setPeriod(p.id)}
              style={css(`padding:8px 18px; border-radius:6px; border:none; background:${p.bg}; color:${p.fg}; font:600 12px/1 'IBM Plex Mono'; cursor:pointer;`)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <Hover
          as="button"
          onClick={exportCsv}
          base="display:flex; align-items:center; gap:8px; padding:10px 18px; border-radius:8px; border:1px solid var(--border2); background:var(--panel); color:var(--text); font:600 12.5px/1 'IBM Plex Sans'; cursor:pointer;"
          hover="border-color:var(--cyan);"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>{" "}
          CSV
        </Hover>
        <Hover
          as="button"
          onClick={() => window.print()}
          base="display:flex; align-items:center; gap:8px; padding:10px 18px; border-radius:8px; border:1px solid var(--gold); background:var(--goldsoft); color:var(--gold); font:600 12.5px/1 'IBM Plex Sans'; cursor:pointer;"
          hover="background:var(--gold); color:var(--bg);"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>{" "}
          PDF
        </Hover>
      </div>

      <div style={css("background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:30px 34px; max-width:780px;")}>
        <div style={css("display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:22px; border-bottom:1px solid var(--border);")}>
          <div>
            <div style={css("font:700 18px/1.1 'IBM Plex Sans'; color:var(--text);")}>Relatório {reportPeriodLabel}</div>
            <div style={css("font:500 12px/1 'IBM Plex Mono'; color:var(--muted); margin-top:8px;")}>ZEUS · Base mainnet · {reportRange}</div>
          </div>
          <div style={css("display:flex; align-items:center; gap:9px;")}>
            <div style={css("width:26px; height:26px; border-radius:7px; background:var(--panel2); border:1px solid var(--border2); display:flex; align-items:center; justify-content:center;")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--gold)">
                <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
              </svg>
            </div>
            <span style={css("font:700 13px/1 'IBM Plex Sans'; letter-spacing:.1em;")}>ZEUS</span>
          </div>
        </div>
        <div className="z-grid-3" style={css("display:grid; grid-template-columns:repeat(3,1fr); gap:18px; padding:24px 0; border-bottom:1px solid var(--border);")}>
          {[
            ["Net realizado", rep.net, "var(--green)"],
            ["Win rate", rep.win, "var(--text)"],
            ["Ops totais", rep.ops, "var(--text)"],
            ["Gás pago", rep.gas, "var(--red)"],
            ["Melhor motor", rep.bestMotor, "var(--text)"],
            ["Drift médio", rep.drift, "var(--gold)"],
          ].map(([label, val, color], i) => (
            <div key={i}>
              <span style={css("font:500 10.5px/1 'IBM Plex Mono'; color:var(--muted); text-transform:uppercase;")}>{label}</span>
              <div style={{ ...css("margin-top:9px; font:600 22px/1 'IBM Plex Mono';"), color: color as string }}>{val}</div>
            </div>
          ))}
        </div>
        <div style={css("padding-top:22px;")}>
          <span style={css("font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--cyan);")}>Resumo executivo</span>
          <p style={css("font:400 14px/1.6 'IBM Plex Sans'; color:var(--text2); margin:12px 0 0;")}>{rep.summary}</p>
        </div>
      </div>
    </section>
  );
}
