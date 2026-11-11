import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildFunctionSpec, diffFunctionSpec } from './core/functionSpecLoader';
import { parseTestCaseMarkdown, diffTestCases, appendTestCasesToMarkdown, TableIssue } from './core/testCaseMarkdownLoader';
import { findDuplicateIds } from './core/testCaseColumns';
import { appendSuggestionsToWorkbook, parseTestCaseWorkbook, ParsedSheet } from './core/excelTestCaseLoader';
import { loadTestCasesFromSource, TestCaseSource } from './core/testCaseSource';
import { writeEvidenceSupport } from './core/evidenceSupport';
import { writeReporter } from './core/reporterSupport';
import { ensurePlaywrightConfig } from './core/playwrightConfigSupport';
import { readAuthTokenFromEnv, readBacklogConfigFromEnv } from './core/envTokenSupport';
import { callClaudeCli } from './core/claudeCliClient';
import { computeNextFireTime } from './core/scheduler';
import { buildMissingTestCasesPrompt, parseMissingTestCasesResponse } from './core/testCaseSuggestion';
import { buildBacklogDescription, buildBugAnalysisPrompt, parseBugAnalysisResponse } from './core/bugAnalysis';
import {
  BacklogClientConfig,
  BacklogProjectSummary,
  backlogBaseUrl,
  buildIssueUrl,
  buildProjectUrl,
  createIssue,
  getIssueCount,
  listIssueTypes,
  listPriorities,
  listProjects,
  pickBugIssueType,
  pickDefaultPriority,
  updateIssue,
  uploadAttachment
} from './core/backlogClient';
import {
  ConcurrencyOptions,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  FailedJob,
  JobProgress,
  JobSettledInfo,
  generateFunctionApiSuiteParallel,
  generateFunctionUiSuiteParallel,
  generateScriptsFromTestCasesParallel
} from './core/parallelGeneration';
import { ensureBracketedTestTitle, scriptFileNameForTestCase } from './core/testSuiteGenerator';
import { runTests, extractTestId, LiveTestRow, RunController } from './core/testRunner';
import { DEFAULT_SLOW_MO_MS } from './core/executionSpeed';
import {
  functionDir as resolveFunctionDir,
  generatedDir as resolveGeneratedDir,
  testCasesPath,
  testCaseHashesPath,
  listFunctionIds,
  listScriptedTestCaseIds,
  readTestCases,
  writeTestCases,
  createFunction,
  readFunctionMeta,
  computeBugOccurrence,
  writeFunctionMeta,
  nextRound,
  appendRound,
  deleteRound,
  updateRoundSummary,
  summarizeRound,
  mergeRoundResults,
  readRoundReport,
  readRounds,
  readSchedules,
  writeSchedules,
  readBlockedCases,
  setBlockedCase,
  clearBlockedCase,
  readBugAnalysis,
  writeBugAnalysis,
  readBacklogUploadedTask,
  writeBacklogUploadedTask,
  readBacklogProject,
  writeBacklogProject,
  clearBacklogProject
} from './core/store';
import { LiveRow, ReportPanel } from './webview/reportPanel';
import { TestCasesPanel } from './webview/testCasesPanel';
import { RunFormPanel, RunFormResult } from './webview/runFormPanel';
import { ScheduleFormPanel, ScheduleFormResult } from './webview/scheduleFormPanel';
import { SimpleFormPanel } from './webview/simpleFormPanel';
import { BugDetailPanel } from './webview/bugDetailPanel';
import { ActionsProvider } from './webview/sidebarViewProvider';
import { McpSettingData, McpSettingPanel } from './webview/mcpSettingPanel';
import { ProjectSettingData, ProjectSettingPanel } from './webview/projectSettingPanel';
import { DEFAULT_MODEL_ID, MODEL_OPTIONS, getModelLabel } from './core/modelOptions';
import { BacklogProjectConfig, Schedule, ScheduleType, SuggestedTestCase, TestCase, TestKind, TestSuite } from './types';

/** Headed runs are only watchable with one browser window at a time. */
const HEADED_DEFAULT_WORKERS = 1;

/** Functions with a run in progress. A schedule that fires while a manual run of the same function is
 * active is skipped (not queued) so two rounds never overwrite each other. */
const runningFunctionIds = new Set<string>();

/** Controller of the active run per function, used to relay Stop/Pause/Resume from the live dashboard
 * to the running Playwright process. Only one run per function at a time, so functionId is a sufficient key. */
const activeRunControllers = new Map<string, RunController>();

// setInterval is not aligned to wall-clock seconds, so a coarse poll adds up to one interval of random
// delay to a schedule set for e.g. 08:50:00. checkDueSchedules is cheap (one small JSON read), so poll every second.
const SCHEDULE_POLL_MS = 1_000;

export function activate(context: vscode.ExtensionContext): void {
  const actionsProvider = new ActionsProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aitest.actions', actionsProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('aitest.generateTests', () => generateTests(actionsProvider)),
    vscode.commands.registerCommand('aitest.importTestCases', () => importTestCasesCommand(actionsProvider)),
    vscode.commands.registerCommand('aitest.reloadTestCasesFromSource', (functionId?: string) =>
      reloadTestCasesFromSource(actionsProvider, functionId)
    ),
    vscode.commands.registerCommand('aitest.runTests', (functionId?: string) =>
      runFunctionTests(actionsProvider, functionId)
    ),
    vscode.commands.registerCommand('aitest.retestSelected', (functionId: string, round: number, ids: string[]) =>
      retestSelectedTestCases(actionsProvider, functionId, round, ids)
    ),
    vscode.commands.registerCommand('aitest.stopRun', (functionId: string) => stopRun(functionId)),
    vscode.commands.registerCommand('aitest.pauseRun', (functionId: string) => pauseRun(functionId)),
    vscode.commands.registerCommand('aitest.resumeRun', (functionId: string) => resumeRun(functionId)),
    vscode.commands.registerCommand('aitest.showReport', (functionId: string, round: number) =>
      ReportPanel.showRound(functionId, round)
    ),
    vscode.commands.registerCommand('aitest.showFunctionTestCases', (functionId: string) =>
      TestCasesPanel.show(functionId)
    ),
    vscode.commands.registerCommand('aitest.renameFunction', (item?: string | { functionId?: string }) =>
      renameFunction(actionsProvider, typeof item === 'string' ? item : item?.functionId)
    ),
    vscode.commands.registerCommand('aitest.manageSchedules', () => manageSchedules()),
    vscode.commands.registerCommand('aitest.suggestMissingTestCases', () => suggestMissingTestCases()),
    vscode.commands.registerCommand('aitest.changeDefaultModel', () => changeDefaultModel(actionsProvider)),
    vscode.commands.registerCommand('aitest.analyzeBug', (functionId: string, round: number, testId: string) =>
      analyzeBug(functionId, round, testId)
    ),

    // --- Project (Backlog) ---
    vscode.commands.registerCommand('aitest.connectBacklogProject', () => connectBacklogProject(context, actionsProvider)),
    vscode.commands.registerCommand('aitest.disconnectBacklogProject', () => disconnectBacklogProject(context, actionsProvider)),
    vscode.commands.registerCommand('aitest.openMcpSetting', () => openMcpSettingPanel()),
    vscode.commands.registerCommand('aitest.showProjectSetting', () => showProjectSettingPanel(context)),
    vscode.commands.registerCommand('aitest.switchBacklogProject', () => switchBacklogProject(context, actionsProvider)),
    vscode.commands.registerCommand('aitest.chooseProjectFolder', () => chooseProjectFolder()),
    vscode.commands.registerCommand('aitest.saveBacklogProjectDescription', (description: string) => saveBacklogProjectDescription(description)),

    // --- Functions CRUD ---
    vscode.commands.registerCommand('aitest.addFunction', () => addFunctionCommand(actionsProvider)),
    vscode.commands.registerCommand('aitest.editFunction', (item?: string | { functionId?: string }) =>
      editFunctionCommand(actionsProvider, typeof item === 'string' ? item : item?.functionId)
    ),
    vscode.commands.registerCommand('aitest.deleteFunction', (item?: string | { functionId?: string }) =>
      deleteFunctionCommand(actionsProvider, typeof item === 'string' ? item : item?.functionId)
    ),

    // --- Test schedules CRUD ---
    vscode.commands.registerCommand('aitest.addSchedule', (item?: string | { functionId?: string }) =>
      addScheduleCommand(actionsProvider, typeof item === 'string' ? item : item?.functionId)
    ),
    vscode.commands.registerCommand('aitest.editSchedule', (item?: string | { schedule?: Schedule }) =>
      editScheduleCommand(actionsProvider, typeof item === 'string' ? item : item?.schedule?.id)
    ),
    vscode.commands.registerCommand('aitest.deleteSchedule', (item?: string | { schedule?: Schedule }) =>
      deleteScheduleCommand(actionsProvider, typeof item === 'string' ? item : item?.schedule?.id)
    ),

    // --- Test results: summary report, bug detail, blocked cases ---
    vscode.commands.registerCommand('aitest.showSummaryReport', (functionId: string) =>
      ReportPanel.showSummary(functionId)
    ),
    vscode.commands.registerCommand('aitest.showBugDetail', (functionId: string, round: number, testId: string) =>
      BugDetailPanel.show(functionId, round, testId)
    ),
    vscode.commands.registerCommand(
      'aitest.toggleBlockedCase',
      (functionId: string, round: number, testId: string, block: boolean) =>
        toggleBlockedCase(functionId, round, testId, block)
    ),
    vscode.commands.registerCommand('aitest.uploadBugToBacklog', (functionId: string, round: number, testId: string) =>
      uploadBugToBacklog(context, functionId, round, testId)
    ),
    vscode.commands.registerCommand(
      'aitest.deleteRound',
      (item?: string | { functionId?: string; round?: number }, roundArg?: number, viewingRound?: number) =>
        deleteRoundCommand(
          actionsProvider,
          typeof item === 'string' ? item : item?.functionId,
          typeof item === 'string' ? roundArg : item?.round,
          viewingRound
        )
    ),

    // --- Test Case panel: import/sync/CRUD/suggest ---
    vscode.commands.registerCommand('aitest.importTestCasesFromFile', (functionId: string) =>
      importTestCasesFromFile(actionsProvider, functionId)
    ),
    vscode.commands.registerCommand('aitest.syncTestScripts', (functionId: string, formResult?: SyncFormResult) =>
      syncTestScripts(actionsProvider, functionId, formResult)
    ),
    vscode.commands.registerCommand('aitest.addTestCase', (functionId: string, testCase: TestCase) =>
      addTestCaseCommand(actionsProvider, functionId, testCase)
    ),
    vscode.commands.registerCommand('aitest.updateTestCase', (functionId: string, testCase: TestCase) =>
      updateTestCaseCommand(actionsProvider, functionId, testCase)
    ),
    vscode.commands.registerCommand('aitest.deleteTestCase', (functionId: string, testId: string) =>
      deleteTestCaseCommand(actionsProvider, functionId, testId)
    ),
    vscode.commands.registerCommand('aitest.syncSingleTestCase', (functionId: string, testId: string) =>
      syncSingleTestCase(actionsProvider, functionId, testId)
    ),
    vscode.commands.registerCommand('aitest.suggestMissingTestCasesForPanel', (functionId: string) =>
      suggestMissingTestCasesForPanel(functionId)
    ),
    vscode.commands.registerCommand('aitest.saveSuggestedTestCases', (functionId: string, testCases: SuggestedTestCase[]) =>
      saveSuggestedTestCases(actionsProvider, functionId, testCases)
    )
  );

  // Schedules only fire while VS Code is open. A single poller instead of one setTimeout per schedule
  // avoids the ~24.8-day setTimeout overflow and survives window reloads without recomputing delays.
  const pollHandle = setInterval(() => void checkDueSchedules(actionsProvider), SCHEDULE_POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(pollHandle) });
}

