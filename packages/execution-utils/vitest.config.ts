import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 8 arquivos de teste abrem DuckDB (TimeseriesStore). O addon NATIVO contende sob carga paralela
    // (múltiplos workers/file-handles) → falhas intermitentes (observationReport, que abre 2 DBs via
    // ATTACH, é o mais vulnerável). Forçamos UM ÚNICO processo, arquivos em série → zero contenção.
    // Custo: suíte um pouco mais lenta; ganho: 100% determinística.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
