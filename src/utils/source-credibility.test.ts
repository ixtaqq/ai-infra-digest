import { describe, it, expect } from "vitest";
import { getSourceCredibility, isPRWireSource } from "./source-credibility";

describe("getSourceCredibility", () => {
  it("returns 1.2 for high-tier sources", () => {
    expect(getSourceCredibility("Reuters")).toBe(1.2);
    expect(getSourceCredibility("Bloomberg Technology")).toBe(1.2);
    expect(getSourceCredibility("TechCrunch")).toBe(1.2);
    expect(getSourceCredibility("Ars Technica")).toBe(1.2);
    expect(getSourceCredibility("SemiAnalysis")).toBe(1.2);
  });

  it("returns 0.8 for low-tier vendor PR sources", () => {
    expect(getSourceCredibility("NVIDIA")).toBe(0.8);
    expect(getSourceCredibility("Google AI Blog")).toBe(0.8);
    expect(getSourceCredibility("OpenAI")).toBe(0.8);
    expect(getSourceCredibility("Anthropic")).toBe(0.8);
    expect(getSourceCredibility("AWS AI")).toBe(0.8);
  });

  it("returns 0.8 for PR wire sources", () => {
    expect(getSourceCredibility("Business Wire")).toBe(0.8);
    expect(getSourceCredibility("PR Newswire")).toBe(0.8);
    expect(getSourceCredibility("Globe Newswire")).toBe(0.8);
  });

  it("returns 1.0 (neutral) for unknown sources", () => {
    expect(getSourceCredibility("Some Unknown Blog")).toBe(1.0);
    expect(getSourceCredibility("")).toBe(1.0);
    expect(getSourceCredibility("Random Tech News")).toBe(1.0);
  });
});

describe("isPRWireSource", () => {
  it("returns true for known PR wire services", () => {
    expect(isPRWireSource("Business Wire")).toBe(true);
    expect(isPRWireSource("BusinessWire")).toBe(true);
    expect(isPRWireSource("PR Newswire")).toBe(true);
    expect(isPRWireSource("PRNewswire")).toBe(true);
    expect(isPRWireSource("Globe Newswire")).toBe(true);
    expect(isPRWireSource("GlobeNewswire")).toBe(true);
    expect(isPRWireSource("PR Web")).toBe(true);
    expect(isPRWireSource("PRWeb")).toBe(true);
    expect(isPRWireSource("EIN Presswire")).toBe(true);
    expect(isPRWireSource("AccessWire")).toBe(true);
  });

  it("returns false for editorial sources", () => {
    expect(isPRWireSource("Reuters")).toBe(false);
    expect(isPRWireSource("TechCrunch")).toBe(false);
    expect(isPRWireSource("Bloomberg Technology")).toBe(false);
    expect(isPRWireSource("NVIDIA")).toBe(false);
    expect(isPRWireSource("")).toBe(false);
  });
});
