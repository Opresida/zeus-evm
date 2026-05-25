// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/// @notice Tipos de DEX suportados — deve bater com `enum DexType` no TypeScript shared-types
enum DexType {
    UniswapV2,    // 0
    UniswapV3,    // 1
    Aerodrome,    // 2
    Curve,        // 3 (futuro)
    Balancer      // 4 (futuro)
}

/// @notice Um swap individual numa cadeia de arbitragem
/// @dev Pra multi-step: amountIn=0 significa "usar saldo atual deste contrato"
struct SwapStep {
    address router;          // endereço do router/factory do DEX
    address tokenIn;
    address tokenOut;
    uint256 amountIn;        // 0 = usar saldo atual (chain de swaps)
    uint256 minAmountOut;
    DexType dexType;
    bytes extraData;         // fee tier (UniV3 uint24), isStable (Aerodrome bool), pool (Curve), etc.
}

/// @notice Parâmetros da arbitragem completa
struct ArbitrageParams {
    SwapStep[] steps;        // sequência de swaps
    uint256 minProfitWei;    // tx reverte se profit < esse valor
    address profitToken;     // token em que o lucro deve estar no final (geralmente tokenIn do step 0)
    address profitReceiver;  // pra onde enviar o lucro residual
}

/// @notice Parâmetros de uma operação de liquidação Aave V3
/// @dev Fluxo: flashloan(debtAsset) → liquidationCall → recebe colateral+bonus → swap colateral→debtAsset → repay
struct LiquidationParams {
    address user;                // dono da posição liquidável
    address collateralAsset;     // asset que receberemos como bonus
    address debtAsset;           // asset cuja dívida estamos quitando (= flashloan asset)
    uint256 debtToCover;         // quantia da dívida a cobrir (= flashloan amount). Aave permite até 50% da dívida total.
    SwapStep[] swapSteps;        // swaps pra converter colateral → debtAsset (pra repay flashloan + manter profit)
    uint256 minProfitWei;        // profit mínimo em debtAsset (após repay) ou tx reverte
    address profitReceiver;      // pra onde enviar o profit residual em debtAsset
}

/// @notice Discriminator pro callback executeOperation diferenciar tipo de operação
enum OperationType {
    Arbitrage,            // 0 — flashloan pra arb cross-DEX
    Liquidation,          // 1 — flashloan pra liquidação Aave V3
    CompoundLiquidation,  // 2 — flashloan pra liquidação Compound III (absorb + buyCollateral)
    MorphoLiquidation     // 3 — flashloan pra liquidação Morpho Blue (markets isolados)
}

/// @notice Parâmetros de uma liquidação Morpho Blue
/// @dev Morpho tem markets isolados — cada (loanToken, collateralToken, oracle, irm, lltv) é market separado
struct MorphoLiquidationParams {
    address morpho;                  // endereço do Morpho singleton
    // MarketParams: identifica o market do borrower
    address loanToken;               // = debtAsset do flashloan (mesmo asset)
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
    address borrower;                // dono da position underwater
    uint256 seizedAssets;            // quantidade de colateral a seizar (deixe 0 se usar repaidShares)
    uint256 repaidShares;            // quantidade de shares de dívida (deixe 0 se usar seizedAssets)
    /// @notice Quantia EXATA em loanToken (wei) a ser flashloaned. Computada off-chain via simulação
    /// `eth_call` em `Morpho.liquidate` pra obter `assetsRepaid` exato. Não confundir com `seizedAssets`
    /// (que é em wei do collateralToken). Resolve mistura semântica do MVP anterior.
    uint256 flashloanAmount;
    SwapStep[] swapSteps;            // swaps pra converter colateral → loanToken pra repay flashloan
    uint256 minProfitWei;            // profit mínimo em loanToken após repay
    address profitReceiver;          // pra onde enviar o profit
}

/// @notice Parâmetros de uma liquidação Compound III (Comet)
/// @dev Fluxo: flashloan(baseToken) → absorb(borrower) → buyCollateral(...) → swap → repay
struct CompoundLiquidationParams {
    address comet;                // endereço do Comet (cUSDCv3, cWETHv3, etc)
    address borrower;             // dono da position underwater
    address collateralAsset;      // qual collateral comprar do protocolo
    uint256 baseAmount;           // quanto do base token usar pra buyCollateral (= flashloan amount)
    uint256 minCollateralReceived; // slippage protection no buyCollateral
    SwapStep[] swapSteps;         // swaps pra converter collateral → base token (pra repay)
    uint256 minProfitWei;         // profit mínimo em base token após repay
    address profitReceiver;       // pra onde enviar o profit
}

/// @title IZeusExecutor — interface pública do contrato executor
interface IZeusExecutor {
    // ════════ EVENTS ════════

    event ArbitrageExecuted(
        address indexed initiator,
        address indexed profitToken,
        uint256 profit,
        uint256 swapsCount
    );

    event FlashloanArbitrageExecuted(
        address indexed initiator,
        address indexed flashloanAsset,
        uint256 flashloanAmount,
        uint256 flashloanFee,
        address indexed profitToken,
        uint256 profit
    );

