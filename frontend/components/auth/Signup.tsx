"use client";
import { useState } from "react";
import { css } from "@/lib/css";
import { AuthShell, authInputStyle, authButtonStyle } from "./AuthShell";

/** Cadastro por link de indicação: /signup?invite=<token>. Cria conta PENDENTE (admin aprova). */
export function Signup({ invite }: { invite: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!invite) {
    return (
      <AuthShell title="Convite necessário" subtitle="O cadastro só é possível por um link de indicação válido.">
        <a href="/" style={{ ...authButtonStyle(false), textDecoration: "none", textAlign: "center" as const }}>
          Ir para o login
        </a>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Conta criada ✓" subtitle="Sua conta foi criada e está aguardando a aprovação do administrador.">
        <div style={css("font:600 30px/1 'IBM Plex Sans'; text-align:center; margin:4px 0;")}>⏳</div>
        <a href="/" style={{ ...authButtonStyle(false), textDecoration: "none", textAlign: "center" as const }}>
          Ir para o login
        </a>
      </AuthShell>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite, email, password }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? "falha no cadastro");
      setDone(true);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "erro desconhecido");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Criar conta" subtitle="Você foi indicado para o ZEUS Command. Crie sua conta abaixo.">
      <form onSubmit={submit} style={css("display:flex; flex-direction:column; gap:11px;")}>
        <input type="email" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" style={authInputStyle()} />
        <input type="password" placeholder="Senha (mín. 8 caracteres)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" style={authInputStyle()} />
        {err && <span style={css("font:500 11.5px/1.4 'IBM Plex Sans'; color:var(--red);")}>{err}</span>}
        <button type="submit" disabled={busy || !email || password.length < 8} style={authButtonStyle(busy || !email || password.length < 8)}>
          {busy ? "Criando…" : "Criar conta"}
        </button>
      </form>
      <span style={css("font:400 11px/1.5 'IBM Plex Sans'; color:var(--muted); text-align:center; margin-top:4px;")}>
        Após criada, sua conta passa por aprovação do administrador antes de liberar o acesso.
      </span>
    </AuthShell>
  );
}
