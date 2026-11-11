import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  functionDir,
  generatedDir,
  testCasesPath,
  listFunctionIds,
  readTestCases,
  writeTestCases,
  createFunction,
  listScriptedTestCaseIds,
  readRounds,
  nextRound,
  appendRound,
  deleteRound,
  roundDir,
  summarizeRound,
  mergeRoundResults,
  updateRoundSummary,
  readFunctionMeta,
  writeFunctionMeta,
  readSchedules,
  writeSchedules,
  readBlockedCases,
  setBlockedCase,
  clearBlockedCase,
  readBugAnalysis,
  writeBugAnalysis,
  computeBugOccurrence,
  readBacklogUploadedTask,
  writeBacklogUploadedTask,
  readBacklogProject,
  writeBacklogProject,
  clearBacklogProject
} from './store';
import { BacklogProjectConfig, RunResult, Schedule } from '../types';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-store-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('listFunctionIds', () => {
  it('returns an empty list when nothing has been generated yet', () => {
    expect(listFunctionIds(makeTmpDir())).toEqual([]);
  });

  it('lists only function dirs that actually have a testcases.json, sorted', () => {
    const aitestDir = makeTmpDir();
    for (const id of ['Zeta', 'Alpha']) {
      fs.mkdirSync(functionDir(aitestDir, id), { recursive: true });
      fs.writeFileSync(testCasesPath(functionDir(aitestDir, id)), '[]');
    }
    fs.mkdirSync(functionDir(aitestDir, 'Incomplete'), { recursive: true }); // no testcases.json yet

    expect(listFunctionIds(aitestDir)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('readTestCases', () => {
  it('reads back what was written, and returns [] when missing', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    fs.mkdirSync(dir, { recursive: true });

    expect(readTestCases(dir)).toEqual([]);

    fs.writeFileSync(testCasesPath(dir), JSON.stringify([{ id: '1' }]));
    expect(readTestCases(dir)).toEqual([{ id: '1' }]);
  });
});

describe('rounds', () => {
  it('starts at round 1 when no rounds recorded yet', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    expect(readRounds(dir)).toEqual([]);
    expect(nextRound(dir)).toBe(1);
  });

  it('increments from the highest recorded round, independently per function', () => {
    const aitestDir = makeTmpDir();
    const dirA = functionDir(aitestDir, 'A');
    const dirB = functionDir(aitestDir, 'B');

    const result: RunResult = { total: 2, passed: 2, failed: 0, tests: [{ name: 't', status: 'passed', durationMs: 100 }] };
    appendRound(dirA, summarizeRound(1, 't0', 't1', 2, result));
    appendRound(dirA, summarizeRound(2, 't1', 't2', 2, result));

    expect(nextRound(dirA)).toBe(3);
    expect(nextRound(dirB)).toBe(1); // untouched by A's rounds
    expect(readRounds(dirA)).toHaveLength(2);
  });

  it('summarizeRound computes untested as testcases beyond what actually ran, floored at 0', () => {
    const result: RunResult = {
      total: 1,
      passed: 0,
      failed: 1,
      tests: [{ name: 't', status: 'failed', durationMs: 50 }]
    };
    expect(summarizeRound(1, 't0', 't1', 5, result).untested).toBe(4);
    expect(summarizeRound(1, 't0', 't1', 0, result).untested).toBe(0);
    expect(summarizeRound(1, 't0', 't1', 5, result).totalDurationMs).toBe(50);
  });
});

describe('deleteRound', () => {
  it('removes the round dir (report.json and friends) and its entry in rounds.json, leaving other rounds untouched', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    const result: RunResult = { total: 1, passed: 1, failed: 0, tests: [{ name: 't', status: 'passed', durationMs: 10 }] };
    appendRound(dir, summarizeRound(1, 't0', 't1', 1, result));
    appendRound(dir, summarizeRound(2, 't1', 't2', 1, result));

    const round1Dir = roundDir(dir, 1);
    fs.mkdirSync(round1Dir, { recursive: true });
    fs.writeFileSync(path.join(round1Dir, 'report.json'), JSON.stringify(result));
    fs.writeFileSync(path.join(round1Dir, 'blocked.json'), '{}');

    deleteRound(dir, 1);

    expect(fs.existsSync(round1Dir)).toBe(false);
    expect(readRounds(dir).map((r) => r.round)).toEqual([2]);
  });

  it('is a no-op (does not throw) when the round never existed', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    expect(() => deleteRound(dir, 99)).not.toThrow();
    expect(readRounds(dir)).toEqual([]);
  });
});

describe('mergeRoundResults', () => {
  it('replaces only the entries matching the updated ids, keeping the rest untouched', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    const initial: RunResult = {
      total: 2,
      passed: 1,
      failed: 1,
      tests: [
        { name: '[A] Case A', status: 'passed', durationMs: 100 },
        { name: '[B] Case B', status: 'failed', durationMs: 200 }
      ]
    };
    appendRound(dir, summarizeRound(1, 't0', 't1', 2, initial));
    // Write the initial report.json directly (appendRound only writes rounds.json).
    const roundDirPath = path.join(dir, 'results', 'round-1');
    fs.mkdirSync(roundDirPath, { recursive: true });
    fs.writeFileSync(path.join(roundDirPath, 'report.json'), JSON.stringify(initial));

    const merged = mergeRoundResults(dir, 1, [{ name: '[B] Case B', status: 'passed', durationMs: 150 }]);

    expect(merged.tests.find((t) => t.name === '[A] Case A')?.status).toBe('passed');
    expect(merged.tests.find((t) => t.name === '[B] Case B')?.status).toBe('passed');
    expect(merged.tests.find((t) => t.name === '[B] Case B')?.durationMs).toBe(150);
    expect(merged.passed).toBe(2);
    expect(merged.failed).toBe(0);
    expect(merged.total).toBe(2);
  });
});

