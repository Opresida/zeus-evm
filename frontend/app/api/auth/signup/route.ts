import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabaseServer";
import { validateInvite, validateCredentials } from "@/lib/invite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cadastro por LINK DE INDICAÇÃO. Sem token de convite válido → bloqueia. Cria a conta JÁ confirmada
 * (sem e-mail de verificação) porém com `status='pending'`: o gate real é a APROVAÇÃO do admin.
 * Body: { invite, email, password }.
 */
export async function POST(req: Request) {
  let body: { invite?: string; email?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const invite = (body.invite ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!invite) return NextResponse.json({ error: "convite obrigatório" }, { status: 400 });

  const cred = validateCredentials(email, password);
  if (!cred.ok) return NextResponse.json({ error: cred.reason }, { status: 400 });

  const svc = getServiceSupabase();
  if (!svc) return NextResponse.json({ error: "supabase não configurado" }, { status: 503 });

  // 1) Valida o convite.
  const { data: inv } = await svc
    .from("invites")
    .select("token, used_at, expires_at, created_by")
    .eq("token", invite)
    .maybeSingle();
  const check = validateInvite(inv as never, Date.now());
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 403 });

  // 2) Cria o usuário JÁ confirmado (sem e-mail de verificação).
  const { data: created, error: cErr } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (cErr || !created?.user) {
    return NextResponse.json({ error: cErr?.message ?? "falha ao criar usuário" }, { status: 400 });
  }
  const uid = created.user.id;

  // 3) Perfil pendente (papel membro) + marca o convite usado.
  await svc.from("profiles").upsert({
    id: uid,
    email,
    role: "member",
    status: "pending",
    invited_by: (inv as { created_by?: string })?.created_by ?? null,
  });
  await svc.from("invites").update({ used_by: uid, used_at: new Date().toISOString() }).eq("token", invite);

  return NextResponse.json({ ok: true, status: "pending" });
}
