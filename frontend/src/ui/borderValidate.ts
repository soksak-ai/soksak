// Border contract runtime validator — applies the contract table (borderContract) to the live DOM.
// The pure evaluation core (evaluateRules — env injected) is separate from the DOM binding (domEnv):
// the core is verified exhaustively with vitest fixtures (planting a violation must turn RED, or it
// is not a validator), and the DOM binding is consumed by the ui.validate/ui.expect commands.

import {
  BORDER_RULES,
  EDGE_NAMES,
  type BorderRule,
  type EdgeExpect,
  type EdgeName,
  type RuleWhen,
} from "./borderContract";

export interface EdgeProbe {
  width: string; // computed border{Edge}Width — "0px"/"1px"…
  style: string; // computed border{Edge}Style — "none"/"solid"…
  color: string; // computed border{Edge}Color — normalized rgb()/rgba()
}

export interface ElementProbe {
  edges: Record<EdgeName, EdgeProbe>;
  backgroundColor: string;
  backgroundImage: string; // input for the seam center-line check
  visible: boolean;
}

export interface ValidateEnv {
  queryAll(selector: string): ElementProbe[];
  // Root data-* (theme chrome tokens). undefined when unset.
  dataset(name: keyof RuleWhen): string | undefined;
  // Normalized token color (rgb()/rgba()) — in the DOM it is resolved with a probe element.
  resolveToken(token: "bd" | "bd-soft"): string;
}

export interface Violation {
  rule: string; // rule id
  selector: string;
  index: number; // position of the element among the matches
  edge: EdgeName | "seam";
  expected: string;
  actual: string;
}

export interface ValidateResult {
  pass: boolean;
  rulesActive: number; // number of rules whose when condition passed
  elementsChecked: number;
  violations: Violation[];
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

function whenActive(when: RuleWhen | undefined, env: ValidateEnv): boolean {
  if (!when) return true;
  for (const key of Object.keys(when) as (keyof RuleWhen)[]) {
    const allowed = when[key];
    if (allowed && !allowed.includes(env.dataset(key) ?? "")) return false;
  }
  return true;
}

// "no line" verdict: width 0 or style none (color irrelevant — a transparent 1px is a violation
// too: an invisible line that occupies layout corrupts the R3 model).
function isNoLine(e: EdgeProbe): boolean {
  return e.width === "0px" || e.style === "none";
}

function checkEdge(
  e: EdgeProbe,
  expect: EdgeExpect,
  env: ValidateEnv,
): string | null {
  if (expect === "none") {
    return isNoLine(e) ? null : `line present(${e.width} ${e.style} ${e.color})`;
  }
  const want = env.resolveToken(expect);
  if (e.width !== "1px") return `width ${e.width}(expected 1px ${expect})`;
  if (e.style !== "solid") return `style ${e.style}(expected solid)`;
  if (norm(e.color) !== norm(want)) {
    return `color ${e.color}(expected ${expect}=${want})`;
  }
  return null;
}

function checkSeam(
  el: ElementProbe,
  seam: NonNullable<BorderRule["seam"]>,
  env: ValidateEnv,
): string | null {
  if (seam === "rest-transparent") {
    const bgClear =
      norm(el.backgroundColor) === "rgba(0,0,0,0)" ||
      norm(el.backgroundColor) === "transparent";
    const noImage = el.backgroundImage === "none";
    return bgClear && noImage
      ? null
      : `resting state not transparent(bg=${el.backgroundColor}, image=${el.backgroundImage})`;
  }
  // "bd-soft": 1px center line — the token color is present in the background gradient.
  const want = norm(env.resolveToken("bd-soft"));
  return norm(el.backgroundImage).includes(want)
    ? null
    : `center line absent(image=${el.backgroundImage}, expected color ${want})`;
}

export function evaluateRules(
  rules: readonly BorderRule[],
  env: ValidateEnv,
): ValidateResult {
  const violations: Violation[] = [];
  let rulesActive = 0;
  let elementsChecked = 0;

  for (const rule of rules) {
    if (!whenActive(rule.when, env)) continue;
    rulesActive++;
    const els = env.queryAll(rule.selector);
    els.forEach((el, index) => {
      if (!el.visible) return; // hidden elements are out of scope (keep-alive stacks and such)
      elementsChecked++;
      if (rule.kind === "seam" && rule.seam) {
        const err = checkSeam(el, rule.seam, env);
        if (err) {
          violations.push({
            rule: rule.id,
            selector: rule.selector,
            index,
            edge: "seam",
            expected: rule.seam,
            actual: err,
          });
        }
        return;
      }
      for (const edge of EDGE_NAMES) {
        const expect = rule.edges?.[edge];
        if (!expect) continue;
        const err = checkEdge(el.edges[edge], expect, env);
        if (err) {
          violations.push({
            rule: rule.id,
            selector: rule.selector,
            index,
            edge,
            expected: expect,
            actual: err,
          });
        }
      }
    });
  }
  return {
    pass: violations.length === 0,
    rulesActive,
    elementsChecked,
    violations,
  };
}

// ── DOM binding ──────────────────────────────────────────────────────────────

const DATASET_ATTR: Record<keyof RuleWhen, string> = {
  paneStyle: "paneStyle",
  gutter: "gutter",
};

function probeElement(el: Element): ElementProbe {
  const cs = getComputedStyle(el);
  const edge = (name: string): EdgeProbe => ({
    width: cs.getPropertyValue(`border-${name}-width`),
    style: cs.getPropertyValue(`border-${name}-style`),
    color: cs.getPropertyValue(`border-${name}-color`),
  });
  return {
    edges: {
      top: edge("top"),
      right: edge("right"),
      bottom: edge("bottom"),
      left: edge("left"),
    },
    backgroundColor: cs.backgroundColor,
    backgroundImage: cs.backgroundImage,
    // A zero-area element such as a closed sidebar (width 0) is not subject to the contract —
    // with no pixels to paint it is not "visible".
    visible: (() => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })(),
  };
}

