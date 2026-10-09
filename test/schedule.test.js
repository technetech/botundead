import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleAt, nextOpening } from '../src/schedule.js';

test('every two hours at :25, closing 90 minutes later with a 30 minute gap', () => {
  for (let hour = 0; hour < 24; hour += 2) {
    const date = new Date(Date.UTC(2026, 9, 9, hour + 6, 25));
    const cycle = cycleAt(date);
    assert.equal(cycle.open, hour * 3600 + 1500);
    assert.equal(cycle.close, (hour + 1) * 3600 + 3300);
    assert.equal(cycle.key, `2026-10-09T${String(hour).padStart(2, '0')}:25`);
    const next = new Date(nextOpening(date));
    assert.equal(next.getTime() - date.getTime(), 2 * 3600000);
    assert.equal(next.getTime() - (date.getTime() + 90 * 60000), 30 * 60000);
  }
});

test('next opening handles just before :25 and midnight in Monterrey', () => {
  assert.equal(nextOpening(new Date('2026-10-09T14:24:59Z')), '2026-10-09T14:25:00.000Z');
  assert.equal(nextOpening(new Date('2026-10-10T05:55:00Z')), '2026-10-10T06:25:00.000Z');
});
