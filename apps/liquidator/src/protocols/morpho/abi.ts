/**
 * Morpho Blue — ABIs mínimas pro discovery + liquidation pricing.
 *
 * Singleton em todas chains: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
 * Markets isolados identificados por id = keccak256(abi.encode(marketParams)).
 */

/** IMorpho — reads pra discovery + HF compute. */
export const MORPHO_ABI = [
  {
    type: 'function',
    name: 'position',
    stateMutability: 'view',
    inputs: [
      { type: 'bytes32', name: 'id' },
      { type: 'address', name: 'user' },
    ],
    outputs: [
      { type: 'uint256', name: 'supplyShares' },
      { type: 'uint128', name: 'borrowShares' },
      { type: 'uint128', name: 'collateral' },
    ],
  },
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32', name: 'id' }],
    outputs: [
      { type: 'uint128', name: 'totalSupplyAssets' },
      { type: 'uint128', name: 'totalSupplyShares' },
      { type: 'uint128', name: 'totalBorrowAssets' },
      { type: 'uint128', name: 'totalBorrowShares' },
      { type: 'uint128', name: 'lastUpdate' },
      { type: 'uint128', name: 'fee' },
    ],
  },
  {
    type: 'function',
    name: 'idToMarketParams',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32', name: 'id' }],
    outputs: [
      { type: 'address', name: 'loanToken' },
      { type: 'address', name: 'collateralToken' },
      { type: 'address', name: 'oracle' },
      { type: 'address', name: 'irm' },
      { type: 'uint256', name: 'lltv' },
    ],
  },
] as const;

/** IOracle do Morpho — retorna preço scaled 1e36 (loanToken por collateralToken). */
export const MORPHO_ORACLE_ABI = [
  {
    type: 'function',
    name: 'price',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * Evento Borrow do Morpho singleton — usado pra discovery on-chain.
 *   event Borrow(bytes32 indexed id, address caller, address indexed onBehalf,
 *                address receiver, uint256 assets, uint256 shares);
 * `onBehalf` é quem carrega a dívida.
 */
export const MORPHO_BORROW_EVENT_ABI = {
  type: 'event',
  name: 'Borrow',
  inputs: [
    { type: 'bytes32', name: 'id', indexed: true },
    { type: 'address', name: 'caller', indexed: false },
    { type: 'address', name: 'onBehalf', indexed: true },
    { type: 'address', name: 'receiver', indexed: false },
    { type: 'uint256', name: 'assets', indexed: false },
    { type: 'uint256', name: 'shares', indexed: false },
  ],
} as const;

/**
 * Evento CreateMarket do Morpho singleton — usado pra enumerar markets.
 *   event CreateMarket(bytes32 indexed id, MarketParams marketParams);
 */
export const MORPHO_CREATE_MARKET_EVENT_ABI = {
  type: 'event',
  name: 'CreateMarket',
  inputs: [
    { type: 'bytes32', name: 'id', indexed: true },
    {
      type: 'tuple',
      name: 'marketParams',
      indexed: false,
      components: [
        { type: 'address', name: 'loanToken' },
        { type: 'address', name: 'collateralToken' },
        { type: 'address', name: 'oracle' },
        { type: 'address', name: 'irm' },
        { type: 'uint256', name: 'lltv' },
      ],
    },
  ],
} as const;
