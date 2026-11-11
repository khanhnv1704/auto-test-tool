// Generated and overwritten by AI Auto Test on every "Generate Tests" — do NOT edit by hand, changes will
// be lost on the next generate. The source lives in the extension's templates/liveReporter.js.
//
// Custom Playwright reporter. The built-in JSON reporter only writes results after the whole run ends.
// This one overwrites a snapshot (results/round-<n>/live-progress.json) whenever a test or a step inside
// it starts/ends; the extension host polls it for the live dashboard (see testRunner.ts). Steps
// (page.goto/locator.click/expect...) show what a test is doing instead of just "running".
//
// Plain CommonJS (no TypeScript) so Playwright can require it regardless of the target project's
// ts-node/tsx setup.
const fs = require('fs');
const path = require('path');

// expect()'s error.message/stack contains ANSI color codes. Both live-progress.json (webview) and the
// bug report .md are plain text, so strip them or they show up as literal "[2m", "[31m"...
const ANSI_PATTERN = new RegExp(
  '[\u001B\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PRZcf-ntqry=><~]))',
  'g'
);
function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_PATTERN, '') : text;
}

// functionId and round can't be derived from this file's location (the same copy serves every round), so
// they come from env vars set by testRunner.ts. process.cwd() is the project root (Playwright is spawned
// there) and is read on every write rather than cached.
function roundResultsDir() {
  return path.join(
    process.cwd(),
    '.aitest',
    'functions',
    process.env.AITEST_FUNCTION_ID || '_unknown',
    'results',
    `round-${process.env.AITEST_ROUND || '0'}`
  );
}

function progressPath() {
  return path.join(roundResultsDir(), 'live-progress.json');
}

function bugReportPath(id) {
  const fileName = String(id).replace(/[^a-zA-Z0-9_-]+/g, '_') || 'test';
  return path.join(roundResultsDir(), 'bug-reports', `${fileName}.md`);
}

// Test titles must start with "[<id>] ..." (see withBatchIdPrefix in parallelGeneration.ts) to match
// results to testcases.json. If the AI didn't comply, fall back to Playwright's internal test.id (unique,
// but won't match testcases.json).
function extractId(test) {
  const match = /^\[([^\]]+)]/.exec(test.title);
  return match ? match[1] : test.id;
}

// Keep only the most recent steps per test — with many parallel tests the snapshot would grow quickly,
// and the dashboard only needs recent activity.
const MAX_STEPS_PER_TEST = 30;

// Steps fire far more often than tests; writing on every event would mean hundreds of writes per second.
// Write at most once per this many ms, and flush immediately on onTestEnd/onEnd so the final state is exact.
const WRITE_THROTTLE_MS = 150;

// Only these categories are meaningful to the user:
//  - 'pw:api'    : page.goto / locator.click / locator.fill ... (real actions on the app)
//  - 'expect'    : the assertion being checked
//  - 'test.step' : steps named by the test script itself
// 'hook' (beforeEach/afterEach) and 'fixture' are skipped as noise.
const VISIBLE_STEP_CATEGORIES = ['pw:api', 'expect', 'test.step'];

function isVisibleStep(step) {
  return Boolean(step) && VISIBLE_STEP_CATEGORIES.indexOf(step.category) !== -1 && Boolean(step.title);
}

// Writes one markdown file per failed test case. The dashboard opens it from the "Failed" cell (see
// reportPanel.ts), so it must be self-contained: error plus evidence screenshot path, if any.
function writeBugReport(id, title, result) {
  const target = bugReportPath(id);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const screenshot = (result.attachments || []).find((a) => a.name === 'evidence' || a.name === 'screenshot');
  const errorText = stripAnsi((result.error && (result.error.stack || result.error.message)) || '(no error details)');

  const lines = [
    `# ${title}`,
    '',
    `- Status: ${result.status}`,
    `- Duration: ${result.duration ?? '?'}ms`,
    '',
    '## Error',
    '',
    '```',
    errorText,
    '```'
  ];
  if (screenshot && screenshot.path) {
    lines.push('', '## Evidence', '', `Screenshot: ${screenshot.path}`);
  }

  fs.writeFileSync(target, lines.join('\n'));
  return target;
}

