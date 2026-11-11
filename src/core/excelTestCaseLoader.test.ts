import ExcelJS from 'exceljs';
import { describe, it, expect } from 'vitest';
import { parseWorkbook } from './excelTestCaseLoader';

function buildWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();

  const cover = wb.addWorksheet('Cover');
  cover.addRow(['Project', 'Demo']);
  cover.addRow(['Author', 'QA team']);

  // Vietnamese headers and severity ('Cao' = High) on purpose: they must map like the English ones.
  const ui = wb.addWorksheet('Signup - UI');
  ui.addRow(['TEST CASE: Customer signup']);                // title above the header
  ui.addRow([]);
  ui.addRow(['No.', 'Mã TC', 'Tên test case', 'Các bước', 'Kết quả mong đợi', 'Mức độ', 'Tester']);
  ui.addRow([1, 'TC01', 'Empty full name', '1. Leave Full name empty\n2. Click Sign up', 'Shows "Please enter your full name"', 'Cao', 'An']);
  ui.addRow([2, 'TC02', 'Invalid email format', '1. Enter Email = "abc@"', 'Shows an email error', 'medium', 'An']);
  ui.addRow([null, null, null, '2. Click Sign up', 'Email field has a red border', null, null]); // continuation row
  ui.mergeCells('B5:B6');                                    // ID cell merged across 2 rows

  const api = wb.addWorksheet('Signup - API');
  api.addRow(['Expected Result', 'Test Case ID', 'Steps', 'Test Case Name', 'Data Test']); // different order
  api.addRow(['400', 'API01', 'POST /api/customers', 'Missing fullName', { richText: [{ text: 'fullName=' }, { text: '""' }] }]);
  api.addRow(['201', 'API02', 'POST /api/customers', 'Valid', new Date(Date.UTC(2000, 0, 1))]);

  const broken = wb.addWorksheet('Bad header');
  broken.addRow(['Test Case ID', 'Steps', 'Notes']);
  broken.addRow(['X1', 'abc', '']);

  const hidden = wb.addWorksheet('Draft', { state: 'hidden' });
  hidden.addRow(['Test Case ID', 'Test Case Name', 'Steps', 'Expected Result']);
  hidden.addRow(['H1', 'hidden', 'x', 'y']);
  return wb;
}

describe('parseWorkbook', () => {
  const sheets = parseWorkbook(buildWorkbook());
  const byName = (n: string) => sheets.find((s) => s.sheetName === n)!;

  it('skips non-test-case sheets and hidden sheets', () => {
    expect(byName('Cover').skipped).toBeDefined();
    expect(byName('Draft').skipped).toBe('hidden sheet');
  });

  it('finds a header below row 1, maps Vietnamese column names, and merges continuation rows', () => {
    const ui = byName('Signup - UI');
    expect(ui.headerRow).toBe(3);
    expect(ui.testCases.map((t) => t.id)).toEqual(['TC01', 'TC02']);
    expect(ui.testCases[0].severity).toBe('High');
    expect(ui.testCases[0].steps).toEqual(['1. Leave Full name empty', '2. Click Sign up']);
    expect(ui.testCases[1].steps).toEqual(['1. Enter Email = "abc@"', '2. Click Sign up']);
    expect(ui.testCases[1].expectedResult).toBe('Shows an email error\nEmail field has a red border');
  });

  it('handles reordered columns, rich text, dates, and infers API kind from the ID prefix', () => {
    const [a1, a2] = byName('Signup - API').testCases;
    expect(a1).toMatchObject({ id: 'API01', kind: 'api', name: 'Missing fullName', dataTest: 'fullName=""', expectedResult: '400' });
    expect(a2.dataTest).toBe('2000-01-01');
  });

  it('reports a sheet missing required columns instead of guessing', () => {
    expect(byName('Bad header').issue).toBe('row 1: missing columns Test Case Name, Expected Result');
    expect(byName('Bad header').testCases).toHaveLength(0);
  });
});
