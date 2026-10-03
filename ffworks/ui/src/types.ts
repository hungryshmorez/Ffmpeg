/** Mirrors the serde output of ffworks-core. Rationals travel as "n/d" strings (see time.ts). */
export type Rational = string;
export type TrackKind = "video" | "audio";

export interface VideoStream { index: number; codec: string; width: number; height: number; fps: Rational | null; bit_rate: number | null; color: { pix_fmt: string | null; color_space: string | null; color_transfer: string | null; color_primaries: string | null; color_range: string | null; bits_per_raw_sample: number | null } }
export interface AudioStream { index: number; codec: string; sample_rate: number; channels: number; channel_layout: string | null; bit_rate: number | null }
export interface MediaInfo { container: string; duration: Rational; bit_rate: number | null; size_bytes: number | null; video: VideoStream[]; audio: AudioStream[]; tags: [string, string][]; /** A single picture or generated media: lasts as long as it is placed for. */ still: boolean }
export type Generator = { kind: "solid"; color: string } | { kind: "nested"; sequence: string };
export interface MediaAsset { id: string; name: string; path: string; info: MediaInfo; fingerprint: string | null; /** Generated media (solid colour, title canvas) has no file. */ generator: Generator | null }
export type Align = "left" | "center" | "right";
export interface Title { text: string; font: string; size: number; color: string; align: Align; outline_width: number; outline_color: string; shadow: number; box_color: string | null; box_pad: number }
export interface FontEntry { name: string; path: string; bundled: boolean }

export interface GNode { id: string; filter: string; options: [string, string][]; x: number; y: number }
export interface GEdge { from: string; from_pad: number; to: string; to_pad: number }
export interface FilterGraph { nodes: GNode[]; edges: GEdge[] }
export interface EffectInstance { id: string; effect: string; enabled: boolean; params: Record<string, number>; graph?: FilterGraph }
export interface ParamDef { id: string; name: string; min: number; max: number; default: number; step: number; unit: string; animatable: boolean }
export interface EffectDef { id: string; name: string; kind: "video" | "audio"; category: string; requires: string[]; params: ParamDef[]; alpha: boolean }
export type Interp = "linear" | "hold" | "ease_in" | "ease_out" | "ease_in_out";
/** One key; `interp` is the curve from this key to the next. `t` is clip-relative seconds. */
export interface Keyframe { t: Rational; v: number; interp: Interp }
export interface Transform { x: number; y: number; scale: number; rotation: number }
export interface ClipParamDef { id: string; name: string; min: number; max: number; default: number; step: number; unit: string; animatable: boolean }
export interface ClipProps { params: ClipParamDef[]; audioParams: ClipParamDef[]; blendModes: [string, string][]; interps: { id: Interp; name: string }[] }
export interface Clip {
  id: string; media: string; name: string; kind: TrackKind; start: Rational; source_in: Rational; duration: Rational; link: string | null; gain_db: number; opacity: number; effects: EffectInstance[];
  speed: Rational; reverse: boolean; freeze: Rational | null; transform: Transform; blend: string;
  /** Audio clips: balance -1..1 and linear fades in seconds (rational). */
  pan: number; fade_in: Rational; fade_out: Rational;
  /** Set on title clips (their media is the transparent title canvas). */
  title: Title | null;
  /** Adjustment layer: its effects apply to everything on lower tracks while it lasts (absent when false). */
  adjustment?: boolean;
  /** Keyed by parameter id: `opacity`, `x`, `y`, `scale`, `rotation` or `fx:<effect id>:<param>`. */
  keyframes: Record<string, Keyframe[]>;
}
export interface Transition { id: string; clip_a: string; clip_b: string; kind: string; duration: Rational }
export interface Track { id: string; name: string; kind: TrackKind; muted: boolean; locked: boolean; gain_db: number; pan: number; solo: boolean; clips: Clip[]; transitions: Transition[] }
export interface Marker { id: string; time: Rational; name: string; color: string; note: string }
export interface Sequence { id: string; name: string; tracks: Track[]; markers: Marker[]; /** The contents of a compound clip (absent when false). */ compound?: boolean }
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
  | { type: "set_track"; track: string; name?: string | null; muted?: boolean | null; locked?: boolean | null; gain_db?: number | null; pan?: number | null; solo?: boolean | null }
  | { type: "add_marker"; time: Rational; name: string; color?: string | null; note?: string | null }
  | { type: "set_marker"; marker: string; time?: Rational | null; name?: string | null; color?: string | null; note?: string | null }
  | { type: "remove_marker"; marker: string }
  | { type: "add_title"; track: string; start: Rational; duration: Rational; text: string }
  | { type: "set_title"; clip: string; title: Title }
  | { type: "add_adjustment"; track: string; start: Rational; duration: Rational }
  | { type: "add_solid"; track: string; start: Rational; duration: Rational; color: string }
  | { type: "set_solid_color"; clip: string; color: string }
  | { type: "set_clip_fades"; clip: string; fade_in?: Rational | null; fade_out?: Rational | null }
  | { type: "add_track"; kind: TrackKind; name?: string | null }
  | { type: "remove_track"; track: string }
  | { type: "take_snapshot"; name: string }
  | { type: "restore_snapshot"; snapshot: string }
  | { type: "delete_snapshot"; snapshot: string }
  | { type: "add_filter_effect"; clip: string; filter: string; options?: [string, string][] }
  | { type: "add_effect"; clip: string; effect: string; params?: Record<string, number>; index?: number | null }
  | { type: "remove_effect"; clip: string; effect_id: string }
  | { type: "set_effect_param"; clip: string; effect_id: string; param: string; value: number }
  | { type: "set_effect_enabled"; clip: string; effect_id: string; enabled: boolean }
  | { type: "set_effect_graph"; clip: string; effect_id: string; graph: FilterGraph }
  | { type: "move_effect"; clip: string; effect_id: string; index: number }
  | { type: "set_clip_opacity"; clip: string; opacity: number }
  | { type: "set_clip_param"; clip: string; param: string; value: number }
  | { type: "set_clip_blend"; clip: string; blend: string }
  | { type: "set_keyframe"; clip: string; param: string; time: Rational; value: number; interp?: Interp | null }
  | { type: "remove_keyframe"; clip: string; param: string; time: Rational }
  | { type: "clear_keyframes"; clip: string; param: string }
  | { type: "set_keyframes"; clip: string; param: string; keys: { t: Rational; v: number; interp?: Interp }[] }
  | { type: "animate_from_lfo"; clip: string; param: string; shape: string; rate: number; low: number; high: number; phase?: number; seed?: number }
  | { type: "animate_from_beats"; clip: string; param: string; source?: string | null; low: number; high: number; decay: number }
  | { type: "animate_from_midi"; clip: string; param: string; path: string; source: string; channel?: number | null; track?: number | null; low: number; high: number; decay?: number; offset?: number }
  | { type: "animate_from_audio"; clip: string; param: string; source?: string | null; low: number; high: number; smooth: number; band?: string | null }
  | { type: "set_clip_speed"; clip: string; speed: Rational }
  | { type: "set_clip_reverse"; clip: string; reverse: boolean }
  | { type: "set_clip_freeze"; clip: string; at: Rational | null }
  | { type: "add_transition"; clip_a: string; clip_b: string; kind: string; duration: Rational }
  | { type: "remove_transition"; transition: string }
  | { type: "set_transition"; transition: string; kind?: string | null; duration?: Rational | null }
  | { type: "remove_ranges"; clip: string; ranges: [Rational, Rational][] }
  | { type: "animate_from_expression"; clip: string; param: string; expr: string; source: string | null; clamp: boolean }
  | { type: "nest_clips"; clips: string[]; name?: string | null }
  | { type: "unnest_clip"; clip: string }
  | { type: "fit_compound"; media: string }
  | { type: "batch"; label: string; commands: Command[] }
  | { type: "rename_project"; name: string };