    event LiquidationExecuted(
        address indexed initiator,
        address indexed user,
        address indexed collateralAsset,
        address debtAsset,
        uint256 debtCovered,
        uint256 collateralReceived,
        uint256 profit
    );

    event CompoundLiquidationExecuted(
        address indexed initiator,
        address indexed comet,
        address indexed borrower,
        address collateralAsset,
        uint256 baseAmount,
        uint256 collateralReceived,
        uint256 profit
    );

    event MorphoLiquidationExecuted(
        address indexed initiator,
        address indexed borrower,
        address indexed collateralToken,
        address loanToken,
        uint256 assetsLiquidated,
        uint256 collateralReceived,
        uint256 profit
    );

    event Killed();
    event Revived();
    event MaxTradeWeiUpdated(uint256 oldValue, uint256 newValue);
    /// @notice Emitido quando owner ajusta cap específico pra um token (H-02 fix)
    event MaxTradePerTokenUpdated(address indexed token, uint256 oldValue, uint256 newValue);
    event OperatorSet(address indexed operator, bool allowed);
    event TokenRescued(address indexed token, uint256 amount, address indexed to);

    // ════════ CUSTOM ERRORS ════════

    error NotAuthorized();
    error BotKilled();
    error InsufficientProfit(uint256 actual, uint256 required);
    error SwapFailed(uint256 stepIndex);
    error InvalidDexType(uint8 dexType);
    error FlashloanRepayShortfall(uint256 available, uint256 required);
    error TradeTooLarge(uint256 amount, uint256 max);
    error EmptySteps();
    error InvalidCaller();

    // ════════ ARBITRAGE ENTRYPOINTS ════════

    /// @notice Modalidade 1: arbitragem com capital próprio do contrato
    /// @dev Bot deve ter transferido tokens pro contrato antes (ou approved transferFrom)
    function executeArbitrage(ArbitrageParams calldata params) external;

    /// @notice Modalidade 2: arbitragem com flashloan Aave V3
    /// @dev Aave chama executeOperation() de volta após emprestar
    function executeFlashloanArbitrage(
        address flashloanAsset,
        uint256 flashloanAmount,
        ArbitrageParams calldata params
    ) external;

    /// @notice Modalidade 3: liquidação Aave V3 financiada por flashloan
    /// @dev Fluxo atômico:
    ///   1. flashloan(debtAsset, debtToCover) do Aave
    ///   2. callback executeOperation:
    ///      a. Aave.liquidationCall(...) → recebe collateral + bonus
    ///      b. swap collateral → debtAsset via swapSteps (UniV3/Aerodrome)
    ///      c. repay flashloan + fee 0.05%
    ///      d. profit residual em debtAsset vai pro profitReceiver
    function executeLiquidation(LiquidationParams calldata params) external;

    /// @notice Modalidade 4: liquidação Compound III (Comet) financiada por flashloan Aave V3
    /// @dev Fluxo atômico:
    ///   1. flashloan(baseToken, baseAmount) do Aave V3
    ///   2. callback executeOperation:
    ///      a. Comet.absorb(self, [borrower]) — protocolo absorve a position
    ///      b. Comet.buyCollateral(asset, ..., baseAmount, self) — compra collateral com desconto
    ///      c. swap collateral → baseToken via swapSteps
    ///      d. repay flashloan Aave + fee 0.05%
    ///      e. profit residual em baseToken vai pro profitReceiver
    function executeCompoundLiquidation(CompoundLiquidationParams calldata params) external;

    /// @notice Modalidade 5: liquidação Morpho Blue (markets isolados)
    /// @dev Fluxo atômico:
    ///   1. flashloan(loanToken, amount) do Aave V3 — quantidade pra repaidShares OU pra cobrir seized
    ///   2. callback executeOperation:
    ///      a. Morpho.liquidate(marketParams, borrower, seized OR shares, ...) → recebe collateral
    ///      b. swap collateral → loanToken via swapSteps
    ///      c. repay flashloan Aave + fee 0.05%
    ///      d. profit residual em loanToken vai pro profitReceiver
    function executeMorphoLiquidation(MorphoLiquidationParams calldata params) external;

    // ════════ ADMIN (owner only) ════════

    function kill() external;
    function revive() external;
    function isKilled() external view returns (bool);

    function setMaxTradeWei(uint256 newMax) external;
    function maxTradeWei() external view returns (uint256);

    /// @notice Define cap específico pra um token. Se 0, usa fallback `maxTradeWei` global.
    /// @dev Fix H-02: cap por token resolve mistura de decimals entre ETH/WETH/USDC/USDT/WBTC.
    function setMaxTradePerToken(address token, uint256 newMax) external;
    /// @notice Retorna o cap aplicável a `token`: override específico se setado, senão fallback global.
    function getMaxTradeFor(address token) external view returns (uint256);

    function setOperator(address operator, bool allowed) external;
    function isOperator(address account) external view returns (bool);

    function rescueToken(address token, uint256 amount, address to) external;
}
