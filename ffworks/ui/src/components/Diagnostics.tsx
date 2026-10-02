import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useProject, useUi } from "../state/stores";

export function Diagnostics() {
  const open = useUi((s) => s.diagOpen);
  const setOpen = useUi((s) => s.setDiagOpen);
  const view = useProject((s) => s.view)!;
  const [d, setD] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { if (open) void api.diagnostics().then(setD); }, [open]);
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffprobePath, setFfprobePath] = useState("");
  const toast = useProject((st) => st.toast);
  useEffect(() => { if (open) void api.getSettings().then((st) => { setFfmpegPath(st.ffmpeg_path ?? ""); setFfprobePath(st.ffprobe_path ?? ""); }); }, [open]);
  const browse = async (set: (v: string) => void) => { const p = await pickFile({ title: "Select executable" }); if (typeof p === "string") set(p); };
  const apply = async () => {
    try {
      const v = await api.setSettings(ffmpegPath.trim() || null, ffprobePath.trim() || null);
      toast("info", `Using ${v.ffmpeg}`);
      setD(await api.diagnostics());
    } catch (e) { toast("error", String(e)); }
  };
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
        <h3>FFmpeg location</h3>
        <p className="muted">Leave blank to use FFWORKS_FFMPEG / FFWORKS_FFPROBE or PATH. The files are run to check they are real FFmpeg/FFprobe before being saved.</p>
        <div className="field"><label htmlFor="ffm">FFmpeg executable</label><div className="row"><input id="ffm" type="text" value={ffmpegPath} onChange={(e) => setFfmpegPath(e.target.value)} placeholder="ffmpeg" /><button onClick={() => void browse(setFfmpegPath)}>Browse…</button></div></div>
        <div className="field"><label htmlFor="ffp">FFprobe executable</label><div className="row"><input id="ffp" type="text" value={ffprobePath} onChange={(e) => setFfprobePath(e.target.value)} placeholder="ffprobe" /><button onClick={() => void browse(setFfprobePath)}>Browse…</button></div></div>
        <div className="row end"><button onClick={() => void apply()}>Apply</button></div>
        <dl className="metadata">
          <div><dt>Missing project media</dt><dd>{view.offlineMedia.length ? `${view.offlineMedia.length} file(s) offline` : "none"}</dd></div>
        </dl>
        <div className="row end"><button className="primary" onClick={() => setOpen(false)}>Close</button></div>
      </div>
    </div>
  );
}
