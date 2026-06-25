import { describe, expect, it } from "vitest";
import { validateInvite, validateCredentials, type InviteRow } from "./invite";

const NOW = 1_700_000_000_000;
const future = new Date(NOW + 86_400_000).toISOString();
const past = new Date(NOW - 86_400_000).toISOString();

describe("validateInvite", () => {
  it("aceita convite existente, não usado e não expirado", () => {
    const inv: InviteRow = { token: "abc", used_at: null, expires_at: future };
    expect(validateInvite(inv, NOW)).toEqual({ ok: true });
  });
  it("rejeita inexistente", () => {
    expect(validateInvite(null, NOW)).toEqual({ ok: false, reason: "convite inválido" });
  });
  it("rejeita já usado", () => {
    const inv: InviteRow = { token: "abc", used_at: new Date(NOW).toISOString(), expires_at: future };
    expect(validateInvite(inv, NOW).ok).toBe(false);
  });
  it("rejeita expirado", () => {
    const inv: InviteRow = { token: "abc", used_at: null, expires_at: past };
    expect(validateInvite(inv, NOW)).toEqual({ ok: false, reason: "convite expirado" });
  });
  it("rejeita expires_at inválido", () => {
    const inv: InviteRow = { token: "abc", used_at: null, expires_at: "lixo" };
    expect(validateInvite(inv, NOW).ok).toBe(false);
  });
});

describe("validateCredentials", () => {
  it("aceita e-mail válido + senha >= 8", () => {
    expect(validateCredentials("a@b.com", "12345678")).toEqual({ ok: true });
  });
  it("rejeita e-mail inválido", () => {
    expect(validateCredentials("nao-email", "12345678").ok).toBe(false);
  });
  it("rejeita senha curta", () => {
    expect(validateCredentials("a@b.com", "123").ok).toBe(false);
  });
});
