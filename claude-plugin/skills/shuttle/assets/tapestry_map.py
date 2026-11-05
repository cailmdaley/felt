#!/usr/bin/env python3
"""Draw a tapestry's map: watercolor washes under hand-inked boxes, arrows and labels.

    from tapestry_map import Map            # copy this file beside your fiber
    m = Map(1200, 780, title="A change, from branch to PR")
    m.wash(225, 300, 215, 175, "ochre")
    m.heading(84, 196, "1  Bake", "full")   # state: full, half, empty, or None
    m.box(66, 222, 178, 62, "a worker, on a branch", "commits only")
    m.arrow([(244, 262), (296, 296)])
    m.curve((1095, 198), (640, -70), (155, 220), color="#1b6b5c")
    m.link("#bake", 40, 150, 400, 290)
    html = m.figure()                       # paste first in <body>; style with .map

Standard library only. The output is a self-contained inline SVG on its own paper,
so it reads the same in light and dark.
"""
import math
import random

INK, SOFT, PAPER = "#2a2730", "#5b5560", "#f4eddf"
PIGMENTS = {"ochre": "#c7892a", "indigo": "#2f5a9c", "viridian": "#23806e", "madder": "#ad3f64", "sage": "#6d7f47"}
FILTER = """<filter id="wash{i}" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.0085" numOctaves="5" seed="{a}" result="n"/>
<feDisplacementMap in="SourceGraphic" in2="n" scale="105" xChannelSelector="R" yChannelSelector="G" result="s"/>
<feGaussianBlur in="s" stdDeviation="1.1" result="sharp"/><feGaussianBlur in="s" stdDeviation="20" result="soft"/>
<feComposite in="sharp" in2="soft" operator="arithmetic" k2="1.5" k3="-.92" result="edge"/>
<feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="4" seed="{b}"/>
<feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1.9 -.42" result="bloom"/>
<feComposite in="edge" in2="bloom" operator="arithmetic" k1=".55" k2=".52"/></filter>"""
CSS = ".map{margin:0;max-width:none;height:100vh;min-height:420px;background:%s}.map svg{display:block;width:100%%;height:100%%;font-family:'EB Garamond',Georgia,serif}" % PAPER


class Map:
    def __init__(self, width=1200, height=780, title=None, subtitle=None, seed=5):
        self.width, self.height, self.rng = width, height, random.Random(seed)
        self.washes, self.ink, self.filters = [], [], []
        if title:
            self.text(40, 52, title, 30, italic=True)
        if subtitle:
            self.text(40, 80, subtitle, 18, italic=True, color=SOFT)

    def wash(self, cx, cy, rx, ry, pigment="ochre", opacity=0.8):
        """One watercolor blob. Overlap two or three in a pigment for a looser shape."""
        i = len(self.filters)
        self.filters.append(FILTER.format(i=i, a=11 + i * 13, b=40 + i * 7))
        fill = PIGMENTS.get(pigment, pigment)
        self.washes.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{fill}" opacity="{opacity}" filter="url(#wash{i})" style="mix-blend-mode:multiply"/>')

    def _wobble(self, points, jitter=1.8, step=46):
        path = []
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            count = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
            for i in range(count):
                t = i / count
                path.append((x0 + (x1 - x0) * t + self.rng.uniform(-jitter, jitter), y0 + (y1 - y0) * t + self.rng.uniform(-jitter, jitter)))
        path.append(points[-1])
        d = f"M{path[0][0]:.1f} {path[0][1]:.1f}"
        for a, b in zip(path, path[1:]):
            d += f" Q{a[0]:.1f} {a[1]:.1f} {(a[0] + b[0]) / 2:.1f} {(a[1] + b[1]) / 2:.1f}"
        return d + f" L{path[-1][0]:.1f} {path[-1][1]:.1f}"

    def arrow(self, points, color=INK, width=1.7, dash=None, head=True, jitter=1.8):
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        self.ink.append(f'<path d="{self._wobble(points, jitter)}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round"{extra}/>')
        if head:
            (x0, y0), (x1, y1) = points[-2], points[-1]
            angle = math.atan2(y1 - y0, x1 - x0)
            for side in (2.65, -2.65):
                self.ink.append(f'<path d="M{x1:.1f} {y1:.1f} L{x1 + 13 * math.cos(angle + side):.1f} {y1 + 13 * math.sin(angle + side):.1f}" stroke="{color}" stroke-width="{width}" stroke-linecap="round"/>')

    def curve(self, start, control, end, color=INK, width=2, dash=None):
        points = [((1 - t) ** 2 * start[0] + 2 * (1 - t) * t * control[0] + t * t * end[0], (1 - t) ** 2 * start[1] + 2 * (1 - t) * t * control[1] + t * t * end[1]) for t in (i / 26 for i in range(27))]
        self.arrow(points, color, width, dash, True, 0.7)

    def box(self, x, y, w, h, label=None, note=None, fill="#fbf6ea", opacity=0.75, color=INK, size=18):
        """A sketched box: four strokes that overshoot their corners, with an optional label and note."""
        self.ink.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" opacity="{opacity}"/>')
        o = 4
        for a, b in (((x - o, y), (x + w + o, y)), ((x + w, y - o), (x + w, y + h + o)), ((x + w + o, y + h), (x - o, y + h)), ((x, y + h + o), (x, y - o))):
            self.ink.append(f'<path d="{self._wobble([a, b], 1.1, 70)}" fill="none" stroke="{color}" stroke-width="1.5" stroke-linecap="round"/>')
        if label:
            self.text(x + w / 2, y + (h / 2 + 6 if not note else h / 2 - 3), label, size, anchor="middle", color=color)
        if note:
            self.text(x + w / 2, y + h / 2 + 19, note, size - 2, italic=True, anchor="middle", color=SOFT)

    def text(self, x, y, value, size=19, italic=False, bold=False, mono=False, anchor="start", color=INK):
        style = ";".join(filter(None, ["font-style:italic" if italic else "", "font-weight:600" if bold else "", "font-family:ui-monospace,Menlo,monospace" if mono else ""]))
        self.ink.append(f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" fill="{color}" style="{style}">{value}</text>')

    def state(self, x, y, kind):
        """A state mark: full (works), half (in progress), empty (untried)."""
        r = 8
        self.ink.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{INK if kind == "full" else "none"}" stroke="{INK}" stroke-width="1.6"/>')
        if kind == "half":
            self.ink.append(f'<path d="M{x} {y - r} A{r} {r} 0 0 0 {x} {y + r} Z" fill="{INK}"/>')

    def heading(self, x, y, value, state=None):
        self.text(x, y, value, 27, bold=True)
        if state:
            self.state(x - 22, y - 9, state)

    def link(self, href, x, y, w, h):
        """Make a region of the map jump to its section."""
        self.ink.append(f'<a href="{href}"><rect x="{x}" y="{y}" width="{w}" height="{h}" fill="transparent"/></a>')

    def figure(self, label="The map of this work"):
        return (f'<style>{CSS}</style><figure class="map"><svg viewBox="0 0 {self.width} {self.height}" role="img" aria-label="{label}">'
                f'<defs>{"".join(self.filters)}</defs><rect width="{self.width}" height="{self.height}" fill="{PAPER}"/>'
                f'{"".join(self.washes)}{"".join(self.ink)}</svg></figure>')
