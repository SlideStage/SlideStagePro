import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { I18nProvider } from "@slidestage/lite-preset/i18n/I18nProvider";
import { AudienceView } from "@slidestage/lite-preset/viewer/AudienceView";
import { router } from "./App";
import { installProPreset } from "./lib/proPreset";
import "./styles/globals.css";

// Register the Pro preset once at module load. The plugin itself is a no-op
// in v0 (see packages/pro-preset/src/proPreset.ts) — this call exists so
// future Pro capabilities can wire themselves into a shared SlideStage
// instance without changes to the Web shell.
installProPreset();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root not found in index.html");
}

// `I18nProvider` resolves the message keys used inside the Lite viewer/UI
// components ("viewer.action.closeDeck", "toolbar.tool.pointer", ...).
// Without it, those keys leak through as literal strings in the rendered DOM.
const isAudienceWindow = new URLSearchParams(window.location.search).get("audience") === "1";

createRoot(rootEl).render(
  <StrictMode>
    <I18nProvider>
      {isAudienceWindow ? <AudienceView /> : <RouterProvider router={router} />}
    </I18nProvider>
  </StrictMode>,
);
