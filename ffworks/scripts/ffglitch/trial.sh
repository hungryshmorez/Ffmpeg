#!/usr/bin/env bash
# Reproducible FFglitch trial: I-frame removal, MV amplification, motion transfer.
# Needs: ffmpeg/ffprobe/python3 on PATH and FFGLITCH_DIR pointing at an unpacked
# ffglitch-0.10.x release (ffedit + ffgac). Everything runs on disposable copies in $WORK.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FG="${FFGLITCH_DIR:?set FFGLITCH_DIR to the unpacked FFglitch directory}"
WORK="${WORK:-$(mktemp -d)}"; cd "$WORK"
pass() { echo "PASS  $*"; }; fail() { echo "FAIL  $*"; exit 1; }
mse() { python3 - "$1" "$2" "$3" <<'P'
import subprocess,sys
def fr(f,t): return subprocess.run(["ffmpeg","-v","quiet","-ss",t,"-i",f,"-frames:v","1","-f","rawvideo","-pix_fmt","gray","-"],capture_output=True).stdout
a,b=fr(sys.argv[1],sys.argv[3]),fr(sys.argv[2],sys.argv[3])
assert len(a)==len(b)>0
print(sum((x-y)**2 for x,y in zip(a,b))/len(a))
P
}
gt() { python3 -c "import sys; sys.exit(0 if float('$1')>$2 else 1)"; }

# 1. I-frame removal with STOCK ffmpeg (noise bitstream filter) -------------------------------
ffmpeg -v error -y -f lavfi -i "testsrc2=s=320x240:r=25:d=2" -f lavfi -i "mandelbrot=s=320x240:r=25:end_scale=0.01" \
  -filter_complex "[1:v]trim=duration=2,setpts=PTS-STARTPTS[b];[0:v][b]concat=n=2:v=1[v]" -map "[v]" \
  -c:v mpeg4 -qscale:v 3 -g 50 -bf 0 -sc_threshold 0 cut.avi
ffmpeg -v error -y -i cut.avi -c copy -bsf:v "noise=drop='key*gt(n,0)'" iframe_removed.avi
[ "$(ffprobe -v error -show_entries frame=pict_type -of csv=p=0 iframe_removed.avi | grep -c I)" = 1 ] || fail "I-frame not removed"
gt "$(mse cut.avi iframe_removed.avi 1.9)" -1 && [ "$(mse cut.avi iframe_removed.avi 1.9)" = 0.0 ] && pass "frames before the removed I-frame are unchanged"
gt "$(mse cut.avi iframe_removed.avi 3.0)" 1000 && pass "frames after the removed I-frame are smeared (mse>1000)"

# 2+3. Motion vectors need an encode that allows large vectors: ffgac + -fcode 6 -------------
for n in a b; do
  src=testsrc2; [ $n = b ] && src="mandelbrot=s=320x240:r=25:end_scale=0.01"
  [ $n = a ] && src="testsrc2=s=320x240:r=25"
  ffmpeg -v error -y -f lavfi -i "$src" -t 4 -pix_fmt yuv420p -f rawvideo $n.yuv
  "$FG/ffgac" -v error -y -f rawvideo -pix_fmt yuv420p -s 320x240 -r 25 -i $n.yuv \
    -c:v mpeg4 -mpv_flags +nopimb+forcemv -qscale:v 2 -g 9999 -bf 0 -sc_threshold 0 -fcode 6 $n.avi
done
# 2. amplify A's motion x4
"$FG/ffedit" -i a.avi -f mv -sp '{"factor":4}' -s "$HERE/amp.js" -o a_amp.avi -y 2>amp.log || { tail -3 amp.log; fail "ffedit script failed"; }
grep -q "outside of range" amp.log && fail "MV out of range even with -fcode 6"
[ "$(ffmpeg -v error -i a_amp.avi -f null - 2>&1 | wc -l)" = 0 ] && pass "amplified stream decodes with no errors" || fail "amplified stream has decode errors"
gt "$(mse a.avi a_amp.avi 3.0)" 1000 && pass "amplified motion visibly differs (mse>1000)"
# 3. motion transfer: apply A's vectors to B's picture data
"$FG/ffedit" -i a.avi -f mv -e a_mv.json >/dev/null 2>&1
"$FG/ffedit" -i b.avi -f mv -a a_mv.json -o transfer.avi -y >/dev/null 2>&1
"$FG/ffedit" -i transfer.avi -f mv -e t_mv.json >/dev/null 2>&1
python3 - <<'P' && pass "transferred stream carries exactly A's motion vectors (all 99 P-frames)" || fail "MVs differ from A"
import json
a=json.load(open("a_mv.json"))["streams"][0]["frames"]; t=json.load(open("t_mv.json"))["streams"][0]["frames"]
assert len(a)==len(t) and all(x["mv"].get("forward")==y["mv"].get("forward") for x,y in zip(a,t))
P
gt "$(mse b.avi transfer.avi 2.0)" 1000 && pass "transfer output differs from B (mse>1000)"
echo "outputs in $WORK"
