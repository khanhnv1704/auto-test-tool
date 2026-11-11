import { Schedule } from '../types';

function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of next month is the last day of this month.
  return new Date(year, month + 1, 0).getDate();
}

function atTime(base: Date, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const d = new Date(base);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/**
 * Computes a schedule's next fire time after `from` (usually now). Pure function; called after each fire
 * and when re-arming schedules after VS Code reloads.
 *
 * `undefined` means a 'once' schedule is already in the past — the caller should remove it rather than
 * reschedule.
 *
 * A dayOfMonth beyond the month's length (e.g. 31 in February) is clamped to the last day of that month,
 * like OS calendars do, rather than skipping the month.
 */
export function computeNextFireTime(schedule: Schedule, from: Date): Date | undefined {
  switch (schedule.type) {
    case 'once': {
      if (!schedule.date) return undefined;
      const [year, month, day] = schedule.date.split('-').map(Number);
      const target = atTime(new Date(year, month - 1, day), schedule.time);
      return target.getTime() > from.getTime() ? target : undefined;
    }

    case 'daily': {
      let target = atTime(from, schedule.time);
      if (target.getTime() <= from.getTime()) {
        target = new Date(target);
        target.setDate(target.getDate() + 1);
      }
      return target;
    }

    case 'weekly': {
      const dayOfWeek = schedule.dayOfWeek ?? from.getDay();
      let target = atTime(from, schedule.time);
      let daysUntil = (dayOfWeek - target.getDay() + 7) % 7;
      if (daysUntil === 0 && target.getTime() <= from.getTime()) daysUntil = 7;
      target = new Date(target);
      target.setDate(target.getDate() + daysUntil);
      return target;
    }

    case 'monthly': {
      const dayOfMonth = schedule.dayOfMonth ?? from.getDate();
      const tryMonth = (year: number, month: number): Date => {
        const day = Math.min(dayOfMonth, lastDayOfMonth(year, month));
        return atTime(new Date(year, month, day), schedule.time);
      };

      let target = tryMonth(from.getFullYear(), from.getMonth());
      if (target.getTime() <= from.getTime()) {
        const nextMonth = from.getMonth() + 1;
        target = tryMonth(from.getFullYear() + Math.floor(nextMonth / 12), nextMonth % 12);
      }
      return target;
    }

    default:
      return undefined;
  }
}
