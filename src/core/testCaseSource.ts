import * as fs from 'fs';
import * as path from 'path';
import { TestCase } from '../types';
import { findDuplicateIds } from './testCaseColumns';
import { parseTestCaseMarkdown, TableIssue } from './testCaseMarkdownLoader';
import { parseTestCaseWorkbook } from './excelTestCaseLoader';

/** Stored in the function's meta.json: the source file and, for Excel, the sheets that belong to it. */
export interface TestCaseSource {
  path: string;
  sheets?: string[];
}

export interface LoadedTestCases {
  testCases: TestCase[];
  issues: TableIssue[];
}

/** Reloads a function's test cases from its source file, on re-import and before each Sync Test. */
export async function loadTestCasesFromSource(source: TestCaseSource, functionId: string): Promise<LoadedTestCases> {
  let testCases: TestCase[];
  const issues: TableIssue[] = [];

  if (path.extname(source.path).toLowerCase() === '.md') {
    const parsed = parseTestCaseMarkdown(fs.readFileSync(source.path, 'utf-8'));
    testCases = parsed.testCases;
    issues.push(...parsed.issues);
  } else {
    const sheets = await parseTestCaseWorkbook(source.path);
    const wanted = source.sheets ?? sheets.filter((s) => s.testCases.length > 0).map((s) => s.sheetName);
    testCases = [];
    for (const name of wanted) {
      const sheet = sheets.find((s) => s.sheetName === name);
      if (!sheet) issues.push({ where: `sheet "${name}"`, message: 'is no longer in the file (renamed or deleted?)' });
      else if (sheet.issue) issues.push({ where: `sheet "${name}"`, message: sheet.issue });
      else testCases.push(...sheet.testCases);
    }
  }

  for (const id of findDuplicateIds(testCases)) {
    issues.push({ where: `ID ${id}`, message: 'is duplicated in the same function' });
  }
  return { testCases: testCases.map((tc) => ({ ...tc, target: functionId })), issues };
}
