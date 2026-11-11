import { nonce } from './popupModal';
import * as vscode from 'vscode';
import * as path from 'path';
import { functionDir, readBlockedCases, readRoundReport, readRounds, readTestCases, RoundSummary } from '../core/store';
import { extractTestId } from '../core/testRunner';
import { TABLE_INTERACTIONS_SCRIPT, TABLE_INTERACTIONS_STYLE } from './tableInteractions';
import { MainPanel } from './mainPanel';

export interface LiveStep {
  title: string;
  /** 'running' | 'passed' | 'failed'. */
  status: string;
  durationMs?: number;
}

export interface LiveRow {
  id: string;
  label: string;
  /** Generate lane: 'pending' | 'running' | 'done' | 'error'. Execute lane: 'pending' | 'running' | 'passed' | 'failed'. */
  status: string;
  extra?: string;
  /** Execute lane, only when status is 'passed'/'failed'. */
  durationMs?: number;
  /** Execute lane, only when status is 'failed': path to the bug report markdown. */
  bugReportPath?: string;
  /** Execute lane: the Playwright action currently running (page.goto/locator.click/...). */
  currentStep?: string;
  /** Execute lane: actions already run for this test case, newest last. */
  steps?: LiveStep[];
  /** Generate lane, only when generating scripts from existing test cases (see TestCase.automationStatus). */
  automationStatus?: 'automatable' | 'manual';
}

const STATUS_META: Record<string, { icon: string; label: string }> = {
  pending: { icon: '⬜', label: 'Pending' },
  running: { icon: '⏳', label: 'Running' },
  done: { icon: '✅', label: 'Done' },
  passed: { icon: '✅', label: 'Pass' },
  error: { icon: '❌', label: 'Error' },
  failed: { icon: '❌', label: 'Fail' }
};

/** Execute lane: Pass/Fail shown in its own column, separate from progress (pending/running/done). */
const RESULT_META: Record<string, { icon: string; label: string }> = {
  passed: { icon: '✅', label: 'Pass' },
  failed: { icon: '❌', label: 'Failed' }
};

const GENERATE_KEY = '__generate__';

function executeKey(functionId: string, round: number): string {
  return `${functionId}::round-${round}`;
}

function summaryKey(functionId: string): string {
  return `${functionId}::summary`;
}

/** Handles messages from every ReportPanel view. Actions are delegated to `aitest.*` commands in the
 * extension host; this panel holds no process handles or test runner state. */
function handleReportMessage(msg: {
  command?: string;
  path?: string;
  functionId?: string;
  round?: number;
  viewingRound?: number;
  ids?: string[];
  id?: string;
  block?: boolean;
}): void {
  // Stop/Pause/Resume buttons on the live dashboard (see renderExecuteLiveShell).
  if (msg?.command === 'stopRun' && msg.functionId) {
    void vscode.commands.executeCommand('aitest.stopRun', msg.functionId);
    return;
  }
  if (msg?.command === 'pauseRun' && msg.functionId) {
    void vscode.commands.executeCommand('aitest.pauseRun', msg.functionId);
    return;
  }
  if (msg?.command === 'resumeRun' && msg.functionId) {
    void vscode.commands.executeCommand('aitest.resumeRun', msg.functionId);
    return;
  }
  if (msg?.command === 'openPath' && msg.path) {
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path)).then(undefined, () =>
      vscode.window.showWarningMessage(`AI Auto Test: could not open file "${msg.path}".`)
    );
    return;
  }
  // "Retest" for the test cases checked in the static report (see renderRound).
  if (msg?.command === 'retest' && msg.functionId && typeof msg.round === 'number' && msg.ids?.length) {
    void vscode.commands.executeCommand('aitest.retestSelected', msg.functionId, msg.round, msg.ids);
    return;
  }
  // "❌ Failed" link (see renderRound) opens the bug detail view.
  if (msg?.command === 'showBugDetail' && msg.functionId && typeof msg.round === 'number' && msg.id) {
    void vscode.commands.executeCommand('aitest.showBugDetail', msg.functionId, msg.round, msg.id);
    return;
  }
  // Block/Unblock an untested case (see renderRound). The extension host prompts for the block reason.
  if (msg?.command === 'toggleBlocked' && msg.functionId && typeof msg.round === 'number' && msg.id) {
    void vscode.commands.executeCommand(
      'aitest.toggleBlockedCase',
      msg.functionId,
      msg.round,
      msg.id,
      msg.block ?? true
    );
    return;
  }
  // Delete a round from the round history table. `round` is the one to delete; `viewingRound` is the one
  // shown in this panel (they may differ), so the host knows whether to switch views or close the panel.
  if (msg?.command === 'deleteRound' && msg.functionId && typeof msg.round === 'number') {
    void vscode.commands.executeCommand('aitest.deleteRound', msg.functionId, msg.round, msg.viewingRound);
  }
}

/**
 * Report webview, in two modes:
 *  1) Live dashboard while Generate/Run runs in the background. Rows are patched via postMessage
 *     rather than re-rendering the whole HTML.
 *  2) Static report for a finished round, read from disk (report.json/testcases.json/rounds.json), so
 *     it can be reopened at any time.
 * All views share the single MainPanel tab.
 */
export class ReportPanel {
  /** Open the live Generate dashboard, seeded with initial `rows` (e.g. all 'pending'). */
  static showGenerateDashboard(rows: LiveRow[] = []): void {
    MainPanel.show(GENERATE_KEY, 'AI Auto Test — Generating tests...', renderGenerateLiveShell(), handleReportMessage);
    MainPanel.postMessageIfCurrent(GENERATE_KEY, { type: 'init', rows });
  }

  static updateGenerateRows(rows: LiveRow[]): void {
    if (rows.length === 0) return;
    MainPanel.postMessageIfCurrent(GENERATE_KEY, { type: 'upsert', rows });
  }

  static removeGenerateRows(ids: string[]): void {
    if (ids.length === 0) return;
    MainPanel.postMessageIfCurrent(GENERATE_KEY, { type: 'remove', ids });
  }

  /** Call when Generate Tests ends (success, no changes, or error) to replace the "Generating" title. */
  static finishGenerateDashboard(message: string): void {
    MainPanel.setTitleIfCurrent(GENERATE_KEY, `AI Auto Test — ${message}`);
    MainPanel.postMessageIfCurrent(GENERATE_KEY, { type: 'finish', message });
  }

  /**
   * Open the live Run Tests dashboard for one (functionId, round). `slowMoMs` is the chosen slow-motion
   * delay, shown on the panel so the user can adjust it next time.
   */
  static showExecuteDashboard(functionId: string, round: number, rows: LiveRow[] = [], slowMoMs = 0): void {
    const key = executeKey(functionId, round);
    MainPanel.show(key, `AI Auto Test — ${functionId} round ${round} running...`, renderExecuteLiveShell(functionId, slowMoMs), handleReportMessage);
    MainPanel.postMessageIfCurrent(key, { type: 'init', rows });
  }

  static updateExecuteRows(functionId: string, round: number, rows: LiveRow[]): void {
    if (rows.length === 0) return;
    MainPanel.postMessageIfCurrent(executeKey(functionId, round), { type: 'upsert', rows });
  }

  /** Static report for one round, read from disk. */
  static showRound(functionId: string, round: number): void {
    const key = executeKey(functionId, round);
    MainPanel.show(key, `AI Auto Test Report — ${functionId} round ${round}`, renderRound(functionId, round), handleReportMessage);
  }

  /** Close this round's report if it is the current view (used after deleting the function's last round). */
  static closeRound(functionId: string, round: number): void {
    MainPanel.closeIfCurrent(executeKey(functionId, round));
  }

  /** Summary report for a function across all rounds run. */
  static showSummary(functionId: string): void {
    const key = summaryKey(functionId);
    MainPanel.show(key, `AI Auto Test — Summary report ${functionId}`, renderSummary(functionId), handleReportMessage);
  }
}


