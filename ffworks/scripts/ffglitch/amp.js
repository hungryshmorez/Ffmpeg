// Multiply all forward motion vectors by `factor` (setup param, default 4).
let factor = 4;
export function setup(args) {
  // the -sp JSON arrives as args.params
  if (args && args.params && args.params.factor) factor = args.params.factor;
  return { features: ["mv"], mb_type: false };
}
export function glitch_frame(frame) {
  const fwd = frame.mv?.forward;
  if (!fwd) return;
  // NOTE: FFglitch's arrays are indexable but NOT iterable: `for...of` throws.
  for (let r = 0; r < fwd.length; r++) {
    const row = fwd[r];
    for (let c = 0; c < row.length; c++) {
      const mv = row[c];
      if (mv === null) continue; // macroblock without a vector
      mv[0] *= factor;
      mv[1] *= factor;
    }
  }
}
