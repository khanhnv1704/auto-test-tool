import * as vscode from 'vscode';
import { BacklogProjectConfig } from '../types';
import { escapeHtml, nonce, renderPopupPage } from './popupModal';
import { MainPanel } from './mainPanel';

const VIEW_ID = 'projectSetting';

export interface ProjectSettingData {
  project: BacklogProjectConfig | undefined;
  /** Full Backlog project URL (from buildProjectUrl). Built by the extension host because it may
   * read a BACKLOG_BASE_URL override from .env. */
  projectUrl: string | undefined;
  /** The open workspace folder. Not stored in backlog.json; changing it reloads the window
   * (aitest.chooseProjectFolder). */
  folderPath: string | undefined;
}

/**
 * Opened from the sidebar "Project" row: shows the connected Backlog project (link, issue count,
 * description, local source folder). The issue count needs a separate API call, so the panel renders
 * "Loading..." first and pushTaskCount patches it in later.
 */
export class ProjectSettingPanel {
  static show(data: ProjectSettingData): void {
    MainPanel.show(VIEW_ID, 'AI Auto Test — Project Setting', render(data), (msg: { command?: string; description?: string; url?: string }) => {
      if (msg?.command === 'openMcpSetting') {
        void vscode.commands.executeCommand('aitest.openMcpSetting');
      } else if (msg?.command === 'switchProject') {
        void vscode.commands.executeCommand('aitest.switchBacklogProject');
      } else if (msg?.command === 'chooseFolder') {
        void vscode.commands.executeCommand('aitest.chooseProjectFolder');
      } else if (msg?.command === 'openExternal' && msg.url) {
        void vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg?.command === 'saveDescription' && typeof msg.description === 'string') {
        void vscode.commands.executeCommand('aitest.saveBacklogProjectDescription', msg.description);
      } else if (msg?.command === 'cancel') {
        MainPanel.closeIfCurrent(VIEW_ID);
      }
    });
  }

  static refreshIfOpen(data: ProjectSettingData): void {
    MainPanel.updateHtmlIfCurrent(VIEW_ID, render(data));
  }

  /** Patch only the issue count cell, without a full re-render, so a description being typed is kept. */
  static pushTaskCount(count: number | undefined, error?: string): void {
    MainPanel.postMessageIfCurrent(VIEW_ID, { type: 'taskCount', count, error });
  }

  static isOpen(): boolean {
    return MainPanel.isCurrent(VIEW_ID);
  }
}

const EXTRA_STYLE = `
  <style>
    .modal { width: 620px; }
    .screen-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    /* The "✕" button sits next to "Switch project" on the right of the header, not inside the left-aligned <h3>. */
    .header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .empty-state { color: #9a9a9a; text-align: center; padding: 40px 0; font-size: 13px; }
    .setting-row { display: flex; align-items: flex-start; gap: 14px; padding: 10px 0; border-bottom: 1px solid #3c3c3c; }
    .setting-row:last-of-type { border-bottom: none; }
    .setting-row .label { width: 150px; flex-shrink: 0; color: #9a9a9a; font-size: 12px; padding-top: 1px; }
    .setting-row .value { flex: 1; font-size: 13px; min-width: 0; }
    .error-text { color: #f14c4c; }
    a { color: #4a9eff; text-decoration: underline; cursor: pointer; }
    .folder-picker { display: flex; align-items: center; gap: 8px; }
    .folder-picker input {
      flex: 1; background: #3c3c3c; border: 1px solid #454545; color: #ddd; padding: 6px 8px;
      border-radius: 3px; font-size: 12.5px; font-family: ui-monospace, Consolas, monospace;
    }
    textarea#description-input {
      width: 100%; min-height: 70px; background: #3c3c3c; border: 1px solid #454545; color: #ddd;
      padding: 6px 8px; border-radius: 3px; font-size: 12.5px; font-family: inherit; resize: vertical; box-sizing: border-box;
    }
    button.btn.block { display: block; width: 100%; margin-top: 16px; text-align: center; }
  </style>`;

