import fs from 'fs';
import path from 'path';

const CANDIDATE_KEYS = ['TEST_TOKEN', 'API_TOKEN', 'AUTH_TOKEN'];
const TOKEN_KEY_PATTERN = /TOKEN/i;

export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Reads the target app's real auth token from .env.local (preferred; usually gitignored) and then
 * .env.example (committed, so it works on a fresh checkout), so users don't have to type it on every
 * generate and the LLM never invents a token (e.g. "valid-test-token") when the Auth header is empty.
 * Common names (TEST_TOKEN, API_TOKEN, AUTH_TOKEN) win; otherwise the first variable whose name
 * contains "TOKEN" is used.
 */
export function readAuthTokenFromEnv(workspaceRoot: string): string | undefined {
  for (const fileName of ['.env.local', '.env.example']) {
    const filePath = path.join(workspaceRoot, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const values = parseEnvFile(fs.readFileSync(filePath, 'utf-8'));
      for (const key of CANDIDATE_KEYS) {
        if (values[key]) return values[key];
      }
      const genericKey = Object.keys(values).find((k) => TOKEN_KEY_PATTERN.test(k));
      if (genericKey) return values[genericKey];
    } catch {
      // Unreadable file: try the next one.
    }
  }
  return undefined;
}

/** Reads one variable using the same file precedence (.env.local, then .env.example). */
function readEnvValue(workspaceRoot: string, key: string): string | undefined {
  for (const fileName of ['.env.local', '.env.example']) {
    const filePath = path.join(workspaceRoot, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const values = parseEnvFile(fs.readFileSync(filePath, 'utf-8'));
      if (values[key]) return values[key];
    } catch {
      // Unreadable file: try the next one.
    }
  }
  return undefined;
}

export interface BacklogEnvConfig {
  apiKey: string;
  /** '' when BACKLOG_SPACE_KEY is not set. */
  spaceKey: string;
  baseUrl?: string;
}

/**
 * Reads Backlog settings from .env.local/.env.example.
 * - BACKLOG_API_KEY is required; without it this returns undefined so callers can show a clear
 *   message instead of calling the API with an empty key.
 * - BACKLOG_SPACE_KEY is optional; it is '' when unset and the connect form asks for it.
 * - BACKLOG_BASE_URL is only needed when the space is not on `.backlog.com` (e.g. `.backlogtool.com`).
 */
export function readBacklogConfigFromEnv(workspaceRoot: string): BacklogEnvConfig | undefined {
  const apiKey = readEnvValue(workspaceRoot, 'BACKLOG_API_KEY');
  if (!apiKey) return undefined;
  const spaceKey = readEnvValue(workspaceRoot, 'BACKLOG_SPACE_KEY') ?? '';
  const baseUrl = readEnvValue(workspaceRoot, 'BACKLOG_BASE_URL');
  return { apiKey, spaceKey, baseUrl };
}
