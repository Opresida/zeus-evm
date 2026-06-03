# Motor 3 — Refit pra realidade da Base 2026

Pesquisa de 2026-05-29: o conceito original do Motor 3 ("backrun via bundle atômico privado")
**não se aplica diretamente à Base** porque a Base tem mecânica MEV fundamentalmente diferente do L1.
Este doc define a nova arquitetura viável.

## O que mudou desde o desenho original

| Premissa antiga | Realidade descoberta |
|---|---|
| Backrun = bundle atômico via Flashbots-style relay | **Base não faz PBS** (proposer-builder separation). Não há bundle atômico Flashbots-style nativo |
| Compra Alchemy mempool ($199/mês) → vê tx pendente | **Base não tem mempool público** — sequencer da Coinbase não faz gossip. Único caminho de entrada é via RPC |
| Atlas (FastLane) seria o relay pra Base | **Chainlink comprou em jan/2026** → exclusivo Chainlink SVR. Não é mais OFA permissionless |
| Blocknative tem relay genérico Base | **Blocknative cessou operações em jun/2025** (equipe → Deloitte) |
| Flashbots tem endpoint Base | Flashbots **construiu o Flashblocks** pra Base (jul/2025) — não é relay clássico, é leilão de priority fee a cada 200ms via `op-rbuilder` |

## A realidade técnica da Base em 2026

- **Flashblocks (jul/2025)**: o sequencer emite "pré-blocos" a cada **200ms** via `op-rbuilder` (construído pela Flashbots).
- **Leilão de priority fee** dentro da janela de 200ms decide ordem — não há bundle atômico no sentido L1.
- **Privacidade vem do design**: sem mempool público, ninguém vê sua tx antes do pré-bloco.
- **Edge se move**: deixa de ser "ver primeiro + bundle selado"; vira **"reagir rápido ao pré-bloco + priority fee certo"**.

## Motor 3 Refit — "Flashblocks-Priority Backrun"

**Conceito:**
1. Assina WebSocket de **Flashblocks** (pré-blocos de 200ms) via provider que suporte (Alchemy/Chainstack/dRPC).
2. Classifica tx do pré-bloco N — detecta swap-baleia que cria dislocação.
3. Monta arb cross-DEX que captura a dislocação.
4. Submete via RPC normal com **priority fee competitivo** pra entrar no pré-bloco N ou N+1 (dentro da janela de 200ms).
5. **Flashloan atômico** continua igual no contrato — só muda a forma de inclusão no bloco.

**Vantagens vs. design antigo:**
- Não depende de relays mortos.
- **Usa infra que já planejamos** — não precisa do $199/mês de Alchemy mempool (não existe mempool pra assinar na Base mesmo).
- Edge medível: latência (Flashblocks WS → classify → submit) + priority fee oracle calibrado.

**Trade-off honesto:**
- Sem bundle atômico → você **não garante** "minha tx só vale se a do whale estiver junto". Em alguns cenários a baleia some/é revertida e sua tx fica desencaixada.
- **Mitigação:** o flashloan + `minProfitWei` no contrato ainda garante "ou lucra, ou reverte" → o pior caso é só gas perdido. Não há risco de capital, só de oportunidade.

## Opção alternativa — bloXroute (paga, mas com bundle atômico)

A **bloXroute está viva e suporta Base** (4 streams + 2 submission endpoints). Usa modelo de bundle atômico em ETH/BSC; **provavelmente** na Base também (precisa confirmar com a documentação atual deles). Novo pricing model anunciado em março/2026 — custo a verificar.

**Quando vale considerar bloXroute:**
- Se o Flashblocks-Priority Backrun (sem bundle atômico) tiver win rate baixo demais por causa de race conditions.
- Se descobrirmos que vale pagar pelo "envelope selado" verdadeiro.
- Após o Primeiro Voo Instrumentado provar que há dinheiro a capturar.

## Infra revisada pro Motor 3

| Antes (estimado) | Refit (provável) |
|---|---|
| Alchemy mempool Growth+ ($199/mês) — pra "ver baleia" | Provider com **Flashblocks WS** (incluído em Alchemy free? Chainstack? a confirmar) |
| Relay pago (Blocknative/Atlas) — pra bundle atômico | **Nenhum** (priority fee auction direto no sequencer) |
| Hosting comum | **Hosting low-latency** próximo ao sequencer (Fly.io US-East ou equivalente) — latência importa muito |
| Custo mensal estimado | Provavelmente próximo do **mesmo de Motor 1** (sem extra significativo) |

**Conclusão de custo:** o Motor 3 nessa formatação **NÃO exige novo investimento de infra** pesado — a premissa antiga de "$199/mês destrava o Motor 3" era de L1, não bate na Base.

## Ações concretas

### Curto prazo (este momento)
- ✅ Marcar `atlasRelay.ts` e `blocknativeRelay.ts` como DEPRECATED com link pras fontes.
- ✅ Atualizar `project-zeus-evm-infra-investment` (memória) com a descoberta.
- ✅ Documentar Motor 3 Refit no relatório (§16).

### Curto-médio (antes de codar o Motor 3 ativo)
1. **Pesquisar quais providers suportam Flashblocks WS** (Alchemy? Chainstack? dRPC?) — fundamental.
2. **Confirmar pricing e atomic bundle na Base do bloXroute** — opção paga de backup.
3. **Investigar Coinbase Searcher Program** — acesso direto ao sequencer (pode existir, fechado/curado).

### Médio prazo (depois do Primeiro Voo do Motor 1)
4. Refazer `relayRouter.ts` com 2 implementações novas: `FlashblocksPriorityRelay` (priority fee direto via RPC) + opcionalmente `BloxrouteRelay` (bundle atômico).
5. Apagar definitivamente `atlasRelay.ts` + `blocknativeRelay.ts`.
6. Testar Motor 3 em DRY_RUN na Base (gravando a janela de 200ms via Flashblocks).

## Princípio que sobreviveu

O **flashloan atômico do contrato** continua sendo a peça que torna isso seguro — qualquer falha
na captura reverte a tx inteira. O Motor 3 refit muda **como a tx entra no bloco**, não muda o que
o contrato faz.

Relacionado: [FIRST_FLIGHT.md](./FIRST_FLIGHT.md) · memória `project-zeus-evm-infra-investment`.
