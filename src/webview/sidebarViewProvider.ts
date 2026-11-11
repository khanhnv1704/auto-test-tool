import * as vscode from 'vscode';
import * as path from 'path';
import {
  functionDir,
  listFunctionIds,
  listScriptedTestCaseIds,
  readBacklogProject,
  readFunctionMeta,
  readRounds,
  readSchedules,
  readTestCases,
  RoundSummary
} from '../core/store';
import { DEFAULT_MODEL_ID, getModelLabel } from '../core/modelOptions';
import { Schedule } from '../types';
import { getSidebarHtml } from './sidebarHtml';

export interface StepInfo {
  /** Pipeline step (Import → Sync Test → Run Tests → Result); picks the action when the chip/step is
   * clicked. Import and Sync both open the Test Case view. */
  key: 'import' | 'sync' | 'run' | 'result';
  label: string;
  /** Chip color: idle (not started) / progress (in progress) / done (no failures) / warn (finished with failures). */
  tone: 'idle' | 'progress' | 'done' | 'warn';
}

export interface SidebarFunctionModel {
  id: string;
  screenUrl?: string;
  testCaseCount: number;
  rounds: RoundSummary[];
  step: StepInfo;
}

export interface SidebarModel {
  project?: { spaceKey: string; projectKey: string; projectName: string };
  functions: SidebarFunctionModel[];
  schedules: Schedule[];
  settings: { modelId: string; modelLabel: string; backlogConnected: boolean };
}

/**
 * Current pipeline step of a function, shown next to its case count so the next action is visible
 * without expanding the row. Derived purely from existing data:
 * - No test cases → "Import test cases".
 * - Some test cases lack a script (per `listScriptedTestCaseIds`) → "Sync Test".
 * - All scripted but never run → "Run Tests".
 * - Has rounds → "Result", plus the failure count of the latest round if any.
 */
function computeStep(testCaseCount: number, scriptedCount: number, rounds: RoundSummary[]): StepInfo {
  if (testCaseCount === 0) return { key: 'import', label: 'Import test cases', tone: 'idle' };
  if (scriptedCount < testCaseCount) return { key: 'sync', label: 'Sync Test', tone: 'progress' };
  if (rounds.length === 0) return { key: 'run', label: 'Run Tests', tone: 'progress' };
  const lastFailed = rounds[rounds.length - 1].failed;
  return lastFailed > 0
    ? { key: 'result', label: `Result · ${lastFailed} failed`, tone: 'warn' }
    : { key: 'result', label: 'Result', tone: 'done' };
}

function buildSidebarModel(aitestDir: string | undefined): SidebarModel {
  if (!aitestDir) {
    return {
      functions: [],
      schedules: [],
      settings: { modelId: DEFAULT_MODEL_ID, modelLabel: getModelLabel(DEFAULT_MODEL_ID), backlogConnected: false }
    };
  }

  const functions = listFunctionIds(aitestDir).map((id): SidebarFunctionModel => {
    const fnDir = functionDir(aitestDir, id);
    const testCaseCount = readTestCases(fnDir).length;
    const scriptedCount = listScriptedTestCaseIds(fnDir).size;
    const rounds = readRounds(fnDir);
    return {
      id,
      screenUrl: readFunctionMeta(fnDir).screenUrl,
      testCaseCount,
      rounds,
      step: computeStep(testCaseCount, scriptedCount, rounds)
    };
  });

  const modelId = vscode.workspace.getConfiguration('aitest').get<string>('generation.model', DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
  const backlogProject = readBacklogProject(aitestDir);

  return {
    project: backlogProject,
    functions,
    schedules: readSchedules(aitestDir),
    settings: { modelId, modelLabel: getModelLabel(modelId), backlogConnected: !!backlogProject }
  };
}

/** Commands the sidebar webview may run. Anything else sent from the webview is ignored. */
const ALLOWED_COMMANDS = new Set([
  'aitest.addFunction', 'aitest.editFunction', 'aitest.deleteFunction', 'aitest.renameFunction',
  'aitest.importTestCases', 'aitest.showFunctionTestCases', 'aitest.runTests', 'aitest.showReport', 'aitest.showSummaryReport',
  'aitest.deleteRound', 'aitest.addSchedule', 'aitest.editSchedule', 'aitest.deleteSchedule',
  'aitest.changeDefaultModel', 'aitest.openMcpSetting', 'aitest.showProjectSetting'
]);

type WebviewMessage = { type: 'ready' } | { type: 'command'; command: string; args?: unknown[] };

/**
 * AI Auto Test sidebar as a Webview View, so it can draw a colored stepper and status chips (a
 * TreeView cannot). All business logic stays in the `aitest.*` commands registered in extension.ts;
 * the webview only posts messages asking to run them.
 */
export class ActionsProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getSidebarHtml();
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message));
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
  }

  /** Push the full model to the webview. Call after any data change (function CRUD, sync, run, new round...). */
  refresh(): void {
    this.view?.webview.postMessage({ type: 'model', model: buildSidebarModel(this.getDir()) });
  }

  private handleMessage(message: WebviewMessage): void {
    if (message.type === 'ready') {
      this.refresh();
      return;
    }
    if (message.type === 'command' && ALLOWED_COMMANDS.has(message.command)) {
      void vscode.commands.executeCommand(message.command, ...(message.args ?? []));
    }
  }

  private getDir(): string | undefined {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return workspaceRoot ? path.join(workspaceRoot, '.aitest') : undefined;
  }
}
