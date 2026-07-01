/**
 * Wallet-pool (Motor 1 / pré-liquidação) — N EOAs paralelos pro grind de presença.
 *
 * Cobre os 4 cuidados do Humberto:
 *   #1 breaker AGREGADO (exposureBreaker) — teto coletivo somando todos os senders.
 *   #2 seed = chave-mestra isolada (walletPool deriva do seed; config exige seed dedicada).
 *   #3 funding/sweep de gás (funding — planners puros).
 *   #4 nonce-pool por sender (noncePool).
 *
 * ⚠️ Default DESLIGADO (WALLET_POOL_ENABLED=false). Wiring no dispatch + movimentação real de fundo
 * = fase mainnet, SÓ após o DRY_RUN provar o edge. Aqui é a fundação testada, sem mover capital.
 */

export { WalletPool, type PooledSender } from './walletPool';
export { NoncePool } from './noncePool';
export { AggregatedExposureBreaker, type ExposureStats } from './exposureBreaker';
export { planGasTopUps, planGasSweeps, totalTopUpWei, type GasTopUp, type GasSweep } from './funding';
export { WalletPoolOrchestrator, buildWalletPoolOrchestrator, type AcquiredSender } from './orchestrator';
