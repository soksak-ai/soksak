// ui.* border contract commands — exposes the validator (borderValidate) and expectation lookup
// over CLI/MCP.
// The red→green button: one `sok ui.validate` line is the RED/GREEN verdict.
// (ui.measure is in catalog.ts — R5 numeric checks. This file is §B contract only.)

import { tmsg } from "../i18n";
import { expectForSelector, validateDom } from "../ui/borderValidate";
import { register } from "./registry";

export function registerUiCatalog(): void {
  register("ui.validate", {
    description:
      "Validate the border ownership contract (docs/UI.md §B) against the live DOM. Compares computed border values on all four edges with the contract table and reports violations. Use as the single RED/GREEN gate for border rules.",
    triggers: { ko: "보더검증 테두리확인 ui검증 border contract" },
    params: {
      rule: {
        type: "string",
        description: "Rule id or selector substring filter (omit to check all rules)",
      },
    },
    returns: "{ pass, rulesActive, elementsChecked, violations: [{rule, selector, index, edge, expected, actual}] }",
    message: (d) =>
      d.pass
        ? tmsg("msg.ui.validate.pass", { n: Number(d.elementsChecked) })
        : tmsg("msg.ui.validate.fail", { n: ((d.violations as unknown[]) ?? []).length }),
    examples: ["ui.validate", 'ui.validate \'{"rule":"status"}\''],
    handler: (p) => ({ ...validateDom(p.rule as string | undefined) }),
  });

  register("ui.expect", {
    description:
      "Look up which border rules apply to a given DOM selector according to the contract table. Returns matched rules and their expected edge configuration; no matching rule is also a valid answer (add to the contract table if coverage is needed).",
    triggers: { ko: "보더기대 계약조회 border expect ui계약" },
    params: {
      selector: { type: "string", description: "CSS selector", required: true },
    },
    returns: "{ matchedElements, rules: [{id, active, kind, edges?, seam?, note}] }",
    message: (d) => tmsg("msg.ui.expect", { n: ((d.rules as unknown[]) ?? []).length }),
    examples: ['ui.expect \'{"selector":".pane-status"}\''],
    handler: (p) => ({ ...expectForSelector(p.selector as string) }),
  });
}
