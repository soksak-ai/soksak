import { describe, expect, it } from "vitest";

import { en } from "./i18n.en";
import { ko } from "./i18n.ko";

const koFigurative = [
  /\uC0B0\uB2E4/u,
  /\uB9D0\uD55C\uB2E4/u,
  /\uC13C\uB2E4/u,
  /\uC2E3\uB294\uB2E4|\uC2E3\uACE0/u,
  /\uD758\uB9B0\uB2E4|\uD758\uB824\uBCF4\uB0B8/u,
  /\uCE68\uBB35/u,
  /\uAF00\uB9E4/u,
  /\uBAB0\uACE0|\uBAB9\uB2C8\uB2E4/u,
  /\uBA39\uC774\uC2ED\uC2DC\uC624/u,
  /\uC8FC\uC778 \uC5C6\uB294/u,
  /\uC720\uB839 \uD45C\uBA74/u,
  /(?<!\uC751)\uB2F5\uD569\uB2C8\uB2E4/u,
  / \uB0C5\uB2C8\uB2E4/u,
];

const enFigurative = [
  /\b(?:land|lands|landed)\b/iu,
  /\b(?:speak|speaks|tells?)\b/iu,
];

describe("i18n technical writing", () => {
  it("contains no banned figurative wording", () => {
    const failures: string[] = [];
    for (const [key, value] of Object.entries(ko)) {
      for (const pattern of koFigurative) {
        if (pattern.test(value)) failures.push(`ko ${key}: ${pattern} :: ${value}`);
      }
    }
    for (const [key, value] of Object.entries(en)) {
      for (const pattern of enFigurative) {
        if (pattern.test(value)) failures.push(`en ${key}: ${pattern} :: ${value}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps each localized message below 900 characters", () => {
    const failures = [...Object.entries(ko), ...Object.entries(en)]
      .filter(([, value]) => value.length > 900)
      .map(([key, value]) => `${key}: ${value.length}`);
    expect(failures).toEqual([]);
  });
});