describe('computeBugOccurrence', () => {
  function writeRound(dir: string, round: number, tests: RunResult['tests']): void {
    const result: RunResult = {
      total: tests.length,
      passed: tests.filter((t) => t.status === 'passed').length,
      failed: tests.filter((t) => t.status === 'failed').length,
      tests
    };
    appendRound(dir, summarizeRound(round, 't0', 't1', tests.length, result));
    const roundDirPath = path.join(dir, 'results', `round-${round}`);
    fs.mkdirSync(roundDirPath, { recursive: true });
    fs.writeFileSync(path.join(roundDirPath, 'report.json'), JSON.stringify(result));
  }

  it('counts the rounds where the case failed against the rounds where it ran at all', () => {
    const dir = functionDir(makeTmpDir(), 'F1');
    writeRound(dir, 1, [{ name: '[TC01] a', status: 'failed', durationMs: 1 }]);
    writeRound(dir, 2, [{ name: '[TC01] a', status: 'passed', durationMs: 1 }]);
    writeRound(dir, 3, [{ name: '[TC01] a', status: 'failed', durationMs: 1 }]);

    expect(computeBugOccurrence(dir, 'TC01')).toEqual({ failedRounds: [1, 3], ranRounds: 3 });
  });

  it('ignores rounds where the case was not part of the run', () => {
    const dir = functionDir(makeTmpDir(), 'F1');
    writeRound(dir, 1, [{ name: '[TC01] a', status: 'failed', durationMs: 1 }]);
    writeRound(dir, 2, [{ name: '[TC99] other', status: 'passed', durationMs: 1 }]);

    expect(computeBugOccurrence(dir, 'TC01')).toEqual({ failedRounds: [1], ranRounds: 1 });
  });

  it('reports nothing ran when the function has no round history', () => {
    const dir = functionDir(makeTmpDir(), 'F1');
    expect(computeBugOccurrence(dir, 'TC01')).toEqual({ failedRounds: [], ranRounds: 0 });
  });
});

describe('updateRoundSummary', () => {
  it('replaces the entry with the matching round number instead of appending a new one', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    const result: RunResult = { total: 2, passed: 1, failed: 1, tests: [{ name: 't', status: 'passed', durationMs: 10 }] };
    appendRound(dir, summarizeRound(1, 't0', 't1', 2, result));

    const updated = summarizeRound(1, 't0', 't2', 2, { total: 2, passed: 2, failed: 0, tests: result.tests });
    updateRoundSummary(dir, updated);

    const rounds = readRounds(dir);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].passed).toBe(2);
    expect(rounds[0].failed).toBe(0);
  });
});