class LiveReporter {
  constructor() {
    this.tests = new Map();
    // Playwright passes the same step object to onStepEnd, so it is used as the key to find the entry in
    // row.steps and update its status/duration in place.
    this.stepEntries = new Map();
    this.lastWriteAt = 0;
    this.pendingWrite = undefined;
  }

  /**
   * `force = true` writes immediately (test end, run end). Otherwise throttled: if the last write was less
   * than WRITE_THROTTLE_MS ago, schedule one trailing write instead, so bursts of steps don't turn into
   * hundreds of disk writes per second.
   */
  write(force) {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = undefined;
    }

    const now = Date.now();
    if (!force && now - this.lastWriteAt < WRITE_THROTTLE_MS) {
      this.pendingWrite = setTimeout(() => {
        this.pendingWrite = undefined;
        this.write(true);
      }, WRITE_THROTTLE_MS - (now - this.lastWriteAt));
      // Don't keep the Playwright process alive just for a pending progress write.
      if (typeof this.pendingWrite.unref === 'function') this.pendingWrite.unref();
      return;
    }

    this.lastWriteAt = now;
    try {
      const target = progressPath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(Array.from(this.tests.values())));
    } catch {
      // Best-effort — never fail the test run because the progress file couldn't be written.
    }
  }

  onBegin(_config, suite) {
    for (const test of suite.allTests()) {
      this.tests.set(test.id, { id: extractId(test), title: test.title, status: 'pending' });
    }
    this.write(true);
  }

  onTestBegin(test) {
    this.tests.set(test.id, { id: extractId(test), title: test.title, status: 'running', steps: [] });
    this.write(true);
  }

  /** A step just started — this is the live "current action" shown on the dashboard. */
  onStepBegin(test, _result, step) {
    if (!isVisibleStep(step)) return;

    const row = this.tests.get(test.id);
    if (!row) return;

    const entry = { title: step.title, status: 'running' };
    if (!row.steps) row.steps = [];
    row.steps.push(entry);
    // Keep only the most recent steps.
    if (row.steps.length > MAX_STEPS_PER_TEST) row.steps.splice(0, row.steps.length - MAX_STEPS_PER_TEST);
    row.currentStep = step.title;

    this.stepEntries.set(step, entry);
    this.write();
  }

  onStepEnd(test, _result, step) {
    const entry = this.stepEntries.get(step);
    if (!entry) return;
    this.stepEntries.delete(step);

    entry.status = step.error ? 'failed' : 'passed';
    entry.durationMs = step.duration;

    const row = this.tests.get(test.id);
    // Nested steps: only clear currentStep when the displayed step itself ends, not when a child ends
    // while the parent is still running.
    if (row && row.currentStep === step.title) row.currentStep = undefined;

    this.write();
  }

  onTestEnd(test, result) {
    const id = extractId(test);
    const status = result.status === 'passed' ? 'passed' : 'failed';
    const previous = this.tests.get(test.id);
    const row = { id, title: test.title, status, durationMs: result.duration };
    // Keep the step history so a finished test's actions can still be reviewed.
    if (previous && previous.steps && previous.steps.length) row.steps = previous.steps;
    if (status === 'failed') {
      // Also stored here (not only in the bug report) so salvageFromLiveProgress (testRunner.ts) can show
      // the real error when a round is stopped or crashes mid-run.
      row.errorMessage = stripAnsi((result.error && result.error.message) || '(no error details)');
      row.bugReportPath = writeBugReport(id, test.title, result);
    }
    this.tests.set(test.id, row);
    this.write(true);
  }

  onEnd() {
    this.write(true);
  }
}

module.exports = LiveReporter;
