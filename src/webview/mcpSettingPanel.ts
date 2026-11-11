import * as vscode from 'vscode';
import { escapeHtml, nonce, renderPopupPage } from './popupModal';
import { MainPanel } from './mainPanel';

const VIEW_ID = 'mcpSetting';

export interface McpSettingData {
  backlogConnected: boolean;
  backlogStatusText: string;
}

/**
 * "Settings → Integrations": the single place to connect/disconnect external integrations (currently
 * Backlog). Rendered as a list of rows so more integrations can be added as extra rows.
 */
export class McpSettingPanel {
  static show(data: McpSettingData): void {
    MainPanel.show(VIEW_ID, 'AI Auto Test — Integrations', render(data), (msg: { command?: string }) => {
      if (msg?.command === 'connectBacklog') {
        void vscode.commands.executeCommand('aitest.connectBacklogProject');
      } else if (msg?.command === 'disconnectBacklog') {
        void vscode.commands.executeCommand('aitest.disconnectBacklogProject');
      } else if (msg?.command === 'cancel') {
        MainPanel.closeIfCurrent(VIEW_ID);
      }
    });
  }

  /** Re-render after Backlog is connected/disconnected from anywhere. */
  static refreshIfOpen(data: McpSettingData): void {
    MainPanel.updateHtmlIfCurrent(VIEW_ID, render(data));
  }

  static isOpen(): boolean {
    return MainPanel.isCurrent(VIEW_ID);
  }
}

function render(data: McpSettingData): string {
  const n = nonce();
  const { backlogConnected, backlogStatusText } = data;

  const style = `
    <style>
      .mcp-row {
        display: flex; align-items: center; gap: 12px; padding: 14px 16px;
        border: 1px solid #3c3c3c; border-radius: 6px; margin-bottom: 10px; background: #262626;
      }
      .mcp-icon { font-size: 20px; width: 28px; text-align: center; flex-shrink: 0; }
      .mcp-body { flex: 1; min-width: 0; }
      .mcp-title { font-weight: 600; font-size: 13.5px; }
      .mcp-desc { color: #9a9a9a; font-size: 11.5px; margin-top: 2px; }
    </style>`;

  const body = `
    <h3>🔌 Integrations <button id="close-button" class="btn icon-close-btn" title="Close">✕</button></h3>
    <div class="subtitle">Connect AI Auto Test to external services. Currently supported: <strong>Backlog</strong>.</div>

    <div class="mcp-row">
      <span class="mcp-icon">🔗</span>
      <div class="mcp-body">
        <div class="mcp-title">Backlog</div>
        <div class="mcp-desc">${escapeHtml(backlogStatusText)}</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="backlog-toggle" ${backlogConnected ? 'checked' : ''} />
        <span class="switch-slider"></span>
      </label>
    </div>`;

  // The toggle never flips on click: it reverts immediately and sends connect/disconnect. The panel
  // updates only after the real result arrives (refreshIfOpen), so cancelling the connect form
  // doesn't leave the toggle in the wrong state.
  const script = `
    (function () {
      var vscode = acquireVsCodeApi();
      var connected = ${backlogConnected ? 'true' : 'false'};
      var toggle = document.getElementById('backlog-toggle');
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        toggle.checked = connected;
        vscode.postMessage({ command: connected ? 'disconnectBacklog' : 'connectBacklog' });
      });
      document.getElementById('close-button').addEventListener('click', function () {
        vscode.postMessage({ command: 'cancel' });
      });
      document.querySelector('.overlay').addEventListener('click', function (e) {
        if (e.target.classList.contains('overlay')) vscode.postMessage({ command: 'cancel' });
      });
    })();
  `;

  return renderPopupPage(n, style + body, script);
}
