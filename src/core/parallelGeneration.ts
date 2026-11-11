import { FunctionSpec, TestCase, TestSuite } from '../types';
import {
  buildApiScriptsFromTestCasesPrompt,
  buildFunctionApiPrompt,
  buildFunctionUiPrompt,
  buildUiScriptsFromTestCasesPrompt,
  generateTestSuite
} from './testSuiteGenerator';
import { scanScreenFields } from './domScanner';

export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_CONCURRENCY = 4;

export type JobStatus = 'pending' | 'running' | 'done' | 'error';
export type JobLane = 'api' | 'ui';

/** A job that ended in error (jobs never throw, see runJobs). Collected in TestSuiteResult.failed so the
 * caller knows what was generated and which jobs to re-run. */
export interface FailedJob {
  batchTag: string;
  lane: JobLane;
  error: string;
}

export interface TestSuiteResult extends TestSuite {
  failed: FailedJob[];
}

export interface JobProgress {
  batchTag: string;
  lane: JobLane;
  status: JobStatus;
  /** Only when status = 'done': number of test cases the job generated. */
  caseCount?: number;
  /**
   * Only when status = 'done': the generated test cases, so the dashboard can show per-test-case rows.
   * They can't be known earlier — Claude returns the whole batch at once.
   */
  testCases?: TestCase[];
}

export type OnJobProgress = (progress: JobProgress) => void;

/** Result of a single job, fired as soon as that job settles (success or error), before the others finish.
 * Separate from OnJobProgress (dashboard only) because this one is used to persist results immediately
 * (see applyTestCaseJobResult in extension.ts). */
export interface JobSettledInfo {
  batchTag: string;
  lane: JobLane;
  /** Only in the "generate from existing test cases" flow, where ids are known before calling the LLM —
   * identifies which test cases a failed job covered, since an error response carries no ids. */
  testCaseIds?: string[];
  outcome: { ok: true; testCases: TestCase[]; scripts: TestSuite['scripts'] } | { ok: false; error: string };
}

export type OnJobSettled = (info: JobSettledInfo) => void;

