"use client";
import { useEffect, useState } from "react";
import { css } from "@/lib/css";
import { Hover } from "@/components/ui";
import { enablePush } from "@/lib/push";
import type { ScreenProps } from "./shared";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:20px 22px;";
const kicker = "font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.07em; text-transform:uppercase; color:var(--muted);";

/**
 * Controle de EXECUÇÃO de um motor. Liga/desliga o ENVIO de transações pelo bot via
 * Supabase `engine_control` (POST /api/control). Modelo armado-mas-travado: ligar aqui LIBERA
 * o envio; os circuit breakers do bot seguem valendo. LIGAR exige dupla confirmação (dinheiro real).
 *
 * Motor 1 = liquidações (clássica + pré-liquidação Morpho). Motor 2 = arbitragem cross-DEX.
 *
 * Mostra o estado DESEJADO (o que o painel pediu). O estado REAL do bot vem do health/heartbeat —
 * se divergir (ex.: bot offline, sem SUPABASE_URL), o operador percebe pelo "estado real" no Home.
 */
function ExecutionControl({ motor, label }: { motor: string; label: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null); // null = carregando
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/control?motor=${motor}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        const row = Array.isArray(j?.control) ? j.control[0] : j?.control;
        setEnabled(!!row?.execution_enabled);
      })
      .catch(() => alive && setMsg("não foi possível ler o estado (Supabase?)"));
    return () => {
      alive = false;
    };
  }, [motor]);

  const apply = async (next: boolean) => {
    if (next) {
      if (!window.confirm(`LIGAR execução do ${label} — o bot passará a SUBMETER transações reais. Continuar?`)) return;
      if (!window.confirm("Confirmação final: dinheiro real em jogo. Circuit breakers seguem ativos. Ligar agora?")) return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ motor, execution_enabled: next }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? "falha");
      setEnabled(next);
      setMsg(next ? "Execução LIGADA ✓ (o bot reflete em até ~1 min)" : "Execução DESLIGADA ✓");
    } catch (e) {
      setMsg(`erro: ${e instanceof Error ? e.message : "desconhecido"}`);
    } finally {
      setBusy(false);
    }
  };

  const on = enabled === true;
  const trackBg = on ? "var(--green, #4cc08a)" : "var(--border2, #2a3146)";
  return (
    <div style={css(card + `margin-bottom:14px; border-color:${on ? "var(--green, #4cc08a)" : "var(--border)"};`)}>
      <span style={css(kicker)}>Execução · {label}</span>
      <div style={css("display:flex; align-items:center; gap:14px; margin-top:14px;")}>
        <div style={css("flex:1;")}>
          <span style={css("display:block; font:600 14px/1.2 'IBM Plex Sans'; color:var(--text);")}>
            {enabled === null ? "carregando…" : on ? "LIGADA — bot submete transações" : "TRAVADA — só simula e observa"}
          </span>
          <span style={css("display:block; font:500 11px/1.5 'IBM Plex Mono'; color:var(--muted); margin-top:7px;")}>
            Armado-mas-travado · ligar libera o envio (circuit breakers seguem valendo)
          </span>
        </div>
        <button
          onClick={() => apply(!on)}
          disabled={busy || enabled === null}
          aria-pressed={on}
          style={{
            ...css("width:46px; height:26px; border-radius:14px; border:none; cursor:pointer; position:relative; transition:background .15s;"),
            background: trackBg,
            opacity: busy || enabled === null ? 0.5 : 1,
          }}
        >
          <span style={{ ...css("position:absolute; top:3px; width:20px; height:20px; border-radius:50%; background:#fff; transition:left .15s;"), left: on ? "23px" : "3px" }} />
        </button>
      </div>
      {msg && <div style={css(`font:500 11px/1.4 'IBM Plex Mono'; color:${msg.startsWith("erro") ? "var(--red)" : "var(--gold)"}; margin-top:12px;`)}>{msg}</div>}
    </div>
  );
}

function Toggle({ on, trackBg, knobLeft, onClick }: { on: boolean; trackBg: string; knobLeft: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      style={{ ...css("width:42px; height:24px; border-radius:13px; border:none; cursor:pointer; position:relative; transition:background .15s;"), background: trackBg }}
    >
      <span style={{ ...css("position:absolute; top:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:left .15s;"), left: knobLeft }} />
    </button>
  );
}

