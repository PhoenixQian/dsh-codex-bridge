import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizePlan, fallbackPlan } from '../server/execution/cooperation-rules.mjs';

function planWith(codexOutputs, dshOutputs, extra = {}) {
  return {
    assignments: [
      {
        agent: 'Codex',
        goal: 'Produce the implementation.',
        outputs: codexOutputs,
        ...(extra.codexDependsOn ? { dependsOn: extra.codexDependsOn } : {}),
      },
      {
        agent: 'DSH',
        goal: 'Review the implementation.',
        outputs: dshOutputs,
        ...(extra.dshDependsOn ? { dependsOn: extra.dshDependsOn } : {}),
      },
    ],
    ...(extra.notes !== undefined ? { notes: extra.notes } : {}),
  };
}

test('accepts a valid wrapped plan and preserves legal paths and notes', () => {
  const normalized = normalizePlan({
    plan: {
      assignments: [
        {
          agent: 'Codex',
          goal: '  Build the API  ',
          outputs: ['src/api.mjs', 'docs/'],
        },
        {
          agent: 'DSH',
          goal: 'Write tests',
          outputs: ['test/api.test.mjs'],
          dependsOn: ['Codex'],
        },
      ],
      notes: '  keep the public API stable  ',
    },
  });

  assert.equal(normalized.assignments.length, 2);
  const codex = normalized.assignments.find((item) => item.agent === 'Codex');
  const dsh = normalized.assignments.find((item) => item.agent === 'DSH');
  assert.ok(codex);
  assert.ok(dsh);
  assert.equal(codex.goal, 'Build the API');
  assert.deepEqual(codex.outputs, ['src/api.mjs', 'docs/']);
  assert.equal(dsh.goal, 'Write tests');
  assert.deepEqual(dsh.outputs, ['test/api.test.mjs']);
  assert.deepEqual(dsh.dependsOn, ['Codex']);
  assert.equal(normalized.notes, 'keep the public API stable');
  assert.equal('dependsOn' in codex, false);
});

test('normalizes agent casing but rejects duplicate or missing roles', () => {
  const normalized = normalizePlan({
    assignments: [
      { agent: 'codex', goal: 'A', outputs: ['a.md'] },
      { agent: 'dsh', goal: 'B', outputs: ['b.md'] },
    ],
  });
  assert.deepEqual(normalized.assignments.map((item) => item.agent), ['Codex', 'DSH']);

  assert.throws(
    () => normalizePlan({
      assignments: [
        { agent: 'Codex', goal: 'A', outputs: ['a.md'] },
        { agent: 'Codex', goal: 'B', outputs: ['b.md'] },
      ],
    }),
    /duplicate assignment/,
  );

  assert.throws(
    () => normalizePlan({
      assignments: [
        { agent: 'Codex', goal: 'A', outputs: ['a.md'] },
        { agent: 'DSH', goal: 'B', outputs: ['b.md'] },
        { agent: 'DSH', goal: 'C', outputs: ['c.md'] },
      ],
    }),
    /exactly two assignments|duplicate assignment/,
  );
});

test('rejects empty goals and empty outputs', () => {
  assert.throws(
    () => normalizePlan({
      assignments: [
        { agent: 'Codex', goal: '   ', outputs: ['a.md'] },
        { agent: 'DSH', goal: 'B', outputs: ['b.md'] },
      ],
    }),
    /non-empty goal/,
  );

  assert.throws(
    () => normalizePlan({
      assignments: [
        { agent: 'Codex', goal: 'A', outputs: [] },
        { agent: 'DSH', goal: 'B', outputs: ['b.md'] },
      ],
    }),
    /non-empty outputs/,
  );
});

test('rejects absolute paths, traversal, backslashes, NUL bytes, and sensitive paths', () => {
  const badOutputs = [
    '/etc/passwd',
    'C:/Windows/system.ini',
    '../outside.md',
    'a/../../outside.md',
    'dir\\file.md',
    'bad\0name.md',
    '.env',
    '.env.local',
    'config/.codex/settings.json',
    '.dsh/state.json',
    'inputs/task.md',
    'SUMMARY.md',
    'nested/Summary.md',
    'credentials/token.json',
    'config/secrets.json',
    '.ssh/id_rsa',
  ];

  for (const badOutput of badOutputs) {
    assert.throws(
      () => normalizePlan(planWith(['ok.md'], [badOutput])),
      Error,
      `expected rejection for ${JSON.stringify(badOutput)}`,
    );
  }
});

