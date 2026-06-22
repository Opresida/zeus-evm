import type { CSSProperties } from "react";

/**
 * Converte uma string de CSS inline (como no design ZEUS Command.dc.html)
 * em um objeto de estilo React. Permite portar o markup do design quase
 * verbatim, preservando as variáveis de tema `var(--x)`.
 *
 * Ex.: css("display:flex; gap:10px; border:1px solid var(--border)")
 *   -> { display: "flex", gap: "10px", border: "1px solid var(--border)" }
 */
export function css(input: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of input.split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    const rawKey = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (!rawKey || !value) continue;
    // custom property (--x) fica como está; demais viram camelCase
    const key = rawKey.startsWith("--")
      ? rawKey
      : rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = value;
  }
  return out as CSSProperties;
}

/** Atalho para mesclar duas strings de estilo. */
export function merge(a: string, b?: string): CSSProperties {
  return css(b ? `${a};${b}` : a);
}
