/**
 * Controle remoto de execução (toggle do Frontend → bot) via Supabase `engine_control`.
 *
 * A implementação foi promovida pra `@zeus-evm/execution-utils` (compartilhada entre os motores).
 * Este arquivo re-exporta pra preservar o import path local do mis-scanner.
 */
export { fetchEngineControlEnabled } from '@zeus-evm/execution-utils';
