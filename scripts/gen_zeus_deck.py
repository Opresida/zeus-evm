# -*- coding: utf-8 -*-
"""Gerador da apresentação completa do ZEUS EVM em PDF (fpdf2)."""
from fpdf import FPDF

# Paleta (ZEUS — navy + dourado/raio)
NAVY   = (16, 24, 43)
NAVY2  = (24, 36, 64)
GOLD   = (240, 188, 70)
GOLDD  = (190, 145, 40)
WHITE  = (245, 247, 250)
GREY   = (150, 160, 178)
GREEN  = (70, 190, 130)
RED    = (225, 95, 95)
YELLOW = (235, 190, 80)
CARD   = (244, 246, 250)
INK    = (28, 34, 48)

PAGE_W = 210
PAGE_H = 297
MX = 16  # margem


class Deck(FPDF):
    def header(self):
        pass

    def footer(self):
        if self.page_no() == 1:
            return
        self.set_y(-12)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*GREY)
        self.cell(0, 8, "ZEUS EVM  -  MAZARI CORP  -  Confidencial", align="L")
        self.cell(0, 8, f"{self.page_no()}", align="R")


def band(pdf, y, h, color):
    pdf.set_fill_color(*color)
    pdf.rect(0, y, PAGE_W, h, "F")


def section_title(pdf, kicker, title):
    band(pdf, 0, 34, NAVY)
    pdf.set_fill_color(*GOLD)
    pdf.rect(0, 0, 6, 34, "F")
    pdf.set_xy(MX, 8)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(*GOLD)
    pdf.cell(0, 5, kicker.upper())
    pdf.set_xy(MX, 14)
    pdf.set_font("Helvetica", "B", 20)
    pdf.set_text_color(*WHITE)
    pdf.cell(0, 12, title)
    pdf.set_xy(MX, 42)
    pdf.set_text_color(*INK)


def bullet(pdf, text, color=GOLD, bold_lead=None, size=10.5, gap=6.2):
    x = pdf.get_x()
    y = pdf.get_y()
    pdf.set_fill_color(*color)
    pdf.rect(x, y + 1.6, 2.4, 2.4, "F")
    pdf.set_xy(x + 6, y)
    if bold_lead:
        pdf.set_font("Helvetica", "B", size)
        pdf.set_text_color(*INK)
        w = pdf.get_string_width(bold_lead + "  ")
        pdf.cell(w, gap, bold_lead + "  ")
        pdf.set_font("Helvetica", "", size)
        pdf.set_text_color(*INK)
        pdf.multi_cell(PAGE_W - MX - (x + 6) - w, gap, text)
    else:
        pdf.set_font("Helvetica", "", size)
        pdf.set_text_color(*INK)
        pdf.multi_cell(PAGE_W - MX - (x + 6), gap, text)
    pdf.set_x(MX)
    pdf.ln(1.5)


def card(pdf, x, y, w, h, title, lines, accent=GOLD):
    pdf.set_fill_color(*CARD)
    pdf.rect(x, y, w, h, "F")
    pdf.set_fill_color(*accent)
    pdf.rect(x, y, w, 1.6, "F")
    pdf.set_xy(x + 5, y + 5)
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(*INK)
    pdf.cell(w - 10, 6, title)
    pdf.set_xy(x + 5, y + 13)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(60, 68, 84)
    pdf.multi_cell(w - 10, 5, lines)


def chip(pdf, x, y, label, color):
    pdf.set_font("Helvetica", "B", 8)
    w = pdf.get_string_width(label) + 7
    pdf.set_fill_color(*color)
    pdf.rect(x, y, w, 6, "F")
    pdf.set_text_color(*WHITE)
    pdf.set_xy(x, y + 0.4)
    pdf.cell(w, 5.2, label, align="C")
    return w


def table(pdf, headers, rows, widths, x=MX, row_h=8, fs=9):
    y = pdf.get_y()
    pdf.set_x(x)
    pdf.set_fill_color(*NAVY2)
    pdf.set_text_color(*WHITE)
    pdf.set_font("Helvetica", "B", fs)
    for h, w in zip(headers, widths):
        pdf.cell(w, row_h, " " + h, border=0, fill=True)
    pdf.ln(row_h)
    pdf.set_font("Helvetica", "", fs)
    for i, row in enumerate(rows):
        pdf.set_x(x)
        fill = (252, 252, 254) if i % 2 == 0 else (238, 241, 246)
        pdf.set_fill_color(*fill)
        for (txt, col), w in zip(row, widths):
            pdf.set_text_color(*col)
            # multi-line safe-ish single cell
            pdf.cell(w, row_h, " " + txt, border=0, fill=True)
        pdf.ln(row_h)


