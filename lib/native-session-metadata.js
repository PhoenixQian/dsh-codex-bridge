import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const failure = code => Object.assign(new Error(code), { code });

/** DSH uses immutable header.cwd for history access and explicit workspace accounting. */
export function createNativeSessionMetadata({ ctx, directory }) {
  let pending;
  async function workspace() {
    if (!pending) pending = (async () => {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry;
      if (typeof registry?.create !== 'function') throw failure('HOST_WORKSPACE_UNAVAILABLE');
      const path = join(directory, 'discussion-workspace');
      await mkdir(path, { recursive: true, mode: 0o700 });
      const cwd = await realpath(path);
      const owner = await registry.create(cwd, '同舟');
      if (typeof owner?.attachSession !== 'function') throw failure('HOST_WORKSPACE_UNAVAILABLE');
      return { cwd, owner };
    })().catch(error => { pending = undefined; throw error; });
    return pending;
  }
  function validate(session, cwd) {
    if (!session.header?.cwd) throw failure('HOST_SESSION_MIGRATION_REQUIRED');
    if (session.header.cwd !== cwd) throw failure('HOST_SESSION_WORKSPACE_CONFLICT');
  }
  function ensureTitle(session, displayTitle, SessionSeq) {
    for (let n = 0; n < session.seq; n++) if (session.eventAt(SessionSeq(n))?.type === 'session/title') return;
    // The user authorizes Tongzhou to use the topic as its display title. This
    // matches native rename; it never adds or rewrites a human/Agent message.
    // DSH's cold codec requires every non-user title to cite human input,
    // which an Agent-only discussion deliberately does not fabricate.
    session.append('session/title', {
      title: `同舟讨论 ${String(displayTitle).replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 160)}`,
      messageSeqs: [], source: { kind: 'user' }
    });
  }
  return { workspace, validate, ensureTitle };
}