test('rejects exact and directory-prefix overlap between agents', () => {
  assert.throws(
    () => normalizePlan(planWith(['shared.md'], ['shared.md'])),
    /overlap/,
  );

  assert.throws(
    () => normalizePlan(planWith(['assets/'], ['assets/logo.png'])),
    /overlap/,
  );

  assert.throws(
    () => normalizePlan(planWith(['assets/logo.png'], ['assets/'])),
    /overlap/,
  );

  assert.throws(
    () => normalizePlan(planWith(['docs/'], ['docs'])),
    /overlap/,
  );
});

test('detects case-insensitive and NFC-equivalent overlap', () => {
  assert.throws(
    () => normalizePlan(planWith(['src/App.mjs'], ['src/app.mjs'])),
    /overlap/,
  );

  const composed = 'caf\u00e9.md';
  const decomposed = 'cafe\u0301.md';
  assert.notEqual(composed, decomposed);
  assert.throws(
    () => normalizePlan(planWith([composed], [decomposed])),
    /overlap/,
  );
});

test('allows same-parent but non-overlapping outputs', () => {
  const normalized = normalizePlan(
    planWith(['docs/api.md'], ['docs/review-notes/']),
  );
  assert.deepEqual(
    normalized.assignments.find((item) => item.agent === 'Codex').outputs,
    ['docs/api.md'],
  );
});

test('allows ordinary code and documentation names containing credential-related words', () => {
  const outputs = [
    'src/tokenizer.js',
    'src/token-budget.mjs',
    'src/password-strength.mjs',
    'src/credential-helper.mjs',
    'src/credentials-handler.mjs',
    'docs/secret-sharing.md',
    'docs/passwd-format.md',
    'src/.environment.mjs',
  ];
  const normalized = normalizePlan(planWith(outputs, ['review.md']));
  assert.deepEqual(normalized.assignments[0].outputs, outputs);
});

test('blocks exact credential files and directories supported by the task file boundary', () => {
  for (const output of [
    '.env-production',
    'config/.ENV.LOCAL',
    '.credentials',
    'config/.credentials.yaml',
    'config/CREDENTIALS.json',
    '.aws/config',
    '.gnupg/keyring',
    '.kube/config',
    'keys/id_rsa.pub',
    'keys/id_ed25519.pub',
    'keys/id_ecdsa.pub',
    'config/auth.json',
  ]) {
    assert.throws(() => normalizePlan(planWith([output], ['review.md'])), /reserved|sensitive/, output);
  }
});

test('returns canonical relative outputs and retains directory namespace ownership', () => {
  const normalized = normalizePlan(planWith(
    ['./src//Tokenizer.js', 'src/./Tokenizer.js', './docs///', './docs/'],
    ['reviews//./report.md'],
  ));
  assert.deepEqual(normalized.assignments[0].outputs, ['src/Tokenizer.js', 'docs/']);
  assert.deepEqual(normalized.assignments[1].outputs, ['reviews/report.md']);
  for (const rootAlias of ['.', './', '././', './//']) {
    assert.throws(() => normalizePlan(planWith([rootAlias], ['review.md'])), /workspace root/);
  }
});

