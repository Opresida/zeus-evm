import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabaseServer";
import { requireAdmin } from "@/lib/authServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TTL_DAYS = 7;

/** ADMIN gera um link de indicação. Body: { note?, ttlDays? }. Retorna o token + a URL de cadastro. */
export async function POST(req: Request) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return NextResponse.json({ error: adm.error }, { status: adm.status });

  let body: { note?: string; ttlDays?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* body opcional */
  }
  const svc = getServiceSupabase();
  if (!svc) return NextResponse.json({ error: "supabase não configurado" }, { status: 503 });

  const token = randomBytes(24).toString("base64url");
  const ttlDays = Number.isFinite(body.ttlDays) && (body.ttlDays as number) > 0 ? (body.ttlDays as number) : DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await svc.from("invites").insert({
    token,
    created_by: adm.userId,
    note: body.note ?? null,
    expires_at: expiresAt,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const origin = new URL(req.url).origin;
  return NextResponse.json({ ok: true, token, url: `${origin}/signup?invite=${token}`, expiresAt });
}