export function deactivate(): void {}

function aitestDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.aitest');
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Default AI model (`aitest.generation.model`), shared by every feature that calls Claude. */
function getDefaultModel(): string {
  return vscode.workspace.getConfiguration('aitest').get<string>('generation.model', DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
}

/** Generation options from settings; `concurrencyOverride` (chosen by the user at start) wins over the setting. */
function getGenerationOptions(workspaceRoot: string, concurrencyOverride?: number): ConcurrencyOptions {
  const config = vscode.workspace.getConfiguration('aitest');
  return {
    batchSize: config.get<number>('generation.batchSize', DEFAULT_BATCH_SIZE),
    concurrency: concurrencyOverride ?? config.get<number>('generation.concurrency', DEFAULT_CONCURRENCY),
    cwd: workspaceRoot,
    onProgress: handleJobProgress,
    model: getDefaultModel()
  };
}

/** Changes the default AI model from the sidebar settings. Saved at Workspace scope because each
 * app may need a different model. */
async function changeDefaultModel(actionsProvider: ActionsProvider): Promise<void> {
  const current = getDefaultModel();

  SimpleFormPanel.show(
    {
      panelKey: 'aitestDefaultModelForm',
      panelTitle: 'AI Auto Test — Default AI model',
      heading: 'Default AI model',
      subtitle: 'Used for: test case import (auto-sync), Sync Test, suggesting missing test cases and bug analysis.',
      fields: [
        {
          id: 'model',
          label: 'Model',
          type: 'select',
          value: current,
          options: MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label }))
        }
      ],
      submitLabel: 'Save'
    },
    (values) => {
      SimpleFormPanel.close('aitestDefaultModelForm');
      void vscode.workspace.getConfiguration('aitest').update('generation.model', values.model, vscode.ConfigurationTarget.Workspace).then(() => {
        actionsProvider.refresh();
        vscode.window.showInformationMessage(`AI Auto Test: default AI model set to ${getModelLabel(values.model)}.`);
      });
    }
  );
}

/** Asks how many generation jobs to run in parallel. Returns undefined if the user cancels. */
async function promptConcurrency(): Promise<number | undefined> {
  const defaultValue = vscode.workspace.getConfiguration('aitest').get<number>('generation.concurrency', DEFAULT_CONCURRENCY);
  const input = await vscode.window.showInputBox({
    title: 'Parallel generation jobs',
    prompt: 'Each job is a separate Claude call. More jobs finish faster but run more processes at once.',
    value: String(defaultValue),
    validateInput: (v) => (/^[1-9]\d*$/.test(v.trim()) ? undefined : 'Enter a positive integer')
  });
  return input === undefined ? undefined : parseInt(input, 10);
}

/** Per-action delay for Run Tests / Retest, from `aitest.execution.slowMoMs`. */
function getExecutionSlowMoMs(): number {
  return vscode.workspace.getConfiguration('aitest').get<number>('execution.slowMoMs', DEFAULT_SLOW_MO_MS);
}

/**
 * The dashboard shows one row per test case, but a job only yields its test cases when it finishes.
 * While a job is pending/running it shows a placeholder row, replaced by the job's test cases on 'done'.
 */
function handleJobProgress(p: JobProgress): void {
  if (p.status === 'done') {
    ReportPanel.removeGenerateRows([p.batchTag]);
    const rows: LiveRow[] = (p.testCases ?? []).map((tc) => ({
      id: tc.id,
      label: tc.name,
      status: 'done',
      extra: tc.category,
      automationStatus: tc.automationStatus
    }));
    ReportPanel.updateGenerateRows(rows);
    return;
  }

  if (p.status === 'error') {
    ReportPanel.updateGenerateRows([
      { id: p.batchTag, label: `Job ${p.batchTag} (${p.lane.toUpperCase()}) — generation failed`, status: 'error' }
    ]);
    return;
  }

  ReportPanel.updateGenerateRows([
    { id: p.batchTag, label: `Generating job ${p.batchTag} (${p.lane.toUpperCase()})...`, status: p.status }
  ]);
}

/**
 * Picks both requirement files in one dialog. Multi-select loses which file is which, so they are told
 * apart by content: "## Screen" marks the User Requirement, "## API"/"## Business Rules" the System Requirement.
 */
async function pickFunctionSpecFiles(): Promise<{ userContent: string; systemContent: string } | undefined> {
  const fileUris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    title: 'Select both files: User Requirement + System Requirement'
  });
  if (!fileUris || fileUris.length === 0) return undefined;

  const files = fileUris.map((uri) => ({ path: uri.fsPath, content: fs.readFileSync(uri.fsPath, 'utf-8') }));
  const userFiles = files.filter((f) => /^##\s*Screen/im.test(f.content));
  const systemFiles = files.filter((f) => /^##\s*(API|Business Rules)/im.test(f.content));

  if (userFiles.length !== 1 || systemFiles.length !== 1) {
    vscode.window.showErrorMessage(
      `AI Auto Test: select exactly one User Requirement file (with a "## Screen" section) and one System Requirement file (with an "## API"/"## Business Rules" section). Selected ${files.length} file(s): detected ${userFiles.length} User Requirement and ${systemFiles.length} System Requirement.`
    );
    return undefined;
  }

  return { userContent: userFiles[0].content, systemContent: systemFiles[0].content };
}

/**
 * Merges the User Requirement (screen) and System Requirement (API + business rules) into one
 * FunctionSpec and generates the API and UI suites in parallel. Changes are diffed per whole function,
 * not per field/endpoint, because cross-field rules would make a partial diff miss related cases.
 */
async function generateFromFunctionSpec(
  userRequirementContent: string,
  systemRequirementContent: string,
  aitestDirPath: string,
  opts: ConcurrencyOptions & { authHeader?: string }
): Promise<{ functionId: string; suite: TestSuite; failed: FailedJob[] } | null> {
  const spec = buildFunctionSpec(userRequirementContent, systemRequirementContent);
  const hashFile = path.join(aitestDirPath, 'cache', 'function-hashes.json');
  const previousHashes = readJson<Record<string, string>>(hashFile, {});
  const { changed, newHashes } = diffFunctionSpec(spec, previousHashes);

  if (changed.length === 0) {
    vscode.window.showInformationMessage(`AI Auto Test: function "${spec.functionId}" has no changes.`);
    return null;
  }

  const { authHeader, ...concurrencyOpts } = opts;

  // Failed jobs are reported in `failed` instead of throwing, so both lanes keep what they generated.
  const [apiSuite, uiSuite] = await Promise.all([
    generateFunctionApiSuiteParallel(spec, authHeader, concurrencyOpts),
    generateFunctionUiSuiteParallel(spec, concurrencyOpts)
  ]);
  const failed = [...apiSuite.failed, ...uiSuite.failed];

  // On any failure, keep the old hash on purpose so the next "Generate Tests" regenerates the whole function.
  if (failed.length === 0) {
    fs.writeFileSync(hashFile, JSON.stringify(newHashes, null, 2));
  }

  return {
    functionId: spec.functionId,
    suite: {
      testCases: [...apiSuite.testCases, ...uiSuite.testCases],
      scripts: [...apiSuite.scripts, ...uiSuite.scripts]
    },
    failed
  };
}

/**
 * Renames a function by renaming `.aitest/functions/<functionId>/`, which carries all of its state.
 * `schedules.json` lives outside that folder and must be updated too, or the next scheduled run would
 * target a function that no longer exists.
 */
async function renameFunction(actionsProvider: ActionsProvider, presetFunctionId?: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const dir = aitestDir(workspaceRoot);
  const functionIds = listFunctionIds(dir);
  if (functionIds.length === 0) {
    vscode.window.showWarningMessage('AI Auto Test: there are no functions to rename.');
    return;
  }

  const functionId = presetFunctionId ?? (await vscode.window.showQuickPick(functionIds, { placeHolder: 'Pick the function to rename' }));
  if (!functionId) return;

  SimpleFormPanel.show(
    {
      panelKey: 'aitestRenameFunctionForm',
      panelTitle: 'AI Auto Test — Rename function',
      heading: `Rename function "${functionId}"`,
      fields: [
        {
          id: 'newName',
          label: 'New name',
          type: 'text',
          value: functionId,
          required: true,
          forbiddenValues: functionIds.filter((id) => id !== functionId),
          forbiddenMessage: 'A function with this name already exists'
        }
      ],
      submitLabel: 'Rename'
    },
    (values) => {
      SimpleFormPanel.close('aitestRenameFunctionForm');
      const trimmedNewName = values.newName;
      if (!trimmedNewName || trimmedNewName === functionId) return;

      const oldDir = resolveFunctionDir(dir, functionId);
      const newDir = resolveFunctionDir(dir, trimmedNewName);

      try {
        fs.renameSync(oldDir, newDir);

        const schedules = readSchedules(dir);
        let scheduleChanged = false;
        const updatedSchedules = schedules.map((s) => {
          if (s.functionId !== functionId) return s;
          scheduleChanged = true;
          return { ...s, functionId: trimmedNewName };
        });
        if (scheduleChanged) writeSchedules(dir, updatedSchedules);

        actionsProvider.refresh();
        vscode.window.showInformationMessage(`AI Auto Test: renamed function "${functionId}" to "${trimmedNewName}".`);
      } catch (err) {
        vscode.window.showErrorMessage(`AI Auto Test: rename failed — ${(err as Error).message}`);
      }
    }
  );
}

function withProgressGenerate<T>(task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'AI Auto Test: generating tests (parallel jobs)...' },
    task
  );
}