pdf = Deck(orientation="P", unit="mm", format="A4")
pdf.set_auto_page_break(auto=True, margin=18)
pdf.set_title("ZEUS EVM - Apresentacao")

# ───────────────────────── CAPA ─────────────────────────
pdf.add_page()
band(pdf, 0, PAGE_H, NAVY)
# faixa dourada
pdf.set_fill_color(*GOLD)
pdf.rect(0, 96, PAGE_W, 1.2, "F")
pdf.rect(0, 150, PAGE_W, 1.2, "F")
pdf.set_xy(0, 60)
pdf.set_font("Helvetica", "B", 13)
pdf.set_text_color(*GOLD)
pdf.cell(0, 8, "MAZARI CORP", align="C")
pdf.set_xy(0, 104)
pdf.set_font("Helvetica", "B", 54)
pdf.set_text_color(*WHITE)
pdf.cell(0, 22, "ZEUS  EVM", align="C")
pdf.set_xy(0, 130)
pdf.set_font("Helvetica", "", 15)
pdf.set_text_color(*WHITE)
pdf.cell(0, 8, "Bot de Arbitragem & MEV On-Chain", align="C")
pdf.set_xy(0, 158)
pdf.set_font("Helvetica", "", 11)
pdf.set_text_color(*GREY)
pdf.cell(0, 7, "Apresentacao Tecnica e Estrategica", align="C")
pdf.set_xy(0, 168)
pdf.cell(0, 7, "Tres motores descorrelacionados  -  Flashloan 0%  -  Base (Coinbase L2)", align="C")
# rodape capa
pdf.set_xy(0, 250)
pdf.set_font("Helvetica", "", 9)
pdf.set_text_color(*GREY)
pdf.cell(0, 6, "Documento confidencial  -  Projeto Humberto + Claude", align="C")

# ───────────────────────── 1. O QUE E ─────────────────────────
pdf.add_page()
section_title(pdf, "Visao geral", "O que e o ZEUS")
pdf.ln(2)
pdf.set_font("Helvetica", "", 11)
pdf.set_text_color(*INK)
pdf.multi_cell(0, 6, "ZEUS e um bot on-chain de arbitragem, liquidacao e MEV na rede Base. A tese central: "
                     "tres motores descorrelacionados que faturam em condicoes de mercado diferentes - "
                     "o bot ganha em crash, em volume e em volatilidade.")
pdf.ln(3)
bullet(pdf, "Liquidacoes (Aave V3 + Compound III + Morpho Blue + Seamless + Moonwell). Edge real = Morpho (aberto, sem OEV capture).", bold_lead="Motor 1 - Liquidacoes:")
bullet(pdf, "Varredura de ineficiencias cross-DEX + triangular, ranqueada por persistencia. Executa nos melhores spreads.", bold_lead="Motor 2 - Arbitragem (MIS):")
bullet(pdf, "Backrun pos-whale, ciente de competidor (gas war) + bribe + relays privados.", bold_lead="Motor 3 - Backrun:")
pdf.ln(3)
y = pdf.get_y()
card(pdf, MX, y, 56, 30, "Modalidades", "Wallet arb (capital proprio)\nFlashloan multi-fonte 0%\n(Morpho/Balancer > Aave)", GOLD)
card(pdf, MX + 61, y, 56, 30, "Seguranca", "Atomic-only (falha reverte tudo)\nSelf-custody + circuit breakers\nOwner = multisig em prod", GREEN)
card(pdf, MX + 122, y, 56, 30, "Inteligencia", "Ledger DuckDB + scoring OIE\nCompetidor-aware\nAuto-calibravel", YELLOW)

