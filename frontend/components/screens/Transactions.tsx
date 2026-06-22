"use client";
import { css } from "@/lib/css";
import { Hover } from "@/components/ui";
import type { ScreenProps } from "./shared";

const TXGRID = "display:grid; grid-template-columns:64px 96px 1.1fr 1fr 110px 90px 80px 110px 70px; gap:0;";

export function Transactions({ vm, ui, actions }: ScreenProps) {
  const { txFilters, txHeads, txRows } = vm;
  return (
    <section>
      <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Transações</h1>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 20px;")}>
        Histórico completo · clique no hash para abrir no Basescan
      </p>

      <div style={css("display:flex; align-items:center; gap:10px; margin-bottom:16px; flex-wrap:wrap;")}>
        {txFilters.map((f) => (
          <Hover
            key={f.id}
            as="button"
            onClick={() => actions.setFilter(f.id)}
            base={`padding:8px 14px; border-radius:8px; border:1px solid ${f.border}; background:${f.bg}; color:${f.fg}; font:600 12px/1 'IBM Plex Mono'; cursor:pointer;`}
            hover="border-color:var(--gold);"
          >
            {f.label} <span style={{ color: "var(--muted)" }}>{f.count}</span>
          </Hover>
        ))}
        <div style={{ flex: 1 }} />
        <div style={css("display:flex; align-items:center; gap:8px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; background:var(--panel); width:240px;")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          <input
            value={ui.query}
            onChange={(e) => actions.setQuery(e.target.value)}
            placeholder="hash · borrower · par"
            style={css("background:transparent; border:none; outline:none; color:var(--text); font:500 12px/1 'IBM Plex Mono'; width:100%;")}
          />
        </div>
      </div>

      <div className="z-txtable" style={css("background:var(--panel); border:1px solid var(--border); border-radius:11px; overflow:hidden;")}>
        <div className="z-txgrid" style={css(TXGRID + "padding:13px 20px; border-bottom:1px solid var(--border); background:var(--bg2);")}>
          {txHeads.map((h, i) => (
            <span key={i} style={css("font:600 9.5px/1.2 'IBM Plex Mono'; letter-spacing:.08em; text-transform:uppercase; color:var(--muted);")}>
              {h}
            </span>
          ))}
        </div>
        {txRows.length === 0 && (
          <div style={css("padding:28px 20px; font:500 12px/1.4 'IBM Plex Mono'; color:var(--muted); text-align:center;")}>
            Nenhuma transação para este filtro.
          </div>
        )}
        {txRows.map((t, i) => (
          <Hover
            key={i}
            base={TXGRID + "padding:14px 20px; border-bottom:1px solid var(--border); align-items:center;"}
            hover="background:var(--bg2);"
            className="z-txgrid"
          >
            <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>{t.time}</span>
            <span style={{ ...css("display:inline-flex; align-items:center; gap:6px; font:600 10.5px/1 'IBM Plex Mono';"), color: t.statusColor }}>
              <span style={{ ...css("width:6px;height:6px;border-radius:50%;"), background: t.statusColor }} />
              {t.statusLabel}
            </span>
            <span style={css("font:500 12.5px/1 'IBM Plex Sans'; color:var(--text);")}>{t.protocol}</span>
            <span style={css("font:500 12px/1 'IBM Plex Mono'; color:var(--text2);")}>{t.pair}</span>
            <span style={{ ...css("font:600 12.5px/1 'IBM Plex Mono';"), color: t.netColor }}>{t.net}</span>
            <span style={css("font:500 11.5px/1 'IBM Plex Mono'; color:var(--muted);")}>{t.gas}</span>
            <span style={{ ...css("font:500 11.5px/1 'IBM Plex Mono';"), color: t.driftColor }}>{t.drift}</span>
            <Hover
              as="a"
              href={t.url}
              target="_blank"
              base="font:500 11.5px/1 'IBM Plex Mono'; color:var(--cyan); text-decoration:none;"
              hover="text-decoration:underline;"
            >
              {t.hashShort} ↗
            </Hover>
            <span style={css("font:500 10px/1 'IBM Plex Mono'; color:var(--muted); text-transform:uppercase;")}>{t.mode}</span>
          </Hover>
        ))}
      </div>
    </section>
  );
}
