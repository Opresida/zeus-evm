"use client";
import { useState } from "react";
import { css } from "@/lib/css";
import { signIn } from "@/lib/authClient";
import { AuthShell, authInputStyle, authButtonStyle } from "./AuthShell";

/** Tela de login (Supabase Auth). onDone → o AuthGate re-checa a sessão via onAuthChange. */
export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await signIn(email, password);
    if (error) {
      setErr(error === "Invalid login credentials" ? "E-mail ou senha incorretos." : error);
      setBusy(false);
    }
    // sucesso: onAuthStateChange no AuthGate cuida da transição (não precisa setBusy false).
  };

  return (
    <AuthShell title="Acesso ao painel" subtitle="Entre com sua conta para acessar o ZEUS Command.">
      <form onSubmit={submit} style={css("display:flex; flex-direction:column; gap:11px;")}>
        <input
          type="email"
          placeholder="E-mail"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          style={authInputStyle()}
        />
        <input
          type="password"
          placeholder="Senha"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          style={authInputStyle()}
        />
        {err && <span style={css("font:500 11.5px/1.4 'IBM Plex Sans'; color:var(--red);")}>{err}</span>}
        <button type="submit" disabled={busy || !email || !password} style={authButtonStyle(busy || !email || !password)}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>
      <span style={css("font:400 11px/1.5 'IBM Plex Sans'; color:var(--muted); text-align:center; margin-top:4px;")}>
        Acesso restrito · contas criadas por indicação e aprovadas pelo administrador.
      </span>
    </AuthShell>
  );
}
