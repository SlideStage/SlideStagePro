import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./App";
import { installProPreset } from "./lib/proPreset";
import "./styles/globals.css";

// Pro preset registration: best-effort, never blocks UI boot. The
// `@slidestage/pro-preset` package is owned by Agent C; until they ship,
// `installProPreset` resolves to a no-op SlideStagePlugin.
void installProPreset();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
