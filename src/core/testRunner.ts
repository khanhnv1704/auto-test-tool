import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RunResult, TestResultDetail, TestStatus } from '../types';
import { roundDir } from './store';

export type LiveTestStatus = 'pending' | 'running' | 'passed' | 'failed';

export type LiveStepStatus = 'running' | 'passed' | 'failed';

/** A single action inside a test case (page.goto / locator.click / expect...) — see liveReporter.js. */
export interface LiveTestStep {
  title: string;
  status: LiveStepStatus;
  /** Set only once the step has finished. */
  durationMs?: number;
}

export interface LiveTestRow {
  id: string;
  title: string;
  status: LiveTestStatus;
  /** Set only when status is 'passed'/'failed' — Playwright's measured duration for this test. */
  durationMs?: number;
  /** Set only when status is 'failed' — markdown file written by liveReporter.js (see writeBugReport). */
  bugReportPath?: string;
  /** Set only when status is 'failed' — short Playwright message, so salvageFromLiveProgress can still
   * show the real error when a round is stopped or crashes mid-run. */
  errorMessage?: string;
  /** Action currently running — set only while status is 'running', so the dashboard can show live activity. */
  currentStep?: string;
  /** Actions run so far (newest last), truncated by the reporter to keep the file small. */
  steps?: LiveTestStep[];
}

export type OnExecutionProgress = (rows: LiveTestRow[]) => void;

interface PlaywrightAttachment {
  name: string;
  path?: string;
}

interface PlaywrightTestResult {
  status: string;
  duration: number;
  /** ISO 8601, provided by Playwright's JSON reporter for every result (parseReport derives
   * endedAt = startTime + duration). */
  startTime?: string;
  error?: { message?: string };
  attachments?: PlaywrightAttachment[];
}

interface PlaywrightSpec {
  title: string;
  tests: Array<{ results: PlaywrightTestResult[] }>;
}

interface PlaywrightSuite {
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

interface PlaywrightJsonReport {
  suites?: PlaywrightSuite[];
}

/**
 * Builds CLI args for `npx playwright test` (pure function, testable without spawning).
 * No `--project` is passed: UI and API cases run in one invocation and the target project's
 * playwright.config.ts routes files via `testMatch` (API-/UI- batchTag prefix, see withBatchIdPrefix in
 * parallelGeneration.ts).
 * - `workers` omitted → no `--workers`, Playwright picks based on CPU count.
 * - `liveReporterPath` is added next to `json` (read from stdout for the final result).
 * - `headed` uses the `--headed` CLI flag rather than `use.headless` so it also works with a
 *   user-written playwright.config.ts (ensurePlaywrightConfig never overwrites an existing config).
 * - `grepIds` limits the run to tests whose title starts with "[<id>] " (used by retestSelectedTestCases
 *   in extension.ts to re-run selected cases only).
 */
export function buildPlaywrightArgs(
  specFiles: string[],
  workers?: number,
  liveReporterPath?: string,
  headed?: boolean,
  grepIds?: string[]
): string[] {
  const reporters = liveReporterPath ? `json,${liveReporterPath}` : 'json';
  const args = ['playwright', 'test', ...specFiles, '--reporter', reporters];
  if (workers && workers > 0) {
    args.push('--workers', String(workers));
  }
  if (headed) {
    args.push('--headed');
  }
  if (grepIds && grepIds.length > 0) {
    const escaped = grepIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    args.push('--grep', `^\\[(${escaped.join('|')})\\]`);
  }
  return args;
}

const LIVE_PROGRESS_POLL_MS = 400;

/**
 * Salvages results from the last `live-progress.json` snapshot when Playwright crashes mid-run (OOM, dead
 * worker) or the user clicks "⏹ Stop" (see RunController). Normally `runTests` reads the JSON reporter
 * output on stdout, which is only printed at the very end, whereas `live-progress.json` (written
 * continuously by templates/liveReporter.js) already holds every finished test. Only 'passed'/'failed'
 * rows are kept. Returns undefined when nothing can be salvaged (empty/corrupt raw, or no finished test).
 */
function salvageFromLiveProgress(raw: string, stoppedByUser: boolean): RunResult | undefined {
  if (!raw) return undefined;

  let rows: LiveTestRow[];
  try {
    rows = JSON.parse(raw) as LiveTestRow[];
  } catch {
    return undefined;
  }

  const tests: TestResultDetail[] = rows
    .filter((row): row is LiveTestRow & { status: 'passed' | 'failed' } => row.status === 'passed' || row.status === 'failed')
    .map((row) => {
      const detail: TestResultDetail = { name: row.title, status: row.status, durationMs: row.durationMs ?? 0 };
      if (row.bugReportPath) detail.bugReportPath = row.bugReportPath;
      if (row.errorMessage) detail.errorMessage = row.errorMessage;
      return detail;
    });
  if (tests.length === 0) return undefined;

  return {
    total: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    tests,
    ...(stoppedByUser
      ? {
          stoppedByUser: true,
          crashMessage: 'Stopped by user — the results below were recovered from tests that finished before the stop.'
        }
      : {
          crashed: true,
          crashMessage: 'The Playwright process exited unexpectedly mid-run — the results below were recovered from tests that finished before the crash.'
        })
  };
}

/**
 * Extracts the id from a "[id] ..." title prefix. Mirrors `extractId` in templates/liveReporter.js (which
 * runs in the target project's child process, so it cannot share code). Exported so webviews
 * (reportPanel.ts, testCasesPanel.ts) join results to testcases.json using the same convention.
 */
export function extractTestId(title: string): string {
  const match = /^\[([^\]]+)]/.exec(title);
  return match ? match[1] : title;
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'test';
}

