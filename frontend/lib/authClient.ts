"use client";
import { getSupabase } from "./supabaseClient";

export type ProfileRole = "admin" | "member";
export type ProfileStatus = "pending" | "approved" | "rejected";

export interface Profile {
  id: string;
  email: string | null;
  role: ProfileRole;
  status: ProfileStatus;
}

/** Sessão + perfil do usuário logado (null = não logado). */
export interface AuthState {
  userId: string;
  email: string | null;
  accessToken: string;
  profile: Profile | null;
}

/** Lê a sessão atual + o perfil (papel/status). null se não houver sessão. */
export async function loadAuthState(): Promise<AuthState | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: sess } = await sb.auth.getSession();
  const session = sess.session;
  if (!session) return null;
  const { data: prof } = await sb
    .from("profiles")
    .select("id, email, role, status")
    .eq("id", session.user.id)
    .maybeSingle();
  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    accessToken: session.access_token,
    profile: (prof as Profile | null) ?? null,
  };
}

export async function signIn(email: string, password: string): Promise<{ error?: string }> {
  const sb = getSupabase();
  if (!sb) return { error: "Supabase não configurado." };
  const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  return error ? { error: error.message } : {};
}

export async function signOut(): Promise<void> {
  await getSupabase()?.auth.signOut();
}

/** Token de acesso atual (pra mandar no header Authorization das rotas protegidas). */
export async function getAccessToken(): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Assina mudanças de sessão (login/logout/refresh) — retorna unsubscribe. */
export function onAuthChange(cb: () => void): () => void {
  const sb = getSupabase();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange(() => cb());
  return () => data.subscription.unsubscribe();
}
