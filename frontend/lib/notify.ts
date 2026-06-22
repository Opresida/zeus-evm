import webpush from "web-push";
import { Resend } from "resend";
import { getServiceSupabase } from "./supabaseServer";
import type { ZeusEvent } from "./types";

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return true;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", pub, priv);
  vapidReady = true;
  return true;
}

/** Define se o evento merece notificação proativa. */
export function isAlertable(e: ZeusEvent): boolean {
  const sev = e.severity;
  if (sev === "critical" || sev === "warn") return true;
  const t = String(e.type);
  if (t === "pnl.kill_switch_triggered" || t === "gas.alert" || t === "failure.cooldown_activated") return true;
  // tx confirmada de valor alto
  if (t === "tx.confirmed" && (e.netProfitUsd ?? 0) >= 500) return true;
  return false;
}

function titleFor(e: ZeusEvent): { title: string; body: string } {
  const t = String(e.type);
  if (t === "pnl.kill_switch_triggered") return { title: "🛑 ZEUS · Kill switch acionado", body: `Perda 24h ${e.loss24hUsd ?? "?"} / limite ${e.limitUsd ?? "?"}` };
  if (t === "gas.alert") return { title: "⛽ ZEUS · Gás crítico", body: `Saldo ${e.balanceEth ?? "?"} ETH (${e.balanceUsd ?? "?"} USD)` };
  if (t === "failure.cooldown_activated") return { title: "⏸️ ZEUS · Cooldown ativado", body: `${e.consecutiveFailures ?? "?"} falhas · ${e.cooldownSec ?? "?"}s` };
  if (t === "tx.confirmed") return { title: "✅ ZEUS · Tx confirmada", body: `${e.protocol ?? ""} +$${(e.netProfitUsd ?? 0).toFixed(2)} net` };
  return { title: `ZEUS · ${t}`, body: e.reason ? String(e.reason) : "Novo evento" };
}

/** Envia Web Push para todas as subscriptions salvas. */
export async function fanoutPush(e: ZeusEvent) {
  if (!ensureVapid()) return;
  const sb = getServiceSupabase();
  if (!sb) return;
  const { data } = await sb.from("push_subscriptions").select("id, subscription");
  if (!data?.length) return;
  const { title, body } = titleFor(e);
  const payload = JSON.stringify({ title, body, type: e.type });
  await Promise.allSettled(
    data.map(async (row: { id: number; subscription: webpush.PushSubscription }) => {
      try {
        await webpush.sendNotification(row.subscription, payload);
      } catch (err: unknown) {
        // 404/410 = subscription expirada → remove
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) await sb.from("push_subscriptions").delete().eq("id", row.id);
      }
    }),
  );
}

/** Envia email (Resend) para eventos críticos. */
export async function sendEmail(e: ZeusEvent) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM;
  if (!key || !to || !from) return;
  if (e.severity !== "critical" && e.type !== "pnl.kill_switch_triggered") return;
  const { title, body } = titleFor(e);
  try {
    const resend = new Resend(key);
    await resend.emails.send({
      from,
      to,
      subject: title,
      text: `${body}\n\nEvento: ${e.type}\nChain: ${e.chain ?? "?"} · Mode: ${e.mode ?? "?"}\nHora: ${e.timestamp ?? new Date().toISOString()}`,
    });
  } catch {
    // não bloqueia a ingestão
  }
}
