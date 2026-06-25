"use client";
import { useEffect, useState } from "react";
import { css } from "@/lib/css";
import { isSupabaseConfigured } from "@/lib/supabaseClient";
import { loadAuthState, onAuthChange, type AuthState } from "@/lib/authClient";
import { Login } from "@/components/auth/Login";
import { Pending } from "@/components/auth/Pending";
import Dashboard from "@/components/Dashboard";
import ZeusLoader from "@/components/ZeusLoader";

/** Tempo MÍNIMO de splash na entrada do app (ms) — o spinner aparece por pelo menos isso. */
const MIN_SPLASH_MS = 4000;

function Splash() {
  return (
    <div
      data-theme="navy"
      style={css("min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg);")}
    >
      <ZeusLoader size={96} />
    </div>
  );
}

/**
 * Portão de autenticação do painel. Em produção (Supabase configurado) o login é OBRIGATÓRIO e só
 * conta APROVADA acessa. Sem Supabase (dev/demo) o painel abre direto com os dados de apresentação.
 *
 * Splash de entrada: o ZeusLoader fica visível por NO MÍNIMO MIN_SPLASH_MS, em paralelo com a
 * checagem de sessão (não soma atraso) — só sai quando os 4s passaram E o auth terminou de carregar.
 */
export default function AuthGate() {
  const configured = isSupabaseConfigured();
  const [state, setState] = useState<AuthState | null>(null);
  const [authLoading, setAuthLoading] = useState(configured); // demo: nada pra carregar
  const [minElapsed, setMinElapsed] = useState(false);

  // tempo mínimo de splash na entrada
  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), MIN_SPLASH_MS);
    return () => clearTimeout(t);
  }, []);

  // checagem de sessão (só quando há Supabase) — roda em paralelo ao splash
  useEffect(() => {
    if (!configured) return;
    let active = true;
    const refresh = () =>
      loadAuthState().then((s) => {
        if (!active) return;
        setState(s);
        setAuthLoading(false);
      });
    void refresh();
    const unsub = onAuthChange(() => void refresh());
    return () => {
      active = false;
      unsub();
    };
  }, [configured]);

  // splash até passar o tempo mínimo E o auth terminar
  if (!minElapsed || authLoading) return <Splash />;

  if (!configured) return <Dashboard />;
  if (!state) return <Login />;
  const status = state.profile?.status;
  if (status === "approved") return <Dashboard profile={state.profile} />;
  return <Pending rejected={status === "rejected"} />;
}
