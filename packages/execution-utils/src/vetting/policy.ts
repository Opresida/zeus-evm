/**
 * Política de vetting POR MOTOR (pura, testável). Decide se um token PASSA, dado os 4 checks.
 *
 * Princípio (plano 2026-06-30):
 *   - Motor 2 (arb): token é ESCOLHIDO por nós → exige segurança + saída + liquidez + NÃO ser no-edge
 *     (LSDs/stables têm liquidez e segurança, mas sem edge de arbitragem → rejeitados pro arb).
 *   - Motor 1 (liquidação): token é IMPOSTO (colateral do tomador) → só pergunta "dá pra VENDER com
 *     segurança?" = segurança + saída + liquidez + não-honeypot. SEM filtro de edge (LSDs aceitos).
 */

export type VettingMotor = 'motor1' | 'motor2';

export interface PolicyChecks {
  safetyOk: boolean;
  exitRouteOk: boolean;
  liquidityFloorOk: boolean;
  isHoneypot: boolean;
  /** Só usado pro motor2: token está na blocklist sem-edge (NO_EDGE_TOKENS). */
  noEdge: boolean;
}

export interface PolicyResult {
  verdict: 'pass' | 'reject';
  /** Chaves que falharam, em ordem de severidade — alimenta o builder de motivo. */
  failed: Array<'honeypot' | 'safety' | 'exitRoute' | 'liquidityFloor' | 'noEdge'>;
}

/** Aplica a política do motor. Pura — sem I/O. */
export function applyPolicy(motor: VettingMotor, c: PolicyChecks): PolicyResult {
  const failed: PolicyResult['failed'] = [];
  if (c.isHoneypot) failed.push('honeypot');
  if (!c.safetyOk) failed.push('safety');
  if (!c.exitRouteOk) failed.push('exitRoute');
  if (!c.liquidityFloorOk) failed.push('liquidityFloor');
  // Gate de EDGE só pro motor2 — preserva a doutrina (não arbitrar token sem edge).
  if (motor === 'motor2' && c.noEdge) failed.push('noEdge');
  return { verdict: failed.length === 0 ? 'pass' : 'reject', failed };
}
