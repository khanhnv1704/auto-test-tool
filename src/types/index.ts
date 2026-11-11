export type TestKind = 'api' | 'ui';
export type TestCategory = 'functional' | 'non-functional';
export type TestSeverity = 'Low' | 'Medium' | 'High' | 'Critical';

/** One test case row, with enough columns to be reviewed or executed manually, not just by machine. */
export interface TestCase {
  id: string;
  name: string;
  kind: TestKind;
  target: string;
  severity: TestSeverity;
  precondition: string;
  steps: string[];
  dataTest: string;
  expectedResult: string;
  isEdgeCase: boolean;
  /** functional (field/business rules) or non-functional (security, authorization, data integrity). Only the API lane generates non-functional cases. */
  category?: TestCategory;
  /** Set by the LLM when generating scripts from test cases: 'automatable' if it wrote a script, 'manual'
   * if the case can't be automated (physical actions, visual judgment, simulated network loss...).
   * Empty in the requirement-doc flow, which always produces a script (implicitly 'automatable'). */
  automationStatus?: 'automatable' | 'manual';
  /** Short reason when automationStatus is 'manual'. */
  automationNote?: string;
  /** Why the last script generation for this case failed; cleared on the next success. Unlike "no
   * script yet", it tells the user generation was attempted and why it failed, so they can fix the
   * case before syncing again. */
  lastScriptGenError?: string;
}

/** A test case suggested by the AI, with the reason it was suggested so the user can decide whether to add it. */
export interface SuggestedTestCase extends TestCase {
  reason?: string;
}

export interface GeneratedScript {
  fileName: string;
  content: string;
}

export interface TestSuite {
  testCases: TestCase[];
  scripts: GeneratedScript[];
}

export interface ApiEndpoint {
  key: string;
  method: string;
  path: string;
  summary?: string;
  requestBody?: Record<string, unknown>;
  responses?: Record<string, unknown>;
  security?: boolean;
}

export interface UiTestCaseBlock {
  key: string;
  screen: string;
  url: string;
  rule?: string;
  steps: string[];
  expected: string;
  raw: string;
}

/**
 * A field on a screen (Function Spec lane). Unlike ApiEndpoint.requestBody, it can express visibility
 * that depends on another field (e.g. "ID number" is only shown when Customer type = Individual).
 */
export interface FunctionField {
  name: string;
  type: string;
  required: boolean;
  constraint?: string;
  /** Only shown/applicable when another field has a given value, e.g. "Customer type=Individual". */
  showIf?: string;
  /** The real widget found by the DOM scan (e.g. "native <select> element, options: Individual, Company"), if the scan succeeded. */
  domHint?: string;
}

export interface FunctionSpec {
  functionId: string;
  screenUrl: string;
  fields: FunctionField[];
  endpoints: ApiEndpoint[];
  functionalRules: string[];
  nonFunctionalRules: string[];
  raw: string;
}

export interface DiffResult<T> {
  changed: T[];
  unchanged: T[];
}

export interface HashDiff {
  changedKeys: string[];
  unchangedKeys: string[];
  newHashes: Record<string, string>;
}

export type TestStatus = 'passed' | 'failed';

export interface TestResultDetail {
  name: string;
  status: TestStatus;
  durationMs: number;
  errorMessage?: string;
  screenshotPath?: string;
  /** Only when status is 'failed': path to the Markdown bug report. */
  bugReportPath?: string;
  /** ISO timestamp, from `result.startTime` in the Playwright JSON report. */
  startedAt?: string;
  /** ISO timestamp = startedAt + durationMs (the Playwright JSON report has no end time). */
  endedAt?: string;
}

/**
 * A test case manually marked "Blocked" for one round (e.g. test environment down, waiting for data).
 * Unlike "untested", which is inferred, Blocked is set explicitly with a reason. Stored per round
 * because a case may be unblocked in a later round.
 */
export interface BlockedInfo {
  reason: string;
  blockedAt: string;
}

/**
 * Structured AI bug analysis, so the UI can render each part separately and the content can be reused
 * as the Backlog issue description.
 */
export interface BugAnalysis {
  rootCause: string;
  fixApproach: string;
  actionItems: string[];
  estimate: string;
}

/**
 * How often a bug reproduced across a function's rounds (the "occurrence rate" in the bug report).
 * `ranRounds` counts only rounds where this case actually has a result: a round may re-run only some
 * cases, and counting the others would make the rate look artificially low.
 */
export interface BugOccurrence {
  /** Rounds where this case failed, ascending. */
  failedRounds: number[];
  /** Number of rounds where this case has a result (pass or fail). */
  ranRounds: number;
}

/** The Backlog project connected for the whole workspace, stored in `.aitest/backlog.json`. */
export interface BacklogProjectConfig {
  spaceKey: string;
  projectId: number;
  projectKey: string;
  projectName: string;
  /** issueTypeId of the project's "Bug" type, looked up once when connecting. */
  bugIssueTypeId: number;
  bugIssueTypeName: string;
  /** Default priorityId (see pickDefaultPriority). */
  defaultPriorityId: number;
  defaultPriorityName: string;
  /** Short description entered in Project Settings. Backlog projects have no description field, so it
   * is stored locally only. */
  description?: string;
}

/** The Backlog issue created for a bug, stored next to the bug report to avoid duplicate uploads. */
export interface BacklogUploadedTask {
  issueId: number;
  issueKey: string;
  url: string;
  uploadedAt: string;
}

export interface RunResult {
  total: number;
  passed: number;
  failed: number;
  tests: TestResultDetail[];
  /** true if the Playwright process crashed mid-run (e.g. OOM, a config error killing workers). `tests`
   * is then salvaged from `live-progress.json`, written as each test finishes, because the final JSON
   * report was never produced. */
  crashed?: boolean;
  crashMessage?: string;
  /** true if the user stopped the round. `tests` is salvaged like a crash, but the UI should show a
   * neutral message rather than an error. */
  stoppedByUser?: boolean;
}

export type ScheduleType = 'once' | 'daily' | 'weekly' | 'monthly';

/** Scheduled test run for a function. Only fires while VS Code is open (no OS-level cron). */
export interface Schedule {
  id: string;
  functionId: string;
  type: ScheduleType;
  /** "HH:mm" */
  time: string;
  /** "YYYY-MM-DD", only for type 'once'. */
  date?: string;
  /** 0 (Sunday) to 6 (Saturday), only for type 'weekly'. */
  dayOfWeek?: number;
  /** 1-31, only for type 'monthly'; clamped to the last day of shorter months. */
  dayOfMonth?: number;
  /** ISO timestamp, recomputed after each fire; 'once' schedules are deleted after firing instead. */
  nextFireAt: string;
}
