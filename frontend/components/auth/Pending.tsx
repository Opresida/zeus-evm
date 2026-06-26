"use client";
import { css } from "@/lib/css";
import { signOut } from "@/lib/authClient";
import { AuthShell, authButtonStyle } from "./AuthShell";

/** Conta criada/logada mas ainda não aprovada (ou rejeitada) pelo admin. */
export function Pending({ rejected = false }: { rejected?: boolean }) {
  return (
    <AuthShell
      title={rejected ? "Acesso não liberado" : "Aguardando aprovação"}
      subtitle={
        rejected
          ? "Sua conta não foi aprovada para acessar o painel."
          : "Sua conta foi criada e está aguardando a aprovação do administrador. Você será liberado assim que ela for revisada."
      }
    >
      <div style={css("font:600 30px/1 'IBM Plex Sans'; text-align:center; margin:4px 0;")}>{rejected ? "🚫" : "⏳"}</div>
      <button onClick={() => void signOut()} style={authButtonStyle(false)}>
        Sair
      </button>
    </AuthShell>
  );
}
