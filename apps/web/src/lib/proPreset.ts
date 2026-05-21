import { createSlideStage, type SlideStage, type SlideStagePlugin } from "@slidestage/core/createSlideStage";

// Pro preset installer.
//
// `@slidestage/pro-preset` is a workspace package owned by Agent C. When the
// package is fully populated, this module wires the preset into a global
// `SlideStage` instance for any install-time side effects (capability
// registration, telemetry hooks, etc.).
//
// While Agent C's source tree is still empty (Phase 1 parallel work), this
// module degrades to a no-op so the web app continues to typecheck, build,
// and run. The dynamic `import()` below intentionally uses a runtime string
// so Vite's static analyzer cannot try to resolve the module at build time;
// the `/* @vite-ignore */` comment makes that explicit. The ambient module
// declaration in `src/types/external.d.ts` keeps TypeScript happy when the
// package IS resolvable.

const noopPlugin: SlideStagePlugin = {
  name: "pro-preset:noop",
};

let cached: { stage: SlideStage; plugin: SlideStagePlugin } | null = null;

export async function installProPreset(): Promise<SlideStagePlugin> {
  if (cached) return cached.plugin;

  const stage = createSlideStage();
  let plugin: SlideStagePlugin = noopPlugin;

  try {
    // Defeat Vite's static analyzer by composing the specifier at runtime.
    const moduleSpecifier = ["@slidestage", "pro-preset"].join("/");
    const mod = await import(/* @vite-ignore */ moduleSpecifier);
    const factory: unknown = (mod as { proPreset?: unknown; default?: unknown }).proPreset
      ?? (mod as { default?: unknown }).default;
    if (typeof factory === "function") {
      const produced = (factory as () => SlideStagePlugin)();
      if (produced && typeof produced === "object" && typeof produced.name === "string") {
        plugin = produced;
      }
    }
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn(
        "[slidestage-pro] @slidestage/pro-preset not available; running with no-op Pro plugin.",
        err,
      );
    }
  }

  stage.use(plugin);
  cached = { stage, plugin };
  return plugin;
}

export function getProStage(): SlideStage | null {
  return cached?.stage ?? null;
}
