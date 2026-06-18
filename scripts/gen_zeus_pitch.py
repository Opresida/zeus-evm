# -*- coding: utf-8 -*-
"""ZEUS EVM - Pitch deck para investidor (fpdf2). Design escuro/arrojado, copy forte."""
from fpdf import FPDF

W, H = 210, 297
# Paleta dramatica
BLACK  = (9, 12, 22)
NAVY   = (15, 20, 38)
PANEL  = (22, 28, 50)
PANEL2 = (30, 38, 66)
GOLD   = (245, 193, 75)
GOLDD  = (200, 150, 40)
CYAN   = (84, 206, 244)
WHITE  = (244, 247, 252)
GREY   = (150, 162, 184)
GREYD  = (110, 122, 145)
GREEN  = (84, 214, 150)
RED    = (236, 104, 104)


class Pitch(FPDF):
    def footer(self):
        if self.page_no() == 1:
            return
        self.set_y(-11)
        self.set_font("Helvetica", "", 7.5)
        self.set_text_color(*GREYD)
        self.cell(0, 6, "ZEUS EVM  |  MAZARI CORP  |  Confidencial", align="L")
        self.cell(0, 6, f"{self.page_no():02d}", align="R")


def fill(pdf, color, x=0, y=0, w=W, h=H):
    pdf.set_fill_color(*color)
    pdf.rect(x, y, w, h, "F")


def page(pdf, bg=BLACK):
    pdf.add_page()
    fill(pdf, bg)


def kicker(pdf, x, y, text, color=GOLD):
    pdf.set_xy(x, y)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(*color)
    # letter-spacing manual
    pdf.cell(0, 5, "  ".join(list(text.upper())))


def headline(pdf, x, y, text, size=26, color=WHITE, w=W - 28, lh=11):
    pdf.set_xy(x, y)
    pdf.set_font("Helvetica", "B", size)
    pdf.set_text_color(*color)
    pdf.multi_cell(w, lh, text)


def body(pdf, x, y, text, size=11, color=GREY, w=W - 28, lh=6):
    pdf.set_xy(x, y)
    pdf.set_font("Helvetica", "", size)
    pdf.set_text_color(*color)
    pdf.multi_cell(w, lh, text)


def goldbar(pdf, x, y, w=22, h=3):
    pdf.set_fill_color(*GOLD)
    pdf.rect(x, y, w, h, "F")


def bolt(pdf, cx, cy, s=1.0, color=GOLD):
    pdf.set_fill_color(*color)
    pts = [(0, -10), (-4, -1), (-0.5, -1), (-3, 10), (5, -3), (1, -3), (4, -10)]
    pts = [(cx + px * s, cy + py * s) for px, py in pts]
    pdf.polygon(pts, "F")


def panel(pdf, x, y, w, h, color=PANEL):
    pdf.set_fill_color(*color)
    pdf.rect(x, y, w, h, "F")


def stat(pdf, x, y, w, big, label, accent=GOLD, big_size=30):
    panel(pdf, x, y, w, 34, PANEL)
    pdf.set_fill_color(*accent)
    pdf.rect(x, y, 2, 34, "F")
    pdf.set_xy(x + 6, y + 5)
    pdf.set_font("Helvetica", "B", big_size)
    pdf.set_text_color(*accent)
    pdf.cell(w - 10, 13, big)
    pdf.set_xy(x + 6, y + 22)
    pdf.set_font("Helvetica", "", 8.5)
    pdf.set_text_color(*GREY)
    pdf.multi_cell(w - 10, 4.5, label)


def featurecard(pdf, x, y, w, h, title, desc, accent=GOLD):
    panel(pdf, x, y, w, h, PANEL)
    pdf.set_fill_color(*accent)
    pdf.rect(x, y, w, 2, "F")
    pdf.set_xy(x + 6, y + 8)
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(*WHITE)
    pdf.cell(w - 12, 6, title)
    pdf.set_xy(x + 6, y + 17)
    pdf.set_font("Helvetica", "", 9.5)
    pdf.set_text_color(*GREY)
    pdf.multi_cell(w - 12, 5.2, desc)


