// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IZeusUniswapXFiller, UniswapXFillParams} from "./interfaces/IZeusUniswapXFiller.sol";
import {IReactor, IReactorCallback, ResolvedOrder, OutputToken} from "./interfaces/uniswapx/IReactor.sol";
import {SwapStep, DexType} from "./interfaces/IZeusExecutor.sol";
import {UniswapV3Lib} from "./libraries/UniswapV3Lib.sol";
import {AerodromeLib} from "./libraries/AerodromeLib.sol";
import {SlipstreamLib} from "./libraries/SlipstreamLib.sol";
import {UniswapV2Lib} from "./libraries/UniswapV2Lib.sol";
import {PancakeV3Lib} from "./libraries/PancakeV3Lib.sol";
import {UniswapV4Lib} from "./libraries/UniswapV4Lib.sol";

/// @title ZeusUniswapXFiller — filler UniswapX (contrato satélite, Motor 2).
/// @notice SEPARADO dos demais (EIP-170). Modelo dex-sourced: o reactor entrega o token de entrada no
///         callback → fazemos o swap multi-DEX (`_executeSwaps`) → aprovamos as saídas → o reactor as puxa.
///         **Sem capital, sem flashloan, atômico** (mesmo modelo do `ZeusMorphoPreLiquidator`).
/// @dev Princípios (iguais ao resto da família v8):
///   - Atomic-only: falha em qualquer passo reverte tudo (só gás). `minProfitWei` é o backstop on-chain.
///   - Circuit breakers: kill switch (começa killed) + `maxTradeWei` por-token + `onlyOperator`.
///   - Callback blindado: whitelist default-deny de reactors + flag transiente "eu iniciei".
///   - Sem modo inventário: `swapSteps` obrigatório. Lucro = surplus em `profitToken`.
///   - Owner = multisig em produção · sem proxy upgradeable.
contract ZeusUniswapXFiller is IZeusUniswapXFiller, IReactorCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public maxTradeWei;
    mapping(address => uint256) private _maxTradePerToken;
    mapping(address => bool) private _operators;
    /// @notice Whitelist (default-deny) de reactors UniswapX autorizados a chamar nosso callback.
    mapping(address => bool) private _approvedReactor;
    /// @notice Whitelist (default-deny) de routers DEX aprovados a receber approve+swap (paridade v10).
    mapping(address => bool) public approvedRouter;
    bool private _killed;

    error RouterNotApproved(address router);
    event ApprovedRouterSet(address indexed router, bool approved);
    event EthRescued(address indexed to, uint256 amount);

    /// @dev Flag transiente "eu iniciei este fill neste reactor" — defesa anti-hijack (além da whitelist).
    uint256 private constant _EXPECTED_SLOT = uint256(keccak256("zeus.uniswapxfiller.expected.v1")) - 1;

    function _setExpected(address reactor) internal {
        uint256 slot = _EXPECTED_SLOT;
        assembly {
            tstore(slot, reactor)
        }
    }

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

    /// @inheritdoc IZeusUniswapXFiller
    function executeFill(UniswapXFillParams calldata params) external override onlyOperator whenAlive nonReentrant {
        if (!_approvedReactor[params.reactor]) revert NotApprovedReactor(params.reactor);
        if (params.swapSteps.length == 0) revert EmptySwapSteps();
        if (params.profitReceiver == address(0) || params.profitToken == address(0)) revert NotAuthorized();

        uint256 balanceBefore = IERC20(params.profitToken).balanceOf(address(this));

        // Arma a flag transiente e dispara o fill. O reactor entrega o input e chama `reactorCallback`
        // (onde fazemos o swap e aprovamos as saídas); depois ele puxa as saídas → swapper.
        _setExpected(params.reactor);
        IReactor(params.reactor).executeWithCallback(params.order, abi.encode(params.swapSteps));
        _clearExpected();

        // Lucro = surplus de profitToken após o reactor puxar as saídas.
        uint256 profit = IERC20(params.profitToken).balanceOf(address(this)) - balanceBefore;
        if (profit < params.minProfitWei) revert InsufficientProfit(profit, params.minProfitWei);

        if (params.profitReceiver != address(this) && profit > 0) {
            IERC20(params.profitToken).safeTransfer(params.profitReceiver, profit);
        }

        emit UniswapXFillExecuted(msg.sender, params.reactor, params.profitToken, profit);
    }

    // ════════ CALLBACK (chamado pelo reactor UniswapX) ════════

    /// @inheritdoc IReactorCallback
    function reactorCallback(ResolvedOrder[] memory resolvedOrders, bytes memory callbackData) external override {
        // Guard duplo: o caller TEM que estar na whitelist E ser o reactor que NÓS acabamos de chamar.
        if (!_approvedReactor[msg.sender] || msg.sender != _expected()) revert InvalidCaller();

        SwapStep[] memory steps = abi.decode(callbackData, (SwapStep[]));

        // Produz os tokens de saída (e o surplus) com o input que o reactor já nos entregou.
        _executeSwaps(steps);

        // Aprova o reactor a puxar CADA output (acumula p/ mesmo token aparecendo em múltiplos outputs).
        uint256 n = resolvedOrders.length;
        for (uint256 i = 0; i < n;) {
            OutputToken[] memory outs = resolvedOrders[i].outputs;
            uint256 m = outs.length;
            for (uint256 j = 0; j < m;) {
                if (outs[j].token == address(0)) revert NativeOutputUnsupported();
                uint256 cur = IERC20(outs[j].token).allowance(address(this), msg.sender);
                IERC20(outs[j].token).forceApprove(msg.sender, cur + outs[j].amount);
                unchecked {
                    ++j;
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    // ════════ INTERNAL ════════

    /// @dev Loop multi-DEX (padrão da família): encadeia com amountIn=0, enforce do cap por-token.
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
            } else if (dt == DexType.UniswapV4) {
                UniswapV4Lib.swap(steps[i]);
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

    function setApprovedReactor(address reactor, bool allowed) external override onlyOwner {
        if (reactor == address(0)) revert NotAuthorized();
        _approvedReactor[reactor] = allowed;
        emit ApprovedReactorSet(reactor, allowed);
    }

    function isApprovedReactor(address reactor) external view override returns (bool) {
        return _approvedReactor[reactor];
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

    /// @notice Resgata ETH preso (este filler é dex-sourced/ERC20-only; ETH só chega por engano).
    function rescueETH(address to) external onlyOwner {
        if (to == address(0)) revert NotAuthorized();
        uint256 bal = address(this).balance;
        (bool ok,) = to.call{value: bal}("");
        if (!ok) revert NotAuthorized();
        emit EthRescued(to, bal);
    }

    receive() external payable {}
}
