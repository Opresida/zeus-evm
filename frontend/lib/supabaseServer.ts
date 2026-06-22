import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente Supabase no servidor (service role — bypassa RLS).
 * Usado só nas rotas /api. Nunca expor a service key ao browser.
 */
export function getServiceSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
