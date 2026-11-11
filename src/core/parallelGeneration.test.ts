import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FunctionSpec, TestCase, TestSuite } from '../types';

const generateTestSuiteMock = vi.fn<[string, string | undefined], Promise<TestSuite>>();
const scanScreenFieldsMock = vi.fn<[string, unknown], Promise<Record<string, string>>>();

vi.mock('./testSuiteGenerator', async () => {
  const actual = await vi.importActual<typeof import('./testSuiteGenerator')>('./testSuiteGenerator');
  return {
    ...actual,
    generateTestSuite: (prompt: string, cwd?: string) => generateTestSuiteMock(prompt, cwd)
  };
});

vi.mock('./domScanner', () => ({
  scanScreenFields: (screenUrl: string, fields: unknown) => scanScreenFieldsMock(screenUrl, fields)
}));

import {
  chunkArray,
  runWithConcurrency,
  generateFunctionApiSuiteParallel,
  generateFunctionUiSuiteParallel,
  generateScriptsFromTestCasesParallel
} from './parallelGeneration';

beforeEach(() => {
  generateTestSuiteMock.mockReset();
  scanScreenFieldsMock.mockReset();
  scanScreenFieldsMock.mockResolvedValue({});
  generateTestSuiteMock.mockImplementation(async (prompt: string) => ({
    testCases: [
      {
        id: 'x',
        name: 'x',
        kind: 'api',
        target: '/x',
        severity: 'Low',
        precondition: '',
        steps: ['step'],
        dataTest: '',
        expectedResult: 'e',
        isEdgeCase: false
      }
    ],
    scripts: [{ fileName: 'out.spec.ts', content: prompt }]
  }));
});

