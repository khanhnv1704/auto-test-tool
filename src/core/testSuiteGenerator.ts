import { FunctionSpec, TestCase, TestKind, TestSuite } from '../types';
import { callClaudeCli } from './claudeCliClient';
import { sanitizeId } from './testRunner';

const OUTPUT_CONTRACT = `
Respond with ONLY one valid JSON object — no markdown fence, no explanation — matching this schema:
{
  "testCases": [
    {
      "id": string,
      "name": string,
      "kind": "api" | "ui",
      "category": "functional" | "non-functional",
      "target": string,
      "severity": "Low" | "Medium" | "High" | "Critical",
      "precondition": string,
      "steps": [string],
      "dataTest": string,
      "expectedResult": string,
      "isEdgeCase": boolean
    }
  ],
  "scripts": [
    { "fileName": string, "content": string }
  ]
}

How to fill the testCases fields (following the standard test case template):
- "severity": High/Critical for required-field, security and data-integrity cases; Medium for format/boundary validation; Low for cosmetic/display cases.
- "precondition": what must be true before running the case (e.g. "The screen is open", "A record with the same email already exists in the DB"); use "-" if there is none.
- "steps": array of concrete actions, in order, matching the actual actions in the Playwright script below.
- "dataTest": the concrete test data value (e.g. "-10", "\\"abc\\"", "empty"); use "-" if the case needs no input.
- "expectedResult": the concrete expected result (status code + message, or UI behavior); it MUST match the actual assertion in the script.
`.trim();

/** Inputs may be in any language; locators and expected messages must keep the app's own wording. */
const LANGUAGE_RULE = `
Test cases and specs may be written in any language. Use the on-screen wording they give as-is for locators and expected messages — do not translate it.`.trim();

/**
 * Both lanes capture red-boxed, annotated evidence for EVERY test case, not only failures: evidence
 * shows what was confirmed, not just debug output. The capture/highlight logic is fixed in
 * templates/evidence.ts (written next to the scripts as `support/evidence.ts`), so the model only calls
 * the helper with the right arguments and every run produces evidence the same way.
 */
const UI_EVIDENCE_CONVENTION = `
- import { captureUiEvidence } from './support/evidence'
- test('...', async ({ page }, testInfo) => { ... })
- Right after each test case's main assertion (usually expect(...).toBeVisible() for a validation message), call:
  await captureUiEvidence({ page, testInfo, locator: <the exact locator you just asserted>, tcId: '<id matching this test case's "id" in testCases[]>', testTitle: testInfo.title, note: '<exactly this test case's Expected text>' });
- Do NOT draw boxes or take screenshots any other way — always go through captureUiEvidence.`.trim();

const API_EVIDENCE_CONVENTION = `
- import { captureApiEvidence } from './support/evidence'
- test('...', async ({ request, page }, testInfo) => { ... }) — \`page\` is there ONLY to capture evidence (captureApiEvidence renders it via page.setContent). Do NOT use page to call the API or navigate the real app; API calls must still go through request.post/get/put/delete.
- Right after you have the response, call:
  await captureApiEvidence({ page, testInfo, response, method: '<the method just called, e.g. "POST">', requestBody: '<JSON.stringify of the payload just sent, or "-" if the request has no body (e.g. GET)>', tcId: '<id matching this test case's "id" in testCases[]>', testTitle: testInfo.title, highlightField: '<"status" or the response body field being asserted, e.g. "error.message">', note: '<exactly what is being confirmed, e.g. "Expect 400 and the message Invalid email">' });
- Do NOT draw boxes or take screenshots any other way — always go through captureApiEvidence.`.trim();

/**
 * Relative path (pathname + search + hash) of a full URL. Generated scripts use this path instead of an
 * absolute URL so Playwright prepends the baseURL configured for the "ui"/"api" project
 * (AITEST_WEB_BASE_URL/AITEST_API_BASE_URL). That way a run can target another environment without
 * regenerating scripts. Input that is already relative is kept as-is, with a leading "/" ensured.
 */
export function toRelativePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || '/';
  } catch {
    return url.startsWith('/') ? url : `/${url}`;
  }
}

