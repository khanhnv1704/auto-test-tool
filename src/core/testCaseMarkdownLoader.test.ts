import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTestCaseMarkdown, diffTestCases, appendTestCasesToMarkdown } from './testCaseMarkdownLoader';
import { TestCase } from '../types';

const SAMPLE_MD = `
# Customer signup - Test Cases

## Access & Authorization

| Test Case ID | Test Case Name | Severity | Pre-condition | Steps | Data Test | Expected Result | Ticket ID | Comment |
|---|---|---|---|---|---|---|---|---|
| [UI-1-01] | Leave Full name empty | High | Screen is open | 1. Leave the Full name field empty.<br>2. Click Sign up. | Empty | Shows the error "Please enter Full name".<br>Field is highlighted in red. | | |
| [UI-1-02] | Drag and drop an image file | Low | Screen is open | 1. Drag an image file onto the upload area. | File .png | Upload succeeds. | | |
`;

describe('parseTestCaseMarkdown', () => {
  it('parses the function id from the heading', () => {
    const { functionId } = parseTestCaseMarkdown(SAMPLE_MD);
    expect(functionId).toBe('Customer signup');
  });

  it('parses each table row into a TestCase with steps split by <br>', () => {
    const { testCases } = parseTestCaseMarkdown(SAMPLE_MD);
    expect(testCases).toHaveLength(2);

    const first = testCases[0];
    expect(first.id).toBe('UI-1-01');
    expect(first.kind).toBe('ui');
    expect(first.severity).toBe('High');
    expect(first.steps).toEqual(['1. Leave the Full name field empty.', '2. Click Sign up.']);
    expect(first.expectedResult).toBe('Shows the error "Please enter Full name".\nField is highlighted in red.');
    expect(first.target).toBe('Customer signup');
  });

  it('does not invent isEdgeCase/category — defaults are conservative', () => {
    const { testCases } = parseTestCaseMarkdown(SAMPLE_MD);
    expect(testCases[0].isEdgeCase).toBe(false);
    expect(testCases[0].category).toBeUndefined();
  });

  it('infers kind="api" when the id starts with "API" (case-insensitive), and "ui" otherwise', () => {
    const MIXED_KIND_MD = `
# CustomerSignup - Test Cases

| Test Case ID | Test Case Name | Severity | Pre-condition | Steps | Data Test | Expected Result | Ticket ID | Comment |
|---|---|---|---|---|---|---|---|---|
| [API01] | Create a valid customer | Medium | - | 1. Send the request. | fullName="An" | 201 Created | | |
| [api02] | Missing fullName | High | - | 1. Send the request. | fullName="" | 400 | | |
| [TC01] | Check the UI | Medium | Screen is open | 1. Enter the full name. | "An" | Signup succeeds | | |
`;
    const { testCases } = parseTestCaseMarkdown(MIXED_KIND_MD);
    expect(testCases.find((tc) => tc.id === 'API01')?.kind).toBe('api');
    expect(testCases.find((tc) => tc.id === 'api02')?.kind).toBe('api');
    expect(testCases.find((tc) => tc.id === 'TC01')?.kind).toBe('ui');
  });

  it('reports no issues for a well-formed table with extra columns (Ticket ID/Comment)', () => {
    expect(parseTestCaseMarkdown(SAMPLE_MD).issues).toEqual([]);
  });

  it('maps columns by name, so a reordered header with extra columns still parses', () => {
    const REORDERED_MD = `
# CustomerSignup - Test Cases

| No. | Steps | Test Case ID | Expected Result | Test Case Name |
|---|---|---|---|---|
| 1 | 1. A<br>2. B | [TC01] | Error X | Case 1 |
`;
    const { testCases, issues } = parseTestCaseMarkdown(REORDERED_MD);
    expect(issues).toEqual([]);
    expect(testCases[0]).toMatchObject({ id: 'TC01', name: 'Case 1', steps: ['1. A', '2. B'], expectedResult: 'Error X' });
    expect(testCases[0]).toMatchObject({ severity: 'Medium', precondition: '-', dataTest: '-' });
  });

  it('reports a test-case-like table that misses required columns INSTEAD OF silently mis-mapping columns', () => {
    // Same shape as the real bug: a custom-column table that still had >= 7 cells, so a positional parser
    // read the wrong columns without any error. It must be skipped and reported instead.
    const CUSTOM_COLUMNS_MD = `
# CustomerSignup - Test Cases

| TC ID | Test Case Name | Related field | Type | Sample Request Body | HTTP Status | Expected Response Message |
|---|---|---|---|---|---|---|
| API01 | Create a valid customer | All | Pass | fullName="An" | 201 Created | { "id": "1" } |
`;
    const { testCases, issues } = parseTestCaseMarkdown(CUSTOM_COLUMNS_MD);
    expect(testCases).toEqual([]);
    expect(issues).toEqual([{ where: 'line 4', message: 'missing columns Steps, Expected Result' }]);
  });

  it('ignores tables that match fewer than 2 known columns, e.g. a notes table elsewhere in the doc', () => {
    const WITH_NOTES_TABLE = `${SAMPLE_MD}

## Notes
| TC ID | Issue |
|---|---|
| UI-1-01 | BA to confirm the error message |
`;
    const { testCases, issues } = parseTestCaseMarkdown(WITH_NOTES_TABLE);
    expect(testCases).toHaveLength(2);
    expect(issues).toEqual([]);
  });

  it('merges continuation rows (empty ID) into the case above', () => {
    const CONTINUATION_MD = `
# CustomerSignup - Test Cases

| Test Case ID | Test Case Name | Steps | Expected Result |
|---|---|---|---|
| TC01 | Case 1 | 1. A | X |
|  |  | 2. B | Y |
`;
    const [tc] = parseTestCaseMarkdown(CONTINUATION_MD).testCases;
    expect(tc.steps).toEqual(['1. A', '2. B']);
    expect(tc.expectedResult).toBe('X\nY');
  });
});

