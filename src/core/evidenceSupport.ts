import * as fs from 'fs';
import * as path from 'path';

export const EVIDENCE_SUPPORT_RELATIVE_PATH = path.join('support', 'evidence.ts');

/**
 * Copies templates/evidence.ts to <generatedDir>/support/evidence.ts, overwriting on every generate so
 * generated scripts always import the latest helper. The highlight/capture logic is not left to the AI,
 * which would be error-prone and inconsistent across calls.
 */
export function writeEvidenceSupport(generatedDir: string): string {
  const targetDir = path.join(generatedDir, 'support');
  fs.mkdirSync(targetDir, { recursive: true });

  const templatePath = path.join(__dirname, '..', '..', 'templates', 'evidence.ts');
  const targetPath = path.join(targetDir, 'evidence.ts');
  fs.copyFileSync(templatePath, targetPath);
  return targetPath;
}
