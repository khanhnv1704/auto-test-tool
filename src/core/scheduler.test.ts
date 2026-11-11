import { describe, it, expect } from 'vitest';
import { computeNextFireTime } from './scheduler';
import { Schedule } from '../types';

function schedule(partial: Partial<Schedule>): Schedule {
  return { id: 's1', functionId: 'F1', type: 'daily', time: '09:00', nextFireAt: '', ...partial };
}

describe('computeNextFireTime', () => {
  describe('once', () => {
    it('returns the target date/time when it is still in the future', () => {
      const from = new Date(2026, 0, 1, 8, 0);
      const result = computeNextFireTime(schedule({ type: 'once', date: '2026-01-02', time: '09:00' }), from);
      expect(result).toEqual(new Date(2026, 0, 2, 9, 0));
    });

    it('returns undefined when the target date/time has already passed', () => {
      const from = new Date(2026, 0, 5, 8, 0);
      const result = computeNextFireTime(schedule({ type: 'once', date: '2026-01-02', time: '09:00' }), from);
      expect(result).toBeUndefined();
    });
  });

  describe('daily', () => {
    it('fires today if the time has not passed yet', () => {
      const from = new Date(2026, 0, 1, 7, 0);
      const result = computeNextFireTime(schedule({ type: 'daily', time: '09:00' }), from);
      expect(result).toEqual(new Date(2026, 0, 1, 9, 0));
    });

    it('rolls over to tomorrow if the time has already passed today', () => {
      const from = new Date(2026, 0, 1, 10, 0);
      const result = computeNextFireTime(schedule({ type: 'daily', time: '09:00' }), from);
      expect(result).toEqual(new Date(2026, 0, 2, 9, 0));
    });
  });

  describe('weekly', () => {
    it('picks the next occurrence of the given day-of-week, later this week', () => {
      // 2026-01-01 is a Thursday (day 4); target Monday (day 1) -> 2026-01-05
      const from = new Date(2026, 0, 1, 8, 0);
      const result = computeNextFireTime(schedule({ type: 'weekly', dayOfWeek: 1, time: '09:00' }), from);
      expect(result).toEqual(new Date(2026, 0, 5, 9, 0));
    });

    it('wraps to next week when today matches but the time has already passed', () => {
      // 2026-01-01 is Thursday (day 4)
      const from = new Date(2026, 0, 1, 10, 0);
      const result = computeNextFireTime(schedule({ type: 'weekly', dayOfWeek: 4, time: '09:00' }), from);
      expect(result).toEqual(new Date(2026, 0, 8, 9, 0));
    });

    it('fires later today when today matches and the time has not passed yet', () => {
      const from = new Date(2026, 0, 1, 8, 0);
      const result = computeNextFireTime(schedule({ type: 'weekly', dayOfWeek: 4, time: '09:00' }), from);
      expect(result).toEqual(new Date(2026, 0, 1, 9, 0));
    });
  });

  describe('monthly', () => {
    it('fires this month if the day/time has not passed yet', () => {
      const from = new Date(2026, 0, 1, 8, 0);
      const result = computeNextFireTime(schedule({ type: 'monthly', dayOfMonth: 15, time: '09:00' }), from);
      expect(result).toEqual(new Date(2026, 0, 15, 9, 0));
    });

    it('rolls over to next month if the day has already passed this month', () => {
      const from = new Date(2026, 0, 20, 8, 0);
      const result = computeNextFireTime(schedule({ type: 'monthly', dayOfMonth: 15, time: '09:00' }), from);
      expect(result).toEqual(new Date(2026, 1, 15, 9, 0));
    });

    it('clamps dayOfMonth 31 to the last day of a shorter month (February)', () => {
      const from = new Date(2026, 1, 20, 8, 0); // already in February, day 31 doesn't exist
      const result = computeNextFireTime(schedule({ type: 'monthly', dayOfMonth: 31, time: '09:00' }), from);
      // 2026 is not a leap year -> Feb has 28 days, and Feb 28 09:00 is still ahead of Feb 20 08:00
      expect(result).toEqual(new Date(2026, 1, 28, 9, 0));
    });

    it('wraps year over when rolling from December to January', () => {
      const from = new Date(2026, 11, 20, 8, 0);
      const result = computeNextFireTime(schedule({ type: 'monthly', dayOfMonth: 15, time: '09:00' }), from);
      expect(result).toEqual(new Date(2027, 0, 15, 9, 0));
    });
  });
});
