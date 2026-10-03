// Drop a marker every five seconds along the timeline.
let end = project().duration;
let t = 5.0;
while t < end {
    add_marker(t, "t = " + t + " s");
    t += 5.0;
}
print("timeline is " + end + " s long");
