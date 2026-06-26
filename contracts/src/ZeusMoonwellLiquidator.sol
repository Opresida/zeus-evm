// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IZeusMoonwellLiquidator, MoonwellLiquidationParams} from "./interfaces/IZeusMoonwellLiquidator.sol";
import {SwapStep, DexType, FlashSource} from "./interfaces/IZeusExecutor.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/aave/IFlashLoanSimpleReceiver.sol";
import {IPool} from "./interfaces/aave/IPool.sol";
import {IMorpho, IMorphoFlashLoanCallback} from "./interfaces/morpho/IMorpho.sol";
import {IBalancerVault, IFlashLoanRecipient} from "./interfaces/balancer/IBalancerVault.sol";
import {IMToken} from "./interfaces/moonwell/IMoonwell.sol";
import {UniswapV3Lib} from "./libraries/UniswapV3Lib.sol";
import {AerodromeLib} from "./libraries/AerodromeLib.sol";

/// @title ZeusMoonwellLiquidator — liquidations Moonwell (Compound V2 fork).
/// @notice Contrato SEPARADO do ZeusLiquidator por EIP-170 (ZeusLiquidator já em 77%).
///         Moonwell usa mTokens + liquidateBorrow + redeem (mecânica Compound V2),
///         distinta de Aave/Compound III/Morpho.
/// @dev Mesmos princípios de segurança do ZeusLiquidator:
///   - Atomic-only (flashloan Aave V3 + tudo num callback)
///   - Self-custody com circuit breakers (kill + maxTrade + minProfit obrigatório)
///   - Owner = multisig em produção · Sem proxy upgradeable
///   - v1 SEM bribe (igual Compound III/Morpho atual) — adicionar depois se necessário
contract ZeusMoonwellLiquidator is
    IZeusMoonwellLiquidator,
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
    uint256 public maxTradeWei;
    mapping(address => uint256) private _maxTradePerToken;
    mapping(address => bool) private _operators;
    /// @notice Routers DEX aprovados pro _executeSwaps (whitelist on-chain — defesa em profundidade).
    mapping(address => bool) public approvedRouter;
    bool private _killed;

    /// @notice Router de swap não está na whitelist on-chain.
    error RouterNotApproved(address router);
    event RouterApprovalSet(address indexed router, bool approved);

    /// @dev Flag transiente "eu iniciei este flashloan" — OBRIGATÓRIA contra hijack do Balancer.
    uint256 private constant _FLASH_EXPECTED_SLOT =
        uint256(keccak256("zeus.moonwell.flashexpected.v1")) - 1;

    function _setFlashExpected(bytes32 v) internal {
        uint256 slot = _FLASH_EXPECTED_SLOT;
        assembly {
            tstore(slot, v)
        }
    }

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

    modifier onlyOperator() {
        if (!_operators[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier whenAlive() {
        if (_killed) revert Killed_();
        _;
    }

    constructor(
        address aaveV3Pool,
        address morphoSingleton,
        address balancerVault,
        address initialOwner,
        uint256 initialMaxTradeWei
    ) Ownable(initialOwner) {
        if (aaveV3Pool == address(0) || initialOwner == address(0)) revert NotAuthorized();
        if (morphoSingleton == address(0) || balancerVault == address(0)) revert NotAuthorized();
        AAVE_V3_POOL = aaveV3Pool;
        MORPHO_SINGLETON = morphoSingleton;
        BALANCER_VAULT = balancerVault;
        maxTradeWei = initialMaxTradeWei;
        _killed = true;
        emit Killed();
    }

    // ════════ ENTRYPOINT ════════

    /// @inheritdoc IZeusMoonwellLiquidator
    function executeMoonwellLiquidation(MoonwellLiquidationParams calldata params)
        external
        override
        onlyOperator
        whenAlive
        nonReentrant
    {
        _validate(params);
        uint256 cap = getMaxTradeFor(params.borrowedUnderlying);
        if (params.flashloanAmount > cap) revert TradeTooLarge(params.flashloanAmount, cap);

        uint256 loanBalanceBefore = IERC20(params.borrowedUnderlying).balanceOf(address(this));
        bytes memory encoded = abi.encode(
            params.borrowedUnderlying,
            abi.encode(params, msg.sender, loanBalanceBefore)
        );
        _initiateFlash(params.flashSource, params.borrowedUnderlying, params.flashloanAmount, encoded);
    }

    // ════════ FLASHLOAN: INICIAÇÃO + CALLBACKS MULTI-FONTE ════════

    /// @notice Inicia o flashloan na fonte escolhida off-chain. Blob `encoded` idêntico entre fontes.
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

        (address encAsset, bytes memory inner) = abi.decode(params, (address, bytes));
        if (encAsset != asset) revert InvalidCaller();

        _moonwellCore(asset, amount, premium, inner);
        _repay(FlashSource.Aave, asset, amount, premium);
        return true;
    }

    /// @notice Callback Morpho Blue. Fee 0% → premium = 0. Lemos `asset` do params encodado.
    /// @inheritdoc IMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets, bytes calldata params) external override {
        if (msg.sender != MORPHO_SINGLETON) revert InvalidCaller();

        (address asset, bytes memory inner) = abi.decode(params, (address, bytes));
        _consumeFlashExpected(keccak256(abi.encodePacked(asset, assets)));

        _moonwellCore(asset, assets, 0, inner);
        _repay(FlashSource.Morpho, asset, assets, 0);
    }

    /// @notice Callback Balancer V2. Fee 0% hoje; repaga amount+premium por robustez.
    /// @dev 🔴 `_consumeFlashExpected` é a ÚNICA defesa contra hijack via `vault.flashLoan(NÓS,...)`.
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

        (address encAsset, bytes memory inner) = abi.decode(params, (address, bytes));
        if (encAsset != asset) revert InvalidCaller();

        _moonwellCore(asset, amount, premium, inner);
        _repay(FlashSource.Balancer, asset, amount, premium);
    }

    /// @notice Repaga o flashloan à fonte. Aave/Morpho: approve. Balancer: transfer direto pro Vault.
    function _repay(FlashSource src, address asset, uint256 amount, uint256 premium) internal {
        if (src == FlashSource.Aave) {
            IERC20(asset).forceApprove(AAVE_V3_POOL, amount + premium);
        } else if (src == FlashSource.Morpho) {
            IERC20(asset).forceApprove(MORPHO_SINGLETON, amount); // premium == 0
        } else {
            IERC20(asset).safeTransfer(BALANCER_VAULT, amount + premium);
        }
    }

    /// @notice Lógica de liquidation Moonwell, agnóstica à fonte do flashloan.
    /// @dev `premium` é parâmetro (0 pra Morpho/Balancer, 0,05% pra Aave) — mesma mecânica do v1.
    ///      O repago do flashloan foi extraído pra `_repay` (chamado pelo callback de cada fonte).
    function _moonwellCore(address asset, uint256 amount, uint256 premium, bytes memory inner) internal {
        (MoonwellLiquidationParams memory mp, address operator, uint256 loanBalanceBefore) =
            abi.decode(inner, (MoonwellLiquidationParams, address, uint256));

        if (asset != mp.borrowedUnderlying) revert InvalidCaller();

        uint256 collateralBefore = IERC20(mp.collateralUnderlying).balanceOf(address(this));

        // 1. Aprova mTokenBorrowed pra puxar repayAmount do underlying borrowed
        IERC20(mp.borrowedUnderlying).forceApprove(mp.mTokenBorrowed, mp.repayAmount);

        // 2. liquidateBorrow: paga dívida, recebe mTokens do collateral (cTokens seizados)
        uint256 errLiq = IMToken(mp.mTokenBorrowed).liquidateBorrow(
            mp.borrower, mp.repayAmount, mp.mTokenCollateral
        );
        if (errLiq != 0) revert LiquidationFailed(errLiq);

        IERC20(mp.borrowedUnderlying).forceApprove(mp.mTokenBorrowed, 0);

        // 3. Redeem dos mTokens de collateral seizados → underlying collateral
        uint256 seizedMTokens = IMToken(mp.mTokenCollateral).balanceOf(address(this));
        if (seizedMTokens == 0) revert InsufficientProfit(0, 1);
        uint256 errRedeem = IMToken(mp.mTokenCollateral).redeem(seizedMTokens);
        if (errRedeem != 0) revert RedeemFailed(errRedeem);

        uint256 collateralReceived = IERC20(mp.collateralUnderlying).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        // 4. Swap collateral → borrowed
        if (mp.swapSteps.length > 0) _executeSwaps(mp.swapSteps);

        // 5. Valida repagamento do flashloan + profit floor
        uint256 amountOwed = amount + premium;
        uint256 loanBalance = IERC20(mp.borrowedUnderlying).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + loanBalanceBefore;
        if (loanBalance < minRequiredBalance) revert FlashloanRepayShortfall(loanBalance, minRequiredBalance);

        uint256 grossProfit = loanBalance - amountOwed - loanBalanceBefore;
        if (grossProfit < mp.minProfitWei) revert InsufficientProfit(grossProfit, mp.minProfitWei);

        if (mp.profitReceiver != address(this) && grossProfit > 0) {
            IERC20(mp.borrowedUnderlying).safeTransfer(mp.profitReceiver, grossProfit);
        }

        emit MoonwellLiquidationExecuted(
            operator, mp.borrower, mp.mTokenCollateral, mp.borrowedUnderlying,
            mp.repayAmount, collateralReceived, grossProfit
        );
        // Repago do flashloan: feito por `_repay(...)` no callback de cada fonte.
    }

    // ════════ INTERNAL ════════

    function _validate(MoonwellLiquidationParams calldata p) internal pure {
        if (p.mTokenBorrowed == address(0) || p.borrowedUnderlying == address(0)) revert NotAuthorized();
        if (p.mTokenCollateral == address(0) || p.collateralUnderlying == address(0)) revert NotAuthorized();
        if (p.borrower == address(0) || p.profitReceiver == address(0)) revert NotAuthorized();
        if (p.repayAmount == 0 || p.flashloanAmount == 0) revert EmptySteps();
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

    function isOperator(address account) external view override returns (bool) { return _operators[account]; }

    /// @notice Aprova/revoga um router DEX pra uso no _executeSwaps (whitelist on-chain).
    function setApprovedRouter(address router, bool approved) external onlyOwner {
        if (router == address(0)) revert NotAuthorized();
        approvedRouter[router] = approved;
        emit RouterApprovalSet(router, approved);
    }

    function rescueToken(address token, uint256 amount, address to) external override onlyOwner {
        if (to == address(0)) revert NotAuthorized();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, amount, to);
    }

    receive() external payable {}
}
