#!/usr/bin/env node

/** Fail the build if any deleted Workflow v2 executable/UI artifact survived. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = resolve(repoRoot, 'dist');
const sourceStatus = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], {
  encoding: 'utf8',
  timeout: 10_000,
}).trim();
if (sourceStatus) {
  throw new Error('BotMux build manifest requires a clean source worktree');
}
const retiredModules = [
  'workflows/attempt-resume',
  'workflows/blob',
  'workflows/cancel-run',
  'workflows/cancel',
  'workflows/catalog',
  'workflows/cold-attach',
  'workflows/cold-scan',
  'workflows/daemon-spawn',
  'workflows/effect-input',
  'workflows/events/append',
  'workflows/events/idempotency',
  'workflows/events/index',
  'workflows/fanout',
  'workflows/hostExecutors/protocol',
  'workflows/loader',
  'workflows/loop',
  'workflows/orchestrator',
  'workflows/output-binding',
  'workflows/params',
  'workflows/resume',
  'workflows/run-id',
  'workflows/run-init',
  'workflows/runs-dir',
  'workflows/runtime',
  'workflows/spawn-bot',
  'workflows/spawn-policy',
  'workflows/system',
  'workflows/trigger-from-envelope',
  'workflows/trigger-run',
  'workflows/wait',
  'im/lark/workflow-card-handler',
  'im/lark/workflow-cards',
  'im/lark/workflow-progress-card',
  'im/lark/workflows-card',
  'dashboard/workflow-api',
  'dashboard/workflow-card-model',
  'dashboard/workflows-action-helpers',
  'core/dashboard-command/workflows',
  'dashboard/web/legacy-workflow-link',
  'dashboard/web/legacy-workflow-page',
  'dashboard/web/workflow-version-switch',
  'dashboard/web/workflows',
];
const generatedSuffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
const stale = retiredModules.flatMap((modulePath) =>
  generatedSuffixes
    .map((suffix) => `${modulePath}${suffix}`)
    .filter((relativePath) => existsSync(resolve(distDir, relativePath))),
);
if (existsSync(resolve(distDir, 'dashboard-web/terminal-replay.html'))) {
  stale.push('dashboard-web/terminal-replay.html');
}
if (stale.length > 0) {
  throw new Error(`retired Workflow v2 build artifacts survived:\n${stale.map((p) => `- ${p}`).join('\n')}`);
}

const manifestName = 'botmux-build-manifest.json';
function runtimeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const target = resolve(directory, entry.name);
      if (entry.isDirectory()) return runtimeFiles(target);
      if (entry.name === manifestName) return [];
      if (!entry.isFile() || !lstatSync(target).isFile()) {
        throw new Error(`BotMux dist contains an unsupported entry: ${target}`);
      }
      return [target];
    });
}

const botmuxCommit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: 10_000,
}).trim();
if (!/^[0-9a-f]{40}$/.test(botmuxCommit)) {
  throw new Error('BotMux build manifest requires a full Git commit');
}
const files = runtimeFiles(distDir).map((file) => {
  if (!statSync(file).isFile()) throw new Error(`BotMux runtime artifact is not a file: ${file}`);
  return {
    path: relative(distDir, file).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  };
});
const treeSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
for (const entrypoint of ['index-daemon.js', 'worker.js']) {
  if (!files.some(file => file.path === entrypoint)) {
    throw new Error(`BotMux build manifest is missing ${entrypoint}`);
  }
}
writeFileSync(resolve(distDir, manifestName), `${JSON.stringify({
  schemaVersion: 1,
  botmuxCommit,
  treeSha256,
  files,
}, null, 2)}\n`, { mode: 0o644 });
console.log('[build-audit] retired Workflow v2 artifacts absent');
console.log(`[build-audit] BotMux runtime manifest covers ${files.length} files at ${botmuxCommit} (${treeSha256})`);
