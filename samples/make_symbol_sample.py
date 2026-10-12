"""Makes samples/sample-symbols.pdf: a made-up plan with patio doors for trying symbol rules.

There are five patio doors (two the right way up, one turned a quarter, one upside down, one
mirrored) and three windows that look a little like them. Plandot should pin the doors and leave
the windows alone. Nothing here comes from a real project.

Rebuild:  pip install reportlab   then   python3 samples/make_symbol_sample.py
Positions are PDF points measured from the TOP-LEFT of the sheet.
"""
from pathlib import Path

from reportlab.lib.colors import Color
from reportlab.pdfgen import canvas

W, H = 1200, 800
OUT = Path(__file__).with_name("sample-symbols.pdf")
INK = Color(0.1, 0.1, 0.1)

c = canvas.Canvas(str(OUT), pagesize=(W, H), invariant=1)
c.setTitle("Sample patio doors (made up)")
c.setAuthor("")
c.setCreator("samples/make_symbol_sample.py")
c.setStrokeColor(INK)

# (x, y from the top, turn in degrees, mirrored)
DOORS = [(200, 150, 0, False), (600, 150, 0, False), (900, 450, 90, False), (300, 600, 180, False), (700, 620, 0, True)]
WINDOWS = [(1000, 150, 0), (150, 420, 90), (500, 400, 0)]


def at(x, y, turn, mirrored, draw):
    c.saveState()
    c.translate(x, H - y)
    c.rotate(-turn)  # clockwise on the sheet
    if mirrored:
        c.scale(-1, 1)
    draw()
    c.restoreState()


def door():
    c.setLineWidth(1.2)
    c.rect(-24, -4, 48, 8)            # frame
    c.line(-22, -1.2, 2, -1.2)        # sliding panels
    c.line(-2, 1.2, 22, 1.2)
    c.line(-24, -4, -24, -36)         # the door leaf, open a quarter turn
    c.arc(-60, -36, 12, 36, 270, 90)  # and its swing


def window():
    c.setLineWidth(1.2)
    c.rect(-24, -4, 48, 8)
    c.line(-24, 0, 24, 0)


# Walls: long lines with a gap where each door or window sits.
c.setLineWidth(3)
c.line(60, H - 150, 176, H - 150); c.line(224, H - 150, 576, H - 150); c.line(624, H - 150, 976, H - 150); c.line(1024, H - 150, 1140, H - 150)
c.line(60, H - 700, 1140, H - 700)
c.line(60, H - 60, 60, H - 700); c.line(1140, H - 60, 1140, H - 700)

for x, y, t, m in DOORS:
    at(x, y, t, m, door)
for x, y, t in WINDOWS:
    at(x, y, t, False, window)

c.setFont("Helvetica", 14)
for i, (x, y, *_r) in enumerate(DOORS, 1):
    c.drawString(x + 30, H - y - 30, f"PD{i}")
c.setFont("Helvetica", 22)
c.drawString(60, H - 40, "Sample patio doors (made up)")
c.save()
print("wrote", OUT)
