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
    """Faixa comparativa pra preencher o rodape com conteúdo (3 colunas)."""
    h = 17 + len(rows) * 9 + 3
    fill(pdf, PANEL, 0, y, W, h)
    pdf.set_fill_color(*GOLD); pdf.rect(0, y, 3, h, "F")
    pdf.set_xy(14, y + 4)
    pdf.set_font("Helvetica", "B", 10.5)
    pdf.set_text_color(*WHITE)
    pdf.cell(0, 6, title)
    # cabecalho colunas (linha própria)
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
pdf.cell(W, 9, "A máquina que captura a ineficiência do DeFi", align="C")
pdf.set_xy(30, 150)
pdf.set_font("Helvetica", "", 12.5)
pdf.set_text_color(*GREY)
pdf.multi_cell(W - 60, 7, "Arbitragem e liquidação on-chain com CAPITAL ZERO via flashloan. "
                         "Lucro mecânico, atômico e sem risco de capital na execução.", align="C")
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
headline(pdf, 14, 30, "Uma transação.\nZero capital. Centenas de milhões.", 25, WHITE, W - 28, 11)
body(pdf, 14, 62, "O flashloan é um empréstimo instantâneo, SEM garantia, que nasce e morre no mesmo bloco. "
                  "Permite mover milhões em uma única transação - sem ter o dinheiro. O mercado já viu o "
                  "poder dessa arma em eventos históricos:", 11, GREY, W - 28, 6)
# Timeline de casos reais
ty = 92
events = [
    ("2020", "bZx", "~US$ 1M", "o primeiro caso famoso - nasce a era flashloan", GREY),
    ("2020", "Harvest Finance", "~US$ 34M", "manipulação de preço via flashloan", GREY),
    ("2021", "PancakeBunny", "~US$ 45M", "exploit em minutos, capital próprio zero", GOLD),
    ("2021", "Cream Finance", "~US$ 130M", "um dos maiores da história DeFi", GOLD),
    ("2022", "Beanstalk", "~US$ 182M", "ataque de governança relâmpago", GOLD),
    ("2023", "Euler Finance", "~US$ 197M", "movido por flashloan numa única leva", CYAN),
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
pdf.multi_cell(W - 28, 6, "ZEUS usa a MESMA arma - o flashloan - de forma LEGAL, atômica e sem risco de capital: "
                         "pra capturar arbitragem e liquidação, não para atacar.")
pdf.set_xy(14, py + 30 + 1.5)
pdf.set_font("Helvetica", "I", 7.5)
pdf.set_text_color(*GREYD)
pdf.cell(0, 4, "Valores públicos reportados. ZEUS opera arbitragem/liquidação legítimas - os casos ilustram a ESCALA do primitivo.")

# ════════════ 3. A OPORTUNIDADE ════════════
page(pdf, BLACK)
kicker(pdf, 14, 16, "A oportunidade", GOLD)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "O DeFi é ineficiente POR DESIGN.\nE ineficiência é dinheiro.", 24, WHITE, W - 28, 11)
body(pdf, 14, 62, "Não é especulação - é captura mecânica. Três fontes de lucro existem 24/7, independente do "
                  "mercado subir ou cair:", 11, GREY, W - 28, 6)
cy = 80
featurecard(pdf, 14, cy, 58, 52, "Liquidações", "Sempre haverá posições alavancadas em risco. "
            "Quando colapsam, quem liquida ganha um bonus garantido pelo protocolo.", GOLD)
featurecard(pdf, 76, cy, 58, 52, "Arbitragem", "O mesmo ativo tem preços diferentes em DEXs diferentes, "
            "o tempo todo. Comprar barato + vender caro na MESMA tx = lucro.", CYAN)
featurecard(pdf, 138, cy, 58, 52, "MEV / Backrun", "Volatilidade gera dislocação de preço. Reagir rápido "
            "a grandes movimentos captura o reequilíbrio.", GREEN)
