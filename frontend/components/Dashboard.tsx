"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { css } from "@/lib/css";
import { Hover } from "@/components/ui";
import { buildViewModel } from "@/lib/viewModel";
import { deriveSnapshot } from "@/lib/live";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import type { EventRow, ServiceStatusRow, UiState, WalletSnapshotRow } from "@/lib/types";
import { MOCK } from "@/lib/mockData";
import type { Actions } from "@/components/screens/shared";
import { Home } from "@/components/screens/Home";
import { Transactions } from "@/components/screens/Transactions";
import { Pnl } from "@/components/screens/Pnl";
import { Wallet } from "@/components/screens/Wallet";
import { Intelligence } from "@/components/screens/Intelligence";
import { Health } from "@/components/screens/Health";
import { Reports } from "@/components/screens/Reports";
import { Settings } from "@/components/screens/Settings";

const NAV: { id: UiState["screen"]; label: string; icon: string }[] = [
  { id: "home", label: "Visão geral", icon: "◉" },
  { id: "tx", label: "Transações", icon: "⇄" },
  { id: "pnl", label: "Lucro & PnL", icon: "↗" },
  { id: "wallet", label: "Carteira & Gás", icon: "◯" },
  { id: "intel", label: "Inteligência", icon: "◈" },
  { id: "health", label: "Saúde", icon: "⊕" },
  { id: "reports", label: "Relatórios", icon: "▤" },
  { id: "settings", label: "Configurações", icon: "⚙" },
];