/**
 * Runs `npx playwright test` for one function (one round) and reads the JSON reporter for
 * pass/fail/error/screenshot, without blocking the extension UI thread. `workers` enables parallel runs
 * (the config sets `fullyParallel: true`).
 *
 * `functionDir` + `round` locate the round directory for report/live-progress. The round is passed to the
 * child via `AITEST_ROUND`: the support templates (copied to `<functionDir>/generated/support/`) derive
 * `functionDir` from their own `__dirname`, but cannot know the round number.
 *
 * `onProgress` is called periodically while the child runs, from snapshots written by
 * `support/liveReporter.js` — the built-in JSON reporter only has data after the process exits.
 *
 * `view` controls live viewing: `headed` opens a real browser window, `slowMoMs` slows each action down
 * enough for a human to follow. Playwright has no CLI flag for slowMo, so it goes through `AITEST_SLOW_MO`
 * (read by templates/playwright.config.ts).
 *
 * `baseUrls` sets the "ui"/"api" project baseURL for this run via `AITEST_WEB_BASE_URL`/
 * `AITEST_API_BASE_URL`. Generated scripts use relative paths (see toRelativePath in
 * testSuiteGenerator.ts), so the environment can change without regenerating. Callers always resolve
 * defaults via resolveRunBaseUrls (from meta.screenUrl/apiBaseUrl); without a baseURL, relative paths
 * in scripts fail to resolve.
 */
export interface LiveViewOptions {
  headed?: boolean;
  slowMoMs?: number;
}

export interface RunBaseUrls {
  web?: string;
  api?: string;
}

/**
 * Controls a running `npx playwright test` process. Handed out via `onController` right after spawn so
 * extension.ts can keep it (per functionId, see activeRunControllers) and call it from the live
 * dashboard's Stop/Pause/Resume buttons (renderExecuteLiveShell in reportPanel.ts).
 *
 * `stop()` is final — the round is still saved with results salvaged from live-progress.json (see
 * salvageFromLiveProgress), same as a crash but with a different message.
 *
 * `pause()`/`resume()` send SIGSTOP/SIGCONT to the whole process group (spawned `detached: true` on POSIX
 * so it gets its own group; a negative pid targets the group, see `man 2 kill`). This freezes Playwright
 * and all its workers in place without losing state. Windows has no SIGSTOP equivalent, so
 * `supportsPause=false` there and the UI hides the Pause button.
 */