# ───────────────────────── 2. ARQUITETURA ─────────────────────────
pdf.add_page()
section_title(pdf, "Engenharia", "Arquitetura & Stack")
pdf.ln(2)
bullet(pdf, "TypeScript + Node 22 + viem (off-chain). Solidity 0.8.27 + Foundry (contratos).", bold_lead="Stack:")
bullet(pdf, "4 contratos split por EIP-170: ZeusArbExecutor + ZeusLiquidator + ZeusMoonwellLiquidator + BribeManager. Sem proxy upgradeable (bug = deploy novo).", bold_lead="Contratos (v8):")
bullet(pdf, "7 apps (detector, liquidator, mis-scanner, backrun, discovery-scraper, monitor, backtest) + 6 packages compartilhados.", bold_lead="Monorepo:")
bullet(pdf, "dRPC primario + Alchemy fallback (failover automatico). Flashloan multi-fonte 0%.", bold_lead="Infra:")
bullet(pdf, "Ledger DuckDB (inteligencia) + Prometheus + Grafana + Discord + pino logs.", bold_lead="Observabilidade:")
pdf.ln(2)
y = pdf.get_y()
card(pdf, MX, y, 86, 34, "Camada on-chain", "Execucao atomica via flashloan.\nN swap steps = multi-hop / triangular.\nCircuit breakers: MAX_TRADE_ETH,\nminProfitWei, kill switch.\n115 funcoes de teste Foundry.", GOLD)
card(pdf, MX + 92, y, 86, 34, "Camada off-chain", "Descoberta dinamica de oportunidades.\nCalculo + simulacao pre-dispatch.\nGates de EV + auto-calibracao.\nColeta de inteligencia em tempo real.\n~340 testes (vitest) verdes.", YELLOW)

# ───────────────────────── 3. OS 3 MOTORES ─────────────────────────
pdf.add_page()
section_title(pdf, "O coracao do bot", "Os 3 Motores")
pdf.ln(2)
headers = ["Motor", "O que faz", "Software", "Bloqueio (infra)"]
widths = [40, 78, 30, 30]
rows = [
    [("1 - Liquidacoes", INK), ("Liquida posicoes em risco (5 protocolos)", INK), ("Completo", GREEN), ("-", GREY)],
    [("2 - Arbitragem", INK), ("Cross-DEX + ve triangular; executa", INK), ("~95%", GREEN), ("-", GREY)],
    [("3 - Backrun", INK), ("Backrun pos-whale na mempool", INK), ("Pronto", YELLOW), ("Mempool", RED)],
]
table(pdf, headers, rows, widths, row_h=10, fs=9)
pdf.ln(4)
bullet(pdf, "os tres agora tem a MESMA camada de inteligencia: veem competidor, reconciliam PnL, fazem post-mortem e se auto-calibram.", bold_lead="Novidade desta fase:", color=GOLD)
bullet(pdf, "Motor 2 deixou de ser so radar - agora dispara nos melhores spreads (sem lista fixa) e enxerga triangular.", color=GOLD)
bullet(pdf, "Motor 3 esta 100% pronto em software; so nao dispara porque a Base nao tem mempool publico (precisa Flashblocks / Alchemy Growth+).", color=RED)
pdf.ln(2)
pdf.set_font("Helvetica", "I", 9.5)
pdf.set_text_color(*GREY)
pdf.multi_cell(0, 5, "Tese de descorrelacao: ZEUS fatura em qualquer mercado - Motor 1 no crash, Motor 2 no volume, Motor 3 na volatilidade.")

# ───────────────────────── 4. INTELIGENCIA (OIE) ─────────────────────────
pdf.add_page()
section_title(pdf, "O cerebro", "Camada de Inteligencia (OIE)")
pdf.ln(2)
pdf.set_font("Helvetica", "", 11)
pdf.set_text_color(*INK)
pdf.multi_cell(0, 6, "Tudo que o bot observa e LIDO, GRAVADO no ledger central (DuckDB) e VISIVEL no Grafana. "
                     "A inteligencia alimenta os gates de decisao e se auto-calibra com o historico real.")
pdf.ln(3)
bullet(pdf, "perfis, priority fee (quanto pagam pra ganhar), deteccao de sybil + builder attribution.", bold_lead="Competidores:")
bullet(pdf, "agrega o lance do mercado e dimensiona o nosso bribe (nao brigar abaixo do mercado).", bold_lead="Market-bribe:")
bullet(pdf, "esperado vs realizado, drift, atribuicao de causa, custo de inclusao real.", bold_lead="Reconciliacao de PnL:")
bullet(pdf, "alarme quando o bot 'mente pra si mesmo' (drift sustentado = algo quebrou).", bold_lead="Calibracao:")
bullet(pdf, "quem nos ganhou + onde nossa tx caiu no bloco (corrida perdida? sandwich?).", bold_lead="Post-mortem:")
bullet(pdf, "thresholds adaptativos por dimensao - o bot aperta/afrouxa os gates sozinho.", bold_lead="Auto-calibracao:")
pdf.ln(2)
y = pdf.get_y()
card(pdf, MX, y, 178, 22, "Fluxo da inteligencia", "Coleta (on-chain + execucao)  ->  Ledger central DuckDB (categorias canonicas)  ->  "
     "Scoring / gates de EV + auto-calibracao  ->  Prometheus / Grafana (8 dashboards) + relatorio CLI.", GOLD)

