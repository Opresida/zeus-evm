// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBribeManager, BribeConfig} from "./interfaces/IBribeManager.sol";

/// @notice WETH9 mínima — necessária pra unwrap antes do coinbase.transfer.
interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice UniV3 SwapRouter02 mínima — usada pro swap inline profitToken → WETH.
interface IUniV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title BribeManager — contrato standalone que processa bribe ao block.coinbase.
/// @notice Solução pra EIP-170 size limit do v7 monolítico. Compartilhado por
///         ZeusLiquidator + ZeusArbExecutor (1 BribeManager, 2 consumidores).
///
/// @dev Estratégia de execução:
///   - Caller (Liquidator ou ArbExecutor) approva BRIBE_MANAGER pra puxar profitToken
///   - BribeManager faz transferFrom(caller, self, bribeProfitTarget)
///   - Se profitToken == WETH: withdraw direto → coinbase.transfer
///   - Senão: swap profitToken → WETH via UniV3 → withdraw → coinbase.transfer
///   - Emit BribePaid (todo log de bribe sai DESTE contrato)
///
/// Segurança:
///   - nonReentrant (defesa em profundidade — coinbase pode ser contrato malicioso)
///   - Validações on-chain (InvalidBribeConfig, BribeExceedsProfit, BribeSwapFailed)
///   - Reset approve em catch (caso swap reverta)
///   - Não tem owner — é stateless library-as-contract
contract BribeManager is IBribeManager, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant ABSOLUTE_BRIBE_CAP_BPS = 9_900;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @dev Audit Pass 4 fix M-02: flag que controla quem pode mandar ETH.
    /// True somente durante uma chamada pay() ativa (set em pay, reset no fim).
    /// receive() rejeita ETH quando false → impede ETH preso por terceiros.
    bool private _payInProgress;

    /// @inheritdoc IBribeManager
    function validateConfig(BribeConfig calldata bribe) external pure override {
        if (bribe.bribeBps == 0 && bribe.minBribeWei == 0) return; // no-op
        if (bribe.bribeBps == 0) revert InvalidBribeConfig();
        if (bribe.bribeBps > BPS_DENOMINATOR) revert InvalidBribeConfig();
        if (bribe.bribeMaxBps == 0 || bribe.bribeMaxBps > ABSOLUTE_BRIBE_CAP_BPS) revert InvalidBribeConfig();
        if (bribe.swapSlippageBps > 1_000) revert InvalidBribeConfig();
    }

    /// @inheritdoc IBribeManager
    function pay(
        address profitToken,
        uint256 grossProfit,
        BribeConfig calldata bribe,
        address weth,
        address swapRouter,
        BribeOpType opType,
        address operator
    ) external override nonReentrant returns (uint256 bribeNativeWei, uint256 profitTokenConsumed) {
        // No-op shortcut
        if (bribe.bribeBps == 0 && bribe.minBribeWei == 0) return (0, 0);

        // M-02 fix: sinaliza pra receive() que estamos em contexto autorizado
        _payInProgress = true;

        // Clamp bribeBps contra bribeMaxBps (runtime guard)
        uint256 effectiveBps = bribe.bribeBps > bribe.bribeMaxBps ? bribe.bribeMaxBps : bribe.bribeBps;
        uint256 bribeProfitTarget = (grossProfit * effectiveBps) / BPS_DENOMINATOR;

        if (bribeProfitTarget == 0 && bribe.minBribeWei == 0) return (0, 0);
        if (bribeProfitTarget >= grossProfit) revert BribeExceedsProfit(bribeProfitTarget, grossProfit);

        // Fast path: profitToken == WETH → só transferFrom + withdraw + transfer
        if (profitToken == weth) {
            if (weth == address(0)) revert WethNotConfigured();
            uint256 bribeWeth = bribeProfitTarget < bribe.minBribeWei ? bribe.minBribeWei : bribeProfitTarget;
            if (bribeWeth >= grossProfit) revert BribeExceedsProfit(bribeWeth, grossProfit);

            IERC20(weth).safeTransferFrom(msg.sender, address(this), bribeWeth);
            IWETH9(weth).withdraw(bribeWeth);
            _sendToCoinbase(bribeWeth, opType, operator, grossProfit, grossProfit - bribeWeth);
            _payInProgress = false;
            return (bribeWeth, bribeWeth);
        }

        // Slow path: swap profitToken → WETH via UniV3
        if (weth == address(0)) revert WethNotConfigured();
        if (swapRouter == address(0)) revert SwapRouterNotConfigured();
        if (bribe.swapFeeTier == 0) revert InvalidBribeConfig();

        // Pull profitToken do caller (caller já approvou BRIBE_MANAGER)
        IERC20(profitToken).safeTransferFrom(msg.sender, address(this), bribeProfitTarget);

        // Approve swap router
        IERC20(profitToken).forceApprove(swapRouter, bribeProfitTarget);

        // Audit Pass 4 fix H-01: amountOutMinimum = bribe.minBribeWei
        // Antes: amountOutMinimum=0 → atacante podia sandwich o swap movendo preço
        // do pool profitToken/WETH (rouba até bribeProfitTarget - minBribeWei).
        // Agora: swap reverte cedo se sandwich for agressivo o suficiente. Bot off-chain
        // DEVE setar minBribeWei adequado (~90% do quote esperado) pra slippage protection.
        uint256 wethReceived;
        try IUniV3SwapRouter(swapRouter).exactInputSingle(
            IUniV3SwapRouter.ExactInputSingleParams({
                tokenIn: profitToken,
                tokenOut: weth,
                fee: bribe.swapFeeTier,
                recipient: address(this),
                amountIn: bribeProfitTarget,
                amountOutMinimum: bribe.minBribeWei,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256 out) {
            wethReceived = out;
        } catch {
            IERC20(profitToken).forceApprove(swapRouter, 0);
            // Refund profitToken que não foi consumido (swap falhou)
            uint256 refund = IERC20(profitToken).balanceOf(address(this));
            if (refund > 0) IERC20(profitToken).safeTransfer(msg.sender, refund);
            revert BribeSwapFailed();
        }

        IERC20(profitToken).forceApprove(swapRouter, 0);

        // Floor minBribeWei: swap rendeu menos que piso = leilão caro demais com esse profit
        if (wethReceived < bribe.minBribeWei) revert BribeExceedsProfit(bribe.minBribeWei, wethReceived);

        IWETH9(weth).withdraw(wethReceived);
        _sendToCoinbase(wethReceived, opType, operator, grossProfit, grossProfit - bribeProfitTarget);

        _payInProgress = false;
        return (wethReceived, bribeProfitTarget);
    }

    function _sendToCoinbase(
        uint256 bribeNativeWei,
        BribeOpType opType,
        address operator,
        uint256 grossProfit,
        uint256 netProfit
    ) internal {
        (bool ok,) = payable(block.coinbase).call{value: bribeNativeWei}("");
        if (!ok) revert BribeSwapFailed();
        emit BribePaid(operator, opType, block.coinbase, bribeNativeWei, grossProfit, netProfit);
    }

    /// @notice Necessário pra receber ETH do withdraw do WETH antes do coinbase.transfer.
    /// @dev Audit Pass 4 fix M-02: só aceita ETH durante uma chamada `pay()` ativa.
    ///      Impede que terceiros enviem ETH por engano (ficaria preso, contrato sem rescue).
    ///      Quando _payInProgress=true, withdraw do WETH9 funciona normal.
    receive() external payable {
        if (!_payInProgress) revert NotAuthorizedCaller();
    }
}