export interface RunController {
  stop(): void;
  pause(): void;
  resume(): void;
  /** false on Windows — pause()/resume() are no-ops and the UI should hide the Pause button. */
  supportsPause: boolean;
}

const STOP_GRACE_MS = 3000;

export function runTests(
  functionDir: string,
  round: number,
  specFiles: string[],
  cwd: string,
  workers?: number,
  onProgress?: OnExecutionProgress,
  view?: LiveViewOptions,
  testIds?: string[],
  baseUrls?: RunBaseUrls,
  onController?: (controller: RunController) => void
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const thisRoundDir = roundDir(functionDir, round);
    fs.mkdirSync(thisRoundDir, { recursive: true });
    const reportPath = path.join(thisRoundDir, 'report.json');
    const liveProgressPath = path.join(thisRoundDir, 'live-progress.json');
    const bugReportsDir = path.join(thisRoundDir, 'bug-reports');
    const reporterPath = path.join(functionDir, 'generated', 'support', 'liveReporter.js');

    // Remove the previous run's snapshot so the dashboard doesn't show stale state before the new
    // reporter writes its first one.
    try {
      fs.unlinkSync(liveProgressPath);
    } catch {
      // never run before — nothing to remove
    }

    const args = buildPlaywrightArgs(
      specFiles,
      workers,
      fs.existsSync(reporterPath) ? reporterPath : undefined,
      view?.headed,
      testIds
    );
    // `detached: true` on POSIX makes the child lead its own process group, so stop()/pause()/resume()
    // can signal the whole group (negative pid). Signalling only `npx` would miss Playwright, which runs
    // in a separate child of `npx`. Windows has no POSIX process groups: stop() uses `taskkill /T` and
    // pause/resume are unsupported (see supportsPause).
    const isWin = process.platform === 'win32';
    const child = spawn('npx', args, {
      cwd,
      shell: isWin,
      detached: !isWin,
      // The support templates can't know the current functionId/round, so pass them via env.
      // path.basename(functionDir) is the sanitized functionId (see functionDir() in store.ts).
      env: {
        ...process.env,
        AITEST_FUNCTION_ID: path.basename(functionDir),
        AITEST_ROUND: String(round),
        AITEST_SLOW_MO: String(view?.slowMoMs ?? 0),
        ...(baseUrls?.web ? { AITEST_WEB_BASE_URL: baseUrls.web } : {}),
        ...(baseUrls?.api ? { AITEST_API_BASE_URL: baseUrls.api } : {})
      }
    });

    let stoppedByUser = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    function signalGroup(signal: NodeJS.Signals) {
      if (!child.pid) return;
      try {
        process.kill(isWin ? child.pid : -child.pid, signal);
      } catch {
        // Process already exited before the signal was sent.
      }
    }

    onController?.({
      supportsPause: !isWin,
      stop() {
        if (stoppedByUser || child.exitCode !== null) return;
        stoppedByUser = true;
        if (isWin) {
          // /T kills the whole tree (npx -> node playwright -> workers); killing only the root PID on
          // Windows often leaves workers running.
          exec(`taskkill /pid ${child.pid} /T /F`);
        } else {
          signalGroup('SIGTERM');
          killTimer = setTimeout(() => signalGroup('SIGKILL'), STOP_GRACE_MS);
        }
      },
      pause() {
        if (!isWin) signalGroup('SIGSTOP');
      },
      resume() {
        if (!isWin) signalGroup('SIGCONT');
      }
    });

    let lastRaw = '';
    const readLiveProgress = () => {
      try {
        const raw = fs.readFileSync(liveProgressPath, 'utf-8');
        if (raw !== lastRaw) {
          lastRaw = raw;
          onProgress?.(JSON.parse(raw) as LiveTestRow[]);
        }
      } catch {
        // File not written yet or mid-write — retry on the next poll.
      }
    };

    const pollInterval = onProgress ? setInterval(readLiveProgress, LIVE_PROGRESS_POLL_MS) : undefined;

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      if (pollInterval) clearInterval(pollInterval);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on('close', () => {
      if (pollInterval) clearInterval(pollInterval);
      if (killTimer) clearTimeout(killTimer);
      readLiveProgress(); // final read so the dashboard reflects the end state

      // Stopped by the user: stdout is empty/partial, so skip parsing and salvage directly — avoids a
      // misleading "Failed to parse..." error.
      if (stoppedByUser) {
        const salvaged = salvageFromLiveProgress(lastRaw, true) ?? {
          total: 0,
          passed: 0,
          failed: 0,
          tests: [],
          stoppedByUser: true as const,
          crashMessage: 'Stopped by user before any test case finished.'
        };
        fs.writeFileSync(reportPath, JSON.stringify(salvaged, null, 2));
        resolve(salvaged);
        return;
      }

      try {
        const report = JSON.parse(stdout) as PlaywrightJsonReport;
        const result = parseReport(report, bugReportsDir);
        fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
        resolve(result);
      } catch (err) {
        // stdout is empty/corrupt when the CLI fails before printing JSON (missing config, bad args)
        // or crashes mid-run. Salvage from live-progress.json first: if any test finished, return it
        // marked `crashed` so the round is still saved and the user can re-run just the rest.
        const salvaged = salvageFromLiveProgress(lastRaw, false);
        if (salvaged) {
          fs.writeFileSync(reportPath, JSON.stringify(salvaged, null, 2));
          resolve(salvaged);
          return;
        }

        // Nothing salvaged — the real error is in stderr; show it instead of a confusing parse error.
        const trimmedStderr = stderr.trim();
        reject(trimmedStderr ? new Error(`Playwright test run failed: ${trimmedStderr}`) : new Error(`Failed to parse Playwright report: ${(err as Error).message}`));
      }
    });
  });
}