# ───────────────────────── 5. ANTES vs DEPOIS ─────────────────────────
pdf.add_page()
section_title(pdf, "A transformacao", "Antes vs Depois")
pdf.ln(2)
headers = ["Dimensao", "Antes", "Depois"]
widths = [62, 58, 58]
rows = [
    [("Inteligencia usada", INK), ("~30% (resto no lixo)", RED), ("~100% lida/gravada/visivel", GREEN)],
    [("Motores funcionais", INK), ("1 de 3", RED), ("3 de 3 (m2 executa)", GREEN)],
    [("Competidor-aware", INK), ("parcial", YELLOW), ("os 3 motores", GREEN)],
    [("Auto-calibracao", INK), ("so 1 motor", YELLOW), ("os 3 motores", GREEN)],
    [("Visao de profundidade", INK), ("nenhuma", RED), ("ve triangular", GREEN)],
    [("Fios soltos criticos", INK), ("varios", RED), ("fechados", GREEN)],
    [("Fallback de RPC", INK), ("inexistente", RED), ("dRPC -> Alchemy", GREEN)],
]
table(pdf, headers, rows, widths, row_h=9.5, fs=9.5)
pdf.ln(5)
y = pdf.get_y()
card(pdf, MX, y, 86, 26, "Nota como SOFTWARE", "Subiu de ~7,5  ->  ~9\n\nDe 'bom mas vazava inteligencia e tinha\nmotor cego' para 'redondo e auto-consciente'.", GREEN)
card(pdf, MX + 92, y, 86, 26, "Nota como COMPETIDOR", "Subiu de ~4,5  ->  ~6,5\n\nSoftware pronto; falta o inevitavel:\nmainnet + infra + validacao com dado real.", YELLOW)

# ───────────────────────── 6. MATRIZ DE CAPACIDADES ─────────────────────────
pdf.add_page()
section_title(pdf, "Estado preciso", "Matriz de Capacidades por Motor")
pdf.ln(2)
headers = ["Capacidade", "Motor 1", "Motor 2", "Motor 3"]
widths = [70, 36, 36, 36]
def ok():   return ("Sim", GREEN)
def no():   return ("Nao", RED)
def part(): return ("Parcial", YELLOW)
rows = [
    [("Deteccao de oportunidade", INK), ok(), ok(), ok()],
    [("Execucao (dispara tx)", INK), ok(), ok(), part()],
    [("Visao triangular", INK), ("n/a", GREY), ("Ve", GREEN), ("n/a", GREY)],
    [("Competidor-aware", INK), ok(), ok(), ok()],
    [("Reconciliacao de PnL", INK), ok(), ok(), ok()],
    [("Post-mortem de falha", INK), ok(), ok(), ok()],
    [("Auto-calibracao", INK), ok(), ok(), ok()],
    [("/metrics + Grafana", INK), ok(), ok(), ok()],
]
table(pdf, headers, rows, widths, row_h=8.6, fs=9.5)
pdf.ln(4)
bullet(pdf, "Motor 2 'Execucao' = cross-DEX ja dispara; triangular o bot VE e falta so disparar (builder N-leg).", color=GOLD)
bullet(pdf, "Motor 3 'Execucao parcial' = pipeline completo, bloqueado so pelo feed de mempool (infra).", color=RED)

# ───────────────────────── 7. TRIANGULAR ─────────────────────────
pdf.add_page()
section_title(pdf, "Profundidade", "Arbitragem Triangular")
pdf.ln(2)
pdf.set_font("Helvetica", "", 11)
pdf.set_text_color(*INK)
pdf.multi_cell(0, 6, "Cross-DEX 2-leg ve a divergencia do mesmo par em 2 pools. Triangular ve a ineficiencia "
                     "entre 3 mercados: um ciclo onde o produto das taxas (ja com fee) e maior que 1 = lucro escondido.")
pdf.ln(2)
# diagrama simples do ciclo
cx, cy = 60, pdf.get_y() + 22
r = 16
import math
pts = [(cx, cy - r), (cx + r*0.95, cy + r*0.6), (cx - r*0.95, cy + r*0.6)]
labels = ["T0", "T1", "T2"]
pdf.set_draw_color(*GOLDD)
pdf.set_line_width(0.8)
for i in range(3):
    a = pts[i]; b = pts[(i+1) % 3]
    pdf.line(a[0], a[1], b[0], b[1])