# numerao
ny = cy + 60
stat(pdf, 14, ny, 88, "US$ bilhões", "em MEV/ineficiência extraida do DeFi por ano (mercado total)", GOLD)
stat(pdf, 108, ny, 88, "24 / 7 / 365", "as ineficiências não dormem - são mecânicas e recorrentes", CYAN)
fill(pdf, PANEL2, 0, ny + 44, W, 24)
pdf.set_xy(14, ny + 51)
pdf.set_font("Helvetica", "B", 13)
pdf.set_text_color(*GOLD)
pdf.cell(0, 8, "O dinheiro já está na mesa. A questão é quem captura primeiro - é com que inteligência.")
bottom_band(pdf, 212, 60,
            "Por que é RECORRENTE, não um golpe de sorte:",
            "Liquidações acontecem todo dia que o mercado se mexe. Pools de DEXs diferentes raramente "
            "estão no mesmo preço. Whales movem o mercado a cada hora. São eventos MECÂNICOS e contínuos - "
            "o bot não precisa 'acertar o mercado', precisa estar presente e ser rápido.",
            CYAN, pills=[("Liquidações", GOLD), ("Spreads cross-DEX", CYAN), ("Backrun de whale", GREEN)])

# ════════════ 4. A SACADA (risco zero) ════════════
page(pdf, NAVY)
kicker(pdf, 14, 16, "A sacada", CYAN)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Você não pode perder\nna execução.", 28, WHITE, W - 28, 12)
body(pdf, 14, 64, "Esse é o ponto que mais importa pra quem investe. A mecânica do ZEUS tem um piso de risco "
                  "estrutural - não por promessa, mas por como o código funciona:", 11.5, GREY, W - 28, 6.2)
yy = 92
featurecard(pdf, 14, yy, 88, 56, "Atomic-only", "Se o trade não dá lucro, a transação INTEIRA reverte. "
            "Não existe 'trade pela metade'. O downside máximo de uma execução é o gás - centavos.", GOLD)
featurecard(pdf, 108, yy, 88, 56, "Capital ZERO", "O flashloan empresta milhões por 1 bloco, sem garantia. "
            "Sem depósito, sem risco de liquidação da nossa posição. O capital não é nosso.", CYAN)
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
pdf.cell(95, 9, "Downside:  o gás (centavos)")
pdf.set_xy(14, ey + 32)
pdf.set_font("Helvetica", "B", 16)
pdf.set_text_color(*GREEN)
pdf.cell(95, 9, "Upside:  o spread inteiro")
bolt(pdf, 170, ey + 26, 2.6, GOLD)
body(pdf, 14, ey + 56, "Risco de capital numa execução = ZERO. O risco do negócio não está no trade - esta em "
                       "competir bem e cobrir custo de infra. E é exatamente aí que entra o diferencial do ZEUS.",
     10.5, GREY, W - 28, 6)
compare_strip(pdf, 230, "Por que é estruturalmente diferente de operar trading:", [
    ("Capital necessário", "alto (o seu)", "ZERO (flashloan)"),
    ("Risco numa operação", "perda do capital", "so o gás"),
    ("Janela de exposição", "minutos a dias", "1 bloco (atômico)"),
])

# ════════════ 5. ZEUS - A SOLUCAO ════════════
page(pdf, BLACK)
kicker(pdf, 14, 16, "A solucao", GOLD)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Três motores. Qualquer mercado.", 25, WHITE, W - 28, 11)
body(pdf, 14, 46, "ZEUS não aposta numa única estratégia. São três motores descorrelacionados - o bot fatura "
                  "no crash, no volume e na volatilidade. Quando um esfria, outro esquenta.", 11, GREY, W - 28, 6)
