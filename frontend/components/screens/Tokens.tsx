"use client";
import { css } from "@/lib/css";
import type { ScreenProps } from "./shared";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:18px 20px;";
const kicker = "font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);";

/**
 * Tela "Tokens" — o porteiro de tokens. Mostra quais tokens estão no universo de trading de cada motor,
 * com VERDICT (entrou/saiu) + motivo em PT-BR simples + a DEX da saída + liquidez + lock.
 * Política por motor: M1 (liquidação) aceita o colateral que dá pra vender; M2 (arb) exige edge.
 * Dados via heartbeat → service_status.vetted_universe. Em DEMO usa o mock.
 */
export function Tokens({ vm }: ScreenProps) {
  const { tokenCards, tokenCounts } = vm;

  return (
    <section>
      <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Tokens</h1>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 18px;")}>
        O porteiro de tokens — quem entrou e quem saiu do universo de trading, e o porquê em linguagem simples.
        O mesmo token pode entrar num motor e sair no outro (M1 aceita colateral; M2 exige edge de arbitragem).
      </p>

      {/* Resumo */}
      <div style={css("display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap;")}>
        {[
          ["No universo", String(tokenCounts.total), "var(--text)"],
          ["Entraram (pass)", String(tokenCounts.pass), "var(--green, #4cc08a)"],
          ["Saíram (reject)", String(tokenCounts.reject), "var(--red)"],
        ].map(([label, val, color], i) => (
          <div key={i} style={css(card + "padding:12px 16px; min-width:130px;")}>
            <span style={css(kicker)}>{label}</span>
            <div style={css(`font:600 22px/1 'IBM Plex Mono'; color:${color}; margin-top:6px;`)}>{val}</div>
          </div>
        ))}
      </div>

      {/* Tabela: token · motor · verdict · saída · liquidez · lock · motivo */}
      <div style={css(card)}>
        <span style={css(kicker)}>Universo vetado (por token × motor)</span>
        <div style={css("display:grid; grid-template-columns:90px 110px 70px 130px 90px 1fr; gap:0; margin-top:14px;")}>
          {["Token", "Motor", "Status", "Saída (DEX)", "Liquidez", "Motivo"].map((h, i) => (
            <span key={i} style={css("font:600 9.5px/1 'IBM Plex Mono'; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding-bottom:10px; border-bottom:1px solid var(--border);")}>{h}</span>
          ))}
          {tokenCards.map((t, i) => (
            <div key={i} style={css("display:contents;")}>
              <span style={css("font:600 12px/1.3 'IBM Plex Mono'; color:var(--text); padding:11px 0; border-bottom:1px solid var(--border);")}>
                {t.symbol}{t.locked ? " 🔒" : ""}
              </span>
              <span style={css("font:500 11px/1.3 'IBM Plex Mono'; color:var(--muted); padding:11px 0; border-bottom:1px solid var(--border);")}>{t.motorLabel}</span>
              <span style={css(`font:600 10px/1 'IBM Plex Mono'; letter-spacing:.04em; text-transform:uppercase; color:${t.pass ? "var(--green, #4cc08a)" : "var(--red)"}; padding:11px 0; border-bottom:1px solid var(--border);`)}>
                {t.pass ? "entrou" : "saiu"}
              </span>
              <span style={css("font:500 11px/1.3 'IBM Plex Mono'; color:var(--cyan, #56b6c2); padding:11px 0; border-bottom:1px solid var(--border);")}>{t.exitDex}</span>
              <span style={css("font:500 11px/1.3 'IBM Plex Mono'; color:var(--muted); padding:11px 0; border-bottom:1px solid var(--border);")}>{t.liquidity}</span>
              <span style={css("font:400 11.5px/1.4 'IBM Plex Sans'; color:var(--text2, var(--text)); padding:11px 0; border-bottom:1px solid var(--border);")}>{t.reason}</span>
            </div>
          ))}
        </div>
        <p style={css("font:400 11px/1.5 'IBM Plex Sans'; color:var(--muted); margin:14px 0 0;")}>
          🔒 = liquidez travada. "Entrou" = passou no porteiro (segurança + saída numa DEX + liquidez). "Saiu" = barrado,
          com o motivo ao lado. O filtro só observa por enquanto — ligar de verdade é um botão admin (próximas etapas).
        </p>
      </div>
    </section>
  );
}
