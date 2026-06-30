// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IZeusMorphoPreLiquidator, PreMorphoLiquidationParams} from "./interfaces/IZeusMorphoPreLiquidator.sol";
import {IPreLiquidation, IPreLiquidationCallback} from "./interfaces/morpho/IPreLiquidation.sol";
import {SwapStep, DexType} from "./interfaces/IZeusExecutor.sol";
import {UniswapV3Lib} from "./libraries/UniswapV3Lib.sol";
import {AerodromeLib} from "./libraries/AerodromeLib.sol";
import {SlipstreamLib} from "./libraries/SlipstreamLib.sol";
import {UniswapV2Lib} from "./libraries/UniswapV2Lib.sol";
import {PancakeV3Lib} from "./libraries/PancakeV3Lib.sol";

/// @title ZeusMorphoPreLiquidator — pré-liquidação Morpho (contrato satélite).
/// @notice SEPARADO do ZeusLiquidator (EIP-170: ZeusLiquidator já apertado). Pré-liquidação usa o callback
///         `onPreLiquidate` do contrato PreLiquidation por-mercado → NÃO precisa de flashloan (o colateral é
///         adiantado pelo callback). Por isso este satélite é enxuto (sem plumbing Aave/Morpho/Balancer).
/// @dev Princípios (iguais ao resto da família v8):
///   - Atomic-only: falha em qualquer passo reverte tudo (só gás). `minProfitWei` é o backstop on-chain.
///   - Self-custody + circuit breakers: kill switch (começa killed) + `maxTradeWei` por-token + `onlyOperator`.
///   - **Stablecoin-only**: SEMPRE vende o colateral seizado → loanToken (stable); o surplus (lucro) fica em
///     stablecoin. NÃO existe modo inventário (reter colateral) — sem aposta direcional.
///   - Callback blindado: whitelist default-deny de contratos PreLiquidation + flag transiente "eu iniciei".
///   - Owner = multisig em produção · sem proxy upgradeable.
contract ZeusMorphoPreLiquidator is IZeusMorphoPreLiquidator, IPreLiquidationCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public maxTradeWei;
    mapping(address => uint256) private _maxTradePerToken;
    mapping(address => bool) private _operators;
    /// @notice Whitelist (default-deny) de contratos PreLiquidation autorizados a chamar nosso callback.
    mapping(address => bool) private _approvedPreLiquidation;
    /// @notice Whitelist (default-deny) de routers DEX aprovados a receber approve+swap (paridade v10 com a família).
    mapping(address => bool) public approvedRouter;
    bool private _killed;

    error RouterNotApproved(address router);
    event ApprovedRouterSet(address indexed router, bool approved);
    event EthRescued(address indexed to, uint256 amount);

    /// @dev Flag transiente "eu iniciei esta pré-liquidação neste PreLiquidation" — defesa contra callback
    ///      inesperado/hijack (além da whitelist). Guarda o endereço esperado do `msg.sender` do callback.
    uint256 private constant _EXPECTED_SLOT = uint256(keccak256("zeus.morphopreliq.expected.v1")) - 1;

    function _setExpected(address preLiq) internal {
        uint256 slot = _EXPECTED_SLOT;
        assembly {
            tstore(slot, preLiq)
        }
    }

    /// @dev Lê o esperado SEM limpar (a limpeza acontece no fim do tx automaticamente — transient storage).
    function _expected() internal view returns (address e) {
        uint256 slot = _EXPECTED_SLOT;
        assembly {
            e := tload(slot)
        }
    }

    function _clearExpected() internal {
        uint256 slot = _EXPECTED_SLOT;
        assembly {
            tstore(slot, 0)
        }
    }

    modifier onlyOperator() {
        if (msg.sender != owner() && !_operators[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier whenAlive() {
        if (_killed) revert BotKilled();
        _;
    }

    constructor(address initialOwner, uint256 initialMaxTradeWei) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert NotAuthorized();
        maxTradeWei = initialMaxTradeWei;
        _killed = true; // fail-safe: sobe travado, owner dá revive() após configurar
        emit Killed();
    }

    // ════════ ENTRYPOINT ════════

    /// @inheritdoc IZeusMorphoPreLiquidator
    function executePreMorphoLiquidation(PreMorphoLiquidationParams calldata params)
        external
        override
        onlyOperator
        whenAlive
        nonReentrant
    {
        // Validação (default-deny no PreLiquidation; swapSteps obrigatório = sem modo inventário).
        if (!_approvedPreLiquidation[params.preLiquidation]) revert NotApprovedPreLiquidation(params.preLiquidation);
        if (params.borrower == address(0) || params.profitReceiver == address(0)) revert NotAuthorized();
        if (params.loanToken == address(0) || params.collateralToken == address(0)) revert NotAuthorized();
        if (params.swapSteps.length == 0) revert EmptySwapSteps();

        uint256 balanceBefore = IERC20(params.loanToken).balanceOf(address(this));

        // Arma a flag transiente e dispara a pré-liquidação. O PreLiquidation vai nos entregar o colateral
        // e chamar `onPreLiquidate` (onde vendemos → loanToken e aprovamos o repay).
        _setExpected(params.preLiquidation);
        IPreLiquidation(params.preLiquidation)
            .preLiquidate(
                params.borrower,
                params.seizedAssets,
                params.repaidShares,
                abi.encode(params.loanToken, params.swapSteps)
            );
        _clearExpected();

        // Lucro = surplus de loanToken (stable) após o PreLiquidation cobrar o repay.
        uint256 profit = IERC20(params.loanToken).balanceOf(address(this)) - balanceBefore;
        if (profit < params.minProfitWei) revert InsufficientProfit(profit, params.minProfitWei);

        if (params.profitReceiver != address(this) && profit > 0) {
            IERC20(params.loanToken).safeTransfer(params.profitReceiver, profit);
        }

        emit PreMorphoLiquidationExecuted(
            msg.sender,
            params.preLiquidation,
            params.borrower,
            params.loanToken,
            /*repaidAssets*/
            0,
            profit
        );
    }

    // ════════ CALLBACK (chamado pelo contrato PreLiquidation) ════════

    /// @inheritdoc IPreLiquidationCallback
    function onPreLiquidate(uint256 repaidAssets, bytes calldata data) external override {
        // Guard duplo: o caller TEM que estar na whitelist E ser o PreLiquidation que NÓS acabamos de chamar.
        if (!_approvedPreLiquidation[msg.sender] || msg.sender != _expected()) revert InvalidCaller();

        (address loanToken, SwapStep[] memory steps) = abi.decode(data, (address, SwapStep[]));

        // Vende TODO o colateral seizado → loanToken (stable). Sem reter colateral.
        _executeSwaps(steps);

        // Aprova o loanToken PRO PRÓPRIO PreLiquidation (msg.sender) — ele puxa `repaidAssets` via transferFrom.
        IERC20(loanToken).forceApprove(msg.sender, repaidAssets);
    }

    // ════════ INTERNAL ════════

    /// @dev Copiado do padrão da família (ZeusArbExecutor): loop multi-DEX, encadeia com amountIn=0,
    ///      enforce do cap por-token. Suporta UniV3/Aerodrome/Slipstream/UniV2/PancakeV3.
    function _executeSwaps(SwapStep[] memory steps) internal {
        uint256 len = steps.length;
        for (uint256 i = 0; i < len;) {
            // Whitelist default-deny do router (paridade v10): bloqueia approve+call a endereço arbitrário.
            if (!approvedRouter[steps[i].router]) revert RouterNotApproved(steps[i].router);
            uint256 effectiveAmountIn =
                steps[i].amountIn == 0 ? IERC20(steps[i].tokenIn).balanceOf(address(this)) : steps[i].amountIn;
            uint256 cap = getMaxTradeFor(steps[i].tokenIn);
            if (effectiveAmountIn > cap) revert TradeTooLarge(effectiveAmountIn, cap);

            DexType dt = steps[i].dexType;
            if (dt == DexType.UniswapV3) {
                UniswapV3Lib.swap(steps[i]);
            } else if (dt == DexType.Aerodrome) {
                AerodromeLib.swap(steps[i]);
            } else if (dt == DexType.Slipstream) {
                SlipstreamLib.swap(steps[i]);
            } else if (dt == DexType.UniswapV2) {
                UniswapV2Lib.swap(steps[i]);
            } else if (dt == DexType.PancakeV3) {
                PancakeV3Lib.swap(steps[i]);
            } else {
                revert InvalidDexType(uint8(dt));
            }

            unchecked {
                ++i;
            }
        }
    }

    // ════════ ADMIN (owner only) ════════

    function kill() external override onlyOwner {
        if (!_killed) {
            _killed = true;
            emit Killed();
        }
    }

    function revive() external override onlyOwner {
        if (_killed) {
            _killed = false;
            emit Revived();
        }
    }

    function isKilled() external view override returns (bool) {
        return _killed;
    }

    function setOperator(address operator, bool allowed) external override onlyOwner {
        _operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function isOperator(address account) external view override returns (bool) {
        return _operators[account];
    }

    function setApprovedPreLiquidation(address preLiquidation, bool allowed) external override onlyOwner {
        if (preLiquidation == address(0)) revert NotAuthorized();
        _approvedPreLiquidation[preLiquidation] = allowed;
        emit ApprovedPreLiquidationSet(preLiquidation, allowed);
    }

    function isApprovedPreLiquidation(address preLiquidation) external view override returns (bool) {
        return _approvedPreLiquidation[preLiquidation];
    }

    function setApprovedRouter(address router, bool approved) external onlyOwner {
        if (router == address(0)) revert NotAuthorized();
        approvedRouter[router] = approved;
        emit ApprovedRouterSet(router, approved);
    }

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

    function rescueToken(address token, uint256 amount, address to) external override onlyOwner {
        if (to == address(0)) revert NotAuthorized();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, amount, to);
    }

    /// @notice Resgata ETH preso (fluxos são ERC20; ETH só chega por engano/dust).
    function rescueETH(address to) external onlyOwner {
        if (to == address(0)) revert NotAuthorized();
        uint256 bal = address(this).balance;
        (bool ok,) = to.call{value: bal}("");
        if (!ok) revert NotAuthorized();
        emit EthRescued(to, bal);
    }

    receive() external payable {}
}
