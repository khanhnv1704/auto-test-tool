import { describe, it, expect, afterEach } from 'vitest';
import { buildBugAnalysisPrompt, parseBugAnalysisResponse, buildBacklogDescription } from './bugAnalysis';
import { TestCase } from '../types';

const testCase: TestCase = {
  id: 'UI-1-02',
  name: 'Gender=Male but ID card number left empty',
  kind: 'ui',
  target: 'Customer sign-up',
  severity: 'High',
  precondition: 'The screen is open',
  steps: ['1. Select Gender = Male.', '2. Leave ID card number empty.', '3. Click Sign up.'],
  dataTest: 'Empty',
  expectedResult: 'A required-field error is shown for ID card number.',
  isEdgeCase: false
};

describe('buildBugAnalysisPrompt', () => {
  it('embeds the test name/error message and the JSON output contract', () => {
    const prompt = buildBugAnalysisPrompt({
      testName: '[UI-1-02] Gender=Male but ID card number left empty',
      errorMessage: 'Timeout waiting for locator getByRole(\'radio\')',
      testCase
    });

    expect(prompt).toContain('[UI-1-02] Gender=Male but ID card number left empty');
    expect(prompt).toContain("Timeout waiting for locator getByRole('radio')");
    expect(prompt).toContain('"rootCause"');
    expect(prompt).toContain('"fixApproach"');
    expect(prompt).toContain('"actionItems"');
    expect(prompt).toContain('"estimate"');
  });

  it('includes the original testcase context (steps/expected) when provided', () => {
    const prompt = buildBugAnalysisPrompt({ testName: 't', errorMessage: 'e', testCase });
    expect(prompt).toContain('Select Gender = Male');
    expect(prompt).toContain('A required-field error is shown for ID card number.');
  });

  it('degrades gracefully when no matching testcase is found', () => {
    const prompt = buildBugAnalysisPrompt({ testName: 't', errorMessage: 'e' });
    expect(prompt).toContain('no matching original test case found');
  });
});

describe('parseBugAnalysisResponse', () => {
  it('parses a well-formed JSON response', () => {
    const raw = JSON.stringify({
      rootCause: 'Missing server-side validation',
      fixApproach: 'Add schema validation',
      actionItems: ['Add middleware', 'Re-run the test'],
      estimate: 'Dev ~2h'
    });
    expect(parseBugAnalysisResponse(raw)).toEqual({
      rootCause: 'Missing server-side validation',
      fixApproach: 'Add schema validation',
      actionItems: ['Add middleware', 'Re-run the test'],
      estimate: 'Dev ~2h'
    });
  });

  it('strips a ```json fence if the model added one anyway', () => {
    const raw = '```json\n{"rootCause":"a","fixApproach":"b","actionItems":[],"estimate":"c"}\n```';
    expect(parseBugAnalysisResponse(raw).rootCause).toBe('a');
  });

  it('throws when the JSON does not match the expected schema', () => {
    expect(() => parseBugAnalysisResponse(JSON.stringify({ rootCause: 'a' }))).toThrow(/expected/);
  });

  it('throws when the response is not valid JSON at all', () => {
    expect(() => parseBugAnalysisResponse('not json')).toThrow(/not valid JSON/);
  });
});

