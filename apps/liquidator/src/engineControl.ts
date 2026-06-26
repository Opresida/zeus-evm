/**
 * Controle remoto de execução (toggle do Frontend → bot) via Supabase `engine_control`.
 *
 * Modelo ARMADO-MAS-TRAVADO: o bot sobe com a wallet pronta (armado), mas o ENVIO de tx fica
 * TRAVADO até o operador ligar pelo painel. A escrita na tabela é EXCLUSIVA das rotas /api do
 * Frontend (validadas por secret); o bot só LÊ.
 *
 * Vale pro Motor 1 INTEIRO (liquidação clássica + pré-liquidação Morpho) — ambos passam pelo
 * mesmo `dispatch`, então o toggle gateia os dois de uma vez.
 *
 * FAIL-SAFE absoluto: qualquer incerteza (sem config, erro de rede, resposta malformada,
 * coluna ausente) → retorna `false` (travado). Nunca liga a execução na dúvida.
 */

/** Lê o estado desejado de execução pra um motor. Retorna `false` em QUALQUER falha (fail-safe). */
export async function fetchEngineControlEnabled(opts: {
  supabaseUrl?: string;
  supabaseKey?: string;
  motor: string;
  /** Timeout do fetch (ms). Default 4000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { supabaseUrl, supabaseKey, motor, timeoutMs = 4_000, fetchImpl = fetch } = opts;
  // Sem config → travado pra sempre (fail-safe). É o default seguro em produção.
  if (!supabaseUrl || !supabaseKey) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/engine_control?motor=eq.${encodeURIComponent(motor)}&select=execution_enabled`;
    const res = await fetchImpl(url, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const row = rows[0] as { execution_enabled?: unknown };
    // Só liga com booleano `true` EXATO — qualquer outra coisa = travado.
    return row.execution_enabled === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
