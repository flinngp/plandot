"""Makes samples/sample-drawing.pdf: a made-up floor plan with tagged callouts.

Nothing in it comes from a real project or a real customer. It exists so Plandot can be
demonstrated and tested without anyone's confidential drawings.

Callouts are drawn the way CAD drawings draw them: a tag inside an outline (diamond,
circle or hexagon), with a leader line running to a solid dot on the thing it tags.
  A1-A3  diamond  -> socket outlets   (one has no leader, one has an elbow leader)
  B1     circle   -> TV points        (one has two leaders, so it gives two dots)
  C1-C3  hexagon  -> cavity barriers  (elbow leaders to dots on the outer walls)

To rebuild the PDF:   pip install reportlab   then   python3 samples/make_sample_drawing.py
All positions are in PDF points, measured from the TOP-LEFT of the sheet (a 34 x 22 inch sheet
is 2448 x 1584 points). test/sample.test.mjs checks that Plandot finds every dot listed here.
"""

from math import cos, radians, sin
from pathlib import Path

from reportlab.lib.colors import Color, black
from reportlab.pdfgen import canvas

W, H = 2448, 1584
OUT = Path(__file__).with_name("sample-drawing.pdf")

GREY = Color(0.35, 0.35, 0.35)
LIGHT = Color(0.6, 0.6, 0.6)

# invariant=1 keeps the file byte-for-byte the same each time it is rebuilt.
c = canvas.Canvas(str(OUT), pagesize=(W, H), invariant=1)
c.setTitle("Sample floor plan (made up)")
c.setAuthor("")
c.setSubject("Made-up drawing for demonstrating Plandot")
c.setCreator("samples/make_sample_drawing.py")


def Y(y):
    """Top-left y to PDF y."""
    return H - y


def stroke(points, width=1.2, colour=black, closed=False):
    path = c.beginPath()
    path.moveTo(points[0][0], Y(points[0][1]))
    for x, y in points[1:]:
        path.lineTo(x, Y(y))
    if closed:
        path.close()
    c.setLineWidth(width)
    c.setStrokeColor(colour)
    c.drawPath(path, stroke=1, fill=0)


def text(cx, cy, s, size=14, font="Helvetica", align="c", colour=black):
    """Draw text with its visual centre (or left edge) at cx, cy."""
    c.setFillColor(colour)
    c.setFont(font, size)
    baseline = Y(cy + size * 0.35)
    if align == "c":
        c.drawCentredString(cx, baseline, s)
    else:
        c.drawString(cx, baseline, s)


def dot(x, y, r=3.2):
    c.setFillColor(black)
    c.circle(x, Y(y), r, stroke=0, fill=1)


# ---- callout symbols (each returns nothing; leaders are drawn separately) ------------------------

def diamond(cx, cy, tag=None, h=17):
    stroke([(cx - h, cy), (cx, cy - h), (cx + h, cy), (cx, cy + h)], closed=True)
    if tag:
        text(cx, cy, tag, 14)


def ring(cx, cy, tag=None, r=17):
    c.setLineWidth(1.2)
    c.setStrokeColor(black)
    c.circle(cx, Y(cy), r, stroke=1, fill=0)
    if tag:
        text(cx, cy, tag, 14)


def hexagon(cx, cy, tag=None, r=18):
    pts = [(cx + r * cos(radians(a)), cy + r * sin(radians(a))) for a in range(0, 360, 60)]
    stroke(pts, closed=True)
    if tag:
        text(cx, cy, tag, 13)


def leader(*points):
    stroke(list(points), 1.2)


# ---- the building -------------------------------------------------------------------------------

X0, X1, Y0, Y1 = 300, 1500, 250, 1250
stroke([(X0, Y0), (X1, Y0), (X1, Y1), (X0, Y1)], width=10, colour=GREY, closed=True)

# interior walls, with gaps where the doors are
for ya, yb in [(250, 430), (500, 750), (750, 930), (1000, 1250)]:
    stroke([(700, ya), (700, yb)], width=6, colour=GREY)
for ya, yb in [(250, 470), (540, 750), (750, 960), (1030, 1250)]:
    stroke([(1100, ya), (1100, yb)], width=6, colour=GREY)
for xa, xb in [(300, 420), (490, 880), (950, 1260), (1330, 1500)]:
    stroke([(xa, 750), (xb, 750)], width=6, colour=GREY)
