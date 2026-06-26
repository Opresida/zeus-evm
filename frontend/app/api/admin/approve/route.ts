import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabaseServer";
import { requireAdmin } from "@/lib/authServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ADMIN lista pendentes (GET) e aprova/rejeita (POST { id, action: 'approve'|'reject' }). */
export async function GET(req: Request) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return NextResponse.json({ error: adm.error }, { status: adm.status });
  const svc = getServiceSupabase();
  if (!svc) return NextResponse.json({ error: "supabase não configurado" }, { status: 503 });

  const { data, error } = await svc
    .from("profiles")
    .select("id, email, role, status, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, pending: data ?? [] });
}

export async function POST(req: Request) {
  const adm = await requireAdmin(req);
  if (!adm.ok) return NextResponse.json({ error: adm.error }, { status: adm.status });

  let body: { id?: string; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  const action = body.action;
  if (!id) return NextResponse.json({ error: "id obrigatório" }, { status: 400 });
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "action deve ser approve|reject" }, { status: 400 });
  }

  const svc = getServiceSupabase();
  if (!svc) return NextResponse.json({ error: "supabase não configurado" }, { status: 503 });

  const status = action === "approve" ? "approved" : "rejected";
  const { data, error } = await svc
    .from("profiles")
    .update({ status, approved_at: new Date().toISOString(), approved_by: adm.userId })
    .eq("id", id)
    .select("id, email, role, status")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, profile: data });
}
