export const VALID_STATUS = ['inbox', 'assigned', 'in_progress', 'review', 'blocked', 'done'];
export const VALID_OWNER = ['ultron', 'codi', 'scout'];
export const VALID_PRIORITY = ['p0', 'p1', 'p2', 'p3'];

export function validateTaskCreate(input = {}) {
  const errors = [];
  if (!input.title || typeof input.title !== 'string' || input.title.trim().length < 3) {
    errors.push('title must be a string of at least 3 chars');
  }
  if (input.owner && !VALID_OWNER.includes(input.owner)) errors.push('owner is invalid');
  if (input.status && !VALID_STATUS.includes(input.status)) errors.push('status is invalid');
  if (input.priority && !VALID_PRIORITY.includes(input.priority)) errors.push('priority is invalid');
  return { ok: errors.length === 0, errors };
}

export function validateTaskUpdate(input = {}) {
  const errors = [];
  if (!input.id || typeof input.id !== 'string') errors.push('id is required');
  if (input.owner && !VALID_OWNER.includes(input.owner)) errors.push('owner is invalid');
  if (input.status && !VALID_STATUS.includes(input.status)) errors.push('status is invalid');
  if (input.priority && !VALID_PRIORITY.includes(input.priority)) errors.push('priority is invalid');
  return { ok: errors.length === 0, errors };
}
