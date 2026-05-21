import { createSlideStage, type SlideStage, type SlideStagePlugin } from "@slidestage/core/createSlideStage";
import { proPreset, type ProPresetOptions } from "@slidestage/pro-preset";

// Pro preset installer.
//
// `@slidestage/pro-preset` is a workspace package that exports a SlideStage
// plugin factory. We instantiate a global SlideStage instance and register
// the Pro plugin on it so any install-time side effects (capability
// registration, telemetry hooks, etc.) happen exactly once for the app.
//
// The Pro plugin itself is a no-op in v0 — see
// `packages/pro-preset/src/proPreset.ts`. The wiring is in place so Pro
// capabilities can light up here without touching the Web shell.

let cached: { stage: SlideStage; plugin: SlideStagePlugin } | null = null;

export function installProPreset(options?: ProPresetOptions): SlideStagePlugin {
  if (cached) return cached.plugin;

  const stage = createSlideStage();
  const plugin = proPreset(options);
  stage.use(plugin);
  cached = { stage, plugin };
  return plugin;
}

export function getProStage(): SlideStage | null {
  return cached?.stage ?? null;
}
