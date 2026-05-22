/**
 * Simulator — usa `eth_call` pra simular a execução do calldata SEM gastar gas.
 *
 * Antes de submeter uma tx real (Fase 5+), sempre simular pra:
 *   1. Confirmar que profit estimado bate com on-chain real
 *   2. Detectar reverts (slippage, profit insuficiente, killed)
 *   3. Estimar gas exato
 *
 * Retorna sucesso/fracasso + decoded error reason (custom errors).
 */

import { decodeErrorResult, type Address, type Hex, type PublicClient } from 'viem';

import { ZEUS_EXECUTOR_ABI } from './abi';

type AnyPublicClient = PublicClient<any, any>;

export interface SimulationResult {
  success: boolean;
  /** Gas usado (apenas se success=true) */
  gasUsed?: bigint;
  /** Reason do revert (se success=false) — decoded custom error */
  revertReason?: string;
  /** Raw error data (pra debug) */
  rawError?: unknown;
}

export interface SimulateParams {
  client: AnyPublicClient;
  executorAddress: Address;
  callerAddress: Address;
  calldata: Hex;
  /** Block opcional pra reprodutibilidade */
  blockNumber?: bigint;
}

/**
 * Simula execução do calldata via eth_call.
 * Retorna decoded error em caso de revert.
 */
export async function simulateArbitrage(params: SimulateParams): Promise<SimulationResult> {
  const { client, executorAddress, callerAddress, calldata, blockNumber } = params;

  try {
    // eth_call simulando execução
    await client.call({
      account: callerAddress,
      to: executorAddress,
      data: calldata,
      blockNumber,
    });

    // Se chegou aqui, não reverteu. Estima gas pra prever custo real.
    const gasUsed = await client.estimateGas({
      account: callerAddress,
      to: executorAddress,
      data: calldata,
      blockNumber,
    });

    return { success: true, gasUsed };
  } catch (err) {
    return parseSimulationError(err);
  }
}

/**
 * Decoda custom errors do ZeusExecutor pra mensagem legível.
 */
function parseSimulationError(err: unknown): SimulationResult {
  if (!(err instanceof Error)) {
    return { success: false, revertReason: 'unknown error', rawError: err };
  }

  // viem expõe revert data em err.cause?.data ou err.data
  const errAny = err as any;
  const revertData: Hex | undefined =
    errAny?.cause?.data ?? errAny?.data ?? extractDataFromMessage(err.message);

  if (!revertData || revertData === '0x' || revertData.length < 10) {
    return { success: false, revertReason: err.message.slice(0, 200), rawError: err };
  }

  try {
    const decoded = decodeErrorResult({
      abi: ZEUS_EXECUTOR_ABI,
      data: revertData,
    });

    const argsStr = decoded.args && decoded.args.length > 0 ? `(${decoded.args.map((a) => String(a)).join(', ')})` : '';
    return {
      success: false,
      revertReason: `${decoded.errorName}${argsStr}`,
      rawError: err,
    };
  } catch {
    return { success: false, revertReason: err.message.slice(0, 200), rawError: err };
  }
}

/**
 * Extrai 0x... do middle de uma mensagem de erro do viem se não estiver em err.data.
 */
function extractDataFromMessage(msg: string): Hex | undefined {
  const match = msg.match(/0x[0-9a-fA-F]{8,}/);
  return match ? (match[0] as Hex) : undefined;
}