function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** "Xm Ys" for round durations, which can run for minutes (formatDuration is for single test cases). */
function formatLongDuration(ms: number | undefined): string {
  if (typeof ms !== 'number') return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const SHARED_STYLE = `
  body { font-family: -apple-system, sans-serif; padding: 16px; color: #ddd; background: #1e1e1e; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  td, th { padding: 6px 8px; border-bottom: 1px solid #444; text-align: left; font-size: 13px; vertical-align: top; }
  tr[data-status="failed"], tr.failed, tr[data-status="error"] { background: rgba(255, 0, 0, 0.08); }
  tr[data-status="passed"], tr.passed, tr[data-status="done"] { background: rgba(0, 200, 0, 0.06); }
  tr.current { outline: 2px solid #4a9eff; }
  #overview, .summary { font-size: 14px; font-weight: 600; margin-top: 4px; }
  h4 { margin-bottom: 4px; }
  .id { font-family: ui-monospace, monospace; white-space: nowrap; }
  a.open-path, .result a { color: #ff6b6b; cursor: pointer; text-decoration: underline; }
  tr.testcase { cursor: pointer; }
  tr.testcase:hover { background: rgba(255, 255, 255, 0.04); }
  .toggle { color: #888; font-family: ui-monospace, monospace; }
  .current-step { color: #4a9eff; font-family: ui-monospace, monospace; font-size: 12px; }
  #now { margin-top: 10px; padding: 8px 10px; border-left: 3px solid #4a9eff; background: rgba(74, 158, 255, 0.08); font-size: 13px; min-height: 18px; }
  #now .idle { color: #888; }
  #now div { margin: 2px 0; }
  td.steps { background: #181818; padding: 8px 8px 8px 28px; }
  td.steps ol { margin: 0; padding-left: 18px; }
  td.steps li { font-family: ui-monospace, monospace; font-size: 12px; padding: 1px 0; color: #bbb; }
  td.steps li.failed { color: #ff8080; }
  td.steps li.running { color: #4a9eff; }
  td.steps .empty { color: #888; font-size: 12px; }
  .hint { color: #888; font-size: 12px; margin: 8px 0 0; }
  .toolbar { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 13px; }
  .toolbar select, .toolbar button { font-size: 13px; }
  .run-controls { display: flex; gap: 8px; margin: 8px 0; }
  .btn { font-size: 13px; padding: 4px 10px; border-radius: 4px; border: 1px solid #555; background: #2d2d2d; color: #ddd; cursor: pointer; }
  .btn:hover:not(:disabled) { background: #3a3a3a; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.danger { border-color: #a33; color: #ff8080; }
  .btn.danger:hover:not(:disabled) { background: rgba(255, 0, 0, 0.1); }
  tr.untested { background: rgba(255, 255, 255, 0.02); }
  .blocked { color: #ff8080; font-weight: 600; }
  .blocked-reason { color: #888; font-size: 11px; }
  a.toggle-blocked { color: #4a9eff; cursor: pointer; text-decoration: underline; font-size: 12px; margin-left: 6px; }
  table.info-table td, table.info-table th { border: none; padding: 4px 10px 4px 0; }
  table.info-table th { color: #888; font-weight: 600; white-space: nowrap; }
  table.summary-table th, table.summary-table td { text-align: center; }
  table.summary-table td.id { text-align: left; font-weight: 600; }
  ${TABLE_INTERACTIONS_STYLE}
`;

/**
 * Styles used only by renderSummary (KPIs, composition bar, trend charts). The good/critical/neutral
 * status colors are kept distinct from the #4a9eff accent so "status" never reads as "selected".
 */
const SUMMARY_STYLE = `
  :root {
    --good: #2fb344; --good-wash: rgba(47,179,68,.14);
    --critical: #e5484d; --critical-wash: rgba(229,72,77,.14);
    --neutral: #6e6e6e;
    --card: #2a2a2b; --border-soft: #333332; --text-muted: #7a7a7a;
  }
  .new-tag {
    font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    background: rgba(47,179,68,.16); border: 1px solid rgba(47,179,68,.4); color: #7be08c;
    padding: 1px 6px; border-radius: 999px;
  }
  .section-caption { color: var(--text-muted); font-size: 11.5px; margin: 0 0 12px; }

  .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 10px; }
  .kpi-tile { background: var(--card); border: 1px solid #444; border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .kpi-label { color: #9a9a9a; font-size: 11px; font-weight: 600; }
  .kpi-value-row { display: flex; align-items: baseline; gap: 8px; }
  .kpi-value { font-size: 26px; font-weight: 650; letter-spacing: -0.01em; }
  .kpi-delta { font-size: 11.5px; font-weight: 600; }
  .kpi-delta.good { color: var(--good); }
  .kpi-delta.bad { color: var(--critical); }
  .kpi-delta.flat { color: var(--text-muted); }
  .kpi-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
  .kpi-foot-text { color: var(--text-muted); font-size: 10.5px; }
  .kpi-spark path.area { fill: #4a9eff; opacity: .12; }
  .kpi-spark path.line { fill: none; stroke: #4a9eff; stroke-width: 1.6; }
  .kpi-spark circle { fill: #4a9eff; }

  .composition-card { background: var(--card); border: 1px solid #444; border-radius: 8px; padding: 14px 16px; margin-top: 10px; }
  .composition-head { color: #9a9a9a; font-size: 12px; margin-bottom: 10px; }
  .comp-bar { display: flex; height: 26px; border-radius: 5px; overflow: hidden; background: #1e1e1e; }
  .comp-seg { position: relative; height: 100%; }
  .comp-seg + .comp-seg { margin-left: 2px; }
  .comp-seg.passed { background: var(--good); }
  .comp-seg.failed { background: var(--critical); }
  .comp-seg.untested { background: var(--neutral); }
  .comp-seg .seg-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11.5px; font-weight: 700; color: #0a1a0a; }
  .comp-legend { display: flex; gap: 18px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #9a9a9a; }
  .legend-swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .legend-item b { color: #ddd; }
  .legend-item .swatch-passed { background: var(--good); }
  .legend-item .swatch-failed { background: var(--critical); }
  .legend-item .swatch-untested { background: var(--neutral); }
  .legend-note { color: var(--text-muted); font-size: 11px; margin-left: auto; }

  .chart-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin: 10px 0 12px; }
  .shared-legend { display: flex; gap: 16px; }
  .pager { display: flex; align-items: center; gap: 10px; }
  .pager-range { color: #9a9a9a; font-size: 12px; white-space: nowrap; }

  .charts-row { display: flex; gap: 16px; flex-wrap: wrap; align-items: stretch; }
  .chart-card { background: var(--card); border: 1px solid #444; border-radius: 8px; padding: 14px 16px 10px; flex: 1 1 420px; min-width: 320px; }
  .chart-card-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
  .chart-card-title { font-size: 12.5px; font-weight: 600; }
  .chart-card-title .muted { color: var(--text-muted); font-weight: 400; }
  svg.chart { display: block; width: 100%; height: auto; overflow: visible; font-family: inherit; }
  .grid-line { stroke: var(--border-soft); stroke-width: 1; }
  .axis-label { fill: var(--text-muted); font-size: 9.5px; }
  .axis-label.y { text-anchor: end; }
  .bar-seg.passed { fill: var(--good); }
  .bar-seg.failed { fill: var(--critical); }
  .bar-seg.untested { fill: var(--neutral); }
  .bar-seg-group.hover .bar-seg { filter: brightness(1.18); }
  .bar-hit { fill: transparent; cursor: pointer; }
  .round-tick { fill: #9a9a9a; font-size: 10px; text-anchor: middle; }
  .round-tick.current { fill: #ddd; font-weight: 700; }
  .line-area { fill: #4a9eff; opacity: .10; }
  .line-path { fill: none; stroke: #4a9eff; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .line-dot { fill: #4a9eff; stroke: var(--card); stroke-width: 2; }
  .line-dot.dip { fill: var(--critical); }
  .line-hit { fill: transparent; cursor: pointer; }
  .value-label { font-size: 10.5px; font-weight: 700; fill: #ddd; }
  .value-label.dip { fill: var(--critical); }
  .callout-line { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 2 2; }
  .chart-caption { color: var(--text-muted); font-size: 10.5px; margin-top: 6px; }

  #tip {
    position: fixed; z-index: 50; pointer-events: none; opacity: 0; transform: translateY(2px);
    transition: opacity .1s ease, transform .1s ease;
    background: #111214; border: 1px solid #454545; border-radius: 6px;
    padding: 7px 10px; font-size: 11.5px; box-shadow: 0 6px 18px rgba(0,0,0,.45); min-width: 150px;
  }
  #tip.show { opacity: 1; transform: translateY(0); }
  #tip .tip-title { color: #9a9a9a; font-size: 10.5px; margin-bottom: 4px; }
  #tip .tip-row { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
  #tip .tip-key { display: flex; align-items: center; gap: 6px; color: #9a9a9a; }
  #tip .tip-swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  #tip .tip-val { font-weight: 700; }

  @media (max-width: 720px) { .kpi-row { grid-template-columns: repeat(2, 1fr); } }
`;

function wrapHtml(n: string, body: string, script = '', extraCsp = ''): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';${extraCsp}" />
    <style>${SHARED_STYLE}</style>
  </head>
  <body>${body}
    ${script ? `<script nonce="${n}">${script}</script>` : ''}
  </body>
  </html>`;
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const AUTOMATION_META: Record<string, { icon: string; label: string }> = {
  automatable: { icon: '🤖', label: 'Automated' },
  manual: { icon: '🧍', label: 'Manual' }
};

function renderGenerateLiveShell(): string {
  const n = nonce();
  const script = `
    (function () {
      var STATUS_META = ${JSON.stringify(STATUS_META)};
      var AUTOMATION_META = ${JSON.stringify(AUTOMATION_META)};
      var rowsById = new Map();
      var tbody = document.getElementById('rows');
      var overview = document.getElementById('overview');

      function statusMeta(status) {
        return STATUS_META[status] || { icon: '?', label: status };
      }

      function renderOverview() {
        var counts = {};
        var automationCounts = { automatable: 0, manual: 0 };
        rowsById.forEach(function (entry) {
          counts[entry.status] = (counts[entry.status] || 0) + 1;
          if (entry.automationStatus === 'manual') automationCounts.manual++;
          else if (entry.status === 'done') automationCounts.automatable++;
        });
        var parts = ['Total: ' + rowsById.size];
        Object.keys(counts).forEach(function (status) {
          var meta = statusMeta(status);
          parts.push(meta.icon + ' ' + meta.label + ': ' + counts[status]);
        });
        if (automationCounts.automatable + automationCounts.manual > 0) {
          parts.push(AUTOMATION_META.automatable.icon + ' Automated: ' + automationCounts.automatable);
          parts.push(AUTOMATION_META.manual.icon + ' Manual: ' + automationCounts.manual);
        }
        overview.textContent = parts.join('   ');
      }

      function upsertRow(row) {
        var entry = rowsById.get(row.id);
        if (!entry) {
          var tr = document.createElement('tr');
          tr.innerHTML = '<td class="id"></td><td class="label"></td><td class="status"></td><td class="automation"></td><td class="extra"></td>';
          tbody.appendChild(tr);
          entry = { tr: tr, status: '' };
          rowsById.set(row.id, entry);
        }
        entry.tr.querySelector('.id').textContent = row.id;
        entry.tr.querySelector('.label').textContent = row.label;
        var meta = statusMeta(row.status);
        entry.tr.querySelector('.status').textContent = meta.icon + ' ' + meta.label;
        var automationMeta = row.automationStatus ? AUTOMATION_META[row.automationStatus] : undefined;
        entry.tr.querySelector('.automation').textContent = automationMeta ? automationMeta.icon + ' ' + automationMeta.label : '';
        entry.tr.querySelector('.extra').textContent = row.extra || '';
        entry.tr.dataset.status = row.status;
        entry.status = row.status;
        entry.automationStatus = row.automationStatus;
      }

      function removeRow(id) {
        var entry = rowsById.get(id);
        if (!entry) return;
        entry.tr.remove();
        rowsById.delete(id);
      }

      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg.type === 'init') {
          tbody.innerHTML = '';
          rowsById.clear();
          msg.rows.forEach(upsertRow);
          renderOverview();
        } else if (msg.type === 'upsert') {
          msg.rows.forEach(upsertRow);
          renderOverview();
        } else if (msg.type === 'remove') {
          msg.ids.forEach(removeRow);
          renderOverview();
        } else if (msg.type === 'finish') {
          document.getElementById('title').textContent = 'AI Auto Test — ' + msg.message;
        }
      });
    })();
  `;

  return wrapHtml(
    n,
    `<h3 id="title">AI Auto Test — Generating tests...</h3>
    <div id="overview">Total: 0</div>
    <table>
      <thead><tr><th>ID</th><th>Job</th><th>Status</th><th>Type</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>`,
    script
  );
}

/**
 * Live Run Tests dashboard, so the user can see what the AI-generated tests are doing:
 *  1) "#now" banner: running tests and the Playwright action each is executing right now.
 *  2) Test case table with separate Progress and Result columns; a Failed result links to the bug report.
 *  3) Clicking a row toggles that test's action history. Expansion is tracked by id, so updates keep it open.
 *  4) Stop/Pause/Resume buttons controlling this function's Playwright process. Pause is hidden on
 *     Windows (no SIGSTOP); Stop always works (taskkill /T on Windows).
 */
function renderExecuteLiveShell(functionId: string, slowMoMs: number): string {
  const n = nonce();
  const supportsPause = process.platform !== 'win32';
  const speedNote =
    slowMoMs > 0
      ? `each action is slowed by ${formatDuration(slowMoMs)} so you can follow along`
      : 'running at full speed — pick a slower speed next time to follow along';
  const script = `
    (function () {
      var vscode = acquireVsCodeApi();
      var FUNCTION_ID = ${JSON.stringify(functionId)};
      var paused = false;
      var stopped = false;
      var stopButton = document.getElementById('stop-run');
      var pauseButton = document.getElementById('pause-run');

      stopButton.addEventListener('click', function () {
        if (stopped) return;
        stopped = true;
        stopButton.disabled = true;
        if (pauseButton) pauseButton.disabled = true;
        stopButton.textContent = '⏹ Stopping...';
        vscode.postMessage({ command: 'stopRun', functionId: FUNCTION_ID });
      });

      if (pauseButton) {
        pauseButton.addEventListener('click', function () {
          if (stopped) return;
          paused = !paused;
          pauseButton.textContent = paused ? '▶ Resume' : '⏸ Pause';
          document.getElementById('paused-banner').style.display = paused ? '' : 'none';
          vscode.postMessage({ command: paused ? 'pauseRun' : 'resumeRun', functionId: FUNCTION_ID });
        });
      }

      var PROGRESS_META = {
        pending: { icon: '⬜', label: 'Pending' },
        running: { icon: '⏳', label: 'Running' },
        passed: { icon: '✅', label: 'Done' },
        failed: { icon: '✅', label: 'Done' }
      };
      var STEP_ICON = { running: '▶', passed: '✔', failed: '✖' };
      var RESULT_META = ${JSON.stringify(RESULT_META)};
      var rowsById = new Map();
      var tbody = document.getElementById('rows');
      var overview = document.getElementById('overview');
      var now = document.getElementById('now');

      function formatDuration(ms) {
        if (typeof ms !== 'number') return '—';
        return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
      }

      function renderOverview() {
        var total = rowsById.size;
        var passCount = 0;
        var failCount = 0;
        var totalMs = 0;
        rowsById.forEach(function (entry) {
          if (entry.status === 'passed') passCount++;
          if (entry.status === 'failed') failCount++;
          if (typeof entry.durationMs === 'number') totalMs += entry.durationMs;
        });
        var tested = passCount + failCount;
        overview.textContent =
          'Total: ' + total +
          '   Tested: ' + tested + '/' + total +
          '   ✅ Pass: ' + passCount +
          '   ❌ Failed: ' + failCount +
          '   ⏱ Total time: ' + formatDuration(totalMs);
      }

      /** "Now running" banner: running tests and their current action. */
      function renderNow() {
        now.innerHTML = '';
        var any = false;
        rowsById.forEach(function (entry) {
          if (entry.status !== 'running') return;
          any = true;
          var line = document.createElement('div');
          var label = document.createElement('span');
          label.textContent = '⏳ ' + entry.label + ' — ';
          var step = document.createElement('span');
          step.className = 'current-step';
          step.textContent = entry.currentStep || 'starting...';
          line.appendChild(label);
          line.appendChild(step);
          now.appendChild(line);
        });
        if (!any) {
          var idle = document.createElement('div');
          idle.className = 'idle';
          idle.textContent = 'No tests running.';
          now.appendChild(idle);
        }
      }

      /** A test's action list; rendered only while its row is expanded. */
      function renderSteps(entry) {
        var cell = entry.stepsTr.querySelector('.steps');
        cell.innerHTML = '';
        var steps = entry.steps || [];
        if (!steps.length) {
          var empty = document.createElement('span');
          empty.className = 'empty';
          empty.textContent = 'No actions recorded yet.';
          cell.appendChild(empty);
          return;
        }
        var list = document.createElement('ol');
        steps.forEach(function (step) {
          var li = document.createElement('li');
          li.className = step.status;
          var icon = STEP_ICON[step.status] || '·';
          var suffix = typeof step.durationMs === 'number' ? '  (' + formatDuration(step.durationMs) + ')' : '';
          li.textContent = icon + ' ' + step.title + suffix;
          list.appendChild(li);
        });
        cell.appendChild(list);
      }

      function setExpanded(entry, expanded) {
        entry.expanded = expanded;
        entry.stepsTr.style.display = expanded ? '' : 'none';
        entry.tr.querySelector('.toggle').textContent = expanded ? '▾' : '▸';
        if (expanded) renderSteps(entry);
      }

      function createEntry(id) {
        var tr = document.createElement('tr');
        tr.className = 'testcase';
        tr.innerHTML =
          '<td class="toggle">▸</td><td class="id"></td><td class="label"></td>' +
          '<td class="progress"></td><td class="result"></td><td class="duration"></td>';

        var stepsTr = document.createElement('tr');
        stepsTr.style.display = 'none';
        stepsTr.innerHTML = '<td class="steps" colspan="6"></td>';

        tbody.appendChild(tr);
        tbody.appendChild(stepsTr);

        var entry = { tr: tr, stepsTr: stepsTr, status: '', steps: [], expanded: false };
        tr.addEventListener('click', function () {
          setExpanded(entry, !entry.expanded);
        });
        return entry;
      }

      function upsertRow(row) {
        var entry = rowsById.get(row.id);
        if (!entry) {
          entry = createEntry(row.id);
          rowsById.set(row.id, entry);
        }
        entry.status = row.status;
        entry.label = row.label;
        entry.durationMs = row.durationMs;
        entry.currentStep = row.currentStep;
        // Updates are partial: keep the previous step history if none was sent.
        if (row.steps) entry.steps = row.steps;

        entry.tr.dataset.status = row.status;
        entry.tr.querySelector('.id').textContent = row.id;
        entry.tr.querySelector('.label').textContent = row.label;

        var progressMeta = PROGRESS_META[row.status] || { icon: '?', label: row.status };
        var progressCell = entry.tr.querySelector('.progress');
        progressCell.innerHTML = '';
        var progressText = document.createElement('div');
        progressText.textContent = progressMeta.icon + ' ' + progressMeta.label;
        progressCell.appendChild(progressText);
        // Show the current action inline, without expanding the row.
        if (row.status === 'running' && row.currentStep) {
          var stepText = document.createElement('div');
          stepText.className = 'current-step';
          stepText.textContent = row.currentStep;
          progressCell.appendChild(stepText);
        }

        var resultCell = entry.tr.querySelector('.result');
        resultCell.innerHTML = '';
        if (row.status === 'passed' || row.status === 'failed') {
          var meta = RESULT_META[row.status];
          if (row.status === 'failed' && row.bugReportPath) {
            var link = document.createElement('a');
            link.href = '#';
            link.textContent = meta.icon + ' ' + meta.label;
            link.addEventListener('click', function (e) {
              e.preventDefault();
              // Don't toggle the row's action list.
              e.stopPropagation();
              vscode.postMessage({ command: 'openPath', path: row.bugReportPath });
            });
            resultCell.appendChild(link);
          } else {
            resultCell.textContent = meta.icon + ' ' + meta.label;
          }
        } else {
          resultCell.textContent = '—';
        }

        entry.tr.querySelector('.duration').textContent = formatDuration(row.durationMs);
        if (entry.expanded) renderSteps(entry);
      }

      function removeRow(id) {
        var entry = rowsById.get(id);
        if (!entry) return;
        entry.tr.remove();
        entry.stepsTr.remove();
        rowsById.delete(id);
      }

      function refresh() {
        renderOverview();
        renderNow();
      }

      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg.type === 'init') {
          tbody.innerHTML = '';
          rowsById.clear();
          msg.rows.forEach(upsertRow);
          refresh();
        } else if (msg.type === 'upsert') {
          msg.rows.forEach(upsertRow);
          refresh();
        } else if (msg.type === 'remove') {
          msg.ids.forEach(removeRow);
          refresh();
        }
      });

      refresh();
    })();
  `;

  return wrapHtml(
    n,
    `<h3>AI Auto Test — Running tests...</h3>
    <div class="run-controls">
      <button id="stop-run" class="btn danger">⏹ Stop</button>
      ${supportsPause ? '<button id="pause-run" class="btn">⏸ Pause</button>' : ''}
    </div>
    <div id="paused-banner" class="hint" style="display:none;color:#ffcf5c;">⏸ Paused — the browser and test process are frozen in place. Click "▶ Resume" to continue.</div>
    <div id="overview">Total: 0</div>
    <div id="now"><div class="idle">No tests running.</div></div>
    <p class="hint">A real browser is being driven in a separate window (${escapeHtml(speedNote)}). Click a row below to see each action.</p>
    <table>
      <thead><tr><th></th><th>ID</th><th>Test case</th><th>Progress</th><th>Result</th><th>Duration</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>`,
    script
  );
}

/**
 * Static report for one round. Joins report.json (results) with testcases.json (Expected/Severity, matched
 * by the id extracted from the test name, see extractTestId) and rounds.json (round history table).
 */
function renderRound(functionId: string, round: number): string {
  const n = nonce();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return wrapHtml(n, '<p>No workspace folder is open.</p>');
  }

  const fnDir = functionDir(path.join(workspaceRoot, '.aitest'), functionId);
  const result = readRoundReport(fnDir, round);
  if (!result) {
    return wrapHtml(n, `<p>No results yet for round ${round} of function "${escapeHtml(functionId)}".</p>`);
  }

  const testCasesById = new Map(readTestCases(fnDir).map((tc) => [tc.id, tc]));
  const rounds = readRounds(fnDir);
  const totalDurationMs = result.tests.reduce((sum, t) => sum + t.durationMs, 0);
  const blockedMap = readBlockedCases(fnDir, round);

  const historyRows = rounds
    .map(
      (r) => `
      <tr class="${r.round === round ? 'current' : ''}">
        <td>Round ${r.round}</td>
        <td>${r.passed}</td>
        <td>${r.failed}</td>
        <td>${r.untested}</td>
        <td>${r.total}</td>
        <td>${r.total ? Math.round((r.passed / r.total) * 100) : 0}%</td>
        <td>${formatDateTime(r.startedAt)}</td>
        <td>${formatDateTime(r.endedAt)}</td>
        <td>${formatLongDuration(r.totalDurationMs)}</td>
        <td><a href="#" class="delete-round" data-round="${r.round}">🗑 Delete</a></td>
      </tr>`
    )
    .join('');

  const executedIds = new Set(result.tests.map((t) => extractTestId(t.name)));

  const executedRows = result.tests
    .map((t) => {
      const id = extractTestId(t.name);
      const tc = testCasesById.get(id);
      const actual =
        t.status === 'passed' ? '✅ As expected' : escapeHtml(t.errorMessage ?? 'Failed (no error details)');
      const resultCell =
        t.status === 'passed'
          ? '✅ Pass'
          : `<a href="#" class="show-bug-detail" data-id="${escapeHtml(id)}">❌ Failed</a>`;
      const evidenceCell = t.screenshotPath
        ? `<a href="#" class="open-path" data-path="${escapeHtml(t.screenshotPath)}">screenshot</a>`
        : '';

      return `
      <tr class="${t.status}" data-status="${t.status}" data-kind="${tc?.kind ?? ''}">
        <td><input type="checkbox" class="row-select" data-id="${escapeHtml(id)}" /></td>
        <td class="id">${escapeHtml(id)}</td>
        <td>${escapeHtml(t.name)}</td>
        <td>${tc?.severity ?? ''}</td>
        <td>${resultCell}</td>
        <td>${t.durationMs}ms</td>
        <td>${formatDateTime(t.startedAt)}</td>
        <td>${formatDateTime(t.endedAt)}</td>
        <td>${escapeHtml(tc?.expectedResult ?? '')}</td>
        <td>${actual}</td>
        <td>${evidenceCell}</td>
      </tr>`;
    })
    .join('');

  // Untested cases still get a row so they can be flagged "Blocked" (e.g. test environment down).
  const untestedRows = Array.from(testCasesById.values())
    .filter((tc) => !executedIds.has(tc.id))
    .map((tc) => {
      const blocked = blockedMap[tc.id];
      const resultCell = blocked
        ? `<span class="blocked">🚫 Blocked</span><div class="blocked-reason">${escapeHtml(blocked.reason)}</div>
           <a href="#" class="toggle-blocked" data-id="${escapeHtml(tc.id)}" data-block="false">Unblock</a>`
        : `◽ Untested <a href="#" class="toggle-blocked" data-id="${escapeHtml(tc.id)}" data-block="true">🚫 Block</a>`;

      return `
      <tr class="untested" data-status="${blocked ? 'blocked' : 'untested'}" data-kind="${tc.kind}">
        <td></td>
        <td class="id">${escapeHtml(tc.id)}</td>
        <td>${escapeHtml(tc.name)}</td>
        <td>${escapeHtml(tc.severity)}</td>
        <td>${resultCell}</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>${escapeHtml(tc.expectedResult)}</td>
        <td>—</td>
        <td></td>
      </tr>`;
    })
    .join('');

  const caseRows = executedRows + untestedRows;

  const script = `
    (function () {
      var vscode = acquireVsCodeApi();
      var FUNCTION_ID = ${JSON.stringify(functionId)};
      var ROUND = ${JSON.stringify(round)};

      document.querySelectorAll('.open-path').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          var p = el.getAttribute('data-path');
          if (p) vscode.postMessage({ command: 'openPath', path: p });
        });
      });

      document.querySelectorAll('.show-bug-detail').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          vscode.postMessage({ command: 'showBugDetail', functionId: FUNCTION_ID, round: ROUND, id: el.getAttribute('data-id') });
        });
      });

      document.querySelectorAll('.delete-round').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          vscode.postMessage({
            command: 'deleteRound',
            functionId: FUNCTION_ID,
            round: parseInt(el.getAttribute('data-round'), 10),
            viewingRound: ROUND
          });
        });
      });

      document.querySelectorAll('.toggle-blocked').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          vscode.postMessage({
            command: 'toggleBlocked',
            functionId: FUNCTION_ID,
            round: ROUND,
            id: el.getAttribute('data-id'),
            block: el.getAttribute('data-block') === 'true'
          });
        });
      });

      var statusFilter = document.getElementById('filter-status');
      var kindFilter = document.getElementById('filter-kind');
      var rows = Array.prototype.slice.call(document.querySelectorAll('#case-rows tr'));

      function applyFilters() {
        var status = statusFilter.value;
        var kind = kindFilter.value;
        rows.forEach(function (tr) {
          var matchesStatus = status === 'all' || tr.dataset.status === status;
          var matchesKind = kind === 'all' || tr.dataset.kind === kind;
          tr.style.display = matchesStatus && matchesKind ? '' : 'none';
        });
      }
      statusFilter.addEventListener('change', applyFilters);
      kindFilter.addEventListener('change', applyFilters);

      var selectAll = document.getElementById('select-all');
      selectAll.addEventListener('change', function () {
        rows.forEach(function (tr) {
          if (tr.style.display === 'none') return;
          var checkbox = tr.querySelector('.row-select');
          if (checkbox) checkbox.checked = selectAll.checked;
        });
      });

      document.getElementById('retest-button').addEventListener('click', function () {
        var ids = Array.prototype.slice
          .call(document.querySelectorAll('.row-select:checked'))
          .map(function (el) { return el.getAttribute('data-id'); });
        if (ids.length === 0) return;
        vscode.postMessage({ command: 'retest', functionId: FUNCTION_ID, round: ROUND, ids: ids });
      });

      ${TABLE_INTERACTIONS_SCRIPT}
      enableTableInteractions(document.getElementById('history-table'));
      enableTableInteractions(document.getElementById('case-table'));
    })();
  `;

  return wrapHtml(
    n,
    `<h3>${escapeHtml(functionId)} — Round ${round}</h3>
    <div class="summary">Total: ${result.total}   ✅ Pass: ${result.passed}   ❌ Failed: ${result.failed}   ⏱ Total time: ${formatDuration(totalDurationMs)}</div>

    <h4>Round history</h4>
    <table id="history-table">
      <thead><tr><th>Round</th><th>Passed</th><th>Failed</th><th>Untested</th><th>Total</th><th>%</th><th>Start</th><th>End</th><th>Duration</th><th></th></tr></thead>
      <tbody>${historyRows}</tbody>
    </table>

    <h4>Test case details</h4>
    <div class="toolbar">
      Status:
      <select id="filter-status">
        <option value="all">All</option>
        <option value="passed">Pass</option>
        <option value="failed">Failed</option>
        <option value="untested">Untested</option>
        <option value="blocked">Blocked</option>
      </select>
      Type:
      <select id="filter-kind">
        <option value="all">All</option>
        <option value="ui">UI</option>
        <option value="api">API</option>
      </select>
      <button id="retest-button">Retest</button>
    </div>
    <table id="case-table">
      <thead><tr><th><input type="checkbox" id="select-all" /></th><th>ID</th><th>Test case</th><th>Severity</th><th>Result</th><th>Duration</th><th>Start</th><th>End</th><th>Expected</th><th>Actual</th><th>Evidence</th></tr></thead>
      <tbody id="case-rows">${caseRows}</tbody>
    </table>`,
    script
  );
}

function formatDateOnly(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Like formatDateOnly but without the year, for compact chart labels/tooltips. */
function formatShortDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
}

function formatTimeOnly(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function passRatePct(r: RoundSummary): number {
  return r.total ? Math.round((r.passed / r.total) * 100) : 0;
}

/** Up/down badge for a KPI tile. `goodWhenUp` says whether an increase is good (pass rate: yes; failed:
 * no), so the color reflects meaning rather than sign. */
function renderKpiDelta(delta: number, unit: string, goodWhenUp: boolean): string {
  if (delta === 0) return `<span class="kpi-delta flat">— no change</span>`;
  const isGood = goodWhenUp ? delta > 0 : delta < 0;
  const arrow = delta > 0 ? '▲' : '▼';
  return `<span class="kpi-delta ${isGood ? 'good' : 'bad'}">${arrow} ${Math.abs(delta)}${unit}</span>`;
}

/** Static sparkline for the pass-rate KPI, over the full round history (independent of the trend chart pager). */
function renderSparkline(values: number[]): string {
  const W = 72;
  const H = 24;
  const PAD = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const pts = values.map((v, i): [number, number] => [PAD + step * i, y(v)]);
  const line = 'M ' + pts.map((p) => `${p[0]} ${p[1]}`).join(' L ');
  const area = `${line} L ${pts[pts.length - 1][0]} ${H} L ${pts[0][0]} ${H} Z`;
  const [lastX, lastY] = pts[pts.length - 1];
  return `<svg class="kpi-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <path class="area" d="${area}" /><path class="line" d="${line}" /><circle cx="${lastX}" cy="${lastY}" r="2" />
  </svg>`;
}

interface ChartRound {
  round: number;
  passed: number;
  failed: number;
  untested: number;
  total: number;
  date: string;
}

/**
 * Client script for the two trend charts (stacked bars + pass-rate line) and the shared tooltip, which the
 * latest-round composition bar (.comp-seg) also uses. Rendered once on open; it does not refresh when new
 * rounds arrive. SVG is drawn by hand because the webview CSP blocks external scripts.
 *
 * The older/newer pager buttons exist only when rounds.length > windowSize, hence the null guards.
 */
function buildTrendChartsScript(chartRounds: ChartRound[], windowSize: number): string {
  return `
    (function () {
      var allRounds = ${JSON.stringify(chartRounds)};
      var WINDOW_SIZE = ${windowSize};
      var windowStart = Math.max(0, allRounds.length - WINDOW_SIZE);
      var tip = document.getElementById('tip');

      function showTip(evt, title, rows) {
        var html = '<div class="tip-title">' + title + '</div>';
        rows.forEach(function (r) {
          html += '<div class="tip-row"><span class="tip-key">' +
            (r.color ? '<span class="tip-swatch" style="background:' + r.color + '"></span>' : '') +
            r.label + '</span><span class="tip-val">' + r.value + '</span></div>';
        });
        tip.innerHTML = html;
        tip.classList.add('show');
        positionTip(evt);
      }
      function positionTip(evt) {
        var x = evt.clientX + 14, y = evt.clientY + 14;
        var vw = window.innerWidth, vh = window.innerHeight;
        tip.style.left = Math.min(x, vw - 200) + 'px';
        tip.style.top = Math.min(y, vh - 90) + 'px';
      }
      function hideTip() { tip.classList.remove('show'); }

      document.querySelectorAll('.comp-seg').forEach(function (seg) {
        seg.setAttribute('tabindex', '0');
        seg.addEventListener('mousemove', function (e) {
          showTip(e, seg.dataset.tipTitle, [{ label: seg.dataset.tipTitle, value: seg.dataset.tipValue, color: getComputedStyle(seg).backgroundColor }]);
        });
        seg.addEventListener('mouseleave', hideTip);
        seg.addEventListener('focus', function () {
          var rect = seg.getBoundingClientRect();
          showTip({ clientX: rect.left, clientY: rect.bottom }, seg.dataset.tipTitle, [{ label: seg.dataset.tipTitle, value: seg.dataset.tipValue }]);
        });
        seg.addEventListener('blur', hideTip);
      });

      var svgns = 'http://www.w3.org/2000/svg';
      function el(tag, attrs) {
        var e = document.createElementNS(svgns, tag);
        for (var k in attrs) e.setAttribute(k, attrs[k]);
        return e;
      }

      /** Index of the deepest local dip (lower than both neighbours) in the window, or -1. Window edges
       * are skipped since they lack a neighbour on one side. */
      function findDipIndex(rates) {
        var idx = -1, min = Infinity;
        for (var i = 1; i < rates.length - 1; i++) {
          if (rates[i] < rates[i - 1] && rates[i] < rates[i + 1] && rates[i] < min) {
            min = rates[i];
            idx = i;
          }
        }
        return idx;
      }

      // One Y-axis ceiling across all windows (from the full history) so the axis doesn't jump when
      // paging; totals vary per round as test cases are added/removed.
      function niceCeil(maxVal) { return Math.max(10, Math.ceil(maxVal / 10) * 10); }
      var maxTotal = 0;
      allRounds.forEach(function (r) { if (r.total > maxTotal) maxTotal = r.total; });
      var CEIL = niceCeil(maxTotal);

      function renderStackedChart(windowRounds) {
        var svg = document.getElementById('chart-stacked');
        svg.textContent = '';
        var W = 560, H = 240, ML = 32, MB = 22, MT = 8, MR = 4;
        var plotW = W - ML - MR, plotH = H - MT - MB;
        var baseline = MT + plotH;
        var n = windowRounds.length;
        var band = plotW / n;
        var barW = 22;
        var GAP = 2;

        function y(v) { return baseline - (v / CEIL) * plotH; }

        var step = CEIL / 5;
        for (var g = 0; g <= 5; g++) {
          var gv = Math.round(step * g);
          svg.appendChild(el('line', { class: 'grid-line', x1: ML, x2: W - MR, y1: y(gv), y2: y(gv) }));
          var t = el('text', { class: 'axis-label y', x: ML - 6, y: y(gv) + 3 });
          t.textContent = gv;
          svg.appendChild(t);
        }

        var lastRound = allRounds[allRounds.length - 1].round;

        windowRounds.forEach(function (r, i) {
          var cx = ML + band * i + band / 2;
          var x = cx - barW / 2;
          var isCurrent = r.round === lastRound;

          var passedTop = y(r.passed);
          var failedTop = y(r.passed + r.failed);
          var untestedTop = y(r.passed + r.failed + r.untested);

          // Group a bar's segments so hovering the hit area highlights the whole bar.
          var segGroup = el('g', { class: 'bar-seg-group' });
          segGroup.appendChild(el('rect', {
            class: 'bar-seg passed', x: x, width: barW,
            y: passedTop, height: Math.max(0, baseline - passedTop)
          }));
          segGroup.appendChild(el('rect', {
            class: 'bar-seg failed', x: x, width: barW,
            y: failedTop, height: Math.max(0, passedTop - failedTop - GAP)
          }));
          var untestedH = Math.max(0, failedTop - untestedTop - GAP);
          segGroup.appendChild(el('rect', {
            class: 'bar-seg untested', x: x, width: barW,
            y: untestedTop, height: untestedH, rx: 3, ry: 3
          }));
          // rx rounds all four corners; overlay a square rect on the lower part so only the top is rounded.
          if (untestedH > 4) {
            segGroup.appendChild(el('rect', { class: 'bar-seg untested', x: x, y: untestedTop + 4, width: barW, height: Math.max(0, untestedH - 4) }));
          }
          svg.appendChild(segGroup);

          var hit = el('rect', { class: 'bar-hit', x: x - 3, y: MT, width: barW + 6, height: plotH });
          hit.addEventListener('mousemove', function (e) {
            segGroup.classList.add('hover');
            showTip(e, 'Round ' + r.round + ' · ' + r.date, [
              { label: 'Passed', value: r.passed, color: '#2fb344' },
              { label: 'Failed', value: r.failed, color: '#e5484d' },
              { label: 'Untested', value: r.untested, color: '#6e6e6e' }
            ]);
          });
          hit.addEventListener('mouseleave', function () {
            segGroup.classList.remove('hover');
            hideTip();
          });
          svg.appendChild(hit);

          var tick = el('text', { class: 'round-tick' + (isCurrent ? ' current' : ''), x: cx, y: baseline + 15 });
          tick.textContent = 'R' + r.round;
          svg.appendChild(tick);
        });
      }

      function renderLineChart(windowRounds) {
        var svg = document.getElementById('chart-line');
        svg.textContent = '';
        var W = 560, H = 240, ML = 30, MB = 22, MT = 24, MR = 10;
        var plotW = W - ML - MR, plotH = H - MT - MB;
        var baseline = MT + plotH;
        var n = windowRounds.length;
        var band = n > 1 ? plotW / (n - 1) : 0;

        function y(pct) { return baseline - (pct / 100) * plotH; }

        var rates = windowRounds.map(function (r) { return r.total ? Math.round((r.passed / r.total) * 100) : 0; });

        [0, 25, 50, 75, 100].forEach(function (v) {
          svg.appendChild(el('line', { class: 'grid-line', x1: ML, x2: W - MR, y1: y(v), y2: y(v) }));
          var t = el('text', { class: 'axis-label y', x: ML - 6, y: y(v) + 3 });
          t.textContent = v;
          svg.appendChild(t);
        });

        var pts = rates.map(function (v, i) { return [ML + band * i, y(v)]; });
        var linePath = 'M ' + pts.map(function (p) { return p[0] + ' ' + p[1]; }).join(' L ');
        var areaPath = linePath + ' L ' + pts[pts.length - 1][0] + ' ' + baseline + ' L ' + pts[0][0] + ' ' + baseline + ' Z';

        svg.appendChild(el('path', { class: 'line-area', d: areaPath }));
        svg.appendChild(el('path', { class: 'line-path', d: linePath }));

        var dipIndex = findDipIndex(rates);
        var lastRound = allRounds[allRounds.length - 1].round;

        windowRounds.forEach(function (r, i) {
          var isDip = i === dipIndex;
          var isLast = r.round === lastRound;
          var dot = el('circle', { class: 'line-dot' + (isDip ? ' dip' : ''), cx: pts[i][0], cy: pts[i][1], r: 4 });
          svg.appendChild(dot);

          var hit = el('circle', { class: 'line-hit', cx: pts[i][0], cy: pts[i][1], r: 14 });
          hit.addEventListener('mousemove', function (e) {
            showTip(e, 'Round ' + r.round + ' · ' + r.date, [
              { label: 'Pass rate', value: rates[i] + '%', color: '#4a9eff' },
              { label: 'Passed', value: r.passed + ' / ' + r.total }
            ]);
          });
          hit.addEventListener('mouseleave', hideTip);
          svg.appendChild(hit);

          if (isLast) {
            var lbl = el('text', { class: 'value-label', x: pts[i][0] - 4, y: pts[i][1] - 10, 'text-anchor': 'end' });
            lbl.textContent = rates[i] + '%';
            svg.appendChild(lbl);
          }
          if (isDip) {
            svg.appendChild(el('line', { class: 'callout-line', x1: pts[i][0], y1: pts[i][1] - 8, x2: pts[i][0], y2: MT - 2 }));
            // State the fact only; the cause has to be read from that round's bug reports.
            var dl = el('text', { class: 'value-label dip', x: pts[i][0], y: MT - 6, 'text-anchor': 'middle' });
            dl.textContent = rates[i] + '% — below adjacent rounds';
            svg.appendChild(dl);
          }

          var tick = el('text', { class: 'round-tick' + (isLast ? ' current' : ''), x: pts[i][0], y: baseline + 15 });
          tick.textContent = 'R' + r.round;
          svg.appendChild(tick);
        });

        return dipIndex >= 0 ? { round: windowRounds[dipIndex].round, rate: rates[dipIndex] } : null;
      }

      var olderBtn = document.getElementById('pager-older');
      var newerBtn = document.getElementById('pager-newer');
      var rangeEl = document.getElementById('pager-range');
      var captionEl = document.getElementById('window-caption');
      var lineCaptionEl = document.getElementById('line-caption');

      function renderTrendCharts() {
        var windowRounds = allRounds.slice(windowStart, windowStart + WINDOW_SIZE);
        renderStackedChart(windowRounds);
        var dip = renderLineChart(windowRounds);

        var first = windowRounds[0].round, last = windowRounds[windowRounds.length - 1].round;
        if (rangeEl) rangeEl.textContent = 'Round ' + first + '–' + last + ' of ' + allRounds.length + ' rounds';
        if (captionEl) {
          captionEl.textContent = allRounds.length > WINDOW_SIZE
            ? 'Showing ' + windowRounds.length + ' rounds (Round ' + first + ' → Round ' + last + '). The table at the bottom always has the full history.'
            : 'Showing all ' + windowRounds.length + ' rounds run.';
        }
        if (lineCaptionEl) {
          lineCaptionEl.textContent = dip
            ? 'Round ' + dip.round + ' is lower than the rounds before and after it (' + dip.rate + '%). Only flagged, not diagnosed.'
            : 'No unusual dips in the ' + windowRounds.length + ' rounds shown.';
        }
        if (olderBtn) olderBtn.disabled = windowStart <= 0;
        if (newerBtn) newerBtn.disabled = windowStart + WINDOW_SIZE >= allRounds.length;
      }

      if (olderBtn) olderBtn.addEventListener('click', function () {
        windowStart = Math.max(0, windowStart - WINDOW_SIZE);
        renderTrendCharts();
      });
      if (newerBtn) newerBtn.addEventListener('click', function () {
        windowStart = Math.min(allRounds.length - WINDOW_SIZE, windowStart + WINDOW_SIZE);
        renderTrendCharts();
      });

      renderTrendCharts();
    })();
  `;
}

/**
 * Summary report for one function: KPI tiles, a 100%-stacked bar for the latest round, trend charts, and
 * a full-history table (Passed/Failed/Untested per round, Blocked summed from each round's blocked.json,
 * total test cases, latest passed count and completion %).
 *
 * Blocked is shown only as a number (KPI + note on the Untested segment), never as its own stacked
 * series: it is a subset of Untested and would be double-counted.
 */
function renderSummary(functionId: string): string {
  const n = nonce();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return wrapHtml(n, '<p>No workspace folder is open.</p>');
  }

  const fnDir = functionDir(path.join(workspaceRoot, '.aitest'), functionId);
  const rounds = readRounds(fnDir);
  const totalCases = readTestCases(fnDir).length;

  if (rounds.length === 0) {
    return wrapHtml(n, `<h3>📊 Summary report — ${escapeHtml(functionId)}</h3><p>No test runs yet.</p>`);
  }

  const blockedPerRound = rounds.map((r) => Object.keys(readBlockedCases(fnDir, r.round)).length);
  const blockedTotal = blockedPerRound.reduce((sum, n2) => sum + n2, 0);
  const latest = rounds[rounds.length - 1];
  const prev = rounds.length > 1 ? rounds[rounds.length - 2] : undefined;
  const pct = totalCases ? Math.round((latest.passed / totalCases) * 100) : 0;

  const roundGroupHeaders = rounds.map((r) => `<th colspan="3">Round ${r.round}</th>`).join('');
  const roundSubHeaders = rounds.map(() => `<th>Passed</th><th>Failed</th><th>Untested</th>`).join('');
  const roundBodyCells = rounds.map((r) => `<td>${r.passed}</td><td>${r.failed}</td><td>${r.untested}</td>`).join('');

  // ---------- KPI row ----------
  const latestRate = passRatePct(latest);
  const prevRate = prev ? passRatePct(prev) : undefined;
  const latestBlocked = blockedPerRound[blockedPerRound.length - 1];
  const passRates = rounds.map(passRatePct);
  const totalCaseFoot =
    rounds[0].total === totalCases ? `Unchanged across ${rounds.length} rounds` : `Round 1 had ${rounds[0].total} cases, now ${totalCases}`;

  const kpiRowHtml = `
    <section>
      <h4>At a glance <span class="new-tag">New</span></h4>
      <p class="section-caption">Key numbers from the latest round (Round ${latest.round}).</p>
      <div class="kpi-row">
        <div class="kpi-tile">
          <div class="kpi-label">Total test cases</div>
          <div class="kpi-value-row"><span class="kpi-value">${totalCases}</span></div>
          <div class="kpi-foot"><span class="kpi-foot-text">${escapeHtml(totalCaseFoot)}</span></div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Pass rate (Round ${latest.round})</div>
          <div class="kpi-value-row">
            <span class="kpi-value">${latestRate}%</span>
            ${prevRate !== undefined ? renderKpiDelta(latestRate - prevRate, 'pp', true) : ''}
          </div>
          <div class="kpi-foot">
            <span class="kpi-foot-text">${prev ? `vs Round ${prev.round}` : 'No previous round to compare'}</span>
            ${renderSparkline(passRates)}
          </div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Failed (Round ${latest.round})</div>
          <div class="kpi-value-row">
            <span class="kpi-value">${latest.failed}</span>
            ${prev ? renderKpiDelta(latest.failed - prev.failed, ' cases', false) : ''}
          </div>
          <div class="kpi-foot"><span class="kpi-foot-text">${prev ? `vs Round ${prev.round} (${prev.failed} cases)` : '—'}</span></div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Blocked (Round ${latest.round})</div>
          <div class="kpi-value-row"><span class="kpi-value">${latestBlocked}</span></div>
          <div class="kpi-foot"><span class="kpi-foot-text">Counted within Untested, not in addition to it</span></div>
        </div>
      </div>
    </section>`;

  // ---------- Composition bar (latest round) ----------
  const compPassedPct = latest.total ? Math.round((latest.passed / latest.total) * 100) : 0;
  const compFailedPct = latest.total ? Math.round((latest.failed / latest.total) * 100) : 0;
  // Untested takes the remainder so rounding never pushes the total off 100%.
  const compUntestedPct = Math.max(0, 100 - compPassedPct - compFailedPct);
  const passedSegLabel = compPassedPct >= 12 ? `<span class="seg-label">${compPassedPct}%</span>` : '';

  const compositionHtml = `
    <section>
      <h4>Latest round <span class="new-tag">New</span></h4>
      <p class="section-caption">All ${latest.total} test cases of Round ${latest.round}, as 100%.</p>
      <div class="composition-card">
        <div class="composition-head">Round ${latest.round} · ${formatDateOnly(latest.startedAt)} ${formatTimeOnly(latest.startedAt)}–${formatTimeOnly(latest.endedAt)} (${formatLongDuration(latest.totalDurationMs)})</div>
        <div class="comp-bar">
          <div class="comp-seg passed" style="width: ${compPassedPct}%" data-tip-title="Passed" data-tip-value="${latest.passed} cases · ${compPassedPct}%">${passedSegLabel}</div>
          <div class="comp-seg failed" style="width: ${compFailedPct}%" data-tip-title="Failed" data-tip-value="${latest.failed} cases · ${compFailedPct}%"></div>
          <div class="comp-seg untested" style="width: ${compUntestedPct}%" data-tip-title="Untested" data-tip-value="${latest.untested} cases · ${compUntestedPct}%${latestBlocked > 0 ? ` (incl. ${latestBlocked} blocked)` : ''}"></div>
        </div>
        <div class="comp-legend">
          <span class="legend-item"><span class="legend-swatch swatch-passed"></span>Passed <b>${latest.passed}</b></span>
          <span class="legend-item"><span class="legend-swatch swatch-failed"></span>Failed <b>${latest.failed}</b></span>
          <span class="legend-item"><span class="legend-swatch swatch-untested"></span>Untested <b>${latest.untested}</b>${latestBlocked > 0 ? ` <span style="color:#7a7a7a">(${latestBlocked} blocked)</span>` : ''}</span>
          <span class="legend-note">Hover a segment for details</span>
        </div>
      </div>
    </section>`;

  // ---------- Trend charts (2 chart + pager) ----------
  const WINDOW_SIZE = 6;
  const showPager = rounds.length > WINDOW_SIZE;
  const chartRounds: ChartRound[] = rounds.map((r) => ({
    round: r.round,
    passed: r.passed,
    failed: r.failed,
    untested: r.untested,
    total: r.total,
    date: formatShortDate(r.endedAt)
  }));

  const trendHtml = `
    <section>
      <h4>Trend across rounds <span class="new-tag">New</span></h4>
      <p class="section-caption" id="window-caption">Loading…</p>
      <div class="chart-toolbar">
        <div class="shared-legend">
          <span class="legend-item"><span class="legend-swatch swatch-passed"></span>Passed</span>
          <span class="legend-item"><span class="legend-swatch swatch-failed"></span>Failed</span>
          <span class="legend-item"><span class="legend-swatch swatch-untested"></span>Untested</span>
        </div>
        ${
          showPager
            ? `<div class="pager">
          <button class="btn" id="pager-older" type="button">◀ ${WINDOW_SIZE} older rounds</button>
          <span class="pager-range" id="pager-range">—</span>
          <button class="btn" id="pager-newer" type="button">${WINDOW_SIZE} newer rounds ▶</button>
        </div>`
            : ''
        }
      </div>
      <div class="charts-row">
        <div class="chart-card">
          <div class="chart-card-head"><span class="chart-card-title">Results per round <span class="muted">(cases)</span></span></div>
          <svg class="chart" id="chart-stacked" viewBox="0 0 560 240"></svg>
          <p class="chart-caption">Bar height = total test cases in that round; it varies if test cases were added or removed.</p>
        </div>
        <div class="chart-card">
          <div class="chart-card-head"><span class="chart-card-title">Pass rate <span class="muted">(%)</span></span></div>
          <svg class="chart" id="chart-line" viewBox="0 0 560 240"></svg>
          <p class="chart-caption" id="line-caption">—</p>
        </div>
      </div>
    </section>
    <div id="tip"></div>`;

  const body = `<style>${SUMMARY_STYLE}</style>
    <h3>📊 Summary report — ${escapeHtml(functionId)}</h3>
    <table class="info-table">
      <tr><th>Module</th><td>${escapeHtml(functionId)}</td><th>Created</th><td>${formatDateTime(rounds[0].startedAt)}</td></tr>
      <tr><th>Total test cases</th><td>${totalCases}</td><th>Updated</th><td>${formatDateTime(latest.endedAt)}</td></tr>
    </table>

    ${kpiRowHtml}
    ${compositionHtml}
    ${trendHtml}

    <section>
      <h4>Test Execution Summary</h4>
      <table class="summary-table">
        <thead>
          <tr>
            <th rowspan="2">Module</th>
            ${roundGroupHeaders}
            <th rowspan="2">Blocked</th>
            <th rowspan="2">Total test cases</th>
            <th rowspan="2">Total passed</th>
            <th rowspan="2">% complete</th>
          </tr>
          <tr>${roundSubHeaders}</tr>
        </thead>
        <tbody>
          <tr>
            <td class="id">${escapeHtml(functionId)}</td>
            ${roundBodyCells}
            <td>${blockedTotal}</td>
            <td>${totalCases}</td>
            <td>${latest.passed}</td>
            <td><strong>${pct}%</strong></td>
          </tr>
        </tbody>
      </table>
    </section>`;

  return wrapHtml(n, body, buildTrendChartsScript(chartRounds, WINDOW_SIZE));
}
