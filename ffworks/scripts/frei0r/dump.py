#!/usr/bin/env python3
"""Dump the parameter tables of installed frei0r plugins to JSON (run on a dev machine that has frei0r-plugins installed).
Reads only what each plugin reports through the frei0r C API (names, parameter types, defaults); output goes to
crates/ffworks-core/assets/frei0r/plugins.json. Plugins are loaded one per subprocess so a crashing plugin cannot take the dump down."""
import ctypes, json, os, subprocess, sys

DIR = sys.argv[1] if len(sys.argv) > 1 else "/usr/lib/frei0r-1"
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "crates", "ffworks-core", "assets", "frei0r", "plugins.json")

class Info(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("author", ctypes.c_char_p), ("plugin_type", ctypes.c_int), ("color_model", ctypes.c_int),
                ("frei0r_version", ctypes.c_int), ("major", ctypes.c_int), ("minor", ctypes.c_int), ("num_params", ctypes.c_int), ("explanation", ctypes.c_char_p)]
class PInfo(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("type", ctypes.c_int), ("explanation", ctypes.c_char_p)]

TYPES = {0: "bool", 1: "double", 2: "color", 3: "position", 4: "string"}
KINDS = {0: "filter", 1: "source", 2: "mixer2", 3: "mixer3"}

def one(path):
    lib = ctypes.CDLL(path)
    lib.f0r_init()
    info = Info(); lib.f0r_get_plugin_info(ctypes.byref(info))
    params = []
    inst = None
    if info.plugin_type in (0, 1):
        lib.f0r_construct.restype = ctypes.c_void_p
        lib.f0r_construct.argtypes = [ctypes.c_uint, ctypes.c_uint]
        inst = lib.f0r_construct(64, 64)
    for i in range(info.num_params):
        pi = PInfo(); lib.f0r_get_param_info(ctypes.byref(pi), i)
        p = {"name": pi.name.decode(), "type": TYPES.get(pi.type, "?"), "explanation": (pi.explanation or b"").decode()}
        if inst and pi.type in (0, 1):
            v = ctypes.c_double(0)
            lib.f0r_get_param_value.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
            lib.f0r_get_param_value(inst, ctypes.byref(v), i)
            if v.value == v.value and abs(v.value) < 1e12:
                p["default"] = round(v.value, 6)
        params.append(p)
    return {"id": os.path.splitext(os.path.basename(path))[0], "name": info.name.decode(), "author": (info.author or b"").decode(), "kind": KINDS.get(info.plugin_type, "?"), "explanation": (info.explanation or b"").decode(), "params": params}

if len(sys.argv) > 2 and sys.argv[2] == "--one":
    print(json.dumps(one(sys.argv[1])))
    sys.exit(0)

plugins = []
for f in sorted(os.listdir(DIR)):
    if not f.endswith((".so", ".dll")):
        continue
    r = subprocess.run([sys.executable, __file__, os.path.join(DIR, f), "--one"], capture_output=True, text=True, timeout=30)
    if r.returncode == 0 and r.stdout.strip():
        plugins.append(json.loads(r.stdout))
    else:
        print("skipped", f, file=sys.stderr)
json.dump({"source": "frei0r-plugins (GPL-2+) parameter tables read through the frei0r C API", "plugins": plugins}, open(OUT, "w"), indent=1)
print(len(plugins), "plugins ->", os.path.abspath(OUT))
