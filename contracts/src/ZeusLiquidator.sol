// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {
    IZeusLiquidator,
    LiquidationParams,
    CompoundLiquidationParams,
    MorphoLiquidationParams,
    LiquidatorOpType
} from "./interfaces/IZeusLiquidator.sol";
import {SwapStep, DexType, FlashSource} from "./interfaces/IZeusExecutor.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/aave/IFlashLoanSimpleReceiver.sol";
import {IPool} from "./interfaces/aave/IPool.sol";
import {IComet} from "./interfaces/compound/IComet.sol";
import {IMorpho, MarketParams, IMorphoFlashLoanCallback} from "./interfaces/morpho/IMorpho.sol";
import {IBalancerVault, IFlashLoanRecipient} from "./interfaces/balancer/IBalancerVault.sol";
import {UniswapV3Lib} from "./libraries/UniswapV3Lib.sol";
import {AerodromeLib} from "./libraries/AerodromeLib.sol";
import {IBribeManager, BribeConfig} from "./interfaces/IBribeManager.sol";

/// @title ZeusLiquidator — contrato dedicado a liquidations (Aave V3 + Compound III + Morpho Blue).
/// @notice Refatoração v8 (sucessor do ZeusExecutor v7 que estourou EIP-170).
///         Cada protocolo tem 2 variantes: sem bribe (v6 fluxo) + com bribe (v7 fluxo).
///         Bribe extraído pra BribeLib pra reuso com ZeusArbExecutor.
/// @dev Princípios de segurança:
///   - Atomic-only: qualquer falha reverte tudo
///   - Self-custody com circuit breakers (kill + maxTrade + minProfit obrigatório)
///   - Owner = multisig em produção
///   - Sem proxy upgradeable
contract ZeusLiquidator is
    IZeusLiquidator,
    IFlashLoanSimpleReceiver,
    IMorphoFlashLoanCallback,
    IFlashLoanRecipient,
    Ownable2Step,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    address public immutable AAVE_V3_POOL;
    /// @notice Morpho Blue singleton — fonte de flashloan 0% e auth do callback onMorphoFlashLoan.
    address public immutable MORPHO_SINGLETON;
    /// @notice Balancer V2 Vault — fonte de flashloan 0% e auth do callback receiveFlashLoan.
    address public immutable BALANCER_VAULT;
    /// @notice BribeManager standalone — paga bribe ao block.coinbase em paths WithBribe.
    /// @dev Imutável após deploy. Compartilhado com ZeusArbExecutor pra reuso de lógica.
    address public immutable BRIBE_MANAGER;
    uint256 public maxTradeWei;
    mapping(address => uint256) private _maxTradePerToken;
    mapping(address => bool) private _operators;
    /// @notice Routers DEX aprovados pro _executeSwaps (whitelist on-chain — defesa em profundidade).
    mapping(address => bool) public approvedRouter;

    /// @notice Router de swap não está na whitelist on-chain.
    error RouterNotApproved(address router);
    event RouterApprovalSet(address indexed router, bool approved);
    bool private _killed;

    address public weth;
    address public uniV3SwapRouter;

    /// @dev Flag transiente "eu iniciei este flashloan" (TSTORE/TLOAD Cancun, mesmo padrão do
    ///      BribeManager._PAY_IN_PROGRESS_SLOT, namespace keccak distinto → sem collision).
    ///      OBRIGATÓRIA contra hijack do Balancer: qualquer um pode chamar `vault.flashLoan(NÓS,...)`
    ///      e o Vault invoca nosso receiveFlashLoan com userData hostil; `msg.sender == vault` passa.
    ///      A flag (= keccak256(asset, amount), setada pelo entrypoint) é a única defesa.
    ///      Reset automático no fim da tx — impossível travar.
    uint256 private constant _FLASH_EXPECTED_SLOT =
        uint256(keccak256("zeus.liquidator.flashexpected.v1")) - 1;

    function _setFlashExpected(bytes32 v) internal {
        uint256 slot = _FLASH_EXPECTED_SLOT;
        assembly {
            tstore(slot, v)
        }
    }

    /// @dev Verifica que o callback corresponde a um flash que NÓS iniciamos e limpa a flag (one-shot).
    function _consumeFlashExpected(bytes32 expected) internal {
        uint256 slot = _FLASH_EXPECTED_SLOT;
        bytes32 stored;
        assembly {
            stored := tload(slot)
        }
        if (expected == bytes32(0) || stored != expected) revert InvalidCaller();
        assembly {
            tstore(slot, 0)
        }
    }

    constructor(
        address aaveV3Pool,
        address morphoSingleton,
        address balancerVault,
        address bribeManager,
        address initialOwner,
        uint256 initialMaxTradeWei
    ) Ownable(initialOwner) {
        if (aaveV3Pool == address(0) || initialOwner == address(0)) revert NotAuthorized();
        if (morphoSingleton == address(0) || balancerVault == address(0)) revert NotAuthorized();
        if (bribeManager == address(0)) revert NotAuthorized();
        AAVE_V3_POOL = aaveV3Pool;
        MORPHO_SINGLETON = morphoSingleton;
        BALANCER_VAULT = balancerVault;
        BRIBE_MANAGER = bribeManager;
        maxTradeWei = initialMaxTradeWei;
        _killed = true;
        emit Killed();
    }

    /// @dev Helper externo pra delegar bribe pro BribeManager. Centraliza o try/transfer pattern
    ///      e libera bytecode do contrato principal.
    /// @notice Audit Pass 4 fix M-01: aprova EXATAMENTE grossProfit (limite superior absoluto)
    ///         em vez de type(uint256).max. Defense em profundidade — mesmo se BribeManager tiver
    ///         bug, máximo que pode puxar é o profit que estamos disposto a "perder" pra bribe.
    function _callBribeManager(
        address profitToken,
        uint256 grossProfit,
        BribeConfig memory bribe,
        IBribeManager.BribeOpType opType,
        address operator
    ) internal returns (uint256 profitConsumed) {
        IERC20(profitToken).forceApprove(BRIBE_MANAGER, grossProfit);
        (, profitConsumed) = IBribeManager(BRIBE_MANAGER).pay(
            profitToken, grossProfit, bribe, weth, uniV3SwapRouter, opType, operator
        );
        IERC20(profitToken).forceApprove(BRIBE_MANAGER, 0);
    }

    modifier onlyOperator() {
        if (msg.sender != owner() && !_operators[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier whenAlive() {
        if (_killed) revert BotKilled();
        _;
    }

    // ════════ ENTRYPOINTS — sem bribe (v6) ════════

    /// @inheritdoc IZeusLiquidator
    function executeLiquidation(LiquidationParams calldata params)
        external
        override
        onlyOperator
        
        whenAlive
        nonReentrant
    {
        _validateLiquidationParams(params);
        uint256 cap = getMaxTradeFor(params.debtAsset);
        if (params.debtToCover > cap) revert TradeTooLarge(params.debtToCover, cap);

        uint256 debtBalanceBefore = IERC20(params.debtAsset).balanceOf(address(this));
        bytes memory encoded = abi.encode(
            LiquidatorOpType.Aave,
            params.debtAsset,
            abi.encode(params, msg.sender, debtBalanceBefore)
        );
        _initiateFlash(params.flashSource, params.debtAsset, params.debtToCover, encoded);
    }

    /// @inheritdoc IZeusLiquidator
    function executeCompoundLiquidation(CompoundLiquidationParams calldata params)
        external
        override
        onlyOperator
        
        whenAlive
        nonReentrant
    {
        _validateCompoundParams(params);
        address baseAsset = IComet(params.comet).baseToken();
        uint256 cap = getMaxTradeFor(baseAsset);
        if (params.baseAmount > cap) revert TradeTooLarge(params.baseAmount, cap);

        uint256 baseBalanceBefore = IERC20(baseAsset).balanceOf(address(this));
        bytes memory encoded = abi.encode(
            LiquidatorOpType.Compound,
            baseAsset,
            abi.encode(params, msg.sender, baseBalanceBefore)
        );
        _initiateFlash(params.flashSource, baseAsset, params.baseAmount, encoded);
    }

    /// @inheritdoc IZeusLiquidator
    function executeMorphoLiquidation(MorphoLiquidationParams calldata params)
        external
        override
        onlyOperator
        
        whenAlive
        nonReentrant
    {
        _validateMorphoParams(params);
        uint256 cap = getMaxTradeFor(params.loanToken);
        if (params.flashloanAmount > cap) revert TradeTooLarge(params.flashloanAmount, cap);

        uint256 loanBalanceBefore = IERC20(params.loanToken).balanceOf(address(this));
        bytes memory encoded = abi.encode(
            LiquidatorOpType.Morpho,
            params.loanToken,
            abi.encode(params, msg.sender, loanBalanceBefore)
        );
        _initiateFlash(params.flashSource, params.loanToken, params.flashloanAmount, encoded);
    }

    // ════════ ENTRYPOINTS — com bribe (v7) ════════

    /// @inheritdoc IZeusLiquidator
    function executeLiquidationWithBribe(LiquidationParams calldata params, BribeConfig calldata bribe)
        external
        override
        onlyOperator
        
        whenAlive
        nonReentrant
    {
        _validateLiquidationParams(params);
        IBribeManager(BRIBE_MANAGER).validateConfig(bribe);

        uint256 cap = getMaxTradeFor(params.debtAsset);
        if (params.debtToCover > cap) revert TradeTooLarge(params.debtToCover, cap);

        uint256 debtBalanceBefore = IERC20(params.debtAsset).balanceOf(address(this));
        bytes memory encoded = abi.encode(
            LiquidatorOpType.AaveWithBribe,
            params.debtAsset,
            abi.encode(params, bribe, msg.sender, debtBalanceBefore)
        );
        _initiateFlash(params.flashSource, params.debtAsset, params.debtToCover, encoded);
    }

    /// @inheritdoc IZeusLiquidator
    function executeCompoundLiquidationWithBribe(
        CompoundLiquidationParams calldata params,
        BribeConfig calldata bribe
    ) external override onlyOperator  whenAlive nonReentrant {
        _validateCompoundParams(params);
        IBribeManager(BRIBE_MANAGER).validateConfig(bribe);

        address baseAsset = IComet(params.comet).baseToken();
        uint256 cap = getMaxTradeFor(baseAsset);
        if (params.baseAmount > cap) revert TradeTooLarge(params.baseAmount, cap);

        uint256 baseBalanceBefore = IERC20(baseAsset).balanceOf(address(this));
        bytes memory encoded = abi.encode(
            LiquidatorOpType.CompoundWithBribe,
            baseAsset,
            abi.encode(params, bribe, msg.sender, baseBalanceBefore)
        );
        _initiateFlash(params.flashSource, baseAsset, params.baseAmount, encoded);
    }

    /// @inheritdoc IZeusLiquidator
    function executeMorphoLiquidationWithBribe(
        MorphoLiquidationParams calldata params,
        BribeConfig calldata bribe
    ) external override onlyOperator  whenAlive nonReentrant {
        _validateMorphoParams(params);
        IBribeManager(BRIBE_MANAGER).validateConfig(bribe);

        uint256 cap = getMaxTradeFor(params.loanToken);
        if (params.flashloanAmount > cap) revert TradeTooLarge(params.flashloanAmount, cap);

        uint256 loanBalanceBefore = IERC20(params.loanToken).balanceOf(address(this));
        bytes memory encoded = abi.encode(
            LiquidatorOpType.MorphoWithBribe,
            params.loanToken,
            abi.encode(params, bribe, msg.sender, loanBalanceBefore)
        );
        _initiateFlash(params.flashSource, params.loanToken, params.flashloanAmount, encoded);
    }

    // ════════ FLASHLOAN: INICIAÇÃO + CALLBACKS MULTI-FONTE ════════

    /// @notice Inicia o flashloan na fonte escolhida off-chain. O blob `encoded` é idêntico
    ///         entre fontes (`abi.encode(opType, asset, inner)`) → os cores decodificam igual.
    /// @dev Seta a flag transiente ANTES de chamar o provider — base da defesa anti-hijack.
    function _initiateFlash(
        FlashSource src,
        address asset,
        uint256 amount,
        bytes memory encoded
    ) internal {
        _setFlashExpected(keccak256(abi.encodePacked(asset, amount)));

        if (src == FlashSource.Aave) {
            IPool(AAVE_V3_POOL).flashLoanSimple(address(this), asset, amount, encoded, 0);
        } else if (src == FlashSource.Morpho) {
            IMorpho(MORPHO_SINGLETON).flashLoan(asset, amount, encoded);
        } else if (src == FlashSource.Balancer) {
            IERC20[] memory tokens = new IERC20[](1);
            tokens[0] = IERC20(asset);
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = amount;
            IBalancerVault(BALANCER_VAULT).flashLoan(address(this), tokens, amounts, encoded);
        } else {
            revert InvalidCaller();
        }
    }

    /// @notice Callback Aave V3. Premium = 0,05%.
    /// @inheritdoc IFlashLoanSimpleReceiver
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != AAVE_V3_POOL) revert InvalidCaller();
        if (initiator != address(this)) revert InvalidCaller();
        _consumeFlashExpected(keccak256(abi.encodePacked(asset, amount)));

        (LiquidatorOpType opType, address encAsset, bytes memory inner) =
            abi.decode(params, (LiquidatorOpType, address, bytes));
        if (encAsset != asset) revert InvalidCaller();

        _dispatchCore(opType, asset, amount, premium, inner);
        _repay(FlashSource.Aave, asset, amount, premium);
        return true;
    }

    /// @notice Callback Morpho Blue. Fee 0% → premium = 0. O callback NÃO recebe o token,
    ///         então lemos `asset` do params encodado pelo nosso próprio entrypoint.
    /// @inheritdoc IMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets, bytes calldata params) external override {
        if (msg.sender != MORPHO_SINGLETON) revert InvalidCaller();

        (LiquidatorOpType opType, address asset, bytes memory inner) =
            abi.decode(params, (LiquidatorOpType, address, bytes));
        _consumeFlashExpected(keccak256(abi.encodePacked(asset, assets)));

        _dispatchCore(opType, asset, assets, 0, inner);
        _repay(FlashSource.Morpho, asset, assets, 0);
    }

    /// @notice Callback Balancer V2. Fee 0% hoje (feeAmounts[0] == 0), mas repagamos
    ///         `amount + premium` por robustez caso o protocolo ligue fee no futuro.
    /// @dev 🔴 `_consumeFlashExpected` é a ÚNICA defesa contra hijack — sem ela, um atacante
    ///      chamaria `vault.flashLoan(NÓS, ...)` com userData hostil e cairia aqui com msg.sender == vault.
    /// @inheritdoc IFlashLoanRecipient
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory params
    ) external override {
        if (msg.sender != BALANCER_VAULT) revert InvalidCaller();

        address asset = address(tokens[0]);
        uint256 amount = amounts[0];
        uint256 premium = feeAmounts[0];
        _consumeFlashExpected(keccak256(abi.encodePacked(asset, amount)));

        (LiquidatorOpType opType, address encAsset, bytes memory inner) =
            abi.decode(params, (LiquidatorOpType, address, bytes));
        if (encAsset != asset) revert InvalidCaller();

        _dispatchCore(opType, asset, amount, premium, inner);
        _repay(FlashSource.Balancer, asset, amount, premium);
    }

    /// @notice Despacha pro core de protocolo correto. Reusado pelos 3 callbacks de fonte.
    /// @dev Os cores `_aaveCore`/`_compoundCore`/`_morphoCore` ficam INTACTOS — `premium` já é
    ///      parâmetro deles, então 0 (Morpho/Balancer) ou 0,05% (Aave) não exige editá-los.
    function _dispatchCore(
        LiquidatorOpType opType,
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        if (opType == LiquidatorOpType.Aave) {
            _aaveCore(asset, amount, premium, inner, /*withBribe*/ false);
        } else if (opType == LiquidatorOpType.AaveWithBribe) {
            _aaveCore(asset, amount, premium, inner, /*withBribe*/ true);
        } else if (opType == LiquidatorOpType.Compound) {
            _compoundCore(asset, amount, premium, inner, /*withBribe*/ false);
        } else if (opType == LiquidatorOpType.CompoundWithBribe) {
            _compoundCore(asset, amount, premium, inner, /*withBribe*/ true);
        } else if (opType == LiquidatorOpType.Morpho) {
            _morphoCore(asset, amount, premium, inner, /*withBribe*/ false);
        } else if (opType == LiquidatorOpType.MorphoWithBribe) {
            _morphoCore(asset, amount, premium, inner, /*withBribe*/ true);
        } else {
            revert InvalidCaller();
        }
    }

    /// @notice Repaga o flashloan à fonte, no estilo que cada protocolo exige.
    /// @dev Aave/Morpho: approve (provider puxa via transferFrom). Balancer: transfer direto pro Vault.
    function _repay(FlashSource src, address asset, uint256 amount, uint256 premium) internal {
        if (src == FlashSource.Aave) {
            IERC20(asset).forceApprove(AAVE_V3_POOL, amount + premium);
        } else if (src == FlashSource.Morpho) {
            IERC20(asset).forceApprove(MORPHO_SINGLETON, amount); // premium == 0
        } else {
            IERC20(asset).safeTransfer(BALANCER_VAULT, amount + premium);
        }
    }

    // ════════ INTERNAL HANDLERS ════════

    function _aaveCore(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner,
        bool withBribe
    ) internal {
        LiquidationParams memory liq;
        BribeConfig memory bribe;
        address operator;
        uint256 debtBalanceBefore;
        if (withBribe) {
            (liq, bribe, operator, debtBalanceBefore) =
                abi.decode(inner, (LiquidationParams, BribeConfig, address, uint256));
        } else {
            (liq, operator, debtBalanceBefore) = abi.decode(inner, (LiquidationParams, address, uint256));
        }

        if (asset != liq.debtAsset) revert InvalidCaller();

        uint256 collateralBefore = IERC20(liq.collateralAsset).balanceOf(address(this));

        IERC20(liq.debtAsset).forceApprove(AAVE_V3_POOL, liq.debtToCover);
        IPool(AAVE_V3_POOL).liquidationCall(liq.collateralAsset, liq.debtAsset, liq.user, liq.debtToCover, false);

        uint256 collateralReceived = IERC20(liq.collateralAsset).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        if (liq.swapSteps.length > 0) _executeSwaps(liq.swapSteps);

        uint256 amountOwed = amount + premium;
        uint256 debtAssetBalance = IERC20(liq.debtAsset).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + debtBalanceBefore;
        if (debtAssetBalance < minRequiredBalance) {
            revert FlashloanRepayShortfall(debtAssetBalance, minRequiredBalance);
        }

        uint256 grossProfit = debtAssetBalance - amountOwed - debtBalanceBefore;
        if (grossProfit < liq.minProfitWei) revert InsufficientProfit(grossProfit, liq.minProfitWei);

        uint256 finalProfit = grossProfit;
        if (withBribe) {
            // Delega bribe pro contrato BribeManager externo — economiza ~5k bytes no liquidator
            uint256 profitConsumed = _callBribeManager(
                liq.debtAsset, grossProfit, bribe, IBribeManager.BribeOpType.LiquidationWithBribe, operator
            );
            finalProfit = grossProfit - profitConsumed;
            if (finalProfit < liq.minProfitWei) revert InsufficientProfit(finalProfit, liq.minProfitWei);
        }

        if (liq.profitReceiver != address(this) && finalProfit > 0) {
            IERC20(liq.debtAsset).safeTransfer(liq.profitReceiver, finalProfit);
        }

        emit LiquidationExecuted(
            operator, liq.user, liq.collateralAsset, liq.debtAsset, liq.debtToCover, collateralReceived, finalProfit
        );
    }

    function _compoundCore(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner,
        bool withBribe
    ) internal {
        CompoundLiquidationParams memory cp;
        BribeConfig memory bribe;
        address operator;
        uint256 baseBalanceBefore;
        if (withBribe) {
            (cp, bribe, operator, baseBalanceBefore) =
                abi.decode(inner, (CompoundLiquidationParams, BribeConfig, address, uint256));
        } else {
            (cp, operator, baseBalanceBefore) = abi.decode(inner, (CompoundLiquidationParams, address, uint256));
        }

        if (asset != IComet(cp.comet).baseToken()) revert InvalidCaller();

        uint256 collateralBefore = IERC20(cp.collateralAsset).balanceOf(address(this));

        address[] memory accounts = new address[](1);
        accounts[0] = cp.borrower;
        IComet(cp.comet).absorb(address(this), accounts);

        IERC20(asset).forceApprove(cp.comet, cp.baseAmount);
        IComet(cp.comet).buyCollateral(cp.collateralAsset, cp.minCollateralReceived, cp.baseAmount, address(this));

        uint256 collateralReceived = IERC20(cp.collateralAsset).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        if (cp.swapSteps.length > 0) _executeSwaps(cp.swapSteps);

        uint256 amountOwed = amount + premium;
        uint256 baseBalance = IERC20(asset).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + baseBalanceBefore;
        if (baseBalance < minRequiredBalance) {
            revert FlashloanRepayShortfall(baseBalance, minRequiredBalance);
        }

        uint256 grossProfit = baseBalance - amountOwed - baseBalanceBefore;
        if (grossProfit < cp.minProfitWei) revert InsufficientProfit(grossProfit, cp.minProfitWei);

        uint256 finalProfit = grossProfit;
        if (withBribe) {
            uint256 profitConsumed = _callBribeManager(
                asset, grossProfit, bribe, IBribeManager.BribeOpType.CompoundLiquidationWithBribe, operator
            );
            finalProfit = grossProfit - profitConsumed;
            if (finalProfit < cp.minProfitWei) revert InsufficientProfit(finalProfit, cp.minProfitWei);
        }

        if (cp.profitReceiver != address(this) && finalProfit > 0) {
            IERC20(asset).safeTransfer(cp.profitReceiver, finalProfit);
        }

        emit CompoundLiquidationExecuted(
            operator, cp.comet, cp.borrower, cp.collateralAsset, cp.baseAmount, collateralReceived, finalProfit
        );
    }

    function _morphoCore(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner,
        bool withBribe
    ) internal {
        MorphoLiquidationParams memory mp;
        BribeConfig memory bribe;
        address operator;
        uint256 loanBalanceBefore;
        if (withBribe) {
            (mp, bribe, operator, loanBalanceBefore) =
                abi.decode(inner, (MorphoLiquidationParams, BribeConfig, address, uint256));
        } else {
            (mp, operator, loanBalanceBefore) = abi.decode(inner, (MorphoLiquidationParams, address, uint256));
        }

        if (asset != mp.loanToken) revert InvalidCaller();

        uint256 collateralBefore = IERC20(mp.collateralToken).balanceOf(address(this));

        IERC20(mp.loanToken).forceApprove(mp.morpho, amount);

        IMorpho(mp.morpho).liquidate(
            MarketParams({
                loanToken: mp.loanToken,
                collateralToken: mp.collateralToken,
                oracle: mp.oracle,
                irm: mp.irm,
                lltv: mp.lltv
            }),
            mp.borrower,
            mp.seizedAssets,
            mp.repaidShares,
            ""
        );

        IERC20(mp.loanToken).forceApprove(mp.morpho, 0);

        uint256 collateralReceived = IERC20(mp.collateralToken).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        if (mp.swapSteps.length > 0) _executeSwaps(mp.swapSteps);

        uint256 amountOwed = amount + premium;
        uint256 loanBalance = IERC20(mp.loanToken).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + loanBalanceBefore;
        if (loanBalance < minRequiredBalance) {
            revert FlashloanRepayShortfall(loanBalance, minRequiredBalance);
        }

        uint256 grossProfit = loanBalance - amountOwed - loanBalanceBefore;
        if (grossProfit < mp.minProfitWei) revert InsufficientProfit(grossProfit, mp.minProfitWei);

        uint256 finalProfit = grossProfit;
        if (withBribe) {
            uint256 profitConsumed = _callBribeManager(
                mp.loanToken, grossProfit, bribe, IBribeManager.BribeOpType.MorphoLiquidationWithBribe, operator
            );
            finalProfit = grossProfit - profitConsumed;
            if (finalProfit < mp.minProfitWei) revert InsufficientProfit(finalProfit, mp.minProfitWei);
        }

        if (mp.profitReceiver != address(this) && finalProfit > 0) {
            IERC20(mp.loanToken).safeTransfer(mp.profitReceiver, finalProfit);
        }

        emit MorphoLiquidationExecuted(
            operator, mp.borrower, mp.collateralToken, mp.loanToken, amount, collateralReceived, finalProfit
        );
    }

    // ════════ INTERNAL VALIDATIONS ════════

    function _validateLiquidationParams(LiquidationParams calldata p) internal pure {
        if (p.user == address(0)) revert NotAuthorized();
        if (p.collateralAsset == address(0)) revert NotAuthorized();
        if (p.debtAsset == address(0)) revert NotAuthorized();
        if (p.profitReceiver == address(0)) revert NotAuthorized();
    }

    function _validateCompoundParams(CompoundLiquidationParams calldata p) internal pure {
        if (p.comet == address(0) || p.borrower == address(0)) revert NotAuthorized();
        if (p.collateralAsset == address(0)) revert NotAuthorized();
        if (p.profitReceiver == address(0)) revert NotAuthorized();
    }

    function _validateMorphoParams(MorphoLiquidationParams calldata p) internal view {
        // Morpho Blue é singleton (1 endereço/chain) — trava o alvo de liquidate ao mesmo
        // endereço usado como fonte de flashloan, impedindo divergência.
        if (p.morpho != MORPHO_SINGLETON) revert NotAuthorized();
        if (p.borrower == address(0)) revert NotAuthorized();
        if (p.loanToken == address(0) || p.collateralToken == address(0)) revert NotAuthorized();
        if (p.profitReceiver == address(0)) revert NotAuthorized();
        if (p.flashloanAmount == 0) revert EmptySteps();
    }

    function _executeSwaps(SwapStep[] memory steps) internal {
        uint256 len = steps.length;
        for (uint256 i = 0; i < len;) {
            uint256 effectiveAmountIn = steps[i].amountIn == 0
                ? IERC20(steps[i].tokenIn).balanceOf(address(this))
                : steps[i].amountIn;
            uint256 cap = getMaxTradeFor(steps[i].tokenIn);
            if (effectiveAmountIn > cap) revert TradeTooLarge(effectiveAmountIn, cap);
            if (!approvedRouter[steps[i].router]) revert RouterNotApproved(steps[i].router);

            DexType dt = steps[i].dexType;
            if (dt == DexType.UniswapV3) {
                UniswapV3Lib.swap(steps[i]);
            } else if (dt == DexType.Aerodrome) {
                AerodromeLib.swap(steps[i]);
            } else {
                revert InvalidDexType(uint8(dt));
            }

            unchecked { ++i; }
        }
    }

    // ════════ ADMIN ════════

    function kill() external override onlyOwner {
        if (!_killed) { _killed = true; emit Killed(); }
    }

    function revive() external override onlyOwner {
        if (_killed) { _killed = false; emit Revived(); }
    }

    function isKilled() external view override returns (bool) { return _killed; }

    function setMaxTradeWei(uint256 newMax) external override onlyOwner {
        emit MaxTradeWeiUpdated(maxTradeWei, newMax);
        maxTradeWei = newMax;
    }

    function setMaxTradePerToken(address token, uint256 newMax) external override onlyOwner {
        if (token == address(0)) revert NotAuthorized();
        emit MaxTradePerTokenUpdated(token, _maxTradePerToken[token], newMax);
        _maxTradePerToken[token] = newMax;
    }

    function getMaxTradeFor(address token) public view override returns (uint256) {
        uint256 override_ = _maxTradePerToken[token];
        return override_ != 0 ? override_ : maxTradeWei;
    }

    function setOperator(address operator, bool allowed) external override onlyOwner {
        _operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    /// @notice Aprova/revoga um router DEX pra uso no _executeSwaps (whitelist on-chain).
    function setApprovedRouter(address router, bool approved) external onlyOwner {
        if (router == address(0)) revert NotAuthorized();
        approvedRouter[router] = approved;
        emit RouterApprovalSet(router, approved);
    }

    function isOperator(address account) external view override returns (bool) { return _operators[account]; }

    function rescueToken(address token, uint256 amount, address to) external override onlyOwner {
        if (to == address(0)) revert NotAuthorized();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, amount, to);
    }

    function setWeth(address newWeth) external override onlyOwner { weth = newWeth; }
    function setUniV3SwapRouter(address newRouter) external override onlyOwner { uniV3SwapRouter = newRouter; }

    // pause/unpause REMOVIDOS na v8 — kill switch (revive/kill) é o circuit breaker primário.
    // Manter 2 mecanismos pra mesma coisa adicionava bytecode sem ganho de segurança.

    receive() external payable {}
}