def compare_strip(pdf, y, title, rows):
    """Faixa comparativa pra preencher o rodape com conteudo (3 colunas)."""
    h = 17 + len(rows) * 9 + 3
    fill(pdf, PANEL, 0, y, W, h)
    pdf.set_fill_color(*GOLD); pdf.rect(0, y, 3, h, "F")
    pdf.set_xy(14, y + 4)
    pdf.set_font("Helvetica", "B", 10.5)
    pdf.set_text_color(*WHITE)
    pdf.cell(0, 6, title)
    # cabecalho colunas (linha propria)
    pdf.set_font("Helvetica", "B", 7.5); pdf.set_text_color(*GREYD)
    pdf.set_xy(86, y + 11); pdf.cell(54, 4, "TRADING CLASSICO")
    pdf.set_xy(142, y + 11); pdf.cell(54, 4, "ZEUS")
    yy = y + 17
    for label, classic, zeus in rows:
        pdf.set_xy(14, yy); pdf.set_font("Helvetica", "", 8.8); pdf.set_text_color(*GREY)
        pdf.cell(70, 6, label)
        pdf.set_xy(86, yy); pdf.set_text_color(*RED); pdf.set_font("Helvetica", "", 8.8)
        pdf.cell(54, 6, classic)
        pdf.set_xy(142, yy); pdf.set_text_color(*GREEN); pdf.set_font("Helvetica", "B", 8.8)
        pdf.cell(54, 6, zeus)
        yy += 9


def bottom_band(pdf, y, h, head, text, accent=GOLD, pills=None):
    """Faixa de reforco pro rodape: headline + texto (+ pills opcionais)."""
    fill(pdf, PANEL, 0, y, W, h)
    pdf.set_fill_color(*accent); pdf.rect(0, y, 3, h, "F")
    pdf.set_xy(14, y + 6)
    pdf.set_font("Helvetica", "B", 13)
    pdf.set_text_color(*accent)
    pdf.cell(0, 7, head)
    pdf.set_xy(14, y + 15)
    pdf.set_font("Helvetica", "", 9.8)
    pdf.set_text_color(*GREY)
    pdf.multi_cell(W - 28, 5.4, text)
    if pills:
        px = 14
        for label, col in pills:
            pdf.set_font("Helvetica", "B", 8.5)
            wpill = pdf.get_string_width(label) + 9
            pdf.set_fill_color(*PANEL2); pdf.rect(px, y + h - 13, wpill, 8, "F")
            pdf.set_fill_color(*col); pdf.rect(px, y + h - 13, 1.6, 8, "F")
            pdf.set_xy(px + 3, y + h - 12.4); pdf.set_text_color(*WHITE)
            pdf.cell(wpill - 3, 7, label)
            px += wpill + 5


pdf = Pitch("P", "mm", "A4")
pdf.set_auto_page_break(False)
pdf.set_title("ZEUS EVM - Investidor")

# ════════════ 1. CAPA ════════════
page(pdf, BLACK)
fill(pdf, NAVY, 0, 0, W, H)
# brilho central
for i, c in enumerate([(18,24,46),(15,20,38)]):
    fill(pdf, c, 0, 70 + i*80, W, 80)
goldbar(pdf, 22, 78, 30, 3)
kicker(pdf, 22, 66, "MAZARI CORP")
bolt(pdf, 168, 96, 2.4, GOLD)
pdf.set_xy(0, 92)
pdf.set_font("Helvetica", "B", 70)
pdf.set_text_color(*WHITE)
pdf.cell(W, 30, "ZEUS", align="C")
pdf.set_xy(0, 132)
pdf.set_font("Helvetica", "B", 17)
pdf.set_text_color(*GOLD)
pdf.cell(W, 9, "A maquina que captura a ineficiencia do DeFi", align="C")
pdf.set_xy(30, 150)
pdf.set_font("Helvetica", "", 12.5)
pdf.set_text_color(*GREY)
pdf.multi_cell(W - 60, 7, "Arbitragem e liquidacao on-chain com CAPITAL ZERO via flashloan. "
                         "Lucro mecanico, atomico e sem risco de capital na execucao.", align="C")
