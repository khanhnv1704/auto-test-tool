import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeEvidenceSupport } from './evidenceSupport';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-evidence-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('writeEvidenceSupport', () => {
  it('copies the evidence template into <generatedDir>/support/evidence.ts', () => {
    const generatedDir = makeTmpDir();
    const targetPath = writeEvidenceSupport(generatedDir);

    expect(targetPath).toBe(path.join(generatedDir, 'support', 'evidence.ts'));
    expect(fs.existsSync(targetPath)).toBe(true);

    const content = fs.readFileSync(targetPath, 'utf-8');
    expect(content).toContain('export async function captureUiEvidence');
    expect(content).toContain('export async function captureApiEvidence');
    expect(content).toContain('export function renderApiEvidenceHtml');
  });

  it('overwrites an existing copy on re-generate', () => {
    const generatedDir = makeTmpDir();
    const targetPath = writeEvidenceSupport(generatedDir);
    fs.writeFileSync(targetPath, '// stale content');

    writeEvidenceSupport(generatedDir);
    expect(fs.readFileSync(targetPath, 'utf-8')).toContain('export async function captureUiEvidence');
  });
});
