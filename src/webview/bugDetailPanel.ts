import { nonce } from './popupModal';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  computeBugOccurrence,
  functionDir,
  readBacklogProject,
  readBacklogUploadedTask,
  readBugAnalysis,
  readFunctionMeta,
  readRoundReport,
  readTestCases
} from '../core/store';
import { extractTestId } from '../core/testRunner';
import { buildBacklogDescription } from '../core/bugAnalysis';
import { TestResultDetail } from '../types';
import { MainPanel } from './mainPanel';


function escapeHtml(input: string): string {
  return String(input).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function key(functionId: string, round: number, testId: string): string {
  return `${functionId}::${round}::${testId}`;
}

/**
 * Bug detail for one failed test case: report, AI analysis and Backlog upload. Reads from disk on
 * every render and keeps no state, so calling `show()` again after analyze/upload reflects new data
 * (see analyzeBug/uploadBugToBacklog in extension.ts).
 */
export class BugDetailPanel {
  static show(functionId: string, round: number, testId: string): void {
    const k = key(functionId, round, testId);
    MainPanel.show(k, `🐞 ${testId} — ${functionId} round ${round}`, render(functionId, round, testId), (msg: { command?: string; path?: string }) => {
      if (msg?.command === 'analyze') {
        void vscode.commands.executeCommand('aitest.analyzeBug', functionId, round, testId);
      } else if (msg?.command === 'upload') {
        void vscode.commands.executeCommand('aitest.uploadBugToBacklog', functionId, round, testId);
      } else if (msg?.command === 'openEvidence' && msg.path) {
        void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
      }
    });
  }

  static refreshIfOpen(functionId: string, round: number, testId: string): void {
    MainPanel.updateHtmlIfCurrent(key(functionId, round, testId), render(functionId, round, testId));
  }
}

function render(functionId: string, round: number, testId: string): string {
  const n = nonce();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return wrapHtml(n, '<p>No workspace folder is open.</p>');

  const aitestDirPath = path.join(workspaceRoot, '.aitest');
  const fnDir = functionDir(aitestDirPath, functionId);
  const report = readRoundReport(fnDir, round);
  const test: TestResultDetail | undefined = report?.tests.find((t) => extractTestId(t.name) === testId);
  if (!test) {
    return wrapHtml(n, `<p>No result found for "${escapeHtml(testId)}" in round ${round}.</p>`);
  }

  const testCase = readTestCases(fnDir).find((tc) => tc.id === testId);
  const analysis = readBugAnalysis(fnDir, round, testId);
  const uploadedTask = readBacklogUploadedTask(fnDir, round, testId);
  const backlogProject = readBacklogProject(aitestDirPath);
  const meta = readFunctionMeta(fnDir);
  // Same inputs as uploadBugToBacklog in extension.ts (including the existing-evidence filter):
  // the preview must match the uploaded description exactly.
  const evidencePaths = [test.screenshotPath, test.bugReportPath].filter(
    (p): p is string => Boolean(p) && fs.existsSync(p as string)
  );
  const description = buildBacklogDescription({
    testName: test.name,
    errorMessage: test.errorMessage ?? '(no error details)',
    testCase,
    analysis,
    environment: {
      functionId,
      round,
      kind: testCase?.kind,
      baseUrl: testCase?.kind === 'api' ? meta.apiBaseUrl : meta.screenUrl,
      startedAt: test.startedAt
    },
    occurrence: computeBugOccurrence(fnDir, testId),
    evidencePaths
  });

  const analysisSectionHtml = analysis
    ? `
      <div class="section analysis-box">
        <h4>🔎 AI analysis</h4>
        <p><strong>Root cause:</strong> ${escapeHtml(analysis.rootCause)}</p>
        <p><strong>Suggested fix:</strong> ${escapeHtml(analysis.fixApproach)}</p>
        <p style="margin-bottom:4px"><strong>Action items:</strong></p>
        <ul>${analysis.actionItems.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
        <p style="margin-top:10px">Effort estimate: <span class="estimate-pill">${escapeHtml(analysis.estimate)}</span></p>
      </div>`
    : `<div class="section"><button id="analyze-btn" class="btn primary">🔎 Analyze this failure</button></div>`;

  // Upload is independent of analysis; the analysis is an optional part of the description.
  const uploadSectionHtml = `<div class="section upload-area">${renderUploadArea(uploadedTask, backlogProject)}</div>`;

  return wrapHtml(
    n,
    `<h3>🐞 ${escapeHtml(testId)} — ${escapeHtml(testCase?.name ?? test.name)}</h3>
    <div class="meta">
      <span>TC: <strong>${escapeHtml(testId)}</strong></span>
      <span>Severity: <strong>${escapeHtml(testCase?.severity ?? '-')}</strong></span>
      <span>Round: <strong>${round}</strong></span>
      <span>Function: <strong>${escapeHtml(functionId)}</strong></span>
    </div>

    <div class="section"><h4>Test</h4><p>${escapeHtml(test.name)}</p></div>

    ${testCase ? `<div class="section"><h4>Steps to Reproduce</h4><ol>${testCase.steps.map((s) => `<li>${escapeHtml(s.replace(/^\s*\d+\s*[.)]\s*/, ''))}</li>`).join('')}</ol></div>` : ''}
    ${testCase ? `<div class="section"><h4>Expected Result</h4><p>${escapeHtml(testCase.expectedResult)}</p></div>` : ''}
    <div class="section"><h4>Actual Result</h4><p>${escapeHtml(test.errorMessage ?? '(no error details)')}</p></div>
    <div class="section"><h4>Error Detail</h4><div class="codeblock">${escapeHtml(test.errorMessage ?? '(no error details)')}</div></div>

    <div class="section">
      <h4>Evidence</h4>
      ${test.screenshotPath ? `<a href="#" class="open-evidence" data-path="${escapeHtml(test.screenshotPath)}">📷 Screenshot</a>` : '<span class="hint">No evidence.</span>'}
      ${test.bugReportPath ? ` &nbsp;|&nbsp; <a href="#" class="open-evidence" data-path="${escapeHtml(test.bugReportPath)}">📄 Original bug report</a>` : ''}
    </div>

    <hr />
    ${analysisSectionHtml}
    ${uploadSectionHtml}

    <details class="preview-details">
      <summary>👁 Preview Backlog issue content</summary>
      <div class="codeblock neutral">${escapeHtml(description)}</div>
    </details>`,
    `
    (function () {
      var vscode = acquireVsCodeApi();
      document.querySelectorAll('.open-evidence').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          vscode.postMessage({ command: 'openEvidence', path: el.getAttribute('data-path') });
        });
      });
      var analyzeBtn = document.getElementById('analyze-btn');
      if (analyzeBtn) {
        analyzeBtn.addEventListener('click', function () {
          analyzeBtn.disabled = true;
          analyzeBtn.innerHTML = '⏳ Analyzing...';
          vscode.postMessage({ command: 'analyze' });
        });
      }
      var uploadBtn = document.getElementById('upload-btn');
      if (uploadBtn) {
        uploadBtn.addEventListener('click', function () {
          uploadBtn.disabled = true;
          uploadBtn.innerHTML = uploadBtn.getAttribute('data-mode') === 'update'
            ? '⏳ Updating issue and uploading evidence...'
            : '⏳ Creating issue and uploading evidence...';
          vscode.postMessage({ command: 'upload' });
        });
      }
    })();
  `
  );
}

/**
 * Backlog upload button, available without AI analysis. The first upload creates an issue; later
 * uploads update that same issue instead of creating a duplicate. `data-mode` selects the progress text.
 */
function renderUploadArea(
  uploadedTask: { issueKey: string; url: string } | undefined,
  backlogProject: { projectName: string } | undefined
): string {
  if (!backlogProject) {
    return `<p class="hint">No Backlog project connected. Connect one in Settings → Integrations before uploading.</p>`;
  }
  if (uploadedTask) {
    return `
      <div class="status ok">✅ Issue <a href="${escapeHtml(uploadedTask.url)}">${escapeHtml(uploadedTask.issueKey)}</a> created in Backlog.</div>
      <button id="upload-btn" class="btn" data-mode="update" style="margin-top:8px">🔄 Upload again (updates ${escapeHtml(uploadedTask.issueKey)}, no new issue)</button>`;
  }
  return `<button id="upload-btn" class="btn primary" data-mode="create">📤 Upload to Backlog (${escapeHtml(backlogProject.projectName)})</button>`;
}

function wrapHtml(n: string, body: string, script = ''): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';" />
    <style>
      body { font-family: -apple-system, sans-serif; padding: 20px 28px; color: #ddd; background: #1e1e1e; max-width: 900px; }
      h3 { margin-bottom: 14px; }
      .meta { display: flex; gap: 18px; flex-wrap: wrap; color: #9a9a9a; font-size: 12.5px; margin-bottom: 18px; }
      .meta strong { color: #ddd; }
      .section { margin-bottom: 20px; }
      .section h4 { margin: 0 0 8px; font-size: 13px; }
      .section ol, .section ul { margin: 0; padding-left: 20px; line-height: 1.6; }
      .codeblock {
        background: #181818; border: 1px solid #3c3c3c; border-radius: 4px; padding: 10px 12px;
        font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #e39a9a; white-space: pre-wrap; overflow-x: auto;
      }
      .codeblock.neutral { color: #9a9a9a; }
      .analysis-box { border: 1px solid #4a9eff; border-radius: 6px; padding: 14px 16px; background: rgba(74,158,255,.06); }
      .analysis-box h4 { color: #4a9eff; }
      .estimate-pill { display: inline-block; background: rgba(137,209,133,.15); color: #89d185; padding: 3px 10px; border-radius: 12px; font-weight: 600; font-size: 12px; }
      .upload-area { margin-top: 14px; padding-top: 12px; border-top: 1px solid #3c3c3c; }
      .status.ok { color: #89d185; }
      .status.ok a { color: #89d185; text-decoration: underline; }
      .hint { color: #9a9a9a; font-size: 12px; }
      a { color: #4a9eff; }
      button.btn {
        background: #3a3d41; color: #ddd; border: 1px solid #555; padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: 12.5px;
      }
      button.btn.primary { background: #0e639c; border-color: #0e639c; }
      button.btn.primary:hover { background: #1177bb; }
      button.btn:disabled { opacity: .6; cursor: not-allowed; }
      .preview-details { margin-top: 10px; }
      .preview-details summary { cursor: pointer; color: #4a9eff; font-size: 12.5px; }
      hr { border-color: #3c3c3c; margin: 24px 0; }
    </style>
  </head>
  <body>${body}
    ${script ? `<script nonce="${n}">${script}</script>` : ''}
  </body>
  </html>`;
}