my = 70
motors = [
    ("MOTOR 1", "Liquidações", "Aave - Compound - Morpho - Seamless - Moonwell. Lucra quando o mercado DESPENCA.", "Mercado de CRASH", GOLD),
    ("MOTOR 2", "Arbitragem (Cross-DEX + Triangular)", "Captura divergencia de preço entre DEXs - inclusive ciclos triangulares 'na profundidade'. Lucra com VOLUME.", "Mercado de VOLUME", CYAN),
    ("MOTOR 3", "Backrun / MEV", "Reage a grandes movimentos (whales) capturando o reequilíbrio. Lucra com VOLATILIDADE.", "Mercado de VOLATILIDADE", GREEN),
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
            "Descorrelação = resiliência.",
            "Um fundo que depende de uma única estratégia quebra quando o mercado vira. ZEUS não: quando "
            "as liquidações esfriam (mercado calmo), a arbitragem esquenta (volume); quando tudo dispara "
            "(volatilidade), o backrun captura. Três fontes de receita que NÃO sobem e descem juntas.",
            GOLD, pills=[("Crash", GOLD), ("Volume", CYAN), ("Volatilidade", GREEN)])

# ════════════ 6. O MOAT ════════════
page(pdf, NAVY)
kicker(pdf, 14, 16, "O diferencial", CYAN)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Não é só um bot.\nÉ uma máquina que aprende.", 24, WHITE, W - 28, 11)
body(pdf, 14, 62, "Bots simples chutam. ZEUS sabe. Uma camada de inteligência transforma cada operação em dado, "
                  "e o bot se calibra sozinho - vendo o adversário em tempo real:", 11, GREY, W - 28, 6)
