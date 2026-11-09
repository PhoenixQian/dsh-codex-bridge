// This helper only parses configuration metadata. It never boots DSH plugins.
import { readFileSync } from 'node:fs';
import { importDshModule, assertSupportedDsh } from '../runtime-config.mjs';
const fields = ['id', 'name', 'api', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pickModel = value => {
  if (!plain(value) || typeof value.id !== 'string' || !value.id || /[\0\r\n]/.test(value.id)) return null;
  return Object.fromEntries(fields.filter(key => value[key] !== undefined && value[key]?.expression !== true).map(key => [key, value[key]]));
};
try {
  const runtime = await assertSupportedDsh();
  const [{ DeepSeekAdapter, resolveAdapterOptions }, yamlModule] = await Promise.all([
    importDshModule('@deepseek-ai/dsh-llm-deepseek'),
    importDshModule('yaml', { subpath: 'dist/index.js' }),
  ]);
  const yaml = yamlModule.default ?? yamlModule;
  const doc = yaml.parseDocument(readFileSync(process.argv[2], 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: () => ({ expression: true }) }], logLevel: 'silent',
  });
  if (doc.errors.length) throw new Error('The desktop provider metadata cannot be parsed.');
  const rows = doc.toJS(); const providers = {};
  function scan(entries) {
    if (!Array.isArray(entries)) return;
    for (const row of entries) {
      if (row?.id === 'llm-pi-ai' || row?.name === '@deepseek-ai/dsh-llm-pi-ai') {
        const route = row.config?.providers?.openrouter;
        if (plain(route) && Array.isArray(route.models)) {
          const models = route.models.map(pickModel).filter(Boolean);
          const apiKeyEnv = typeof route.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(route.apiKeyEnv) ? route.apiKeyEnv : undefined;
          if (models.length && apiKeyEnv) providers.openrouter = { apiKeyEnv, models, ...typeof route.reasoning === 'string' ? { reasoning: route.reasoning } : {} };
        }
      }
      scan(row?.insert); scan(row?.entries); scan(row?.config?.entries);
    }
  }
  scan(rows);
  // resolveModel is a pure local metadata method when dependencies.connect is
  // absent. Never call discoverModels/prepareCall/stream or load account auth.
  const adapter = new DeepSeekAdapter({ options: () => resolveAdapterOptions({}) });
  const account = await adapter.resolveModel('deepseek-account', 'deepseek-flash');
  process.stdout.write('DSH_METADATA ' + JSON.stringify({ providers, accountReasoning: account.reasoning, reasoningSource: '@deepseek-ai/dsh-llm-deepseek:DeepSeekAdapter.resolveModel', runtimeVersion: runtime.version }) + '\n');
} catch (error) {
  process.stderr.write('DSH metadata inspection failed; the supported DSH Desktop runtime and profile are required.\n');
  process.exitCode = 1;
}
