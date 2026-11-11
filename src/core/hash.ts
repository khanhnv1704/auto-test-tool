import { createHash } from 'crypto';
import { HashDiff } from '../types';

export function sha256(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

interface HashableItem {
  key: string;
  raw: string;
}

/**
 * Compares each item's (endpoint/test case) hash with the previous run's hash for the same key.
 * Core change detection: only items whose content actually changed are marked "changed".
 */
export function diffByHash(items: HashableItem[], previousHashes: Record<string, string>): HashDiff {
  const changedKeys: string[] = [];
  const unchangedKeys: string[] = [];
  const newHashes: Record<string, string> = {};

  for (const item of items) {
    const hash = sha256(item.raw);
    newHashes[item.key] = hash;

    if (previousHashes[item.key] === hash) {
      unchangedKeys.push(item.key);
    } else {
      changedKeys.push(item.key);
    }
  }

  return { changedKeys, unchangedKeys, newHashes };
}
