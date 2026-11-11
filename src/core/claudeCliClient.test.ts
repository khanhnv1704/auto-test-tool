import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'child_process';
import { callClaudeCli } from './claudeCliClient';

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  return child;
}

describe('callClaudeCli', () => {
  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('disables all tools, excludes dynamic system prompt sections, and disables session persistence — every call is pure text-in/JSON-out, no filesystem/tool access needed', async () => {
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = callClaudeCli('prompt', '/some/cwd');
    child.stdout.emit('data', Buffer.from(JSON.stringify({ is_error: false, result: 'ok' })));
    child.emit('close', 0);
    await resultPromise;

    const [command, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe('claude');
    expect(args).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'json', '--tools', '', '--exclude-dynamic-system-prompt-sections', '--no-session-persistence'])
    );
    expect(args).not.toContain('--model');
    expect((opts as { cwd?: string })?.cwd).toBe('/some/cwd');
  });

  it('passes --model only when a model override is given', async () => {
    const withoutModel = fakeChildProcess();
    vi.mocked(spawn).mockReturnValueOnce(withoutModel as never);
    const p1 = callClaudeCli('prompt');
    withoutModel.stdout.emit('data', Buffer.from(JSON.stringify({ is_error: false, result: 'ok' })));
    withoutModel.emit('close', 0);
    await p1;
    expect(vi.mocked(spawn).mock.calls[0][1]).not.toContain('--model');

    const withModel = fakeChildProcess();
    vi.mocked(spawn).mockReturnValueOnce(withModel as never);
    const p2 = callClaudeCli('prompt', undefined, 'haiku');
    withModel.stdout.emit('data', Buffer.from(JSON.stringify({ is_error: false, result: 'ok' })));
    withModel.emit('close', 0);
    await p2;
    const args = vi.mocked(spawn).mock.calls[1][1] as string[];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
  });

  it('writes the prompt to stdin and resolves with the parsed result on success', async () => {
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = callClaudeCli('generate test cases for this');
    child.stdout.emit('data', Buffer.from(JSON.stringify({ is_error: false, result: '{"testCases":[]}' })));
    child.emit('close', 0);

    await expect(resultPromise).resolves.toBe('{"testCases":[]}');
    expect(child.stdin.write).toHaveBeenCalledWith('generate test cases for this');
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('rejects when the CLI exits non-zero', async () => {
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = callClaudeCli('prompt');
    child.stderr.emit('data', Buffer.from('some fatal error'));
    child.emit('close', 1);

    await expect(resultPromise).rejects.toThrow('claude CLI exited with code 1');
  });

  it('rejects when the CLI reports is_error in its JSON envelope', async () => {
    const child = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const resultPromise = callClaudeCli('prompt');
    child.stdout.emit('data', Buffer.from(JSON.stringify({ is_error: true, result: '', api_error_status: 'overloaded_error' })));
    child.emit('close', 0);

    await expect(resultPromise).rejects.toThrow('overloaded_error');
  });
});