/**
 * API-lane prompt for a Function Spec (see functionSpecLoader.ts). It must cover far more than the UI
 * lane: functional rules per field plus cross-field conditions, and non-functional rules (security,
 * authorization, data integrity) that neither an OpenAPI schema nor the screen expresses.
 */
export function buildFunctionApiPrompt(spec: FunctionSpec, authHeader?: string): string {
  const endpointBlocks = spec.endpoints
    .map((e) => {
      const fields = (e.requestBody as { fields?: string[] } | undefined)?.fields ?? [];
      return [
        `Endpoint: ${e.key}`,
        e.security ? 'Requires a Bearer token.' : 'No authentication required.',
        fields.length ? `RequestBody fields:\n- ${fields.join('\n- ')}` : null,
        `Responses: ${JSON.stringify(e.responses ?? {}, null, 2)}`
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return `
You are an automated test generator for API testing and validation testing.
Function under test: ${spec.functionId}

${authHeader ? `Auth header: ${authHeader}` : ''}

${endpointBlocks}

Business rules — Functional (per-field validation plus cross-field/conditional rules, e.g. field A is required depending on the value of field B):
- ${spec.functionalRules.join('\n- ') || '(none)'}

Business rules — Non-Functional (security, authorization, data integrity):
- ${spec.nonFunctionalRules.join('\n- ') || '(none)'}

IMPORTANT — the API lane must generate MANY MORE and BROADER test cases than the UI lane for the same function, because the API is where every rule is actually enforced, not just what the screen shows:
- Functional: for EVERY field in the RequestBody — missing required field, wrong type/format, boundary violations (min/max), invalid enum value, and every cross-field/conditional rule listed above (not just one representative case — cover every condition branch, e.g. one case for gender=MALE and one for gender=FEMALE).
- Non-Functional: a dedicated test for each non-functional rule above — call with a missing/invalid Bearer token (expect 401/403), send special characters/SQL injection/XSS in text fields (expect rejection or safe storage, never execution), send a duplicate value for a unique field (expect rejection per the rule).
- Set "category": "functional" or "category": "non-functional" on each test case according to the groups above.

${LANGUAGE_RULE}

Generate Playwright Test scripts using the built-in \`request\` fixture (do NOT open a browser to call the API, do NOT call request.newContext — the request fixture is already a context; call request.post/get/put/delete directly), following these conventions:
- import { test, expect } from '@playwright/test'
- call request.post/get/put/delete directly with EXACTLY the relative path from the Endpoint key above (e.g. request.post('/api/customers')) — do NOT build the base URL yourself; Playwright already has baseURL configured for the "api" project and prepends it
- each test case is its own test(...) block with a clear, descriptive name
${API_EVIDENCE_CONVENTION}

${OUTPUT_CONTRACT}
`.trim();
}

/**
 * UI-lane prompt for a Function Spec — ONLY test cases for fields actually shown on screen (no
 * non-functional cases; those belong to buildFunctionApiPrompt). Fields with "showIf" get dedicated
 * cases confirming which fields show/hide for each value of the controlling field.
 */
export function buildFunctionUiPrompt(spec: FunctionSpec): string {
  const fieldBlocks = spec.fields
    .map((f) => {
      const parts = [`- ${f.name} (${f.type}, ${f.required ? 'required' : 'optional'})`];
      if (f.constraint) parts.push(`  constraint: ${f.constraint}`);
      if (f.showIf) parts.push(`  shown only when: ${f.showIf}`);
      if (f.domHint) parts.push(`  Scanned DOM: ${f.domHint}`);
      return parts.join('\n');
    })
    .join('\n');

  return `
You are a generator of test cases + Playwright scripts for UI validation tests.
Function under test: ${spec.functionId}
Screen path (navigate with page.goto('${toRelativePath(spec.screenUrl)}') — use EXACTLY this relative path, NOT an absolute URL; Playwright already has baseURL configured for the "ui" project): ${toRelativePath(spec.screenUrl)}

Fields on the screen:
${fieldBlocks}

Business rules related to the fields on the screen:
- ${spec.functionalRules.join('\n- ') || '(none)'}

IMPORTANT — the UI lane is much narrower than the API lane; generate test cases ONLY for what the user sees and does on the screen:
- For each visible field: test leaving it empty (if required), entering an invalid format, and that the validation message appears in the right place.
- For fields with "shown only when" (a condition): generate a separate test case for EACH value of the controlling field, confirming exactly which fields show/hide when that value is selected (e.g. selecting Gender=Male shows the Male-only field and hides the Female-only field, and vice versa).
- Do NOT generate security/authorization/injection test cases — those belong to the API lane.
- Every test case in this lane has "category": "functional".

${LANGUAGE_RULE}

Script conventions:
- import { test, expect } from '@playwright/test'
- each test case is its own test(...) block
- use semantic locators (getByRole/getByLabel/getByText) matching the given field names exactly; do NOT invent CSS selectors or data-testid
- A field with a "Scanned DOM" line is ground truth taken from the real app — you MUST use the matching action, overriding any guess from the declared type above: <select> → .selectOption(...); custom combobox (role="combobox", e.g. the shadcn/ui Select component — NOT a native <select>) → open it via getByRole('combobox', { name }).click() then click the option via getByRole('option', { name: <value> }).click(), NEVER use .selectOption() for this kind; input type="checkbox" → .check()/.uncheck(); input type="radio" → getByRole('radio', { name }).check(); input type="date" (the browser's native date picker) → \`.fill()\` MUST use ISO format "yyyy-mm-dd" (convert if the constraint/business rule uses dd/mm/yyyy); anything else → .fill(...). Only fields WITHOUT this line may have their locator/action inferred from the declared type.
${UI_EVIDENCE_CONVENTION}

${OUTPUT_CONTRACT}
`.trim();
}

/**
 * Fixed script file name per test case — never left to the LLM, so files can be reliably matched or
 * deleted when a test case changes or is removed. The "UI-"/"API-" prefix follows `kind` so the file
 * matches the testMatch of the right Playwright project; a wrong prefix would run it in the wrong
 * project (no `request` fixture with the right baseURL) or in none at all.
 */
export function scriptFileNameForTestCase(testCaseId: string, kind: TestKind): string {
  const prefix = kind === 'api' ? 'API' : 'UI';
  return `${prefix}-${sanitizeId(testCaseId)}.spec.ts`;
}

/**
 * Forces the FIRST `test(...)` title in a script to start with `[<id>] `. The prompt asks for it, but
 * cheaper models (e.g. Haiku) sometimes drop the bracket, and both script-status tracking
 * (listScriptedTestCaseIds) and result matching (extractTestId) silently fall back to "not found" /
 * the raw title without it. Only the first title is fixed: each script in this flow has exactly one test.
 */
export function ensureBracketedTestTitle(content: string, testCaseId: string): string {
  const match = /test\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(content);
  if (!match) return content;

  const [full, quote, title] = match;
  if (title.startsWith(`[${testCaseId}]`)) return content;

  const escapedId = testCaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutStaleBracket = title
    .replace(/^\[[^\]]*]\s*/, '') // bracket with the wrong id, if any
    .replace(new RegExp(`^${escapedId}\\s+`), ''); // unbracketed id repeated at the start of the title
  const replacement = `test(${quote}[${testCaseId}] ${withoutStaleBracket}${quote}`;
  return content.slice(0, match.index) + replacement + content.slice(match.index + full.length);
}

/**
 * UI-lane prompt for generating scripts from existing QA test cases (kind='ui', loaded by
 * testCaseMarkdownLoader.ts). Unlike the Function Spec prompts, the LLM must not add or drop test cases;
 * it only (1) classifies each one as "automatable" or "manual" and (2) writes exactly one script per
 * automatable case. It reuses the {testCases, scripts} contract, but testCases must echo the input ids
 * (plus automationStatus/automationNote) rather than new cases.
 */
export function buildUiScriptsFromTestCasesPrompt(testCases: TestCase[], screenUrl: string, credential?: string): string {
  const caseBlocks = testCases
    .map((tc) => {
      const parts = [
        `- id: ${tc.id}`,
        `  name: ${tc.name}`,
        `  severity: ${tc.severity}`,
        `  precondition: ${tc.precondition}`,
        `  steps:\n${tc.steps.map((s) => `    ${s}`).join('\n')}`,
        `  dataTest: ${tc.dataTest}`,
        `  expectedResult: ${tc.expectedResult}`,
        `  fileName if automatable (you MUST use exactly this name, do NOT choose another): ${scriptFileNameForTestCase(tc.id, 'ui')}`
      ];
      return parts.join('\n');
    })
    .join('\n\n');

  return `
You generate Playwright scripts for UI validation tests FROM AN EXISTING SET OF TEST CASES.
Screen path (navigate with page.goto('${toRelativePath(screenUrl)}') — use EXACTLY this relative path, NOT an absolute URL; Playwright already has baseURL configured for the "ui" project): ${toRelativePath(screenUrl)}
${credential ? `If the screen requires login, log in with these credentials before performing the test case steps: ${credential}` : ''}

Test cases ALREADY WRITTEN BY QA (do NOT invent, add, remove or rename any test case;
handle ONLY the test cases below):
${caseBlocks}

${LANGUAGE_RULE}

IMPORTANT — for EACH test case above:
- Decide whether it can be automated with Playwright. It CANNOT be automated (set
  "automationStatus": "manual") if it requires physical actions or real devices (dragging a file from
  the real machine, scanning a QR code...), subjective visual judgment (colors, overall layout,
  multilingual spelling), or simulating infrastructure conditions (sudden network loss, server crash).
  Set every other case to "automationStatus": "automatable".
- For an "automatable" case: write EXACTLY ONE test('[<id>] <name>', ...) in its own script file, using
  EXACTLY the fileName given above for that id — the file contains ONLY this test case; never put
  multiple test cases in one file.
- For a "manual" case: do NOT generate a script and do not add anything to "scripts".
- Return "testCases" as EXACTLY the list of ids given above (no additions, no removals), each keeping
  all of its original fields plus "automationStatus" ("automatable"/"manual") and "automationNote" (a
  short reason, ONLY needed for "manual").

Script conventions (apply to every "automatable" file):
- import { test, expect } from '@playwright/test'
- use semantic locators (getByRole/getByLabel/getByText) matching the fields mentioned in
  Steps/Data Test; do NOT invent CSS selectors or data-testid
- Single-choice fields (dropdown/select): do NOT default to \`.selectOption()\` — many modern apps (e.g.
  the shadcn/ui Select component) render this field as a custom combobox (role="combobox"), NOT a
  native \`<select>\`, so \`.selectOption()\` fails or does nothing. Unless Steps/Data Test clearly state it
  is a native \`<select>\`, you MUST use the pattern that works in both cases: open it via
  \`getByRole('combobox', { name: <field label> }).click()\`, then click the option via
  \`getByRole('option', { name: <value to select> }).click()\`.
- Date fields: if the field is a native HTML date input (\`<input type="date">\`, usually with the
  browser's built-in calendar picker), Playwright's \`.fill()\` MUST use ISO format "yyyy-mm-dd" — never
  dd/mm/yyyy, even if Steps/Data Test use dd/mm/yyyy; convert before calling \`.fill()\` (e.g. Steps say
  "01/01/2000" → call \`.fill('2000-01-01')\`), otherwise it fails with "Malformed value". If the date
  field is a plain text input (not a native date picker), keep the format exactly as Steps/Data Test
  wrote it.
- Fields shown ONLY conditionally, depending on a value chosen earlier in another field (e.g. field A
  only appears when value X is chosen in field B, field C only when Y is chosen — cross-check
  Steps/Data Test across MULTIPLE cases in the list to spot such pairs, even when the current case does
  not say so explicitly): NEVER call \`.fill()\`/\`.check()\` on a field that is only shown under a
  DIFFERENT condition than the one this case selected (e.g. after choosing gender Female, do NOT touch
  the field that only appears for Male), and do not touch any conditional field at all if this case
  deliberately leaves the deciding value UNSELECTED (e.g. a "gender left empty" case must NOT fill any
  gender-dependent field). A field that does not exist or is not visible in the DOM makes \`.fill()\`
  hang until timeout instead of failing immediately — that is a script-generation bug, not an app bug,
  so avoid it entirely by working out the visibility condition BEFORE writing any action on that field.
- If a case only mentions one specific field (e.g. "enter an invalid referral code and submit"), do NOT
  fill just that field and submit right away — you MUST fill ALL other required fields (with valid
  values; use the other cases in the list to learn which fields are required and what valid values
  look like), except the field this case deliberately leaves empty/invalid. Reason: forms usually
  validate MULTIPLE fields in a fixed order, so a missing UNRELATED required field surfaces that field's
  error (e.g. "Please enter your full name") instead of the error the case actually wants to check.
- Cases that test an age/date boundary RELATIVE to "today" (e.g. "under 18", "just turned 18", "date in
  the future"): NEVER hardcode a fixed absolute date (e.g. "2008-08-23"), because the test will run on
  MANY later days — a birth date that is "under 18" today will naturally become "18 or older" some time
  after generation, breaking the case's own expectation. You MUST compute the date with a JS expression
  relative to the moment the test runs (e.g. \`new Date()\` and add/subtract the needed years/days right
  in the script, just as duplicate-check cases use \`Date.now()\` to generate unique values) instead of a
  hardcoded date string.
${UI_EVIDENCE_CONVENTION}

${OUTPUT_CONTRACT}
`.trim();
}

/**
 * API-lane prompt for generating scripts from existing QA test cases (kind='api', ids starting with
 * "API..." — see parseTestCaseRow in testCaseMarkdownLoader.ts). Each case already describes the
 * expected request/response in Steps/Data Test/Expected Result; the LLM derives method/path/body/status
 * from that and never drives a browser. Same contract and automatable/manual rules as the UI variant.
 */
export function buildApiScriptsFromTestCasesPrompt(testCases: TestCase[], authHeader?: string): string {
  const caseBlocks = testCases
    .map((tc) => {
      const parts = [
        `- id: ${tc.id}`,
        `  name: ${tc.name}`,
        `  severity: ${tc.severity}`,
        `  precondition: ${tc.precondition}`,
        `  steps:\n${tc.steps.map((s) => `    ${s}`).join('\n')}`,
        `  dataTest: ${tc.dataTest}`,
        `  expectedResult: ${tc.expectedResult}`,
        `  fileName if automatable (you MUST use exactly this name, do NOT choose another): ${scriptFileNameForTestCase(tc.id, 'api')}`
      ];
      return parts.join('\n');
    })
    .join('\n\n');

  return `
You generate Playwright scripts for API testing FROM AN EXISTING SET OF TEST CASES.
${authHeader ? `Auth header: ${authHeader}` : ''}

Test cases ALREADY WRITTEN BY QA (do NOT invent, add, remove or rename any test case; handle ONLY
the test cases below — each case already describes the expected request/response in
Steps/Data Test/Expected Result; derive the exact method/path/request body/status code from that):
${caseBlocks}

${LANGUAGE_RULE}

IMPORTANT — for EACH test case above:
- You MUST use EXACTLY the field/param names given in that test case's Steps/Data Test/Expected Result
  when building the request body (e.g. if the case says "fullName", the payload MUST have the key
  "fullName"; NEVER rename it or guess a more familiar name such as firstName/lastName, even if that is
  the more common pattern). If a case only says "...and the other required fields" without listing
  them all, you MUST reuse EXACTLY the field names that appear in OTHER test cases in the same list
  above (never invent new names) — every case calling the same endpoint must use one consistent set of
  field names.
- APPLY THE SAME PRINCIPLE TO VALUES, not just field names: when a case does not state the format/value
  to use for a shared field (e.g. date of birth, gender, phone number...), you MUST use EXACTLY the
  format/value that field uses in OTHER test cases in the same list (e.g. if another case used
  dateOfBirth="01/01/2000", do NOT switch to "1990-01-01"; if gender="MALE"/"FEMALE" was used, do NOT
  shorten it to "M"/"F") — NEVER invent a format/enum that "seems reasonable" but differs from the other
  cases, even if that format is more common in other APIs.
- If the payload has a field that is conditional on another field's value (e.g. a field that is only
  required/validated when another field = a specific value — cross-check the cases in the list to spot
  this rule), and the current case is NOT specifically testing that conditional field being
  missing/invalid, you MUST still fill that conditional field with a valid value (reuse the field/value
  seen in another case with the same condition) so the request is not blocked by a validation error on
  a field that is NOT the target of this test.
- EACH test case MUST generate its OWN value (never reuse another case's fixed constant) for every field
  that is likely a unique/duplicate-checked key on the backend (e.g. email, national ID number,
  username...) — unless the case itself is testing duplicate behavior (submitting the same value twice
  within THIS script to check the conflict). Use a stable random suffix such as \`Date.now()\` (following
  the pattern seen in other cases, if any) instead of repeating a fixed string — many scripts sharing a
  fixed value will collide with each other across runs because the test server's data is not reset
  between runs.
- If a case only describes one specific field to test (e.g. "invalid referralCode"), the payload MUST
  still contain ALL other required fields with valid values (use the other cases in the list as
  reference) — a missing unrelated required field makes the server return THAT field's error first,
  not the error for the field the case actually wants to check (the server validates multiple fields
  in a fixed order).
- Cases that test an age/date boundary RELATIVE to "today" (e.g. "under 18", "just turned 18", "date in
  the future"): NEVER hardcode a fixed absolute date — the test will run on many later days, so a birth
  date that is "under 18" today will naturally become "18 or older" some time after generation. You
  MUST compute the date with a JS expression relative to the moment the test runs (\`new Date()\` and
  add/subtract the needed years/days right in the script), just as duplicate-check cases use
  \`Date.now()\`.
- Decide whether it can be automated with Playwright. It CANNOT be automated (set
  "automationStatus": "manual") if it requires infrastructure that cannot be simulated with plain HTTP
  requests (simulating network loss mid-request, server crashes, special timing/race-condition
  dependencies). Set every other case to "automationStatus": "automatable".
- For an "automatable" case: write EXACTLY ONE test('[<id>] <name>', ...) in its own script file, using
  EXACTLY the fileName given above for that id — the file contains ONLY this test case; never put
  multiple test cases in one file.
- For a "manual" case: do NOT generate a script and do not add anything to "scripts".
- Return "testCases" as EXACTLY the list of ids given above (no additions, no removals), each keeping
  all of its original fields plus "automationStatus" ("automatable"/"manual") and "automationNote" (a
  short reason, ONLY needed for "manual").

Generate Playwright Test scripts using the built-in \`request\` fixture (do NOT open a browser to call the
API, do NOT call request.newContext — the request fixture is already a context; call
request.post/get/put/delete directly), following these conventions:
- import { test, expect } from '@playwright/test'
- call request.post/get/put/delete directly with EXACTLY the relative path derived from the test case (e.g. request.post('/api/customers')) — do NOT build the base URL yourself; Playwright already has baseURL configured for the "api" project and prepends it
- each test case is its own test(...) block with a clear, descriptive name
${API_EVIDENCE_CONVENTION}

${OUTPUT_CONTRACT}
`.trim();
}

/**
 * Parses Claude's JSON reply, tolerating a stray ```json fence, and validates the
 * { testCases, scripts } shape before accepting it.
 */
export function parseAiResponse(raw: string): TestSuite {
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

  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).testCases) ||
    !Array.isArray((data as Record<string, unknown>).scripts)
  ) {
    throw new Error('AI response does not match the expected { testCases, scripts } schema');
  }

  return data as TestSuite;
}

/**
 * Calls Claude once (via the Claude Code CLI, see claudeCliClient.ts) with a prebuilt prompt and
 * parses the result into { testCases, scripts }. A single call keeps latency down.
 */
export async function generateTestSuite(prompt: string, cwd?: string, model?: string): Promise<TestSuite> {
  const raw = await callClaudeCli(prompt, cwd, model);
  return parseAiResponse(raw);
}