async function generateTests(actionsProvider: ActionsProvider): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('AI Auto Test: open a workspace first.');
    return;
  }

  const picked = await pickFunctionSpecFiles();
  if (!picked) return;

  // Prefill the real token from the app's .env files; an empty field makes the LLM invent a fake token.
  const detectedToken = readAuthTokenFromEnv(workspaceRoot);
  const authHeader = await vscode.window.showInputBox({
    prompt: 'Auth header the scripts send to the API (leave empty if the API needs no auth)',
    placeHolder: 'Bearer demo-secret-token',
    value: detectedToken ? `Bearer ${detectedToken}` : undefined
  });

  const concurrency = await promptConcurrency();
  if (concurrency === undefined) return;

  const dir = aitestDir(workspaceRoot);
  const genOpts = getGenerationOptions(workspaceRoot, concurrency);

  try {
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    // Refresh the evidence helper and live-progress reporter that generated scripts import.
    writeEvidenceSupport(path.join(dir, 'generated'));
    writeReporter(path.join(dir, 'generated'));
    // Scaffold playwright.config.ts (with the "api"/"ui" projects) if the workspace has none.
    ensurePlaywrightConfig(workspaceRoot);

    // Job status updates arrive through genOpts.onProgress (handleJobProgress).
    ReportPanel.showGenerateDashboard([]);

    const generated = await withProgressGenerate(() =>
      generateFromFunctionSpec(picked.userContent, picked.systemContent, dir, {
        ...genOpts,
        authHeader: authHeader || undefined
      })
    );
    if (!generated) {
      ReportPanel.finishGenerateDashboard('Nothing changed, nothing regenerated.');
      return;
    }

    // The id comes from the "# Function:" heading (or a fallback); let the user fix it or merge into
    // an existing function before writing to disk.
    const confirmedFunctionId = await vscode.window.showInputBox({
      title: 'Function ID',
      prompt: 'Confirm or edit the functionId for this generation',
      value: generated.functionId,
      validateInput: (v) => (v.trim() ? undefined : 'functionId cannot be empty')
    });
    if (!confirmedFunctionId) {
      ReportPanel.finishGenerateDashboard('Cancelled: no functionId entered.');
      return;
    }

    const { suite } = generated;
    const functionId = confirmedFunctionId.trim();
    const fnDir = resolveFunctionDir(dir, functionId);
    const genDir = resolveGeneratedDir(fnDir);
    fs.mkdirSync(genDir, { recursive: true });
    writeEvidenceSupport(genDir);
    writeReporter(genDir);

    // Write whatever was generated, even if some jobs failed (the hash was not updated in that case).
    for (const script of suite.scripts) {
      fs.writeFileSync(path.join(genDir, script.fileName), script.content);
    }
    fs.writeFileSync(testCasesPath(fnDir), JSON.stringify(suite.testCases, null, 2));
    actionsProvider.refresh();
    TestCasesPanel.refreshIfOpen(functionId);

    if (generated.failed.length === 0) {
      ReportPanel.finishGenerateDashboard(
        `Generated ${suite.testCases.length} test cases for function "${functionId}".`
      );
      vscode.window.showInformationMessage(
        `AI Auto Test: generated ${suite.testCases.length} test cases and ${suite.scripts.length} scripts for function "${functionId}".`
      );
    } else {
      const message = `Generated ${suite.testCases.length} test cases for function "${functionId}"; ${generated.failed.length} job(s) failed (${generated.failed.map((f) => f.batchTag).join(', ')}). Run "Generate Tests" again on the same requirement docs to regenerate the whole function, including the failed part.`;
      ReportPanel.finishGenerateDashboard(message);
      vscode.window.showWarningMessage(`AI Auto Test: ${message}`);
    }
  } catch (err) {
    ReportPanel.finishGenerateDashboard(`Test generation failed — ${(err as Error).message}`);
    vscode.window.showErrorMessage(`AI Auto Test: ${(err as Error).message}`);
  }
}

/** Shows the generate dashboard in its finished state with automated/manual counts. */
function showFinishedGenerateStats(testCases: TestCase[], message: string): void {
  const rows: LiveRow[] = testCases.map((tc) => ({
    id: tc.id,
    label: tc.name,
    status: 'done',
    automationStatus: tc.automationStatus
  }));
  ReportPanel.showGenerateDashboard(rows);
  const manual = testCases.filter((tc) => tc.automationStatus === 'manual').length;
  const automatable = testCases.length - manual;
  ReportPanel.finishGenerateDashboard(
    `${message} — ${testCases.length} test cases total (🤖 ${automatable} automated, 🧍 ${manual} manual).`
  );
}

/** One function to create or update from an imported file. */
interface ImportGroup {
  functionId: string;
  source: TestCaseSource;
  testCases: TestCase[];
}

function describeIssues(issues: TableIssue[]): string {
  return `AI Auto Test: nothing was imported. ${issues.map((i) => `${i.where}: ${i.message}`).join('; ')}.`;
}

/**
 * Reads a test case file (.md, .xlsx, .xlsm) into one or more import groups.
 * Markdown: one group, function id from the "# <FunctionId> - Test Cases" heading.
 * Excel: the user picks the sheets, then (when several are picked) whether each sheet is its own
 * function or all of them merge into one. `fixedFunctionId` (import from the Test Case panel) always
 * merges into that function. Returns undefined when the user cancels or the file cannot be used.
 */
async function readTestCaseFileGroups(filePath: string, fixedFunctionId?: string): Promise<ImportGroup[] | undefined> {
  let groups: ImportGroup[];

  if (path.extname(filePath).toLowerCase() === '.md') {
    const parsed = parseTestCaseMarkdown(fs.readFileSync(filePath, 'utf-8'));
    if (parsed.issues.length > 0) {
      vscode.window.showErrorMessage(describeIssues(parsed.issues));
      return undefined;
    }
    groups = [{ functionId: fixedFunctionId ?? parsed.functionId, source: { path: filePath }, testCases: parsed.testCases }];
  } else {
    let sheets: ParsedSheet[];
    try {
      sheets = await parseTestCaseWorkbook(filePath);
    } catch (err) {
      vscode.window.showErrorMessage(`AI Auto Test: ${(err as Error).message}`);
      return undefined;
    }
    if (!sheets.some((s) => s.testCases.length > 0)) {
      const reasons = sheets.map((s) => `${s.sheetName}: ${s.issue ?? s.skipped ?? 'no test cases'}`).join('; ');
      vscode.window.showErrorMessage(`AI Auto Test: no sheet contains readable test cases. ${reasons}`);
      return undefined;
    }

    // Sheets that cannot be read stay in the list with the reason, so nothing is skipped silently
    const picked = await vscode.window.showQuickPick(
      sheets.map((s) => ({
        label: s.sheetName,
        description: s.testCases.length > 0 ? `${s.testCases.length} test cases` : `skipped: ${s.issue ?? s.skipped}`,
        picked: s.testCases.length > 0,
        sheet: s
      })),
      { canPickMany: true, title: `${path.basename(filePath)}: pick the sheets that contain test cases` }
    );
    const chosen = (picked ?? []).map((p) => p.sheet).filter((s) => s.testCases.length > 0);
    if (chosen.length === 0) return undefined;

    let merge = fixedFunctionId !== undefined;
    if (!merge && chosen.length > 1) {
      const mode = await vscode.window.showQuickPick(
        [
          { label: 'One function per sheet', merge: false },
          { label: 'Merge the sheets into one function', description: 'e.g. a UI sheet and an API sheet for the same screen', merge: true }
        ],
        { title: 'Which function do the selected sheets belong to?' }
      );
      if (!mode) return undefined;
      merge = mode.merge;
    }

    if (merge) {
      const functionId = fixedFunctionId ?? path.basename(filePath, path.extname(filePath));
      groups = [{
        functionId,
        source: { path: filePath, sheets: chosen.map((s) => s.sheetName) },
        testCases: chosen.flatMap((s) => s.testCases)
      }];
    } else {
      groups = chosen.map((s) => ({ functionId: s.sheetName, source: { path: filePath, sheets: [s.sheetName] }, testCases: s.testCases }));
    }
  }

  for (const group of groups) {
    if (group.testCases.length === 0) {
      vscode.window.showErrorMessage(`AI Auto Test: no test cases found for "${group.functionId}". Check the table header.`);
      return undefined;
    }
    const duplicates = findDuplicateIds(group.testCases);
    if (duplicates.length > 0) {
      vscode.window.showErrorMessage(`AI Auto Test: function "${group.functionId}" has duplicate IDs: ${duplicates.join(', ')}. Fix the file and import again.`);
      return undefined;
    }
  }
  return groups;
}

/** Command Palette / sidebar "Import test cases": creates or updates one function per import group. */
async function importTestCasesCommand(actionsProvider: ActionsProvider): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('AI Auto Test: open a workspace first.');
    return;
  }
  const [uri] = (await vscode.window.showOpenDialog({
    canSelectMany: false,
    title: 'Pick a test case file',
    filters: { 'Test cases': ['md', 'xlsx', 'xlsm'] }
  })) ?? [];
  if (!uri) return;

  const groups = await readTestCaseFileGroups(uri.fsPath);
  if (!groups) return;

  for (const group of groups) {
    await applyImport(actionsProvider, workspaceRoot, group.functionId, group.testCases, group.source, group === groups[0]);
  }
}

/**
 * Persists one settled job of the "scripts from existing test cases" flow right away (scripts,
 * testcases.json, hashes), so a failing job never discards results of jobs that already finished.
 *
 * On failure, marks the job's ids with `lastScriptGenError` and keeps their old hashes on purpose: the
 * next Sync Test sees them as changed and retries them. Existing scripts on disk are left untouched.
 */
function applyTestCaseJobResult(
  fnDir: string,
  genDir: string,
  hashFile: string,
  newHashesById: Record<string, string>,
  info: JobSettledInfo
): void {
  const current = readTestCases(fnDir);

  if (info.outcome.ok) {
    // File names are derived from the id, so map each script back to its id and force the "[<id>] "
    // test title prefix regardless of whether the model followed the prompt format.
    const idByFileName = new Map(info.outcome.testCases.map((tc) => [scriptFileNameForTestCase(tc.id, tc.kind), tc.id]));
    for (const script of info.outcome.scripts) {
      const testCaseId = idByFileName.get(script.fileName);
      const content = testCaseId ? ensureBracketedTestTitle(script.content, testCaseId) : script.content;
      fs.writeFileSync(path.join(genDir, script.fileName), content);
    }

    // Only take the automation fields from the LLM. The model sometimes rewrites QA-authored fields
    // (e.g. drops the "1. " step numbers); storing those would change the hash and make the next sync
    // regenerate every case.
    const freshById = new Map(info.outcome.testCases.map((tc) => [tc.id, tc]));
    writeTestCases(fnDir, current.map((tc) => {
      const fresh = freshById.get(tc.id);
      if (!fresh) return tc;
      const { lastScriptGenError: _cleared, ...rest } = tc;
      return { ...rest, automationStatus: fresh.automationStatus, automationNote: fresh.automationNote };
    }));

    const hashes = readJson<Record<string, string>>(hashFile, {});
    for (const tc of info.outcome.testCases) {
      if (newHashesById[tc.id]) hashes[tc.id] = newHashesById[tc.id];
    }
    fs.writeFileSync(hashFile, JSON.stringify(hashes, null, 2));
  } else if (info.testCaseIds) {
    const failedIds = new Set(info.testCaseIds);
    const error = info.outcome.error;
    writeTestCases(fnDir, current.map((tc) => (failedIds.has(tc.id) ? { ...tc, lastScriptGenError: error } : tc)));
  }
}

/** Summary message after generating scripts from existing test cases; `verb` is e.g. "Synced". */
function buildTestCaseGenerateMessage(verb: string, functionId: string, attempted: number, failedCount: number, removedCount: number): string {
  const removedPart = removedCount > 0 ? `, ${removedCount} removed` : '';
  if (failedCount === 0) {
    return `${verb} function "${functionId}" (${attempted} new/changed test cases${removedPart})`;
  }
  const okCount = attempted - failedCount;
  return (
    `Function "${functionId}": scripts generated for ${okCount}/${attempted} test cases, ${failedCount} failed${removedPart}` +
    ` — see the "Script status" column or run Sync Test to retry the failed cases.`
  );
}

/**
 * When a test case keeps its id but changes `kind` (e.g. ui -> api), the script named after the old kind
 * would still run with the same "[id]" and overwrite the new script's bug report/evidence. Move it to
 * _stale/ (like removed ids) instead of deleting it, so a mistaken kind change can be recovered.
 */
function moveStaleKindScript(genDir: string, id: string, oldKind: TestKind, newKind: TestKind): void {
  if (oldKind === newKind) return;
  const staleSource = path.join(genDir, scriptFileNameForTestCase(id, oldKind));
  if (!fs.existsSync(staleSource)) return;
  const staleDir = path.join(genDir, '_stale');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.renameSync(staleSource, path.join(staleDir, path.basename(staleSource)));
}

/** Command Palette entry for "Suggest missing test cases": opens the Test Case panel of the chosen
 * function and runs the same suggestion flow as the panel button. */
async function suggestMissingTestCases(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const functionIds = listFunctionIds(aitestDir(workspaceRoot));
  if (functionIds.length === 0) {
    vscode.window.showWarningMessage('AI Auto Test: there are no functions yet.');
    return;
  }
  const functionId = await vscode.window.showQuickPick(functionIds, { placeHolder: 'Pick the function to review' });
  if (!functionId) return;
  await vscode.commands.executeCommand('aitest.showFunctionTestCases', functionId);
  await suggestMissingTestCasesForPanel(functionId);
}

