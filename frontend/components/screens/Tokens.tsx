"use client";
import { css } from "@/lib/css";
import type { ScreenProps } from "./shared";
import { ExecutionControl } from "./Settings";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:18px 20px;";
const kicker = "font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);";
const cellPad = "padding:11px 0;";
const rowBorder = "border-bottom:1px solid var(--border);";
// Grids compartilhados por header + linhas (padrão responsivo z-txgrid/z-card-row).
const UNIGRID = "display:grid; grid-template-columns:90px 110px 70px 130px 90px 1fr; gap:0 14px; align-items:center;";
const LOGGRID = "display:grid; grid-template-columns:64px 100px 56px 1fr; gap:0 14px; align-items:center;";

/**
 * Tela "Tokens" — o porteiro de tokens. Universo (token × motor) + log de entrou/saiu, com motivo em PT-BR.
 * Responsivo: ≤900px a tabela rola na horizontal (z-txtable/z-txgrid); ≤480px vira cards empilhados
 * (z-card-row + data-label). Dados via heartbeat/eventos; em DEMO usa o mock.
 */
export function Tokens({ vm, isAdmin }: ScreenProps & { isAdmin?: boolean }) {
  const { tokenCards, tokenCounts, tokenLog, vettingEnforce, vettingRevetAt } = vm;
  const m2On = !!vettingEnforce?.motor2;
  const m1On = !!vettingEnforce?.motor1;
  const revetAgo = (() => {
    if (!vettingRevetAt) return null;
    const sec = Math.max(0, Math.floor((Date.now() - new Date(vettingRevetAt).getTime()) / 1000));
    return sec < 60 ? `há ${sec}s` : sec < 3600 ? `há ${Math.floor(sec / 60)}min` : `há ${Math.floor(sec / 3600)}h`;
  })();

  return (
    <section>
      <div style={css("display:flex; align-items:center; gap:10px; flex-wrap:wrap;")}>
        <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Tokens</h1>
        <span style={css(`font:600 9.5px/1 'IBM Plex Mono'; letter-spacing:.06em; text-transform:uppercase; padding:5px 9px; border-radius:6px; border:1px solid; color:${m1On ? "var(--green, #4cc08a)" : "var(--muted)"}; border-color:${m1On ? "var(--green, #4cc08a)" : "var(--border)"};`)}>
          {m1On ? "filtro M1 ligado" : "M1 só observando"}
        </span>
        <span style={css(`font:600 9.5px/1 'IBM Plex Mono'; letter-spacing:.06em; text-transform:uppercase; padding:5px 9px; border-radius:6px; border:1px solid; color:${m2On ? "var(--green, #4cc08a)" : "var(--muted)"}; border-color:${m2On ? "var(--green, #4cc08a)" : "var(--border)"};`)}>
          {m2On ? "filtro M2 ligado" : "M2 só observando"}
        </span>
        {revetAgo && (
          <span style={css("font:500 9.5px/1 'IBM Plex Mono'; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); padding:5px 8px; border-radius:6px; background:var(--bg2);")}>
            re-vet {revetAgo}
          </span>
        )}
      </div>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 16px;")}>
        O porteiro de tokens — quem entrou e quem saiu do universo de trading, e o porquê em linguagem simples.
        O mesmo token pode entrar num motor e sair no outro (M1 aceita colateral; M2 exige edge de arbitragem).
      </p>

      {/* Botões admin: ligam/desligam o FILTRO de cada motor (engine_control vetting_mX_enforce) */}
      {isAdmin && (
        <div style={css(card + "margin-bottom:14px;")}>
          <ExecutionControl motor="vetting_m1_enforce" label="Filtro de tokens — Motor 1 (liquidação)" />
          <div style={css("height:1px; background:var(--border); margin:14px 0;")} />
          <ExecutionControl motor="vetting_m2_enforce" label="Filtro de tokens — Motor 2 (arbitragem)" />
          <p style={css("font:400 11px/1.5 'IBM Plex Sans'; color:var(--muted); margin:12px 0 0;")}>
            Ligar faz o bot DEIXAR DE tocar tokens reprovados no porteiro (sem saída / sem liquidez / inseguros).
            No M1, dado incompleto NÃO bloqueia (nunca perde liquidação lucrativa); no M2, na dúvida ele fica de fora.
            Em DRY_RUN não envia nada — só treina num universo mais seguro. Só você (admin) liga.
          </p>
        </div>
      )}

      {/* Resumo (já responsivo: flex-wrap) */}
      <div style={css("display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap;")}>
        {[
          ["No universo", String(tokenCounts.total), "var(--text)"],
          ["Entraram (pass)", String(tokenCounts.pass), "var(--green, #4cc08a)"],
          ["Saíram (reject)", String(tokenCounts.reject), "var(--red)"],
        ].map(([label, val, color], i) => (
          <div key={i} style={css(card + "padding:12px 16px; flex:1 1 130px; min-width:120px;")}>
            <span style={css(kicker)}>{label}</span>
            <div style={css(`font:600 22px/1 'IBM Plex Mono'; color:${color}; margin-top:6px;`)}>{val}</div>
          </div>
        ))}
      </div>

      {/* Universo (token × motor) — tabela responsiva */}
      <div style={css(card + "padding-bottom:8px;")}>
        <span style={css(kicker)}>Universo vetado (por token × motor)</span>
        <div className="z-txtable" style={css("margin-top:12px; border-radius:9px;")}>
          <div className="z-txgrid z-card-hide" style={css(UNIGRID + "border-bottom:1px solid var(--border);")}>
            {["Token", "Motor", "Status", "Saída (DEX)", "Liquidez", "Motivo"].map((h, i) => (
              <span key={i} style={css("font:600 9.5px/1 'IBM Plex Mono'; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding-bottom:10px;")}>{h}</span>
            ))}
          </div>
          {tokenCards.map((t, i) => (
            <div key={i} className="z-txgrid z-card-row" style={css(UNIGRID + rowBorder)}>
              <span data-label="Token" style={css("font:600 12px/1.3 'IBM Plex Mono'; color:var(--text);" + cellPad)}>
                {t.symbol}{t.locked ? " 🔒" : ""}
              </span>
              <span data-label="Motor" style={css("font:500 11px/1.3 'IBM Plex Mono'; color:var(--muted);" + cellPad)}>{t.motorLabel}</span>
              <span data-label="Status" style={css(`font:600 10px/1 'IBM Plex Mono'; letter-spacing:.04em; text-transform:uppercase; color:${t.pass ? "var(--green, #4cc08a)" : "var(--red)"};` + cellPad)}>
                {t.pass ? "entrou" : "saiu"}
              </span>
              <span data-label="Saída" style={css("font:500 11px/1.3 'IBM Plex Mono'; color:var(--cyan, #56b6c2);" + cellPad)}>{t.exitDex}</span>
              <span data-label="Liquidez" style={css("font:500 11px/1.3 'IBM Plex Mono'; color:var(--muted);" + cellPad)}>{t.liquidity}</span>
              <span data-label="Motivo" style={css("font:400 11.5px/1.4 'IBM Plex Sans'; color:var(--text2, var(--text));" + cellPad)}>{t.reason}</span>
            </div>
          ))}
        </div>
        <p style={css("font:400 11px/1.5 'IBM Plex Sans'; color:var(--muted); margin:12px 0 8px;")}>
          🔒 = liquidez travada. "Entrou" = passou no porteiro (segurança + saída numa DEX + liquidez). "Saiu" = barrado,
          com o motivo ao lado. O filtro só observa por enquanto — ligar de verdade é um botão admin (próximas etapas).
        </p>
      </div>

      {/* Log de entrou/saiu — tabela responsiva */}
      <div style={css(card + "margin-top:14px; padding-bottom:8px;")}>
        <span style={css(kicker)}>Movimento recente (entrou / saiu)</span>
        {tokenLog.length === 0 ? (
          <p style={css("font:400 12px/1.4 'IBM Plex Sans'; color:var(--muted); margin:12px 0 0;")}>
            Nenhum movimento ainda — quando o porteiro estiver ativo, cada entrada/saída aparece aqui com o motivo.
          </p>
        ) : (
          <div className="z-txtable" style={css("margin-top:12px; border-radius:9px;")}>
            <div className="z-txgrid z-card-hide" style={css(LOGGRID + "border-bottom:1px solid var(--border);")}>
              {["Hora", "Token", "Ação", "Motivo"].map((h, i) => (
                <span key={i} style={css("font:600 9.5px/1 'IBM Plex Mono'; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding-bottom:10px;")}>{h}</span>
              ))}
            </div>
            {tokenLog.map((row, i) => (
              <div key={i} className="z-txgrid z-card-row" style={css(LOGGRID + rowBorder)}>
                <span data-label="Hora" style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);" + cellPad)}>{row.time}</span>
                <span data-label="Token" style={css("font:600 11px/1 'IBM Plex Mono'; color:var(--text);" + cellPad)}>
                  {row.symbol} <span style={css("color:var(--muted);")}>{row.motor}</span>
                </span>
                <span data-label="Ação" style={css(`font:600 10px/1 'IBM Plex Mono'; text-transform:uppercase; color:${row.color};` + cellPad)}>{row.action}</span>
                <span data-label="Motivo" style={css("font:400 11.5px/1.4 'IBM Plex Sans'; color:var(--text2, var(--text));" + cellPad)}>{row.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
