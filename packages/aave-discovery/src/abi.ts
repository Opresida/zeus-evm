/**
 * Aave V3 — ABIs mínimas usadas pelo discovery.
 *
 * Endereços do PoolAddressesProvider por chain (canônicos Aave V3):
 *   Base mainnet:     0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D
 *   Arbitrum mainnet: 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb
 *   Optimism mainnet: 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb
 *
 * O liquidator resolve dinamicamente o PoolDataProvider via:
 *   Pool.ADDRESSES_PROVIDER() → PoolAddressesProvider.getPoolDataProvider()
 * Isso evita hardcodar endereços que mudam entre versões.
 */

export const POOL_ADDRESSES_PROVIDER_BY_CHAIN: Record<number, `0x${string}`> = {
  // mainnets
  8453: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',     // Base
  42161: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',    // Arbitrum
  10: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',       // Optimism
  // testnets (PoolAddressesProvider mostly imutável entre deploys)
  84532: '0xd449FeD49d9C443688d6816fE6872F21402e41de',    // Base Sepolia
  421614: '0xB25a5D144626a0D488e52AE717A051a2E9997076',   // Arbitrum Sepolia
  11155420: '0x36616cf17557639614c1cdDb356b1B83fc0B2132', // Optimism Sepolia
};

export const POOL_ABI = [
  {
    type: 'function',
    name: 'ADDRESSES_PROVIDER',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'user' }],
    outputs: [
      { type: 'uint256', name: 'totalCollateralBase' },
      { type: 'uint256', name: 'totalDebtBase' },
      { type: 'uint256', name: 'availableBorrowsBase' },
      { type: 'uint256', name: 'currentLiquidationThreshold' },
      { type: 'uint256', name: 'ltv' },
      { type: 'uint256', name: 'healthFactor' },
    ],
  },
  {
    type: 'function',
    name: 'getReservesList',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getUserConfiguration',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'user' }],
    outputs: [
      // tipo é struct { uint256 data } no Solidity — em ABI é uint256 wrapped em tuple
      {
        type: 'tuple',
        components: [{ type: 'uint256', name: 'data' }],
      },
    ],
  },
] as const;

export const POOL_ADDRESSES_PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getPoolDataProvider',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

export const POOL_DATA_PROVIDER_ABI = [
  /**
   * Retorna config estática do reserve: decimals, LTV, liquidationThreshold,
   * liquidationBonus (em bps + 10000, ex: 10750 = 7.5% bonus), reserveFactor, etc.
   */
  {
    type: 'function',
    name: 'getReserveConfigurationData',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'asset' }],
    outputs: [
      { type: 'uint256', name: 'decimals' },
      { type: 'uint256', name: 'ltv' },
      { type: 'uint256', name: 'liquidationThreshold' },
      { type: 'uint256', name: 'liquidationBonus' },
      { type: 'uint256', name: 'reserveFactor' },
      { type: 'bool', name: 'usageAsCollateralEnabled' },
      { type: 'bool', name: 'borrowingEnabled' },
      { type: 'bool', name: 'stableBorrowRateEnabled' },
      { type: 'bool', name: 'isActive' },
      { type: 'bool', name: 'isFrozen' },
    ],
  },
  /**
   * Retorna balances atuais do user num reserve específico.
   */
  {
    type: 'function',
    name: 'getUserReserveData',
    stateMutability: 'view',
    inputs: [
      { type: 'address', name: 'asset' },
      { type: 'address', name: 'user' },
    ],
    outputs: [
      { type: 'uint256', name: 'currentATokenBalance' },     // collateral em wei do asset
      { type: 'uint256', name: 'currentStableDebt' },        // debt em stable rate
      { type: 'uint256', name: 'currentVariableDebt' },      // debt em variable rate
      { type: 'uint256', name: 'principalStableDebt' },
      { type: 'uint256', name: 'scaledVariableDebt' },
      { type: 'uint256', name: 'stableBorrowRate' },
      { type: 'uint256', name: 'liquidityRate' },
      { type: 'uint40', name: 'stableRateLastUpdated' },
      { type: 'bool', name: 'usageAsCollateralEnabled' },    // este reserve é collateral pro user
    ],
  },
] as const;

/// ERC20 minimal pra ler symbol/decimals em fallback (cache reserves)
export const ERC20_VIEW_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;
