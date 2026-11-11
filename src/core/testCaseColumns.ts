import { TestCase, TestSeverity } from '../types';

export type ColumnKey = 'id' | 'name' | 'severity' | 'precondition' | 'steps' | 'dataTest' | 'expectedResult' | 'kind';

/**
 * Accepted header names per field, compared after normalizing (lowercase, collapsed whitespace).
 * The Vietnamese aliases are intentional: they let teams use either English or Vietnamese headers.
 */
export const HEADER_ALIASES: Record<ColumnKey, string[]> = {
  id: ['test case id', 'tc id', 'id', 'mã test case', 'mã tc'],
  name: ['test case name', 'test case', 'tên test case', 'tên testcase', 'tiêu đề'],
  severity: ['severity', 'priority', 'mức độ', 'độ ưu tiên'],
  precondition: ['pre-condition', 'precondition', 'điều kiện tiên quyết', 'tiền điều kiện'],
  steps: ['steps', 'test steps', 'các bước', 'bước thực hiện'],
  dataTest: ['data test', 'test data', 'dữ liệu test', 'dữ liệu kiểm thử'],
  expectedResult: ['expected result', 'expected', 'kết quả mong đợi', 'kết quả mong muốn'],
  kind: ['kind', 'loại test']
};

export const REQUIRED_COLUMNS: ColumnKey[] = ['id', 'name', 'steps', 'expectedResult'];

/** Canonical column names, used in error messages and when writing AI suggestions back to the file. */
export const COLUMN_LABELS: Record<ColumnKey, string> = {
  id: 'Test Case ID', name: 'Test Case Name', severity: 'Severity', precondition: 'Pre-condition',
  steps: 'Steps', dataTest: 'Data Test', expectedResult: 'Expected Result', kind: 'Kind'
};

export type ColumnMap = Partial<Record<ColumnKey, number>>;

export interface HeaderMatch {
  columns: ColumnMap;
  /** Number of recognized columns. 2 or more means the table is meant to be a test case table. */
  matched: number;
  missing: ColumnKey[];
}

function normalizeHeader(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Maps columns by name, not position: any order works and unknown columns (No., Tester, Result...) are ignored. */
export function mapHeader(header: string[]): HeaderMatch {
  const columns: ColumnMap = {};
  header.forEach((cell, index) => {
    const name = normalizeHeader(cell);
    for (const key of Object.keys(HEADER_ALIASES) as ColumnKey[]) {
      if (columns[key] === undefined && HEADER_ALIASES[key].includes(name)) {
        columns[key] = index;
        break;
      }
    }
  });
  const missing = REQUIRED_COLUMNS.filter((key) => columns[key] === undefined);
  return { columns, matched: Object.keys(columns).length, missing };
}

/** English or Vietnamese severity names (Vietnamese: low, medium, high, critical). */
const SEVERITY_ALIASES: Record<string, TestSeverity> = {
  low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical',
  'thấp': 'Low', 'trung bình': 'Medium', cao: 'High', 'nghiêm trọng': 'Critical'
};

/** Both `<br>` (Markdown) and in-cell newlines (Alt+Enter in Excel) are line breaks. */
function splitLines(text: string): string[] {
  return text.split(/<br\s*\/?>|\r?\n/i).map((s) => s.trim()).filter(Boolean);
}

function multiline(text: string): string {
  return splitLines(text).join('\n');
}

/**
 * Converts table rows (Markdown or an Excel sheet) into TestCases.
 * A row with an empty ID, or the same ID as the row above (merged ID cell), continues the previous
 * case: its steps/expected result are appended to it. Cases spanning several rows are common in Excel.
 */
export function rowsToTestCases(rows: string[][], columns: ColumnMap, target: string): TestCase[] {
  const get = (cells: string[], key: ColumnKey): string => {
    const index = columns[key];
    return index === undefined ? '' : (cells[index] ?? '').trim();
  };

  const result: TestCase[] = [];
  for (const cells of rows) {
    const id = get(cells, 'id').replace(/^\[(.+)\]$/, '$1').trim();
    const last = result[result.length - 1];

    if (last && (!id || id === last.id)) {
      last.steps.push(...splitLines(get(cells, 'steps')));
      const more = multiline(get(cells, 'expectedResult'));
      if (more) last.expectedResult = [last.expectedResult, more].filter(Boolean).join('\n');
      continue;
    }
    if (!id) continue; // blank rows before the first case

    const kindCell = get(cells, 'kind').toLowerCase();
    result.push({
      id,
      name: get(cells, 'name'),
      kind: kindCell === 'api' || kindCell === 'ui' ? kindCell : /^api/i.test(id) ? 'api' : 'ui',
      target,
      severity: SEVERITY_ALIASES[get(cells, 'severity').toLowerCase()] ?? 'Medium',
      precondition: multiline(get(cells, 'precondition')) || '-',
      steps: splitLines(get(cells, 'steps')),
      dataTest: multiline(get(cells, 'dataTest')) || '-',
      expectedResult: multiline(get(cells, 'expectedResult')),
      isEdgeCase: false
    });
  }
  return result;
}

/** IDs key the hashes, so they must be unique within a function (even across sheets). */
export function findDuplicateIds(testCases: TestCase[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tc of testCases) {
    if (seen.has(tc.id)) duplicates.add(tc.id);
    seen.add(tc.id);
  }
  return [...duplicates];
}
