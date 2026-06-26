"use client";
import { useEffect, useState, useCallback } from "react";
import { css } from "@/lib/css";
import { getAccessToken } from "@/lib/authClient";

const card = "background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:18px 20px;";
const kicker = "font:600 10.5px/1.2 'IBM Plex Mono'; letter-spacing:.08em; text-transform:uppercase; color:var(--muted);";
const btn = (primary = false) =>
  `padding:9px 14px; border-radius:8px; border:1px solid ${primary ? "var(--gold)" : "var(--border2)"}; background:${primary ? "var(--goldsoft)" : "var(--panel2)"}; color:${primary ? "var(--gold)" : "var(--text2)"}; font:600 12px/1 'IBM Plex Sans'; cursor:pointer;`;

interface Pending {
  id: string;
  email: string | null;
  created_at: string;
}

async function authedFetch(url: string, init?: RequestInit) {
  const token = await getAccessToken();
  return fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
}

/** Tela ADMIN — gerar link de indicação + aprovar/rejeitar contas pendentes. */
export function Admin() {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/admin/approve");
      const j = await res.json();
      if (res.ok) setPending(j.pending ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const generate = async () => {
    setGenBusy(true);
    setCopied(false);
    setMsg(null);
    try {
      const res = await authedFetch("/api/admin/invite", { method: "POST", body: JSON.stringify({}) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? "falha");
      setInviteUrl(j.url);
    } catch (e) {
      setMsg(`erro: ${e instanceof Error ? e.message : "desconhecido"}`);
    } finally {
      setGenBusy(false);
    }
  };

  const act = async (id: string, action: "approve" | "reject") => {
    setMsg(null);
    try {
      const res = await authedFetch("/api/admin/approve", { method: "POST", body: JSON.stringify({ id, action }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? "falha");
      setPending((p) => p.filter((x) => x.id !== id));
      setMsg(action === "approve" ? "Conta aprovada ✓" : "Conta rejeitada");
    } catch (e) {
      setMsg(`erro: ${e instanceof Error ? e.message : "desconhecido"}`);
    }
  };

  const copy = () => {
    if (!inviteUrl) return;
    void navigator.clipboard?.writeText(inviteUrl);
    setCopied(true);
  };

  return (
    <section>
      <h1 style={css("font:700 22px/1.1 'IBM Plex Sans'; margin:0 0 6px; letter-spacing:-.01em;")}>Admin</h1>
      <p style={css("font:400 13px/1.4 'IBM Plex Sans'; color:var(--muted); margin:0 0 22px;")}>
        Gerar links de indicação e aprovar novas contas · acesso exclusivo do administrador
      </p>

      {/* Gerar indicação */}
      <div style={css(card + "margin-bottom:16px;")}>
        <span style={css(kicker)}>Link de indicação</span>
        <p style={css("font:400 12.5px/1.5 'IBM Plex Sans'; color:var(--muted); margin:10px 0 14px;")}>
          Gere um link único (validade 7 dias) para convidar uma nova pessoa. A conta criada entra como
          <b style={css("color:var(--text2);")}> pendente</b> até você aprovar abaixo.
        </p>
        <button onClick={generate} disabled={genBusy} style={css(btn(true))}>
          {genBusy ? "Gerando…" : "Gerar link de indicação"}
        </button>
        {inviteUrl && (
          <div style={css("display:flex; align-items:center; gap:10px; margin-top:14px; padding:11px 13px; background:var(--bg2); border:1px solid var(--border2); border-radius:9px;")}>
            <span style={css("flex:1; font:500 11.5px/1.4 'IBM Plex Mono'; color:var(--text2); word-break:break-all;")}>{inviteUrl}</span>
            <button onClick={copy} style={css(btn(false))}>{copied ? "Copiado ✓" : "Copiar"}</button>
          </div>
        )}
      </div>

      {/* Aprovações pendentes */}
      <div style={css(card)}>
        <span style={css(kicker)}>Aprovações pendentes</span>
        {loading ? (
          <p style={css("font:400 12.5px/1.5 'IBM Plex Sans'; color:var(--muted); margin-top:12px;")}>Carregando…</p>
        ) : pending.length === 0 ? (
          <p style={css("font:400 12.5px/1.5 'IBM Plex Sans'; color:var(--muted); margin-top:12px;")}>Nenhuma conta aguardando aprovação.</p>
        ) : (
          <div style={css("display:flex; flex-direction:column; gap:10px; margin-top:14px;")}>
            {pending.map((p) => (
              <div key={p.id} style={css("display:flex; align-items:center; gap:12px; padding:11px 13px; background:var(--bg2); border:1px solid var(--border2); border-radius:9px;")}>
                <span style={css("flex:1; font:600 12.5px/1.2 'IBM Plex Sans'; color:var(--text);")}>{p.email ?? p.id}</span>
                <button onClick={() => void act(p.id, "approve")} style={css(btn(true))}>Aprovar</button>
                <button onClick={() => void act(p.id, "reject")} style={css(btn(false))}>Rejeitar</button>
              </div>
            ))}
          </div>
        )}
        {msg && <p style={css("font:500 11.5px/1.4 'IBM Plex Sans'; color:var(--text2); margin-top:12px;")}>{msg}</p>}
      </div>
    </section>
  );
}
