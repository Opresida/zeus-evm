-- ═══════════════════════════════════════════════════════════════════════════════
-- #5 automação — SLIPPAGE / IMPACTO DE PREÇO REAL por DEX × tamanho na BASE
-- Objetivo: calibrar MAX_SLIPPAGE_BPS POR DEX (hoje é global) a partir do histórico
-- de swaps REAIS de terceiros — SEM esperar nossa execução na mainnet.
-- Dialeto: DuneSQL (Trino). Fonte: spellbook `dex.trades` (decodificado, multi-DEX).
--
-- Método: pra cada swap, calcula o preço EFETIVO normalizado (token B por token A do
-- par canônico). A REFERÊNCIA é a mediana do preço efetivo do mesmo (par, DEX, hora).
-- O desvio |efetivo − referência| / referência em bps = proxy do impacto/slippage.
-- Agrega p50/p95 por (DEX, faixa de tamanho). "Recorte" = janela + pares abaixo.
-- ═══════════════════════════════════════════════════════════════════════════════

WITH base_trades AS (
  SELECT
    block_time,
    concat(project, coalesce(concat('-', version), '')) AS dex,   -- ex: 'uniswap-3', 'aerodrome-1', 'baseswap-2'
    token_bought_symbol,
    token_sold_symbol,
    token_bought_amount,
    token_sold_amount,
    amount_usd,
    -- par canônico (símbolos ordenados) → junta as duas direções no mesmo grupo
    least(token_bought_symbol, token_sold_symbol)    AS pair_a,
    greatest(token_bought_symbol, token_sold_symbol) AS pair_b
  FROM dex.trades
  WHERE blockchain = 'base'
    AND block_time > now() - interval '30' day          -- ◀── RECORTE 1: janela (subir p/ 90d depois)
    AND amount_usd BETWEEN 100 AND 1000000              -- descarta poeira e baleias absurdas
    AND token_bought_amount > 0 AND token_sold_amount > 0
    -- ◀── RECORTE 2: pares que a gente opera (começar pequeno, expandir depois)
    AND token_bought_symbol IN ('WETH','USDC','cbETH','USDbC','DAI','AERO','cbBTC')
    AND token_sold_symbol   IN ('WETH','USDC','cbETH','USDbC','DAI','AERO','cbBTC')
    AND token_bought_symbol <> token_sold_symbol
),
priced AS (
  SELECT
    *,
    concat(pair_a, '/', pair_b) AS pair,
    -- preço efetivo SEMPRE na direção "B por A" (normaliza as duas direções do trade)
    CASE
      WHEN token_bought_symbol = pair_a THEN token_sold_amount   / token_bought_amount  -- comprou A, vendeu B
      ELSE                                    token_bought_amount / token_sold_amount    -- comprou B, vendeu A
    END AS eff_price
  FROM base_trades
),
hourly_ref AS (
  -- referência robusta: mediana do preço efetivo por (par, DEX, hora)
  SELECT pair, dex, date_trunc('hour', block_time) AS hr,
         approx_percentile(eff_price, 0.5) AS ref_price
  FROM priced
  WHERE eff_price > 0
  GROUP BY 1, 2, 3
),
impact AS (
  SELECT
    p.dex,
    abs(p.eff_price - r.ref_price) / r.ref_price * 10000 AS slippage_bps,
    CASE
      WHEN p.amount_usd < 1000   THEN '1_ate_1k'
      WHEN p.amount_usd < 5000   THEN '2_1k_5k'
      WHEN p.amount_usd < 25000  THEN '3_5k_25k'
      WHEN p.amount_usd < 100000 THEN '4_25k_100k'
      ELSE                             '5_acima_100k'
    END AS size_bucket
  FROM priced p
  JOIN hourly_ref r
    ON p.pair = r.pair AND p.dex = r.dex
   AND date_trunc('hour', p.block_time) = r.hr
  WHERE p.eff_price > 0 AND r.ref_price > 0
)
SELECT
  dex,
  size_bucket,
  count(*)                                          AS trades,
  round(approx_percentile(slippage_bps, 0.50), 1)   AS p50_slippage_bps,
  round(approx_percentile(slippage_bps, 0.95), 1)   AS p95_slippage_bps,
  round(approx_percentile(slippage_bps, 0.99), 1)   AS p99_slippage_bps
FROM impact
WHERE slippage_bps < 2000            -- corta outliers de dados sujos (não é slippage real)
GROUP BY 1, 2
HAVING count(*) >= 20                -- amostra mínima pra confiar no percentil
ORDER BY dex, size_bucket
-- ═══════════════════════════════════════════════════════════════════════════════
-- LEITURA: pra cada DEX e faixa de tamanho, p95_slippage_bps = o slippage que a
-- gente deve tolerar (com folga). Vira a tabela `slippage_by_dex` que calibra o gate.
-- Ex esperado: UniswapV3 pares líquidos ~10-30 bps; Aerodrome/forks ~50-150 bps.
-- ═══════════════════════════════════════════════════════════════════════════════
