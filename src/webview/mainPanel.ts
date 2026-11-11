import * as vscode from 'vscode';

type MessageHandler = (msg: any) => void;

/**
 * Single WebviewPanel shared by every view in the extension (Report, Test Cases, Run Tests, Bug Detail,
 * settings...). Each show() replaces the previous view in the same tab instead of opening a new one.
 *
 * `viewId` identifies the view currently displayed. Later updates (postMessage, HTML refresh, title,
 * close) go through the `*IfCurrent` helpers so a background task from an old view (e.g. a still-running
 * Generate Tests) cannot overwrite a view the user has since switched to.
 */
export class MainPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static currentViewId: string | undefined;
  private static messageHandler: MessageHandler | undefined;

  private static ensurePanel(): vscode.WebviewPanel {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('aitestView', 'AI Auto Test', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.currentViewId = undefined;
        this.messageHandler = undefined;
      });
      // Registered once per panel lifetime and dispatched to the current view's handler, so a message
      // never reaches more than one view.
      this.panel.webview.onDidReceiveMessage((msg) => this.messageHandler?.(msg));
    }
    return this.panel;
  }

  static show(viewId: string, title: string, html: string, onMessage?: MessageHandler): void {
    const panel = this.ensurePanel();
    this.currentViewId = viewId;
    this.messageHandler = onMessage;
    panel.title = title;
    panel.webview.html = html;
    panel.reveal(panel.viewColumn);
  }

  static isCurrent(viewId: string): boolean {
    return !!this.panel && this.currentViewId === viewId;
  }

  static setTitleIfCurrent(viewId: string, title: string): void {
    if (this.isCurrent(viewId) && this.panel) this.panel.title = title;
  }

  static postMessageIfCurrent(viewId: string, message: unknown): void {
    if (this.isCurrent(viewId) && this.panel) void this.panel.webview.postMessage(message);
  }

  /** Re-render the whole page (unlike `postMessageIfCurrent`, which patches it via webview script). */
  static updateHtmlIfCurrent(viewId: string, html: string): void {
    if (this.isCurrent(viewId) && this.panel) this.panel.webview.html = html;
  }

  /** Close the panel only if `viewId` is still the displayed view. Without `viewId`, close unconditionally
   * (used by popups that close themselves right after submit). */
  static closeIfCurrent(viewId?: string): void {
    if (viewId !== undefined && !this.isCurrent(viewId)) return;
    this.panel?.dispose();
  }
}
