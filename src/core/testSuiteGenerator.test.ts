import { describe, it, expect } from 'vitest';
import {
  buildApiScriptsFromTestCasesPrompt,
  buildFunctionApiPrompt,
  buildFunctionUiPrompt,
  buildUiScriptsFromTestCasesPrompt,
  ensureBracketedTestTitle,
  parseAiResponse,
  scriptFileNameForTestCase,
  toRelativePath
} from './testSuiteGenerator';
import { FunctionSpec, TestCase } from '../types';

const functionSpec: FunctionSpec = {
  functionId: 'Customer sign-up',
  screenUrl: 'http://localhost:3000/customer-signup',
  fields: [
    { name: 'Full name', type: 'text', required: true },
    { name: 'Gender', type: 'enum(Male,Female)', required: true },
    { name: 'ID card number', type: 'text', required: true, showIf: 'Gender=Male' },
    { name: 'Citizen ID', type: 'text', required: true, showIf: 'Gender=Female' }
  ],
  endpoints: [
    {
      key: 'POST /customers',
      method: 'POST',
      path: '/customers',
      requestBody: { fields: ['idNumber: string, required if gender=MALE'] },
      responses: { '201': 'Created', '401': 'Unauthorized' },
      security: true
    }
  ],
  functionalRules: ['idNumber is required when gender=MALE'],
  nonFunctionalRules: ['The API only accepts calls with a valid Bearer token'],
  raw: ''
};

describe('buildFunctionApiPrompt', () => {
  it('includes functional and non-functional rules, and demands broader coverage than UI', () => {
    const prompt = buildFunctionApiPrompt(functionSpec);
    expect(prompt).toContain('idNumber is required when gender=MALE');
    expect(prompt).toContain('The API only accepts calls with a valid Bearer token');
    expect(prompt).toContain('MANY MORE and BROADER test cases than the UI lane');
    expect(prompt).toContain('category');
  });

  it('requests the template-aligned fields (severity, precondition, steps, dataTest, expectedResult)', () => {
    const prompt = buildFunctionApiPrompt(functionSpec);
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"precondition"');
    expect(prompt).toContain('"steps"');
    expect(prompt).toContain('"dataTest"');
    expect(prompt).toContain('"expectedResult"');
  });

  it('instructs the model to capture red-boxed API evidence', () => {
    const prompt = buildFunctionApiPrompt(functionSpec);
    expect(prompt).toContain('captureApiEvidence');
  });

  it('instructs the model to pass requestBody into captureApiEvidence', () => {
    const prompt = buildFunctionApiPrompt(functionSpec);
    expect(prompt).toContain('requestBody:');
  });

  it('instructs calling with a relative path — no base URL to embed, Playwright supplies it', () => {
    const prompt = buildFunctionApiPrompt(functionSpec);
    expect(prompt).toContain('relative path');
    expect(prompt).not.toContain('http://');
  });

  it('includes the auth header when given', () => {
    const prompt = buildFunctionApiPrompt(functionSpec, 'Bearer demo-token');
    expect(prompt).toContain('Auth header: Bearer demo-token');
  });
});

describe('buildFunctionUiPrompt', () => {
  it('lists on-screen fields with their showIf condition and excludes non-functional scope', () => {
    const prompt = buildFunctionUiPrompt(functionSpec);
    expect(prompt).toContain('ID card number');
    expect(prompt).toContain('shown only when: Gender=Male');
    expect(prompt).toContain('Do NOT generate security/authorization/injection test cases');
  });

  it('instructs the model to capture red-boxed UI evidence', () => {
    const prompt = buildFunctionUiPrompt(functionSpec);
    expect(prompt).toContain('captureUiEvidence');
  });

  it('uses the relative path (not the absolute screenUrl) so Playwright supplies baseURL', () => {
    const prompt = buildFunctionUiPrompt(functionSpec);
    expect(prompt).toContain("page.goto('/customer-signup')");
    expect(prompt).not.toContain(functionSpec.screenUrl);
  });

  it('instructs the model to handle a custom combobox (e.g. shadcn/ui Select) via click+option, never .selectOption()', () => {
    const prompt = buildFunctionUiPrompt(functionSpec);
    expect(prompt).toContain('role="combobox"');
    expect(prompt).toContain("getByRole('option', { name: <value> }).click()");
    expect(prompt).toContain('NEVER use .selectOption()');
  });

  it('embeds a combobox domHint verbatim when a field has one', () => {
    const specWithCombobox: FunctionSpec = {
      ...functionSpec,
      fields: [
        {
          name: 'Gender',
          type: 'enum(Male,Female)',
          required: true,
          domHint:
            'custom combobox element (role="combobox", NOT a native <select>) — use getByRole(\'combobox\', { name: <field name> }).click() then getByRole(\'option\', { name: <value> }).click(), do not use .selectOption(). Options: Male, Female'
        }
      ]
    };
    const prompt = buildFunctionUiPrompt(specWithCombobox);
    expect(prompt).toContain('Scanned DOM: custom combobox element');
    expect(prompt).toContain('Options: Male, Female');
  });
});

