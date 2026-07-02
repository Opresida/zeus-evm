/**
 * #7 automação — Quarentena de token (observe-first).
 *
 * Estende o porteiro de tokens: quando um token acumula FALHAS/REVERTS repetidos numa janela
 * (ex.: 5 reverts em 24h), o bot mostra "colocaria em quarentena" (pararia de negociar aquele token).
 * Com histerese: precisa do threshold cheio pra entrar e a contagem decai com o tempo (janela rolante),
 * então um problema isolado não quarentena. Observe-first: só AVISA; a demote real é gated (chave-mestra/flag).
 *
 * Reutiliza o sinal de falha que o bot já emite (revert/lost_race por token). Em DRY_RUN, alimenta-se
 * de reverts de simulação/pré-dispatch; ao vivo, dos reverts reais. NÃO inventa sinal.
 */

export interface TokenQuarantineEntry {
  token: string;
  symbol?: string;
  failures: number;
  lastReason?: string;
  /** Passaria do threshold → seria posto em quarentena (advisory até a flag ligar). */
  wouldQuarantine: boolean;
}

interface Fail {
  t: number;
  reason?: string;
}

export class TokenQuarantineTracker {
  private byToken = new Map<string, { symbol?: string; fails: Fail[] }>();
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly now: () => number;

  constructor(opts?: { windowMs?: number; threshold?: number; now?: () => number }) {
    this.windowMs = opts?.windowMs ?? 24 * 60 * 60 * 1000; // 24h
    this.threshold = Math.max(1, opts?.threshold ?? 5);
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Registra uma falha/revert atribuída a um token. */
  recordFailure(token: string, opts?: { symbol?: string; reason?: string }): void {
    if (!token) return;
    const key = token.toLowerCase();
    const t = this.now();
    let e = this.byToken.get(key);
    if (!e) {
      e = { symbol: opts?.symbol, fails: [] };
      this.byToken.set(key, e);
    }
    if (opts?.symbol) e.symbol = opts.symbol;
    e.fails.push({ t, reason: opts?.reason });
    this.prune(e, t);
    if (this.byToken.size > 1000) this.evict();
  }

  /** Um sucesso alivia a pressão (histerese): remove a falha mais antiga do token. */
  recordSuccess(token: string): void {
    if (!token) return;
    const e = this.byToken.get(token.toLowerCase());
    if (e && e.fails.length) e.fails.shift();
  }

  private prune(e: { fails: Fail[] }, now: number): void {
    const cutoff = now - this.windowMs;
    while (e.fails.length && e.fails[0]!.t < cutoff) e.fails.shift();
  }

  private evict(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [k, e] of this.byToken) {
      this.prune(e, this.now());
      if (!e.fails.length || e.fails[e.fails.length - 1]!.t < cutoff) this.byToken.delete(k);
    }
  }

  /** True quando o token estouraria o threshold (advisory). O caller decide se aplica (gated). */
  wouldQuarantine(token: string): boolean {
    const e = this.byToken.get(token.toLowerCase());
    if (!e) return false;
    this.prune(e, this.now());
    return e.fails.length >= this.threshold;
  }

  /** Lista os tokens sob pressão (com ≥1 falha na janela), do pior pro melhor. */
  snapshot(): TokenQuarantineEntry[] {
    const now = this.now();
    const out: TokenQuarantineEntry[] = [];
    for (const [token, e] of this.byToken) {
      this.prune(e, now);
      if (!e.fails.length) continue;
      out.push({
        token,
        symbol: e.symbol,
        failures: e.fails.length,
        lastReason: e.fails[e.fails.length - 1]!.reason,
        wouldQuarantine: e.fails.length >= this.threshold,
      });
    }
    return out.sort((a, b) => b.failures - a.failures);
  }

  /** Só os que seriam quarentenados (threshold cheio). */
  quarantined(): TokenQuarantineEntry[] {
    return this.snapshot().filter((e) => e.wouldQuarantine);
  }
}
