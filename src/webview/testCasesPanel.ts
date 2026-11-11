import { nonce } from './popupModal';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import {
  functionDir,
  listScriptedTestCaseIds,
  readFunctionMeta,
  readRoundReport,
  readRounds,
  readTestCases,
  testCaseHashesPath
} from '../core/store';
import { diffTestCases } from '../core/testCaseMarkdownLoader';
import { extractTestId } from '../core/testRunner';
import { DEFAULT_MODEL_ID, MODEL_OPTIONS } from '../core/modelOptions';
import { SuggestedTestCase, TestCase, TestResultDetail } from '../types';
import { TABLE_INTERACTIONS_SCRIPT, TABLE_INTERACTIONS_STYLE } from './tableInteractions';
import { MainPanel } from './mainPanel';

function viewId(functionId: string): string {
  return `testCases:${functionId}`;
}


function escapeHtml(input: string): string {
  return String(input).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface InboundMessage {
  command?: string;
  path?: string;
  round?: number;
  testCase?: TestCase;
  id?: string;
  testCases?: TestCase[];
  screenUrl?: string;
  apiBaseUrl?: string;
  apiAuthHeader?: string;
  model?: string;
  forceAll?: boolean;
}

/**
 * Test case table for one function: add/edit/delete/import/sync/suggest.
 * Every mutation is relayed to a vscode command; this panel only renders and exchanges postMessage.
 * Business logic (writing testcases.json, calling the AI, syncing scripts) lives in extension.ts.
 */
export class TestCasesPanel {
  /** Test case ids currently syncing, per functionId. Kept here because a full re-render
   * (refreshIfOpen, e.g. after test case A finishes) may happen while test case B is still syncing;
   * without this state the re-render would drop B's spinner and re-enable its buttons. */
  private static syncingIds = new Map<string, Set<string>>();

  static show(functionId: string): void {
    MainPanel.show(
      viewId(functionId),
      `AI Auto Test Cases — ${functionId}`,
      render(functionId, false, this.syncingIds.get(functionId)),
      (msg: InboundMessage) => {
        if (msg?.command === 'openPath' && msg.path) {
          void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
        } else if (msg?.command === 'openRound' && typeof msg.round === 'number') {
          void vscode.commands.executeCommand('aitest.showReport', functionId, msg.round);
        } else if (msg?.command === 'import') {
          void vscode.commands.executeCommand('aitest.importTestCasesFromFile', functionId);
        } else if (msg?.command === 'sync' && typeof msg.screenUrl === 'string' && typeof msg.model === 'string') {
          void vscode.commands.executeCommand('aitest.syncTestScripts', functionId, {
            screenUrl: msg.screenUrl,
            apiBaseUrl: msg.apiBaseUrl,
            apiAuthHeader: msg.apiAuthHeader,
            model: msg.model,
            forceAll: msg.forceAll
          });
        } else if (msg?.command === 'addTestCase' && msg.testCase) {
          void vscode.commands.executeCommand('aitest.addTestCase', functionId, msg.testCase);
        } else if (msg?.command === 'updateTestCase' && msg.testCase) {
          void vscode.commands.executeCommand('aitest.updateTestCase', functionId, msg.testCase);
        } else if (msg?.command === 'deleteTestCase' && msg.id) {
          void vscode.commands.executeCommand('aitest.deleteTestCase', functionId, msg.id);
        } else if (msg?.command === 'syncTestCase' && msg.id) {
          void vscode.commands.executeCommand('aitest.syncSingleTestCase', functionId, msg.id);
        } else if (msg?.command === 'suggestMissing') {
          void vscode.commands.executeCommand('aitest.suggestMissingTestCasesForPanel', functionId);
        } else if (msg?.command === 'saveSuggested' && msg.testCases) {
          void vscode.commands.executeCommand('aitest.saveSuggestedTestCases', functionId, msg.testCases);
        }
      }
    );
  }

  /** Re-render after testcases.json or generated/ changes (import/sync/CRUD/run).
   * `autoOpenSync=true` opens the embedded "Sync Test" modal right away, used after an import
   * when the Screen URL/API config is still missing. */
  static refreshIfOpen(functionId: string, autoOpenSync = false): void {
    MainPanel.updateHtmlIfCurrent(viewId(functionId), render(functionId, autoOpenSync, this.syncingIds.get(functionId)));
  }

  /** Send "Suggest missing test cases" results to the open panel via postMessage, without a full
   * re-render, so any unsaved input is kept. */
  static pushSuggestions(functionId: string, suggestions: SuggestedTestCase[]): void {
    MainPanel.postMessageIfCurrent(viewId(functionId), { type: 'suggestions', suggestions });
  }

  /** Toggle the "syncing" state of a single row (spinning 🔄, Edit/Delete/Sync disabled).
   * Patches the row via postMessage and also records it in `syncingIds` so a full re-render
   * triggered meanwhile keeps the state. syncSingleTestCase in extension.ts calls
   * setRowSyncing(..., false) in `finally` before refreshIfOpen() to clear the entry. */
  static setRowSyncing(functionId: string, testId: string, syncing: boolean): void {
    let ids = this.syncingIds.get(functionId);
    if (!ids) {
      ids = new Set();
      this.syncingIds.set(functionId, ids);
    }
    if (syncing) ids.add(testId);
    else ids.delete(testId);
    MainPanel.postMessageIfCurrent(viewId(functionId), { type: 'rowSyncing', testId, syncing });
  }

  static isOpen(functionId: string): boolean {
    return MainPanel.isCurrent(viewId(functionId));
  }
}

function severityBadgeClass(sev: string): string {
  return { Critical: 'sev-critical', High: 'sev-high', Medium: 'sev-medium', Low: 'sev-low' }[sev] || 'sev-medium';
}

/** Previous hash cache, used to count CHANGED test cases (as opposed to ones without a script) for
 * the Sync Test modal. A missing cache (new function) means nothing changed. */
function readPreviousHashes(fnDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(testCaseHashesPath(fnDir), 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function render(functionId: string, autoOpenSync = false, syncingIds?: Set<string>): string {
  const n = nonce();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return wrapHtml(n, '<p>No workspace folder is open.</p>');
  }

  const fnDir = functionDir(path.join(workspaceRoot, '.aitest'), functionId);
  const testCases = readTestCases(fnDir);
  const scriptedIds = listScriptedTestCaseIds(fnDir);
  const rounds = readRounds(fnDir);
  const latestRound = rounds.at(-1);
  const latestReport = latestRound ? readRoundReport(fnDir, latestRound.round) : undefined;
  const latestById = new Map<string, TestResultDetail>((latestReport?.tests ?? []).map((t) => [extractTestId(t.name), t]));

  const okCount = testCases.filter((tc) => scriptedIds.has(tc.id)).length;

  // Data for the embedded "Sync Test" modal (see openSyncModal in the script).
  const meta = readFunctionMeta(fnDir);
  const hasApiCases = testCases.some((tc) => tc.kind === 'api');
  const missingScriptIds = testCases.filter((tc) => !scriptedIds.has(tc.id)).map((tc) => tc.id);
  const changedIds = diffTestCases(testCases, readPreviousHashes(fnDir)).changedKeys;
  const toSyncCount = new Set([...changedIds, ...missingScriptIds]).size;
  const defaultModel =
    vscode.workspace.getConfiguration('aitest').get<string>('generation.model', DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
  const syncMeta = {
    screenUrl: meta.screenUrl ?? '',
    hasApiCases,
    apiBaseUrl: meta.apiBaseUrl ?? '',
    apiAuthHeader: meta.apiAuthHeader ?? '',
    model: meta.syncModel || defaultModel,
    toSyncCount,
    totalCount: testCases.length,
    autoOpen: autoOpenSync
  };

  const rows = testCases
    .map((tc) => {
      const latest = latestById.get(tc.id);
      const latestCell = !latest
        ? '—'
        : latest.status === 'passed'
          ? '✅ Pass'
          : latest.bugReportPath
            ? `<a href="#" class="open-path" data-path="${escapeHtml(latest.bugReportPath)}">❌ Failed</a>`
            : '❌ Failed';

      const scriptCell = scriptedIds.has(tc.id)
        ? `<span class="status ok">✅ Scripted</span>`
        : tc.lastScriptGenError
          ? `<span class="status error" title="${escapeHtml(tc.lastScriptGenError)}">❌ Script generation failed</span>`
          : `<span class="status missing">⚠️ No script</span>`;

      // Render the syncing state up front: a full re-render can happen while this row is still
      // syncing (see TestCasesPanel.syncingIds).
      const isSyncing = syncingIds?.has(tc.id) ?? false;
      return `
      <tr data-tc-id="${escapeHtml(tc.id)}" class="${isSyncing ? 'syncing' : ''}">
        <td class="col-id">${escapeHtml(tc.id)}</td>
        <td>${escapeHtml(tc.name)}</td>
        <td><span class="badge kind">${escapeHtml(tc.kind.toUpperCase())}</span> <span class="badge kind">${escapeHtml(tc.category ?? '-')}</span></td>
        <td><span class="badge ${severityBadgeClass(tc.severity)}">${escapeHtml(tc.severity)}</span></td>
        <td>${escapeHtml(tc.precondition)}</td>
        <td class="col-steps"><ol>${tc.steps.map((s) => `<li>${escapeHtml(s.replace(/^\s*\d+\s*[.)]\s*/, ''))}</li>`).join('')}</ol></td>
        <td>${escapeHtml(tc.dataTest)}</td>
        <td>${escapeHtml(tc.expectedResult)}</td>
        <td class="col-script-status">${scriptCell}</td>
        <td>${latestCell}</td>
        <td class="col-actions">
          <button class="icon-btn sync-tc" data-id="${escapeHtml(tc.id)}" title="Sync Test" ${isSyncing ? 'disabled' : ''}><span class="sync-icon${isSyncing ? ' spin' : ''}">🔄</span></button>
          <button class="icon-btn edit-tc" data-id="${escapeHtml(tc.id)}" title="Edit" ${isSyncing ? 'disabled' : ''}>✎</button>
          <button class="icon-btn delete-tc" data-id="${escapeHtml(tc.id)}" title="Delete" ${isSyncing ? 'disabled' : ''}>🗑</button>
        </td>
      </tr>`;
    })
    .join('');

  const roundLinks = rounds
    .map((r) => `<a href="#" class="open-round" data-round="${r.round}">Round ${r.round} (${r.passed}/${r.total} pass)</a>`)
    .join(' &nbsp;|&nbsp; ');

  const testCasesJson = JSON.stringify(testCases).replace(/</g, '\\u003c');
  const syncMetaJson = JSON.stringify(syncMeta).replace(/</g, '\\u003c');

  const script = `
    (function () {
      var vscode = acquireVsCodeApi();
      var testCases = ${testCasesJson};
      var syncMeta = ${syncMetaJson};

      document.querySelectorAll('.open-path').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          var p = el.getAttribute('data-path');
          if (p) vscode.postMessage({ command: 'openPath', path: p });
        });
      });
      document.querySelectorAll('.open-round').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          vscode.postMessage({ command: 'openRound', round: parseInt(el.getAttribute('data-round'), 10) });
        });
      });

      document.getElementById('import-btn').addEventListener('click', function () {
        vscode.postMessage({ command: 'import' });
      });
      document.getElementById('sync-btn').addEventListener('click', function () {
        openSyncModal();
      });

      function openSyncModal() {
        document.getElementById('sync-summary').textContent =
          syncMeta.toSyncCount > 0
            ? 'Will sync scripts for ' + syncMeta.toSyncCount + '/' + syncMeta.totalCount + ' test cases that are new or changed.'
            : 'No test cases changed (' + syncMeta.totalCount + '/' + syncMeta.totalCount + ' scripts are up to date). Turn on "Regenerate all" below to regenerate anyway.';
        document.getElementById('sync-screen-url').value = syncMeta.screenUrl;
        document.getElementById('sync-api-fields').style.display = syncMeta.hasApiCases ? '' : 'none';
        document.getElementById('sync-api-base').value = syncMeta.apiBaseUrl;
        document.getElementById('sync-auth-header').value = syncMeta.apiAuthHeader;
        document.getElementById('sync-model').value = syncMeta.model;
        document.getElementById('sync-force-all').checked = false;
        document.getElementById('sync-error').textContent = '';
        document.getElementById('sync-modal').classList.remove('hidden');
      }

      document.getElementById('sync-modal-cancel').addEventListener('click', function () {
        document.getElementById('sync-modal').classList.add('hidden');
      });
      document.getElementById('sync-modal-save').addEventListener('click', function () {
        var errorEl = document.getElementById('sync-error');
        var screenUrl = document.getElementById('sync-screen-url').value.trim();
        if (!screenUrl || !/^https?:\\/\\//i.test(screenUrl)) {
          errorEl.textContent = 'Enter a valid Screen URL (starting with http:// or https://)';
          return;
        }
        var apiBaseUrl, apiAuthHeader;
        if (syncMeta.hasApiCases) {
          apiBaseUrl = document.getElementById('sync-api-base').value.trim();
          apiAuthHeader = document.getElementById('sync-auth-header').value.trim() || undefined;
          if (!apiBaseUrl || !/^https?:\\/\\//i.test(apiBaseUrl)) {
            errorEl.textContent = 'Enter a valid API Base URL (starting with http:// or https://); this function has API test cases';
            return;
          }
        }
        var model = document.getElementById('sync-model').value;
        var forceAll = document.getElementById('sync-force-all').checked;
        errorEl.textContent = '';
        vscode.postMessage({
          command: 'sync',
          screenUrl: screenUrl,
          apiBaseUrl: apiBaseUrl,
          apiAuthHeader: apiAuthHeader,
          model: model,
          forceAll: forceAll
        });
        document.getElementById('sync-modal').classList.add('hidden');
      });

      if (syncMeta.autoOpen) openSyncModal();

      document.getElementById('suggest-btn').addEventListener('click', function () {
        document.getElementById('suggest-modal').classList.remove('hidden');
        document.getElementById('suggest-body').innerHTML = '<p class="hint">Reviewing the source code and current test cases...</p>';
        vscode.postMessage({ command: 'suggestMissing' });
      });
      document.getElementById('add-btn').addEventListener('click', function () {
        openTestCaseModal(null);
      });

      document.querySelectorAll('.edit-tc').forEach(function (el) {
        el.addEventListener('click', function () {
          var id = el.getAttribute('data-id');
          openTestCaseModal(testCases.find(function (tc) { return tc.id === id; }));
        });
      });
      document.querySelectorAll('.delete-tc').forEach(function (el) {
        el.addEventListener('click', function () {
          var id = el.getAttribute('data-id');
          if (confirm('Delete test case ' + id + '?')) vscode.postMessage({ command: 'deleteTestCase', id: id });
        });
      });
      document.querySelectorAll('.sync-tc').forEach(function (el) {
        el.addEventListener('click', function () {
          if (el.disabled) return;
          var id = el.getAttribute('data-id');
          vscode.postMessage({ command: 'syncTestCase', id: id });
        });
      });

      function openTestCaseModal(tc) {
        document.getElementById('tcm-title').textContent = tc ? 'Edit test case ' + tc.id : 'Add test case';
        document.getElementById('tcm-id').value = tc ? tc.id : '';
        document.getElementById('tcm-id').disabled = Boolean(tc);
        document.getElementById('tcm-kind').value = tc ? tc.kind : 'ui';
        document.getElementById('tcm-severity').value = tc ? tc.severity : 'Medium';
        document.getElementById('tcm-name').value = tc ? tc.name : '';
        document.getElementById('tcm-pre').value = tc ? tc.precondition : '';
        document.getElementById('tcm-steps').value = tc ? tc.steps.join('\\n') : '';
        document.getElementById('tcm-data').value = tc ? tc.dataTest : '';
        document.getElementById('tcm-expected').value = tc ? tc.expectedResult : '';
        document.getElementById('tc-modal').dataset.editing = tc ? tc.id : '';
        document.getElementById('tc-modal').classList.remove('hidden');
      }

      document.getElementById('tc-modal-cancel').addEventListener('click', function () {
        document.getElementById('tc-modal').classList.add('hidden');
      });
      document.getElementById('tc-modal-save').addEventListener('click', function () {
        var id = document.getElementById('tcm-id').value.trim();
        var name = document.getElementById('tcm-name').value.trim();
        if (!id || !name) { alert('ID and test case name are required'); return; }
        var testCase = {
          id: id,
          name: name,
          kind: document.getElementById('tcm-kind').value,
          category: 'functional',
          target: '${escapeHtml(functionId)}',
          severity: document.getElementById('tcm-severity').value,
          precondition: document.getElementById('tcm-pre').value.trim(),
          steps: document.getElementById('tcm-steps').value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean),
          dataTest: document.getElementById('tcm-data').value.trim(),
          expectedResult: document.getElementById('tcm-expected').value.trim(),
          isEdgeCase: false
        };
        var editing = document.getElementById('tc-modal').dataset.editing;
        vscode.postMessage({ command: editing ? 'updateTestCase' : 'addTestCase', testCase: testCase });
        document.getElementById('tc-modal').classList.add('hidden');
      });

      document.getElementById('suggest-cancel').addEventListener('click', function () {
        document.getElementById('suggest-modal').classList.add('hidden');
      });

      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg.type === 'suggestions') renderSuggestions(msg.suggestions);
        else if (msg.type === 'rowSyncing') setRowSyncing(msg.testId, msg.syncing);
      });

      // Patch only this row while it syncs, so the case can't be edited/deleted while its script is
      // regenerated from the old data. The extension host always re-renders when the sync ends, so
      // the state is never cleared here.
      function setRowSyncing(testId, syncing) {
        var row = document.querySelector('tr[data-tc-id="' + testId + '"]');
        if (!row) return;
        row.classList.toggle('syncing', syncing);
        row.querySelectorAll('.sync-tc, .edit-tc, .delete-tc').forEach(function (btn) { btn.disabled = syncing; });
        var icon = row.querySelector('.sync-icon');
        if (icon) icon.classList.toggle('spin', syncing);
      }

      function renderSuggestions(suggestions) {
        var body = document.getElementById('suggest-body');
        if (!suggestions || suggestions.length === 0) {
          body.innerHTML = '<p class="hint">The AI found no missing test cases; coverage looks complete.</p>';
          return;
        }
        body.innerHTML =
          '<p class="hint">Found ' + suggestions.length + ' missing cases:</p>' +
          '<div id="suggest-list"></div>' +
          '<button id="suggest-save" class="btn primary" disabled>Save selected (0)</button>';

        var list = document.getElementById('suggest-list');
        suggestions.forEach(function (s, i) {
          var item = document.createElement('label');
          item.className = 'suggest-item';
          item.innerHTML =
            '<input type="checkbox" data-idx="' + i + '" />' +
            '<span class="body"><div class="name">' + escapeText(s.name) + '</div>' +
            '<div class="why">' + escapeText(s.reason || s.expectedResult || '') + '</div></span>';
          list.appendChild(item);
        });

        function updateSaveBtn() {
          var n = list.querySelectorAll('input:checked').length;
          var btn = document.getElementById('suggest-save');
          btn.textContent = 'Save selected (' + n + ')';
          btn.disabled = n === 0;
        }
        list.querySelectorAll('input').forEach(function (cb) { cb.addEventListener('change', updateSaveBtn); });

        document.getElementById('suggest-save').addEventListener('click', function () {
          var chosen = Array.prototype.slice.call(list.querySelectorAll('input:checked'))
            .map(function (cb) { return suggestions[parseInt(cb.getAttribute('data-idx'), 10)]; });
          vscode.postMessage({ command: 'saveSuggested', testCases: chosen });
          document.getElementById('suggest-modal').classList.add('hidden');
        });
      }

      function escapeText(s) {
        var d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
      }

      ${TABLE_INTERACTIONS_SCRIPT}
      enableTableInteractions(document.getElementById('tc-table'));
    })();
  `;

  return wrapHtml(
    n,
    `<h3>Test Case — ${escapeHtml(functionId)}</h3>
    <div class="subtitle">${testCases.length} test case${testCases.length === 1 ? '' : 's'} &nbsp;•&nbsp; ✅ ${okCount} scripted &nbsp;•&nbsp; ⚠️ ${testCases.length - okCount} without script</div>
    <div class="rounds">${rounds.length ? roundLinks : 'No test runs yet.'}</div>

    <div class="toolbar">
      <button id="import-btn" class="btn">📥 Import test cases</button>
      <button id="sync-btn" class="btn">🔄 Sync Test</button>
      <button id="suggest-btn" class="btn">💡 Suggest missing test cases</button>
      <span class="spacer"></span>
      <button id="add-btn" class="btn primary">➕ Add test case</button>
    </div>

    <table id="tc-table">
      <thead>
        <tr>
          <th>ID</th><th>Test Case Name</th><th>Type</th><th>Severity</th><th>Pre-condition</th><th>Steps</th>
          <th>Data Test</th><th>Expected Result</th><th>Script status</th><th>Latest result</th><th></th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="11">No test cases yet. Click "Import test cases" (Markdown or Excel) or "Add test case".</td></tr>'}</tbody>
    </table>

    <div class="overlay hidden" id="sync-modal">
      <div class="modal">
        <h4>🔄 Sync Test Script</h4>
        <p class="hint" id="sync-summary"></p>
        <div class="field">
          <label>Screen URL (for UI test cases)</label>
          <input id="sync-screen-url" type="text" placeholder="http://localhost:3000/customer-signup" />
        </div>
        <div id="sync-api-fields">
          <div class="field"><label>API Base URL</label><input id="sync-api-base" type="text" placeholder="http://localhost:3000" /></div>
          <div class="field"><label>Auth header (leave empty if the API needs none)</label><input id="sync-auth-header" type="text" placeholder="Bearer &lt;token&gt;" /></div>
        </div>
        <div class="field">
          <label>Claude model for this sync</label>
          <select id="sync-model">${MODEL_OPTIONS.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('')}</select>
          <div class="hint" style="margin-top:4px">Applies to this sync only.</div>
        </div>
        <div class="field">
          <div class="toggle-row">
            <label for="sync-force-all" class="field-inline-label">Regenerate all</label>
            <label class="switch">
              <input id="sync-force-all" type="checkbox" />
              <span class="switch-slider"></span>
            </label>
          </div>
          <div class="hint" style="margin-top:4px">Skip change detection and regenerate scripts for ALL test cases, including unchanged ones. Useful when generation conventions changed (e.g. how the base URL is used). Uses more AI calls.</div>
        </div>
        <div id="sync-error" style="color:#f14c4c;font-size:12px;min-height:16px"></div>
        <div class="modal-footer">
          <button id="sync-modal-cancel" class="btn">Cancel</button>
          <button id="sync-modal-save" class="btn primary">🔄 Start sync</button>
        </div>
      </div>
    </div>

    <div class="overlay hidden" id="tc-modal">
      <div class="modal">
        <h4 id="tcm-title">Add test case</h4>
        <div class="field-row">
          <div class="field"><label>ID</label><input id="tcm-id" type="text" /></div>
          <div class="field"><label>Type</label>
            <select id="tcm-kind"><option value="ui">UI</option><option value="api">API</option></select>
          </div>
          <div class="field"><label>Severity</label>
            <select id="tcm-severity">
              <option value="Low">Low</option><option value="Medium">Medium</option>
              <option value="High">High</option><option value="Critical">Critical</option>
            </select>
          </div>
        </div>
        <div class="field"><label>Test case name</label><input id="tcm-name" type="text" /></div>
        <div class="field"><label>Pre-condition</label><input id="tcm-pre" type="text" /></div>
        <div class="field"><label>Steps (one per line)</label><textarea id="tcm-steps"></textarea></div>
        <div class="field-row">
          <div class="field"><label>Data Test</label><input id="tcm-data" type="text" /></div>
          <div class="field"><label>Expected Result</label><input id="tcm-expected" type="text" /></div>
        </div>
        <div class="modal-footer">
          <button id="tc-modal-cancel" class="btn">Cancel</button>
          <button id="tc-modal-save" class="btn primary">Save test case</button>
        </div>
      </div>
    </div>

    <div class="overlay hidden" id="suggest-modal">
      <div class="modal wide">
        <h4>💡 Suggest missing test cases</h4>
        <div id="suggest-body"></div>
        <div class="modal-footer"><button id="suggest-cancel" class="btn">Close</button></div>
      </div>
    </div>`,
    script
  );
}

function wrapHtml(n: string, body: string, script = ''): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';" />
    <style>
      body { font-family: -apple-system, sans-serif; padding: 16px; color: #ddd; background: #1e1e1e; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; }
      td, th { padding: 6px 8px; border-bottom: 1px solid #444; text-align: left; font-size: 13px; vertical-align: top; }
      .col-id { font-family: ui-monospace, monospace; white-space: nowrap; color: #4a9eff; }
      .col-steps ol { margin: 0; padding-left: 16px; }
      .col-actions { white-space: nowrap; text-align: right; }
      .subtitle { color: #9a9a9a; font-size: 12px; margin: 2px 0 8px; }
      .rounds { margin-top: 4px; font-size: 13px; }
      a.open-path, a.open-round { color: #4a9eff; cursor: pointer; text-decoration: underline; }
      .toolbar { display: flex; align-items: center; gap: 8px; margin: 14px 0; flex-wrap: wrap; }
      .toolbar .spacer { flex: 1; }
      button.btn {
        background: #3a3d41; color: #ddd; border: 1px solid #555; padding: 5px 12px; border-radius: 3px;
        cursor: pointer; font-size: 12px;
      }
      button.btn:hover { background: #45494e; }
      button.btn.primary { background: #0e639c; border-color: #0e639c; }
      button.btn.primary:hover { background: #1177bb; }
      button.btn:disabled { opacity: .5; cursor: not-allowed; }
      .icon-btn { background: none; border: none; color: #9a9a9a; cursor: pointer; font-size: 13px; padding: 2px 4px; }
      .icon-btn:hover { color: #ddd; }
      .icon-btn:disabled { opacity: .4; cursor: not-allowed; }
      .sync-icon.spin { display: inline-block; animation: aitest-spin 1s linear infinite; }
      @keyframes aitest-spin { to { transform: rotate(360deg); } }
      tr.syncing .col-script-status::after { content: ' — ⏳ syncing...'; color: #4a9eff; }
      .badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; }
      .badge.sev-critical { background: rgba(241,76,76,.18); color: #f88; }
      .badge.sev-high { background: rgba(215,153,33,.18); color: #d7ba7d; }
      .badge.sev-medium { background: rgba(74,158,255,.18); color: #4a9eff; }
      .badge.sev-low { background: rgba(137,209,133,.18); color: #89d185; }
      .badge.kind { background: #3a3d41; color: #9a9a9a; }
      .status.ok { color: #89d185; }
      .status.missing { color: #d7ba7d; }
      .status.error { color: #f88; }
      .hint { color: #9a9a9a; font-size: 12px; }
      .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
      .overlay.hidden { display: none; }
      .modal { background: #2d2d2d; border: 1px solid #454545; border-radius: 5px; width: 520px; max-width: 92vw; max-height: 86vh; overflow-y: auto; padding: 16px 18px; }
      .modal.wide { width: 640px; }
      .modal h4 { margin: 0 0 12px; }
      .field { margin-bottom: 12px; }
      .field label { display: block; margin-bottom: 4px; color: #9a9a9a; font-size: 11.5px; }
      .field input, .field select, .field textarea {
        width: 100%; background: #3c3c3c; border: 1px solid #454545; color: #ddd; padding: 6px 8px; border-radius: 3px;
        font-size: 12.5px; font-family: inherit; box-sizing: border-box;
      }
      .field textarea { min-height: 60px; resize: vertical; }
      .field-row { display: flex; gap: 10px; }
      .field-row .field { flex: 1; }
      .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .toggle-row .field-inline-label { display: inline; margin-bottom: 0; }
      .switch { position: relative; display: inline-block; flex: none; width: 36px; height: 20px; cursor: pointer; }
      .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
      .switch-slider { position: absolute; inset: 0; background: #5a5a5a; border-radius: 20px; transition: background .15s; pointer-events: none; }
      .switch-slider::before {
        content: ""; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px;
        background: #fff; border-radius: 50%; transition: transform .15s;
      }
      .switch input:checked + .switch-slider { background: #0e639c; }
      .switch input:checked + .switch-slider::before { transform: translateX(16px); }
      .switch input:focus-visible + .switch-slider { outline: 2px solid #0e639c; outline-offset: 2px; }
      .modal-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
      .suggest-item { display: flex; gap: 10px; padding: 10px; border: 1px solid #444; border-radius: 4px; margin-bottom: 8px; }
      .suggest-item .name { font-weight: 600; margin-bottom: 2px; }
      .suggest-item .why { color: #9a9a9a; font-size: 11.5px; }
      ${TABLE_INTERACTIONS_STYLE}
    </style>
  </head>
  <body>${body}
    ${script ? `<script nonce="${n}">${script}</script>` : ''}
  </body>
  </html>`;
}
