/**
 * Re-vetting contínuo (Etapa 6) — o porteiro fica VIVO: re-checa o universo atual num loop e
 * detecta DEGRADAÇÃO (liquidez caiu, virou honeypot) → auto-demote (token.exited), ou RECUPERAÇÃO
 * → auto-promote (token.entered). Tira o "restart" do jogo: o enforce passa a re-filtrar ao vivo.
 *
 * Genérico: o app injeta COMO re-vetar (revet) e COMO emitir (onTransition). O tracker já detecta a
 * transição (só emite quando o verdict MUDA — anti-flicker natural).
 */

import type { VettingUniverseTracker, VettedEntry } from './universeTracker';
import type { TokenVerdict } from './tokenVetting';

export interface RevetTickDeps {
  tracker: VettingUniverseTracker;
  /** Re-veta uma entrada do universo → verdict fresco (ou null se não deu pra re-vetar agora). */
  revet: (entry: VettedEntry) => Promise<TokenVerdict | null>;
  /** Emite a transição (entrou/saiu) — o app decide o barramento/tipo. */
  onTransition: (verdict: TokenVerdict, transition: 'entered' | 'exited') => void;
  /** Máximo de tokens re-vetados por tick (protege RPC). Default: todos. */
  maxPerTick?: number;
}

/**
 * Roda 1 tick de re-vetting sobre o universo ATUAL do tracker. Cada re-vet é isolado (um erro num
 * token não derruba o tick). Retorna quantos entraram/saíram nesse tick.
 */
export async function runRevetTick(deps: RevetTickDeps): Promise<{ entered: number; exited: number; checked: number }> {
  const universe = deps.tracker.snapshot();
  const slice = deps.maxPerTick ? universe.slice(0, deps.maxPerTick) : universe;
  let entered = 0;
  let exited = 0;
  let checked = 0;
  for (const entry of slice) {
    let verdict: TokenVerdict | null = null;
    try {
      verdict = await deps.revet(entry);
    } catch {
      continue; // re-vet de 1 token falhou → mantém o verdict anterior (não degrada na dúvida)
    }
    if (!verdict) continue;
    checked++;
    const transition = deps.tracker.record(verdict);
    if (transition === 'entered') {
      entered++;
      deps.onTransition(verdict, 'entered');
    } else if (transition === 'exited') {
      exited++;
      deps.onTransition(verdict, 'exited');
    }
  }
  return { entered, exited, checked };
}