describe('buildUiScriptsFromTestCasesPrompt', () => {
  const testCases: TestCase[] = [
    {
      id: 'UI-1-02',
      name: 'Drag and drop an image file',
      kind: 'ui',
      target: 'Customer sign-up',
      severity: 'Low',
      precondition: 'The screen is open',
      steps: ['1. Drag an image file onto the upload area.'],
      dataTest: '.png file',
      expectedResult: 'Upload succeeds.',
      isEdgeCase: false
    }
  ];

  it('embeds the testcase content and a fixed, non-negotiable fileName per id', () => {
    const prompt = buildUiScriptsFromTestCasesPrompt(testCases, 'http://localhost:3000/customer-signup');
    expect(prompt).toContain('id: UI-1-02');
    expect(prompt).toContain('Drag an image file onto the upload area');
    expect(prompt).toContain('UI-UI-1-02.spec.ts');
    expect(prompt).toContain('do NOT invent, add, remove or rename any test case');
  });

  it('instructs classification into automatable vs manual and captures UI evidence', () => {
    const prompt = buildUiScriptsFromTestCasesPrompt(testCases, 'http://localhost:3000/customer-signup');
    expect(prompt).toContain('automationStatus');
    expect(prompt).toContain('automatable');
    expect(prompt).toContain('manual');
    expect(prompt).toContain('captureUiEvidence');
  });

  it('does not mention login credentials when none is provided', () => {
    const prompt = buildUiScriptsFromTestCasesPrompt(testCases, 'http://localhost:3000/customer-signup');
    expect(prompt).not.toContain('log in with these credentials');
  });

  it('instructs the model to log in first when a credential is provided', () => {
    const prompt = buildUiScriptsFromTestCasesPrompt(testCases, 'http://localhost:3000/customer-signup', 'admin/admin123');
    expect(prompt).toContain('log in with these credentials before performing the test case steps: admin/admin123');
  });

  it('tells the model to keep the on-screen wording of the test case untranslated', () => {
    const prompt = buildUiScriptsFromTestCasesPrompt(testCases, 'http://localhost:3000/customer-signup');
    expect(prompt).toContain('may be written in any language');
    expect(prompt).toContain('do not translate it');
    expect(buildApiScriptsFromTestCasesPrompt([])).toContain('do not translate it');
  });

  it('uses the relative path (not the absolute screenUrl) so Playwright supplies baseURL', () => {
    const prompt = buildUiScriptsFromTestCasesPrompt(testCases, 'http://localhost:3000/customer-signup');
    expect(prompt).toContain("page.goto('/customer-signup')");
    expect(prompt).not.toContain('http://localhost:3000/customer-signup');
  });
});

describe('buildApiScriptsFromTestCasesPrompt', () => {
  const apiTestCases: TestCase[] = [
    {
      id: 'API02',
      name: 'Create customer without fullName',
      kind: 'api',
      target: 'Customer sign-up',
      severity: 'High',
      precondition: '-',
      steps: ['1. Send POST /api/customers with sample body: fullName="".'],
      dataTest: 'fullName=""',
      expectedResult: '400 — { "message": "Please enter your full name" }',
      isEdgeCase: false
    }
  ];

  it('embeds the testcase content, a relative-path instruction (no base URL to embed), and a fixed API- prefixed fileName per id', () => {
    const prompt = buildApiScriptsFromTestCasesPrompt(apiTestCases);
    expect(prompt).toContain('id: API02');
    expect(prompt).toContain('relative path');
    expect(prompt).not.toContain('http://');
    expect(prompt).toContain('API-API02.spec.ts');
    expect(prompt).toContain('do NOT invent, add, remove or rename any test case');
  });

  it('instructs using the request fixture (not the browser) and captures API evidence', () => {
    const prompt = buildApiScriptsFromTestCasesPrompt(apiTestCases);
    expect(prompt).toContain('`request` fixture');
    expect(prompt).toContain('do NOT open a browser to call the');
    expect(prompt).toContain('captureApiEvidence');
  });

  it('omits the auth header line when none is provided, includes it when given', () => {
    const withoutAuth = buildApiScriptsFromTestCasesPrompt(apiTestCases);
    expect(withoutAuth).not.toContain('Auth header');

    const withAuth = buildApiScriptsFromTestCasesPrompt(apiTestCases, 'Bearer demo-token');
    expect(withAuth).toContain('Auth header: Bearer demo-token');
  });
});