for (px, py), lab in zip(pts, labels):
    pdf.set_fill_color(*NAVY)
    pdf.ellipse(px - 6, py - 6, 12, 12, "F")
    pdf.set_xy(px - 6, py - 3)
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(*GOLD)
    pdf.cell(12, 6, lab, align="C")
pdf.set_xy(95, cy - 22)
pdf.set_text_color(*INK)
bullet(pdf, "monta o grafo de tokens a partir dos pools varridos (sem RPC extra).", bold_lead="VE:", size=10)
pdf.set_x(95)
bullet(pdf, "acha ciclos lucrativos rapido (latencia decide) e grava no ledger.", bold_lead="Detecta:", size=10)
pdf.set_x(95)
bullet(pdf, "o contrato ja executa N steps (flashloan -> 3 swaps -> repaga).", bold_lead="Executa:", size=10)
pdf.set_xy(MX, cy + 28)
pdf.set_text_color(*INK)
bullet(pdf, "tudo numa unica TX atomica (flashloan): triangular que falha = so gas, nunca capital.", color=GREEN, bold_lead="Por que vale:")
bullet(pdf, "mais caro (3 swaps = mais gas + slippage) e mais disputado - o gate de profundidade/persistencia separa o edge real do ruido.", color=YELLOW, bold_lead="Honestidade:")
bullet(pdf, "deteccao PRONTA (o bot ve); execucao triangular (disparo N-leg) e o ultimo passo focado.", color=GOLD, bold_lead="Status:")

# ───────────────────────── 8. SEGURANCA ─────────────────────────
pdf.add_page()
section_title(pdf, "Risco", "Seguranca & Principios")
pdf.ln(2)
bullet(pdf, "qualquer falha reverte a TX inteira. Nunca perde capital numa execucao - no maximo o gas.", bold_lead="Atomic-only:", color=GREEN)
bullet(pdf, "MAX_TRADE_ETH + minProfitWei + kill switch no proprio contrato.", bold_lead="Circuit breakers on-chain:", color=GREEN)
bullet(pdf, "self-custody; owner = multisig (Safe) em producao.", bold_lead="Custodia:", color=GREEN)
bullet(pdf, "chave do ZEUS exclusiva, nunca reutilizada entre dev/prod ou projetos.", bold_lead="Chaves:", color=GREEN)
bullet(pdf, "Security Audit Pass 1+2 + fixes (H-01, H-02, M-01, M-02). Audit externo antes de capital alto.", bold_lead="Auditoria:", color=GREEN)
bullet(pdf, "testnet 2 semanas -> mainnet DRY_RUN -> capital pequeno 4 semanas -> audit -> escala.", bold_lead="Validacao antes de escalar:", color=GOLD)
pdf.ln(3)
y = pdf.get_y()
card(pdf, MX, y, 178, 20, "Regra de ouro", "Codigo redondo nao e o mesmo que pronto pra capital. ZEUS so opera capital real depois de "
     "DRY_RUN mainnet provar o edge + audit externo. Honestidade > otimismo cego.", RED)

# ───────────────────────── 9. STATUS HONESTO ─────────────────────────
pdf.add_page()
section_title(pdf, "Onde estamos", "Status Honesto")
pdf.ln(2)
y = pdf.get_y()
card(pdf, MX, y, 86, 52, "PRONTO (software)",
     "- 3 motores inteligentes e auto-calibraveis\n"
     "- Inteligencia 100% lida/gravada/visivel\n"
     "- Motor 2 executa cross-DEX + ve triangular\n"
     "- Fios soltos criticos fechados\n"
     "- typecheck + ~340 testes verdes\n"
     "- Contratos: 115 funcoes de teste Foundry", GREEN)
card(pdf, MX + 92, y, 86, 52, "PENDENTE (infra/validacao)",
     "- Deploy de contratos na MAINNET\n"
     "- Wallet/chave + provedor RPC pago\n"
     "- Mempool do Motor 3 (Flashblocks/Alchemy)\n"
     "- Execucao triangular (builder N-leg)\n"
     "- 2 semanas DRY_RUN mainnet (coletar)\n"
     "- Audit externo antes de capital alto", YELLOW)
