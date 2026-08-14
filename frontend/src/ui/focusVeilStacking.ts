// Layer law for the left rail and the tabview work plane, established from the CSS text.
// The left rail moves below the work plane; lighting exclusion is owned by exact mask geometry.
// Right sidebar/modal/global chrome is owned by projectRailStackingViolations/B09, not by this law.

interface CssRule {
  selector: string;
  decls: string;
}

/** Split into top-level "selector { decls }" units. A comment attached to the selector is stripped. */
function rulesOf(css: string): CssRule[] {
  const out: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    out.push({
      selector: match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
      decls: match[2].replace(/\/\*[\s\S]*?\*\//g, ""),
    });
  }
  return out;
}

const PLANE = /^\.[a-z0-9-]+-plane$/;

interface PlaneFact {
  selector: string;
  zIndex: number | null;
  positioned: boolean;
}

function declared(decls: string, property: string): string | null {
  const found = decls.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  return found ? found[1].trim() : null;
}

/** Planes declared by a single class selector. A rule carrying a state selector is not the base declaration. */
export function planeFacts(css: string): PlaneFact[] {
  const bySelector = new Map<string, PlaneFact>();
  for (const { selector, decls } of rulesOf(css)) {
    for (const single of selector.split(",").map((part) => part.trim())) {
      if (!PLANE.test(single)) continue;
      const fact = bySelector.get(single) ?? { selector: single, zIndex: null, positioned: false };
      const zIndex = declared(decls, "z-index");
      if (zIndex !== null && zIndex !== "auto") {
        const order = Number.parseInt(zIndex, 10);
        fact.zIndex = Number.isFinite(order) ? order : fact.zIndex;
      }
      const position = declared(decls, "position");
      if (position !== null && position !== "static") fact.positioned = true;
      bySelector.set(single, fact);
    }
  }
  return [...bySelector.values()];
}

function layerOf(css: string, selector: string): number | null {
  for (const rule of rulesOf(css)) {
    if (rule.selector.split(",").map((part) => part.trim()).includes(selector)) {
      const zIndex = declared(rule.decls, "z-index");
      if (zIndex === null || zIndex === "auto") continue;
      const order = Number.parseInt(zIndex, 10);
      if (Number.isFinite(order)) return order;
    }
  }
  return null;
}

const RAIL_PLANE = ".left-rail-plane";
const VEIL_PLANE = ".focus-lighting-plane";
const SPACE_PLANE = ".space-plane";
const RELATION_OVERLAY = ".rail-link-overlay";
const PROJECT_RAIL = ".project-rail";
const CONTENT_STACK = ".terminal-stack";

function boxFact(css: string, selector: string): PlaneFact | null {
  const fact: PlaneFact = { selector, zIndex: null, positioned: false };
  let found = false;
  for (const rule of rulesOf(css)) {
    if (!rule.selector.split(",").map((part) => part.trim()).includes(selector)) continue;
    found = true;
    const zIndex = declared(rule.decls, "z-index");
    if (zIndex !== null && zIndex !== "auto") {
      const order = Number.parseInt(zIndex, 10);
      if (Number.isFinite(order)) fact.zIndex = order;
    }
    const position = declared(rule.decls, "position");
    if (position !== null) fact.positioned = position !== "static";
  }
  return found ? fact : null;
}

/** Project + rail is permanent chrome above the browser content stack of the same DOM document. */
export function projectRailStackingViolations(css: string): string[] {
  const violations: string[] = [];
  const rail = boxFact(css, PROJECT_RAIL);
  const content = boxFact(css, CONTENT_STACK);
  if (!rail) return [`${PROJECT_RAIL}: not declared`];
  if (!content) return [`${CONTENT_STACK}: not declared`];
  if (!rail.positioned) violations.push(`${PROJECT_RAIL}: not positioned`);
  if (rail.zIndex === null) violations.push(`${PROJECT_RAIL}: no z-index`);
  const contentRank = content.zIndex ?? (content.positioned ? 0 : -0.5);
  if (rail.zIndex !== null && rail.zIndex <= contentRank) {
    violations.push(`${PROJECT_RAIL}: z-index ${rail.zIndex} <= ${CONTENT_STACK} ${contentRank}`);
  }
  return violations;
}

/** Violation list. An empty array passes. A dead oracle (no plane found at all) is a violation too. */
export function focusVeilStackingViolations(css: string): string[] {
  const violations: string[] = [];
  const planes = planeFacts(css);
  const rail = planes.find((plane) => plane.selector === RAIL_PLANE);
  const veil = planes.find((plane) => plane.selector === VEIL_PLANE);
  const space = planes.find((plane) => plane.selector === SPACE_PLANE);

  if (!rail || rail.zIndex === null) {
    violations.push(`${RAIL_PLANE}: no layer declared — the reference plane of the rule is gone`);
  }
  if (!veil || veil.zIndex === null) {
    violations.push(`${VEIL_PLANE}: no layer declared — the subject of the rule is gone`);
  }
  if (!space || space.zIndex === null) {
    violations.push(`${SPACE_PLANE}: no layer declared — the tabview work plane reference is gone`);
  }

  for (const plane of planes) {
    if (plane.zIndex === null) continue;
    if (!plane.positioned) {
      violations.push(`${plane.selector}: z-index ${plane.zIndex} declared without positioning — content leaks outside the plane`);
    }
  }

  if (!rail || rail.zIndex === null || !space || space.zIndex === null) return violations;
  if (rail.zIndex >= space.zIndex) {
    violations.push(
      `${RAIL_PLANE}: z-index ${rail.zIndex} >= ${SPACE_PLANE} ${space.zIndex} — the left rail covers the tabview work plane`,
    );
  }

  const relation = layerOf(css, RELATION_OVERLAY);
  const contentTop = Math.max(rail.zIndex, space.zIndex);
  if (relation === null || relation <= contentTop) {
    violations.push(`${RELATION_OVERLAY}: z-index ${String(relation)} <= content planes ${contentTop}`);
  }
  return violations;
}