/**
 * Bug analysis from the Bug Detail panel. Cached by the existence of `<id>.analysis.json`; otherwise
 * asks the AI for structured JSON (root cause, fix approach, action items, estimate) and stores it.
 */
async function analyzeBug(functionId: string, round: number, testId: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const dir = aitestDir(workspaceRoot);
  const fnDir = resolveFunctionDir(dir, functionId);

  if (readBugAnalysis(fnDir, round, testId)) {
    BugDetailPanel.refreshIfOpen(functionId, round, testId);
    return;
  }

  const report = readRoundReport(fnDir, round);
  const test = report?.tests.find((t) => extractTestId(t.name) === testId);
  if (!test) {
    vscode.window.showErrorMessage(`AI Auto Test: no result found for "${testId}" in round ${round}.`);
    return;
  }

  try {
    const testCase = readTestCases(fnDir).find((tc) => tc.id === testId);
    const raw = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `AI Auto Test: analyzing bug "${testId}"...` },
      () =>
        callClaudeCli(
          buildBugAnalysisPrompt({ testName: test.name, errorMessage: test.errorMessage ?? '', testCase }),
          workspaceRoot,
          getDefaultModel()
        )
    );
    const analysis = parseBugAnalysisResponse(raw);
    writeBugAnalysis(fnDir, round, testId, analysis);
    BugDetailPanel.refreshIfOpen(functionId, round, testId);
  } catch (err) {
    vscode.window.showErrorMessage(`AI Auto Test: bug analysis failed — ${(err as Error).message}`);
  }
}

/**
 * Pushes only changed rows to the live dashboard. Rows are compared by a signature, not just status,
 * because a running test's current step changes while its status stays the same.
 */
function buildExecuteProgressHandler(functionId: string, round: number): (rows: LiveTestRow[]) => void {
  const lastSignature = new Map<string, string>();
  return (rows: LiveTestRow[]) => {
    const changed: LiveRow[] = [];
    for (const row of rows) {
      const signature = `${row.status}|${row.currentStep ?? ''}|${row.steps?.length ?? 0}`;
      if (lastSignature.get(row.id) !== signature) {
        lastSignature.set(row.id, signature);
        changed.push({
          id: row.id,
          label: row.title,
          status: row.status,
          durationMs: row.durationMs,
          bugReportPath: row.bugReportPath,
          currentStep: row.currentStep,
          steps: row.steps
        });
      }
    }
    ReportPanel.updateExecuteRows(functionId, round, changed);
  };
}

function describeSchedule(schedule: Schedule): string {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  switch (schedule.type) {
    case 'once':
      return `once at ${schedule.time} on ${schedule.date}`;
    case 'daily':
      return `daily at ${schedule.time}`;
    case 'weekly':
      return `weekly on ${dayNames[schedule.dayOfWeek ?? 0]} at ${schedule.time}`;
    case 'monthly':
      return `monthly on day ${schedule.dayOfMonth} at ${schedule.time}`;
  }
}

/** Builds a `Schedule` from the schedule form, computing `nextFireAt`. Pass `existingId` when editing
 * so the existing entry is replaced rather than duplicated. */
function buildScheduleFromScheduleForm(result: ScheduleFormResult, existingId?: string): Schedule | undefined {
  const base: Schedule = {
    id: existingId ?? `${result.functionId}-${result.type}-${Date.now()}`,
    functionId: result.functionId,
    type: result.type,
    time: result.time,
    nextFireAt: ''
  };
  if (result.type === 'once') base.date = result.date;
  if (result.type === 'weekly') base.dayOfWeek = result.dayOfWeek;
  if (result.type === 'monthly') base.dayOfMonth = result.dayOfMonth;

  const nextFireTime = computeNextFireTime(base, new Date());
  if (!nextFireTime) return undefined;
  base.nextFireAt = nextFireTime.toISOString();
  return base;
}

/** Lists the schedules of all functions and deletes the one the user picks. */
async function manageSchedules(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const dir = aitestDir(workspaceRoot);
  const schedules = readSchedules(dir);
  if (schedules.length === 0) {
    vscode.window.showInformationMessage('AI Auto Test: there are no test schedules yet.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    schedules.map((s) => ({ label: `${s.functionId} — ${describeSchedule(s)}`, schedule: s })),
    { title: 'Pick a schedule to delete', placeHolder: 'Press Esc to keep all schedules' }
  );
  if (!picked) return;

  writeSchedules(
    dir,
    schedules.filter((s) => s.id !== picked.schedule.id)
  );
  vscode.window.showInformationMessage(`AI Auto Test: deleted schedule "${picked.label}".`);
}

/**
 * Runs every schedule whose `nextFireAt` has passed (skipping functions that are already running), then
 * re-arms it. 'once' schedules are removed after firing.
 */
async function checkDueSchedules(actionsProvider: ActionsProvider): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const dir = aitestDir(workspaceRoot);
  const schedules = readSchedules(dir);
  if (schedules.length === 0) return;

  const now = new Date();
  const due = schedules.filter((s) => new Date(s.nextFireAt).getTime() <= now.getTime());
  if (due.length === 0) return;

  const remaining = schedules.filter((s) => !due.includes(s));
  const rearmed: Schedule[] = [];

  for (const schedule of due) {
    if (runningFunctionIds.has(schedule.functionId)) {
      // Another run of this function is active: skip (not queue) so two rounds never overwrite each other.
      rearmed.push(schedule);
      continue;
    }

    await runFunctionTests(actionsProvider, schedule.functionId, true);

    if (schedule.type === 'once') continue; // fired once: drop it.
    const next = computeNextFireTime(schedule, now);
    if (next) rearmed.push({ ...schedule, nextFireAt: next.toISOString() });
  }

  writeSchedules(dir, [...remaining, ...rearmed]);
  actionsProvider.refresh();
}

/**
 * Runs all UI and API cases of one function in a new round (rounds are numbered per function).
 * `isScheduledRun` (from the schedule poller) skips the run form and runs immediately.
 */
async function runFunctionTests(
  actionsProvider: ActionsProvider,
  presetFunctionId?: string,
  isScheduledRun = false
): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const dir = aitestDir(workspaceRoot);
  const functionIds = listFunctionIds(dir);

  // No preset id: pick from known functions, or type one in (e.g. a function generated elsewhere).
  let functionId: string | undefined = presetFunctionId;
  if (!functionId) {
    if (functionIds.length === 0) {
      functionId = await vscode.window.showInputBox({
        title: 'Run tests',
        prompt: 'No functions generated yet. Enter the functionId to run',
        placeHolder: 'e.g. CustomerSignup',
        validateInput: (v) => (v.trim() ? undefined : 'functionId cannot be empty')
      });
    } else {
      const manualEntry = '✎ Enter a functionId manually...';
      const picked = await vscode.window.showQuickPick([manualEntry, ...functionIds], {
        placeHolder: 'Pick the function to test'
      });
      if (!picked) return;
      functionId =
        picked === manualEntry
          ? await vscode.window.showInputBox({
              title: 'Run tests',
              prompt: 'Enter the functionId to run',
              validateInput: (v) => (v.trim() ? undefined : 'functionId cannot be empty')
            })
          : picked;
    }
  }
  if (!functionId) return;
  functionId = functionId.trim();

  const configuredWorkers = vscode.workspace.getConfiguration('aitest').get<number>('execution.workers', 0);
  const defaultWorkers = configuredWorkers > 0 ? configuredWorkers : HEADED_DEFAULT_WORKERS;

  if (isScheduledRun) {
    await executeFunctionTests(actionsProvider, workspaceRoot, functionId, defaultWorkers);
    return;
  }

  // Prefill base URLs from the last Sync Test; the user only edits them to target another environment.
  const fnDir = resolveFunctionDir(dir, functionId);
  const runDefaults = resolveRunBaseUrls(fnDir);

  RunFormPanel.show(
    { functionId, defaultWorkers, defaultWebBaseUrl: runDefaults.web, defaultApiBaseUrl: runDefaults.api },
    (result) => {
      RunFormPanel.close();

      // Remember the chosen worker count for the next time the form opens.
      void vscode.workspace.getConfiguration('aitest').update('execution.workers', result.workers, vscode.ConfigurationTarget.Workspace);

      if (result.mode === 'now') {
        void executeFunctionTests(
          actionsProvider,
          workspaceRoot,
          functionId!,
          result.workers,
          { web: result.webBaseUrl, api: result.apiBaseUrl },
          result.headed
        );
        return;
      }

      const schedule = buildScheduleFromRunForm(functionId!, result);
      if (!schedule) {
        vscode.window.showErrorMessage('AI Auto Test: could not compute the next run time. Check the selected date/time.');
        return;
      }
      writeSchedules(dir, [...readSchedules(dir), schedule]);
      actionsProvider.refresh();
      vscode.window.showInformationMessage(`AI Auto Test: scheduled tests for "${functionId}" — ${describeSchedule(schedule)}.`);
    }
  );
}

/** Base URLs for a run: the run form's override, else the values saved by the last Sync Test.
 * Generated scripts use relative paths, so a run can target another environment without re-syncing. */
function resolveRunBaseUrls(fnDir: string, override?: { web?: string; api?: string }): { web?: string; api?: string } {
  const meta = readFunctionMeta(fnDir);
  const defaultWeb = (() => {
    try {
      return meta.screenUrl ? new URL(meta.screenUrl).origin : undefined;
    } catch {
      return undefined;
    }
  })();
  return { web: override?.web || defaultWeb, api: override?.api || meta.apiBaseUrl };
}

/** Builds a `Schedule` from the run form when its mode is not "now". */
function buildScheduleFromRunForm(functionId: string, result: RunFormResult): Schedule | undefined {
  return buildScheduleFromScheduleForm({
    functionId,
    type: result.mode as ScheduleType,
    time: result.time,
    date: result.date,
    dayOfWeek: result.dayOfWeek,
    dayOfMonth: result.dayOfMonth
  });
}

/** Stops the active round for good (unlike pause). A no-op if the round already ended. */
function stopRun(functionId: string): void {
  activeRunControllers.get(functionId)?.stop();
}

/** Freezes Playwright in place (SIGSTOP on the process group); the browser stays open. POSIX only. */
function pauseRun(functionId: string): void {
  activeRunControllers.get(functionId)?.pause();
}

/** Continues a paused run (SIGCONT) from where it stopped. */
function resumeRun(functionId: string): void {
  activeRunControllers.get(functionId)?.resume();
}

