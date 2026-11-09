/**
 * Pure Node ESM cooperation rules for Codex/DSH task plans.
 *
 * A plan has exactly two assignments, one for Codex and one for DSH. Outputs
 * are sandbox-relative paths or directory namespaces (trailing slash). The
 * rules are intentionally conservative: anything that could escape the task
 * workspace, touch secrets, or let both agents write the same artifact is
 * rejected instead of being silently repaired.
 */

const AGENTS = ['Codex', 'DSH'];
const CANONICAL_AGENT = new Map([
  ['codex', 'Codex'],
  ['dsh', 'DSH'],
]);

// Segments that must never be used as task outputs. Matching is case- and
// NFC-insensitive because some filesystems are case-insensitive.
const RESERVED_EXACT = new Set([
  '.env',
  '.codex',
  '.dsh',
  'inputs',
  'summary.md',
]);

// Keep the task file boundary's anchored credential names: a word such as
// "token" inside tokenizer.js does not make that source file a credential.
const TASK_CREDENTIAL_NAME = /^(?:\.env(?:[.-].*)?|auth\.json|\.credentials(?:\..*)?|credentials(?:\..*)?|\.ssh|\.aws|\.codex|\.dsh|\.gnupg|\.kube|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?)$/i;

const SENSITIVE_EXACT = new Set([
  '.ssh',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.pypirc',
  'secrets.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'auth.json',
]);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAgent(value) {
  if (typeof value !== 'string') {
    fail('agent must be the string "Codex" or "DSH"');
  }
  const canonical = CANONICAL_AGENT.get(value.trim().toLowerCase());
  if (!canonical) {
    fail(`unknown agent: ${JSON.stringify(value)}`);
  }
  return canonical;
}

