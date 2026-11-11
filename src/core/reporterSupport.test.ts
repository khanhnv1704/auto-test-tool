import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeReporter } from './reporterSupport';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-reporter-support-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('writeReporter', () => {
  it('copies the reporter template into <generatedDir>/support/liveReporter.js', () => {
    const generatedDir = makeTmpDir();
    const targetPath = writeReporter(generatedDir);

    expect(targetPath).toBe(path.join(generatedDir, 'support', 'liveReporter.js'));
    const content = fs.readFileSync(targetPath, 'utf-8');
    expect(content).toContain('class LiveReporter');
    expect(content).toContain('module.exports = LiveReporter');
  });
});
