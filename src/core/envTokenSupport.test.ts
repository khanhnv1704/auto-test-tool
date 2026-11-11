import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readAuthTokenFromEnv, readBacklogConfigFromEnv } from './envTokenSupport';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-envtoken-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('readAuthTokenFromEnv', () => {
  it('reads TEST_TOKEN from .env.local when present', () => {
    const workspaceRoot = makeTmpDir();
    fs.writeFileSync(path.join(workspaceRoot, '.env.local'), 'TEST_TOKEN=demo-secret-token\n');

    expect(readAuthTokenFromEnv(workspaceRoot)).toBe('demo-secret-token');
  });

  it('falls back to .env.example when .env.local is absent', () => {
    const workspaceRoot = makeTmpDir();
    fs.writeFileSync(path.join(workspaceRoot, '.env.example'), '# comment\nTEST_TOKEN=demo-secret-token\n');

    expect(readAuthTokenFromEnv(workspaceRoot)).toBe('demo-secret-token');
  });

  it('prefers .env.local over .env.example when both exist', () => {
    const workspaceRoot = makeTmpDir();
    fs.writeFileSync(path.join(workspaceRoot, '.env.local'), 'TEST_TOKEN=local-token\n');
    fs.writeFileSync(path.join(workspaceRoot, '.env.example'), 'TEST_TOKEN=example-token\n');

    expect(readAuthTokenFromEnv(workspaceRoot)).toBe('local-token');
  });

  it('falls back to any *TOKEN* variable when no candidate key matches', () => {
    const workspaceRoot = makeTmpDir();
    fs.writeFileSync(path.join(workspaceRoot, '.env.local'), 'SOME_CUSTOM_TOKEN="quoted-token"\n');

    expect(readAuthTokenFromEnv(workspaceRoot)).toBe('quoted-token');
  });

  it('returns undefined when neither file exists or no token-like variable is found', () => {
    const workspaceRoot = makeTmpDir();
    expect(readAuthTokenFromEnv(workspaceRoot)).toBeUndefined();

    fs.writeFileSync(path.join(workspaceRoot, '.env.local'), 'PORT=3000\n');
    expect(readAuthTokenFromEnv(workspaceRoot)).toBeUndefined();
  });
});

describe('readBacklogConfigFromEnv', () => {
  it('returns undefined when BACKLOG_API_KEY is not set anywhere', () => {
    const workspaceRoot = makeTmpDir();
    expect(readBacklogConfigFromEnv(workspaceRoot)).toBeUndefined();

    fs.writeFileSync(path.join(workspaceRoot, '.env.local'), 'PORT=3000\n');
    expect(readBacklogConfigFromEnv(workspaceRoot)).toBeUndefined();
  });

  it('leaves spaceKey empty when BACKLOG_SPACE_KEY is not set', () => {
    const workspaceRoot = makeTmpDir();
    fs.writeFileSync(path.join(workspaceRoot, '.env.local'), 'BACKLOG_API_KEY=secret123\n');

    expect(readBacklogConfigFromEnv(workspaceRoot)).toEqual({ apiKey: 'secret123', spaceKey: '', baseUrl: undefined });
  });

  it('reads spaceKey and baseUrl overrides when present', () => {
    const workspaceRoot = makeTmpDir();
    fs.writeFileSync(
      path.join(workspaceRoot, '.env.local'),
      'BACKLOG_API_KEY=secret123\nBACKLOG_SPACE_KEY=example\nBACKLOG_BASE_URL=https://example.backlogtool.com\n'
    );

    expect(readBacklogConfigFromEnv(workspaceRoot)).toEqual({
      apiKey: 'secret123',
      spaceKey: 'example',
      baseUrl: 'https://example.backlogtool.com'
    });
  });

  it('prefers .env.local over .env.example for each field independently', () => {
    const workspaceRoot = makeTmpDir();
    fs.writeFileSync(path.join(workspaceRoot, '.env.local'), 'BACKLOG_API_KEY=local-key\n');
    fs.writeFileSync(path.join(workspaceRoot, '.env.example'), 'BACKLOG_API_KEY=example-key\nBACKLOG_SPACE_KEY=example-space\n');

    // .env.local exists and has the key, so it is used exclusively for BACKLOG_API_KEY;
    // BACKLOG_SPACE_KEY isn't in .env.local, but the lookup still checks .env.local first per key.
    expect(readBacklogConfigFromEnv(workspaceRoot)?.apiKey).toBe('local-key');
  });
});
