/** Mirrors the serde output of ffworks-core. Rationals travel as "n/d" strings (see time.ts). */
export type Rational = string;
export type TrackKind = "video" | "audio";

export interface VideoStream { index: number; codec: string; width: number; height: number; fps: Rational | null; bit_rate: number | null; color: { pix_fmt: string | null; color_space: string | null; color_transfer: string | null; color_primaries: string | null; color_range: string | null; bits_per_raw_sample: number | null } }
export interface AudioStream { index: number; codec: string; sample_rate: number; channels: number; channel_layout: string | null; bit_rate: number | null }
export interface MediaInfo { container: string; duration: Rational; bit_rate: number | null; size_bytes: number | null; video: VideoStream[]; audio: AudioStream[]; tags: [string, string][] }
export interface MediaAsset { id: string; name: string; path: string; info: MediaInfo; fingerprint: string | null }

export interface EffectInstance { id: string; effect: string; enabled: boolean; params: Record<string, number> }
export interface ParamDef { id: string; name: string; min: number; max: number; default: number; step: number; unit: string }
export interface EffectDef { id: string; name: string; category: string; requires: string[]; params: ParamDef[] }
export interface Clip { id: string; media: string; name: string; kind: TrackKind; start: Rational; source_in: Rational; duration: Rational; link: string | null; gain_db: number; opacity: number; effects: EffectInstance[] }
export interface Track { id: string; name: string; kind: TrackKind; muted: boolean; locked: boolean; gain_db: number; clips: Clip[] }
export interface Sequence { id: string; name: string; tracks: Track[] }
export interface ProjectSettings { width: number; height: number; fps: Rational; sample_rate: number }
export interface Project { schema_version: number; name: string; settings: ProjectSettings; media: MediaAsset[]; sequences: Sequence[]; active_sequence: string }

export interface StateView {
  appName: string;
  project: Project;
  dirty: boolean;
  path: string | null;
  undoLabel: string | null;
  redoLabel: string | null;
  history: string[];
  duration: Rational;
  offlineMedia: string[];
  renderHash: string;
}

export interface PreviewInfo { path: string; start: Rational; end: Rational; renderHash: string; cached: boolean; scaleDiv: number }

/** Commands accepted by the backend command bus (serde tag = "type"). */
export type Command =
  | { type: "place_clip"; media: string; track: string; start: Rational; source_in?: Rational | null; duration?: Rational | null; with_audio?: boolean; audio_track?: string | null }
  | { type: "move_clip"; clip: string; start: Rational; track?: string | null }
  | { type: "trim_clip"; clip: string; edge: "start" | "end"; to: Rational }
  | { type: "split_clip"; clip: string; at: Rational }
  | { type: "delete_clip"; clip: string; ripple: boolean }
  | { type: "set_clip_gain"; clip: string; gain_db: number; relative: boolean }
  | { type: "set_track"; track: string; name?: string | null; muted?: boolean | null; locked?: boolean | null; gain_db?: number | null }
  | { type: "add_track"; kind: TrackKind; name?: string | null }
  | { type: "remove_track"; track: string }
  | { type: "add_effect"; clip: string; effect: string; params?: Record<string, number>; index?: number | null }
  | { type: "remove_effect"; clip: string; effect_id: string }
  | { type: "set_effect_param"; clip: string; effect_id: string; param: string; value: number }
  | { type: "set_effect_enabled"; clip: string; effect_id: string; enabled: boolean }
  | { type: "move_effect"; clip: string; effect_id: string; index: number }
  | { type: "set_clip_opacity"; clip: string; opacity: number }
  | { type: "rename_project"; name: string };

export interface Waveform { bins_per_sec: number; peaks: number[] }
export interface ExportPreset { id: string; name: string; extension: string; video_codec: string | null; audio_codec: string | null }

export type JobEvent = { jobId: string; operation: string; output: string } & (
  | { state: "queued" }
  | { state: "rendering"; fraction: number | null; fps: number | null; elapsed_secs: number; eta_secs: number | null }
  | { state: "completed" }
  | { state: "failed"; message: string }
  | { state: "canceled" }
);

export interface RecoveryInfo { saved_unix: number; original_path: string | null; name: string; clips: number }

export interface AppSettings { ffmpeg_path: string | null; ffprobe_path: string | null }
export interface RelinkResult { state: StateView; relinked: string[]; unresolved: { mediaId: string; candidates: { path: string; exact: boolean; reason: string }[] }[] }
