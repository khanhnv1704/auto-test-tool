import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'child_process';
import { parseReport, buildPlaywrightArgs, runTests } from './testRunner';

describe('buildPlaywrightArgs', () => {
  it('omits --workers when not given, letting Playwright auto-pick based on CPU count', () => {
    const args = buildPlaywrightArgs(['.aitest/functions/F1/generated']);
    expect(args).not.toContain('--workers');
  });

  it('adds --workers <n> to run testcases across multiple parallel workers', () => {
    const args = buildPlaywrightArgs(['.aitest/functions/F1/generated'], 8);
    expect(args).toContain('--workers');
    expect(args[args.indexOf('--workers') + 1]).toBe('8');
  });

  it('ignores a workers value of 0 or negative', () => {
    expect(buildPlaywrightArgs(['dir'], 0)).not.toContain('--workers');
    expect(buildPlaywrightArgs(['dir'], -1)).not.toContain('--workers');
  });

  it('never passes --project — project selection is now done via testMatch per function, not per run', () => {
    const args = buildPlaywrightArgs(['dir']);
    expect(args).not.toContain('--project');
  });

  it('uses plain "json" reporter when no live reporter path is given', () => {
    const args = buildPlaywrightArgs(['dir']);
    expect(args[args.indexOf('--reporter') + 1]).toBe('json');
  });

  it('adds the custom live reporter alongside json when a path is given', () => {
    const args = buildPlaywrightArgs(['dir'], undefined, '/ws/.aitest/functions/F1/generated/support/liveReporter.js');
    expect(args[args.indexOf('--reporter') + 1]).toBe('json,/ws/.aitest/functions/F1/generated/support/liveReporter.js');
  });

  it('omits --headed by default (runs headless, no browser window)', () => {
    expect(buildPlaywrightArgs(['dir'])).not.toContain('--headed');
    expect(buildPlaywrightArgs(['dir'], 2, undefined, false)).not.toContain('--headed');
  });

  it('adds --headed so the user can watch the real browser being driven', () => {
    expect(buildPlaywrightArgs(['dir'], undefined, undefined, true)).toContain('--headed');
  });

  it('omits --grep when grepIds is not given', () => {
    expect(buildPlaywrightArgs(['dir'])).not.toContain('--grep');
  });

  it('adds --grep matching only the given ids by their "[id] " title prefix', () => {
    const args = buildPlaywrightArgs(['dir'], undefined, undefined, undefined, ['UI-1-01', 'UI-1-02']);
    expect(args).toContain('--grep');
    expect(args[args.indexOf('--grep') + 1]).toBe('^\\[(UI-1-01|UI-1-02)\\]');
  });

  it('escapes regex special characters in ids before building --grep', () => {
    const args = buildPlaywrightArgs(['dir'], undefined, undefined, undefined, ['ID.001(a)']);
    expect(args[args.indexOf('--grep') + 1]).toBe('^\\[(ID\\.001\\(a\\))\\]');
  });
});

