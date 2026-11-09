import { join, resolve } from 'node:path';
import { importDshModule, dshResources, assertSupportedDsh } from '../runtime-config.mjs';
await assertSupportedDsh();
const [{ loadProfileDirectory }, { runProfile }, { createLaunchEnvironmentSnapshot }] = await Promise.all([
  importDshModule('@deepseek-ai/dsh-app-boot'),
  importDshModule('@deepseek-ai/dsh', { subpath: 'lib/profile-boot.js' }),
  importDshModule('@deepseek-ai/dsh-launch-environment'),
]);
const directory = resolve(process.argv[2]);
const installAnchor = join(dshResources(), 'app.asar', 'dsh', 'node_modules', '@deepseek-ai/dsh', 'package.json');
process.chdir(directory);
const profile = loadProfileDirectory('dsh', join(directory, 'profile'), installAnchor);
// The parent supplies a small environment allowlist. Never load user/project .env.
const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]);
await runProfile({ environment, profile: 'codex-dsh-task', resolvedProfile: { profile, installAnchor }, patchFiles: [], args: [] });
