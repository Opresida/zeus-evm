# Handoff — Fases 0 (medição antes de construir): Motor 1 + Motor 2

> Ponto de partida pra retomar no PC. As duas frentes seguem a MESMA disciplina: **medir o edge real
> com dado on-chain ANTES de escrever código.** O cloud não acessa a Base (RPC bloqueado) nem o Dune
> (sem login) → quem roda é o **Antigravity via RPC/Dune**; aqui já deixamos tudo preparado.
>
> **Ordem sugerida:** Motor 1 primeiro (edge mais concreto), Motor 2 em seguida (ou em paralelo).
> Docs de detalhe: `PRE_LIQUIDATION_FEASIBILITY.md` (M1) · `UNISWAPX_FILLER_FEASIBILITY.md` (M2).

---

## 🥇 Motor 1 — F0 das Pre-Liquidations do Morpho (prioridade)

**O que decide:** se vale construir o caminho de pre-liquidation (permissionless + callback, ~30% dos
borrows do Morpho opt-in). Detalhe técnico completo em `PRE_LIQUIDATION_FEASIBILITY.md` §5 (Fase 0) e §6.

**Mensagem pronta pro Antigravity:**

> Preciso confirmar fatos on-chain das **Pre-Liquidations do Morpho na Base** (chain 8453), via RPC, pra
> destravar a feature. Por favor:
> 1. **Endereço da `PreLiquidationFactory` na Base** — confirmar no Basescan/GitHub `morpho-org/pre-liquidation`
>    (os scans que achei eram BSC/Katana — preciso do endereço da **Base**).
> 2. **ABI exata do contrato `PreLiquidation`**: a função `preLiquidate(address,uint256,uint256,bytes)` +
>    as views de config (`PRE_LLTV`, `PRE_LCF_1/2`, `PRE_LIF_1/2`, `PRE_LIQUIDATION_ORACLE`, e os market
>    params `LOAN_TOKEN/COLLATERAL_TOKEN/ORACLE/IRM/LLTV`) + a interface `IPreLiquidationCallback.onPreLiquidate(uint256,bytes)`.
> 3. **Alvo do approve no repay:** no callback, o token de dívida é aprovado pro **Morpho singleton** ou pro
>    contrato **PreLiquidation**? (confirmar lendo o fluxo `onMorphoRepay`).
> 4. **Adoção real na Base:** quantos contratos `PreLiquidation` ativos existem (eventos da Factory) e quanto
>    de TVL/colateral cobrem — pra ver se os ~30% globais valem aqui.
>
> Me devolve os 4 itens. Não construir nada ainda — só confirmar.

**Onde gravar:** os achados entram em `PRE_LIQUIDATION_FEASIBILITY.md` §6 (substituir o "⚠️ não verificado"
pelos valores reais) + add `morpho.preLiquidationFactory` em `chain-config/src/base.ts` quando confirmado.

**Critério go/no-go:** se a Factory existir na Base + houver contratos ativos cobrindo TVL relevante →
**GO** (segue Fase 1: contrato satélite `ZeusMorphoPreLiquidator`). Se adoção ~0 na Base → **adiar**.

---

## 🥈 Motor 2 — F0 do filler UniswapX (medição no Dune)

**O que decide:** se há **long-tail na Base onde fillers buscam liquidez em DEX (não inventário) com margem
positiva** — o único nicho onde o nosso stack compete. Passo a passo completo (queries incluídas) em
`UNISWAPX_FILLER_FEASIBILITY.md` **Anexo A**.

**Mensagem pronta pro Antigravity:**

> Preciso medir, no Dune, se vale virar **filler da UniswapX na Base** — sem construir nada ainda. Siga o
> **Anexo A** de `docs/UNISWAPX_FILLER_FEASIBILITY.md`:
> 1. **Confirmar no Basescan** o(s) endereço(s) do(s) Reactor(es) UniswapX na Base (ExclusiveDutch / V2 /
>    V3 Dutch / Priority) e, no Dune, o **nome exato da tabela decodificada** do evento `Fill`.
> 2. Rodar a **Query A** (contexto: quem preenche e quanto na Base, 14d).
> 3. Rodar a **Query B** (classifica `dex_sourced` × `inventario`).
> 4. Adicionar o **Passo 2 (margem)**: join com os transfers ERC20 da mesma tx pra calcular margem por par
>    e achar o long-tail.
> 5. Preencher a **tabela de resultados** (Passo 3) e me devolver os números + o link das queries.
>
> Não construir o bot — só medir e gravar.

**Onde gravar:** preencher a tabela do **Passo 3** dentro do próprio `UNISWAPX_FILLER_FEASIBILITY.md`
(Anexo A) + colar o link das queries do Dune.

**Critério go/no-go (fixar antes de ver):** **GO** se ≥ 5 pares long-tail dex-sourced com margem líquida
> 3 bps em ≥ 10 fills/dia; **NO-GO** se quase tudo inventário ou margem < gas. (Ajustável com o Humberto,
mas travar ANTES.)

---

## Resumo de uma linha

| Motor | F0 (o que rodar) | Ferramenta | Decide |
|---|---|---|---|
| **1 — Pre-Liquidation** | confirmar Factory + ABI + adoção na Base | **RPC / Basescan** | construir o satélite ou adiar |
| **2 — Filler UniswapX** | medir fills dex-sourced + margem long-tail | **Dune** (Anexo A) | construir o filler ou engavetar |

Ambos: **número decide, não otimismo.** Nada de código antes do go.