# faixa inferior com 3 selos
yb = 215
fill(pdf, PANEL, 0, yb, W, 38)
seals = [("CAPITAL", "ZERO"), ("RISCO NA EXEC.", "ZERO"), ("MOTORES", "3 / qualquer mercado")]
sw = W / 3
for i, (a, b) in enumerate(seals):
    cx = sw * i
    pdf.set_xy(cx, yb + 8)
    pdf.set_font("Helvetica", "", 8.5)
    pdf.set_text_color(*GREY)
    pdf.cell(sw, 5, a, align="C")
    pdf.set_xy(cx, yb + 15)
    pdf.set_font("Helvetica", "B", 15)
    pdf.set_text_color(*GOLD)
    pdf.cell(sw, 8, b, align="C")
pdf.set_xy(0, 268)
pdf.set_font("Helvetica", "", 9)
pdf.set_text_color(*GREYD)
pdf.cell(W, 6, "Oportunidade de Investimento  -  Documento Confidencial", align="C")

# ════════════ 2. O GANCHO - PODER DO FLASHLOAN ════════════
page(pdf, BLACK)
kicker(pdf, 14, 16, "O poder do flashloan", CYAN)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Uma transacao.\nZero capital. Centenas de milhoes.", 25, WHITE, W - 28, 11)
body(pdf, 14, 62, "O flashloan e um emprestimo instantaneo, SEM garantia, que nasce e morre no mesmo bloco. "
                  "Permite mover milhoes em uma unica transacao - sem ter o dinheiro. O mercado ja viu o "
                  "poder dessa arma em eventos historicos:", 11, GREY, W - 28, 6)
# Timeline de casos reais
ty = 92
events = [
    ("2020", "bZx", "~US$ 1M", "o primeiro caso famoso - nasce a era flashloan", GREY),
    ("2020", "Harvest Finance", "~US$ 34M", "manipulacao de preco via flashloan", GREY),
    ("2021", "PancakeBunny", "~US$ 45M", "exploit em minutos, capital proprio zero", GOLD),
    ("2021", "Cream Finance", "~US$ 130M", "um dos maiores da historia DeFi", GOLD),
    ("2022", "Beanstalk", "~US$ 182M", "ataque de governanca relampago", GOLD),
    ("2023", "Euler Finance", "~US$ 197M", "movido por flashloan numa unica leva", CYAN),
]
# linha vertical
pdf.set_draw_color(*GOLDD)
pdf.set_line_width(0.5)
pdf.line(20, ty, 20, ty + len(events) * 22 - 6)
for i, (yr, name, amt, desc, col) in enumerate(events):
    ey = ty + i * 22
    pdf.set_fill_color(*col)
    pdf.ellipse(17.5, ey, 5, 5, "F")
    pdf.set_xy(28, ey - 1)
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(*WHITE)
    pdf.cell(60, 6, f"{name}")
    pdf.set_xy(28, ey + 6)
    pdf.set_font("Helvetica", "", 8.5)
    pdf.set_text_color(*GREY)
    pdf.cell(95, 4, f"{yr}  -  {desc}")
    pdf.set_xy(130, ey - 1)
    pdf.set_font("Helvetica", "B", 16)
    pdf.set_text_color(*col)
    pdf.cell(66, 7, amt, align="R")
# punchline
py = ty + len(events) * 22 + 2
fill(pdf, PANEL2, 0, py, W, 30)
pdf.set_fill_color(*GOLD); pdf.rect(0, py, 3, 30, "F")
pdf.set_xy(14, py + 6)
pdf.set_font("Helvetica", "B", 11.5)
pdf.set_text_color(*WHITE)
pdf.multi_cell(W - 28, 6, "ZEUS usa a MESMA arma - o flashloan - de forma LEGAL, atomica e sem risco de capital: "
                         "pra capturar arbitragem e liquidacao, nao para atacar.")
pdf.set_xy(14, py + 30 + 1.5)
pdf.set_font("Helvetica", "I", 7.5)
pdf.set_text_color(*GREYD)
pdf.cell(0, 4, "Valores publicos reportados. ZEUS opera arbitragem/liquidacao legitimas - os casos ilustram a ESCALA do primitivo.")

