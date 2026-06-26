import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabaseServer";
import { requireAdmin } from "@/lib/authServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Control-plane painel → bot. Liga/desliga a EXECUÇÃO de um motor escrevendo na tabela
 * `engine_control` (o bot faz poll dela). Modelo armado-mas-travado: ligar aqui só LIBERA o envio;
 * os circuit breakers do bot (MAX_TRADE_ETH, min profit, simulação+EV gate) seguem valendo.
 *
 * Auth: ADMIN-ONLY (defesa em profundidade). Aceita (a) sessão Supabase de admin aprovado via header
 * `Authorization: Bearer <token>` — o caminho do painel; ou (b) o header `x-zeus-control` ==
 * `ZEUS_CONTROL_SECRET` como OVERRIDE de máquina (curl/automação), só se o segredo estiver setado.
 * Sem nenhum dos dois → 401/403. O painel inteiro já fica atrás do login (Supabase Auth).
 */

const MOTORS = new Set(["motor1", "motor2", "motor3"]);
const MODES = new Set(["dryrun", "testnet", "mainnet"]);

/** true + (email do admin, quando houver) se autorizado. Admin-session OU header de máquina. */
async function authorize(req: Request): Promise<{ ok: true; who: string } | { ok: false; status: number; error: string }> {
  const secret = process.env.ZEUS_CONTROL_SECRET;
  if (secret && req.headers.get("x-zeus-control") === secret) return { ok: true, who: "machine" };
  const adm = await requireAdmin(req);
  if (adm.ok) return { ok: true, who: adm.email ?? "admin" };
  return { ok: false, status: adm.status, error: adm.error };
}

/** GET — estado desejado atual (pra UI mostrar o que foi pedido). Admin-only. */
export async function GET(req: Request) {
  const auth = await authorize(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const sb = getServiceSupabase();
  if (!sb) return NextResponse.json({ error: "supabase not configured" }, { status: 503 });

  const { searchParams } = new URL(req.url);
  const motor = searchParams.get("motor");
  let q = sb.from("engine_control").select("motor, execution_enabled, desired_mode, updated_at, updated_by");
  if (motor) q = q.eq("motor", motor);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, control: data ?? [] });
}

/** POST — liga/desliga a execução de um motor. Body: { motor, execution_enabled, desired_mode? }. Admin-only. */
export async function POST(req: Request) {
  const auth = await authorize(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { motor?: string; execution_enabled?: boolean; desired_mode?: string; updated_by?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const motor = body.motor ?? "motor2";
  if (!MOTORS.has(motor)) return NextResponse.json({ error: `motor inválido: ${motor}` }, { status: 400 });
  if (typeof body.execution_enabled !== "boolean") {
    return NextResponse.json({ error: "execution_enabled (boolean) obrigatório" }, { status: 400 });
  }
  if (body.desired_mode && !MODES.has(body.desired_mode)) {
    return NextResponse.json({ error: `desired_mode inválido: ${body.desired_mode}` }, { status: 400 });
  }

  const sb = getServiceSupabase();
  if (!sb) return NextResponse.json({ error: "supabase not configured" }, { status: 503 });

  const row: Record<string, unknown> = {
    motor,
    execution_enabled: body.execution_enabled,
    updated_at: new Date().toISOString(),
    updated_by: body.updated_by ?? auth.who,
  };
  if (body.desired_mode) row.desired_mode = body.desired_mode;

  const { data, error } = await sb
    .from("engine_control")
    .upsert(row, { onConflict: "motor" })
    .select("motor, execution_enabled, desired_mode, updated_at, updated_by")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, control: data });
}
