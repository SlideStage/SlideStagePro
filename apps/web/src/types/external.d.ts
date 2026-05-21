// Ambient module declarations for workspace packages that Agent C / Agent D
// have not yet populated at the moment this app shipped. The shapes mirror the
// expected public API. If a real `.d.ts` exists at runtime it wins.

declare module "@slidestage/pro-preset" {
  import type { SlideStagePlugin } from "@slidestage/core/createSlideStage";
  export interface ProPresetOptions {
    [key: string]: unknown;
  }
  export function proPreset(options?: ProPresetOptions): SlideStagePlugin;
}

declare module "@slidestage/pro-shared" {
  export type ProEditionFlag = "pro";
  export const PRO_EDITION: ProEditionFlag;
}
