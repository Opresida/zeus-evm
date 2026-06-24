import { describe, expect, it } from "vitest";
import { generateInsights } from "./insights";

describe("generateInsights — Fase 3 (regras sobre dados reais)", () => {
  it("sem sinais → lista vazia (card fica vazio em LIVE, não inventa)", () => {
    expect(generateInsights({})).toEqual([]);
  });

  it("concentração de motor >=55% → insight gold", () => {
    const r = generateInsights({
      motorBreak: [
        { name: "M2 · Arbitragem", val: 700, pct: "100" },
        { name: "M1 · Liquidações", val: 300, pct: "43" },
      ],
    });
    expect(r.some((i) => i.text.includes("70%") && i.text.includes("M2"))).toBe(true);
  });

  it("concentração equilibrada (<55%) → sem insight de concentração", () => {
    const r = generateInsights({
      motorBreak: [
        { name: "M2", val: 500, pct: "100" },
        { name: "M1", val: 500, pct: "100" },
      ],
    });
    expect(r).toEqual([]);
  });

  it("drift >=150 bps → insight vermelho de calibração", () => {
    const r = generateInsights({ driftBps: -210 });
    expect(r[0]).toMatchObject({ color: "var(--red)" });
    expect(r[0].text).toContain("-210 bps");
  });

  it("kill switch disparado → crítico; perda >=50% do limite → atenção", () => {
    expect(generateInsights({ killSwitch: { loss24hUsd: 100, limitUsd: 100, triggered: true } })[0].text).toContain("DISPARADO");
    const warn = generateInsights({ killSwitch: { loss24hUsd: 60, limitUsd: 100, triggered: false } });
    expect(warn[0].text).toContain("60%");
    // abaixo de 50% não alerta
    expect(generateInsights({ killSwitch: { loss24hUsd: 10, limitUsd: 100, triggered: false } })).toEqual([]);
  });

  it("runway < 3 dias → alerta; >= 3 → silêncio", () => {
    expect(generateInsights({ runwayDays: 1.8 })[0].text).toContain("runway");
    expect(generateInsights({ runwayDays: 6.2 })).toEqual([]);
    expect(generateInsights({ runwayDays: NaN })).toEqual([]); // "—" parseado vira NaN
  });

  it("competidor com ameaça >=0.7 → insight cyan", () => {
    const r = generateInsights({ competitors: [{ alias: "bob.eth", category: "builder", threat: 0.85 }] });
    expect(r[0]).toMatchObject({ color: "var(--cyan)" });
    expect(r[0].text).toContain("bob.eth");
  });

  it("win-rate < 50% → insight; >=50% → silêncio", () => {
    expect(generateInsights({ winRatePct: 42 })[0].text).toContain("42%");
    expect(generateInsights({ winRatePct: 64 })).toEqual([]);
  });

  it("vários sinais ao mesmo tempo → acumula", () => {
    const r = generateInsights({
      motorBreak: [{ name: "M2", val: 900, pct: "100" }, { name: "M1", val: 100, pct: "11" }],
      driftBps: 300,
      killSwitch: { loss24hUsd: 80, limitUsd: 100, triggered: false },
      runwayDays: 1.0,
      competitors: [{ alias: "x", category: "searcher", threat: 0.9 }],
      winRatePct: 30,
    });
    expect(r.length).toBe(6);
  });
});
