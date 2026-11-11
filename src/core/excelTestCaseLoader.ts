import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { TestCase } from '../types';
import { COLUMN_LABELS, HeaderMatch, mapHeader, rowsToTestCases } from './testCaseColumns';

/** The header is often not on row 1: Excel files tend to have project name, author, date above it. */
const HEADER_SCAN_ROWS = 30;

export interface ParsedSheet {
  sheetName: string;
  testCases: TestCase[];
  headerRow?: number;
  /** Set when the sheet looks like a test case table but lacks required columns. */
  issue?: string;
  /** Set when the sheet is not a test case table (Cover, Revision History...) or is hidden. */
  skipped?: string;
}

/** ExcelJS cell values can be text, number, date, rich text, formula or hyperlink. Normalize to a string. */
export function cellToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10); // yyyy-mm-dd
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('formula' in value || 'sharedFormula' in value) {
      return cellToText((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    }
    if ('hyperlink' in value) return cellToText(value.text as ExcelJS.CellValue);
    if ('error' in value) return '';
  }
  return String(value);
}

function rowCells(sheet: ExcelJS.Worksheet, rowNumber: number, width: number): string[] {
  const row = sheet.getRow(rowNumber);
  const cells: string[] = [];
  for (let col = 1; col <= width; col++) cells.push(cellToText(row.getCell(col).value));
  return cells;
}

function parseSheet(sheet: ExcelJS.Worksheet): ParsedSheet {
  const sheetName = sheet.name;
  if (sheet.state !== 'visible') return { sheetName, testCases: [], skipped: 'hidden sheet' };

  const width = sheet.columnCount;
  let header: { rowNumber: number; match: HeaderMatch } | undefined;
  for (let r = 1; r <= Math.min(sheet.rowCount, HEADER_SCAN_ROWS) && !header; r++) {
    const match = mapHeader(rowCells(sheet, r, width));
    if (match.matched >= 2) header = { rowNumber: r, match };
  }

  if (!header) return { sheetName, testCases: [], skipped: 'no test case header row' };
  if (header.match.missing.length > 0) {
    const missing = header.match.missing.map((key) => COLUMN_LABELS[key]).join(', ');
    return { sheetName, testCases: [], headerRow: header.rowNumber, issue: `row ${header.rowNumber}: missing columns ${missing}` };
  }

  const rows: string[][] = [];
  for (let r = header.rowNumber + 1; r <= sheet.rowCount; r++) rows.push(rowCells(sheet, r, width));
  return { sheetName, headerRow: header.rowNumber, testCases: rowsToTestCases(rows, header.match.columns, sheetName) };
}

/** Separate from file reading so tests can build workbooks in memory. */
export function parseWorkbook(workbook: ExcelJS.Workbook): ParsedSheet[] {
  const sheets: ParsedSheet[] = [];
  workbook.eachSheet((sheet) => sheets.push(parseSheet(sheet)));
  return sheets;
}

export async function parseTestCaseWorkbook(filePath: string): Promise<ParsedSheet[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.xlsm') {
    throw new Error(`${ext} files are not supported. Open the file in Excel and Save As .xlsx.`);
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return parseWorkbook(workbook);
}

/** Excel sheet names: max 31 chars, no : \ / ? * [ ], and unique. */
function uniqueSheetName(workbook: ExcelJS.Workbook, wanted: string): string {
  const base = wanted.replace(/[:\\/?*[\]]/g, '-').slice(0, 28);
  let name = base;
  for (let i = 2; workbook.getWorksheet(name); i++) name = `${base}-${i}`;
  return name;
}

/**
 * Writes the AI suggestions the user picked to a NEW sheet in the source Excel file; existing sheets
 * are untouched. The original is backed up first because ExcelJS rewrites the whole workbook and may
 * drop what it doesn't support (macros, pivots, some advanced formatting).
 */
export async function appendSuggestionsToWorkbook(filePath: string, testCases: TestCase[], sheetLabel: string): Promise<string> {
  if (path.extname(filePath).toLowerCase() !== '.xlsx') {
    throw new Error('Can only write back to .xlsx files (writing a .xlsm file would drop its macros).');
  }
  fs.copyFileSync(filePath, filePath.replace(/\.xlsx$/i, `.backup-${Date.now()}.xlsx`));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const date = new Date().toISOString().slice(0, 10);
  const sheet = workbook.addWorksheet(uniqueSheetName(workbook, `AI ${date} ${sheetLabel}`));

  const keys = ['id', 'name', 'severity', 'precondition', 'steps', 'dataTest', 'expectedResult'] as const;
  sheet.addRow(keys.map((key) => COLUMN_LABELS[key])).font = { bold: true };
  for (const tc of testCases) {
    sheet.addRow([tc.id, tc.name, tc.severity, tc.precondition, tc.steps.join('\n'), tc.dataTest, tc.expectedResult]);
  }
  sheet.columns.forEach((column) => {
    column.width = 32;
    column.alignment = { wrapText: true, vertical: 'top' };
  });

  await workbook.xlsx.writeFile(filePath); // fails with EBUSY if the file is open in Excel (Windows)
  return sheet.name;
}