describe('buildBacklogDescription', () => {
  it('lays out every heading of the log-bug/fix-bug template in order', () => {
    const description = buildBacklogDescription({ testName: '[TC-01] test', errorMessage: 'boom' });

    const headings = [
      '# Bug report',
      '## Test Environment',
      '## Preconditions',
      '## Steps',
      '## Actual results',
      '## Expected results',
      '## Occurrence rate (if any)',
      '## Evidence (if any)',
      '# Developer fix',
      '## Root cause:',
      '## Changes made:',
      '## Related issues:',
      '## Impact scope:',
      '## Pull request',
      '## Verification after the fix'
    ];

    const positions = headings.map((h) => description.indexOf(h));
    expect(positions.filter((p) => p < 0)).toEqual([]);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('fills preconditions, steps, data test and expected result from the original testcase', () => {
    const description = buildBacklogDescription({ testName: 't', errorMessage: 'e', testCase });

    expect(description).toContain('The screen is open');
    expect(description).toContain('Leave ID card number empty.');
    expect(description).toContain('Data test: Empty');
    expect(description).toContain('A required-field error is shown for ID card number.');
  });

  it('numbers steps that have no numbering of their own', () => {
    const description = buildBacklogDescription({
      testName: 't',
      errorMessage: 'e',
      testCase: { ...testCase, steps: ['Open the sign-up screen', 'Click Sign up'] }
    });

    expect(description).toContain('1. Open the sign-up screen');
    expect(description).toContain('2. Click Sign up');
  });

  it('leaves steps that already carry their own numbering untouched', () => {
    const description = buildBacklogDescription({ testName: 't', errorMessage: 'e', testCase });
    expect(description).toContain('1. Select Gender = Male.');
    expect(description).not.toContain('1. 1. Select Gender = Male.');
  });

  it('puts the raw error message under Actual results', () => {
    const description = buildBacklogDescription({ testName: 't', errorMessage: 'Expected: 409\nReceived: 201' });
    const actual = description.slice(description.indexOf('## Actual results'), description.indexOf('## Expected results'));
    expect(actual).toContain('Expected: 409');
    expect(actual).toContain('Received: 201');
  });

  it('marks the testcase-driven sections as unknown when no testcase was found', () => {
    const description = buildBacklogDescription({ testName: 't', errorMessage: 'e' });
    const preconditions = description.slice(description.indexOf('## Preconditions'), description.indexOf('## Steps'));
    expect(preconditions).toContain('no matching original test case found');
  });

  it('describes the run context under Test Environment', () => {
    const description = buildBacklogDescription({
      testName: '[API16] create customer with duplicate email',
      errorMessage: 'e',
      testCase: { ...testCase, kind: 'api' },
      environment: {
        functionId: 'Customer sign-up',
        round: 16,
        kind: 'api',
        baseUrl: 'http://localhost:3000',
        startedAt: '2026-07-15T07:32:22.033Z'
      }
    });
    const env = description.slice(description.indexOf('## Test Environment'), description.indexOf('## Preconditions'));

    expect(env).toContain('Customer sign-up');
    expect(env).toContain('Round: 16');
    expect(env).toContain('http://localhost:3000');
    expect(env).toContain('[API16] create customer with duplicate email');
  });

  describe('run time', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    const runTimeLine = () =>
      buildBacklogDescription({
        testName: 't',
        errorMessage: 'e',
        environment: { startedAt: '2026-07-15T07:32:22.033Z' }
      })
        .split('\n')
        .find((line) => line.startsWith('- Run time:'));

    it('prints the run time in machine local time with an explicit UTC offset', () => {
      process.env.TZ = 'Asia/Tokyo';
      expect(runTimeLine()).toBe('- Run time: 2026-07-15 16:32:22 (UTC+09:00)');

      process.env.TZ = 'UTC';
      expect(runTimeLine()).toBe('- Run time: 2026-07-15 07:32:22 (UTC+00:00)');

      process.env.TZ = 'America/St_Johns';
      expect(runTimeLine()).toBe('- Run time: 2026-07-15 05:02:22 (UTC-02:30)');
    });

    it('keeps an unparseable timestamp as-is', () => {
      const description = buildBacklogDescription({
        testName: 't',
        errorMessage: 'e',
        environment: { startedAt: 'not-a-date' }
      });
      expect(description).toContain('- Run time: not-a-date');
    });
  });

  it('reports how often the case failed across rounds that actually ran', () => {
    const description = buildBacklogDescription({
      testName: 't',
      errorMessage: 'e',
      occurrence: { failedRounds: [12, 14, 16], ranRounds: 5 }
    });
    const rate = description.slice(description.indexOf('## Occurrence rate'), description.indexOf('## Evidence'));

    expect(rate).toContain('3/5');
    expect(rate).toContain('12, 14, 16');
  });

  it('says the history is unknown when the case has no round data', () => {
    const description = buildBacklogDescription({ testName: 't', errorMessage: 'e' });
    const rate = description.slice(description.indexOf('## Occurrence rate'), description.indexOf('## Evidence'));
    expect(rate).toContain('no round history');
  });

  it('lists evidence by file name, not by absolute path', () => {
    const description = buildBacklogDescription({
      testName: 't',
      errorMessage: 'e',
      evidencePaths: ['/home/qa/results/round-16/bug-reports/API16.md']
    });
    const evidence = description.slice(description.indexOf('## Evidence'), description.indexOf('# Developer fix'));

    expect(evidence).toContain('API16.md');
    expect(evidence).not.toContain('/home/qa/results');
  });

  it('inserts the AI analysis block between the two template sections only when analysis exists', () => {
    const withoutAnalysis = buildBacklogDescription({ testName: 't', errorMessage: 'e' });
    expect(withoutAnalysis).not.toContain('# Automated analysis');

    const withAnalysis = buildBacklogDescription({
      testName: 't',
      errorMessage: 'e',
      analysis: { rootCause: 'r', fixApproach: 'f', actionItems: ['a1', 'a2'], estimate: 'x' }
    });
    expect(withAnalysis).toContain('# Automated analysis (AI Auto Test)');
    expect(withAnalysis).toContain('r');
    expect(withAnalysis).toContain('- a1');
    expect(withAnalysis).toContain('- a2');
    expect(withAnalysis).toContain('x');
    expect(withAnalysis.indexOf('# Automated analysis (AI Auto Test)')).toBeGreaterThan(
      withAnalysis.indexOf('## Evidence (if any)')
    );
    expect(withAnalysis.indexOf('# Automated analysis (AI Auto Test)')).toBeLessThan(
      withAnalysis.indexOf('# Developer fix')
    );
  });

  it('keeps the developer section empty so the dev writes their own conclusion', () => {
    const description = buildBacklogDescription({
      testName: 't',
      errorMessage: 'e',
      analysis: { rootCause: 'missing server-side validation', fixApproach: 'f', actionItems: [], estimate: 'x' }
    });
    const devSection = description.slice(description.indexOf('# Developer fix'));

    expect(devSection).not.toContain('missing server-side validation');
    expect(devSection.replace(/^#.*$/gm, '').trim()).toBe('');
  });
});
