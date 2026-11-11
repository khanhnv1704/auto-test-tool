import { describe, it, expect } from 'vitest';
import { buildMissingTestCasesPrompt, parseMissingTestCasesResponse } from './testCaseSuggestion';
import { TestCase } from '../types';

const existing: TestCase[] = [
  {
    id: 'UI-1-01',
    name: 'Leave Full name empty',
    kind: 'ui',
    target: 'Customer sign-up',
    severity: 'High',
    precondition: 'The screen is open',
    steps: ['1. Leave Full name empty.', '2. Click Sign up.'],
    dataTest: 'Empty',
    expectedResult: 'A required-field error is shown.',
    isEdgeCase: false
  }
];

describe('buildMissingTestCasesPrompt', () => {
  it('lists existing testcases so the model does not suggest duplicates', () => {
    const prompt = buildMissingTestCasesPrompt(existing, 'Customer sign-up');
    expect(prompt).toContain('[UI-1-01] Leave Full name empty');
    expect(prompt).toContain('do not suggest duplicates');
  });

  it('asks for coverage across the 4 required categories', () => {
    const prompt = buildMissingTestCasesPrompt(existing, 'Customer sign-up');
    expect(prompt).toContain('Core logic');
    expect(prompt).toContain('Non-functional');
    expect(prompt).toContain('Performance');
    expect(prompt).toContain('Security');
  });

  it('clarifies performance is UI-observable, not real load testing', () => {
    const prompt = buildMissingTestCasesPrompt(existing, 'Customer sign-up');
    expect(prompt).toContain('NOT real load testing/benchmarking');
  });

  it('handles an empty existing list without throwing', () => {
    const prompt = buildMissingTestCasesPrompt([], 'Customer sign-up');
    expect(prompt).toContain('no test cases yet');
  });

  it('asks for a "reason" field explaining why each case is missing', () => {
    const prompt = buildMissingTestCasesPrompt(existing, 'Customer sign-up');
    expect(prompt).toContain('"reason"');
  });
});

describe('parseMissingTestCasesResponse', () => {
  it('parses a well-formed { suggestions } response', () => {
    const raw = JSON.stringify({
      suggestions: [
        {
          id: 'UI-1-99',
          name: 'SQL injection check',
          kind: 'ui',
          target: 'x',
          severity: 'High',
          precondition: '-',
          steps: ['1. ...'],
          dataTest: "' OR 1=1--",
          expectedResult: 'Handled safely',
          isEdgeCase: true,
          reason: 'No case tests injection on this field yet'
        }
      ]
    });
    const suggestions = parseMissingTestCasesResponse(raw);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].id).toBe('UI-1-99');
    expect(suggestions[0].reason).toBe('No case tests injection on this field yet');
  });

  it('strips a surrounding ```json fence before parsing', () => {
    const raw = '```json\n' + JSON.stringify({ suggestions: [] }) + '\n```';
    expect(() => parseMissingTestCasesResponse(raw)).not.toThrow();
  });

  it('throws when the response is not valid JSON', () => {
    expect(() => parseMissingTestCasesResponse('not json')).toThrow(/not valid JSON/);
  });

  it('throws when the JSON does not match the { suggestions } schema', () => {
    expect(() => parseMissingTestCasesResponse(JSON.stringify({ foo: 'bar' }))).toThrow(/expected/);
  });
});
