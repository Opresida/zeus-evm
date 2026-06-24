import { defineConfig } from "vitest/config";

// O painel não tinha runner de testes. Vitest em ambiente node cobre a lógica pura de derivação
// (lib/live.ts, lib/viewModel.ts) — sem React/DOM. Telas (TSX) seguem cobertas por typecheck.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
