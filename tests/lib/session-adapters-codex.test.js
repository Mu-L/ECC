'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createCodexWorktreeAdapter,
  parseCodexTarget,
  findLatestRollout
} = require('../../scripts/lib/session-adapters/codex-worktree');
const {
  normalizeCodexWorktreeSession,
  validateCanonicalSnapshot
} = require('../../scripts/lib/session-adapters/canonical-session');
const { createAdapterRegistry } = require('../../scripts/lib/session-adapters/registry');

console.log('=== Testing codex-worktree session adapter ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL - ${name}`);
    console.log(`        ${error && error.message}`);
  }
}

function writeRolloutFixture() {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-sessions-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-worktree-'));
  const dayDir = path.join(sessionsDir, '2026', '06', '02');
  fs.mkdirSync(dayDir, { recursive: true });

  const now = new Date().toISOString();
  const rolloutPath = path.join(dayDir, 'rollout-2026-06-02T03-01-58-019etest-codex-0001.jsonl');
  const lines = [
    { type: 'session_meta', timestamp: now, payload: {
      id: '019etest-codex-0001', timestamp: now, cwd: repoRoot,
      originator: 'Codex Desktop', cli_version: '0.136.0', source: 'vscode', model_provider: 'openai'
    } },
    { type: 'turn_context', timestamp: now, payload: { model: 'gpt-5.5-codex' } },
    { type: 'response_item', timestamp: now, payload: {
      type: 'message', role: 'user',
      content: [{ type: 'text', text: '# AGENTS.md instructions for /repo\n<cwd>/repo</cwd>' }]
    } },
    { type: 'response_item', timestamp: now, payload: {
      type: 'message', role: 'user',
      content: [{ type: 'text', text: 'continue our ecc 2.0 session and build the codex-worktree adapter' }]
    } }
  ];

  fs.writeFileSync(rolloutPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return { sessionsDir, repoRoot, rolloutPath };
}

test('normalizeCodexWorktreeSession produces a valid ecc.session.v1 snapshot', () => {
  const snapshot = normalizeCodexWorktreeSession({
    sessionId: 'abc', sessionPath: '/tmp/r.jsonl', cwd: '/repo', branch: 'feat/x',
    objective: 'do the thing', model: 'gpt-5.5-codex', originator: 'Codex Desktop',
    cliVersion: '0.136.0', startedAt: '2026-06-02T03:01:58Z', recordCount: 4, active: true
  }, { type: 'codex-worktree', value: 'abc' });

  validateCanonicalSnapshot(snapshot);
  assert.strictEqual(snapshot.adapterId, 'codex-worktree');
  assert.strictEqual(snapshot.session.kind, 'codex-worktree');
  assert.strictEqual(snapshot.session.state, 'active');
  assert.strictEqual(snapshot.workers[0].runtime.kind, 'codex-session');
  assert.strictEqual(snapshot.workers[0].branch, 'feat/x');
  assert.strictEqual(snapshot.workers[0].artifacts.model, 'gpt-5.5-codex');
});

test('parseCodexTarget strips codex prefixes', () => {
  assert.strictEqual(parseCodexTarget('codex:latest'), 'latest');
  assert.strictEqual(parseCodexTarget('codex-worktree:019eabc'), '019eabc');
  assert.strictEqual(parseCodexTarget('/some/path.jsonl'), null);
});

test('adapter reads latest rollout, skips preamble, derives objective + model', () => {
  const { sessionsDir, repoRoot, rolloutPath } = writeRolloutFixture();
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-rec-'));

  assert.strictEqual(findLatestRollout(sessionsDir), rolloutPath);

  const adapter = createCodexWorktreeAdapter({
    sessionsDir, recordingDir, loadStateStoreImpl: () => null, resolveBranchImpl: () => null
  });
  const snapshot = adapter.open('codex:latest', { cwd: repoRoot }).getSnapshot();

  assert.strictEqual(snapshot.adapterId, 'codex-worktree');
  assert.strictEqual(snapshot.session.id, '019etest-codex-0001');
  assert.strictEqual(snapshot.session.state, 'active');
  assert.strictEqual(snapshot.workers.length, 1);
  assert.strictEqual(snapshot.workers[0].worktree, repoRoot);
  assert.strictEqual(snapshot.workers[0].runtime.command, 'codex');
  assert.strictEqual(snapshot.workers[0].runtime.active, true);
  assert.strictEqual(snapshot.workers[0].artifacts.model, 'gpt-5.5-codex');
  assert.strictEqual(
    snapshot.workers[0].intent.objective,
    'continue our ecc 2.0 session and build the codex-worktree adapter'
  );
  assert.strictEqual(snapshot.aggregates.workerCount, 1);
  assert.strictEqual(snapshot.aggregates.states.active, 1);
});

test('registry routes structured codex-worktree target and direct rollout path', () => {
  const { sessionsDir, repoRoot, rolloutPath } = writeRolloutFixture();
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-reg-'));

  const registry = createAdapterRegistry({
    recordingDir,
    loadStateStoreImpl: () => null,
    adapterOptions: { 'codex-worktree': { sessionsDir, resolveBranchImpl: () => null } }
  });

  const typed = registry.open({ type: 'codex-worktree', value: 'latest' }, { cwd: repoRoot }).getSnapshot();
  assert.strictEqual(typed.adapterId, 'codex-worktree');
  assert.strictEqual(typed.session.id, '019etest-codex-0001');

  const byPath = registry.open(rolloutPath, { cwd: repoRoot }).getSnapshot();
  assert.strictEqual(byPath.adapterId, 'codex-worktree');

  const listed = registry.listAdapters().map(a => a.id);
  assert.ok(listed.includes('codex-worktree'), 'registry lists codex-worktree adapter');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
