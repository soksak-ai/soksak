import { framework } from "../framework";
import { titlebarProvisionBreaches } from "../framework/titlebarProvision";
import { key, tmsg } from "../i18n";
import { register } from "./registry";

function capabilityNames(runtime: Record<string, unknown>): string[] {
  const result: string[] = [];
  for (const name of Object.keys(runtime)) {
    if (name === "name") continue;
    const value = runtime[name];
    if (typeof value === "function") result.push(name);
    else if (value && typeof value === "object") {
      for (const member of Object.keys(value as object)) result.push(`${name}.${member}`);
    }
  }
  return result.sort();
}

export function registerRuntimeCatalog(): void {
  register("runtime.capabilities", {
    description: key("cmd.runtime.capabilities.desc"),
    triggers: { ko: "런타임 기능 타이틀바 합성 지원 상태" },
    params: {},
    returns: "{ capabilities[], titlebarComposition, titlebarBreaches[] }",
    message: (data) => tmsg("msg.runtime.capabilities", {
      n: Array.isArray(data.capabilities) ? data.capabilities.length : 0,
    }),
    examples: ["runtime.capabilities"],
    handler: () => ({
      capabilities: capabilityNames(framework as unknown as Record<string, unknown>),
      titlebarComposition: framework.titlebarComposition,
      titlebarBreaches: titlebarProvisionBreaches(),
    }),
  });
}
