import { useEffect, useState } from "react";
import { api } from "../api";
import { useProject, useUi } from "../state/stores";

export function Diagnostics() {
  const open = useUi((s) => s.diagOpen);
  const setOpen = useUi((s) => s.setDiagOpen);
  const view = useProject((s) => s.view)!;
  const [d, setD] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { if (open) void api.diagnostics().then(setD); }, [open]);
  if (!open) return null;
  const ok = d && !("error" in d);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Diagnostics">
      <div className="modal">
        <h2>Diagnostics</h2>
        {!d && <p>Checking…</p>}
        {d && "error" in d && <p className="err">{String(d.error)}</p>}
        {ok && (
          <dl className="metadata">
            <div><dt>FFmpeg</dt><dd>{String(d.ffmpeg)}</dd></div>
            <div><dt>ffmpeg path</dt><dd>{String(d.ffmpegPath)}</dd></div>
            <div><dt>ffprobe path</dt><dd>{String(d.ffprobePath)}</dd></div>
            <div><dt>Filters / encoders</dt><dd>{String(d.filters)} / {String(d.encoders)}</dd></div>
            <div><dt>libx264 (H.264 export)</dt><dd>{d.x264 ? "available" : "MISSING — H.264 export will be refused"}</dd></div>
            <div><dt>libvpx-vp9 (WebM export)</dt><dd>{d.vp9 ? "available" : "missing"}</dd></div>
            <div><dt>Hardware acceleration</dt><dd>{(d.hwaccels as string[]).join(", ") || "none reported (GPU encoding is not used in this build)"}</dd></div>
          </dl>
        )}
        <dl className="metadata">
          <div><dt>Missing project media</dt><dd>{view.offlineMedia.length ? `${view.offlineMedia.length} file(s) offline` : "none"}</dd></div>
        </dl>
        <div className="row end"><button className="primary" onClick={() => setOpen(false)}>Close</button></div>
      </div>
    </div>
  );
}
