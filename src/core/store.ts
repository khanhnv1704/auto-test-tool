import type { TestCaseSource } from './testCaseSource';
import * as fs from 'fs';
import * as path from 'path';
import {
  BacklogProjectConfig,
  BacklogUploadedTask,
  BlockedInfo,
  BugAnalysis,
  BugOccurrence,
  RunResult,
  Schedule,
  TestCase,
  TestResultDetail
} from '../types';

/**
 * Single on-disk storage layer for `.aitest/functions/<functionId>/...`. Every other module goes through
 * here instead of building paths itself, so the layout lives in one place.
 */

export function functionsRootDir(aitestDir: string): string {
  return path.join(aitestDir, 'functions');
}

/** Test schedules are shared across all functions, so they live at the `.aitest/` root. */
export function schedulesPath(aitestDir: string): string {
  return path.join(aitestDir, 'schedules.json');
}

export function readSchedules(aitestDir: string): Schedule[] {
  try {
    const data = JSON.parse(fs.readFileSync(schedulesPath(aitestDir), 'utf-8')) as { schedules: Schedule[] };
    return data.schedules ?? [];
  } catch {
    return [];
  }
}

export function writeSchedules(aitestDir: string, schedules: Schedule[]): void {
  fs.mkdirSync(aitestDir, { recursive: true });
  fs.writeFileSync(schedulesPath(aitestDir), JSON.stringify({ schedules }, null, 2));
}

/**
 * functionId comes from free-form input (the "# Function:" line, see extractFunctionId in
 * functionSpecLoader.ts), so strip path separators and ".." to never write outside `.aitest/functions/`.
 * Idempotent: re-sanitizing a directory name (e.g. from listFunctionIds) yields the same result.
 */
function sanitizeFunctionId(functionId: string): string {
  return functionId.replace(/[\\/]/g, '_').replace(/\.\./g, '_');
}

export function functionDir(aitestDir: string, functionId: string): string {
  return path.join(functionsRootDir(aitestDir), sanitizeFunctionId(functionId));
}

export function generatedDir(functionDir: string): string {
  return path.join(functionDir, 'generated');
}

export function testCasesPath(functionDir: string): string {
  return path.join(functionDir, 'testcases.json');
}

/** Hash cache for the "generate from existing test cases" flow (testCaseMarkdownLoader.ts). Separate from
 * cache/function-hashes.json because that flow diffs per test case rather than per function. */
export function testCaseHashesPath(functionDir: string): string {
  return path.join(functionDir, 'cache', 'testcase-hashes.json');
}

export interface FunctionMeta {
  /** Screen URL entered for the "generate from existing test cases" flow (no requirement doc to derive it
   * from); remembered for later runs. */
  screenUrl?: string;
  /** Login credentials, if the screen requires them — passed to the generation prompt (see
   * buildScriptsFromTestCasesPrompt in testSuiteGenerator.ts). */
  credential?: string;
  /** Source file (Markdown or Excel) the test cases were imported from, plus the sheets that belong to
   * this function when the source is Excel. Used to reload the source and to write AI suggestions back. */
  testCaseSource?: TestCaseSource;
  /** Base URL for real requests in kind='api' test cases; asked once (see ensureApiConfig in extension.ts). */
  apiBaseUrl?: string;
  /** Auth header, if the API requires one — passed to the API generation prompt (see
   * buildApiScriptsFromTestCasesPrompt in testSuiteGenerator.ts). */
  apiAuthHeader?: string;
  /** Claude model chosen in this function's last "Sync Test" (modal in testCasesPanel.ts). Overrides
   * `aitest.generation.model` for this function's later syncs; the modal prefills it when set. */
  syncModel?: string;
}

function metaPath(functionDir: string): string {
  return path.join(functionDir, 'meta.json');
}

export function readFunctionMeta(functionDir: string): FunctionMeta {
  try {
    return JSON.parse(fs.readFileSync(metaPath(functionDir), 'utf-8')) as FunctionMeta;
  } catch {
    return {};
  }
}