/** Runs a new round now; used by the run form and by scheduled runs. */
async function executeFunctionTests(
  actionsProvider: ActionsProvider,
  workspaceRoot: string,
  functionId: string,
  workers: number,
  baseUrlOverride?: { web?: string; api?: string },
  headed = true
): Promise<void> {
  if (runningFunctionIds.has(functionId)) {
    vscode.window.showWarningMessage(`AI Auto Test: "${functionId}" already has a test run in progress; skipping this one.`);
    return;
  }
  runningFunctionIds.add(functionId);

  try {
    const dir = aitestDir(workspaceRoot);
    const fnDir = resolveFunctionDir(dir, functionId);
    const genDir = resolveGeneratedDir(fnDir);
    if (!fs.existsSync(genDir)) {
      vscode.window.showWarningMessage(`AI Auto Test: function "${functionId}" has no generated tests yet.`);
      return;
    }

    // Older workspaces may lack playwright.config.ts; without its "api"/"ui" projects Playwright fails.
    ensurePlaywrightConfig(workspaceRoot);

    const slowMoMs = getExecutionSlowMoMs();
    const round = nextRound(fnDir);
    const testCases = readTestCases(fnDir);
    const baseUrls = resolveRunBaseUrls(fnDir, baseUrlOverride);

    // Seed the dashboard with all known test cases as pending; the live reporter updates them as they run.
    const initialRows: LiveRow[] = testCases.map((tc) => ({ id: tc.id, label: tc.name, status: 'pending' }));
    ReportPanel.showExecuteDashboard(functionId, round, initialRows, slowMoMs);

    const onProgress = buildExecuteProgressHandler(functionId, round);

    const startedAt = new Date().toISOString();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `AI Auto Test: running tests for "${functionId}" (round ${round})...`
        },
        async () => {
          const result = await runTests(
            fnDir,
            round,
            [genDir],
            workspaceRoot,
            workers,
            onProgress,
            { headed, slowMoMs },
            undefined,
            baseUrls,
            (controller) => activeRunControllers.set(functionId, controller)
          );
          const endedAt = new Date().toISOString();
          // Even if Playwright crashed or was stopped, `result` holds what was salvaged from
          // live-progress.json; cases that never ran count as untested.
          appendRound(fnDir, summarizeRound(round, startedAt, endedAt, testCases.length, result));
          actionsProvider.refresh();
          TestCasesPanel.refreshIfOpen(functionId);
          ReportPanel.showRound(functionId, round);

          if (result.stoppedByUser) {
            vscode.window.showInformationMessage(
              `AI Auto Test: "${functionId}" round ${round} — stopped on request; saved ${result.total}/${testCases.length} finished results. Select the remaining test cases in the report and click "Retest" to continue.`
            );
          } else if (result.crashed) {
            vscode.window.showWarningMessage(
              `AI Auto Test: "${functionId}" round ${round} — Playwright crashed mid-run; saved ${result.total}/${testCases.length} finished results. Select the remaining test cases in the report and click "Retest" to continue.`
            );
          }
        }
      );
    } catch (err) {
      vscode.window.showErrorMessage(`AI Auto Test: ${(err as Error).message}`);
    }
  } finally {
    runningFunctionIds.delete(functionId);
    activeRunControllers.delete(functionId);
  }
}

/**
 * Retests the test cases selected in a round's report. Results are merged into that same round
 * instead of starting a new one, which would show every unselected case as untested.
 */
async function retestSelectedTestCases(
  actionsProvider: ActionsProvider,
  functionId: string,
  round: number,
  ids: string[]
): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const dir = aitestDir(workspaceRoot);
  const fnDir = resolveFunctionDir(dir, functionId);
  const genDir = resolveGeneratedDir(fnDir);
  if (!fs.existsSync(genDir)) {
    vscode.window.showWarningMessage(`AI Auto Test: function "${functionId}" has no generated tests yet.`);
    return;
  }

  ensurePlaywrightConfig(workspaceRoot);

  const slowMoMs = getExecutionSlowMoMs();

  const configuredWorkers = vscode.workspace.getConfiguration('aitest').get<number>('execution.workers', 0);
  const workers = configuredWorkers > 0 ? configuredWorkers : HEADED_DEFAULT_WORKERS;

  const testCases = readTestCases(fnDir);
  const selectedTestCases = testCases.filter((tc) => ids.includes(tc.id));
  const baseUrls = resolveRunBaseUrls(fnDir);

  // Same (functionId, round) key: the open report tab turns into the live dashboard, then back when done.
  const seedRows: LiveRow[] = selectedTestCases.map((tc) => ({ id: tc.id, label: tc.name, status: 'pending' }));
  ReportPanel.showExecuteDashboard(functionId, round, seedRows, slowMoMs);

  const onProgress = buildExecuteProgressHandler(functionId, round);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AI Auto Test: retesting ${ids.length} test cases of "${functionId}" (round ${round})...`
      },
      async () => {
        const startedAt = new Date().toISOString();
        const result = await runTests(
          fnDir,
          round,
          [genDir],
          workspaceRoot,
          workers,
          onProgress,
          { headed: true, slowMoMs },
          ids,
          baseUrls,
          (controller) => activeRunControllers.set(functionId, controller)
        );
        const endedAt = new Date().toISOString();

        const merged = mergeRoundResults(fnDir, round, result.tests);
        updateRoundSummary(fnDir, summarizeRound(round, startedAt, endedAt, testCases.length, merged));
        actionsProvider.refresh();
        TestCasesPanel.refreshIfOpen(functionId);
        ReportPanel.showRound(functionId, round);

        if (result.stoppedByUser) {
          vscode.window.showInformationMessage(`AI Auto Test: "${functionId}" round ${round} — retest stopped on request.`);
        }
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(`AI Auto Test: ${(err as Error).message}`);
  } finally {
    activeRunControllers.delete(functionId);
  }
}

/**
 * Permanently deletes a round (report, evidence, bug reports). Called from the sidebar (no
 * `viewingRound`) or from a report's round history, where `viewingRound` is the round shown in that
 * panel and may differ from the deleted one.
 */
async function deleteRoundCommand(
  actionsProvider: ActionsProvider,
  functionId: string | undefined,
  round: number | undefined,
  viewingRound?: number
): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot || !functionId || typeof round !== 'number') return;

  const confirm = await vscode.window.showWarningMessage(
    `Delete round ${round} of function "${functionId}"? Its report, evidence and bug reports will be permanently deleted.`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;

  const dir = aitestDir(workspaceRoot);
  const fnDir = resolveFunctionDir(dir, functionId);

  try {
    deleteRound(fnDir, round);
    actionsProvider.refresh();
    TestCasesPanel.refreshIfOpen(functionId);

    if (viewingRound === round) {
      // The open report was the deleted round: show the latest remaining round, or close the panel.
      const remaining = readRounds(fnDir);
      if (remaining.length > 0) {
        ReportPanel.showRound(functionId, remaining[remaining.length - 1].round);
      } else {
        ReportPanel.closeRound(functionId, round);
      }
    } else if (typeof viewingRound === 'number') {
      // Re-render the open report so its round history drops the deleted round.
      ReportPanel.showRound(functionId, viewingRound);
    }

    vscode.window.showInformationMessage(`AI Auto Test: deleted round ${round} of function "${functionId}".`);
  } catch (err) {
    vscode.window.showErrorMessage(`AI Auto Test: failed to delete round — ${(err as Error).message}`);
  }
}

/* ============================================================
   Project — Backlog connection
   ============================================================ */

/** The API key is stored in SecretStorage, not in `.aitest/`. Keyed per workspace because each repo
 * may point at a different Backlog space/project. */
function backlogSecretKey(workspaceRoot: string): string {
  return `aitest.backlogApiKey::${workspaceRoot}`;
}

/** Client config from the saved project (`.aitest/backlog.json`) and the stored API key. Undefined when
 * not connected or the secret is gone (e.g. another machine); callers show the message. */
async function getBacklogClient(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<{ config: BacklogClientConfig; project: BacklogProjectConfig } | undefined> {
  const dir = aitestDir(workspaceRoot);
  const project = readBacklogProject(dir);
  if (!project) return undefined;

  const apiKey = await context.secrets.get(backlogSecretKey(workspaceRoot));
  if (!apiKey) return undefined;

  const baseUrlOverride = readBacklogConfigFromEnv(workspaceRoot)?.baseUrl;
  return { config: { baseUrl: backlogBaseUrl(project.spaceKey, baseUrlOverride), apiKey }, project };
}

/**
 * Connects (or changes) the Backlog project in two steps: (1) space key + API key (empty API key keeps
 * the saved one), (2) pick a project from the fetched list. The "Bug" issue type and default priority
 * are resolved once here so uploads don't need to ask again.
 */
async function connectBacklogProject(context: vscode.ExtensionContext, actionsProvider: ActionsProvider): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const dir = aitestDir(workspaceRoot);
  const existingProject = readBacklogProject(dir);
  const existingApiKey = await context.secrets.get(backlogSecretKey(workspaceRoot));
  const env = readBacklogConfigFromEnv(workspaceRoot);

  SimpleFormPanel.show(
    {
      panelKey: 'aitestBacklogCredentialsForm',
      panelTitle: 'AI Auto Test — Connect Backlog',
      heading: 'Connect Backlog',
      subtitle: existingProject
        ? `Connected to project "${existingProject.projectName}" (space: ${existingProject.spaceKey}). Edit to change the project or API key.`
        : undefined,
      fields: [
        {
          id: 'spaceKey',
          label: 'Space key',
          type: 'text',
          value: existingProject?.spaceKey ?? env?.spaceKey ?? '',
          required: true,
          hint: 'Backlog space key, e.g. "your-space" for https://your-space.backlog.com'
        },
        {
          id: 'apiKey',
          label: 'API Key',
          type: 'password',
          value: existingApiKey ? '' : env?.apiKey ?? '',
          required: !existingApiKey,
          placeholder: existingApiKey ? '(leave empty to keep the saved API key)' : '',
          hint: 'Your personal Backlog API key (Personal Settings → API → Register new API key).'
        }
      ],
      submitLabel: 'Continue'
    },
    (values) => {
      SimpleFormPanel.close('aitestBacklogCredentialsForm');
      const spaceKey = values.spaceKey;
      const apiKey = values.apiKey || existingApiKey;
      if (!apiKey) {
        vscode.window.showErrorMessage('AI Auto Test: an API key is required.');
        return;
      }
      void pickBacklogProjectAndConnect(context, actionsProvider, workspaceRoot, dir, spaceKey, apiKey);
    }
  );
}

/** Step 2 of connectBacklogProject: fetches the projects with the given credentials and lets the user pick one. */
async function pickBacklogProjectAndConnect(
  context: vscode.ExtensionContext,
  actionsProvider: ActionsProvider,
  workspaceRoot: string,
  dir: string,
  spaceKey: string,
  apiKey: string
): Promise<void> {
  const baseUrlOverride = readBacklogConfigFromEnv(workspaceRoot)?.baseUrl;
  const config: BacklogClientConfig = { baseUrl: backlogBaseUrl(spaceKey, baseUrlOverride), apiKey };

  try {
    const projects = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'AI Auto Test: fetching Backlog projects...' },
      () => listProjects(config)
    );
    if (projects.length === 0) {
      vscode.window.showWarningMessage(`AI Auto Test: space "${spaceKey}" has no projects.`);
      return;
    }

    SimpleFormPanel.show(
      {
        panelKey: 'aitestBacklogProjectForm',
        panelTitle: 'AI Auto Test — Choose Backlog project',
        heading: `Choose a Backlog project (space: ${spaceKey})`,
        fields: [
          {
            id: 'projectId',
            label: 'Project',
            type: 'select',
            options: projects.map((p) => ({ value: String(p.id), label: `${p.name} (${p.projectKey})` }))
          }
        ],
        submitLabel: 'Connect'
      },
      (values) => {
        SimpleFormPanel.close('aitestBacklogProjectForm');
        const project = projects.find((p) => p.id === parseInt(values.projectId, 10));
        if (project) void finishConnectBacklog(context, actionsProvider, workspaceRoot, dir, config, project, spaceKey, apiKey);
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(`AI Auto Test: Backlog connection failed — ${(err as Error).message}`);
  }
}

/** Final step of connectBacklogProject: resolves the "Bug" issue type and default priority, then saves
 * the API key and backlog.json. */
async function finishConnectBacklog(
  context: vscode.ExtensionContext,
  actionsProvider: ActionsProvider,
  workspaceRoot: string,
  dir: string,
  config: BacklogClientConfig,
  project: BacklogProjectSummary,
  spaceKey: string,
  apiKey: string
): Promise<void> {
  try {
    const [issueTypes, priorities] = await Promise.all([listIssueTypes(config, project.id), listPriorities(config)]);
    const bugType = pickBugIssueType(issueTypes);
    const priority = pickDefaultPriority(priorities);
    if (!bugType || !priority) {
      vscode.window.showErrorMessage('AI Auto Test: this project has no issue types or priorities; cannot connect.');
      return;
    }

    // Only store the key after the API calls succeeded, so a wrong key is never saved.
    await context.secrets.store(backlogSecretKey(workspaceRoot), apiKey);
    writeBacklogProject(dir, {
      spaceKey,
      projectId: project.id,
      projectKey: project.projectKey,
      projectName: project.name,
      bugIssueTypeId: bugType.id,
      bugIssueTypeName: bugType.name,
      defaultPriorityId: priority.id,
      defaultPriorityName: priority.name
    });
    actionsProvider.refresh();
    refreshMcpAndProjectSettingPanelsIfOpen(context, workspaceRoot);
    vscode.window.showInformationMessage(`AI Auto Test: connected to Backlog project "${project.name}" (${project.projectKey}).`);
  } catch (err) {
    vscode.window.showErrorMessage(`AI Auto Test: Backlog connection failed — ${(err as Error).message}`);
  }
}

async function disconnectBacklogProject(context: vscode.ExtensionContext, actionsProvider: ActionsProvider): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  clearBacklogProject(aitestDir(workspaceRoot));
  await context.secrets.delete(backlogSecretKey(workspaceRoot));
  actionsProvider.refresh();
  refreshMcpAndProjectSettingPanelsIfOpen(context, workspaceRoot);
  vscode.window.showInformationMessage('AI Auto Test: disconnected the Backlog project.');
}

/* ============================================================
   Integrations / Project Setting panels
   ============================================================ */

function buildMcpSettingData(dir: string): McpSettingData {
  const project = readBacklogProject(dir);
  return {
    backlogConnected: !!project,
    backlogStatusText: project
      ? `Connected: ${project.projectName} (${project.spaceKey} · ${project.projectKey})`
      : 'Not connected. Turn on to choose a Backlog project.'
  };
}

function buildProjectSettingSyncData(
  workspaceRoot: string,
  dir: string
): { data: ProjectSettingData; project: BacklogProjectConfig | undefined } {
  const project = readBacklogProject(dir);
  const baseUrlOverride = readBacklogConfigFromEnv(workspaceRoot)?.baseUrl;
  const projectUrl = project ? buildProjectUrl(backlogBaseUrl(project.spaceKey, baseUrlOverride), project.projectKey) : undefined;
  return { data: { project, projectUrl, folderPath: workspaceRoot }, project };
}

/** Fetches the issue count separately and pushes it to the panel, so the API call never blocks rendering. */
async function fetchAndPushTaskCount(context: vscode.ExtensionContext, workspaceRoot: string): Promise<void> {
  const client = await getBacklogClient(context, workspaceRoot);
  if (!client) {
    ProjectSettingPanel.pushTaskCount(undefined, 'not connected, or the saved API key is missing. Reconnect in Integrations');
    return;
  }
  try {
    const count = await getIssueCount(client.config, client.project.projectId);
    ProjectSettingPanel.pushTaskCount(count);
  } catch (err) {
    ProjectSettingPanel.pushTaskCount(undefined, (err as Error).message);
  }
}

function openMcpSettingPanel(): void {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('AI Auto Test: open a workspace first.');
    return;
  }
  McpSettingPanel.show(buildMcpSettingData(aitestDir(workspaceRoot)));
}

async function showProjectSettingPanel(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('AI Auto Test: open a workspace first.');
    return;
  }
  const dir = aitestDir(workspaceRoot);
  const { data, project } = buildProjectSettingSyncData(workspaceRoot, dir);
  ProjectSettingPanel.show(data);
  if (project) void fetchAndPushTaskCount(context, workspaceRoot);
}

/** Re-renders both panels after the Backlog connection changes; they read state from disk on each render. */
function refreshMcpAndProjectSettingPanelsIfOpen(context: vscode.ExtensionContext, workspaceRoot: string): void {
  const dir = aitestDir(workspaceRoot);
  if (McpSettingPanel.isOpen()) {
    McpSettingPanel.refreshIfOpen(buildMcpSettingData(dir));
  }
  if (ProjectSettingPanel.isOpen()) {
    const { data, project } = buildProjectSettingSyncData(workspaceRoot, dir);
    ProjectSettingPanel.refreshIfOpen(data);
    if (project) void fetchAndPushTaskCount(context, workspaceRoot);
  }
}

/** Switches project with the saved space key and API key (step 2 of connectBacklogProject only). */
async function switchBacklogProject(context: vscode.ExtensionContext, actionsProvider: ActionsProvider): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);
  const existingProject = readBacklogProject(dir);
  if (!existingProject) return;

  const apiKey = await context.secrets.get(backlogSecretKey(workspaceRoot));
  if (!apiKey) {
    vscode.window.showErrorMessage('AI Auto Test: the saved API key is missing. Reconnect in "Settings → Integrations".');
    return;
  }
  await pickBacklogProjectAndConnect(context, actionsProvider, workspaceRoot, dir, existingProject.spaceKey, apiKey);
}

/** Opens a folder like File → Open Folder. VS Code reloads the window, so there is no separate save step. */
async function chooseProjectFolder(): Promise<void> {
  const current = getWorkspaceRoot();
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Select project folder',
    defaultUri: current ? vscode.Uri.file(current) : undefined,
    title: 'Select the folder containing the project source code'
  });
  if (!uris || uris.length === 0) return;
  await vscode.commands.executeCommand('vscode.openFolder', uris[0], { forceNewWindow: false });
}

/** Backlog projects have no description field, so the description is stored locally in .aitest/backlog.json only. */
async function saveBacklogProjectDescription(description: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);
  const project = readBacklogProject(dir);
  if (!project) return;
  writeBacklogProject(dir, { ...project, description });
  vscode.window.showInformationMessage('AI Auto Test: project description saved.');
}

/**
 * Creates (or updates, if already uploaded) a Backlog "Bug" issue for a failed test case. The description
 * combines the report and the AI analysis (if any); evidence files are attached. The issue key/URL is saved
 * to `<round>/bug-reports/<id>.backlog.json` so the Bug Detail panel knows it was uploaded.
 */
async function uploadBugToBacklog(context: vscode.ExtensionContext, functionId: string, round: number, testId: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const dir = aitestDir(workspaceRoot);
  const client = await getBacklogClient(context, workspaceRoot);
  if (!client) {
    vscode.window.showErrorMessage(
      'AI Auto Test: no Backlog project connected (or the saved API key is missing). Connect in "Settings → Integrations".'
    );
    return;
  }
  const { project } = client;

  const fnDir = resolveFunctionDir(dir, functionId);
  const report = readRoundReport(fnDir, round);
  const test = report?.tests.find((t) => extractTestId(t.name) === testId);
  if (!test) {
    vscode.window.showErrorMessage(`AI Auto Test: no result found for "${testId}" in round ${round}.`);
    return;
  }

  // Re-upload updates the existing issue instead of creating a duplicate.
  const existingTask = readBacklogUploadedTask(fnDir, round, testId);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AI Auto Test: ${existingTask ? 'updating' : 'creating'} Backlog issue for "${testId}"...`
      },
      async () => {
        const testCase = readTestCases(fnDir).find((tc) => tc.id === testId);
        const analysis = readBugAnalysis(fnDir, round, testId);
        const meta = readFunctionMeta(fnDir);

        // Filter first so the description's Evidence section lists only files that are actually attached.
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

        // Always re-upload evidence: it may come from a newer run than the previous upload.
        const attachmentIds: number[] = [];
        for (const filePath of evidencePaths) {
          const attachment = await uploadAttachment(client.config, filePath);
          attachmentIds.push(attachment.id);
        }

        const issue = existingTask
          ? await updateIssue(client.config, { issueIdOrKey: existingTask.issueKey, description, attachmentIds })
          : await createIssue(client.config, {
              projectId: project.projectId,
              summary: `[${testId}] ${testCase?.name ?? test.name}`,
              issueTypeId: project.bugIssueTypeId,
              priorityId: project.defaultPriorityId,
              description,
              attachmentIds
            });

        const url = buildIssueUrl(client.config.baseUrl, issue.issueKey);
        writeBacklogUploadedTask(fnDir, round, testId, {
          issueId: issue.id,
          issueKey: issue.issueKey,
          url,
          uploadedAt: new Date().toISOString()
        });
        BugDetailPanel.refreshIfOpen(functionId, round, testId);
        vscode.window.showInformationMessage(
          existingTask
            ? `AI Auto Test: updated Backlog issue ${issue.issueKey} (no new issue created).`
            : `AI Auto Test: created Backlog issue ${issue.issueKey}.`
        );
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(`AI Auto Test: Backlog upload failed — ${(err as Error).message}`);
  }
}