# ════════════ 3. A OPORTUNIDADE ════════════
page(pdf, BLACK)
kicker(pdf, 14, 16, "A oportunidade", GOLD)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "O DeFi e ineficiente POR DESIGN.\nE ineficiencia e dinheiro.", 24, WHITE, W - 28, 11)
body(pdf, 14, 62, "Nao e especulacao - e captura mecanica. Tres fontes de lucro existem 24/7, independente do "
                  "mercado subir ou cair:", 11, GREY, W - 28, 6)
cy = 80
featurecard(pdf, 14, cy, 58, 52, "Liquidacoes", "Sempre havera posicoes alavancadas em risco. "
            "Quando colapsam, quem liquida ganha um bonus garantido pelo protocolo.", GOLD)
featurecard(pdf, 76, cy, 58, 52, "Arbitragem", "O mesmo ativo tem precos diferentes em DEXs diferentes, "
            "o tempo todo. Comprar barato + vender caro na MESMA tx = lucro.", CYAN)
featurecard(pdf, 138, cy, 58, 52, "MEV / Backrun", "Volatilidade gera dislocacao de preco. Reagir rapido "
            "a grandes movimentos captura o reequilibrio.", GREEN)
# numerao
ny = cy + 60
stat(pdf, 14, ny, 88, "US$ bilhoes", "em MEV/ineficiencia extraida do DeFi por ano (mercado total)", GOLD)
stat(pdf, 108, ny, 88, "24 / 7 / 365", "as ineficiencias nao dormem - sao mecanicas e recorrentes", CYAN)
fill(pdf, PANEL2, 0, ny + 44, W, 24)
pdf.set_xy(14, ny + 51)
pdf.set_font("Helvetica", "B", 13)
pdf.set_text_color(*GOLD)
pdf.cell(0, 8, "O dinheiro ja esta na mesa. A questao e quem captura primeiro - e com que inteligencia.")
bottom_band(pdf, 212, 60,
            "Por que e RECORRENTE, nao um golpe de sorte:",
            "Liquidacoes acontecem todo dia que o mercado se mexe. Pools de DEXs diferentes raramente "
            "estao no mesmo preco. Whales movem o mercado a cada hora. Sao eventos MECANICOS e continuos - "
            "o bot nao precisa 'acertar o mercado', precisa estar presente e ser rapido.",
            CYAN, pills=[("Liquidacoes", GOLD), ("Spreads cross-DEX", CYAN), ("Backrun de whale", GREEN)])

# ════════════ 4. A SACADA (risco zero) ════════════
page(pdf, NAVY)
kicker(pdf, 14, 16, "A sacada", CYAN)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Voce nao pode perder\nna execucao.", 28, WHITE, W - 28, 12)
body(pdf, 14, 64, "Esse e o ponto que mais importa pra quem investe. A mecanica do ZEUS tem um piso de risco "
                  "estrutural - nao por promessa, mas por como o codigo funciona:", 11.5, GREY, W - 28, 6.2)
yy = 92
featurecard(pdf, 14, yy, 88, 56, "Atomic-only", "Se o trade nao da lucro, a transacao INTEIRA reverte. "
            "Nao existe 'trade pela metade'. O downside maximo de uma execucao e o gas - centavos.", GOLD)
featurecard(pdf, 108, yy, 88, 56, "Capital ZERO", "O flashloan empresta milhoes por 1 bloco, sem garantia. "
            "Sem deposito, sem risco de liquidacao da nossa posicao. O capital nao e nosso.", CYAN)
