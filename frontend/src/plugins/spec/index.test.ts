// The barrel exports only the names Core uses. parseEnvironmentDocument is not one of them: the host
// validates environment.json once and the frontend consumes the result as typed data.
import { describe, expect, it } from "vitest";
import * as spec from "./index";

describe("spec barrel", () => {
  it("does not export parseEnvironmentDocument", () => {
    expect(Object.keys(spec)).not.toContain("parseEnvironmentDocument");
  });
});