function render(data: ProjectSettingData): string {
  const n = nonce();
  const { project, projectUrl, folderPath } = data;

  const closeButton = `<button id="close-button" class="btn icon-close-btn" title="Close">✕</button>`;

  const folderRow = `
    <div class="setting-row">
      <div class="label">Local project folder</div>
      <div class="value">
        <div class="folder-picker">
          <input type="text" readonly value="${escapeHtml(folderPath ?? '')}" placeholder="No workspace open" />
          <button id="choose-folder-btn" class="btn">📁 Choose folder</button>
        </div>
        <div class="hint-text">This folder must contain the project's source code; the AI reads it to write tests and analyze bugs. Changing it reopens VS Code in that folder, like File → Open Folder.</div>
      </div>
    </div>`;

  if (!project) {
    return renderPopupPage(
      n,
      `${EXTRA_STYLE}
      <div class="screen-header">
        <div>
          <h3>📁 Project Setting</h3>
          <div class="subtitle">Backlog project connected to this workspace.</div>
        </div>
        <div class="header-actions">${closeButton}</div>
      </div>
      <div class="empty-state">
        No Backlog project is connected to this workspace.<br /><br />
        <button id="open-mcp-btn" class="btn primary">🔌 Open Integrations to connect</button>
      </div>`,
      `
      (function () {
        var vscode = acquireVsCodeApi();
        document.getElementById('open-mcp-btn').addEventListener('click', function () {
          vscode.postMessage({ command: 'openMcpSetting' });
        });
        document.getElementById('close-button').addEventListener('click', function () {
          vscode.postMessage({ command: 'cancel' });
        });
        document.querySelector('.overlay').addEventListener('click', function (e) {
          if (e.target.classList.contains('overlay')) vscode.postMessage({ command: 'cancel' });
        });
      })();`
    );
  }

  const body = `
    ${EXTRA_STYLE}
    <div class="screen-header">
      <div>
        <h3>📁 Project Setting</h3>
        <div class="subtitle">Backlog project connected to this workspace.</div>
      </div>
      <div class="header-actions">
        <button id="switch-project-btn" class="btn">🔁 Switch project</button>
        ${closeButton}
      </div>
    </div>

    <div class="setting-row">
      <div class="label">Project</div>
      <div class="value"><strong>${escapeHtml(project.projectName)}</strong> <span class="hint-text">(${escapeHtml(project.projectKey)})</span></div>
    </div>
    <div class="setting-row">
      <div class="label">Link Backlog</div>
      <div class="value">${projectUrl ? `<a href="#" id="open-project-link">${escapeHtml(projectUrl)} ↗</a>` : '—'}</div>
    </div>
    <div class="setting-row">
      <div class="label">Issues</div>
      <div class="value" id="task-count">Loading... <span class="hint-text">(GET /api/v2/issues/count)</span></div>
    </div>
    ${folderRow}
    <div class="setting-row">
      <div class="label">Description</div>
      <div class="value">
        <textarea id="description-input" placeholder="Short description of this project...">${escapeHtml(project.description ?? '')}</textarea>
      </div>
    </div>
    <button id="save-btn" class="btn primary block">Save</button>`;

  const script = `
    (function () {
      var vscode = acquireVsCodeApi();

      document.getElementById('close-button').addEventListener('click', function () {
        vscode.postMessage({ command: 'cancel' });
      });
      document.querySelector('.overlay').addEventListener('click', function (e) {
        if (e.target.classList.contains('overlay')) vscode.postMessage({ command: 'cancel' });
      });
      document.getElementById('switch-project-btn').addEventListener('click', function () {
        vscode.postMessage({ command: 'switchProject' });
      });
      document.getElementById('choose-folder-btn').addEventListener('click', function () {
        vscode.postMessage({ command: 'chooseFolder' });
      });
      var link = document.getElementById('open-project-link');
      if (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          vscode.postMessage({ command: 'openExternal', url: ${JSON.stringify(projectUrl ?? '')} });
        });
      }
      document.getElementById('save-btn').addEventListener('click', function () {
        var description = document.getElementById('description-input').value.trim();
        vscode.postMessage({ command: 'saveDescription', description: description });
      });

      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg.type !== 'taskCount') return;
        var el = document.getElementById('task-count');
        if (typeof msg.count === 'number') {
          el.innerHTML = msg.count + ' <span class="hint-text">(GET /api/v2/issues/count)</span>';
        } else {
          el.innerHTML = '<span class="error-text">Could not load' + (msg.error ? ' — ' + escapeText(msg.error) : '') + '</span>';
        }
      });

      function escapeText(s) {
        var d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
      }
    })();`;

  return renderPopupPage(n, body, script);
}