describe('toRelativePath', () => {
  it('extracts pathname + search + hash from an absolute URL', () => {
    expect(toRelativePath('http://localhost:3000/customer-signup')).toBe('/customer-signup');
    expect(toRelativePath('http://localhost:3000/search?q=abc#top')).toBe('/search?q=abc#top');
  });

  it('defaults to "/" for an absolute URL with no path', () => {
    expect(toRelativePath('http://localhost:3000')).toBe('/');
  });

  it('leaves an already-relative path untouched', () => {
    expect(toRelativePath('/customer-signup')).toBe('/customer-signup');
  });

  it('adds a leading slash to a bare relative path missing one', () => {
    expect(toRelativePath('customer-signup')).toBe('/customer-signup');
  });
});

describe('scriptFileNameForTestCase', () => {
  it('prefixes with "API-" for kind api and "UI-" for kind ui, so Playwright testMatch routes to the right project', () => {
    expect(scriptFileNameForTestCase('API02', 'api')).toBe('API-API02.spec.ts');
    expect(scriptFileNameForTestCase('TC04', 'ui')).toBe('UI-TC04.spec.ts');
  });
});

describe('ensureBracketedTestTitle', () => {
  it('prepends "[<id>] " when the model forgot the bracket entirely (regression: cheaper models like Haiku sometimes drop it, silently breaking script status + Run Tests result matching)', () => {
    const content = "test('TC01 Valid sign-up', async ({ page }, testInfo) => { /* ... */ })";
    expect(ensureBracketedTestTitle(content, 'TC01')).toBe(
      "test('[TC01] Valid sign-up', async ({ page }, testInfo) => { /* ... */ })"
    );
  });

  it('does not duplicate the id when the plain (unbracketed) title already repeats it', () => {
    const content = "test('TC02 Leave full name empty', async () => {})";
    expect(ensureBracketedTestTitle(content, 'TC02')).toBe("test('[TC02] Leave full name empty', async () => {})");
  });

  it('replaces a stale/wrong bracketed id instead of stacking a second bracket', () => {
    const content = "test('[TC99] Check abc', async () => {})";
    expect(ensureBracketedTestTitle(content, 'TC03')).toBe("test('[TC03] Check abc', async () => {})");
  });

  it('leaves the content untouched when the bracket is already correct', () => {
    const content = "test('[TC01] Valid sign-up', async () => {})";
    expect(ensureBracketedTestTitle(content, 'TC01')).toBe(content);
  });

  it('works with double-quoted titles too', () => {
    const content = 'test("API01 Create customer", async ({ request }, testInfo) => {})';
    expect(ensureBracketedTestTitle(content, 'API01')).toBe(
      'test("[API01] Create customer", async ({ request }, testInfo) => {})'
    );
  });

  it('returns the content unchanged when no test(...) call is found', () => {
    const content = '// no test here';
    expect(ensureBracketedTestTitle(content, 'TC01')).toBe(content);
  });
});

describe('parseAiResponse', () => {
  it('parses a well-formed response', () => {
    const raw = JSON.stringify({
      testCases: [
        {
          id: '1',
          name: 'x',
          kind: 'api',
          target: '/users',
          severity: 'High',
          precondition: '-',
          steps: ['Call POST /users'],
          dataTest: '-',
          expectedResult: '201 Created',
          isEdgeCase: false
        }
      ],
      scripts: [{ fileName: 'a.spec.ts', content: 'test()' }]
    });
    const result = parseAiResponse(raw);
    expect(result.testCases).toHaveLength(1);
    expect(result.scripts).toHaveLength(1);
  });

  it('strips a surrounding ```json fence before parsing', () => {
    const raw = '```json\n' + JSON.stringify({ testCases: [], scripts: [] }) + '\n```';
    expect(() => parseAiResponse(raw)).not.toThrow();
  });

  it('throws a clear error when the response is not JSON', () => {
    expect(() => parseAiResponse('not json at all')).toThrow(/not valid JSON/);
  });

  it('throws when the JSON does not match the expected shape', () => {
    expect(() => parseAiResponse(JSON.stringify({ foo: 'bar' }))).toThrow(/expected/);
  });
});