export function domEnv(): ValidateEnv {
  const tokenCache = new Map<string, string>();
  return {
    queryAll: (selector) =>
      [...document.querySelectorAll(selector)].map(probeElement),
    dataset: (name) =>
      (document.documentElement.dataset as Record<string, string | undefined>)[
        DATASET_ATTR[name]
      ],
    // The raw var() text can be an unresolved string such as color-mix — a normalized rgb() is
    // obtained from the probe element's computed value.
    resolveToken: (token) => {
      const hit = tokenCache.get(token);
      if (hit) return hit;
      const probe = document.createElement("div");
      probe.style.borderTopStyle = "solid";
      probe.style.borderTopColor = `var(--${token})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).borderTopColor;
      probe.remove();
      tokenCache.set(token, color);
      return color;
    },
  };
}

// ui.validate entry point: ruleFilter is a substring filter over rule id and selector.
export function validateDom(ruleFilter?: string): ValidateResult {
  const rules = ruleFilter
    ? BORDER_RULES.filter(
        (r) => r.id.includes(ruleFilter) || r.selector.includes(ruleFilter),
      )
    : BORDER_RULES;
  return evaluateRules(rules, domEnv());
}

// ui.expect entry point: reports which edge must look how for the DOM a selector points at.
// A selector absent from the contract yields rules: [] — "no rule" is an answer too (add one to the
// contract if it is needed).
export function expectForSelector(selector: string): {
  matchedElements: number;
  rules: {
    id: string;
    active: boolean;
    kind: BorderRule["kind"];
    edges?: BorderRule["edges"];
    seam?: BorderRule["seam"];
    note: string;
  }[];
} {
  const env = domEnv();
  const targets = new Set(document.querySelectorAll(selector));
  const rules = BORDER_RULES.filter((r) =>
    [...document.querySelectorAll(r.selector)].some((el) => targets.has(el)),
  ).map((r) => ({
    id: r.id,
    active: whenActive(r.when, env),
    kind: r.kind,
    edges: r.edges,
    seam: r.seam,
    note: r.note,
  }));
  return { matchedElements: targets.size, rules };
}
