// Pixel-sort every video clip along whole rows at 60% strength.
for c in clips() {
    if c.kind != "video" { continue; }
    add_effect(c.id, "pixel_sort", #{ mode: 1, mix: 0.6 });
}
