import { spawn } from 'child_process';

interface ClaudeCliResult {
  is_error: boolean;
  result: string;
  api_error_status?: string | null;
}

/**
 * Calls Claude through the Claude Code CLI (`claude -p`) instead of an Anthropic API key, reusing the
 * Claude Code login already on the machine: no separate API key to store, no separate billing account.
 *
 * Every prompt sent here (test generation, test case suggestions, bug analysis) only needs a text/JSON
 * answer and never needs to read/write files or run commands, so all tools are disabled (`--tools ''`).
 * That stops the model from exploring files (extra tool turns are a hidden token cost) and prevents
 * hangs on permission prompts nobody can approve in headless mode.
 * `--exclude-dynamic-system-prompt-sections` keeps machine-specific system prompt sections (cwd, env,
 * git status...) out of the fixed prefix so consecutive calls (several batches per generation) can share
 * a cached prefix. `--no-session-persistence` because each call is one-shot.
 *
 * Requires the Claude Code CLI installed and logged in (`claude` runs in a terminal), and `claude` run
 * interactively once in the workspace to accept the trust dialog.
 *
 * `model`: per-call override passed as `--model` (an alias like "haiku" or a full model id); empty uses
 * the Claude Code session default. Generating scripts from existing test cases is fairly mechanical
 * (a fixed JSON contract), so a cheaper model usually costs little quality but saves many tokens — see
 * the `aitest.generation.model` setting.
 */
export function callClaudeCli(prompt: string, cwd?: string, model?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--exclude-dynamic-system-prompt-sections',
      '--no-session-persistence'
    ];
    if (model) args.push('--model', model);

    const child = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      reject(new Error(`Could not run the claude CLI — check that Claude Code is installed and logged in: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as ClaudeCliResult;
        if (parsed.is_error) {
          reject(new Error(`Claude CLI returned an error: ${parsed.api_error_status ?? stdout}`));
          return;
        }
        resolve(parsed.result);
      } catch (err) {
        reject(new Error(`Could not parse claude CLI output: ${(err as Error).message}\n${stdout}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
