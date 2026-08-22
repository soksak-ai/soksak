import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

function installBootFailureScreen(): void {
  const html = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
  const body = html.match(/<body>([\s\S]*?)<script type="module"/)?.[1];
  const script = body?.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!body || !script) throw new Error("boot failure surface is missing");
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, "");
  document.documentElement.dataset.bootStatus = "loading";
  Function("window", "document", "navigator", script)(window, document, navigator);
}

describe("boot failure screen", () => {
  it("shows the failure code, phase and message without requiring the CLI", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    installBootFailureScreen();
    const failure = Object.assign(new Error("Plugin manifest is invalid"), {
      code: "MANIFEST_INVALID",
      phase: "plugin-load",
    });
    window.dispatchEvent(new ErrorEvent("error", { error: failure }));

    const screen = document.querySelector<HTMLElement>("[data-boot-screen]");
    expect(screen?.hasAttribute("data-shown")).toBe(true);
    expect(screen?.querySelector("[data-boot-code]")?.textContent).toBe("MANIFEST_INVALID");
    expect(screen?.querySelector("[data-boot-phase]")?.textContent).toBe("plugin-load");
    expect(screen?.querySelector("[data-boot-message]")?.textContent).toBe("Plugin manifest is invalid");
    expect(screen?.querySelector("[data-boot-diagnostics]")?.textContent).toContain("Error: Plugin manifest is invalid");
    expect(screen?.querySelector("[data-boot-command]")?.textContent).toContain("sok state.boot");
  });
});
