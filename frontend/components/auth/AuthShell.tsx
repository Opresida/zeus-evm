"use client";
import type { ReactNode } from "react";
import { css } from "@/lib/css";

/** Casca de marca das telas de auth: logo MAZARI + conteúdo + rodapé "Tecnologia exclusiva...". */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div
      data-theme="navy"
      style={css(
        "min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0; background:var(--bg); color:var(--text); font-family:'IBM Plex Sans',system-ui,sans-serif; padding:24px;",
      )}
    >
      <div
        style={css(
          "width:100%; max-width:380px; background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:32px 28px; display:flex; flex-direction:column; align-items:center; gap:6px;",
        )}
      >
        {/* Logo oficial ZEUS FLASHLOAN (lockup completo, fundo transparente) */}
        <img
          src="/brand/mazari-logo.png"
          alt="ZEUS FLASHLOAN — Control Panel"
          style={{ width: 196, height: "auto", marginTop: 2, marginBottom: 2 }}
        />
        <h1 style={css("font:700 18px/1.2 'IBM Plex Sans'; margin:4px 0 0; letter-spacing:-.01em; text-align:center;")}>{title}</h1>
        {subtitle && (
          <p style={css("font:400 12.5px/1.5 'IBM Plex Sans'; color:var(--muted); margin:2px 0 10px; text-align:center;")}>{subtitle}</p>
        )}
        <div style={css("width:100%; display:flex; flex-direction:column; gap:11px; margin-top:8px;")}>{children}</div>
      </div>

      <div style={css("margin-top:20px; display:flex; flex-direction:column; align-items:center; gap:4px;")}>
        <span style={css("font:500 10px/1.4 'IBM Plex Mono'; letter-spacing:.08em; color:var(--muted); text-align:center;")}>
          Tecnologia exclusiva do Grupo MAZARI CORP
        </span>
      </div>
    </div>
  );
}

/** Input padronizado das telas de auth. */
export function authInputStyle() {
  return css(
    "width:100%; padding:11px 13px; border-radius:9px; border:1px solid var(--border2); background:var(--bg2); color:var(--text); font:500 13px/1 'IBM Plex Sans'; outline:none;",
  );
}

/** Botão primário (gold) das telas de auth. */
export function authButtonStyle(disabled: boolean) {
  return css(
    `width:100%; padding:12px 13px; border-radius:9px; border:none; cursor:${disabled ? "not-allowed" : "pointer"}; font:700 13px/1 'IBM Plex Sans'; background:${disabled ? "var(--border2)" : "var(--gold)"}; color:${disabled ? "var(--muted)" : "#10131c"};`,
  );
}
