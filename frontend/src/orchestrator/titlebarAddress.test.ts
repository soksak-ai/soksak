import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_CSS = readFileSync(join(SRC, "App.css"), "utf8");

function openingTag(file: string, className: string): string {
  const source = readFileSync(join(SRC, file), "utf8");
  return source.match(
    new RegExp(`<(?:div|header)\\s+className="${className}"[^>]*>`),
  )?.[0] ?? "";
}

describe("shared titlebar public address", () => {
  it.each([
    ["App.tsx", "titlebar"],
    ["orchestrator/OrchestratorApp.tsx", "orch-header"],
  ])("%s exposes its real window header at the ui.tree titlebar address", (file, className) => {
    const tag = openingTag(file, className);
    expect(tag).toContain('data-node="titlebar"');
    expect(tag).not.toMatch(/data-tauri-/);
  });

  it("both windows compute the same 45px border-box for the public titlebar", () => {
    const style = document.createElement("style");
    style.textContent = APP_CSS;
    document.head.append(style);

    const workspace = document.createElement("div");
    workspace.className = "titlebar";
    const orchestrator = document.createElement("header");
    orchestrator.className = "orch-header";
    document.body.append(workspace, orchestrator);

    for (const header of [workspace, orchestrator]) {
      const computed = getComputedStyle(header);
      expect(computed.boxSizing).toBe("border-box");
      expect(computed.height).toBe("45px");
    }

    workspace.remove();
    orchestrator.remove();
    style.remove();
  });
});