# equacao
ey = yy + 64
fill(pdf, PANEL, 0, ey, W, 50)
pdf.set_xy(14, ey + 8)
pdf.set_font("Helvetica", "B", 13)
pdf.set_text_color(*WHITE)
pdf.cell(0, 7, "A assimetria que todo investidor procura:")
pdf.set_xy(14, ey + 20)
pdf.set_font("Helvetica", "B", 16)
pdf.set_text_color(*RED)
pdf.cell(95, 9, "Downside:  o gas (centavos)")
pdf.set_xy(14, ey + 32)
pdf.set_font("Helvetica", "B", 16)
pdf.set_text_color(*GREEN)
pdf.cell(95, 9, "Upside:  o spread inteiro")
bolt(pdf, 170, ey + 26, 2.6, GOLD)
body(pdf, 14, ey + 56, "Risco de capital numa execucao = ZERO. O risco do negocio nao esta no trade - esta em "
                       "competir bem e cobrir custo de infra. E e exatamente ai que entra o diferencial do ZEUS.",
     10.5, GREY, W - 28, 6)
compare_strip(pdf, 230, "Por que e estruturalmente diferente de operar trading:", [
    ("Capital necessario", "alto (o seu)", "ZERO (flashloan)"),
    ("Risco numa operacao", "perda do capital", "so o gas"),
    ("Janela de exposicao", "minutos a dias", "1 bloco (atomico)"),
])

# ════════════ 5. ZEUS - A SOLUCAO ════════════
page(pdf, BLACK)
kicker(pdf, 14, 16, "A solucao", GOLD)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Tres motores. Qualquer mercado.", 25, WHITE, W - 28, 11)
body(pdf, 14, 46, "ZEUS nao aposta numa unica estrategia. Sao tres motores descorrelacionados - o bot fatura "
                  "no crash, no volume e na volatilidade. Quando um esfria, outro esquenta.", 11, GREY, W - 28, 6)
my = 70
motors = [
    ("MOTOR 1", "Liquidacoes", "Aave - Compound - Morpho - Seamless - Moonwell. Lucra quando o mercado DESPENCA.", "Mercado de CRASH", GOLD),
    ("MOTOR 2", "Arbitragem (Cross-DEX + Triangular)", "Captura divergencia de preco entre DEXs - inclusive ciclos triangulares 'na profundidade'. Lucra com VOLUME.", "Mercado de VOLUME", CYAN),
    ("MOTOR 3", "Backrun / MEV", "Reage a grandes movimentos (whales) capturando o reequilibrio. Lucra com VOLATILIDADE.", "Mercado de VOLATILIDADE", GREEN),
]
for i, (tag, name, desc, market, col) in enumerate(motors):
    yy = my + i * 50
    panel(pdf, 14, yy, 182, 44, PANEL)
    pdf.set_fill_color(*col); pdf.rect(14, yy, 2.5, 44, "F")
    pdf.set_xy(22, yy + 7)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(*col)
    pdf.cell(40, 5, tag)
    pdf.set_xy(22, yy + 13)
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(*WHITE)
    pdf.cell(150, 7, name)
    pdf.set_xy(22, yy + 23)
    pdf.set_font("Helvetica", "", 9.5)
    pdf.set_text_color(*GREY)
    pdf.multi_cell(135, 5, desc)
    # selo do mercado
    pdf.set_xy(150, yy + 9)
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(*col)
    pdf.multi_cell(40, 5, market, align="R")
bottom_band(pdf, 226, 54,
            "Descorrelacao = resiliencia.",
            "Um fundo que depende de uma unica estrategia quebra quando o mercado vira. ZEUS nao: quando "
            "as liquidacoes esfriam (mercado calmo), a arbitragem esquenta (volume); quando tudo dispara "
            "(volatilidade), o backrun captura. Tres fontes de receita que NAO sobem e descem juntas.",
            GOLD, pills=[("Crash", GOLD), ("Volume", CYAN), ("Volatilidade", GREEN)])

# ════════════ 6. O MOAT ════════════
page(pdf, NAVY)
kicker(pdf, 14, 16, "O diferencial", CYAN)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Nao e so um bot.\nE uma maquina que aprende.", 24, WHITE, W - 28, 11)
body(pdf, 14, 62, "Bots simples chutam. ZEUS sabe. Uma camada de inteligencia transforma cada operacao em dado, "
                  "e o bot se calibra sozinho - vendo o adversario em tempo real:", 11, GREY, W - 28, 6)
