import { describe, expect, it } from "vitest";
import { filterKind } from "./FilterBrowser";

describe("filterKind", () => {
  it("classifies by pad summary", () => {
    expect(filterKind("V->V")).toBe("video");
    expect(filterKind("VV->V")).toBe("video");
    expect(filterKind("|->V")).toBe("video");
    expect(filterKind("A->A")).toBe("audio");
    expect(filterKind("AA->A")).toBe("audio");
    expect(filterKind("A->V")).toBe("other");
    expect(filterKind("N->N")).toBe("other");
  });
});
