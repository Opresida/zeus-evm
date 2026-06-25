import { createClient } from "@supabase/supabase-js";
import { getServiceSupabase } from "./supabaseServer";
import type { Profile } from "./authClient";

export interface AuthOk {
  ok: true;
  userId: string;
  email: string | null;
  profile: Profile;
}
export interface AuthErr {
  ok: false;
  status: number;
  error: string;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * Valida a sessão (token Bearer do Supabase) e carrega o perfil. NÃO checa papel — use requireAdmin
 * pra rotas de admin. Fail-closed: sem token/perfil → erro.
 */
export async function requireUser(req: Request): Promise<AuthOk | AuthErr> {
  const token = bearer(req);
  if (!token) return { ok: false, status: 401, error: "sem token de sessão" };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return { ok: false, status: 503, error: "supabase não configurado" };

  // Valida o JWT com o cliente anon (getUser confere a assinatura no servidor do Supabase).
  const anonClient = createClient(url, anon, { auth: { persistSession: false } });
  const { data: u, error } = await anonClient.auth.getUser(token);
  if (error || !u?.user) return { ok: false, status: 401, error: "sessão inválida" };

  // Perfil via service role (papel/status) — fonte de verdade de autorização.
  const svc = getServiceSupabase();
  if (!svc) return { ok: false, status: 503, error: "supabase service não configurado" };
  const { data: prof } = await svc
    .from("profiles")
    .select("id, email, role, status")
    .eq("id", u.user.id)
    .maybeSingle();
  if (!prof) return { ok: false, status: 403, error: "perfil não encontrado" };

  return { ok: true, userId: u.user.id, email: u.user.email ?? null, profile: prof as Profile };
}

/** Exige admin APROVADO. Tudo que arma o bot / mexe em contas passa por aqui (defesa em profundidade). */
export async function requireAdmin(req: Request): Promise<AuthOk | AuthErr> {
  const r = await requireUser(req);
  if (!r.ok) return r;
  if (r.profile.role !== "admin" || r.profile.status !== "approved") {
    return { ok: false, status: 403, error: "acesso restrito ao admin" };
  }
  return r;
}
