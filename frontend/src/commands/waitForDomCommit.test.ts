// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { waitForDomCommit } from "./waitForDomCommit";

describe("waitForDomCommit", () => {
  it("an already committed condition resolves immediately", async () => {
    await expect(waitForDomCommit(() => true)).resolves.toBeUndefined();
  });

  it("a DOM mutation event re-reads the condition and disconnects the observer", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    const done = waitForDomCommit(() => node.dataset.open === "1", node);
    node.dataset.open = "1";
    await expect(done).resolves.toBeUndefined();
  });

  it("with no event it rejects at a finite bound", async () => {
    vi.useFakeTimers();
    const done = waitForDomCommit(() => false, document.documentElement, 25);
    const verdict = expect(done).rejects.toThrow(/25ms/);
    await vi.advanceTimersByTimeAsync(25);
    await verdict;
    vi.useRealTimers();
  });
});
