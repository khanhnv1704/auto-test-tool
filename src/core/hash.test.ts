import { describe, it, expect } from 'vitest';
import { sha256, diffByHash } from './hash';

describe('sha256', () => {
  it('is deterministic for the same content', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
  });

  it('differs for different content', () => {
    expect(sha256('hello')).not.toBe(sha256('world'));
  });

  it('ignores surrounding whitespace', () => {
    expect(sha256('hello')).toBe(sha256('  hello  \n'));
  });
});

describe('diffByHash', () => {
  it('marks unseen items as changed', () => {
    const { changedKeys, unchangedKeys } = diffByHash([{ key: 'a', raw: 'content-a' }], {});
    expect(changedKeys).toEqual(['a']);
    expect(unchangedKeys).toEqual([]);
  });

  it('marks items with a matching previous hash as unchanged', () => {
    const first = diffByHash([{ key: 'a', raw: 'content-a' }], {});
    const second = diffByHash([{ key: 'a', raw: 'content-a' }], first.newHashes);
    expect(second.unchangedKeys).toEqual(['a']);
    expect(second.changedKeys).toEqual([]);
  });

  it('marks an item as changed when its content changes, even with a previous hash present', () => {
    const first = diffByHash([{ key: 'a', raw: 'content-a' }], {});
    const second = diffByHash([{ key: 'a', raw: 'content-a-modified' }], first.newHashes);
    expect(second.changedKeys).toEqual(['a']);
    expect(second.unchangedKeys).toEqual([]);
  });

  it('diffs each item independently by key', () => {
    const first = diffByHash(
      [
        { key: 'a', raw: 'content-a' },
        { key: 'b', raw: 'content-b' }
      ],
      {}
    );
    const second = diffByHash(
      [
        { key: 'a', raw: 'content-a-modified' },
        { key: 'b', raw: 'content-b' }
      ],
      first.newHashes
    );
    expect(second.changedKeys).toEqual(['a']);
    expect(second.unchangedKeys).toEqual(['b']);
  });
});