export interface Waveform { bins_per_sec: number; peaks: number[] }
export interface ExportPreset { id: string; name: string; extension: string; video_codec: string | null; audio_codec: string | null }

export interface JobLog { job_id: string; executable: string; args: string[]; started_unix: number; ended_unix: number | null; exit_code: number | null; stderr: string; operation: string }

export type JobEvent = { jobId: string; operation: string; output: string; priority: number; enqueuedUnix: number } & (
  | { state: "queued" }
  | { state: "rendering"; fraction: number | null; fps: number | null; elapsed_secs: number; eta_secs: number | null }
  | { state: "completed" }
  | { state: "failed"; message: string }
  | { state: "canceled" }
);

export interface RecoveryInfo { saved_unix: number; original_path: string | null; name: string; clips: number }

export interface AppSettings { ffmpeg_path: string | null; ffprobe_path: string | null }
export interface RelinkResult { state: StateView; relinked: string[]; unresolved: { mediaId: string; candidates: { path: string; exact: boolean; reason: string }[] }[] }
export interface BeatAnalysis { beats: number[]; bpm: number; duration: number }
export interface SceneAnalysis { cuts: number[]; scenes: [number, number][]; threshold: number }
export interface EffectPreset { kind: "video" | "audio"; effects: { effect: string; params: Record<string, number> }[] }
export type DetectKind = "silence" | "black" | "freeze";
export interface Loudness { integrated_lufs: number | null; range_lu: number; true_peak_dbtp: number | null }

export interface ProxyStatus { mediaId: string; eligible: boolean; ready: boolean; path: string | null; bytes: number | null }

export interface FilterInfo { name: string; io: string; description: string; timeline: boolean }
export interface FilterOption { name: string; kind: string; description: string; default: string | null; min: string | null; max: string | null; choices: [string, string][]; dynamic: boolean }
export interface FilterHelp { name: string; description: string; inputs: string[]; outputs: string[]; options: FilterOption[]; timeline: boolean }

export interface FavGroup { effects: string[]; transitions: string[] }
export interface Favourites { starred: FavGroup; groups: Record<string, FavGroup> }
export interface RandomResult { state: StateView; seed: number; applied?: number; skipped?: string[] }

export interface EngineInfo { id: string; name: string; ffmpeg_path: string; ffprobe_path: string; ok: boolean; error: string | null; version: string; license: string; filters: number; encoders: number; xfade_custom: boolean; hwaccels: string[]; notable: string[] }
export interface FoundEngine { ffmpeg_path: string; ffprobe_path: string; suggested_name: string }

export interface DemoStep { index: number; start: number; transition: string | null; effects: string[]; fx: { effect: string; params: Record<string, number> }[] }
export interface DemoBatch { path: string; steps: DemoStep[]; seed: number; duration: number }

/** Whether FFglitch (the mosh lab's tool) is installed, and where it was found. */
export interface GlitchStatus {
  found: boolean;
  ffedit: string | null;
  dir: string | null;
  bundled: boolean;
}

/** The local HTTP API (off by default): where to reach it and the secret callers must send. */
export interface LocalApi { enabled: boolean; url: string | null; token: string | null; port: number }

/** What the frame-lab dialog sends: a mode id plus the fields that mode uses. */
export interface FrameArgs {
  kind: string;
  count?: number;
  at?: number;
  every?: number;
  spread?: number;
  seed?: number;
  descending?: boolean;
  donor?: string;
  spliceAt?: number;
  keyframeEvery: number;
  dropKeyframes: boolean;
  keepFirst: boolean;
  kill?: number;
}
