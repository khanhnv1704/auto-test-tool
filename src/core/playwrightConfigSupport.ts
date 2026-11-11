import * as fs from 'fs';
import * as path from 'path';

/**
 * Runs need a config with "api"/"ui" projects; without one the Playwright CLI fails before printing JSON
 * and runTests() gets empty stdout and a confusing error. If the workspace has no
 * playwright.config.(ts|js), scaffold the default one so "Run Tests" works out of the box.
 * An existing config is never overwritten — the user may have customized it (baseURL, webServer, ...).
 */
export function ensurePlaywrightConfig(workspaceRoot: string): string {
  const existing = ['playwright.config.ts', 'playwright.config.js'].find((f) => fs.existsSync(path.join(workspaceRoot, f)));
  const targetPath = path.join(workspaceRoot, existing ?? 'playwright.config.ts');
  if (existing) return targetPath;

  const templatePath = path.join(__dirname, '..', '..', 'templates', 'playwright.config.ts');
  fs.copyFileSync(templatePath, targetPath);
  return targetPath;
}