describe('writeTestCases / createFunction', () => {
  it('writeTestCases persists what readTestCases reads back', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    writeTestCases(dir, [{ id: 'TC-01' } as never]);
    expect(readTestCases(dir)).toEqual([{ id: 'TC-01' }]);
  });

  it('createFunction registers an empty function that listFunctionIds immediately picks up', () => {
    const aitestDir = makeTmpDir();
    createFunction(aitestDir, 'NewFn');
    expect(listFunctionIds(aitestDir)).toEqual(['NewFn']);
    expect(readTestCases(functionDir(aitestDir, 'NewFn'))).toEqual([]);
  });

  it('createFunction writes meta.json only when meta fields are given', () => {
    const aitestDir = makeTmpDir();
    createFunction(aitestDir, 'WithMeta', { screenUrl: 'http://localhost:3000/x' });
    expect(readFunctionMeta(functionDir(aitestDir, 'WithMeta'))).toEqual({ screenUrl: 'http://localhost:3000/x' });
  });
});

describe('listScriptedTestCaseIds', () => {
  it('returns an empty set when generated/ does not exist yet', () => {
    const aitestDir = makeTmpDir();
    expect(listScriptedTestCaseIds(functionDir(aitestDir, 'F1'))).toEqual(new Set());
  });

  it('finds ids from the [id] title prefix regardless of the script file name', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    fs.mkdirSync(generatedDir(dir), { recursive: true });
    fs.writeFileSync(
      path.join(generatedDir(dir), 'API-1-somefile.spec.ts'),
      `test('[API-1-01] case A', async () => {});\ntest("[API-1-02] case B", async () => {});`
    );
    fs.writeFileSync(path.join(generatedDir(dir), 'UI-TC-03.spec.ts'), `test('[TC-03] case C', async () => {});`);

    const ids = listScriptedTestCaseIds(dir);
    expect(ids.has('API-1-01')).toBe(true);
    expect(ids.has('API-1-02')).toBe(true);
    expect(ids.has('TC-03')).toBe(true);
    expect(ids.has('TC-04')).toBe(false);
  });

  it('ignores files inside support/ and _stale/', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    fs.mkdirSync(path.join(generatedDir(dir), 'support'), { recursive: true });
    fs.writeFileSync(path.join(generatedDir(dir), 'support', 'evidence.ts'), `test('[TC-99] should not count', () => {});`);

    expect(listScriptedTestCaseIds(dir).has('TC-99')).toBe(false);
  });
});

describe('blocked cases', () => {
  it('returns {} when nothing is blocked, and reads back what was set', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    expect(readBlockedCases(dir, 1)).toEqual({});

    setBlockedCase(dir, 1, 'TC-01', 'Test environment is down');
    const blocked = readBlockedCases(dir, 1);
    expect(blocked['TC-01'].reason).toBe('Test environment is down');
    expect(typeof blocked['TC-01'].blockedAt).toBe('string');
  });

  it('clearBlockedCase removes only the given id, keeping others intact', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    setBlockedCase(dir, 1, 'TC-01', 'reason A');
    setBlockedCase(dir, 1, 'TC-02', 'reason B');

    clearBlockedCase(dir, 1, 'TC-01');

    const blocked = readBlockedCases(dir, 1);
    expect(blocked['TC-01']).toBeUndefined();
    expect(blocked['TC-02'].reason).toBe('reason B');
  });

  it('is scoped per round — blocking in round 1 does not affect round 2', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    setBlockedCase(dir, 1, 'TC-01', 'reason');
    expect(readBlockedCases(dir, 2)).toEqual({});
  });
});

