import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Command, EffectDef, ExportPreset, JobEvent, PreviewInfo, RecoveryInfo, AppSettings, RelinkResult, StateView, Waveform } from "./types";

/** Every backend call goes through here so the UI never touches the filesystem or processes directly. */
export const api = {
  getState: () => invoke<StateView>("get_state"),
  newProject: (name: string) => invoke<StateView>("new_project", { name }),
  openProject: (path: string) => invoke<StateView>("open_project", { path }),
  saveProject: (path?: string) => invoke<StateView>("save_project", { path: path ?? null }),
  importMedia: (paths: string[]) => invoke<{ state: StateView; errors: string[] }>("import_media", { paths }),
  dispatch: (command: Command) => invoke<StateView>("dispatch", { command }),
  undo: () => invoke<StateView>("undo"),
  redo: () => invoke<StateView>("redo"),
  getWaveform: (mediaId: string) => invoke<Waveform>("get_waveform", { mediaId }),
  getThumbnails: (mediaId: string) => invoke<string[]>("get_thumbnails", { mediaId }),
  findRecovery: () => invoke<RecoveryInfo | null>("find_recovery"),
  recoverProject: () => invoke<StateView>("recover_project"),
  discardRecovery: () => invoke<void>("discard_recovery"),
  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (ffmpegPath: string | null, ffprobePath: string | null) => invoke<{ ffmpeg: string; ffprobe: string }>("set_settings", { ffmpegPath, ffprobePath }),
  relinkSearch: (dir: string) => invoke<RelinkResult>("relink_search", { dir }),
  relinkMedia: (mediaId: string, path: string) => invoke<StateView>("relink_media", { mediaId, path }),
  listEffects: () => invoke<EffectDef[]>("list_effects"),
  renderPreview: (start: string, end: string, scaleDiv: number) => invoke<PreviewInfo>("render_preview", { start, end, scaleDiv }),
  listExportPresets: () => invoke<ExportPreset[]>("list_export_presets"),
  previewCommand: (preset: string, output: string) => invoke<string>("preview_command", { preset, output }),
  startExport: (preset: string, output: string) => invoke<string>("start_export", { preset, output }),
  cancelJob: (jobId: string) => invoke<void>("cancel_job", { jobId }),
  verifyOutput: (path: string) => invoke<string>("verify_output", { path }),
  diagnostics: () => invoke<Record<string, unknown>>("get_diagnostics"),
  onJob: (cb: (e: JobEvent) => void): Promise<UnlistenFn> => listen<JobEvent>("job-state", (ev) => cb(ev.payload)),
};