export interface ConcurrencyOptions {
  /** Max endpoints/fields per Claude call — smaller batches keep prompts short and parallelize better. */
  batchSize?: number;
  /** Max concurrent jobs (each job is a separate `claude -p` process). */
  concurrency?: number;
  cwd?: string;
  /** Called whenever a job changes status (pending/running/done/error), for the live dashboard. */
  onProgress?: OnJobProgress;
  /** Called when each job settles (see JobSettledInfo), to persist without waiting for the whole batch. */
  onJobSettled?: OnJobSettled;
  /** Model override for every Claude CLI call in this batch (see callClaudeCli); empty uses the default. */
  model?: string;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0 || items.length === 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Runs up to `limit` workers pulling from a shared queue (`cursor`), instead of firing everything with
 * Promise.all. Each job spawns its own `claude -p` process (see claudeCliClient.ts), so this caps the
 * number of concurrent processes when there are dozens or hundreds of batches.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runNext(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}

function withBatchIdPrefix(prompt: string, batchTag: string): string {
  return `${prompt}\n\nIMPORTANT:
- Every "id" in testCases MUST start with the prefix "${batchTag}-" (e.g. "${batchTag}-01") so it doesn't collide with other batches generated in parallel.
- Each Playwright test title MUST start with "[<id>] " using that exact id, e.g. test('[${batchTag}-01] Create valid user', ...) — so the system can match test results (pass/fail) to the right test case in testCases.`;
}

interface GenerationJob {
  batchTag: string;
  lane: JobLane;
  prompt: string;
  /** Only set by generateScriptsFromTestCasesParallel (ids known up front) — see JobSettledInfo. */
  testCaseIds?: string[];
  /**
   * true in generateScriptsFromTestCasesParallel: fileName is already fixed and unique per id
   * ("UI-<id>.spec.ts", see scriptFileNameForTestCase). A batchTag prefix would produce
   * "SCRIPT-1-UI-<id>.spec.ts", which no longer matches testMatch (/^UI-.*\.spec\.ts$/) in
   * playwright.config.ts, so Playwright would find 0 tests.
   */
  skipFileNamePrefix?: boolean;
}

type JobOutcome =
  | { ok: true; testCases: TestCase[]; scripts: TestSuite['scripts'] }
  | { ok: false; batchTag: string; lane: JobLane; error: string };

/**
 * Runs generation jobs concurrently and merges their results. Script fileNames get a batchTag prefix so
 * batches never overwrite each other even if the AI picks the same name (independent parallel jobs can't
 * be trusted to pick unique names), except for jobs with `skipFileNamePrefix` (see GenerationJob).
 *
 * Reports 'pending' for every job up front (so the dashboard shows all rows immediately), then 'running'
 * when a worker picks the job up, and 'done'/'error' when it finishes.
 *
 * Jobs never throw out of `runWithConcurrency`: one failure (CLI crash, invalid JSON...) would otherwise
 * reject the whole Promise.all and discard every other job's results. Each job catches its own error and
 * returns a `JobOutcome`; this function always resolves, merges successful jobs, and lists the rest in
 * `failed`.
 */
async function runJobs(
  jobs: GenerationJob[],
  concurrency: number,
  cwd?: string,
  onProgress?: OnJobProgress,
  onJobSettled?: OnJobSettled,
  model?: string
): Promise<TestSuiteResult> {
  for (const job of jobs) {
    onProgress?.({ batchTag: job.batchTag, lane: job.lane, status: 'pending' });
  }

  const perJob = await runWithConcurrency(jobs, concurrency, async (job): Promise<JobOutcome> => {
    onProgress?.({ batchTag: job.batchTag, lane: job.lane, status: 'running' });
    try {
      const suite = await generateTestSuite(job.prompt, cwd, model);
      const scripts = job.skipFileNamePrefix
        ? suite.scripts
        : suite.scripts.map((s) => ({ ...s, fileName: `${job.batchTag}-${s.fileName}` }));
      onProgress?.({
        batchTag: job.batchTag,
        lane: job.lane,
        status: 'done',
        caseCount: suite.testCases.length,
        testCases: suite.testCases
      });
      onJobSettled?.({ batchTag: job.batchTag, lane: job.lane, testCaseIds: job.testCaseIds, outcome: { ok: true, testCases: suite.testCases, scripts } });
      return { ok: true, testCases: suite.testCases, scripts };
    } catch (err) {
      const error = (err as Error).message;
      onProgress?.({ batchTag: job.batchTag, lane: job.lane, status: 'error' });
      onJobSettled?.({ batchTag: job.batchTag, lane: job.lane, testCaseIds: job.testCaseIds, outcome: { ok: false, error } });
      return { ok: false, batchTag: job.batchTag, lane: job.lane, error };
    }
  });

  const failed: FailedJob[] = [];
  const testCases: TestCase[] = [];
  const scripts: TestSuite['scripts'] = [];
  for (const result of perJob) {
    if (result.ok) {
      testCases.push(...result.testCases);
      scripts.push(...result.scripts);
    } else {
      failed.push({ batchTag: result.batchTag, lane: result.lane, error: result.error });
    }
  }

  return { testCases, scripts, failed };
}

/**
 * Function Spec API lane: batches each endpoint's RequestBody fields, plus one dedicated non-functional job
 * (non-functional rules don't belong to any field). The non-functional job has its requestBody.fields
 * cleared so fields aren't repeated.
 */
export async function generateFunctionApiSuiteParallel(
  spec: FunctionSpec,
  authHeader?: string,
  opts: ConcurrencyOptions = {}
): Promise<TestSuiteResult> {
  const { batchSize = DEFAULT_BATCH_SIZE, concurrency = DEFAULT_CONCURRENCY, cwd, onProgress, onJobSettled, model } = opts;
  const jobs: GenerationJob[] = [];
  let batchCounter = 0;

  for (const endpoint of spec.endpoints) {
    const fields = (endpoint.requestBody as { fields?: string[] } | undefined)?.fields ?? [];
    for (const fieldBatch of chunkArray(fields, batchSize)) {
      batchCounter += 1;
      const batchTag = `API-${batchCounter}`;
      const subSpec: FunctionSpec = {
        ...spec,
        endpoints: [{ ...endpoint, requestBody: { fields: fieldBatch } }],
        nonFunctionalRules: []
      };
      jobs.push({ batchTag, lane: 'api', prompt: withBatchIdPrefix(buildFunctionApiPrompt(subSpec, authHeader), batchTag) });
    }
  }

  if (spec.nonFunctionalRules.length > 0) {
    batchCounter += 1;
    const batchTag = `API-NF-${batchCounter}`;
    const nfSpec: FunctionSpec = {
      ...spec,
      endpoints: spec.endpoints.map((e) => ({ ...e, requestBody: { fields: [] } })),
      functionalRules: []
    };
    jobs.push({ batchTag, lane: 'api', prompt: withBatchIdPrefix(buildFunctionApiPrompt(nfSpec, authHeader), batchTag) });
  }

  return runJobs(jobs, concurrency, cwd, onProgress, onJobSettled, model);
}

/**
 * Function Spec UI lane: batches screen fields and generates in parallel.
 * Scans the real DOM at screenUrl once (not per batch) to attach a domHint to each field, giving the LLM
 * ground truth about widgets instead of guessing from the declared type (see domScanner.ts). A failed
 * scan (app not running, browser not installed...) doesn't block generation; the hints are just omitted.
 */
export async function generateFunctionUiSuiteParallel(
  spec: FunctionSpec,
  opts: ConcurrencyOptions = {}
): Promise<TestSuiteResult> {
  const { batchSize = DEFAULT_BATCH_SIZE, concurrency = DEFAULT_CONCURRENCY, cwd, onProgress, onJobSettled, model } = opts;
  const hints = await scanScreenFields(spec.screenUrl, spec.fields);
  const fields = spec.fields.map((f) => (hints[f.name] ? { ...f, domHint: hints[f.name] } : f));
  const jobs = chunkArray(fields, batchSize).map((batch, i) => {
    const batchTag = `UI-${i + 1}`;
    const subSpec: FunctionSpec = { ...spec, fields: batch };
    return { batchTag, lane: 'ui' as const, prompt: withBatchIdPrefix(buildFunctionUiPrompt(subSpec), batchTag) };
  });
  return runJobs(jobs, concurrency, cwd, onProgress, onJobSettled, model);
}

/** Base URL + auth header for the API lane of generateScriptsFromTestCasesParallel. Only needed when the
 * batch has kind='api' test cases (see ensureApiConfig in extension.ts, asked once per function). */
export interface ApiTestCaseConfig {
  baseUrl: string;
  authHeader?: string;
}

/**
 * "Generate scripts from existing test cases" flow (see testCaseMarkdownLoader.ts). `testCases` must
 * already be filtered to the changed (new/edited) ones via diffTestCases in the caller, so unchanged cases
 * cost no LLM call and keep their scripts.
 *
 * Two lanes: kind='ui' (default) drives the screen via `screenUrl`/`credential`; kind='api' (ids starting
 * with "API", see parseTestCaseRow) sends real requests via `apiConfig`. Without `apiConfig` (no Base URL
 * yet), API cases are not sent to the LLM (the call would surely be wrong); they're reported as failed via
 * `onJobSettled`/`failed` so `applyTestCaseJobResult` sets `lastScriptGenError` and the next Sync Test
 * retries them once a Base URL exists.
 *
 * withBatchIdPrefix is not used here: ids are QA-authored and already unique in the source document, and a
 * batch prefix would break id matching everywhere (fixed per-id fileName, incremental diff, retest by id).
 */
export async function generateScriptsFromTestCasesParallel(
  testCases: TestCase[],
  screenUrl: string,
  opts: ConcurrencyOptions = {},
  credential?: string,
  apiConfig?: ApiTestCaseConfig
): Promise<TestSuiteResult> {
  const { batchSize = DEFAULT_BATCH_SIZE, concurrency = DEFAULT_CONCURRENCY, cwd, onProgress, onJobSettled, model } = opts;

  const uiCases = testCases.filter((tc) => tc.kind !== 'api');
  const apiCases = testCases.filter((tc) => tc.kind === 'api');

  const uiJobs = chunkArray(uiCases, batchSize).map((batch, i) => ({
    batchTag: `SCRIPT-UI-${i + 1}`,
    lane: 'ui' as const,
    prompt: buildUiScriptsFromTestCasesPrompt(batch, screenUrl, credential),
    testCaseIds: batch.map((tc) => tc.id),
    skipFileNamePrefix: true
  }));

  const apiJobs = apiConfig
    ? chunkArray(apiCases, batchSize).map((batch, i) => ({
        batchTag: `SCRIPT-API-${i + 1}`,
        lane: 'api' as const,
        prompt: buildApiScriptsFromTestCasesPrompt(batch, apiConfig.authHeader),
        testCaseIds: batch.map((tc) => tc.id),
        skipFileNamePrefix: true
      }))
    : [];

  const result = await runJobs([...uiJobs, ...apiJobs], concurrency, cwd, onProgress, onJobSettled, model);

  if (!apiConfig && apiCases.length > 0) {
    const batchTag = 'SCRIPT-API-NO-BASEURL';
    const error = 'Missing Base URL for the API lane — provide a Base URL before generating scripts for these API test cases.';
    const testCaseIds = apiCases.map((tc) => tc.id);
    onProgress?.({ batchTag, lane: 'api', status: 'error' });
    onJobSettled?.({ batchTag, lane: 'api', testCaseIds, outcome: { ok: false, error } });
    result.failed.push({ batchTag, lane: 'api', error });
  }

  return result;
}