/* ============================================================
   Functions — add / edit / delete
   ============================================================ */

async function addFunctionCommand(actionsProvider: ActionsProvider): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);
  const existingIds = listFunctionIds(dir);

  SimpleFormPanel.show(
    {
      panelKey: 'aitestFunctionForm',
      panelTitle: 'AI Auto Test — Add function',
      heading: 'Add function',
      fields: [
        {
          id: 'functionId',
          label: 'Function ID',
          type: 'text',
          placeholder: 'e.g. CustomerSignup',
          required: true,
          forbiddenValues: existingIds,
          forbiddenMessage: 'A function with this name already exists'
        },
        {
          id: 'screenUrl',
          label: 'Screen URL',
          type: 'text',
          placeholder: 'http://localhost:3000/customer-signup',
          hint: 'Optional. You can set it later when importing or syncing test cases.'
        }
      ],
      submitLabel: 'Add function'
    },
    (values) => {
      SimpleFormPanel.close('aitestFunctionForm');
      createFunction(dir, values.functionId, values.screenUrl ? { screenUrl: values.screenUrl } : {});
      actionsProvider.refresh();
      vscode.window.showInformationMessage(`AI Auto Test: added function "${values.functionId}".`);
    }
  );
}

async function editFunctionCommand(actionsProvider: ActionsProvider, presetFunctionId?: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);

  const functionId = presetFunctionId ?? (await vscode.window.showQuickPick(listFunctionIds(dir), { placeHolder: 'Pick the function to edit' }));
  if (!functionId) return;

  const fnDir = resolveFunctionDir(dir, functionId);
  const meta = readFunctionMeta(fnDir);

  SimpleFormPanel.show(
    {
      panelKey: 'aitestFunctionForm',
      panelTitle: `AI Auto Test — Edit function`,
      heading: `Edit function "${functionId}"`,
      fields: [
        { id: 'functionId', label: 'Function ID', type: 'text', value: functionId, disabled: true },
        {
          id: 'screenUrl',
          label: 'Screen URL',
          type: 'text',
          value: meta.screenUrl ?? '',
          placeholder: 'http://localhost:3000/customer-signup',
          hint: 'To rename the function, use the "AI Auto Test: Rename Function" command.'
        }
      ],
      submitLabel: 'Save function'
    },
    (values) => {
      SimpleFormPanel.close('aitestFunctionForm');
      writeFunctionMeta(fnDir, { ...meta, screenUrl: values.screenUrl || undefined });
      actionsProvider.refresh();
      vscode.window.showInformationMessage(`AI Auto Test: saved function "${functionId}".`);
    }
  );
}