export function Settings({ vm, ui, actions }: ScreenProps) {
  const { notifRules, channels } = vm;
  const [pushMsg, setPushMsg] = useState<string | null>(null);

  const onChan = async (key: string, on: boolean) => {
    actions.toggleChan(key);
    if (key === "push" && !on) {
      const res = await enablePush();
      setPushMsg(res.ok ? "Push ativado neste dispositivo ✓" : `Push: ${res.error}`);
    }
  };

  return (
    <section>
      <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0;")}>Configurações</h1>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:6px 0 20px;")}>Execução, notificações, canais, tema e conta</p>

      <ExecutionControl motor="motor1" label="Motor 1 (liquidações + pré-liq)" />
      <ExecutionControl motor="motor2" label="Motor 2 (arbitragem + filler UniswapX)" />

      <div className="z-grid-2" style={css("display:grid; grid-template-columns:1fr 1fr; gap:14px;")}>
        <div style={css(card)}>
          <span style={css(kicker)}>Limiares de notificação</span>
          <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
            {notifRules.map((nr) => (
              <div key={nr.key} style={css("display:flex; align-items:center; gap:12px; padding:13px 0; border-bottom:1px solid var(--border);")}>
                <span style={css("font:500 13px/1.3 'IBM Plex Sans'; color:var(--text2); flex:1;")}>{nr.label}</span>
                <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>{nr.value}</span>
                <Toggle on={nr.on} trackBg={nr.trackBg} knobLeft={nr.knobLeft} onClick={() => actions.toggleNotif(nr.key)} />
              </div>
            ))}
          </div>
        </div>

        <div style={css("display:flex; flex-direction:column; gap:14px;")}>
          <div style={css(card)}>
            <span style={css(kicker)}>Canais</span>
            <div style={css("display:flex; flex-direction:column; margin-top:14px;")}>
              {channels.map((ch) => (
                <div key={ch.key} style={css("display:flex; align-items:center; gap:12px; padding:13px 0; border-bottom:1px solid var(--border);")}>
                  <span style={css("font:500 13px/1.3 'IBM Plex Sans'; color:var(--text2); flex:1;")}>{ch.label}</span>
                  <span style={css("font:500 11px/1 'IBM Plex Mono'; color:var(--muted);")}>{ch.sub}</span>
                  <Toggle on={ch.on} trackBg={ch.trackBg} knobLeft={ch.knobLeft} onClick={() => onChan(ch.key, ch.on)} />
                </div>
              ))}
            </div>
            {pushMsg && <div style={css("font:500 11px/1.4 'IBM Plex Mono'; color:var(--gold); margin-top:12px;")}>{pushMsg}</div>}
          </div>

          <div style={css(card)}>
            <span style={css(kicker)}>Tema</span>
            <div style={css("display:flex; gap:10px; margin-top:14px;")}>
              <button
                onClick={() => actions.setTheme("navy")}
                style={css(`flex:1; padding:14px; border-radius:9px; border:1px solid ${ui.theme === "navy" ? "var(--gold)" : "var(--border)"}; background:#0b1020; cursor:pointer; text-align:left;`)}
              >
                <span style={css("display:block; font:600 13px/1 'IBM Plex Sans'; color:#e7ecf6;")}>Navy profundo</span>
                <span style={css("display:flex; gap:5px; margin-top:10px;")}>
                  <span style={css("width:18px;height:9px;border-radius:2px;background:#101728;")} />
                  <span style={css("width:18px;height:9px;border-radius:2px;background:#d6b25e;")} />
                  <span style={css("width:18px;height:9px;border-radius:2px;background:#4cc08a;")} />
                </span>
              </button>
              <button
                onClick={() => actions.setTheme("black")}
                style={css(`flex:1; padding:14px; border-radius:9px; border:1px solid ${ui.theme === "black" ? "var(--gold)" : "var(--border)"}; background:#0d0d10; cursor:pointer; text-align:left;`)}
              >
                <span style={css("display:block; font:600 13px/1 'IBM Plex Sans'; color:#ededee;")}>Preto puro</span>
                <span style={css("display:flex; gap:5px; margin-top:10px;")}>
                  <span style={css("width:18px;height:9px;border-radius:2px;background:#141417;")} />
                  <span style={css("width:18px;height:9px;border-radius:2px;background:#d6b25e;")} />
                  <span style={css("width:18px;height:9px;border-radius:2px;background:#4cc08a;")} />
                </span>
              </button>
            </div>
          </div>

          <div style={css(card + "display:flex; align-items:center; justify-content:space-between;")}>
            <div>
              <span style={css("display:block; font:600 13px/1 'IBM Plex Sans'; color:var(--text);")}>Conta do operador</span>
              <span style={css("display:block; font:500 11px/1.4 'IBM Plex Mono'; color:var(--muted); margin-top:7px;")}>humberto · push 1 dispositivo</span>
            </div>
            <Hover
              as="button"
              onClick={actions.logout}
              base="padding:9px 16px; border-radius:8px; border:1px solid var(--border2); background:transparent; color:var(--red); font:600 12px/1 'IBM Plex Sans'; cursor:pointer;"
              hover="border-color:var(--red);"
            >
              Sair
            </Hover>
          </div>
        </div>
      </div>
    </section>
  );
}
