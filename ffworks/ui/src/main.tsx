import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { importPaths } from "./components/MediaBrowser";
import { usePlayhead, useProject, useUi } from "./state/stores";

// Test hook, compiled in only when the UI is built with VITE_UITEST=1.
if (import.meta.env.VITE_UITEST) (window as unknown as Record<string, unknown>).__ffworks = { useProject, usePlayhead, useUi, importPaths };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
