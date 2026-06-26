/** Validação PURA de convite (testável, sem I/O). Usada pela rota /api/auth/signup. */

export interface InviteRow {
  token: string;
  used_at: string | null;
  expires_at: string;
}

export type InviteCheck = { ok: true } | { ok: false; reason: string };

/** Convite só vale se existe, não foi usado e não expirou. `nowMs` injetado pra teste determinístico. */
export function validateInvite(invite: InviteRow | null | undefined, nowMs: number): InviteCheck {
  if (!invite) return { ok: false, reason: "convite inválido" };
  if (invite.used_at) return { ok: false, reason: "convite já utilizado" };
  const exp = Date.parse(invite.expires_at);
  if (!Number.isFinite(exp) || exp <= nowMs) return { ok: false, reason: "convite expirado" };
  return { ok: true };
}

/** Validação simples de e-mail/senha de cadastro (regra mínima). */
export function validateCredentials(email: string, password: string): InviteCheck {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return { ok: false, reason: "e-mail inválido" };
  if (password.length < 8) return { ok: false, reason: "senha precisa de ao menos 8 caracteres" };
  return { ok: true };
}
