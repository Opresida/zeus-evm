# Primeiro Voo Instrumentado — plano de validação na mainnet

> Definido 2026-05-29. O primeiro voo **não é pra lucrar** — é pra a caixa-preta responder, com dado
> real e risco mínimo, se existe dinheiro no nosso nicho. Estreito, instrumentado, flashloan-only.

## Objetivo — 3 perguntas

1. **Existe oportunidade** no nosso nicho? (densidade)
2. **Conseguimos capturar?** (win rate / a corrida contra competidores)
3. **A ineficiência de arb persiste e passa no gate?** (tese do Motor 2)

## Escopo — deliberadamente ESTREITO

**Dentro:**
- 1 chain: **Base** (a mais madura).
- **Motor 1:** só **Aave V3 + Compound III** (os mais validados, com fork test).
- **Motor 2 (MIS):** **observação pura** em paralelo (zero risco), coletando persistência.

**Fora (por enquanto, de propósito):** Moonwell (sem fork test) · Morpho (markets esparsos na Base) ·
Seamless · Polygon/Avalanche · Motor 3 (precisa mempool) · ponte MIS→executor.

> Motivo: a caixa-preta gera sinal LIMPO com 1-2 frentes. Com 5 ao mesmo tempo, vira ruído.

## Fases

| Fase | Quando | O que | Risco |
|---|---|---|---|
| **0 — DRY_RUN mainnet** | dias 1-3 | Deploy (BribeManager + ZeusLiquidator), liquidator em `dryrun`. Valida os INSTRUMENTOS da caixa-preta contra fluxo real (reconciler lê certo? discovery acha borrowers? thresholds batem?) | ZERO |
| **1 — Armado, cap mínimo** | semana 1-2 | Flip pra `mainnet`, `MAX_TRADE` ~$200-500, `MIN_PROFIT` modesto. Flashloan-only + atômico → downside é gas, não capital | Baixo |
| **2 — Decisão** | semana 2-4 | Lê as 4 métricas → tese vive, morre ou pivota | — |

> Por que Fase 0: o cockpit nunca rodou contra fill real. O primeiro voo também testa os próprios instrumentos.

## O que a caixa-preta TEM que capturar (dia 1)

- **Toda oportunidade vista** (borrower HF < threshold): quantas, tamanho, protocolo.
- **Toda tentativa de dispatch:** ganhou / perdeu / reverteu + gas pago + **esperado vs real** (reconciler).
- **Toda corrida perdida:** quem ganhou (fingerprint do competidor), quanto pagou de gas, timing.
- **MIS (Motor 2):** por par → persistenceRatio + passou/não no gate de profundidade + tamanho ótimo + lucro hipotético.
- **Falhas categorizadas:** sem-oportunidade / revert pré-dispatch / revert on-chain / perdeu-corrida.

## As 4 métricas que decidem (vive ou morre)

| # | Métrica | Vive se... | Morre/pivota se... |
|---|---|---|---|
| 1 | **Densidade** (oport./semana acima do min-profit) | > punhado/semana | ≈ 0 → nicho seco na Base; ir pros sub-servidos |
| 2 | **Win rate** (das tentadas, % ganhas) | > 0 e subindo | ≈ 0% → gap de velocidade fatal aqui |
| 3 | **Net real/captura** (pós gas, via reconciler) | positivo | negativo consistente → economia não fecha |
| 4 | **MIS: pares persistentes que PASSAM o gate** | ≥ 1 par | 0 pares → tese de arb falsificada (por ora) |

**Leitura dos cenários:**
- Motor 1 seco MAS MIS acha par no gate → foca no Motor 2 (constrói a ponte→executor).
- Ambos secos após 4 semanas → a tese precisa mudar — descoberto com **~$0 de risco** (o ponto).
- Motor 1 ganha algumas com net+ → tese viva; expande **devagar** (1 protocolo/chain por vez, guiado por dado).

## Pré-requisitos (decisões — não-código)

1. **Owner = multisig** (Safe na Base) ou chave hardware dedicada.
2. **Capital de gas** (ETH na Base — flashloan cobre o trade, gas é nosso).
3. **Cap inicial** ($200-500) + min profit.
4. **RPC pago + Fly.io** pra rodar 24/7.

## Custo/tempo

- Setup: deploy (~horas) + config. Infra: ~$60-130/mês (RPC + Fly.io).
- Janela de decisão: **3-4 semanas** de dado real.

## Princípio

Deploya o mínimo, liga a caixa-preta inteira, e deixa **os dados** — não opinião — decidirem se a Base/Aave
paga, ANTES de gastar mais uma linha de código em largura (mais protocolos/chains/Motor 3).

Relacionado: pré-mainnet checklist em [TODO.md](../TODO.md) · doutrina em memória `project-zeus-evm-edge-doctrine`.
