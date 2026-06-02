// Shapes the shared Job Aid renderer consumes. These mirror @platform/db's
// StepBlock / ProcedureStepMedia structurally, so each app can pass its own
// (identically-shaped) types without a runtime dependency on @platform/db.

export type JobAidBlock =
  | { kind: 'paragraph'; text: string }
  | {
      kind: 'callout';
      tone: 'safety' | 'warning' | 'tip' | 'note';
      title?: string;
      text: string;
    }
  | { kind: 'bullet_list'; items: string[] }
  | { kind: 'numbered_list'; items: string[] }
  | { kind: 'key_value'; columns: [string, string]; rows: Array<[string, string]> }
  | { kind: 'photo_inline'; storageKey: string; caption?: string };

/** Minimal media shape the photo_inline block needs to resolve an image. */
export interface JobAidMedia {
  kind: string; // 'image' | 'video' | 'video_clip'
  storageKey: string;
  url?: string | null;
  caption?: string | null;
}
