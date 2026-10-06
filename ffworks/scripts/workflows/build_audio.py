#!/usr/bin/env python3
"""Builds crates/ffworks-core/assets/workflows/audio_workflows.tsv from docs/browser_workflows.json.

The browser app turns a workflow's `settings` into an audio filter chain in `buildAudioFilterChain()` (app.js): sections 12 (tone, loudness,
effects), 26 (pitch and time), 27 (channels) and 28 (dynamics), in that order. This script applies the same rules to the workflows that only
touch those sections. Tempo changes (atempo) are not part of the chain: FFWORKS retimes the clip instead (the `speed` column), which also
moves the clip's end like the browser app's shorter/longer output does.
Columns: id, name, category, description, speed ('' = unchanged), chain ('' = none). `@SR@` is the project's sample rate.
"""
import json, math, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, "..", "..")
w = json.load(open(os.path.join(root, "docs", "browser_workflows.json")))

def num(x):
    s = f"{x:.6f}".rstrip("0").rstrip(".")
    return s or "0"

def chain_for(s):
    af, speed = [], None
    if s.get("enable-12"):
        v = s.get("volume", 1)
        if v != 1: af.append(f"volume={num(v)}")
        if s.get("bass", 0): af.append(f"bass=g={num(s['bass'])}")
        if s.get("treble", 0): af.append(f"treble=g={num(s['treble'])}")
        if s.get("highpass", 0) > 0: af.append(f"highpass=f={num(s['highpass'])}")
        if s.get("lowpass", 20000) < 20000: af.append(f"lowpass=f={num(s['lowpass'])}")
        if s.get("loudnorm"): af.append("loudnorm=I=-16:TP=-1.5:LRA=11")
        if s.get("aecho"): af.append(f"aecho=0.8:0.9:{num(s['aecho-delay'])}:{num(s['aecho-decay'])}")
        if s.get("flanger"): af.append("flanger")
        if s.get("tremolo"): af.append(f"tremolo=f={num(s['tremolo-f'])}:d={num(s['tremolo-d'])}")
        if s.get("vibrato"): af.append(f"vibrato=f={num(s['vibrato-f'])}:d={num(s['vibrato-d'])}")
        if s.get("audio-speed", 1) != 1: speed = s["audio-speed"]
    if s.get("enable-26"):
        semis, tempo = s.get("pitch-semitones", 0), s.get("tempo-only", 1)
        if semis:
            r = 2 ** (semis / 12)
            af += [f"asetrate=@SR@*{num(r)}", "aresample=@SR@"]
            c = 1 / r
            while c < 0.5: af.append("atempo=0.5"); c *= 2
            while c > 2.0: af.append("atempo=2"); c /= 2
            af.append(f"atempo={num(c)}")
        if tempo != 1: speed = tempo
    if s.get("enable-27"):
        m = s.get("channel-mode")
        af.append({"mono2stereo": "pan=stereo|c0=c0|c1=c0", "swap": "pan=stereo|c0=c1|c1=c0", "karaoke": "pan=stereo|c0=c0-c1|c1=c1-c0"}.get(m) or (f"apulsator=hz={num(s.get('apulsator-hz', 0.08))}" if m == "8d" else ""))
    if s.get("enable-28"):
        if s.get("gate-enable"): af.append(f"agate=threshold={num(s.get('gate-thresh', -40))}dB")
        if s.get("comp-enable"): af.append(f"acompressor=threshold={num(s['comp-thresh'])}dB:ratio={num(s['comp-ratio'])}:attack={num(s['comp-attack'])}:release={num(s['comp-release'])}")
        if s.get("deess-enable"): af.append(f"equalizer=f={num(s['deess-freq'])}:t=q:w=2:g=-{num(s['deess-reduce'])}")
    return ",".join(a for a in af if a), speed

SKIP = {"extract-mp3", "extract-wav", "extract-aac", "stereo-to-mono", "sample-rate-48k", "sample-rate-441"}  # export/format operations, not filter chains
rows = []
for x in w:
    if "fullChain" in x:
        chain, speed = x["fullChain"].replace("44100", "@SR@"), ""
        m = re.match(r"asetrate=@SR@\*([0-9.]+),aresample=@SR@,?", chain)
        if m:
            # a bare asetrate slows pitch and tempo together: keep the pitch drop in the chain (tempo compensated) and slow the clip itself
            k = float(m.group(1))
            chain, speed = f"asetrate=@SR@*{num(k)},aresample=@SR@,atempo={num(1 / k)}," + chain[m.end():], num(k)
            chain = chain.rstrip(",")
        rows.append((x["id"], x["name"], x["category"], x["description"], speed, chain))
    elif x["category"] in ("audio", "audio-repair-utility") and x["id"] not in SKIP:
        c, sp = chain_for(x.get("settings", {}))
        assert c or sp, x["id"]
        rows.append((x["id"], x["name"], x["category"], x["description"], "" if sp is None else num(sp), c))
out = os.path.join(root, "crates", "ffworks-core", "assets", "workflows", "audio_workflows.tsv")
open(out, "w").write("".join("\t".join(r).replace("\n", " ") + "\n" for r in rows))
print(len(rows), "workflows ->", out, file=sys.stderr)