export function writeFunctionMeta(functionDir: string, meta: FunctionMeta): void {
  fs.mkdirSync(functionDir, { recursive: true });
  fs.writeFileSync(metaPath(functionDir), JSON.stringify(meta, null, 2));
}

export function resultsDir(functionDir: string): string {
  return path.join(functionDir, 'results');
}

export function roundDir(functionDir: string, round: number): string {
  return path.join(resultsDir(functionDir), `round-${round}`);
}

export function roundReportPath(functionDir: string, round: number): string {
  return path.join(roundDir(functionDir, round), 'report.json');
}

/** Lists functionIds under `.aitest/functions/*` — source for the sidebar tree and QuickPick. */
export function listFunctionIds(aitestDir: string): string[] {
  const root = functionsRootDir(aitestDir);
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(testCasesPath(functionDir(aitestDir, entry.name))))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Ids of test cases that already have a script. Scans the content of the .ts files directly in generated/
 * (so not support/ or _stale/) for `[<id>] ` prefixes in `test(...)` titles. File names can't be relied on:
 * in the requirement-doc lane the LLM picks them (see parallelGeneration.ts). Used for the script status
 * column in testCasesPanel.ts.
 */
export function listScriptedTestCaseIds(functionDir: string): Set<string> {
  const genDir = generatedDir(functionDir);
  const ids = new Set<string>();
  let files: string[];
  try {
    files = fs.readdirSync(genDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => e.name);
  } catch {
    return ids;
  }

  const titlePattern = /test\(\s*['"`]\[([^\]]+)]/g;
  for (const name of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(genDir, name), 'utf-8');
    } catch {
      continue;
    }
    for (const match of content.matchAll(titlePattern)) {
      ids.add(match[1]);
    }
  }
  return ids;
}

export function readTestCases(functionDir: string): TestCase[] {
  try {
    return JSON.parse(fs.readFileSync(testCasesPath(functionDir), 'utf-8')) as TestCase[];
  } catch {
    return [];
  }
}

/** The only writer of testcases.json; all CRUD from testCasesPanel.ts goes through here. */
export function writeTestCases(functionDir: string, testCases: TestCase[]): void {
  fs.mkdirSync(functionDir, { recursive: true });
  fs.writeFileSync(testCasesPath(functionDir), JSON.stringify(testCases, null, 2));
}

/**
 * Creates an empty function (0 test cases), e.g. from the sidebar "Functions" > "+". `listFunctionIds`
 * treats a function as existing once testcases.json exists, so writing `[]` makes it show up immediately.
 */
export function createFunction(aitestDir: string, functionId: string, meta: FunctionMeta = {}): void {
  const fnDir = functionDir(aitestDir, functionId);
  writeTestCases(fnDir, []);
  if (Object.keys(meta).length > 0) writeFunctionMeta(fnDir, meta);
}

export function readRoundReport(functionDir: string, round: number): RunResult | undefined {
  try {
    return JSON.parse(fs.readFileSync(roundReportPath(functionDir, round), 'utf-8')) as RunResult;
  } catch {
    return undefined;
  }
}

/** Mirrors extractTestId in testRunner.ts; duplicated to avoid a circular import (testRunner.ts imports
 * from this file). */
function extractTestIdFromName(name: string): string {
  const match = /^\[([^\]]+)]/.exec(name);
  return match ? match[1] : name;
}

/**
 * Counts the rounds where a test case failed out of the rounds it actually ran in (bug occurrence rate for
 * Backlog tasks, see buildBacklogDescription). Rounds that didn't run the case are skipped entirely,
 * since a retest can run only some test cases.
 */
export function computeBugOccurrence(functionDir: string, testId: string): BugOccurrence {
  const failedRounds: number[] = [];
  let ranRounds = 0;

  for (const { round } of readRounds(functionDir)) {
    const test = readRoundReport(functionDir, round)?.tests.find((t) => extractTestIdFromName(t.name) === testId);
    if (!test) continue;
    ranRounds += 1;
    if (test.status === 'failed') failedRounds.push(round);
  }

  return { failedRounds: failedRounds.sort((a, b) => a - b), ranRounds };
}