pdf.ln(58)
pdf.set_font("Helvetica", "B", 12)
pdf.set_text_color(*RED)
pdf.cell(0, 8, "Lucro real hoje: US$ 0  (provado em fork, ainda na testnet Sepolia)")
pdf.ln(10)
pdf.set_font("Helvetica", "", 10.5)
pdf.set_text_color(*INK)
pdf.multi_cell(0, 6, "Resumo: o software esta redondo; o negocio ainda nao - e isso e por design, nao por descuido. "
                     "O que falta NAO e software: e ligar a infra que cada motor exige e validar com dado real.")

# ───────────────────────── 10. ROADMAP ─────────────────────────
pdf.add_page()
section_title(pdf, "Proximos passos", "Roadmap")
pdf.ln(3)
steps = [
    ("1", "Coletar dados (DRY_RUN mainnet)", "Read-only, SEM deploy de contrato. Observar + calibrar. Descobrir qual motor tem edge real.", GOLD),
    ("2", "Ler o dado e decidir", "As 2 semanas respondem: Morpho fatura? triangular fecha? quanto perco de corrida?", GOLD),
    ("3", "Audit interno -> deploy MAINNET -> capital pequeno", "Deployar contrato so quando o dado provar que vale executar. Capital pequeno 4 semanas.", YELLOW),
    ("4", "Rust no caminho quente (SE necessario)", "So se o dado mostrar perda por latencia (backrun/triangular). Cirurgico, nao rewrite total.", GREY),
    ("5", "Ligar Motor 3 + multi-chain", "Mempool (Flashblocks/Alchemy Growth+). Depois expansao (Avalanche).", GREY),
]
for num, title, desc, col in steps:
    y = pdf.get_y()
    pdf.set_fill_color(*NAVY)
    pdf.ellipse(MX, y, 9, 9, "F")
    pdf.set_xy(MX, y + 1.5)
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(*GOLD)
    pdf.cell(9, 6, num, align="C")
    pdf.set_xy(MX + 14, y - 0.5)
    pdf.set_font("Helvetica", "B", 11.5)
    pdf.set_text_color(*INK)
    pdf.cell(0, 6, title)
    pdf.set_xy(MX + 14, y + 5.5)
    pdf.set_font("Helvetica", "", 9.5)
    pdf.set_text_color(70, 78, 94)
    pdf.multi_cell(PAGE_W - MX - (MX + 14), 5, desc)
    pdf.ln(3)
pdf.ln(1)
pdf.set_font("Helvetica", "I", 10)
pdf.set_text_color(*GREY)
pdf.multi_cell(0, 5.5, "Ordem importa: COLETAR vem antes de DEPLOYAR. Nao se deploya pra coletar - coleta-se read-only, "
                      "e deploya-se quando o dado mandar.")

# ───────────────────────── 11. FECHAMENTO ─────────────────────────
pdf.add_page()
band(pdf, 0, PAGE_H, NAVY)
pdf.set_fill_color(*GOLD)
pdf.rect(0, 110, PAGE_W, 1.2, "F")
pdf.set_xy(0, 70)
pdf.set_font("Helvetica", "B", 26)
pdf.set_text_color(*WHITE)
pdf.cell(0, 14, "ZEUS esta pronto.", align="C")
pdf.set_xy(0, 88)
pdf.set_font("Helvetica", "", 13)
pdf.set_text_color(*GOLD)
pdf.cell(0, 8, "Inteligente. Competidor-aware. Auto-calibravel. Sem ponta solta.", align="C")
pdf.set_xy(20, 122)
pdf.set_font("Helvetica", "", 12)
pdf.set_text_color(*WHITE)
pdf.multi_cell(PAGE_W - 40, 8,
    "Os 3 motores no mesmo nivel. O bot ve fundo (triangular), aprende sozinho e dispara nos melhores spreads. "
    "O que falta agora nao e codigo - e ligar a tomada de cada motor e deixar o dado real falar.",
    align="C")
pdf.set_xy(0, 175)
pdf.set_font("Helvetica", "I", 12)
pdf.set_text_color(*GREY)
pdf.cell(0, 8, '"Quando temos tudo planejado, menos tentados ficamos em improvisar."', align="C")
pdf.set_xy(0, 250)
pdf.set_font("Helvetica", "B", 11)
pdf.set_text_color(*GOLD)
pdf.cell(0, 6, "MAZARI CORP  -  ZEUS EVM", align="C")

out = "/home/user/zeus-evm/ZEUS_EVM_APRESENTACAO.pdf"
pdf.output(out)
print("OK ->", out)
