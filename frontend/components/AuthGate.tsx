"use client";
import { useEffect, useState } from "react";
import { css } from "@/lib/css";
import { isSupabaseConfigured } from "@/lib/supabaseClient";
import { loadAuthState, onAuthChange, type AuthState } from "@/lib/authClient";
import { Login } from "@/components/auth/Login";
import { Pending } from "@/components/auth/Pending";
import Dashboard from "@/components/Dashboard";
import ZeusLoader from "@/components/ZeusLoader";

/** Tempo MÍNIMO de splash na entrada (ms) e duração do crossfade splash → conteúdo (ms). */
const MIN_SPLASH_MS = 4000;
const FADE_MS = 500;

function Splash({ fading }: { fading: boolean }) {
  return (
    <div
      data-theme="navy"
      style={{
        ...css("position:fixed; inset:0; z-index:50; display:flex; align-items:center; justify-content:center; background:var(--bg);"),
        opacity: fading ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: fading ? "none" : "auto",
      }}
    >
      <ZeusLoader size={96} />
    </div>
  );
}

/**
 * Portão de autenticação do painel. Em produção (Supabase configurado) o login é OBRIGATÓRIO e só
 * conta APROVADA acessa. Sem Supabase (dev/demo) o painel abre direto.
 *
 * Entrada: o ZeusLoader fica visível por NO MÍNIMO MIN_SPLASH_MS, em paralelo com a checagem de
 * sessão (não soma atraso). Quando pronto, faz um CROSSFADE suave: o splash (camada por cima) some
 * em fade-out enquanto o conteúdo (login/painel) aparece em fade-in por baixo.
 */
export default function AuthGate() {
  const configured = isSupabaseConfigured();
  const [state, setState] = useState<AuthState | null>(null);
  const [authLoading, setAuthLoading] = useState(configured); // demo: nada pra carregar
  const [minElapsed, setMinElapsed] = useState(false);
  const [splashFading, setSplashFading] = useState(false);
  const [splashGone, setSplashGone] = useState(false);

  // tempo mínimo de splash
  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), MIN_SPLASH_MS);
    return () => clearTimeout(t);
  }, []);

  // checagem de sessão (só com Supabase) — em paralelo ao splash
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

  const ready = minElapsed && !authLoading;

  // quando pronto: dispara o fade-out do splash e desmonta após a transição
  useEffect(() => {
    if (!ready || splashGone) return;
    setSplashFading(true);
    const t = setTimeout(() => setSplashGone(true), FADE_MS);
    return () => clearTimeout(t);
  }, [ready, splashGone]);

  // conteúdo resolvido (só quando pronto)
  const content = (() => {
    if (!ready) return null;
    if (!configured) return <Dashboard />;
    if (!state) return <Login />;
    const status = state.profile?.status;
    if (status === "approved") return <Dashboard profile={state.profile} />;
    return <Pending rejected={status === "rejected"} />;
  })();

  return (
    <>
      {content && <div style={{ animation: `zfadein ${FADE_MS}ms ease both` }}>{content}</div>}
      {!splashGone && <Splash fading={splashFading} />}
    </>
  );
}