# door leaves
for (x1, y1, x2, y2) in [(700, 430, 760, 410), (1100, 470, 1160, 450), (420, 750, 440, 690),
                         (880, 750, 900, 810), (1260, 750, 1280, 690), (700, 930, 760, 950), (1100, 960, 1160, 980)]:
    stroke([(x1, y1), (x2, y2)], width=1.4, colour=LIGHT)

# room labels: name, then a box with the room number and area (as on a real plan)
rooms = [
    (500, 500, "OFFICE", "1-101", "180 SF"), (900, 500, "MEETING", "1-102", "160 SF"),
    (1300, 500, "OPEN PLAN", "1-103", "240 SF"), (500, 1000, "STORE", "1-104", "90 SF"),
    (900, 1000, "KITCHEN", "1-105", "120 SF"), (1300, 1000, "RECEPTION", "1-106", "210 SF"),
]
for cx, cy, name, number, area in rooms:
    text(cx, cy - 20, name, 22)
    c.setLineWidth(1)
    c.setStrokeColor(black)
    c.rect(cx - 45, Y(cy + 48), 90, 40, stroke=1, fill=0)
    c.line(cx - 45, Y(cy + 28), cx + 45, Y(cy + 28))
    text(cx, cy + 18, number, 14)
    text(cx, cy + 38, area, 12)

text(700, 1330, "SEE DETAIL 1/A1.01 FOR WALL BUILD-UP", 14, align="c")

# ---- callouts -----------------------------------------------------------------------------------
# Socket outlets: diamonds
diamond(590, 330, "A1")
leader((573, 330), (480, 330))
dot(480, 330)

diamond(960, 340, "A2")  # elbow leader: down, then left
leader((960, 357), (960, 420), (900, 420))
dot(900, 420)

diamond(1190, 340, "A2")
leader((1173, 340), (1100, 340))
dot(1100, 340)  # on the wall

diamond(520, 880, "A3")
leader((520, 863), (520, 800))
dot(520, 800)

diamond(1330, 1150, "A1")
leader((1313, 1150), (1240, 1150))
dot(1240, 1150)

diamond(1400, 620, "A2")  # no leader at all: Plandot keeps this one on the callout

# TV points: circles
ring(900, 1130, "B1")
leader((917, 1130), (1000, 1130))
dot(1000, 1130)

ring(1300, 880, "B1")  # two leaders: two dots, so two tasks
leader((1283, 880), (1210, 880))
dot(1210, 880)
leader((1317, 880), (1400, 880))
dot(1400, 880)

# Cavity barriers: hexagons
hexagon(400, 170, "C1")
leader((418, 170), (440, 170), (440, 250))
dot(440, 250)

hexagon(900, 170, "C2")
leader((918, 170), (940, 170), (940, 250))
dot(940, 250)

hexagon(1400, 1330, "C3")
leader((1418, 1330), (1440, 1330), (1440, 1250))
dot(1440, 1250)

hexagon(230, 620, "C1")
leader((248, 620), (300, 620))
dot(300, 620)

# north arrow: one filled triangle, which is NOT a dot
c.setFillColor(black)
tri = c.beginPath()
tri.moveTo(1700, Y(240))
tri.lineTo(1688, Y(280))
tri.lineTo(1712, Y(280))
tri.close()
c.drawPath(tri, stroke=0, fill=1)
text(1700, 300, "N", 16)

# ---- title block and key -------------------------------------------------------------------------
c.setLineWidth(2)
c.setStrokeColor(black)
c.rect(1950, Y(1520), 450, 1460, stroke=1, fill=0)
text(2175, 130, "SAMPLE PROJECT", 28, "Helvetica-Bold")
text(2175, 175, "Made-up drawing for demonstrating Plandot.", 14)
text(2175, 198, "Not a real building or a real customer.", 14)

text(2175, 300, "CALLOUT KEY", 18, "Helvetica-Bold")
for i, (kind, label) in enumerate([("d", "Socket outlet"), ("r", "TV point"), ("h", "Cavity barrier"), ("o", "Task location")]):
    y = 360 + i * 60
    if kind == "d":
        diamond(2030, y)
    elif kind == "r":
        ring(2030, y)
    elif kind == "h":
        hexagon(2030, y)
    else:
        dot(2030, y)
    text(2075, y, label, 16, align="l")

text(2175, 1380, "GROUND FLOOR PLAN", 30, "Helvetica-Bold")
text(2175, 1430, "Sheet P-101", 20)
text(2175, 1470, "Not to scale", 14)

c.showPage()
c.save()
print("wrote", OUT)
