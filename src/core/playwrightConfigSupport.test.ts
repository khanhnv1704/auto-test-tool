import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensurePlaywrightConfig } from './playwrightConfigSupport';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-pwconfig-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('ensurePlaywrightConfig', () => {
  it('scaffolds playwright.config.ts with the api/ui projects when the workspace has none', () => {
    const workspaceRoot = makeTmpDir();
    const targetPath = ensurePlaywrightConfig(workspaceRoot);

    expect(targetPath).toBe(path.join(workspaceRoot, 'playwright.config.ts'));
    expect(fs.existsSync(targetPath)).toBe(true);

    const content = fs.readFileSync(targetPath, 'utf-8');
    expect(content).toContain("name: 'api'");
    expect(content).toContain("name: 'ui'");
  });

  it('excludes generated/_stale/ from testMatch (regression: files moved there have relative imports one level off; a load error would abort the whole run with 0 tests)', () => {
    const workspaceRoot = makeTmpDir();
    const content = fs.readFileSync(ensurePlaywrightConfig(workspaceRoot), 'utf-8');

    const testMatchLines = content.match(/testMatch:.*$/gm) ?? [];
    expect(testMatchLines.length).toBe(2);
    for (const line of testMatchLines) {
      expect(line).toContain('_stale');
    }
  });

  it('wires slowMo from AITEST_SLOW_MO so Run Tests can run slowly enough to follow (there is no CLI flag for slowMo)', () => {
    const workspaceRoot = makeTmpDir();
    const content = fs.readFileSync(ensurePlaywrightConfig(workspaceRoot), 'utf-8');

    expect(content).toContain('AITEST_SLOW_MO');
    // Both projects need it — the API lane still uses `page` to render and capture evidence.
    expect(content.match(/launchOptions: \{ slowMo \}/g)).toHaveLength(2);
  });

  it('wires baseURL from AITEST_WEB_BASE_URL/AITEST_API_BASE_URL per project — generated scripts now use relative paths, Playwright must supply the base (see toRelativePath in testSuiteGenerator.ts)', () => {
    const workspaceRoot = makeTmpDir();
    const content = fs.readFileSync(ensurePlaywrightConfig(workspaceRoot), 'utf-8');

    expect(content).toContain('AITEST_WEB_BASE_URL');
    expect(content).toContain('AITEST_API_BASE_URL');
    expect(content).toContain('baseURL: webBaseUrl');
    expect(content).toContain('baseURL: apiBaseUrl');
  });

  it('does not overwrite an existing playwright.config.ts', () => {
    const workspaceRoot = makeTmpDir();
    const targetPath = path.join(workspaceRoot, 'playwright.config.ts');
    fs.writeFileSync(targetPath, '// custom user config');

    ensurePlaywrightConfig(workspaceRoot);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('// custom user config');
  });

  it('does not overwrite an existing playwright.config.js', () => {
    const workspaceRoot = makeTmpDir();
    const jsPath = path.join(workspaceRoot, 'playwright.config.js');
    fs.writeFileSync(jsPath, '// custom user config (js)');

    const targetPath = ensurePlaywrightConfig(workspaceRoot);
    expect(targetPath).toBe(jsPath);
    expect(fs.readFileSync(jsPath, 'utf-8')).toBe('// custom user config (js)');
    expect(fs.existsSync(path.join(workspaceRoot, 'playwright.config.ts'))).toBe(false);
  });
});
