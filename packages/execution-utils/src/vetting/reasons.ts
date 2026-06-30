/**
 * Tradutor verdict → motivo em PT-BR SIMPLES (linguagem do dia-a-dia pro painel).
 * Pura, testável. Nunca jargão técnico cru — o Humberto lê e entende na hora.
 */

import type { PolicyResult, VettingMotor } from './policy';

export interface ReasonContext {
  motor: VettingMotor;
  exitDex?: string; // ex: "Aerodrome stable", "UniV3 0.05%"
  liquidityUsd?: number;
  locked?: boolean;
}

function money(usd?: number): string {
  if (usd == null || !Number.isFinite(usd)) return '';
  return '$' + Math.round(usd).toLocaleString('en-US');
}

/** Constrói as linhas de motivo (1+ por verdict) em PT-BR simples. */
export function buildReasons(result: PolicyResult, ctx: ReasonContext): string[] {
  if (result.verdict === 'pass') {
    const parts: string[] = [];
    if (ctx.exitDex) parts.push(`tem saída na ${ctx.exitDex}`);
    if (ctx.liquidityUsd) parts.push(`liquidez ok (${money(ctx.liquidityUsd)})`);
    parts.push('passou no exame de segurança');
    if (ctx.locked) parts.push('liquidez travada');
    return [`entrou: ${parts.join(', ')}`];
  }

  // reject — uma linha por motivo que falhou (o 1º é o principal).
  return result.failed.map((f) => {
    switch (f) {
      case 'honeypot':
        return 'saiu: é honeypot (não dá pra vender) — bloqueado';
      case 'safety':
        return 'saiu: reprovou no exame de segurança (taxa abusiva / dono concentrado / mintável)';
      case 'exitRoute':
        return 'saiu: não achei saída em nenhuma DEX que a gente executa';
      case 'liquidityFloor':
        return `saiu: liquidez abaixo do piso${ctx.liquidityUsd != null ? ` (${money(ctx.liquidityUsd)})` : ''}`;
      case 'noEdge':
        return 'rejeitado: seguro, mas sem edge de arbitragem (não vale a pena pro arb)';
      default:
        return 'saiu: motivo não documentado';
    }
  });
}
