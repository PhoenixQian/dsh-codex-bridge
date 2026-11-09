const MEANINGFUL_TYPES = new Set([
  'user-message',
  'agent-message',
  'created',
  'plan',
  'approval-requested',
  'approval-decided',
  'delivered',
  'cancelled',
  'archived',
  'unarchived',
  'tool',
]);

const WORKER_MEANINGFUL_TYPES = new Set([
  'tool-started',
  'tool-completed',
  'file',
  'progress',
  'approval-requested',
  'approval-decided',
  'ready',
  'error',
]);

const ACTIVITY_FIELDS = ['lastActivityAt', 'updatedAt', 'createdAt'];

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function isValidTimestamp(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * Resolve the timestamp that represents a row's activity.
 * Prefers lastActivityAt, then updatedAt, then createdAt; returns '' when
 * no valid timestamp is available.
 */
export function activityTime(row) {
  if (!isObject(row)) return '';
  for (const field of ACTIVITY_FIELDS) {
    const value = row[field];
    if (!isValidTimestamp(value)) continue;
    return value instanceof Date ? value.toISOString() : value;
  }
  return '';
}

function timeValue(row) {
  const value = activityTime(row);
  return value === '' ? 0 : Date.parse(value);
}

function compareIdDescending(a, b) {
  const left = a === null || a === undefined ? '' : String(a);
  const right = b === null || b === undefined ? '' : String(b);
  if (left === right) return 0;
  // Numeric-looking ids compare numerically; the final sign makes the
  // comparison descending.
  if (/^-?\d+$/.test(left) && /^-?\d+$/.test(right)) {
    return Number(right) - Number(left);
  }
  return right.localeCompare(left, undefined, { numeric: true });
}

function isArchived(row) {
  if (!isObject(row)) return false;
  return Boolean(row.archivedAt) || row.status === 'archived';
}

/**
 * Filter, order and page activity rows without mutating the input.
 * Ordering is activity time descending, then id descending for equal times,
 * with the original order as the final stable tie-breaker.
 */
export function paginateActivity(rows, { limit = 10, archived } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('limit must be an integer between 1 and 1000');
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  let filtered = rows;
  if (archived === true) {
    filtered = rows.filter(isArchived);
  } else if (archived === false) {
    filtered = rows.filter((row) => !isArchived(row));
  }

  const ordered = filtered.map((item, index) => ({
    item,
    index,
    time: timeValue(item),
    id: isObject(item) ? item.id : undefined,
  }));
  ordered.sort(
    (left, right) =>
      right.time - left.time ||
      compareIdDescending(left.id, right.id) ||
      left.index - right.index,
  );

  const total = ordered.length;
  return {
    items: ordered.slice(0, limit).map((entry) => entry.item),
    hasMore: total > limit,
    total,
    limit,
  };
}

function nestedEventType(event) {
  for (const key of ['event', 'data', 'payload']) {
    const nested = event[key];
    if (isObject(nested) && typeof nested.type === 'string') return nested.type;
  }
  return '';
}

/**
 * Decide whether an event should count as meaningful activity.
 * The decision is made from event types only, never from message bodies.
 */
export function meaningfulActivity(event) {
  if (!isObject(event) || typeof event.type !== 'string') return false;
  if (MEANINGFUL_TYPES.has(event.type)) return true;
  if (event.type === 'worker') {
    return WORKER_MEANINGFUL_TYPES.has(nestedEventType(event));
  }
  return false;
}
