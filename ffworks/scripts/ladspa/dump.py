#!/usr/bin/env python3
"""Dump the control tables of installed LADSPA plugins (audio effects: swh, TAP, CMT, CAPS...) to JSON through the LADSPA
C API (names, ports, range hints only). Output: crates/ffworks-core/assets/ladspa/plugins.json. One library per subprocess so a
crashing plugin cannot take the dump down. Only effects with 1 or 2 audio inputs and the same number of outputs are kept."""
import ctypes, json, math, os, subprocess, sys

DIR = sys.argv[1] if len(sys.argv) > 1 else "/usr/lib/ladspa"
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "crates", "ffworks-core", "assets", "ladspa", "plugins.json")

PORT_INPUT, PORT_OUTPUT, PORT_CONTROL, PORT_AUDIO = 1, 2, 4, 8
H_BELOW, H_ABOVE, H_TOGGLED, H_SR, H_LOG, H_INT = 1, 2, 4, 8, 16, 32
H_DEF_MASK = 0x3C0
DEFAULTS = {0x40: "min", 0x80: "low", 0xC0: "mid", 0x100: "high", 0x140: "max", 0x200: 0.0, 0x240: 1.0, 0x280: 100.0, 0x2C0: 440.0}

class Hint(ctypes.Structure):
    _fields_ = [("hint", ctypes.c_int), ("lower", ctypes.c_float), ("upper", ctypes.c_float)]

class Desc(ctypes.Structure):
    _fields_ = [("unique_id", ctypes.c_ulong), ("label", ctypes.c_char_p), ("properties", ctypes.c_int), ("name", ctypes.c_char_p),
                ("maker", ctypes.c_char_p), ("copyright", ctypes.c_char_p), ("port_count", ctypes.c_ulong),
                ("port_descriptors", ctypes.POINTER(ctypes.c_int)), ("port_names", ctypes.POINTER(ctypes.c_char_p)),
                ("port_hints", ctypes.POINTER(Hint))]

SR = 48000.0

def control(name, h):
    lo, hi, flags = float(h.lower), float(h.upper), h.hint
    if flags & H_TOGGLED:
        lo, hi = 0.0, 1.0
    if flags & H_SR:
        lo, hi = lo * SR, hi * SR
    if not flags & H_BELOW:
        lo = None
    if not flags & H_ABOVE:
        hi = None
    d = DEFAULTS.get(flags & H_DEF_MASK)
    if isinstance(d, str):
        if lo is None or hi is None:
            d = None
        elif d == "min":
            d = lo
        elif d == "max":
            d = hi
        else:
            w = {"low": 0.25, "mid": 0.5, "high": 0.75}[d]
            if flags & H_LOG and lo > 0 and hi > 0:
                d = math.exp(math.log(lo) * (1 - w) + math.log(hi) * w)
            else:
                d = lo * (1 - w) + hi * w
    if d is None:
        d = lo if lo is not None else (0.0 if hi is None or hi >= 0 else hi)
    return {"name": name, "min": lo, "max": hi, "default": round(d, 6), "toggled": bool(flags & H_TOGGLED), "integer": bool(flags & H_INT), "log": bool(flags & H_LOG), "sample_rate": bool(flags & H_SR)}

def one(path):
    lib = ctypes.CDLL(path)
    fn = lib.ladspa_descriptor
    fn.restype = ctypes.POINTER(Desc)
    fn.argtypes = [ctypes.c_ulong]
    out = []
    i = 0
    while True:
        p = fn(i)
        if not p:
            break
        d = p.contents
        ains = aouts = 0
        ctrls = []
        for k in range(d.port_count):
            pd = d.port_descriptors[k]
            nm = (d.port_names[k] or b"").decode("utf-8", "replace")
            if pd & PORT_AUDIO:
                ains += bool(pd & PORT_INPUT)
                aouts += bool(pd & PORT_OUTPUT)
            elif pd & PORT_CONTROL and pd & PORT_INPUT:
                ctrls.append(control(nm, d.port_hints[k]))
        if ains in (1, 2) and ains == aouts:
            out.append({"label": d.label.decode("utf-8", "replace"), "name": (d.name or b"").decode("utf-8", "replace"), "maker": (d.maker or b"").decode("utf-8", "replace"), "channels": ains, "controls": ctrls})
        i += 1
    return {"file": os.path.splitext(os.path.basename(path))[0], "plugins": out}

if len(sys.argv) > 2 and sys.argv[2] == "--one":
    print(json.dumps(one(sys.argv[1])))
    sys.exit(0)

libs = []
for f in sorted(os.listdir(DIR)):
    if not f.endswith((".so", ".dll")):
        continue
    r = subprocess.run([sys.executable, __file__, os.path.join(DIR, f), "--one"], capture_output=True, text=True, timeout=30)
    if r.returncode == 0 and r.stdout.strip():
        lib = json.loads(r.stdout)
        if lib["plugins"]:
            libs.append(lib)
    else:
        print("skipped", f, file=sys.stderr)
json.dump({"source": "LADSPA plugin control tables read through the LADSPA C API (swh-plugins GPL-2+, TAP GPL-2+, CMT LGPL-2.1+)", "libraries": libs}, open(OUT, "w"), indent=1)
print(sum(len(l["plugins"]) for l in libs), "effects in", len(libs), "libraries ->", os.path.abspath(OUT))
