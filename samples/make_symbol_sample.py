"""Makes samples/sample-symbols.pdf: a made-up floor plan with patio doors for trying symbol rules.

The plan has rooms, walls, a little furniture, dimensions and a title block. Five patio doors sit in
the outside walls (two the right way up, one turned a quarter, one upside down, one mirrored) with
three windows that look a little like them. Plandot should pin the doors and leave the windows
alone. Nothing here comes from a real project.

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

GREY = Color(0.55, 0.55, 0.55)
WALL = Color(0.22, 0.22, 0.22)
WHITE = Color(1, 1, 1)
Y = lambda y: H - y  # top-left y to PDF y

# (x, y from the top, turn in degrees, mirrored, label x, label y)
DOORS = [(200, 150, 0, False, 238, 190), (600, 150, 0, False, 638, 190), (1140, 560, 90, False, 1040, 610),
         (300, 700, 180, False, 338, 660), (700, 700, 180, True, 738, 660)]
WINDOWS = [(1000, 150, 0), (60, 560, 90), (500, 700, 0)]


def at(x, y, turn, mirrored, draw):
    c.saveState()
    c.translate(x, Y(y))
    c.rotate(-turn)  # clockwise on the sheet
    if mirrored:
        c.scale(-1, 1)
    draw()
    c.restoreState()


def door():
    c.setStrokeColor(INK); c.setLineWidth(1.2)
    c.rect(-24, -4, 48, 8)            # frame
    c.line(-22, -1.2, 2, -1.2)        # sliding panels
    c.line(-2, 1.2, 22, 1.2)
    c.line(-24, -4, -24, -36)         # the door leaf, open a quarter turn
    c.arc(-60, -36, 12, 36, 270, 90)  # and its swing


def window():
    c.setStrokeColor(INK); c.setLineWidth(1.2)
    c.rect(-24, -4, 48, 8)
    c.line(-24, 0, 24, 0)


def strips(a, b, gaps):
    """Split the span a..b around openings given as (centre, width)."""
    out, cur = [], a
    for g, w in sorted(gaps):
        out.append((cur, g - w / 2)); cur = g + w / 2
    out.append((cur, b))
    return out


def wall(horizontal, at_, a, b, gaps=(), t=8):
    c.setFillColor(WALL); c.setStrokeColor(WALL); c.setLineWidth(0.5)
    for s0, s1 in strips(a, b, gaps):
        if horizontal:
            c.rect(s0, Y(at_) - t / 2, s1 - s0, t, fill=1, stroke=0)
        else:
            c.rect(at_ - t / 2, Y(s1), t, s1 - s0, fill=1, stroke=0)


def leaf(x, y, vertical, size=34, flip=1):
    """An ordinary room door: a thin leaf and its swing arc (no frame, unlike the patio doors)."""
    c.setStrokeColor(GREY); c.setLineWidth(0.8)
    if vertical:
        c.line(x, Y(y - size / 2 * flip), x + size * flip, Y(y - size / 2 * flip))
        c.arc(x - size + size * flip, Y(y - size / 2 * flip) - size, x + size + size * flip, Y(y - size / 2 * flip) + size, 0 if flip > 0 else 90, 90)
    else:
        c.line(x - size / 2 * flip, Y(y), x - size / 2 * flip, Y(y) + size * flip)


def box(x0, y0, x1, y1, dash=False):
    c.setStrokeColor(GREY); c.setLineWidth(0.8)
    if dash: c.setDash(3, 3)
    c.rect(x0, Y(y1), x1 - x0, y1 - y0)
    c.setDash()


def disc(x, y, r):
    c.setStrokeColor(GREY); c.setLineWidth(0.8); c.circle(x, Y(y), r)


# --- walls: outside walls thick, partitions thinner, a gap wherever a door or window sits
OUTSIDE = dict(t=10)
wall(True, 150, 60, 1140, gaps=[(200, 48), (600, 48), (1000, 48)], **OUTSIDE)
wall(True, 700, 60, 1140, gaps=[(300, 48), (500, 48), (700, 48)], **OUTSIDE)
wall(False, 60, 150, 700, gaps=[(560, 48)], **OUTSIDE)
wall(False, 1140, 150, 700, gaps=[(560, 48)], **OUTSIDE)
wall(True, 430, 60, 1140, gaps=[(240, 40), (900, 40)], t=6)
wall(False, 420, 150, 430, gaps=[(340, 40)], t=6)
wall(False, 780, 150, 430, gaps=[(340, 40)], t=6)
wall(False, 600, 430, 700, gaps=[(520, 40)], t=6)

# --- furniture (light grey, so the doors and windows stay the clear detail)
box(110, 330, 290, 378); box(150, 270, 250, 305)                       # living: sofa, coffee table
disc(600, 300, 55); [disc(600 + dx, 300 + dy, 13) for dx, dy in ((0, -78), (0, 78), (-78, 0), (78, 0))]  # dining
box(880, 330, 1060, 372); disc(970, 405, 16); box(1090, 190, 1120, 330)  # study: desk, chair, shelves
box(120, 470, 470, 520); box(200, 560, 380, 600); box(80, 640, 160, 685, dash=True)  # lounge
box(800, 500, 980, 560); disc(1080, 470, 16); disc(1080, 650, 16)      # garden room

# --- ordinary room doors (a thin leaf and arc, nothing like the patio doors)
leaf(420, 340, True); leaf(780, 340, True); leaf(600, 520, True, flip=-1)
c.setStrokeColor(GREY); c.setLineWidth(0.8)
c.line(220, Y(430), 220, Y(430) + 30); c.line(880, Y(430), 880, Y(430) + 30)

# --- the patio doors and the windows that look a little like them
for x, y, t, m, *_l in DOORS:
    at(x, y, t, m, door)
for x, y, t in WINDOWS:
    at(x, y, t, False, window)

# --- labels
c.setFillColor(INK)
c.setFont("Helvetica", 14)
for i, (*_p, lx, ly) in enumerate(DOORS, 1):
    c.drawString(lx, Y(ly), f"PD{i}")
c.setFillColor(GREY); c.setFont("Helvetica", 13)
for t, x, y in (("LIVING", 80, 175), ("DINING", 440, 175), ("STUDY", 800, 175), ("LOUNGE", 80, 455), ("GARDEN ROOM", 620, 455)):
    c.drawString(x, Y(y), t)

# --- dimensions, north arrow, scale bar and title block
c.setStrokeColor(GREY); c.setFillColor(GREY); c.setLineWidth(0.7); c.setFont("Helvetica", 10)
c.line(60, Y(118), 1140, Y(118))
for x in (60, 420, 780, 1140):
    c.line(x, Y(112), x, Y(124)); c.line(x - 4, Y(122), x + 4, Y(114))
for x in (320, 680, 1040):
    c.drawCentredString(x, Y(110), "3600")
c.line(30, Y(150), 30, Y(700))
for y in (150, 430, 700):
    c.line(24, Y(y), 36, Y(y))
c.saveState(); c.translate(24, Y(290)); c.rotate(90); c.drawCentredString(0, 0, "2800"); c.restoreState()
c.saveState(); c.translate(24, Y(565)); c.rotate(90); c.drawCentredString(0, 0, "2700"); c.restoreState()
c.circle(1100, Y(60), 16); c.line(1100, Y(76), 1100, Y(44)); c.drawCentredString(1100, Y(36), "N")
c.line(70, Y(742), 170, Y(742)); [c.line(x, Y(738), x, Y(746)) for x in (70, 120, 170)]
c.drawString(70, Y(756), "0"); c.drawString(114, Y(756), "2 m"); c.drawString(160, Y(756), "4 m")
c.setStrokeColor(INK); c.setFillColor(INK); c.setLineWidth(1)
c.rect(800, Y(785), 340, 50)
c.line(800, Y(760), 1140, Y(760))
c.setFont("Helvetica-Bold", 12); c.drawString(810, Y(752), "GROUND FLOOR PLAN")
c.setFont("Helvetica", 10); c.drawString(810, Y(776), "Scale 1:100 at A3. Made up for trying Plandot.")
c.setFont("Helvetica", 22)
c.drawString(60, Y(40), "Sample patio doors (made up)")
c.save()
print("wrote", OUT)