test('canonical plan outputs can be written and collected by the task runtime', async t => {
  const { TaskFiles } = await import('../server/execution/files.mjs');
  const { TaskRuntime } = await import('../server/execution/runtime.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'cooperation-paths-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attemptRoot = join(directory, 'attempt'); await mkdir(attemptRoot);
  const plan = normalizePlan(planWith(['./result.md', 'assets///'], ['reviews//./report.md']));
  for (const assignment of plan.assignments) {
    const files = await new TaskFiles({ workspace: join(attemptRoot, 'workers', assignment.agent, 'workspace'), allowedOutputs: assignment.outputs }).init();
    for (const path of assignment.outputs) await files.write(path.endsWith('/') ? path + 'file.txt' : path, assignment.agent + ' output');
  }
  const runtime = new TaskRuntime({ directory });
  const artifacts = await runtime.collectArtifacts('fixture', attemptRoot, plan.assignments);
  assert.deepEqual(artifacts.map(a => a.agent + ':' + a.name).sort(), ['Codex:assets/file.txt', 'Codex:result.md', 'DSH:reviews/report.md']);
});

test('an explicit image generation task reserves the complete images namespace for Codex', () => {
  const task = { imageGeneration: true };
  const accepted = normalizePlan(planWith(['./images///'], ['review.md']), task);
  assert.deepEqual(accepted.assignments[0].outputs, ['images/']);
  for (const outputs of [['result.md'], ['images/logo.png'], ['images/subdir/']]) {
    assert.throws(() => normalizePlan(planWith(outputs, ['review.md']), task), /Codex.*images\//);
  }
  assert.throws(() => normalizePlan(planWith(['result.md'], ['images/']), task), /Codex|images\//);
  assert.throws(() => normalizePlan(planWith(['images/'], ['images/review.md']), task), /overlap|images\//);
});

test('image words in the task title or goal do not enforce image output ownership', () => {
  const task = { title: 'Describe an image parser', goal: 'Explain image tokenization', imageGeneration: false };
  assert.doesNotThrow(() => normalizePlan(planWith(['tokenizer.js'], ['review.md']), task));
  assert.doesNotThrow(() => normalizePlan(planWith(['result.md'], ['review.md']), { title: '图片说明' }));
});

test('rejects self-dependencies, unknown dependencies, and two-way cycles', () => {
  assert.throws(
    () => normalizePlan(planWith(['a.md'], ['b.md'], { codexDependsOn: ['Codex'] })),
    /itself/,
  );

  assert.throws(
    () => normalizePlan(planWith(['a.md'], ['b.md'], { dshDependsOn: ['Someone'] })),
    /unknown agent/,
  );

  assert.throws(
    () => normalizePlan(planWith(['a.md'], ['b.md'], {
      codexDependsOn: ['DSH'],
      dshDependsOn: ['Codex'],
    })),
    /circular/,
  );
});

test('fallbackPlan gives normal tasks exclusive default outputs', () => {
  const fallback = fallbackPlan({ kind: 'text', title: 'Refactor parser' });
  assert.equal(fallback.assignments.length, 2);

  const codex = fallback.assignments.find((item) => item.agent === 'Codex');
  const dsh = fallback.assignments.find((item) => item.agent === 'DSH');
  assert.deepEqual(codex.outputs, ['Codex-result.md']);
  assert.deepEqual(dsh.outputs, ['DSH-review.md']);
  assert.deepEqual(dsh.dependsOn, ['Codex']);
  assert.doesNotThrow(() => normalizePlan(fallback));
});

test('fallbackPlan detects image tasks and separates images/ from the review', () => {
  for (const task of [
    { imageGeneration: true, title: 'Create the requested asset' },
    { kind: 'image-generation' },
    { images: ['reference.png'] },
    { prompt: '请生成一张海报图片' },
    { attachments: [{ type: 'image/png', name: 'ref.png' }] },
  ]) {
    const fallback = fallbackPlan(task);
    const codex = fallback.assignments.find((item) => item.agent === 'Codex');
    const dsh = fallback.assignments.find((item) => item.agent === 'DSH');
    assert.deepEqual(codex.outputs, ['images/']);
    assert.deepEqual(dsh.outputs, ['DSH-review.md']);
    assert.deepEqual(dsh.dependsOn, ['Codex']);
    assert.doesNotThrow(() => normalizePlan(fallback, task));
  }
});

test('fallbackPlan returns fresh, independent objects', () => {
  const first = fallbackPlan({ kind: 'text' });
  first.assignments[0].outputs.push('mutated.md');
  const second = fallbackPlan({ kind: 'text' });
  assert.deepEqual(second.assignments[0].outputs, ['Codex-result.md']);
});