describe('diffTestCases', () => {
  it('reports all testcases as changed when there is no previous hash', () => {
    const { testCases } = parseTestCaseMarkdown(SAMPLE_MD);
    const diff = diffTestCases(testCases, {});
    expect(diff.changedKeys.sort()).toEqual(['UI-1-01', 'UI-1-02']);
    expect(diff.unchangedKeys).toEqual([]);
    expect(diff.removedIds).toEqual([]);
  });

  it('reports unchanged testcases as unchanged and only edited ones as changed', () => {
    const { testCases } = parseTestCaseMarkdown(SAMPLE_MD);
    const first = diffTestCases(testCases, {});

    const edited = testCases.map((tc) => (tc.id === 'UI-1-01' ? { ...tc, name: 'Leave Full name empty (updated)' } : tc));
    const second = diffTestCases(edited, first.newHashes);

    expect(second.changedKeys).toEqual(['UI-1-01']);
    expect(second.unchangedKeys).toEqual(['UI-1-02']);
    expect(second.removedIds).toEqual([]);
  });

  it('reports ids missing from the new set as removed', () => {
    const { testCases } = parseTestCaseMarkdown(SAMPLE_MD);
    const first = diffTestCases(testCases, {});

    const withoutSecond = testCases.filter((tc) => tc.id !== 'UI-1-02');
    const second = diffTestCases(withoutSecond, first.newHashes);

    expect(second.removedIds).toEqual(['UI-1-02']);
    expect(second.unchangedKeys).toEqual(['UI-1-01']);
  });
});

describe('appendTestCasesToMarkdown', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    while (tmpFiles.length) fs.rmSync(tmpFiles.pop()!, { force: true });
  });

  function makeTmpFile(content: string): string {
    const file = path.join(os.tmpdir(), `aitest-append-md-${process.pid}-${tmpFiles.length}.md`);
    fs.writeFileSync(file, content);
    tmpFiles.push(file);
    return file;
  }

  it('does nothing when given an empty list', () => {
    const file = makeTmpFile(SAMPLE_MD);
    const before = fs.readFileSync(file, 'utf-8');
    appendTestCasesToMarkdown(file, []);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('appends a new AI-suggested section that round-trips back through parseTestCaseMarkdown', () => {
    const file = makeTmpFile(SAMPLE_MD);
    const suggestions: TestCase[] = [
      {
        id: 'UI-1-03',
        name: 'SQL injection in the Full name field',
        kind: 'ui',
        target: 'Customer signup',
        severity: 'High',
        precondition: 'Screen is open',
        steps: ["1. Enter \"' OR 1=1--\" in Full name.", '2. Click Sign up.'],
        dataTest: "' OR 1=1--",
        expectedResult: 'The input is stored safely as a plain string.\nNo SQL error occurs.',
        isEdgeCase: true
      }
    ];

    appendTestCasesToMarkdown(file, suggestions);

    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('### AI suggestions (');

    const { testCases } = parseTestCaseMarkdown(content);
    expect(testCases).toHaveLength(3);
    const appended = testCases.find((tc) => tc.id === 'UI-1-03');
    expect(appended?.name).toBe('SQL injection in the Full name field');
    expect(appended?.severity).toBe('High');
    expect(appended?.steps).toEqual(["1. Enter \"' OR 1=1--\" in Full name.", '2. Click Sign up.']);
    expect(appended?.expectedResult).toBe('The input is stored safely as a plain string.\nNo SQL error occurs.');
  });
});
