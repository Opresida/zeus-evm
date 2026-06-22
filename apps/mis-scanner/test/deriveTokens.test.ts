/**
 * Robustez da derivação de tokens — Morpho via getLogs.
 *
 * Regressão do bug "0 tokens silencioso": se o RPC rejeita o range de getLogs
 * (ex.: Alchemy free tier = 10 blocos vs o scan usa ~10k), TODOS os chunks falham
 * e a derivação volta 0 tokens. Antes isso era ENGOLIDO sem aviso; agora tem que logar warn.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChainConfig } from '@zeus-evm/chain-config';
import { deriveProtocolTokens } from '../src/deriveTokens';

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';

/** ChainConfig mínima: só Morpho ligado (isola o caminho do event scan). */
function morphoOnlyConfig(): ChainConfig {
  return { tokens: {}, morpho: { morphoBlue: MORPHO } } as unknown as ChainConfig;
}

describe('deriveProtocolTokens — robustez Morpho getLogs', () => {
  it('loga WARN quando os chunks de getLogs do Morpho falham (RPC com range apertado)', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    // current pequeno → start=0, poucos chunks; getLogs SEMPRE lança (simula Alchemy free tier).
    const client = {
      getBlockNumber: async () => 30_000n,
      getLogs: async () => {
        throw new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.');
      },
    } as never;

    const tokens = await deriveProtocolTokens({ client, chainConfig: morphoOnlyConfig(), logger });

    expect(tokens).toEqual([]); // sem tokens (todos os chunks falharam)
    expect(logger.warn).toHaveBeenCalled(); // mas NÃO silenciosamente
    const [meta, msg] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect((meta.failedChunks as number) > 0).toBe(true);
    expect(meta.failedChunks).toBe(meta.totalChunks); // 100% falharam
    expect(msg).toMatch(/Morpho/i);
    expect(msg).toMatch(/getLogs/i);
  });

  it('NÃO loga warn quando os chunks passam (caminho feliz)', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const client = {
      getBlockNumber: async () => 30_000n,
      getLogs: async () => [], // sucesso, sem mercados na janela
      multicall: async () => [],
    } as never;

    const tokens = await deriveProtocolTokens({ client, chainConfig: morphoOnlyConfig(), logger });

    expect(tokens).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled(); // chunks ok → nenhum warn
  });
});