/**
 * Merges a partial retest into the existing round's report.json: entries with matching ids are replaced,
 * the rest kept (see retestSelectedTestCases in extension.ts). The round number does not increase —
 * a partial retest shown as a new round would make unselected cases look untested.
 */
export function mergeRoundResults(functionDir: string, round: number, updates: TestResultDetail[]): RunResult {
  const existing = readRoundReport(functionDir, round) ?? { total: 0, passed: 0, failed: 0, tests: [] };
  const updatesById = new Map(updates.map((t) => [extractTestIdFromName(t.name), t]));

  const merged: TestResultDetail[] = [];
  const seen = new Set<string>();
  for (const t of existing.tests) {
    const id = extractTestIdFromName(t.name);
    const replacement = updatesById.get(id);
    merged.push(replacement ?? t);
    seen.add(id);
  }
  for (const t of updates) {
    const id = extractTestIdFromName(t.name);
    if (!seen.has(id)) merged.push(t);
  }

  const result: RunResult = {
    total: merged.length,
    passed: merged.filter((t) => t.status === 'passed').length,
    failed: merged.filter((t) => t.status === 'failed').length,
    tests: merged
  };
  fs.writeFileSync(roundReportPath(functionDir, round), JSON.stringify(result, null, 2));
  return result;
}

export interface RoundSummary {
  round: number;
  startedAt: string;
  endedAt: string;
  total: number;
  passed: number;
  failed: number;
  untested: number;
  totalDurationMs: number;
}

function roundsIndexPath(functionDir: string): string {
  return path.join(resultsDir(functionDir), 'rounds.json');
}

/** Rounds run for a function, in write order (oldest first, not re-sorted by round number). */
export function readRounds(functionDir: string): RoundSummary[] {
  try {
    const data = JSON.parse(fs.readFileSync(roundsIndexPath(functionDir), 'utf-8')) as { rounds: RoundSummary[] };
    return data.rounds ?? [];
  } catch {
    return [];
  }
}

/** Next round number, derived from the highest recorded round (no separate counter to drift). */
export function nextRound(functionDir: string): number {
  return readRounds(functionDir).reduce((max, r) => Math.max(max, r.round), 0) + 1;
}

export function appendRound(functionDir: string, summary: RoundSummary): void {
  const rounds = [...readRounds(functionDir), summary];
  fs.mkdirSync(resultsDir(functionDir), { recursive: true });
  fs.writeFileSync(roundsIndexPath(functionDir), JSON.stringify({ rounds }, null, 2));
}

/** Permanently deletes a round: its `results/round-<n>/` directory and its rounds.json entry. */
export function deleteRound(functionDir: string, round: number): void {
  fs.rmSync(roundDir(functionDir, round), { recursive: true, force: true });
  const rounds = readRounds(functionDir).filter((r) => r.round !== round);
  fs.mkdirSync(resultsDir(functionDir), { recursive: true });
  fs.writeFileSync(roundsIndexPath(functionDir), JSON.stringify({ rounds }, null, 2));
}

/** Replaces (not appends) the entry with the same `summary.round` — used after a partial retest (see
 * mergeRoundResults). */
export function updateRoundSummary(functionDir: string, summary: RoundSummary): void {
  const rounds = readRounds(functionDir).map((r) => (r.round === summary.round ? summary : r));
  fs.mkdirSync(resultsDir(functionDir), { recursive: true });
  fs.writeFileSync(roundsIndexPath(functionDir), JSON.stringify({ rounds }, null, 2));
}

/** Summarizes a RunResult into a round history entry; `totalTestCases` is used to compute untested. */
export function summarizeRound(
  round: number,
  startedAt: string,
  endedAt: string,
  totalTestCases: number,
  result: RunResult
): RoundSummary {
  return {
    round,
    startedAt,
    endedAt,
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    untested: Math.max(0, totalTestCases - result.total),
    totalDurationMs: result.tests.reduce((sum, t) => sum + t.durationMs, 0)
  };
}

/**
 * Manual "Blocked" flags per (round, testId), see BlockedInfo in types/index.ts. Stored in a separate file
 * because report.json is overwritten on every run/retest, while Blocked is a user annotation that must
 * survive re-runs.
 */