async function deleteFunctionCommand(actionsProvider: ActionsProvider, presetFunctionId?: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);

  const functionId = presetFunctionId ?? (await vscode.window.showQuickPick(listFunctionIds(dir), { placeHolder: 'Pick the function to delete' }));
  if (!functionId) return;

  const confirm = await vscode.window.showWarningMessage(
    `Delete function "${functionId}"? All of its test cases, scripts and reports will be permanently deleted.`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;

  try {
    fs.rmSync(resolveFunctionDir(dir, functionId), { recursive: true, force: true });
    const schedules = readSchedules(dir);
    writeSchedules(dir, schedules.filter((s) => s.functionId !== functionId));
    actionsProvider.refresh();
    vscode.window.showInformationMessage(`AI Auto Test: deleted function "${functionId}".`);
  } catch (err) {
    vscode.window.showErrorMessage(`AI Auto Test: failed to delete function — ${(err as Error).message}`);
  }
}

/* ============================================================
   Test schedules — add / edit / delete
   ============================================================ */

async function addScheduleCommand(actionsProvider: ActionsProvider, presetFunctionId?: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);

  const functionIds = listFunctionIds(dir);
  if (functionIds.length === 0) {
    vscode.window.showWarningMessage('AI Auto Test: there are no functions to schedule.');
    return;
  }

  ScheduleFormPanel.show(
    {
      panelTitle: 'AI Auto Test — Add test schedule',
      heading: 'Add test schedule',
      functionId: presetFunctionId,
      functionOptions: presetFunctionId ? undefined : functionIds,
      type: 'daily',
      time: '09:00'
    },
    (result) => {
      ScheduleFormPanel.close();
      const schedule = buildScheduleFromScheduleForm(result);
      if (!schedule) {
        vscode.window.showErrorMessage('AI Auto Test: could not compute the next run time. Check the selected date/time.');
        return;
      }
      writeSchedules(dir, [...readSchedules(dir), schedule]);
      actionsProvider.refresh();
      vscode.window.showInformationMessage(`AI Auto Test: scheduled "${schedule.functionId}" — ${describeSchedule(schedule)}.`);
    }
  );
}

async function editScheduleCommand(actionsProvider: ActionsProvider, scheduleId?: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);
  const schedules = readSchedules(dir);

  const existing = scheduleId
    ? schedules.find((s) => s.id === scheduleId)
    : (await vscode.window.showQuickPick(schedules.map((s) => ({ label: `${s.functionId} — ${describeSchedule(s)}`, schedule: s })), {
        title: 'Pick the schedule to edit'
      }))?.schedule;
  if (!existing) return;

  ScheduleFormPanel.show(
    {
      panelTitle: 'AI Auto Test — Edit test schedule',
      heading: `Edit test schedule — ${existing.functionId}`,
      functionId: existing.functionId,
      type: existing.type,
      time: existing.time,
      date: existing.date,
      dayOfWeek: existing.dayOfWeek,
      dayOfMonth: existing.dayOfMonth
    },
    (result) => {
      ScheduleFormPanel.close();
      const updated = buildScheduleFromScheduleForm(result, existing.id);
      if (!updated) {
        vscode.window.showErrorMessage('AI Auto Test: could not compute the next run time. Check the selected date/time.');
        return;
      }
      writeSchedules(dir, schedules.map((s) => (s.id === existing.id ? updated : s)));
      actionsProvider.refresh();
      vscode.window.showInformationMessage(`AI Auto Test: saved schedule for "${existing.functionId}" — ${describeSchedule(updated)}.`);
    }
  );
}

async function deleteScheduleCommand(actionsProvider: ActionsProvider, scheduleId?: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);
  const schedules = readSchedules(dir);

  const existing = scheduleId
    ? schedules.find((s) => s.id === scheduleId)
    : (await vscode.window.showQuickPick(schedules.map((s) => ({ label: `${s.functionId} — ${describeSchedule(s)}`, schedule: s })), {
        title: 'Pick the schedule to delete'
      }))?.schedule;
  if (!existing) return;

  writeSchedules(dir, schedules.filter((s) => s.id !== existing.id));
  actionsProvider.refresh();
  vscode.window.showInformationMessage(`AI Auto Test: deleted schedule "${existing.functionId} — ${describeSchedule(existing)}".`);
}

/* ============================================================
   Test results — manual "Blocked" status per (round, test case)
   ============================================================ */

async function toggleBlockedCase(functionId: string, round: number, testId: string, block: boolean): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const fnDir = resolveFunctionDir(aitestDir(workspaceRoot), functionId);

  if (block) {
    const reason = await vscode.window.showInputBox({
      title: `Block test case "${testId}"`,
      prompt: 'Reason (e.g. test environment is down, waiting for data from another team...)',
      placeHolder: 'Reason for blocking'
    });
    if (reason === undefined) return; // cancelled
    setBlockedCase(fnDir, round, testId, reason.trim() || '(no reason given)');
  } else {
    clearBlockedCase(fnDir, round, testId);
  }
  ReportPanel.showRound(functionId, round);
}

/* ============================================================
   Test Case panel — import / sync / CRUD / suggest
   ============================================================ */

/**
 * Shared core of Import and Sync Test. Generates scripts for test cases whose hash changed or that have
 * no script yet (e.g. an interrupted generation), so a sync always leaves every case with a script.
 *
 * - `forceAll` ("Regenerate all" in the Sync modal) regenerates every case, for when the generation
 *   conventions changed but the test case content (and so its hash) did not.
 * - `forceIds` (per-row sync) forces the given ids regardless of the hash.
 * - `showDashboard=false` (per-row sync) skips the generate dashboard; the row shows its own spinner.
 */
async function syncTestCaseScripts(
  actionsProvider: ActionsProvider,
  workspaceRoot: string,
  fnDir: string,
  functionId: string,
  testCases: TestCase[],
  screenUrl: string,
  credential: string | undefined,
  modelOverride?: string,
  forceAll = false,
  forceIds?: Set<string>,
  showDashboard = true
): Promise<void> {
  const hashFile = testCaseHashesPath(fnDir);
  const previousHashes = readJson<Record<string, string>>(hashFile, {});
  const diff = diffTestCases(testCases, previousHashes);
  const scriptedIds = listScriptedTestCaseIds(fnDir);
  const missingScriptIds = testCases.filter((tc) => !scriptedIds.has(tc.id)).map((tc) => tc.id);
  // `diff.newHashes` covers every current test case, so forceAll needs no separate hash computation.
  const toGenerateIds = forceAll
    ? new Set(testCases.map((tc) => tc.id))
    : new Set([...diff.changedKeys, ...missingScriptIds, ...(forceIds ?? [])]);

  if (toGenerateIds.size === 0 && diff.removedIds.length === 0) {
    vscode.window.showInformationMessage(`AI Auto Test: function "${functionId}" — every test case already has a script; nothing to sync.`);
    return;
  }

  const changedTestCases = testCases.filter((tc) => toGenerateIds.has(tc.id));
  const apiConfig = await ensureApiConfig(workspaceRoot, fnDir, functionId, changedTestCases.some((tc) => tc.kind === 'api'));

  // Snapshot the old kinds before generating: onJobSettled overwrites the stored entries, and the old
  // kind is needed to locate stale scripts of removed or re-kinded cases.
  const oldById = new Map(readTestCases(fnDir).map((tc) => [tc.id, tc]));

  const genDir = resolveGeneratedDir(fnDir);
  // `modelOverride` (chosen in the Sync modal) replaces the default model for this sync only.
  const genOpts: ConcurrencyOptions = {
    ...getGenerationOptions(workspaceRoot),
    ...(modelOverride ? { model: modelOverride } : {}),
    onJobSettled: (info) => applyTestCaseJobResult(fnDir, genDir, hashFile, diff.newHashes, info)
  };

  try {
    fs.mkdirSync(path.join(fnDir, 'cache'), { recursive: true });
    fs.mkdirSync(genDir, { recursive: true });
    writeEvidenceSupport(genDir);
    writeReporter(genDir);
    ensurePlaywrightConfig(workspaceRoot);

    if (showDashboard) ReportPanel.showGenerateDashboard([]);

    const suite = await withProgressGenerate(() =>
      generateScriptsFromTestCasesParallel(changedTestCases, screenUrl, genOpts, credential, apiConfig)
    );

    if (diff.removedIds.length > 0) {
      // Removed ids are no longer in `testCases`; their old kind gives the script file prefix.
      for (const removedId of diff.removedIds) {
        const staleSource = path.join(genDir, scriptFileNameForTestCase(removedId, oldById.get(removedId)?.kind ?? 'ui'));
        if (fs.existsSync(staleSource)) {
          const staleDir = path.join(genDir, '_stale');
          fs.mkdirSync(staleDir, { recursive: true });
          fs.renameSync(staleSource, path.join(staleDir, path.basename(staleSource)));
        }
      }
      const hashes = readJson<Record<string, string>>(hashFile, {});
      for (const id of diff.removedIds) delete hashes[id];
      fs.writeFileSync(hashFile, JSON.stringify(hashes, null, 2));
    }

    for (const tc of changedTestCases) {
      const old = oldById.get(tc.id);
      if (old) moveStaleKindScript(genDir, tc.id, old.kind, tc.kind);
    }

    actionsProvider.refresh();
    TestCasesPanel.refreshIfOpen(functionId);

    showFinishedGenerateStats(
      readTestCases(fnDir),
      buildTestCaseGenerateMessage('Synced', functionId, changedTestCases.length, suite.failed.length, diff.removedIds.length)
    );
  } catch (err) {
    if (showDashboard) ReportPanel.finishGenerateDashboard(`Sync failed — ${(err as Error).message}`);
    vscode.window.showErrorMessage(`AI Auto Test: ${(err as Error).message}`);
  }
}

/**
 * API base URL and auth header for API test cases, asked only when API cases are about to be generated
 * and none is saved yet. Normally the Sync modal already saved them, so this is a safety net.
 * Returns undefined if the user cancels; the API cases are then marked failed rather than generated
 * against an empty base URL.
 */
