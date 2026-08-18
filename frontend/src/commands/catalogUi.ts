// ui.* border contract commands — exposes the validator (borderValidate) and expectation lookup
// over CLI/MCP.
// The red→green button: one `sok ui.validate` line is the RED/GREEN verdict.
// (ui.measure is in catalog.ts — R5 numeric checks. This file is §B contract only.)

import { tmsg, key} from "../i18n";
import { expectForSelector, validateDom } from "../ui/borderValidate";
import { register } from "./registry";

export function registerUiCatalog(): void {
  register("ui.validate", {
    description:
      key("cmd.ui.validate.desc"),
    triggers: { ko: "보더검증 테두리확인 ui검증 border contract" },
    params: {
      rule: {
        type: "string",
        description: key("cmd.ui.validate.param.rule"),
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
      key("cmd.ui.expect.desc"),
    triggers: { ko: "보더기대 계약조회 border expect ui계약" },
    params: {
      selector: { type: "string", description: key("cmd.ui.expect.param.selector"), required: true },
    },
    returns: "{ matchedElements, rules: [{id, active, kind, edges?, seam?, note}] }",
    message: (d) => tmsg("msg.ui.expect", { n: ((d.rules as unknown[]) ?? []).length }),
    examples: ['ui.expect \'{"selector":".pane-status"}\''],
    handler: (p) => ({ ...expectForSelector(p.selector as string) }),
  });
}