function blockedPath(functionDir: string, round: number): string {
  return path.join(roundDir(functionDir, round), 'blocked.json');
}

export function readBlockedCases(functionDir: string, round: number): Record<string, BlockedInfo> {
  try {
    return JSON.parse(fs.readFileSync(blockedPath(functionDir, round), 'utf-8')) as Record<string, BlockedInfo>;
  } catch {
    return {};
  }
}

export function setBlockedCase(functionDir: string, round: number, testId: string, reason: string): void {
  const all = readBlockedCases(functionDir, round);
  all[testId] = { reason, blockedAt: new Date().toISOString() };
  fs.mkdirSync(roundDir(functionDir, round), { recursive: true });
  fs.writeFileSync(blockedPath(functionDir, round), JSON.stringify(all, null, 2));
}

export function clearBlockedCase(functionDir: string, round: number, testId: string): void {
  const all = readBlockedCases(functionDir, round);
  delete all[testId];
  fs.mkdirSync(roundDir(functionDir, round), { recursive: true });
  fs.writeFileSync(blockedPath(functionDir, round), JSON.stringify(all, null, 2));
}

/**
 * AI bug analysis as structured JSON, so bugDetailPanel.ts can render each section and build the Backlog
 * description. Stored next to liveReporter.js's `.md` file in `bug-reports/`, with a different extension.
 */
function bugAnalysisPath(functionDir: string, round: number, testId: string): string {
  return path.join(roundDir(functionDir, round), 'bug-reports', `${sanitizeIdForPath(testId)}.analysis.json`);
}

/** Mirrors sanitizeId in testRunner.ts (avoids a circular import). */
function sanitizeIdForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'test';
}

export function readBugAnalysis(functionDir: string, round: number, testId: string): BugAnalysis | undefined {
  try {
    return JSON.parse(fs.readFileSync(bugAnalysisPath(functionDir, round, testId), 'utf-8')) as BugAnalysis;
  } catch {
    return undefined;
  }
}

export function writeBugAnalysis(functionDir: string, round: number, testId: string, analysis: BugAnalysis): void {
  const target = bugAnalysisPath(functionDir, round, testId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(analysis, null, 2));
}

/** Backlog task created for a bug. Kept separate from BugAnalysis since it is created/refreshed independently. */
function backlogTaskPath(functionDir: string, round: number, testId: string): string {
  return path.join(roundDir(functionDir, round), 'bug-reports', `${sanitizeIdForPath(testId)}.backlog.json`);
}

export function readBacklogUploadedTask(functionDir: string, round: number, testId: string): BacklogUploadedTask | undefined {
  try {
    return JSON.parse(fs.readFileSync(backlogTaskPath(functionDir, round, testId), 'utf-8')) as BacklogUploadedTask;
  } catch {
    return undefined;
  }
}

export function writeBacklogUploadedTask(functionDir: string, round: number, testId: string, task: BacklogUploadedTask): void {
  const target = backlogTaskPath(functionDir, round, testId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(task, null, 2));
}

/**
 * Backlog project connected for the whole workspace (stored at the `.aitest/` root): one project tracks
 * bugs for every function (see connectBacklogProject in extension.ts).
 */
function backlogConfigPath(aitestDir: string): string {
  return path.join(aitestDir, 'backlog.json');
}

export function readBacklogProject(aitestDir: string): BacklogProjectConfig | undefined {
  try {
    return JSON.parse(fs.readFileSync(backlogConfigPath(aitestDir), 'utf-8')) as BacklogProjectConfig;
  } catch {
    return undefined;
  }
}

export function writeBacklogProject(aitestDir: string, config: BacklogProjectConfig): void {
  fs.mkdirSync(aitestDir, { recursive: true });
  fs.writeFileSync(backlogConfigPath(aitestDir), JSON.stringify(config, null, 2));
}

export function clearBacklogProject(aitestDir: string): void {
  try {
    fs.unlinkSync(backlogConfigPath(aitestDir));
  } catch {
    // Never connected — nothing to remove.
  }
}
