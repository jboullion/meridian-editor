import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { runCommand } from "./commands.tsx";
import { compiled } from "./compiler.ts";
import { editor } from "./store.ts";
import "./styles.css";

// Development only: a handle for poking at the editor from the console and tests.
if (import.meta.env.DEV) Object.assign(window, { __editor: { editor, compiled, runCommand } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