gy = 84
items = [
    ("Vê o competidor", "perfila quem disputa, mede quanto pagam pra ganhar a corrida (market-bribe).", GOLD),
    ("Reconcilia lucro", "esperado vs realizado + alarme quando algo quebra (drift sustentado).", CYAN),
    ("Post-mortem", "descobre QUEM nos ganhou e por que - e ajusta o lance.", GREEN),
    ("Auto-calibrável", "aperta/afrouxa os gates sozinho a partir do histórico real.", GOLD),
    ("Vê na profundidade", "enxerga arbitragem triangular - onde os bots simples não olham.", CYAN),
    ("Tudo observável", "ledger + dashboards: nada se perde, nada é chute.", GREEN),
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
fill(pdf, PANEL2, 0, gy + 120, W, 26)
pdf.set_xy(14, gy + 125)
pdf.set_font("Helvetica", "B", 12)
pdf.set_text_color(*GOLD)
pdf.multi_cell(W - 28, 6.5, "O moat não é velocidade pura - é INTELIGÊNCIA.\n"
                           "Enquanto outros improvisam, ZEUS planeja.", align="C")

# ════════════ 7. MODELO DE LUCRO ════════════
page(pdf, BLACK)
kicker(pdf, 14, 16, "Como gera lucro", GOLD)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Lucro = spread x frequência,\ncom custo de capital ZERO.", 22, WHITE, W - 28, 10)
body(pdf, 14, 60, "Como o capital é emprestado (flashloan), não há custo de capital - o lucro escala com a "
                  "FREQUENCIA de oportunidades capturadas e o spread médio líquido. Cenários ilustrativos:",
     10.5, GREY, W - 28, 6)
# tabela de cenarios
ty = 84
heads = ["Cenário", "Op./dia", "Líquido médio/op.", "Potencial/mes*"]
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
pdf.multi_cell(W - 28, 4.5, "* Ilustrativo - potencial, NÃO garantido. Pré-receita, em fase de validação. Números dependem de "
              "competição, liquidez e calibracao real. Servem pra mostrar a ALAVANCA do modelo (capital zero), não uma promessa.")
# drivers
dy = yy + 16
stat(pdf, 14, dy, 58, "x0", "custo de capital (flashloan)", GREEN, 30)
stat(pdf, 76, dy, 58, "x N", "escala com frequência de captura", CYAN, 30)
stat(pdf, 138, dy, 58, "atômico", "downside limitado ao gás", GOLD, 22)
body(pdf, 14, dy + 40, "A tese de 3 motores reduz a dependência de um único mercado: o potencial total é a SOMA "
                       "das oportunidades dos três, descorrelacionadas.", 10.5, GREY, W - 28, 6)
bottom_band(pdf, dy + 56, 60,
            "A alavanca do modelo: escala sem capital.",
            "Num negócio tradicional, dobrar o lucro exige dobrar o capital. Aqui não - como o capital e "
            "emprestado a cada operação, o lucro escala com FREQUENCIA e QUALIDADE de captura (a inteligência), "
            "não com quanto dinheiro você poe. A infra é custo fixo; cada oportunidade extra é margem quase pura.",
            GREEN, pills=[("Capital fixo: ~0", GREEN), ("Custo: infra + gás", CYAN), ("Margem: o spread", GOLD)])

# ════════════ 8. STATUS / POR QUE AGORA ════════════
page(pdf, NAVY)
kicker(pdf, 14, 16, "Onde estamos", GOLD)
goldbar(pdf, 14, 24, 22, 3)
headline(pdf, 14, 30, "Construído. Testado. Pronto pra ligar.", 22, WHITE, W - 28, 10)
body(pdf, 14, 50, "Transparência total - o que esta pronto e o que falta:", 11, GREY, W - 28, 6)
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
    ("3 motores inteligentes", "competidor-aware + auto-calibráveis"),
    ("Arbitragem cross-DEX executa", "re-cota fresco e dispara nos melhores"),
    ("Vê arbitragem triangular", "ciclos A->B->C->A na profundidade"),
    ("Inteligencia 100% ligada", "ledger + Grafana, nada se perde"),
    ("Contratos testados", "115 funções de teste Foundry"),
    ("~340 testes off-chain verdes", "typecheck + suite passando"),
    ("Audit interno (Pass 1+2)", "+ fixes H/M aplicados"),
])
status_panel(108, "PROXIMOS PASSOS", GOLD, [
    ("Coletar dados (DRY_RUN)", "mainnet read-only, sem deploy"),
    ("Validar edge", "qual motor fatura de verdade"),
    ("Deploy na mainnet", "quando o dado mandar"),
    ("Capital pequeno (4 sem.)", "validação com risco baixo"),
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
pdf.multi_cell(W - 28, 6, "O que falta NÃO e software - e ligar a infra e validar com dado real. "
                         "O risco de construção já foi pago.")
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
pdf.multi_cell(W - 28, 7, "O investimento não paga risco de construção - compra VELOCIDADE de validação "
                         "e a infra pra ligar os três motores.")

# ════════════ 9. O CONVITE ════════════
page(pdf, BLACK)
fill(pdf, NAVY, 0, 0, W, H)
bolt(pdf, 105, 64, 4.2, GOLD)
pdf.set_xy(0, 92)
pdf.set_font("Helvetica", "B", 34)
pdf.set_text_color(*WHITE)
pdf.cell(W, 16, "O dinheiro já está na mesa.", align="C")
pdf.set_xy(0, 112)
pdf.set_font("Helvetica", "B", 20)
pdf.set_text_color(*GOLD)
pdf.cell(W, 11, "ZEUS foi construído pra capturá-lo.", align="C")
pdf.set_xy(28, 134)
pdf.set_font("Helvetica", "", 12.5)
pdf.set_text_color(*GREY)
pdf.multi_cell(W - 56, 7, "Capital zero. Risco de execução zero. Três motores que faturam em qualquer mercado, "
                         "com uma inteligência que aprende e se calibra sozinha. O hard work de engenharia esta feito "
                         "e testado - falta ligar a tomada.", align="C")
# 3 highlights
hy = 178
hl = [("ZERO", "capital próprio na execução"), ("3", "motores descorrelacionados"), ("100%", "inteligência ligada")]
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
