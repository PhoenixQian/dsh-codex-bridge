import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activityTime,
  paginateActivity,
  meaningfulActivity,
} from '../server/activity.mjs';

const row = (id, extra = {}) => ({ id, ...extra });

test('activityTime prefers valid lastActivityAt, then updatedAt, then createdAt', () => {
  const all = row('a', {
    lastActivityAt: '2026-02-03T10:00:00.000Z',
    updatedAt: '2026-02-02T10:00:00.000Z',
    createdAt: '2026-02-01T10:00:00.000Z',
  });
  assert.equal(activityTime(all), '2026-02-03T10:00:00.000Z');
  assert.equal(
    activityTime(row('b', {
      lastActivityAt: 'not-a-date',
      updatedAt: '2026-02-02T10:00:00.000Z',
      createdAt: '2026-02-01T10:00:00.000Z',
    })),
    '2026-02-02T10:00:00.000Z',
  );
  assert.equal(
    activityTime(row('c', {
      lastActivityAt: '',
      updatedAt: null,
      createdAt: '2026-02-01T10:00:00.000Z',
    })),
    '2026-02-01T10:00:00.000Z',
  );
  assert.equal(activityTime(row('d', { lastActivityAt: 'nope' })), '');
  assert.equal(activityTime(row('e')), '');
  assert.equal(activityTime(null), '');
  assert.equal(activityTime(undefined), '');
});

test('paginateActivity sorts by activity time desc and id desc for ties', () => {
  const rows = [
    row('b', { lastActivityAt: '2026-01-02T00:00:00.000Z' }),
    row('a', { lastActivityAt: '2026-01-02T00:00:00.000Z' }),
    row('c', { lastActivityAt: '2026-01-03T00:00:00.000Z' }),
    row('d', { createdAt: '2026-01-01T00:00:00.000Z' }),
  ];
  const result = paginateActivity(rows, { limit: 2 });
  assert.equal(result.limit, 2);
  assert.equal(result.total, 4);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.items.map((r) => r.id), ['c', 'b']);
  assert.equal(result.items[0], rows[2], 'items keep original object identity');
  assert.equal(result.items[1], rows[0], 'items keep original object identity');
});

test('paginateActivity pages 10 -> 20 with hasMore', () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    row(`r${String(i).padStart(2, '0')}`, {
      lastActivityAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }));
  const first = paginateActivity(rows, { limit: 10 });
  assert.equal(first.items.length, 10);
  assert.equal(first.total, 25);
  assert.equal(first.hasMore, true);
  assert.equal(first.items[0].id, 'r24');
  assert.equal(first.items[9].id, 'r15');

  const expanded = paginateActivity(rows, { limit: 20 });
  assert.equal(expanded.items.length, 20);
  assert.equal(expanded.limit, 20);
  assert.equal(expanded.total, 25);
  assert.equal(expanded.hasMore, true);
  assert.deepEqual(
    expanded.items.slice(0, 10).map((r) => r.id),
    first.items.map((r) => r.id),
    'expanded page keeps a stable prefix',
  );

  const done = paginateActivity(rows, { limit: 1000 });
  assert.equal(done.items.length, 25);
  assert.equal(done.hasMore, false);
});

test('paginateActivity filters archived when requested', () => {
  const rows = [
    row('open1', { lastActivityAt: '2026-01-01T00:00:00.000Z' }),
    row('arch1', { lastActivityAt: '2026-01-02T00:00:00.000Z', archivedAt: '2026-01-05T00:00:00.000Z' }),
    row('arch2', { lastActivityAt: '2026-01-03T00:00:00.000Z', status: 'archived' }),
    row('open2', { lastActivityAt: '2026-01-04T00:00:00.000Z', status: 'active' }),
  ];
  const archived = paginateActivity(rows, { archived: true });
  assert.deepEqual(archived.items.map((r) => r.id), ['arch2', 'arch1']);
  assert.equal(archived.total, 2);
  assert.equal(archived.hasMore, false);

  const active = paginateActivity(rows, { archived: false });
  assert.deepEqual(active.items.map((r) => r.id), ['open2', 'open1']);

  const all = paginateActivity(rows);
  assert.equal(all.items.length, 4);
});

test('paginateActivity does not mutate input and validates limit', () => {
  const rows = [
    row('b', { lastActivityAt: '2026-01-02T00:00:00.000Z' }),
    row('a', { lastActivityAt: '2026-01-02T00:00:00.000Z' }),
  ];
  const snapshot = JSON.stringify(rows);
  paginateActivity(rows, { limit: 1 });
  assert.equal(JSON.stringify(rows), snapshot);
  assert.equal(rows[0].id, 'b');
  assert.equal(rows[1].id, 'a');

  for (const bad of [0, -1, 1.5, 1001, NaN, Infinity, '10', null, true]) {
    assert.throws(() => paginateActivity(rows, { limit: bad }), /limit/i, `limit=${String(bad)}`);
  }
  assert.equal(paginateActivity(rows, { limit: 1 }).items.length, 1);
  assert.equal(paginateActivity(rows, { limit: 1000 }).items.length, 2);
  assert.equal(paginateActivity([], {}).total, 0);
  assert.equal(paginateActivity([], { limit: undefined }).limit, 10);
});

test('meaningfulActivity accepts real activity types', () => {
  for (const type of [
    'user-message', 'agent-message', 'created', 'plan',
    'approval-requested', 'approval-decided', 'delivered',
    'cancelled', 'archived', 'unarchived', 'tool',
  ]) {
    assert.equal(meaningfulActivity({ type }), true, type);
    assert.equal(meaningfulActivity({ type, text: '' }), true, `${type} empty text`);
  }
});

test('meaningfulActivity rejects heartbeat, poll, token, usage, connection and unknown', () => {
  for (const type of ['heartbeat', 'poll', 'token', 'usage', 'connection', 'noise', '', undefined]) {
    assert.equal(meaningfulActivity({ type }), false, String(type));
  }
  assert.equal(meaningfulActivity({ type: 'token', text: 'lots of tokens' }), false);
  assert.equal(meaningfulActivity({}), false);
  assert.equal(meaningfulActivity(null), false);
});

test('worker activity depends on nested event type', () => {
  for (const type of ['tool-started', 'tool-completed', 'file', 'progress',
    'approval-requested', 'approval-decided', 'ready', 'error']) {
    assert.equal(meaningfulActivity({ type: 'worker', event: { type } }), true, type);
  }
  for (const type of ['heartbeat', 'poll', 'token', 'usage', 'connection', 'delta', 'tool', '']) {
    assert.equal(meaningfulActivity({ type: 'worker', event: { type } }), false, type);
  }
  assert.equal(meaningfulActivity({ type: 'worker' }), false);
  assert.equal(
    meaningfulActivity({ type: 'native', event: { type: 'token' } }),
    false,
    'native token stream is not activity',
  );
  assert.equal(meaningfulActivity({ type: 'native' }), false);
});

test('meaningfulActivity does not judge on non-empty body', () => {
  assert.equal(meaningfulActivity({ type: 'heartbeat', text: 'hello' }), false);
  assert.equal(meaningfulActivity({ type: 'unknown', text: 'hello' }), false);
  assert.equal(meaningfulActivity({ type: 'worker', event: { type: 'token' }, text: 'x' }), false);
});