describe('chunkArray', () => {
  it('splits into chunks of the given size, including a shorter last chunk', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single chunk when size <= 0 or the list is empty', () => {
    expect(chunkArray([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(chunkArray([], 5)).toEqual([[]]);
  });
});

describe('runWithConcurrency', () => {
  it('never runs more than `limit` workers at the same time', async () => {
    let active = 0;
    let maxActive = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return item * 2;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('returns results in the same order as the input, regardless of completion order', async () => {
    const delays = [30, 10, 20];
    const results = await runWithConcurrency(delays, 3, async (delay, i) => {
      await new Promise((r) => setTimeout(r, delay));
      return i;
    });
    expect(results).toEqual([0, 1, 2]);
  });
});

const functionSpec: FunctionSpec = {
  functionId: 'Customer signup',
  screenUrl: 'http://localhost:3000/customer-signup',
  fields: Array.from({ length: 10 }, (_, i) => ({ name: `field${i}`, type: 'text', required: true })),
  endpoints: [
    {
      key: 'POST /customers',
      method: 'POST',
      path: '/customers',
      requestBody: { fields: Array.from({ length: 25 }, (_, i) => `field${i}: string, required`) },
      responses: { '201': 'Created' },
      security: true
    }
  ],
  functionalRules: ['rule 1'],
  nonFunctionalRules: ['nf rule 1'],
  raw: ''
};

describe('generateFunctionApiSuiteParallel', () => {
  it('batches request fields per endpoint AND adds 1 dedicated non-functional job', async () => {
    await generateFunctionApiSuiteParallel(functionSpec, undefined, { batchSize: 10 });
    // 25 fields / batchSize 10 => 3 field-batches + 1 non-functional job = 4 jobs
    expect(generateTestSuiteMock).toHaveBeenCalledTimes(4);
  });

  it('skips the non-functional job entirely when there are no non-functional rules', async () => {
    const specWithoutNf: FunctionSpec = { ...functionSpec, nonFunctionalRules: [] };
    await generateFunctionApiSuiteParallel(specWithoutNf, undefined, { batchSize: 10 });
    expect(generateTestSuiteMock).toHaveBeenCalledTimes(3);
  });
});

describe('generateFunctionUiSuiteParallel', () => {
  it('batches screen fields into concurrent jobs', async () => {
    await generateFunctionUiSuiteParallel(functionSpec, { batchSize: 4 });
    // 10 fields / batchSize 4 => 3 batches
    expect(generateTestSuiteMock).toHaveBeenCalledTimes(3);
  });

  it('enriches fields with DOM hints from scanScreenFields before building the prompt', async () => {
    scanScreenFieldsMock.mockResolvedValue({ field0: '<select> element (combobox), options: Male, Female' });
    await generateFunctionUiSuiteParallel(functionSpec, { batchSize: 4 });

    expect(scanScreenFieldsMock).toHaveBeenCalledWith(functionSpec.screenUrl, functionSpec.fields);
    const prompts = generateTestSuiteMock.mock.calls.map(([prompt]) => prompt);
    expect(prompts.some((p) => p.includes('<select> element (combobox), options: Male, Female'))).toBe(true);
  });
});

const testCases: TestCase[] = Array.from({ length: 10 }, (_, i) => ({
  id: `UI-1-${i}`,
  name: `Test case ${i}`,
  kind: 'ui',
  target: 'Customer sign-up',
  severity: 'Medium',
  precondition: '-',
  steps: ['1. Do something.'],
  dataTest: '-',
  expectedResult: 'Expected result',
  isEdgeCase: false
}));

describe('generateScriptsFromTestCasesParallel', () => {
  it('batches testcases into concurrent ui-lane jobs', async () => {
    await generateScriptsFromTestCasesParallel(testCases, 'http://localhost:3000/customer-signup', { batchSize: 4 });
    // 10 testcases / batchSize 4 => 3 batches
    expect(generateTestSuiteMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT prefix ids with a batch tag — QA-authored ids must survive verbatim', async () => {
    await generateScriptsFromTestCasesParallel(testCases, 'http://localhost:3000/customer-signup', { batchSize: 4 });
    const prompts = generateTestSuiteMock.mock.calls.map(([prompt]) => prompt);
    expect(prompts.every((p) => !p.includes('MUST start with the prefix'))).toBe(true);
    expect(prompts.some((p) => p.includes('id: UI-1-0'))).toBe(true);
  });

  it('does NOT prefix the script fileName with a batch tag either — it must stay exactly "UI-<id>.spec.ts" to match playwright.config.ts testMatch', async () => {
    generateTestSuiteMock.mockImplementation(async () => ({
      testCases: [],
      scripts: [{ fileName: 'UI-1-0.spec.ts', content: 'x' }]
    }));

    const result = await generateScriptsFromTestCasesParallel(testCases, 'http://localhost:3000/customer-signup', {
      batchSize: 4
    });

    expect(result.scripts.map((s) => s.fileName)).toEqual(['UI-1-0.spec.ts', 'UI-1-0.spec.ts', 'UI-1-0.spec.ts']);
    expect(result.scripts.every((s) => !s.fileName.startsWith('SCRIPT-'))).toBe(true);
  });

  it('passes the credential through to every batch prompt when provided', async () => {
    await generateScriptsFromTestCasesParallel(
      testCases,
      'http://localhost:3000/customer-signup',
      { batchSize: 4 },
      'admin/admin123'
    );
    const prompts = generateTestSuiteMock.mock.calls.map(([prompt]) => prompt);
    expect(prompts.every((p) => p.includes('admin/admin123'))).toBe(true);
  });

  const apiTestCases: TestCase[] = Array.from({ length: 3 }, (_, i) => ({
    id: `API0${i + 1}`,
    name: `API test case ${i}`,
    kind: 'api',
    target: 'Customer sign-up',
    severity: 'Medium',
    precondition: '-',
    steps: ['1. Send the request.'],
    dataTest: '-',
    expectedResult: '201 Created',
    isEdgeCase: false
  }));

  it('routes kind="api" testcases to the API prompt (request-based) when apiConfig is given, separately from kind="ui"', async () => {
    const result = await generateScriptsFromTestCasesParallel(
      [...testCases, ...apiTestCases],
      'http://localhost:3000/customer-signup',
      { batchSize: 20 },
      undefined,
      { baseUrl: 'http://localhost:3000' }
    );

    expect(generateTestSuiteMock).toHaveBeenCalledTimes(2); // 1 ui batch + 1 api batch
    const prompts = generateTestSuiteMock.mock.calls.map(([prompt]) => prompt);
    const apiPrompt = prompts.find((p) => p.includes('id: API01'));
    const uiPrompt = prompts.find((p) => p.includes('id: UI-1-0'));
    expect(apiPrompt).toContain('relative path');
    expect(apiPrompt).not.toContain('http://localhost:3000');
    expect(apiPrompt).toContain('`request` fixture');
    expect(apiPrompt).not.toContain('id: UI-1-0');
    expect(uiPrompt).not.toContain('id: API01');
    expect(result.failed).toEqual([]);
  });

  it('marks kind="api" testcases as failed (without calling the LLM) when no apiConfig is given', async () => {
    const result = await generateScriptsFromTestCasesParallel(
      [...testCases, ...apiTestCases],
      'http://localhost:3000/customer-signup',
      { batchSize: 20 }
      // no credential, no apiConfig
    );

    expect(generateTestSuiteMock).toHaveBeenCalledTimes(1); // only the ui batch — no LLM call wasted on the api batch
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].lane).toBe('api');
    expect(result.failed[0].error).toContain('Base URL');
  });

  it('1 job throwing does NOT lose the testCases/scripts already produced by the other jobs, and is reported in `failed`', async () => {
    // 10 testcases / batchSize 4 => 3 jobs (SCRIPT-1, SCRIPT-UI-2, SCRIPT-3) — make the 2nd job reject.
    generateTestSuiteMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('id: UI-1-4')) {
        // 2nd batch (items 4-7) starts with UI-1-4 — force this one job to fail.
        throw new Error('claude CLI crashed');
      }
      return {
        testCases: [
          {
            id: 'x',
            name: 'x',
            kind: 'api',
            target: '/x',
            severity: 'Low',
            precondition: '',
            steps: ['step'],
            dataTest: '',
            expectedResult: 'e',
            isEdgeCase: false
          }
        ],
        scripts: [{ fileName: 'out.spec.ts', content: prompt }]
      };
    });

    const result = await generateScriptsFromTestCasesParallel(testCases, 'http://localhost:3000/customer-signup', {
      batchSize: 4,
      concurrency: 1 // deterministic order: job 2 fails without cancelling jobs 1/3
    });

    expect(result.testCases).toHaveLength(2); // jobs 1 and 3 succeeded, job 2 did not contribute
    expect(result.scripts).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ batchTag: 'SCRIPT-UI-2', lane: 'ui', error: 'claude CLI crashed' });
  });

  it('calls onJobSettled per job with the correct testCaseIds, even for the failed job', async () => {
    generateTestSuiteMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('id: UI-1-4')) throw new Error('boom');
      return { testCases: [], scripts: [] };
    });

    const settled: Array<{ batchTag: string; testCaseIds?: string[]; ok: boolean }> = [];
    await generateScriptsFromTestCasesParallel(testCases, 'http://localhost:3000/customer-signup', {
      batchSize: 4,
      concurrency: 1,
      onJobSettled: (info) => settled.push({ batchTag: info.batchTag, testCaseIds: info.testCaseIds, ok: info.outcome.ok })
    });

    expect(settled).toHaveLength(3);
    const job2 = settled.find((s) => s.batchTag === 'SCRIPT-UI-2');
    expect(job2?.ok).toBe(false);
    expect(job2?.testCaseIds).toEqual(['UI-1-4', 'UI-1-5', 'UI-1-6', 'UI-1-7']);
  });
});
