import * as path from 'path';
import { BugAnalysis, BugOccurrence, TestCase, TestKind } from '../types';

const NO_TEST_CASE = '(no matching original test case found)';

export interface BugAnalysisInput {
  testName: string;
  errorMessage: string;
  testCase?: TestCase;
}

/**
 * Bug-investigation prompt, run on demand from bugDetailPanel.ts. Returns a JSON contract (not free
 * markdown) so the UI can render each part separately and the same text can be reused verbatim in the
 * Backlog description (see buildBacklogDescription below).
 */
export function buildBugAnalysisPrompt(input: BugAnalysisInput): string {
  const { testName, errorMessage, testCase } = input;

  const testCaseBlock = testCase
    ? `
Original test case:
- Severity: ${testCase.severity}
- Precondition: ${testCase.precondition}
- Steps: ${testCase.steps.join(' → ')}
- Data test: ${testCase.dataTest}
- Expected result: ${testCase.expectedResult}`.trim()
    : NO_TEST_CASE;

  return `
You are a senior QA/Dev engineer investigating a failed Playwright test case.

Test: ${testName}
Recorded error:
${errorMessage}

${testCaseBlock}

Analyze it and respond with ONLY one valid JSON object — no markdown fence, no explanation outside
the JSON — matching this schema:
{
  "rootCause": string,
  "fixApproach": string,
  "actionItems": [string],
  "estimate": string
}

How to fill each field:
- "rootCause": clearly distinguish a bug in the TEST SCRIPT (e.g. wrong locator, missing wait for load,
  wrong assumption about a condition) from a REAL bug in the application (e.g. wrong validation,
  malformed response, race condition) — reason concretely from the error message and the test case
  context, not generically. If other features/business flows are likely affected by the SAME root
  cause, mention them in this field too.
- "fixApproach": a concrete fix — for an application bug, suggest where to fix it (e.g. "review the
  server-side validation logic for field X"); for a script bug, suggest what to change in the script.
- "actionItems": list of concrete tasks to finish the fix and verify it (e.g. "add schema validation
  in the middleware", "re-run TC-04 after the fix"), one short sentence each.
- "estimate": estimated effort to fix + verify, kept short (e.g. "Dev ~2h · QA verify ~1h").
`.trim();
}

/** Parses Claude's reply to the prompt above, same approach as parseAiResponse/parseMissingTestCasesResponse. */
export function parseBugAnalysisResponse(raw: string): BugAnalysis {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`AI response is not valid JSON: ${(err as Error).message}`);
  }

  const obj = data as Partial<BugAnalysis> | null;
  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof obj.rootCause !== 'string' ||
    typeof obj.fixApproach !== 'string' ||
    !Array.isArray(obj.actionItems) ||
    typeof obj.estimate !== 'string'
  ) {
    throw new Error('AI response does not match the expected { rootCause, fixApproach, actionItems, estimate } schema');
  }

  return obj as BugAnalysis;
}

/** Context of the run that produced the bug, for the "Test Environment" section. Every field is
 * optional because bugs from older rounds may lack any of them. */
export interface BugEnvironment {
  functionId?: string;
  round?: number;
  kind?: TestKind;
  /** Base URL configured for the function (screenUrl for UI, apiBaseUrl for API). Note: if the user
   * overrode the base URL in the "Run Tests" form, this is not the URL actually used — rounds do not
   * record it. */
  baseUrl?: string;
  /** ISO timestamp when the test case started (TestResultDetail.startedAt). */
  startedAt?: string;
}

export interface BugReportContent {
  testName: string;
  errorMessage: string;
  testCase?: TestCase;
  analysis?: BugAnalysis;
  environment?: BugEnvironment;
  occurrence?: BugOccurrence;
  /** Absolute paths of evidence files attached to the issue. The description prints only file names:
   * paths on the tester's machine mean nothing to issue readers. */
  evidencePaths?: string[];
}

/**
 * Machine local time with an explicit UTC offset ("YYYY-MM-DD HH:mm:ss (UTC+07:00)"), so readers in
 * other time zones can interpret it unambiguously.
 */
function formatRunTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`;
}

function environmentLines(testName: string, environment?: BugEnvironment, testCase?: TestCase): string[] {
  const kind = environment?.kind ?? testCase?.kind;
  const lines = [`- Test: ${testName}`];

  if (environment?.functionId) lines.push(`- Function: ${environment.functionId}`);
  if (environment?.round !== undefined) lines.push(`- Round: ${environment.round}`);
  if (kind) lines.push(`- Test type: ${kind === 'api' ? 'API' : 'UI (screen)'}`);
  if (environment?.baseUrl) lines.push(`- Base URL: ${environment.baseUrl}`);
  if (environment?.startedAt) lines.push(`- Run time: ${formatRunTime(environment.startedAt)}`);
  lines.push(
    kind === 'ui' ? '- Tool: Playwright (Chromium — Desktop Chrome)' : '- Tool: Playwright (HTTP request)'
  );

  return lines;
}

/** Some steps in testcases.json are already numbered ("1. Select..."), some are not — number the
 * unnumbered ones so devs read them in order, without double-numbering the others. */
function numberSteps(steps: string[]): string[] {
  return steps.map((step, i) => (/^\s*\d+\s*[.)]/.test(step) ? step.trim() : `${i + 1}. ${step.trim()}`));
}

function formatOccurrence(occurrence?: BugOccurrence): string {
  if (!occurrence || occurrence.ranRounds === 0) return '(no round history yet)';
  const { failedRounds, ranRounds } = occurrence;
  const percent = Math.round((failedRounds.length / ranRounds) * 100);
  const detail = failedRounds.length > 0 ? ` — failed in rounds ${failedRounds.join(', ')}` : '';
  return `${failedRounds.length}/${ranRounds} rounds run (${percent}%)${detail}`;
}

function evidenceLines(evidencePaths?: string[]): string[] {
  if (!evidencePaths || evidencePaths.length === 0) return ['(no evidence attached)'];
  return evidencePaths.map((p) => `- ${path.basename(p)} (attached to this issue)`);
}

/**
 * Builds the Backlog issue description from the run result, the original test case and the AI analysis,
 * following a bug-report template (Test Environment / Preconditions / Steps / Actual / Expected /
 * Occurrence rate / Evidence, then a "Developer fix" section). Shared by uploadBugToBacklog
 * (extension.ts) and the preview in bugDetailPanel.ts so both always show the same content.
 *
 * The AI analysis goes in its own block between the two parts, never into "Developer fix": that
 * section is the developer's own conclusion after reading the code, and pre-filling it with AI guesses
 * could be mistaken for a confirmed root cause.
 */
export function buildBacklogDescription(content: BugReportContent): string {
  const { testName, errorMessage, testCase, analysis, environment, occurrence, evidencePaths } = content;

  const lines: string[] = [
    '# Bug report',
    '',
    '## Test Environment',
    ...environmentLines(testName, environment, testCase),
    '',
    '## Preconditions',
    testCase?.precondition || NO_TEST_CASE,
    '',
    '## Steps',
    ...(testCase ? numberSteps(testCase.steps) : [NO_TEST_CASE])
  ];

  if (testCase?.dataTest) lines.push('', `Data test: ${testCase.dataTest}`);

  lines.push(
    '',
    '## Actual results',
    '```',
    errorMessage,
    '```',
    '',
    '## Expected results',
    testCase?.expectedResult || NO_TEST_CASE,
    '',
    '## Occurrence rate (if any)',
    formatOccurrence(occurrence),
    '',
    '## Evidence (if any)',
    ...evidenceLines(evidencePaths),
    ''
  );

  if (analysis) {
    lines.push(
      '# Automated analysis (AI Auto Test)',
      '',
      '## Root cause (AI analysis)',
      analysis.rootCause,
      '',
      '## Suggested fix',
      analysis.fixApproach,
      '',
      '## Action items',
      ...analysis.actionItems.map((item) => `- ${item}`),
      '',
      '## Effort estimate',
      analysis.estimate,
      ''
    );
  }

  lines.push(
    '# Developer fix',
    '',
    '## Root cause:',
    '',
    '## Changes made:',
    '',
    '## Related issues:',
    '',
    '## Impact scope:',
    '',
    '## Pull request',
    '',
    '## Verification after the fix',
    ''
  );

  return lines.join('\n');
}
