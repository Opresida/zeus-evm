"use client";
import { useEffect, useState } from "react";
import { css } from "@/lib/css";
import { isSupabaseConfigured } from "@/lib/supabaseClient";
import { loadAuthState, onAuthChange, type AuthState } from "@/lib/authClient";
import { Login } from "@/components/auth/Login";
import { Pending } from "@/components/auth/Pending";
import Dashboard from "@/components/Dashboard";
import ZeusLoader from "@/components/ZeusLoader";

/**
 * Portão de autenticação do painel. Em produção (Supabase configurado) o login é OBRIGATÓRIO e só
 * conta APROVADA acessa. Sem Supabase (dev/demo) o painel abre direto com os dados de apresentação
 * — preserva a experiência de design local.
 */
export default function AuthGate() {
  // Sem Supabase → modo demo, sem login (igual antes).
  if (!isSupabaseConfigured()) return <Dashboard />;
  return <Gated />;
}

function Gated() {
  const [state, setState] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const refresh = () =>
      loadAuthState().then((s) => {
        if (!active) return;
        setState(s);
        setLoading(false);
      });
    void refresh();
    const unsub = onAuthChange(() => void refresh());
    return () => {
      active = false;
      unsub();
    };
  }, []);

  if (loading) {
    return (
      <div
        data-theme="navy"
        style={css("min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg);")}
      >
        <ZeusLoader size={84} />
      </div>
    );
  }

  if (!state) return <Login />;
  const status = state.profile?.status;
  if (status === "approved") return <Dashboard profile={state.profile} />;
  return <Pending rejected={status === "rejected"} />;
}
