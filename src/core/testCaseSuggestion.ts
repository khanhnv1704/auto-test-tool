import { SuggestedTestCase, TestCase } from '../types';

/**
 * Gap-review prompt. Unlike the generation prompts it writes no scripts; it only suggests NEW test
 * cases for QA to review before adding them to the source file (see appendTestCasesToMarkdown in
 * testCaseMarkdownLoader.ts). Runs on demand from its own command, not after every Generate.
 */
export function buildMissingTestCasesPrompt(existingTestCases: TestCase[], functionId: string): string {
  const existingBlocks = existingTestCases
    .map((tc) => `- [${tc.id}] ${tc.name} (${tc.severity}) — ${tc.steps.join(' → ')}`)
    .join('\n');

  return `
You review test coverage gaps for the function "${functionId}".

EXISTING test cases (do not suggest duplicates of these):
${existingBlocks || '(no test cases yet)'}

Find the test cases MISSING from the list above, grouped into 4 categories:
- Core logic (functional): important business flows/branches not yet tested.
- Non-functional: security, authorization, data integrity (e.g. race conditions on double submit, data
  getting out of sync between steps).
- Performance: NOTE — this is NOT real load testing/benchmarking (Playwright is not a load-testing tool);
  only suggest cases about response time/loading states that are OBSERVABLE in the UI (e.g. "shows a
  loading spinner while submitting", "the button cannot be clicked twice while waiting for the response").
- Security: injection (SQL/XSS), bypassing client-side validation by calling the API directly, sensitive
  data leaking in responses.

For EACH suggested test case, fill in the full structure: id (a new id, not clashing with any id
above), name, severity (Low/Medium/High/Critical), precondition, steps (array of concrete steps),
dataTest, expectedResult, isEdgeCase (true/false), kind always "ui", and "reason" — one short sentence
explaining WHY this case is missing (e.g. "no case tests the boundary values of field X"), so the user
can read the reason before deciding which cases to add.

Respond with ONLY one valid JSON object — no markdown fence, no explanation — matching this schema:
{
  "suggestions": [
    {
      "id": string,
      "name": string,
      "kind": "ui",
      "target": string,
      "severity": "Low" | "Medium" | "High" | "Critical",
      "precondition": string,
      "steps": [string],
      "dataTest": string,
      "expectedResult": string,
      "isEdgeCase": boolean,
      "reason": string
    }
  ]
}
`.trim();
}

/**
 * Parses Claude's reply to the prompt above. Separate from parseAiResponse (testSuiteGenerator.ts)
 * because the contract differs ({ suggestions } instead of { testCases, scripts }).
 */
export function parseMissingTestCasesResponse(raw: string): SuggestedTestCase[] {
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

  if (typeof data !== 'object' || data === null || !Array.isArray((data as Record<string, unknown>).suggestions)) {
    throw new Error('AI response does not match the expected { suggestions } schema');
  }

  return (data as { suggestions: SuggestedTestCase[] }).suggestions;
}
