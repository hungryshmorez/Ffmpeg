// Make every video clip's opacity swing slowly between 40% and 100% (a sine wave, one swing every two seconds).
for c in clips() {
    if c.kind != "video" { continue; }
    animate_lfo(c.id, "opacity", "sine", 0.5, 0.4, 1.0);
}
