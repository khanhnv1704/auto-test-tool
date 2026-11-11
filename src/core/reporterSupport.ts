import * as fs from 'fs';
import * as path from 'path';

/**
 * Copies templates/liveReporter.js to <generatedDir>/support/liveReporter.js, overwriting on every
 * generate. testRunner.ts passes it to Playwright via `--reporter` to get each test's live
 * pass/fail/running status without waiting for the whole run.
 */
export function writeReporter(generatedDir: string): string {
  const targetDir = path.join(generatedDir, 'support');
  fs.mkdirSync(targetDir, { recursive: true });

  const templatePath = path.join(__dirname, '..', '..', 'templates', 'liveReporter.js');
  const targetPath = path.join(targetDir, 'liveReporter.js');
  fs.copyFileSync(templatePath, targetPath);
  return targetPath;
}
