import type { SlideStagePlugin } from "@slidestage/core/createSlideStage";

/**
 * Configuration for the Pro plugin preset.
 *
 * The preset is a no-op in v0; options are declared here so we can wire them
 * to real Pro capabilities (server-backed annotations, realtime sync, cloud
 * import, ...) without changing the public signature later.
 */
export interface ProPresetOptions {
  /** Reserved for future Pro features (e.g. server-backed annotations). */
  serverEndpoint?: string;
}

/**
 * Pro plugin preset for SlideStage.
 *
 * Mount via `createSlideStage().use(litePreset()).use(proPreset())`. The mere
 * presence of this plugin in the stage's plugin chain signals "Pro is
 * installed"; consumers must NOT branch on an edition flag.
 *
 * v0 install is intentionally empty: Pro capabilities will register through
 * this plugin in later versions (annotations, share links, realtime, ...).
 */
export function proPreset(options: ProPresetOptions = {}): SlideStagePlugin {
  void options;
  return {
    name: "pro",
    install(_stage) {
      // No-op for v0. Pro capabilities will register here in future versions.
      // Example shape:
      //   stage.capabilities.register("pro/server-notes", { /* ... */ });
    },
  };
}