gy = 84
items = [
    ("Ve o competidor", "perfila quem disputa, mede quanto pagam pra ganhar a corrida (market-bribe).", GOLD),
    ("Reconcilia lucro", "esperado vs realizado + alarme quando algo quebra (drift sustentado).", CYAN),
    ("Post-mortem", "descobre QUEM nos ganhou e por que - e ajusta o lance.", GREEN),
    ("Auto-calibravel", "aperta/afrouxa os gates sozinho a partir do historico real.", GOLD),
    ("Ve na profundidade", "enxerga arbitragem triangular - onde os bots simples nao olham.", CYAN),
    ("Tudo observavel", "ledger + dashboards: nada se perde, nada e chute.", GREEN),
]
for i, (t, d, col) in enumerate(items):
    cx = 14 + (i % 2) * 94
    yy = gy + (i // 2) * 40
    panel(pdf, cx, yy, 88, 34, PANEL)
    pdf.set_fill_color(*col); pdf.rect(cx, yy, 88, 1.6, "F")
    pdf.set_xy(cx + 5, yy + 6)
    pdf.set_font("Helvetica", "B", 11.5)
    pdf.set_text_color(*WHITE)
    pdf.cell(80, 6, t)
    pdf.set_xy(cx + 5, yy + 14)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(*GREY)
    pdf.multi_cell(80, 4.8, d)
fill(pdf, PANEL2, 0, gy + 122, W, 20)
pdf.set_xy(14, gy + 128)
pdf.set_font("Helvetica", "B", 12.5)
pdf.set_text_color(*GOLD)
pdf.cell(0, 8, "O moat nao e velocidade pura - e INTELIGENCIA. Enquanto outros improvisam, ZEUS planeja.")

# ════════════ 7. MODELO DE LUCRO ════════════
page(pdf, BLACK)
kicker(pdf, 14, 16, "Como gera lucro", GOLD)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Lucro = spread x frequencia,\ncom custo de capital ZERO.", 22, WHITE, W - 28, 10)
body(pdf, 14, 60, "Como o capital e emprestado (flashloan), nao ha custo de capital - o lucro escala com a "
                  "FREQUENCIA de oportunidades capturadas e o spread medio liquido. Cenarios ilustrativos:",
     10.5, GREY, W - 28, 6)
# tabela de cenarios
ty = 84
heads = ["Cenario", "Op./dia", "Liquido medio/op.", "Potencial/mes*"]
ws = [44, 38, 56, 44]
rows = [
    ("Conservador", "5", "US$ 8", "~US$ 1,2k", GREY),
    ("Base", "20", "US$ 12", "~US$ 7,2k", WHITE),
    ("Otimista", "60", "US$ 18", "~US$ 32k", GOLD),
]
pdf.set_xy(14, ty)
pdf.set_fill_color(*PANEL2); pdf.set_text_color(*CYAN); pdf.set_font("Helvetica", "B", 9.5)
x = 14
for h, w in zip(heads, ws):
    pdf.set_xy(x, ty); pdf.cell(w, 9, " " + h, fill=True); x += w
yy = ty + 9
for name, opd, avg, mo, col in rows:
    x = 14
    pdf.set_fill_color(*(PANEL if name != "Otimista" else PANEL2))
    for val, w in zip([name, opd, avg, mo], ws):
        pdf.set_xy(x, yy)
        pdf.set_text_color(*(col if val == mo else WHITE))
        pdf.set_font("Helvetica", "B" if val == mo else "", 11)
        pdf.cell(w, 12, " " + val, fill=True); x += w
    yy += 12
pdf.set_xy(14, yy + 2)
pdf.set_font("Helvetica", "I", 8)
pdf.set_text_color(*GREYD)
pdf.multi_cell(W - 28, 4.5, "* Ilustrativo - potencial, NAO garantido. Pre-receita, em fase de validacao. Numeros dependem de "
              "competicao, liquidez e calibracao real. Servem pra mostrar a ALAVANCA do modelo (capital zero), nao uma promessa.")
# drivers
dy = yy + 16
stat(pdf, 14, dy, 58, "x0", "custo de capital (flashloan)", GREEN, 30)
stat(pdf, 76, dy, 58, "x N", "escala com frequencia de captura", CYAN, 30)
stat(pdf, 138, dy, 58, "atomico", "downside limitado ao gas", GOLD, 22)
body(pdf, 14, dy + 40, "A tese de 3 motores reduz a dependencia de um unico mercado: o potencial total e a SOMA "
                       "das oportunidades dos tres, descorrelacionadas.", 10.5, GREY, W - 28, 6)
bottom_band(pdf, dy + 56, 60,
            "A alavanca do modelo: escala sem capital.",
            "Num negocio tradicional, dobrar o lucro exige dobrar o capital. Aqui nao - como o capital e "
            "emprestado a cada operacao, o lucro escala com FREQUENCIA e QUALIDADE de captura (a inteligencia), "
            "nao com quanto dinheiro voce poe. A infra e custo fixo; cada oportunidade extra e margem quase pura.",
            GREEN, pills=[("Capital fixo: ~0", GREEN), ("Custo: infra + gas", CYAN), ("Margem: o spread", GOLD)])

# ════════════ 8. STATUS / POR QUE AGORA ════════════
page(pdf, NAVY)
kicker(pdf, 14, 16, "Onde estamos", GOLD)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Construido. Testado. Pronto pra ligar.", 22, WHITE, W - 28, 10)
body(pdf, 14, 50, "Transparencia total - o que esta pronto e o que falta:", 11, GREY, W - 28, 6)
sy = 64
PANEL_H = 116


def status_panel(px, head, hcol, items):
    panel(pdf, px, sy, 88, PANEL_H, PANEL)
    pdf.set_fill_color(*hcol); pdf.rect(px, sy, 88, 2, "F")
    pdf.set_xy(px + 6, sy + 8); pdf.set_font("Helvetica", "B", 12); pdf.set_text_color(*hcol)
    pdf.cell(0, 6, head)
    yy = sy + 20
    for title, sub in items:
        pdf.set_fill_color(*hcol); pdf.rect(px + 6, yy + 1.4, 2, 2, "F")
        pdf.set_xy(px + 11, yy); pdf.set_font("Helvetica", "B", 9); pdf.set_text_color(*WHITE)
        pdf.cell(72, 5, title)
        pdf.set_xy(px + 11, yy + 5); pdf.set_font("Helvetica", "", 7.8); pdf.set_text_color(*GREY)
        pdf.cell(72, 4, sub)
        yy += 13.2


status_panel(14, "PRONTO", GREEN, [
    ("3 motores inteligentes", "competidor-aware + auto-calibraveis"),
    ("Arbitragem cross-DEX executa", "re-cota fresco e dispara nos melhores"),
    ("Ve arbitragem triangular", "ciclos A->B->C->A na profundidade"),
    ("Inteligencia 100% ligada", "ledger + Grafana, nada se perde"),
    ("Contratos testados", "115 funcoes de teste Foundry"),
    ("~340 testes off-chain verdes", "typecheck + suite passando"),
    ("Audit interno (Pass 1+2)", "+ fixes H/M aplicados"),
])
status_panel(108, "PROXIMOS PASSOS", GOLD, [
    ("Coletar dados (DRY_RUN)", "mainnet read-only, sem deploy"),
    ("Validar edge", "qual motor fatura de verdade"),
    ("Deploy na mainnet", "quando o dado mandar"),
    ("Capital pequeno (4 sem.)", "validacao com risco baixo"),
    ("Infra: RPC pago + wallet", "+ mempool pro Motor 3"),
    ("Audit externo", "antes de capital alto"),
])
# faixa inferior cheia
by = sy + PANEL_H + 6
bh = 276 - by
fill(pdf, PANEL2, 0, by, W, bh)
pdf.set_fill_color(*GOLD); pdf.rect(0, by, 3, bh, "F")
pdf.set_xy(14, by + 6)
pdf.set_font("Helvetica", "B", 11.5); pdf.set_text_color(*WHITE)
pdf.multi_cell(W - 28, 6, "O que falta NAO e software - e ligar a infra e validar com dado real. "
                         "O risco de construcao ja foi pago.")
pdf.set_xy(14, by + 20)
pdf.set_font("Helvetica", "B", 10.5); pdf.set_text_color(*GOLD)
pdf.cell(0, 6, "Caminho ate a primeira receita:")
steps = [("1", "Coletar dados", "DRY_RUN mainnet"), ("2", "Validar edge", "qual motor fatura"),
         ("3", "Deploy + capital", "valor pequeno"), ("4", "Escalar", "audit + mais capital")]
sw = (W - 28) / 4
ly = by + 32
pdf.set_draw_color(*GOLDD); pdf.set_line_width(0.5)
pdf.line(20, ly + 4, W - 20, ly + 4)
for i, (n, t, d) in enumerate(steps):
    cx = 14 + sw * i
    pdf.set_fill_color(*NAVY); pdf.ellipse(cx + 2, ly, 8, 8, "F")
    pdf.set_xy(cx + 2, ly + 1.4); pdf.set_font("Helvetica", "B", 9); pdf.set_text_color(*GOLD)
    pdf.cell(8, 5, n, align="C")
    pdf.set_xy(cx + 13, ly - 0.5); pdf.set_font("Helvetica", "B", 9.5); pdf.set_text_color(*WHITE)
    pdf.cell(sw - 13, 5, t)
    pdf.set_xy(cx + 13, ly + 5); pdf.set_font("Helvetica", "", 7.6); pdf.set_text_color(*GREY)
    pdf.cell(sw - 14, 4, d)
# linha de fechamento grande
pdf.set_xy(14, ly + 18)
pdf.set_font("Helvetica", "B", 13.5); pdf.set_text_color(*WHITE)
pdf.multi_cell(W - 28, 7, "O investimento nao paga risco de construcao - compra VELOCIDADE de validacao "
                         "e a infra pra ligar os tres motores.")

# ════════════ 9. O CONVITE ════════════
page(pdf, BLACK)
fill(pdf, NAVY, 0, 0, W, H)
bolt(pdf, 105, 64, 4.2, GOLD)
pdf.set_xy(0, 92)
pdf.set_font("Helvetica", "B", 34)
pdf.set_text_color(*WHITE)
pdf.cell(W, 16, "O dinheiro ja esta na mesa.", align="C")
pdf.set_xy(0, 112)
pdf.set_font("Helvetica", "B", 20)
pdf.set_text_color(*GOLD)
pdf.cell(W, 11, "ZEUS foi construido pra captura-lo.", align="C")
pdf.set_xy(28, 134)
pdf.set_font("Helvetica", "", 12.5)
pdf.set_text_color(*GREY)
pdf.multi_cell(W - 56, 7, "Capital zero. Risco de execucao zero. Tres motores que faturam em qualquer mercado, "
                         "com uma inteligencia que aprende e se calibra sozinha. O hard work de engenharia esta feito "
                         "e testado - falta ligar a tomada.", align="C")
# 3 highlights
hy = 178
hl = [("ZERO", "capital proprio na execucao"), ("3", "motores descorrelacionados"), ("100%", "inteligencia ligada")]
sw = W / 3
for i, (a, b) in enumerate(hl):
    cx = sw * i
    pdf.set_xy(cx, hy)
    pdf.set_font("Helvetica", "B", 26)
    pdf.set_text_color(*GOLD)
    pdf.cell(sw, 12, a, align="C")
    pdf.set_xy(cx + 8, hy + 14)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(*GREY)
    pdf.multi_cell(sw - 16, 4.5, b, align="C")
fill(pdf, PANEL, 0, 232, W, 34)
pdf.set_xy(0, 240)
pdf.set_font("Helvetica", "B", 14)
pdf.set_text_color(*WHITE)
pdf.cell(W, 8, "Vamos conversar.", align="C")
pdf.set_xy(0, 250)
pdf.set_font("Helvetica", "B", 10.5)
pdf.set_text_color(*GOLD)
pdf.cell(W, 6, "MAZARI CORP  -  ZEUS EVM", align="C")

out = "/home/user/zeus-evm/ZEUS_EVM_PITCH_INVESTIDOR.pdf"
pdf.output(out)
print("OK ->", out)