export default function Dashboard() {
  const [ui, setUi] = useState<UiState>({
    screen: "home",
    theme: "navy",
    txFilter: "all",
    period: "daily",
    query: "",
    tick: 0,
    notif: { ...MOCK.notifDefault },
    chans: { ...MOCK.chanDefault },
  });
  const [rows, setRows] = useState<EventRow[]>([]);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusRow[]>([]);
  const [walletSnaps, setWalletSnaps] = useState<WalletSnapshotRow[]>([]);
  const live = isSupabaseConfigured();
  // Toggle Demo: ON = dados de mock (layout/apresentação); OFF = dados REAIS do Supabase
  // (cards sem dado real ficam vazios — útil pra ver o que ainda não está fiado ao backend).
  const [demoMode, setDemoMode] = useState(true);

  // tema persistido
  useEffect(() => {
    const t = (localStorage.getItem("zeus-theme") as UiState["theme"]) || "navy";
    setUi((s) => ({ ...s, theme: t }));
  }, []);
  useEffect(() => {
    localStorage.setItem("zeus-theme", ui.theme);
  }, [ui.theme]);

  // demo mode persistido
  useEffect(() => {
    const d = localStorage.getItem("zeus-demo");
    if (d != null) setDemoMode(d === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem("zeus-demo", demoMode ? "1" : "0");
  }, [demoMode]);

  // relógio / uptime / ticker
  useEffect(() => {
    const t = setInterval(() => setUi((s) => ({ ...s, tick: s.tick + 1 })), 1000);
    return () => clearInterval(t);
  }, []);

  // Supabase: carga inicial + realtime
  const loadedRef = useRef(false);
  useEffect(() => {
    const sb = getSupabase();
    if (!sb || loadedRef.current) return;
    loadedRef.current = true;
    let active = true;

    sb.from("events")
      .select("*")
      .order("ts", { ascending: false })
      .limit(300)
      .then(({ data }) => {
        if (active && data) setRows(data as EventRow[]);
      });

    // estado ao vivo dos serviços (heartbeat) — tabela separada (não inunda events)
    sb.from("service_status")
      .select("*")
      .then(({ data }) => {
        if (active && data) setServiceStatus(data as ServiceStatusRow[]);
      });

    // Fase 2b — histórico de saldo (snapshot diário) p/ o gráfico 30d
    sb.from("wallet_snapshots")
      .select("*")
      .order("ts", { ascending: false })
      .limit(60)
      .then(({ data }) => {
        if (active && data) setWalletSnaps(data as WalletSnapshotRow[]);
      });

    const ch = sb
      .channel("events-stream")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, (payload) => {
        setRows((prev) => [payload.new as EventRow, ...prev].slice(0, 400));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "service_status" }, (payload) => {
        const row = payload.new as ServiceStatusRow;
        if (!row?.service) return;
        setServiceStatus((prev) => [row, ...prev.filter((s) => s.service !== row.service)]);
      })
      .subscribe();

    return () => {
      active = false;
      sb.removeChannel(ch);
    };
  }, []);

  const snapshot = useMemo(
    () => (live ? deriveSnapshot(rows, serviceStatus, walletSnaps) : null),
    [live, rows, serviceStatus, walletSnaps],
  );
  const vm = useMemo(() => buildViewModel(ui, demoMode ? null : snapshot), [ui, snapshot, demoMode]);

  const actions: Actions = useMemo(
    () => ({
      setScreen: (screen) => setUi((s) => ({ ...s, screen })),
      setTheme: (theme) => setUi((s) => ({ ...s, theme })),
      setFilter: (txFilter) => setUi((s) => ({ ...s, txFilter })),
      setPeriod: (period) => setUi((s) => ({ ...s, period })),
      setQuery: (query) => setUi((s) => ({ ...s, query })),
      toggleNotif: (key) => setUi((s) => ({ ...s, notif: { ...s.notif, [key]: !s.notif[key] } })),
      toggleChan: (key) => setUi((s) => ({ ...s, chans: { ...s.chans, [key]: !s.chans[key] } })),
      logout: () => {
        getSupabase()?.auth.signOut();
      },
    }),
    [],
  );

  const screenProps = { vm, ui, actions };
  const glowShadow = "0 0 14px -2px rgba(214,178,94,.35)";

  return (
    <div
      data-theme={ui.theme}
      style={css(
        "display:flex; flex-direction:column; min-height:100vh; background:var(--bg); color:var(--text); font-family:'IBM Plex Sans',system-ui,sans-serif; -webkit-font-smoothing:antialiased;",
      )}
    >
      {/* ===== TOPBAR ===== */}
      <header
        className="z-topbar"
        style={css(
          "display:flex; align-items:center; gap:18px; padding:0 22px; height:60px; border-bottom:1px solid var(--border); background:var(--bg2); position:sticky; top:0; z-index:20;",
        )}
      >
        <div style={css("display:flex; align-items:center; gap:11px;")}>
          <div
            style={{
              ...css(
                "width:30px; height:30px; border-radius:8px; background:linear-gradient(150deg,var(--panel2),var(--panel)); border:1px solid var(--border2); display:flex; align-items:center; justify-content:center;",
              ),
              boxShadow: glowShadow,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="var(--gold)">
              <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
            </svg>
          </div>
          <div style={css("display:flex; flex-direction:column; gap:4px; white-space:nowrap;")}>
            <span style={css("font:700 14px/1 'IBM Plex Sans'; letter-spacing:.13em;")}>
              ZEUS<span style={{ color: "var(--gold)" }}> COMMAND</span>
            </span>
            <span style={css("font:500 9px/1 'IBM Plex Mono'; letter-spacing:.16em; color:var(--muted);")}>CONTROL PANEL</span>
          </div>
        </div>

        <div className="z-topspacer" style={{ flex: 1 }} />

        <div
          style={css(
            "display:flex; align-items:center; gap:9px; padding:6px 12px; border:1px solid var(--border2); border-radius:8px; background:var(--panel);",
          )}
        >
          <span style={css("width:7px; height:7px; border-radius:50%; background:var(--green); animation:zpulse 2.2s ease-in-out infinite;")} />
          <span style={css("font:600 11px/1 'IBM Plex Mono'; letter-spacing:.06em; color:var(--text);")}>{vm.botStatus}</span>
        </div>

        <div className="z-topmeta" style={css("display:flex; align-items:center; gap:7px; padding:6px 12px; border:1px solid var(--border); border-radius:8px;")}>
          <span style={css("font:600 10px/1 'IBM Plex Mono'; letter-spacing:.1em; color:var(--gold);")}>MAINNET</span>
          <span style={css("width:1px; height:11px; background:var(--border2);")} />
          <span style={css("font:600 10px/1 'IBM Plex Mono'; letter-spacing:.1em; color:var(--text2);")}>BASE</span>
        </div>

        <div className="z-topmeta" style={css("display:flex; align-items:center; gap:8px; padding:6px 12px; border:1px solid var(--border); border-radius:8px;")}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2">
            <rect x="3" y="6" width="14" height="11" rx="2" />
            <path d="M17 10h2a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1h-3" />
          </svg>
          <span style={css("font:600 11px/1 'IBM Plex Mono'; color:var(--text);")}>{vm.runwayDays}d</span>
          <span style={css("font:500 10px/1 'IBM Plex Mono'; color:var(--muted);")}>runway</span>
        </div>

        <Hover
          as="button"
          onClick={() => setDemoMode((d) => !d)}
          base={`display:flex; align-items:center; gap:7px; padding:7px 11px; border-radius:8px; cursor:pointer; border:1px solid ${demoMode ? "var(--gold)" : "var(--border2)"}; background:${demoMode ? "var(--goldsoft)" : "var(--panel)"};`}
          hover="border-color:var(--gold);"
          title={demoMode ? "Modo DEMO (dados de mock). Clique pra mostrar dados REAIS." : "Modo AO VIVO (dados reais). Clique pra voltar ao DEMO."}
        >
          <span style={{ ...css("width:7px; height:7px; border-radius:50%; flex:none;"), background: demoMode ? "var(--gold)" : "var(--green)" }} />
          <span style={{ ...css("font:600 10px/1 'IBM Plex Mono'; letter-spacing:.12em;"), color: demoMode ? "var(--gold)" : "var(--text2)" }}>
            {demoMode ? "DEMO" : "LIVE"}
          </span>
        </Hover>

        <Hover
          as="button"
          onClick={() => actions.setTheme(ui.theme === "navy" ? "black" : "navy")}
          base="width:34px; height:34px; border-radius:8px; border:1px solid var(--border2); background:var(--panel); color:var(--text2); cursor:pointer; display:flex; align-items:center; justify-content:center;"
          hover="border-color:var(--gold); color:var(--gold);"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
          </svg>
        </Hover>
      </header>

      {/* ===== BODY ===== */}
      <div style={css("display:flex; flex:1; min-height:0;")}>
        {/* SIDEBAR */}
        <nav
          className="z-sidebar"
          style={css(
            "width:230px; flex:none; border-right:1px solid var(--border); background:var(--bg2); padding:16px 12px; display:flex; flex-direction:column; gap:3px; position:sticky; top:60px; height:calc(100vh - 60px); overflow-y:auto;",
          )}
        >
          {NAV.map((n) => {
            const activeSel = ui.screen === n.id;
            return (
              <Hover
                key={n.id}
                as="button"
                onClick={() => actions.setScreen(n.id)}
                base={`display:flex; align-items:center; gap:12px; padding:11px 12px; border:none; border-radius:8px; cursor:pointer; text-align:left; font:600 13px/1 'IBM Plex Sans'; background:${
                  activeSel ? "var(--panel2)" : "transparent"
                }; color:${activeSel ? "var(--text)" : "var(--muted)"}; position:relative;`}
                hover="background:var(--panel);"
              >
                <span
                  style={{
                    ...css("position:absolute; left:0; top:9px; bottom:9px; width:3px; border-radius:3px; background:var(--gold);"),
                    opacity: activeSel ? 1 : 0,
                  }}
                />
                <span style={css("display:flex; width:18px; justify-content:center; font-size:15px;")}>{n.icon}</span>
                <span className="z-navlabel">{n.label}</span>
              </Hover>
            );
          })}
          <div style={{ flex: 1 }} />
          <div
            className="z-navfoot"
            style={css("padding:12px; border-top:1px solid var(--border); margin-top:8px; display:flex; flex-direction:column; gap:4px;")}
          >
            <span style={css("font:500 9.5px/1.4 'IBM Plex Mono'; letter-spacing:.1em; color:var(--muted);")}>UPTIME</span>
            <span style={css("font:600 13px/1 'IBM Plex Mono'; color:var(--text2);")}>{vm.uptime}</span>
          </div>
        </nav>

        {/* MAIN */}
        <main className="z-main" style={css("flex:1; min-width:0; padding:26px 30px 60px; background:var(--bg);")}>
          <div className="zscreen" key={ui.screen}>
            {ui.screen === "home" && <Home {...screenProps} />}
            {ui.screen === "tx" && <Transactions {...screenProps} />}
            {ui.screen === "pnl" && <Pnl {...screenProps} />}
            {ui.screen === "wallet" && <Wallet {...screenProps} />}
            {ui.screen === "intel" && <Intelligence {...screenProps} />}
            {ui.screen === "health" && <Health {...screenProps} />}
            {ui.screen === "reports" && <Reports {...screenProps} />}
            {ui.screen === "settings" && <Settings {...screenProps} />}
          </div>
        </main>
      </div>
    </div>
  );
}
