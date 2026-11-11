import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// Imported from templates/ (copied verbatim to <functionDir>/generated/support/ by reporterSupport.ts),
// so this tests the exact file that runs in the target project.
import LiveReporter from '../../templates/liveReporter.js';

const originalCwd = process.cwd();
const originalFunctionId = process.env.AITEST_FUNCTION_ID;
const originalRound = process.env.AITEST_ROUND;
const tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-reporter-'));
  tmpDirs.push(dir);
  process.chdir(dir);
  process.env.AITEST_FUNCTION_ID = 'CustomerSignup';
  process.env.AITEST_ROUND = '1';
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  process.env.AITEST_FUNCTION_ID = originalFunctionId;
  process.env.AITEST_ROUND = originalRound;
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function roundResultsDir(dir: string): string {
  return path.join(dir, '.aitest', 'functions', 'CustomerSignup', 'results', 'round-1');
}

function readProgress(dir: string): unknown[] {
  const raw = fs.readFileSync(path.join(roundResultsDir(dir), 'live-progress.json'), 'utf-8');
  return JSON.parse(raw);
}

function fakeTest(id: string, title: string) {
  return { id, title };
}

function fakeStep(title: string, category = 'pw:api') {
  return { title, category };
}

describe('LiveReporter', () => {
  it('marks every test pending on begin, keyed by the [id] prefix in the title', () => {
    const dir = makeTmpWorkspace();
    const reporter = new LiveReporter();

    reporter.onBegin({}, {
      allTests: () => [fakeTest('pw-1', '[API-1-01] Create valid user'), fakeTest('pw-2', '[API-1-02] Missing email')]
    });

    expect(readProgress(dir)).toEqual([
      { id: 'API-1-01', title: '[API-1-01] Create valid user', status: 'pending' },
      { id: 'API-1-02', title: '[API-1-02] Missing email', status: 'pending' }
    ]);
  });

  it('falls back to the Playwright-internal test id when the title has no [id] prefix', () => {
    const dir = makeTmpWorkspace();
    const reporter = new LiveReporter();

    reporter.onBegin({}, { allTests: () => [fakeTest('pw-1', 'Some test without a bracketed id')] });

    expect(readProgress(dir)).toEqual([{ id: 'pw-1', title: 'Some test without a bracketed id', status: 'pending' }]);
  });

  it('transitions a test through running -> passed, carrying the measured duration', () => {
    const dir = makeTmpWorkspace();
    const reporter = new LiveReporter();
    const test = fakeTest('pw-1', '[API-1-01] Create valid user');

    reporter.onBegin({}, { allTests: () => [test] });
    reporter.onTestBegin(test);
    expect(readProgress(dir)).toEqual([{ id: 'API-1-01', title: test.title, status: 'running', steps: [] }]);

    reporter.onTestEnd(test, { status: 'passed', duration: 42 });
    expect(readProgress(dir)).toEqual([{ id: 'API-1-01', title: test.title, status: 'passed', durationMs: 42 }]);
  });

  it('maps any non-passed Playwright status to "failed" and writes a bug report file', () => {
    const dir = makeTmpWorkspace();
    const reporter = new LiveReporter();
    const test = fakeTest('pw-1', '[API-1-01] Missing token');

    reporter.onBegin({}, { allTests: () => [test] });
    reporter.onTestEnd(test, { status: 'timedOut', duration: 15, error: { message: 'boom' } });

    const rows = readProgress(dir) as Array<{ id: string; status: string; durationMs: number; bugReportPath: string; errorMessage: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'API-1-01', title: test.title, status: 'failed', durationMs: 15, errorMessage: 'boom' });
    expect(rows[0].bugReportPath).toBe(path.join(roundResultsDir(dir), 'bug-reports', 'API-1-01.md'));

    const reportContent = fs.readFileSync(rows[0].bugReportPath, 'utf-8');
    expect(reportContent).toContain('boom');
    expect(reportContent).toContain('Missing token');
  });

  it('strips ANSI color codes from errorMessage and the bug report — otherwise the dashboard shows literal "[2m", "[31m"...', () => {
    const dir = makeTmpWorkspace();
    const reporter = new LiveReporter();
    const test = fakeTest('pw-1', '[API-1-01] Create customer');
    const ESC = String.fromCharCode(27);
    const coloredMessage = `expect(received).toBe(expected) ${ESC}[2m// Object.is equality${ESC}[22m\n\nExpected: ${ESC}[32m201${ESC}[39m\nReceived: ${ESC}[31m409${ESC}[39m`;

    reporter.onBegin({}, { allTests: () => [test] });
    reporter.onTestEnd(test, { status: 'failed', duration: 15, error: { message: coloredMessage } });

    const rows = readProgress(dir) as Array<{ errorMessage: string; bugReportPath: string }>;
    expect(rows[0].errorMessage).toBe('expect(received).toBe(expected) // Object.is equality\n\nExpected: 201\nReceived: 409');

    const reportContent = fs.readFileSync(rows[0].bugReportPath, 'utf-8');
    expect(reportContent).not.toContain(ESC);
    expect(reportContent).toContain('Expected: 201');
  });

  it('falls back to "(no error details)" for errorMessage when Playwright gives no error object at all', () => {
    const dir = makeTmpWorkspace();
    const reporter = new LiveReporter();
    const test = fakeTest('pw-1', '[API-1-01] Interrupted mid-run');

    reporter.onBegin({}, { allTests: () => [test] });
    reporter.onTestEnd(test, { status: 'interrupted', duration: 5 });

    const rows = readProgress(dir) as Array<{ errorMessage: string }>;
    expect(rows[0].errorMessage).toBe('(no error details)');
  });

  it('does not create a bug report file when the test passes', () => {
    const dir = makeTmpWorkspace();
    const reporter = new LiveReporter();
    const test = fakeTest('pw-1', '[API-1-01] Create valid user');

    reporter.onBegin({}, { allTests: () => [test] });
    reporter.onTestEnd(test, { status: 'passed', duration: 10 });

    expect(fs.existsSync(path.join(roundResultsDir(dir), 'bug-reports'))).toBe(false);
  });

  // Shows the user what each test is doing during Run Tests — a bare "running" for a whole minute doesn't
  // tell them which action a test is stuck on.
  describe('live step log', () => {
    function startTest(reporter: InstanceType<typeof LiveReporter>, test: { id: string; title: string }) {
      reporter.onBegin({}, { allTests: () => [test] });
      reporter.onTestBegin(test);
    }

    it('exposes the running step via currentStep and records it in steps', () => {
      const dir = makeTmpWorkspace();
      const reporter = new LiveReporter();
      const test = fakeTest('pw-1', '[UI-1-01] Signup succeeds');
      startTest(reporter, test);

      const step = fakeStep('page.goto(http://localhost:4000/signup)');
      reporter.onStepBegin(test, {}, step);
      // write() is throttled, so flush via a forced write before reading the snapshot.
      reporter.onEnd();

      const rows = readProgress(dir) as Array<{ currentStep: string; steps: Array<{ title: string; status: string }> }>;
      expect(rows[0].currentStep).toBe('page.goto(http://localhost:4000/signup)');
      expect(rows[0].steps).toEqual([{ title: 'page.goto(http://localhost:4000/signup)', status: 'running' }]);
    });

    it('closes the step with status + duration when it ends, and clears currentStep', () => {
      const dir = makeTmpWorkspace();
      const reporter = new LiveReporter();
      const test = fakeTest('pw-1', '[UI-1-01] Signup succeeds');
      startTest(reporter, test);

      const step = fakeStep('locator.click(#submit)');
      reporter.onStepBegin(test, {}, step);
      // Playwright passes the same step object to onStepEnd (the reporter uses it as the key).
      reporter.onStepEnd(test, {}, Object.assign(step, { duration: 120 }));
      reporter.onEnd();

      const rows = readProgress(dir) as Array<{ currentStep?: string; steps: Array<unknown> }>;
      expect(rows[0].steps).toEqual([{ title: 'locator.click(#submit)', status: 'passed', durationMs: 120 }]);
      expect(rows[0].currentStep).toBeUndefined();
    });

    it('marks the step as failed when it has an error', () => {
      const dir = makeTmpWorkspace();
      const reporter = new LiveReporter();
      const test = fakeTest('pw-1', '[UI-1-01] Signup succeeds');
      startTest(reporter, test);

      const step = fakeStep('expect.toHaveText', 'expect');
      reporter.onStepBegin(test, {}, step);
      reporter.onStepEnd(test, {}, Object.assign(step, { duration: 5000, error: { message: 'timeout' } }));
      reporter.onEnd();

      const rows = readProgress(dir) as Array<{ steps: Array<{ status: string }> }>;
      expect(rows[0].steps[0].status).toBe('failed');
    });

    it('skips hook/fixture steps — they say nothing about what the test does to the app', () => {
      const dir = makeTmpWorkspace();
      const reporter = new LiveReporter();
      const test = fakeTest('pw-1', '[UI-1-01] Signup succeeds');
      startTest(reporter, test);

      reporter.onStepBegin(test, {}, fakeStep('Before Hooks', 'hook'));
      reporter.onStepBegin(test, {}, fakeStep('fixture: page', 'fixture'));
      reporter.onEnd();

      const rows = readProgress(dir) as Array<{ steps: unknown[]; currentStep?: string }>;
      expect(rows[0].steps).toEqual([]);
      expect(rows[0].currentStep).toBeUndefined();
    });

    it('keeps only the 30 most recent steps so the snapshot does not grow during parallel runs', () => {
      const dir = makeTmpWorkspace();
      const reporter = new LiveReporter();
      const test = fakeTest('pw-1', '[UI-1-01] Signup succeeds');
      startTest(reporter, test);

      for (let i = 0; i < 40; i++) {
        reporter.onStepBegin(test, {}, fakeStep('locator.click(#btn-' + i + ')'));
      }
      reporter.onEnd();

      const rows = readProgress(dir) as Array<{ steps: Array<{ title: string }> }>;
      expect(rows[0].steps).toHaveLength(30);
      expect(rows[0].steps[0].title).toBe('locator.click(#btn-10)');
      expect(rows[0].steps[29].title).toBe('locator.click(#btn-39)');
    });

    it('keeps the step history after the test ends so it can be reviewed', () => {
      const dir = makeTmpWorkspace();
      const reporter = new LiveReporter();
      const test = fakeTest('pw-1', '[UI-1-01] Signup succeeds');
      startTest(reporter, test);

      const step = fakeStep('locator.fill(#email)');
      reporter.onStepBegin(test, {}, step);
      reporter.onStepEnd(test, {}, Object.assign(step, { duration: 30 }));
      reporter.onTestEnd(test, { status: 'passed', duration: 900 });

      const rows = readProgress(dir) as Array<{ status: string; steps: Array<{ title: string }> }>;
      expect(rows[0].status).toBe('passed');
      expect(rows[0].steps).toEqual([{ title: 'locator.fill(#email)', status: 'passed', durationMs: 30 }]);
    });

    it('onTestEnd flushes immediately even if a step was written ms earlier (throttling must not swallow the final state)', () => {
      const dir = makeTmpWorkspace();
      const reporter = new LiveReporter();
      const test = fakeTest('pw-1', '[UI-1-01] Signup succeeds');
      startTest(reporter, test);

      reporter.onStepBegin(test, {}, fakeStep('page.goto(/)'));
      reporter.onTestEnd(test, { status: 'passed', duration: 42 });

      const rows = readProgress(dir) as Array<{ status: string; durationMs: number }>;
      expect(rows[0]).toMatchObject({ status: 'passed', durationMs: 42 });
    });
  });
});