describe('bug analysis storage', () => {
  it('returns undefined when no analysis has been written, and reads back what was written', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    expect(readBugAnalysis(dir, 1, 'TC-01')).toBeUndefined();

    writeBugAnalysis(dir, 1, 'TC-01', { rootCause: 'r', fixApproach: 'f', actionItems: ['a'], estimate: 'e' });
    expect(readBugAnalysis(dir, 1, 'TC-01')).toEqual({ rootCause: 'r', fixApproach: 'f', actionItems: ['a'], estimate: 'e' });
  });

  it('sanitizes the test id the same way bug reports themselves are named', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    writeBugAnalysis(dir, 1, 'TC 01/weird', { rootCause: 'r', fixApproach: 'f', actionItems: [], estimate: 'e' });
    expect(readBugAnalysis(dir, 1, 'TC 01/weird')).toBeDefined();
  });
});

describe('backlog uploaded task storage', () => {
  it('returns undefined when nothing uploaded yet, and reads back what was written', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    expect(readBacklogUploadedTask(dir, 1, 'TC-01')).toBeUndefined();

    const task = { issueId: 42, issueKey: 'PROJ-42', url: 'https://example.backlog.com/view/PROJ-42', uploadedAt: '2026-01-01T00:00:00.000Z' };
    writeBacklogUploadedTask(dir, 1, 'TC-01', task);
    expect(readBacklogUploadedTask(dir, 1, 'TC-01')).toEqual(task);
  });
});

describe('backlog project config', () => {
  const config: BacklogProjectConfig = {
    spaceKey: 'example',
    projectId: 12345,
    projectKey: 'PROJ',
    projectName: 'AI Auto Test Automation',
    bugIssueTypeId: 1,
    bugIssueTypeName: 'Bug',
    defaultPriorityId: 3,
    defaultPriorityName: 'Normal'
  };

  it('returns undefined when never connected, and reads back what was written', () => {
    const aitestDir = makeTmpDir();
    expect(readBacklogProject(aitestDir)).toBeUndefined();

    writeBacklogProject(aitestDir, config);
    expect(readBacklogProject(aitestDir)).toEqual(config);
  });

  it('clearBacklogProject removes the config without throwing when nothing was ever written', () => {
    const aitestDir = makeTmpDir();
    expect(() => clearBacklogProject(aitestDir)).not.toThrow();

    writeBacklogProject(aitestDir, config);
    clearBacklogProject(aitestDir);
    expect(readBacklogProject(aitestDir)).toBeUndefined();
  });
});

describe('function meta (Screen URL)', () => {
  it('returns {} when no meta has been written yet, and reads back what was written', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    expect(readFunctionMeta(dir)).toEqual({});

    writeFunctionMeta(dir, { screenUrl: 'http://localhost:3000/customer-signup' });
    expect(readFunctionMeta(dir)).toEqual({ screenUrl: 'http://localhost:3000/customer-signup' });
  });

  it('reads back credential and testCaseFilePath alongside screenUrl', () => {
    const aitestDir = makeTmpDir();
    const dir = functionDir(aitestDir, 'F1');
    writeFunctionMeta(dir, {
      screenUrl: 'http://localhost:3000/customer-signup',
      credential: 'Bearer demo-secret-token',
      testCaseFilePath: '/workspace/demo-testcases.md'
    });
    expect(readFunctionMeta(dir)).toEqual({
      screenUrl: 'http://localhost:3000/customer-signup',
      credential: 'Bearer demo-secret-token',
      testCaseFilePath: '/workspace/demo-testcases.md'
    });
  });
});

describe('schedules', () => {
  it('returns [] when no schedules have been written yet, and reads back what was written', () => {
    const aitestDir = makeTmpDir();
    expect(readSchedules(aitestDir)).toEqual([]);

    const schedules: Schedule[] = [
      { id: 's1', functionId: 'F1', type: 'daily', time: '09:00', nextFireAt: '2026-01-02T02:00:00.000Z' }
    ];
    writeSchedules(aitestDir, schedules);
    expect(readSchedules(aitestDir)).toEqual(schedules);
  });

  it('overwrites the whole list rather than merging', () => {
    const aitestDir = makeTmpDir();
    writeSchedules(aitestDir, [{ id: 's1', functionId: 'F1', type: 'daily', time: '09:00', nextFireAt: 'x' }]);
    writeSchedules(aitestDir, [{ id: 's2', functionId: 'F2', type: 'weekly', time: '10:00', dayOfWeek: 1, nextFireAt: 'y' }]);

    const schedules = readSchedules(aitestDir);
    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).toBe('s2');
  });
});
