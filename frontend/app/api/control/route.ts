import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Control-plane painel → bot. Liga/desliga a EXECUÇÃO de um motor escrevendo na tabela
 * `engine_control` (o bot faz poll dela). Modelo armado-mas-travado: ligar aqui só LIBERA o envio;
 * os circuit breakers do bot (MAX_TRADE_ETH, min profit, simulação+EV gate) seguem valendo.
 *
 * Auth: setar `ZEUS_CONTROL_SECRET` → exige header `x-zeus-control` batendo. FAIL-CLOSED em
 * produção: sem o segredo, o POST (que LIGA/DESLIGA execução) é recusado (503) — nunca fica aberto
 * em prod. Em dev libera (painel privado-por-URL). O GET (read-only) segue a mesma regra do segredo
 * mas não trava em prod. Melhor ainda: pôr o painel inteiro atrás de auth (Vercel password /
 * Supabase Auth) em vez de expor o segredo no browser.
 */

const MOTORS = new Set(["motor1", "motor2", "motor3"]);
const MODES = new Set(["dryrun", "testnet", "mainnet"]);

function checkAuth(req: Request): boolean {
  const secret = process.env.ZEUS_CONTROL_SECRET;
  if (!secret) return true; // sem segredo → libera (painel privado-por-URL em dev).
  return req.headers.get("x-zeus-control") === secret;
}

/** FAIL-CLOSED: a rota de mutação NUNCA fica aberta em produção sem `ZEUS_CONTROL_SECRET`. */
function writeBlockedInProd(): NextResponse | null {
  if (process.env.NODE_ENV === "production" && !process.env.ZEUS_CONTROL_SECRET) {
    return NextResponse.json(
      { error: "ZEUS_CONTROL_SECRET não configurado — rota de controle travada em produção (fail-closed)" },
      { status: 503 },
    );
  }
  return null;
}

/** GET — estado desejado atual (pra UI mostrar o que foi pedido). */
export async function GET(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

/** POST — liga/desliga a execução de um motor. Body: { motor, execution_enabled, desired_mode? }. */
export async function POST(req: Request) {
  const blocked = writeBlockedInProd();
  if (blocked) return blocked;
  if (!checkAuth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
    updated_by: body.updated_by ?? "panel",
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
