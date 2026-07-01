#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Cliente Dune API (sem jq) — cria/executa query e imprime a tabela.
// Uso:
//   node dune/dune.mjs create dune/slippage_by_dex.sql "ZEUS #5 slippage"   → cria e devolve QUERY_ID
//   node dune/dune.mjs run <QUERY_ID>                                       → executa, aguarda, imprime
//   node dune/dune.mjs sql dune/slippage_by_dex.sql "nome"                  → create + run num passo só
// Lê DUNE_API_KEY do ambiente ou do .env raiz. Salva o JSON em dune/out/<id>.json.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function apiKey() {
  if (process.env.DUNE_API_KEY) return process.env.DUNE_API_KEY.trim();
  const envPath = resolve(ROOT, '.env');
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').match(/^DUNE_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('DUNE_API_KEY ausente (ambiente ou .env raiz)');
}
const API = 'https://api.dune.com/api/v1';
const H = () => ({ 'X-Dune-API-Key': apiKey(), 'Content-Type': 'application/json' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function create(sqlFile, name) {
  const query_sql = readFileSync(resolve(ROOT, sqlFile), 'utf8');
  const res = await fetch(`${API}/query`, { method: 'POST', headers: H(), body: JSON.stringify({ name, query_sql, is_private: false }) });
  const j = await res.json();
  if (!j.query_id) throw new Error(`falha ao criar (plano free?): ${JSON.stringify(j)}`);
  console.log(`✅ query criada: QUERY_ID=${j.query_id}`);
  return j.query_id;
}

async function run(queryId) {
  console.log(`▶️  executando query ${queryId} ...`);
  const ex = await (await fetch(`${API}/query/${queryId}/execute`, { method: 'POST', headers: H() })).json();
  if (!ex.execution_id) throw new Error(`falha ao iniciar execução: ${JSON.stringify(ex)}`);
  const execId = ex.execution_id;
  for (let i = 1; i <= 60; i++) {
    const st = await (await fetch(`${API}/execution/${execId}/status`, { headers: H() })).json();
    console.log(`    [${i}] ${st.state}`);
    if (st.state === 'QUERY_STATE_COMPLETED') break;
    if (st.state === 'QUERY_STATE_FAILED' || st.state === 'QUERY_STATE_CANCELLED') throw new Error(`execução ${st.state}`);
    await sleep(5000);
  }
  const out = await (await fetch(`${API}/execution/${execId}/results`, { headers: H() })).json();
  mkdirSync(resolve(ROOT, 'dune/out'), { recursive: true });
  writeFileSync(resolve(ROOT, `dune/out/${queryId}.json`), JSON.stringify(out, null, 2));
  const rows = out?.result?.rows ?? [];
  console.log(`\n✅ ${rows.length} linhas — dune/out/${queryId}.json\n`);
  if (rows.length) {
    const cols = Object.keys(rows[0]);
    console.log(cols.map((c) => String(c).padEnd(16)).join(''));
    for (const r of rows) console.log(cols.map((c) => String(r[c] ?? '').padEnd(16)).join(''));
  }
  return rows;
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'create') await create(a, b ?? 'ZEUS query');
  else if (cmd === 'run') await run(a);
  else if (cmd === 'sql') await run(await create(a, b ?? 'ZEUS query'));
  else { console.log('uso: node dune/dune.mjs [create <sql> <nome> | run <id> | sql <sql> <nome>]'); process.exit(1); }
} catch (e) {
  console.error('❌', e.message);
  process.exit(1);
}