async function ensureApiConfig(
  workspaceRoot: string,
  fnDir: string,
  functionId: string,
  hasApiCases: boolean
): Promise<{ baseUrl: string; authHeader?: string } | undefined> {
  if (!hasApiCases) return undefined;

  const meta = readFunctionMeta(fnDir);
  if (meta.apiBaseUrl) return { baseUrl: meta.apiBaseUrl, authHeader: meta.apiAuthHeader };

  const defaultBaseUrl = (() => {
    try {
      return meta.screenUrl ? new URL(meta.screenUrl).origin : '';
    } catch {
      return '';
    }
  })();

  const baseUrl = await vscode.window.showInputBox({
    title: `Base URL for the API test cases of "${functionId}"`,
    prompt: 'Scripts for test cases whose id starts with "API" send real requests to this base URL. Asked once and saved for later syncs',
    value: defaultBaseUrl,
    placeHolder: 'http://localhost:3000',
    validateInput: (v) => (/^https?:\/\//i.test(v.trim()) ? undefined : 'Enter a valid URL starting with http:// or https://')
  });
  if (!baseUrl) return undefined;

  const detectedToken = readAuthTokenFromEnv(workspaceRoot);
  const authHeader = await vscode.window.showInputBox({
    title: `Auth header for the API test cases of "${functionId}"`,
    prompt: 'Authentication header, if the API needs one (leave empty otherwise)',
    placeHolder: 'Bearer demo-secret-token',
    value: detectedToken ? `Bearer ${detectedToken}` : undefined
  });

  const trimmedBaseUrl = baseUrl.trim();
  const trimmedAuthHeader = authHeader?.trim() || undefined;
  writeFunctionMeta(fnDir, { ...meta, apiBaseUrl: trimmedBaseUrl, apiAuthHeader: trimmedAuthHeader });
  return { baseUrl: trimmedBaseUrl, authHeader: trimmedAuthHeader };
}

/** Values from the Test Case panel's Sync modal, passed as the 2nd argument of `aitest.syncTestScripts`. */
interface SyncFormResult {
  screenUrl: string;
  apiBaseUrl?: string;
  apiAuthHeader?: string;
  model: string;
  /** "Regenerate all": ignore hashes and regenerate every test case. */
  forceAll?: boolean;
}

/**
 * Writes imported test cases into a function, remembers the source file, then syncs scripts.
 * When the screen URL (or the API base URL for API cases) is still unknown, the Test Case panel opens
 * its Sync modal instead of syncing right away.
 */
async function applyImport(
  actionsProvider: ActionsProvider,
  workspaceRoot: string,
  functionId: string,
  testCases: TestCase[],
  source: TestCaseSource,
  openPanel = true
): Promise<void> {
  const fnDir = resolveFunctionDir(aitestDir(workspaceRoot), functionId);
  const retargeted = testCases.map((tc) => ({ ...tc, target: functionId }));
  const meta = readFunctionMeta(fnDir);
  const hasApiCases = retargeted.some((tc) => tc.kind === 'api');

  // Keep the automation fields of cases that already exist, so an unchanged case keeps its status
  const previousById = new Map(readTestCases(fnDir).map((tc) => [tc.id, tc]));
  writeTestCases(fnDir, retargeted.map((tc) => {
    const previous = previousById.get(tc.id);
    return previous ? { ...tc, automationStatus: previous.automationStatus, automationNote: previous.automationNote } : tc;
  }));
  writeFunctionMeta(fnDir, { ...meta, testCaseSource: source });
  actionsProvider.refresh();
  if (openPanel) await vscode.commands.executeCommand('aitest.showFunctionTestCases', functionId);

  const needsConfig = !meta.screenUrl || (hasApiCases && !meta.apiBaseUrl);
  if (needsConfig) {
    TestCasesPanel.refreshIfOpen(functionId, true);
    return;
  }
  TestCasesPanel.refreshIfOpen(functionId);
  await syncTestCaseScripts(actionsProvider, workspaceRoot, fnDir, functionId, readTestCases(fnDir), meta.screenUrl!, meta.credential);
}

/** "Import" button in the Test Case panel: imports a .md or Excel file into this function. */
async function importTestCasesFromFile(actionsProvider: ActionsProvider, functionId: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const [uri] = (await vscode.window.showOpenDialog({
    canSelectMany: false,
    title: `Import test cases into "${functionId}"`,
    filters: { 'Test cases': ['md', 'xlsx', 'xlsm'] }
  })) ?? [];
  if (!uri) return;

  const groups = await readTestCaseFileGroups(uri.fsPath, functionId);
  if (!groups) return;
  await applyImport(actionsProvider, workspaceRoot, functionId, groups[0].testCases, groups[0].source, false);
}

/** Re-reads the function's source file (Markdown or the chosen Excel sheets) and syncs what changed. */
async function reloadTestCasesFromSource(actionsProvider: ActionsProvider, functionId?: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);
  const withSource = listFunctionIds(dir).filter((id) => readFunctionMeta(resolveFunctionDir(dir, id)).testCaseSource);
  const id = functionId ?? (await vscode.window.showQuickPick(withSource, { placeHolder: 'Pick the function to reload' }));
  if (!id) return;

  const source = readFunctionMeta(resolveFunctionDir(dir, id)).testCaseSource;
  if (!source) {
    vscode.window.showErrorMessage(`AI Auto Test: function "${id}" was not imported from a file.`);
    return;
  }
  try {
    const loaded = await loadTestCasesFromSource(source, id);
    if (loaded.issues.length > 0) {
      vscode.window.showErrorMessage(describeIssues(loaded.issues));
      return;
    }
    await applyImport(actionsProvider, workspaceRoot, id, loaded.testCases, source);
  } catch (err) {
    vscode.window.showErrorMessage(`AI Auto Test: ${(err as Error).message}`);
  }
}

/**
 * "Sync Test": the panel's Sync modal has already collected the screen URL, API config and model, so
 * this saves them to meta and runs the sync. `formResult` is optional only to guard other callers.
 */
async function syncTestScripts(actionsProvider: ActionsProvider, functionId: string, formResult?: SyncFormResult): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);
  const fnDir = resolveFunctionDir(dir, functionId);

  const testCases = readTestCases(fnDir);
  if (testCases.length === 0) {
    vscode.window.showWarningMessage(`AI Auto Test: function "${functionId}" has no test cases yet.`);
    return;
  }
  if (!formResult) {
    vscode.window.showErrorMessage('AI Auto Test: Screen URL and model are required to sync.');
    return;
  }

  const meta = readFunctionMeta(fnDir);
  const hasApiCases = testCases.some((tc) => tc.kind === 'api');
  writeFunctionMeta(fnDir, {
    ...meta,
    screenUrl: formResult.screenUrl,
    apiBaseUrl: hasApiCases ? formResult.apiBaseUrl : meta.apiBaseUrl,
    apiAuthHeader: hasApiCases ? formResult.apiAuthHeader : meta.apiAuthHeader,
    syncModel: formResult.model
  });

  await syncTestCaseScripts(
    actionsProvider,
    workspaceRoot,
    fnDir,
    functionId,
    testCases,
    formResult.screenUrl,
    meta.credential,
    formResult.model,
    formResult.forceAll
  );
}

async function addTestCaseCommand(actionsProvider: ActionsProvider, functionId: string, testCase: TestCase): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const fnDir = resolveFunctionDir(aitestDir(workspaceRoot), functionId);

  const testCases = readTestCases(fnDir);
  if (testCases.some((tc) => tc.id === testCase.id)) {
    vscode.window.showErrorMessage(`AI Auto Test: test case id "${testCase.id}" already exists.`);
    return;
  }
  writeTestCases(fnDir, [...testCases, testCase]);
  actionsProvider.refresh();
  TestCasesPanel.refreshIfOpen(functionId);
}

async function updateTestCaseCommand(actionsProvider: ActionsProvider, functionId: string, testCase: TestCase): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const fnDir = resolveFunctionDir(aitestDir(workspaceRoot), functionId);

  const testCases = readTestCases(fnDir);
  const idx = testCases.findIndex((tc) => tc.id === testCase.id);
  if (idx === -1) {
    vscode.window.showErrorMessage(`AI Auto Test: test case "${testCase.id}" not found.`);
    return;
  }
  testCases[idx] = testCase;
  writeTestCases(fnDir, testCases);
  actionsProvider.refresh();
  TestCasesPanel.refreshIfOpen(functionId);
  // A saved edit re-syncs the test case right away.
  void syncSingleTestCase(actionsProvider, functionId, testCase.id);
}

/**
 * Per-row sync: regenerates the script for one test case regardless of its hash. The row stays locked
 * with a spinner while syncing; `finally` always clears that state so it never gets stuck.
 */
async function syncSingleTestCase(actionsProvider: ActionsProvider, functionId: string, testId: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const dir = aitestDir(workspaceRoot);
  const fnDir = resolveFunctionDir(dir, functionId);
  const testCases = readTestCases(fnDir);
  if (!testCases.some((tc) => tc.id === testId)) {
    vscode.window.showErrorMessage(`AI Auto Test: test case "${testId}" not found.`);
    return;
  }

  const meta = readFunctionMeta(fnDir);
  if (!meta.screenUrl) {
    vscode.window.showWarningMessage(
      `AI Auto Test: function "${functionId}" has no Screen URL. Click "Sync Test" to configure it before syncing single test cases.`
    );
    return;
  }

  const defaultModel = vscode.workspace.getConfiguration('aitest').get<string>('generation.model', DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;

  TestCasesPanel.setRowSyncing(functionId, testId, true);
  try {
    await syncTestCaseScripts(
      actionsProvider,
      workspaceRoot,
      fnDir,
      functionId,
      testCases,
      meta.screenUrl,
      meta.credential,
      meta.syncModel || defaultModel,
      false,
      new Set([testId]),
      false
    );
  } finally {
    // Clear only this row's syncing flag before re-rendering, so rows still syncing in parallel keep
    // their spinner (the panel tracks syncing ids itself).
    TestCasesPanel.setRowSyncing(functionId, testId, false);
    TestCasesPanel.refreshIfOpen(functionId);
  }
}

async function deleteTestCaseCommand(actionsProvider: ActionsProvider, functionId: string, testId: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const fnDir = resolveFunctionDir(aitestDir(workspaceRoot), functionId);

  writeTestCases(fnDir, readTestCases(fnDir).filter((tc) => tc.id !== testId));
  actionsProvider.refresh();
  TestCasesPanel.refreshIfOpen(functionId);
}

/**
 * Asks the AI for missing test cases of a function and pushes the suggestions to the Test Case panel,
 * where the user picks which to keep (see saveSuggestedTestCases). Works for any function.
 */
async function suggestMissingTestCasesForPanel(functionId: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const fnDir = resolveFunctionDir(aitestDir(workspaceRoot), functionId);
  const existingTestCases = readTestCases(fnDir);

  try {
    const suggestions = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `AI Auto Test: looking for missing test cases in "${functionId}"...` },
      async () => {
        const prompt = buildMissingTestCasesPrompt(existingTestCases, functionId);
        const raw = await callClaudeCli(prompt, workspaceRoot, getDefaultModel());
        return parseMissingTestCasesResponse(raw);
      }
    );
    TestCasesPanel.pushSuggestions(functionId, suggestions);
  } catch (err) {
    vscode.window.showErrorMessage(`AI Auto Test: missing test case review failed — ${(err as Error).message}`);
  }
}

/** Saves the suggested test cases the user accepted to testcases.json (and back to the source file, if any). */
async function saveSuggestedTestCases(
  actionsProvider: ActionsProvider,
  functionId: string,
  testCases: SuggestedTestCase[]
): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const fnDir = resolveFunctionDir(aitestDir(workspaceRoot), functionId);

  const existing = readTestCases(fnDir);
  const existingIds = new Set(existing.map((tc) => tc.id));
  // "reason" is only shown in the modal; don't store it.
  const toAdd: TestCase[] = testCases
    .filter((tc) => !existingIds.has(tc.id))
    .map(({ reason, ...rest }) => rest);

  writeTestCases(fnDir, [...existing, ...toAdd]);

  // Write the accepted cases back to the source file, so the next reload from source keeps them
  const meta = readFunctionMeta(fnDir);
  const source = meta.testCaseSource;
  if (source && toAdd.length > 0) {
    try {
      if (path.extname(source.path).toLowerCase() === '.md') {
        appendTestCasesToMarkdown(source.path, toAdd);
      } else {
        const sheetName = await appendSuggestionsToWorkbook(source.path, toAdd, functionId);
        writeFunctionMeta(fnDir, { ...meta, testCaseSource: { ...source, sheets: [...(source.sheets ?? []), sheetName] } });
      }
    } catch (err) {
      const busy = (err as NodeJS.ErrnoException).code === 'EBUSY';
      vscode.window.showWarningMessage(
        `AI Auto Test: saved to the function, but could not write to ${path.basename(source.path)}` +
          (busy ? ' (the file is open in another program; close it and save again).' : `: ${(err as Error).message}`)
      );
    }
  }

  actionsProvider.refresh();
  TestCasesPanel.refreshIfOpen(functionId);
  vscode.window.showInformationMessage(`AI Auto Test: added ${toAdd.length} suggested test cases to "${functionId}".`);
}
