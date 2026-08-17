// clipboard.* commands — expose the core clipboard capability through the command registry (single truth).
// clipboard.read: read system clipboard text (delegates to core clipboard_read).
// clipboard.write: write system clipboard text (delegates to core clipboard_write; self-write echo suppression is the core's job).
// Change watching (clipboard-change emit) is a plugin subscription via app.clipboard.onChange — a stream, not a command surface.

import { invoke } from "../framework";
import { tmsg, key} from "../i18n";
import { register } from "./registry";

export function registerClipboardCatalog(): void {
  register("clipboard.read", {
    description: key("cmd.clipboard.read.desc"),
    triggers: { ko: "클립보드 읽기 복사내용 붙여넣기확인" },
    params: {},
    // The answer is home-wide, not per-window — same in every window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ text }",
    message: (d) => tmsg("msg.clipboard.read", { n: String(d.text ?? "").length }),
    errors: ["INTERNAL"],
    examples: ["clipboard.read"],
    handler: async () => {
      const text = await invoke<string>("clipboard_read");
      return { text };
    },
  });

  register("clipboard.write", {
    description: key("cmd.clipboard.write.desc"),
    triggers: { ko: "클립보드 쓰기 복사 클립보드저장" },
    params: {
      text: { type: "string", description: key("cmd.clipboard.write.param.text"), required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.clipboard.write"),
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['clipboard.write \'{"text":"text to copy"}\''],
    handler: async (p) => {
      if (typeof p.text !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.clipboard.write.textRequired") };
      }
      await invoke("clipboard_write", { text: p.text });
      return { ok: true };
    },
  });
}
