import * as fs from 'fs';
import { HashDiff, TestCase } from '../types';
import { diffByHash } from './hash';
import { COLUMN_LABELS, mapHeader, rowsToTestCases } from './testCaseColumns';

export interface TableIssue {
  /** Where to find and fix it, e.g. "line 12" or 'sheet "UI"'. */
  where: string;
  message: string;
}

export interface ParsedTestCaseMarkdown {
  functionId: string;
  testCases: TestCase[];
  issues: TableIssue[];
}

function splitCells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-+:?$/.test(cell));
}

interface MarkdownTable {
  line: number;
  header: string[];
  rows: string[][];
}

/** Finds each table: a header row, the |---|---| row right after it, and the following data rows. */
function findTables(lines: string[]): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const next = lines[i + 1]?.trim() ?? '';
    if (!line.startsWith('|') || !next.startsWith('|') || !isSeparatorRow(splitCells(next))) {
      i += 1;
      continue;
    }
    const rows: string[][] = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith('|')) {
      rows.push(splitCells(lines[j].trim()));
      j += 1;
    }
    tables.push({ line: i + 1, header: splitCells(line), rows });
    i = j;
  }
  return tables;
}

export function parseTestCaseMarkdown(content: string): ParsedTestCaseMarkdown {
  const heading = /^#\s*(.+?)\s*-\s*Test Cases\s*$/im.exec(content);
  const functionId = heading ? heading[1].trim() : 'Unknown Function';

  const testCases: TestCase[] = [];
  const issues: TableIssue[] = [];
  for (const table of findTables(content.split(/\r?\n/))) {
    const { columns, matched, missing } = mapHeader(table.header);
    if (missing.length === 0) {
      testCases.push(...rowsToTestCases(table.rows, columns, functionId));
    } else if (matched >= 2) {
      // Looks like a test case table but lacks required columns: report it rather than guess.
      issues.push({ where: `line ${table.line}`, message: `missing columns ${missing.map((k) => COLUMN_LABELS[k]).join(', ')}` });
    }
    // matched < 2: notes, summary tables, etc. Ignore.
  }
  return { functionId, testCases, issues };
}

function testCaseRaw(tc: TestCase): string {
  return JSON.stringify({
    name: tc.name,
    severity: tc.severity,
    precondition: tc.precondition,
    steps: tc.steps,
    dataTest: tc.dataTest,
    expectedResult: tc.expectedResult
  });
}

/**
 * Diffs parsed test cases against the previous generation's hashes (by id), so unchanged cases keep
 * their scripts and skip the LLM. Only source fields are hashed: automationStatus/automationNote are
 * LLM output and would make every case look changed after the first generation.
 */
export function diffTestCases(testCases: TestCase[], previousHashes: Record<string, string>): HashDiff & { removedIds: string[] } {
  const diff = diffByHash(
    testCases.map((tc) => ({ key: tc.id, raw: testCaseRaw(tc) })),
    previousHashes
  );
  const currentIds = new Set(testCases.map((tc) => tc.id));
  const removedIds = Object.keys(previousHashes).filter((id) => !currentIds.has(id));

  return { ...diff, removedIds };
}

function toMarkdownRow(tc: TestCase): string {
  const cells = [
    `[${tc.id}]`,
    tc.name,
    tc.severity,
    tc.precondition,
    tc.steps.join('<br>'),
    tc.dataTest,
    tc.expectedResult.replace(/\n/g, '<br>'),
    '',
    ''
  ];
  return `| ${cells.join(' | ')} |`;
}

/**
 * Appends AI-suggested test cases as a new section at the end of the source Markdown file. The file
 * stays the single source of truth: writing only to testcases.json would make the next diff treat
 * these cases as removed and move their scripts to _stale/.
 */
export function appendTestCasesToMarkdown(filePath: string, testCases: TestCase[]): void {
  if (testCases.length === 0) return;

  const date = new Date().toISOString().slice(0, 10);
  const header = `\n\n### AI suggestions (${date})\n\n`;
  const tableHeader =
    '| Test Case ID | Test Case Name | Severity | Pre-condition | Steps | Data Test | Expected Result | Ticket ID | Comment |\n' +
    '|---|---|---|---|---|---|---|---|---|\n';
  const rows = testCases.map(toMarkdownRow).join('\n');

  fs.appendFileSync(filePath, header + tableHeader + rows + '\n');
}