// expect()'s error.message contains ANSI color codes; the webview shows plain text, so strip them or it
// renders literal "[2m", "[31m"...
const ANSI_PATTERN = new RegExp(
  '[\u001B\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PRZcf-ntqry=><~]))',
  'g'
);

function stripAnsi(text: string | undefined): string | undefined {
  return typeof text === 'string' ? text.replace(ANSI_PATTERN, '') : text;
}

/**
 * `bugReportsDir`, when given, sets `bugReportPath` on failed cases by reproducing liveReporter.js's file
 * naming (`<sanitizeId(id)>.md`) — the JSON reporter knows nothing about our bug reports.
 */
export function parseReport(report: PlaywrightJsonReport, bugReportsDir?: string): RunResult {
  const tests: TestResultDetail[] = [];

  const walk = (suites: PlaywrightSuite[] = []) => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        const result = spec.tests[0]?.results[0];
        if (!result) continue;

        const status: TestStatus = result.status === 'passed' ? 'passed' : 'failed';
        const detail: TestResultDetail = {
          name: spec.title,
          status,
          durationMs: result.duration,
          errorMessage: stripAnsi(result.error?.message),
          // 'evidence' = annotated screenshot from captureUiEvidence/captureApiEvidence (every case, pass
          // or fail); 'screenshot' = Playwright's automatic fallback on failure.
          screenshotPath: result.attachments?.find((a) => a.name === 'evidence' || a.name === 'screenshot')?.path
        };

        if (result.startTime) {
          detail.startedAt = result.startTime;
          detail.endedAt = new Date(new Date(result.startTime).getTime() + result.duration).toISOString();
        }

        if (status === 'failed' && bugReportsDir) {
          const candidate = path.join(bugReportsDir, `${sanitizeId(extractTestId(spec.title))}.md`);
          if (fs.existsSync(candidate)) detail.bugReportPath = candidate;
        }

        tests.push(detail);
      }
      walk(suite.suites);
    }
  };

  walk(report.suites);

  return {
    total: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    tests
  };
}
