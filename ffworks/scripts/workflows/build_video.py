#!/usr/bin/env python3
"""Builds crates/ffworks-core/assets/workflows/video_workflows.tsv from docs/browser_workflows.json.

The browser app turns a workflow's `settings` into a video filter chain in `buildVideoFilterChain()` (app.js). This applies the same rules, in the
same order, to the workflows whose settings only use the sections FFWORKS can express as a plain filter chain: 5 (flips), 7 (eq, hue, negate),
8 (colour channel mixer), 9 (blur, sharpen), 13 (noise), 16 (edges, vignette, posterize). A workflow that touches any other section (scale,
crop, fps, fades, zoom, glitch presets, retro CRT tools...) is left out and stays "not ported".
Columns: id, name, category, description, chain.
"""
import json, os, sys
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
w = json.load(open(os.path.join(root, "docs", "browser_workflows.json")))
SECTIONS = {5, 7, 8, 9, 13, 16}
NEUTRAL = {"vcodec", "acodec"}  # encode choices of the browser app's own pipeline, not part of the look

def n(x):
    s = f"{x:.6f}".rstrip("0").rstrip(".")
    return s or "0"

def chain(s):
    vf = []
    if s.get("enable-5"):
        if s.get("hflip"): vf.append("hflip")
        if s.get("vflip"): vf.append("vflip")
    if s.get("enable-7"):
        g = lambda k, d: s.get(k, d)
        vf.append(f"eq=brightness={n(g('eq-brightness',0))}:contrast={n(g('eq-contrast',1))}:saturation={n(g('eq-saturation',1))}:gamma={n(g('eq-gamma',1))}:gamma_r={n(g('eq-gamma-r',1))}:gamma_g={n(g('eq-gamma-g',1))}:gamma_b={n(g('eq-gamma-b',1))}")
        if g("hue-h", 0) != 0 or g("hue-s", 1) != 1: vf.append(f"hue=h={n(g('hue-h',0))}:s={n(g('hue-s',1))}")
    if s.get("enable-8"):
        d = {"rr": 1, "rg": 0, "rb": 0, "gr": 0, "gg": 1, "gb": 0, "br": 0, "bg": 0, "bb": 1}
        vf.append("colorchannelmixer=" + ":".join(f"{k}={n(s.get('ccm-' + k, d[k]))}" for k in d))
    if s.get("enable-7") and s.get("negate"): vf.append("negate")
    if s.get("enable-13"):
        if s.get("grain-overlay"): vf.append("noise=alls=15:allf=t+u")
        elif s.get("add-noise"):
            st = int(s.get("noise-strength", 10))
            if st > 0: vf.append(f"noise=alls={st}:allf={s.get('noise-type','t+u')}")
    if s.get("enable-9"):
        bs = int(s.get("blur-strength", 0))
        if bs > 0: vf.append(f"boxblur={bs}:{bs}" if s.get("blur-type", "box") == "box" else f"gblur=sigma={bs}")
        if s.get("sharpen-amt", 0) > 0: vf.append(f"unsharp=5:5:{n(s['sharpen-amt'])}:5:5:0")
    if s.get("enable-16"):
        if s.get("edge-detect"):
            mode = s.get("edge-mode", "wires")
            vf.append(f"edgedetect=mode=canny:low={n(s.get('edge-low',0.1))}:high={n(s.get('edge-high',0.3))}" if mode == "canny" else f"edgedetect=mode={mode}")
        if s.get("sobel"): vf.append("sobel")
        if s.get("vignette"): vf.append(f"vignette=angle={n(s.get('vignette-angle',0.628))}")
        bits = int(s.get("posterize", 8))
        if 1 <= bits < 8:
            mask = (0xFF << (8 - bits)) & 0xFF
            vf.append(f"lutyuv=y=bitand(val,0x{mask:02X}):u=val:v=val")
    return ",".join(vf)

rows = []
for x in w:
    s = x.get("settings")
    if not s or "fullChain" in x: continue
    enabled = {int(k.split("-")[1]) for k in s if k.startswith("enable-") and s[k] and k.split("-")[1].isdigit()}
    enabled -= {1}  # section 1 = container/codec choice
    if not enabled or not enabled <= SECTIONS: continue
    if x["category"] not in ("color-grading", "retro-analog", "artistic-stylize", "glitch"): continue
    if s.get("emboss") or s.get("sobel") and False: continue
    c = chain(s)
    if not c: continue
    rows.append((x["id"], x["name"], x["category"], x["description"], c))
out = os.path.join(root, "crates", "ffworks-core", "assets", "workflows", "video_workflows.tsv")
open(out, "w").write("".join("\t".join(r).replace("\n", " ") + "\n" for r in rows))
print(len(rows), "video workflows ->", out, file=sys.stderr)
for r in rows: print(r[0], "|", r[4][:130], file=sys.stderr)
