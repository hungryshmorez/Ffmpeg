// Negate every video clip longer than 3 seconds, halve the opacity of the shorter ones, and say what was done.
let long = 0;
for c in clips() {
    if c.kind != "video" { continue; }
    if c.duration > 3.0 {
        add_effect(c.id, "negate");
        long += 1;
    } else {
        set_opacity(c.id, 0.5);
    }
}
add_marker(1, "script ran: " + long + " long");
print("long clips: " + long);
