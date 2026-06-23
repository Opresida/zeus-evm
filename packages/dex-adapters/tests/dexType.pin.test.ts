/**
 * PIN TEST — guarda de sincronia do enum DexType (TS ↔ Solidity).
 *
 * O enum DexType é encodado como `uint8 dexType` na calldata on-chain. Seus valores DEVEM bater
 * EXATAMENTE com o enum Solidity em `contracts/src/interfaces/IZeusExecutor.sol`. Reordenar ou
 * inserir no meio quebra silenciosamente toda calldata já construída → este teste trava no CI.
 *
 * Regra: SÓ APPEND, NUNCA REORDENAR. Ao adicionar um DexType novo, atualize:
 *   1. packages/shared-types/src/index.ts (fonte única TS)
 *   2. contracts/src/interfaces/IZeusExecutor.sol (enum Solidity)
 *   3. este pin (append do par nome=valor)
 */

import { describe, expect, it } from 'vitest';
import { DexType } from '../src/types';
import { DexType as SharedDexType } from '@zeus-evm/shared-types';

describe('DexType pin (espelha contracts/src/interfaces/IZeusExecutor.sol)', () => {
  it('valores exatos — SÓ APPEND, NUNCA REORDENAR', () => {
    expect(DexType.UniswapV2).toBe(0);
    expect(DexType.UniswapV3).toBe(1);
    expect(DexType.Aerodrome).toBe(2);
    expect(DexType.Curve).toBe(3);
    expect(DexType.Balancer).toBe(4);
    expect(DexType.Slipstream).toBe(5);
    expect(DexType.PancakeV3).toBe(6);
  });

  it('re-export aponta pra fonte única (shared-types) — não há enum duplicado', () => {
    expect(DexType).toBe(SharedDexType);
  });
});