function isImageAttachment(attachment) {
  if (typeof attachment === 'string') {
    return /\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)$/i.test(attachment);
  }
  if (!isPlainObject(attachment)) return false;
  if (typeof attachment.type === 'string' && /^image\//i.test(attachment.type)) {
    return true;
  }
  if (typeof attachment.mimeType === 'string' && /^image\//i.test(attachment.mimeType)) {
    return true;
  }
  return [attachment.path, attachment.name, attachment.filename, attachment.url]
    .filter((item) => typeof item === 'string')
    .some((item) => /\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)(?:[?#].*)?$/i.test(item));
}

/**
 * Best-effort image-task detection used only to choose fallback outputs.
 * These are implementation defaults, not user-stated facts.
 */
function isImageTask(task) {
  if (!isPlainObject(task)) return false;
  if (task.imageGeneration === true) return true;

  for (const key of ['image', 'images', 'needsImage', 'needsImages', 'isImage']) {
    const value = task[key];
    if (value === true) return true;
    if (Array.isArray(value) && value.length > 0) return true;
    if (isPlainObject(value) && Object.keys(value).length > 0) return true;
    if (typeof value === 'string' && value.trim() !== '') return true;
  }

  const typeText = [task.kind, task.type, task.mode, task.category, task.taskType]
    .filter((item) => typeof item === 'string')
    .join(' ');
  if (/image|img|photo|picture|illustration|drawing|图片|图像|插画|海报|绘图|生图/i.test(typeText)) {
    return true;
  }

  const descriptionText = [task.goal, task.title, task.description, task.prompt]
    .filter((item) => typeof item === 'string')
    .join(' ');
  if (/图片|图像|插画|海报|绘图|生图|image|illustration/i.test(descriptionText)) {
    return true;
  }

  if (Array.isArray(task.attachments) && task.attachments.some(isImageAttachment)) {
    return true;
  }

  return false;
}

function normalizeSegment(segment) {
  return segment.normalize('NFC').toLowerCase();
}

function isSensitiveSegment(segment) {
  const normalized = normalizeSegment(segment);

  if (RESERVED_EXACT.has(normalized)) return true;
  if (TASK_CREDENTIAL_NAME.test(normalized)) return true;
  if (SENSITIVE_EXACT.has(normalized)) return true;
  return false;
}

function assertSafeOutput(rawOutput) {
  if (typeof rawOutput !== 'string') {
    fail('outputs must contain only strings');
  }
  if (rawOutput.length === 0) {
    fail('output path must not be empty');
  }
  if (rawOutput !== rawOutput.trim()) {
    fail(`output path must not have surrounding whitespace: ${JSON.stringify(rawOutput)}`);
  }
  if (rawOutput.includes('\0')) {
    fail('output path must not contain a NUL byte');
  }
  if (rawOutput.includes('\\')) {
    fail(`output path must use forward slashes: ${JSON.stringify(rawOutput)}`);
  }
  if (rawOutput.startsWith('/') || /^[A-Za-z]:/.test(rawOutput)) {
    fail(`output path must be relative: ${JSON.stringify(rawOutput)}`);
  }

  const segments = rawOutput.split('/');
  for (const segment of segments) {
    // Repeated separators are aliases; normalizeOutputs returns their single
    // canonical spelling before runtime ownership checks consume the plan.
    if (segment === '') continue;
    if (segment === '..') {
      fail(`output path must not contain "..": ${JSON.stringify(rawOutput)}`);
    }
    if (isSensitiveSegment(segment)) {
      fail(`output path uses a reserved or sensitive name: ${JSON.stringify(rawOutput)}`);
    }
  }
}

/**
 * The relative path used by runtime ownership checks, plus a case/NFC-folded
 * key used only for detecting conflicts on case-insensitive filesystems.
 */
function canonicalOutput(rawOutput) {
  const directory = rawOutput.endsWith('/');
  const withoutTrailing = rawOutput.replace(/\/+$/, '');
  const segments = withoutTrailing
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');

  const path = segments.join('/');
  const key = path.normalize('NFC').toLowerCase();
  if (key === '') {
    fail(`output path resolves to the workspace root: ${JSON.stringify(rawOutput)}`);
  }
  return { key, directory, path: path + (directory ? '/' : '') };
}

function pathsOverlap(a, b) {
  return a.key === b.key
    || a.key.startsWith(`${b.key}/`)
    || b.key.startsWith(`${a.key}/`);
}

function normalizeOutputs(rawOutputs, agent) {
  if (!Array.isArray(rawOutputs) || rawOutputs.length === 0) {
    fail(`assignments for ${agent} must include a non-empty outputs array`);
  }

  const outputs = [];
  const seen = new Set();
  for (const rawOutput of rawOutputs) {
    assertSafeOutput(rawOutput);
    const canonical = canonicalOutput(rawOutput);
    // Duplicate entries within one assignment are redundant, not a conflict.
    if (seen.has(canonical.key)) continue;
    seen.add(canonical.key);
    outputs.push(canonical.path);
  }
  return outputs;
}

function normalizeDependsOn(rawDependsOn, agent) {
  if (rawDependsOn === undefined) return undefined;
  if (!Array.isArray(rawDependsOn)) {
    fail(`dependsOn for ${agent} must be an array of agent names`);
  }

  const dependencies = [];
  const seen = new Set();
  for (const rawDependency of rawDependsOn) {
    const dependency = normalizeAgent(rawDependency);
    if (dependency === agent) {
      fail(`${agent} must not depend on itself`);
    }
    if (!seen.has(dependency)) {
      seen.add(dependency);
      dependencies.push(dependency);
    }
  }
  return dependencies.length > 0 ? dependencies : undefined;
}

function assertNoDependencyCycle(assignments) {
  const dependencies = new Map(assignments.map((assignment) => [
    assignment.agent,
    assignment.dependsOn ?? [],
  ]));
  const visiting = new Set();
  const visited = new Set();

  function visit(agent) {
    if (visiting.has(agent)) {
      fail(`circular dependsOn relationship involving ${agent}`);
    }
    if (visited.has(agent)) return;
    visiting.add(agent);
    for (const dependency of dependencies.get(agent) ?? []) {
      visit(dependency);
    }
    visiting.delete(agent);
    visited.add(agent);
  }

  for (const assignment of assignments) {
    visit(assignment.agent);
  }
}

/**
 * Validate and normalise a proposed cooperation plan.
 *
 * Accepts either `{assignments, notes}` or `{plan: {assignments, notes}}`.
 * Returns a fresh object with canonical relative output paths and normalised
 * agent names. Any rule violation throws an Error.
 */
export function normalizePlan(value, task = {}) {
  if (!isPlainObject(value)) {
    fail('plan must be a JSON object');
  }

  let plan = value;
  if (Object.prototype.hasOwnProperty.call(value, 'plan')) {
    if (!isPlainObject(value.plan)) {
      fail('plan must be a JSON object');
    }
    plan = value.plan;
  }

  if (!Array.isArray(plan.assignments)) {
    fail('plan.assignments must be an array');
  }
  if (plan.assignments.length !== AGENTS.length) {
    fail('plan must contain exactly two assignments, one for Codex and one for DSH');
  }

  const assignments = [];
  const byAgent = new Map();

  for (const rawAssignment of plan.assignments) {
    if (!isPlainObject(rawAssignment)) {
      fail('each assignment must be an object');
    }
    const agent = normalizeAgent(rawAssignment.agent);
    if (byAgent.has(agent)) {
      fail(`duplicate assignment for agent ${agent}`);
    }

    if (typeof rawAssignment.goal !== 'string' || rawAssignment.goal.trim() === '') {
      fail(`assignment for ${agent} must have a non-empty goal`);
    }
    const goal = rawAssignment.goal.trim();
    const outputs = normalizeOutputs(rawAssignment.outputs, agent);
    const dependsOn = normalizeDependsOn(rawAssignment.dependsOn, agent);

    const assignment = { agent, goal, outputs };
    if (dependsOn) assignment.dependsOn = dependsOn;

    byAgent.set(agent, assignment);
    assignments.push(assignment);
  }

  for (const agent of AGENTS) {
    if (!byAgent.has(agent)) {
      fail(`missing assignment for agent ${agent}`);
    }
  }

  // Cross-agent output conflicts: exact file equality, directory namespace
  // containment, and case/NFC-equivalent names all count as overlap.
  const codex = byAgent.get('Codex');
  const dsh = byAgent.get('DSH');
  if (task?.imageGeneration === true && !codex.outputs.includes('images/')) {
    fail('Codex must own the complete images/ namespace for an imageGeneration task');
  }
  for (const codexOutput of codex.outputs) {
    const left = canonicalOutput(codexOutput);
    for (const dshOutput of dsh.outputs) {
      const right = canonicalOutput(dshOutput);
      if (pathsOverlap(left, right)) {
        fail(
          `outputs overlap between agents: ${JSON.stringify(codexOutput)} and ${JSON.stringify(dshOutput)}`,
        );
      }
    }
  }

  assertNoDependencyCycle(assignments);

  const sourceNotes = typeof plan.notes === 'string'
    ? plan.notes
    : (typeof value.notes === 'string' ? value.notes : undefined);
  const notes = typeof sourceNotes === 'string' ? sourceNotes.trim() : '';

  const result = { assignments };
  if (notes !== '') result.notes = notes;
  return result;
}

/**
 * Deterministic fallback when the proposed plan is unusable. Outputs are
 * exclusive by construction. These defaults are implementation suggestions,
 * not claims about the user's intent.
 */
export function fallbackPlan(task = {}) {
  const imageTask = isImageTask(task);

  const codexAssignment = {
    agent: 'Codex',
    goal: imageTask
      ? 'Produce the requested image assets in images/.'
      : 'Produce the requested result in Codex-result.md.',
    outputs: imageTask ? ['images/'] : ['Codex-result.md'],
  };

  const dshAssignment = {
    agent: 'DSH',
    goal: imageTask
      ? 'Review Codex image assets and record findings in DSH-review.md.'
      : 'Review Codex result and record findings in DSH-review.md.',
    outputs: ['DSH-review.md'],
    dependsOn: ['Codex'],
  };

  return normalizePlan({ assignments: [codexAssignment, dshAssignment] }, task);
}