describe('parseReport', () => {
  it('flattens nested suites into a flat list of test results', () => {
    const report = {
      suites: [
        {
          specs: [
            { title: 'Test A', tests: [{ results: [{ status: 'passed', duration: 10 }] }] }
          ],
          suites: [
            {
              specs: [
                {
                  title: 'Test B',
                  tests: [
                    {
                      results: [
                        {
                          status: 'failed',
                          duration: 20,
                          error: { message: 'boom' },
                          attachments: [{ name: 'screenshot', path: '/tmp/b.png' }]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const result = parseReport(report);

    expect(result.total).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.tests).toEqual([
      { name: 'Test A', status: 'passed', durationMs: 10, errorMessage: undefined, screenshotPath: undefined },
      { name: 'Test B', status: 'failed', durationMs: 20, errorMessage: 'boom', screenshotPath: '/tmp/b.png' }
    ]);
  });

  it('returns an empty result for a report with no suites', () => {
    expect(parseReport({})).toEqual({ total: 0, passed: 0, failed: 0, tests: [] });
  });

  it('strips ANSI color codes from errorMessage — the Playwright JSON reporter keeps terminal colors', () => {
    const ESC = String.fromCharCode(27);
    const report = {
      suites: [
        {
          specs: [
            {
              title: 'Test A',
              tests: [
                {
                  results: [
                    { status: 'failed', duration: 10, error: { message: `Expected: ${ESC}[32m201${ESC}[39m Received: ${ESC}[31m409${ESC}[39m` } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const result = parseReport(report);

    expect(result.tests[0].errorMessage).toBe('Expected: 201 Received: 409');
  });

  describe('bugReportPath resolution', () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
      while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    });

    it('attaches bugReportPath for a failed test when the reconstructed file exists on disk', () => {
      const bugReportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-bugreports-'));
      tmpDirs.push(bugReportsDir);
      const expected = path.join(bugReportsDir, 'API-1-01.md');
      fs.writeFileSync(expected, '# boom');

      const report = {
        suites: [
          { specs: [{ title: '[API-1-01] Missing token', tests: [{ results: [{ status: 'failed', duration: 5 }] }] }] }
        ]
      };

      const result = parseReport(report, bugReportsDir);
      expect(result.tests[0].bugReportPath).toBe(expected);
    });

    it('leaves bugReportPath undefined when no such file exists (AI test title had no [id] prefix, or file never got written)', () => {
      const bugReportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-bugreports-'));
      tmpDirs.push(bugReportsDir);

      const report = {
        suites: [{ specs: [{ title: '[API-1-99] Bug report never written', tests: [{ results: [{ status: 'failed', duration: 5 }] }] }] }]
      };

      const result = parseReport(report, bugReportsDir);
      expect(result.tests[0].bugReportPath).toBeUndefined();
    });

    it('never sets bugReportPath for a passed test even if a same-named file happens to exist', () => {
      const bugReportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-bugreports-'));
      tmpDirs.push(bugReportsDir);
      fs.writeFileSync(path.join(bugReportsDir, 'API-1-01.md'), '# stale');

      const report = {
        suites: [{ specs: [{ title: '[API-1-01] Create valid user', tests: [{ results: [{ status: 'passed', duration: 5 }] }] }] }]
      };

      const result = parseReport(report, bugReportsDir);
      expect(result.tests[0].bugReportPath).toBeUndefined();
    });
  });
});

function fakeChildProcess(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    exitCode: number | null;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  return child;
}

describe('runTests (live progress polling)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.mocked(spawn).mockReset();
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeTmpWorkspace(): { cwd: string; functionDir: string } {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-autotestrunner-'));
    tmpDirs.push(cwd);
    return { cwd, functionDir: path.join(cwd, '.aitest', 'functions', 'CustomerSignup') };
  }

  it('calls onProgress as the live-progress file changes, and once more after the process closes', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const updates: unknown[] = [];
    const resultPromise = runTests(functionDir, 1, ['dir'], cwd, undefined, (rows) => updates.push(rows));

    // Reporter (spawned in the "child" process) writes a snapshot mid-run.
    const progressFile = path.join(functionDir, 'results', 'round-1', 'live-progress.json');
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.writeFileSync(progressFile, JSON.stringify([{ id: 'A-1', title: '[A-1] x', status: 'running' }]));

    // Wait past 1 poll tick (400ms) for the mid-run update to be picked up.
    await new Promise((r) => setTimeout(r, 450));
    expect(updates).toContainEqual([{ id: 'A-1', title: '[A-1] x', status: 'running' }]);

    // Reporter updates the file to "passed" right as the process closes.
    fs.writeFileSync(progressFile, JSON.stringify([{ id: 'A-1', title: '[A-1] x', status: 'passed' }]));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ suites: [] })));
    child.emit('close');

    await resultPromise;
    expect(updates.at(-1)).toEqual([{ id: 'A-1', title: '[A-1] x', status: 'passed' }]);
  });

  it('spawns Playwright with AITEST_FUNCTION_ID/AITEST_ROUND set so the copied reporter/evidence templates know which round dir to write', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 3, ['dir'], cwd);
    child.stdout.emit('data', Buffer.from(JSON.stringify({ suites: [] })));
    child.emit('close');
    await resultPromise;

    const [, , spawnOpts] = vi.mocked(spawn).mock.calls[0];
    const env = (spawnOpts as { env?: Record<string, string> })?.env;
    expect(env?.AITEST_FUNCTION_ID).toBe('CustomerSignup');
    expect(env?.AITEST_ROUND).toBe('3');
  });

  it('passes the requested slowMo to the child through AITEST_SLOW_MO (Playwright has no CLI flag for it)', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 1, ['dir'], cwd, 1, undefined, { headed: true, slowMoMs: 250 });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ suites: [] })));
    child.emit('close');
    await resultPromise;

    const [, args, spawnOpts] = vi.mocked(spawn).mock.calls[0];
    expect(args).toContain('--headed');
    expect((spawnOpts as { env?: Record<string, string> })?.env?.AITEST_SLOW_MO).toBe('250');
  });

  it('passes web/api base URL overrides to the child through AITEST_WEB_BASE_URL/AITEST_API_BASE_URL (Playwright reads them back in playwright.config.ts to set each project baseURL)', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 1, ['dir'], cwd, undefined, undefined, undefined, undefined, {
      web: 'http://staging.example.com',
      api: 'http://api-staging.example.com'
    });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ suites: [] })));
    child.emit('close');
    await resultPromise;

    const env = (vi.mocked(spawn).mock.calls[0][2] as { env?: Record<string, string> })?.env;
    expect(env?.AITEST_WEB_BASE_URL).toBe('http://staging.example.com');
    expect(env?.AITEST_API_BASE_URL).toBe('http://api-staging.example.com');
  });

  it('omits AITEST_WEB_BASE_URL/AITEST_API_BASE_URL entirely when no override is given', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 1, ['dir'], cwd);
    child.stdout.emit('data', Buffer.from(JSON.stringify({ suites: [] })));
    child.emit('close');
    await resultPromise;

    const env = (vi.mocked(spawn).mock.calls[0][2] as { env?: Record<string, string> })?.env;
    expect(env?.AITEST_WEB_BASE_URL).toBeUndefined();
    expect(env?.AITEST_API_BASE_URL).toBeUndefined();
  });

  it('defaults AITEST_SLOW_MO to 0 when no view options are given', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 1, ['dir'], cwd);
    child.stdout.emit('data', Buffer.from(JSON.stringify({ suites: [] })));
    child.emit('close');
    await resultPromise;

    const [, , spawnOpts] = vi.mocked(spawn).mock.calls[0];
    expect((spawnOpts as { env?: Record<string, string> })?.env?.AITEST_SLOW_MO).toBe('0');
  });

  it('does not poll at all when no onProgress callback is given', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 1, ['dir'], cwd);
    child.stdout.emit('data', Buffer.from(JSON.stringify({ suites: [] })));
    child.emit('close');

    const result = await resultPromise;
    expect(result.total).toBe(0);
  });

  it('surfaces the raw stderr when Playwright CLI fails before writing any JSON (e.g. missing project)', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 1, ['dir'], cwd);
    child.stderr.emit('data', Buffer.from('Error: Project(s) "ui" not found. Available projects: ""'));
    child.emit('close');

    await expect(resultPromise).rejects.toThrow('Playwright test run failed: Error: Project(s) "ui" not found. Available projects: ""');
  });

  it('falls back to the JSON parse error when Playwright exits with empty stdout and stderr', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 1, ['dir'], cwd);
    child.emit('close');

    await expect(resultPromise).rejects.toThrow('Failed to parse Playwright report:');
  });

  it('salvages passed/failed results from live-progress.json instead of losing everything when Playwright crashes mid-run', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 1, ['dir'], cwd, undefined, () => {});

    // Reporter already recorded 2 finished tests (1 passed, 1 failed) before the process crashed —
    // a 3rd test is still 'running' and must NOT be counted as a result.
    const progressFile = path.join(functionDir, 'results', 'round-1', 'live-progress.json');
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.writeFileSync(
      progressFile,
      JSON.stringify([
        { id: 'A-1', title: '[A-1] passes', status: 'passed', durationMs: 100 },
        { id: 'A-2', title: '[A-2] fails', status: 'failed', durationMs: 50, bugReportPath: '/tmp/A-2.md', errorMessage: 'expected 200, got 409' },
        { id: 'A-3', title: '[A-3] never finished', status: 'running' }
      ])
    );

    // Process crashes without ever printing a JSON report on stdout.
    child.stderr.emit('data', Buffer.from('FATAL: worker process crashed'));
    child.emit('close');

    const result = await resultPromise;
    expect(result.crashed).toBe(true);
    expect(result.total).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.tests.map((t) => t.name)).toEqual(['[A-1] passes', '[A-2] fails']);
    expect(result.tests.find((t) => t.name === '[A-2] fails')?.bugReportPath).toBe('/tmp/A-2.md');
    // Salvage must keep errorMessage so stopped/crashed rounds show the real error from liveReporter.js.
    expect(result.tests.find((t) => t.name === '[A-2] fails')?.errorMessage).toBe('expected 200, got 409');

    // Still persisted to disk like a normal round, so report/round history isn't lost either.
    const reportPath = path.join(functionDir, 'results', 'round-1', 'report.json');
    expect(JSON.parse(fs.readFileSync(reportPath, 'utf-8')).crashed).toBe(true);
  });

  it('still rejects when the process crashes before even 1 test finished (nothing to salvage)', async () => {
    const { cwd, functionDir } = makeTmpWorkspace();
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = runTests(functionDir, 1, ['dir'], cwd, undefined, () => {});

    const progressFile = path.join(functionDir, 'results', 'round-1', 'live-progress.json');
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.writeFileSync(progressFile, JSON.stringify([{ id: 'A-1', title: '[A-1] x', status: 'running' }]));

    child.emit('close');

    await expect(resultPromise).rejects.toThrow('Failed to parse Playwright report:');
  });

  describe('RunController (Stop/Pause/Resume)', () => {
    const isWin = process.platform === 'win32';

    it('invokes onController exactly once, synchronously after spawning, with supportsPause reflecting the platform', async () => {
      const { cwd, functionDir } = makeTmpWorkspace();
      const child = fakeChildProcess();
      vi.mocked(spawn).mockReturnValue(child as never);

      const controllers: { supportsPause: boolean }[] = [];
      const resultPromise = runTests(functionDir, 1, ['dir'], cwd, undefined, undefined, undefined, undefined, undefined, (c) =>
        controllers.push(c)
      );

      expect(controllers).toHaveLength(1);
      expect(controllers[0].supportsPause).toBe(!isWin);

      child.stdout.emit('data', Buffer.from(JSON.stringify({ suites: [] })));
      child.emit('close');
      await resultPromise;
    });

    it('stop() sends SIGTERM to the whole process group (negative pid) on POSIX', async () => {
      if (isWin) return;
      const { cwd, functionDir } = makeTmpWorkspace();
      const child = fakeChildProcess(9999);
      vi.mocked(spawn).mockReturnValue(child as never);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      let controller: import('./testRunner').RunController | undefined;
      const resultPromise = runTests(functionDir, 1, ['dir'], cwd, undefined, undefined, undefined, undefined, undefined, (c) => {
        controller = c;
      });

      controller!.stop();
      expect(killSpy).toHaveBeenCalledWith(-9999, 'SIGTERM');

      child.emit('close');
      await resultPromise;
      killSpy.mockRestore();
    });

    it('pause()/resume() send SIGSTOP/SIGCONT to the process group on POSIX, and do nothing when supportsPause is false', async () => {
      const { cwd, functionDir } = makeTmpWorkspace();
      const child = fakeChildProcess(7777);
      vi.mocked(spawn).mockReturnValue(child as never);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      let controller: import('./testRunner').RunController | undefined;
      const resultPromise = runTests(functionDir, 1, ['dir'], cwd, undefined, undefined, undefined, undefined, undefined, (c) => {
        controller = c;
      });

      controller!.pause();
      controller!.resume();
      if (isWin) {
        expect(killSpy).not.toHaveBeenCalled();
      } else {
        expect(killSpy).toHaveBeenCalledWith(-7777, 'SIGSTOP');
        expect(killSpy).toHaveBeenCalledWith(-7777, 'SIGCONT');
      }

      child.stdout.emit('data', Buffer.from(JSON.stringify({ suites: [] })));
      child.emit('close');
      await resultPromise;
      killSpy.mockRestore();
    });

    it('resolves with stoppedByUser (not crashed) and salvaged partial results when stop() was called before close', async () => {
      const { cwd, functionDir } = makeTmpWorkspace();
      const child = fakeChildProcess();
      vi.mocked(spawn).mockReturnValue(child as never);
      vi.spyOn(process, 'kill').mockImplementation(() => true);

      let controller: import('./testRunner').RunController | undefined;
      const resultPromise = runTests(functionDir, 1, ['dir'], cwd, undefined, undefined, undefined, undefined, undefined, (c) => {
        controller = c;
      });

      const progressFile = path.join(functionDir, 'results', 'round-1', 'live-progress.json');
      fs.mkdirSync(path.dirname(progressFile), { recursive: true });
      fs.writeFileSync(
        progressFile,
        JSON.stringify([
          { id: 'A-1', title: '[A-1] passes', status: 'passed', durationMs: 100 },
          { id: 'A-2', title: '[A-2] never finished', status: 'running' }
        ])
      );

      controller!.stop();
      // Killed mid-run — no JSON report on stdout, same as a real crash.
      child.emit('close');

      const result = await resultPromise;
      expect(result.stoppedByUser).toBe(true);
      expect(result.crashed).toBeUndefined();
      expect(result.total).toBe(1);
      expect(result.passed).toBe(1);
      expect(result.tests.map((t) => t.name)).toEqual(['[A-1] passes']);

      vi.mocked(process.kill).mockRestore?.();
    });

    it('resolves with an empty stoppedByUser result (does not reject) when stop() was called before any test finished', async () => {
      const { cwd, functionDir } = makeTmpWorkspace();
      const child = fakeChildProcess();
      vi.mocked(spawn).mockReturnValue(child as never);
      vi.spyOn(process, 'kill').mockImplementation(() => true);

      let controller: import('./testRunner').RunController | undefined;
      const resultPromise = runTests(functionDir, 1, ['dir'], cwd, undefined, undefined, undefined, undefined, undefined, (c) => {
        controller = c;
      });

      controller!.stop();
      child.emit('close');

      const result = await resultPromise;
      expect(result.stoppedByUser).toBe(true);
      expect(result.total).toBe(0);

      vi.mocked(process.kill).mockRestore?.();
    });
  });
});
