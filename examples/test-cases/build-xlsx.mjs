// Builds signup.test-cases.xlsx from signup.test-cases.md so the two sample files stay in sync.
//
// Usage (from the repository root, after `npm install`):
//   node examples/test-cases/build-xlsx.mjs
//
// The workbook deliberately looks like a typical QA spreadsheet, to show that the importer maps
// columns by NAME and skips non-test-case sheets:
//   - "Cover" and "Revision History": no test case table, skipped on import.
//   - "UI": a title row and an empty row above the header, extra "No." and "Result" columns.
//   - "API": header on row 1, with a different column order.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const here = dirname(fileURLToPath(import.meta.url));
const mdPath = join(here, 'signup.test-cases.md');
const xlsxPath = join(here, 'signup.test-cases.xlsx');

const FIELDS = ['id', 'name', 'severity', 'precondition', 'steps', 'dataTest', 'expectedResult'];

function splitCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Reads every test case row of every Markdown table whose first header cell is "Test Case ID". */
function readTestCases(markdown) {
  const cases = [];
  let inTable = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = splitCells(line);
    if (cells[0] === 'Test Case ID') {
      inTable = true;
      continue;
    }
    if (!inTable || cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const tc = {};
    FIELDS.forEach((key, i) => {
      tc[key] = (cells[i] ?? '').replace(/<br\s*\/?>/gi, '\n');
    });
    tc.id = tc.id.replace(/^\[(.+)\]$/, '$1');
    cases.push(tc);
  }
  return cases;
}

const all = readTestCases(readFileSync(mdPath, 'utf-8'));
const uiCases = all.filter((tc) => tc.id.startsWith('TC'));
const apiCases = all.filter((tc) => tc.id.startsWith('API'));
if (uiCases.length === 0 || apiCases.length === 0) {
  throw new Error(`Expected UI and API test cases in ${mdPath}, found ${uiCases.length} UI / ${apiCases.length} API`);
}

const workbook = new ExcelJS.Workbook();
workbook.creator = 'AI Auto Test example';

const wrap = { wrapText: true, vertical: 'top' };
const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE7F3' } };
const thin = { style: 'thin', color: { argb: 'FFB0B7C3' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = headerFill;
    cell.alignment = { wrapText: true, vertical: 'middle' };
    cell.border = border;
  });
}

function styleBody(row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.alignment = wrap;
    cell.border = border;
  });
}

// --- Cover ---------------------------------------------------------------------------------------
const cover = workbook.addWorksheet('Cover');
cover.columns = [{ width: 18 }, { width: 70 }];
cover.addRow(['Project', 'Demo sign-up app']);
cover.addRow(['Version', '1.0']);
cover.addRow(['Description', 'Sample test cases for the customer sign-up form and API of the AI Auto Test demo app.']);
cover.eachRow((row) => {
  row.getCell(1).font = { bold: true };
  row.eachCell((cell) => (cell.alignment = wrap));
});

// --- Revision History ----------------------------------------------------------------------------
const history = workbook.addWorksheet('Revision History');
history.columns = [{ width: 6 }, { width: 14 }, { width: 70 }];
styleHeader(history.addRow(['No', 'Date', 'Description']));
styleBody(history.addRow([1, '2026-01-15', 'Initial version: 25 UI and 25 API test cases.']));

// --- UI ------------------------------------------------------------------------------------------
const ui = workbook.addWorksheet('UI');
ui.columns = [
  { width: 6 }, { width: 12 }, { width: 36 }, { width: 10 }, { width: 28 },
  { width: 55 }, { width: 40 }, { width: 50 }, { width: 10 }
];
ui.addRow(['Customer sign-up — UI test cases']).getCell(1).font = { bold: true, size: 14 };
ui.addRow([]);
styleHeader(ui.addRow([
  'No.', 'Test Case ID', 'Test Case Name', 'Severity', 'Pre-condition', 'Steps', 'Data Test', 'Expected Result', 'Result'
]));
uiCases.forEach((tc, i) => {
  styleBody(ui.addRow([
    i + 1, tc.id, tc.name, tc.severity, tc.precondition, tc.steps, tc.dataTest, tc.expectedResult, ''
  ]));
});
ui.views = [{ state: 'frozen', ySplit: 3 }];

// --- API -----------------------------------------------------------------------------------------
const api = workbook.addWorksheet('API');
api.columns = [
  { width: 12 }, { width: 36 }, { width: 55 }, { width: 40 }, { width: 60 }, { width: 10 }, { width: 28 }
];
styleHeader(api.addRow([
  'Test Case ID', 'Test Case Name', 'Steps', 'Data Test', 'Expected Result', 'Severity', 'Pre-condition'
]));
apiCases.forEach((tc) => {
  styleBody(api.addRow([
    tc.id, tc.name, tc.steps, tc.dataTest, tc.expectedResult, tc.severity, tc.precondition
  ]));
});
api.views = [{ state: 'frozen', ySplit: 1 }];

await workbook.xlsx.writeFile(xlsxPath);
console.log(`Wrote ${xlsxPath}: ${uiCases.length} UI + ${apiCases.length} API test cases`);
