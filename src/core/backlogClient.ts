import * as fs from 'fs';
import * as path from 'path';

/**
 * REST client for Backlog (Nulab): https://developer.nulab.com/docs/backlog/
 * Authenticates with an API key (`apiKey` query param, not OAuth2), the simplest option for a
 * developer tool.
 *
 * NOTE: unlike most REST APIs, Backlog API v2 takes POST/PATCH bodies as
 * `application/x-www-form-urlencoded`, not JSON. Array fields (e.g. attachmentId[]) repeat the key.
 *
 * `fetchImpl` is injectable (defaults to the global `fetch`) so tests can mock it without stubbing globals.
 */

export interface BacklogProjectSummary {
  id: number;
  projectKey: string;
  name: string;
}

export interface BacklogIssueType {
  id: number;
  name: string;
}

export interface BacklogPriority {
  id: number;
  name: string;
}

export interface BacklogAttachment {
  id: number;
  name: string;
}

export interface BacklogIssue {
  id: number;
  issueKey: string;
}

export interface BacklogClientConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Base URL of a Backlog space. Defaults to `.backlog.com`; BACKLOG_BASE_URL overrides it because
 * some spaces live on `.backlogtool.com` or `.backlog.jp`. */
export function backlogBaseUrl(spaceKey: string, baseUrlOverride?: string): string {
  if (baseUrlOverride) return baseUrlOverride.replace(/\/+$/, '');
  return `https://${spaceKey}.backlog.com`;
}

function buildUrl(config: BacklogClientConfig, apiPath: string, query: Record<string, string | undefined> = {}): string {
  const url = new URL(`${config.baseUrl}${apiPath}`);
  url.searchParams.set('apiKey', config.apiKey);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Backlog errors look like `{ errors: [{ message, code, moreInfo }] }`; join them into one message. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { errors?: Array<{ message?: string }> };
    const messages = body.errors?.map((e) => e.message).filter(Boolean);
    if (messages && messages.length > 0) return messages.join('; ');
  } catch {
    // Not JSON: fall back to statusText.
  }
  return response.statusText || `HTTP ${response.status}`;
}

async function backlogGet<T>(config: BacklogClientConfig, apiPath: string, query?: Record<string, string | undefined>): Promise<T> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(buildUrl(config, apiPath, query));
  if (!response.ok) {
    throw new Error(`Backlog API GET ${apiPath} failed (${response.status}): ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as T;
}

async function backlogPostForm<T>(config: BacklogClientConfig, apiPath: string, form: URLSearchParams): Promise<T> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(buildUrl(config, apiPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  if (!response.ok) {
    throw new Error(`Backlog API POST ${apiPath} failed (${response.status}): ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as T;
}

async function backlogPatchForm<T>(config: BacklogClientConfig, apiPath: string, form: URLSearchParams): Promise<T> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(buildUrl(config, apiPath), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  if (!response.ok) {
    throw new Error(`Backlog API PATCH ${apiPath} failed (${response.status}): ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as T;
}

export async function listProjects(config: BacklogClientConfig): Promise<BacklogProjectSummary[]> {
  return backlogGet<BacklogProjectSummary[]>(config, '/api/v2/projects');
}

export async function listIssueTypes(config: BacklogClientConfig, projectIdOrKey: string | number): Promise<BacklogIssueType[]> {
  return backlogGet<BacklogIssueType[]>(config, `/api/v2/projects/${projectIdOrKey}/issueTypes`);
}

export async function listPriorities(config: BacklogClientConfig): Promise<BacklogPriority[]> {
  return backlogGet<BacklogPriority[]>(config, '/api/v2/priorities');
}

/**
 * Picks the "Bug" issue type of a project by name (case-insensitive; also matches the Vietnamese
 * "Lỗi"). Falls back to the first type, since every project can name its issue types differently.
 */
export function pickBugIssueType(issueTypes: BacklogIssueType[]): BacklogIssueType | undefined {
  if (issueTypes.length === 0) return undefined;
  const match = issueTypes.find((t) => /bug|lỗi|defect/i.test(t.name));
  return match ?? issueTypes[0];
}

/** Prefers a priority named "Normal"/"Medium" (or Vietnamese "Trung bình"), else the first one. */
export function pickDefaultPriority(priorities: BacklogPriority[]): BacklogPriority | undefined {
  if (priorities.length === 0) return undefined;
  const match = priorities.find((p) => /normal|trung bình|medium/i.test(p.name));
  return match ?? priorities[0];
}

/** Uploads a file to the space's attachment area and returns its id. Backlog requires this two-step
 * flow: attach the returned id when creating or updating the issue. */
export async function uploadAttachment(config: BacklogClientConfig, filePath: string): Promise<BacklogAttachment> {
  const doFetch = config.fetchImpl ?? fetch;
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([fileBuffer]), path.basename(filePath));

  const url = buildUrl(config, '/api/v2/space/attachment');
  const response = await doFetch(url, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`Backlog API upload attachment failed (${response.status}): ${await readErrorMessage(response)}`);
  }
  return (await response.json()) as BacklogAttachment;
}

export interface CreateIssueParams {
  projectId: number;
  summary: string;
  issueTypeId: number;
  priorityId: number;
  description: string;
  attachmentIds?: number[];
}

export async function createIssue(config: BacklogClientConfig, params: CreateIssueParams): Promise<BacklogIssue> {
  const form = new URLSearchParams();
  form.set('projectId', String(params.projectId));
  form.set('summary', params.summary);
  form.set('issueTypeId', String(params.issueTypeId));
  form.set('priorityId', String(params.priorityId));
  form.set('description', params.description);
  for (const id of params.attachmentIds ?? []) {
    form.append('attachmentId[]', String(id));
  }
  return backlogPostForm<BacklogIssue>(config, '/api/v2/issues', form);
}

export interface UpdateIssueParams {
  issueIdOrKey: string | number;
  description: string;
  attachmentIds?: number[];
}

/** Re-uploads a bug that already has an issue: updates that issue instead of creating a duplicate. */
export async function updateIssue(config: BacklogClientConfig, params: UpdateIssueParams): Promise<BacklogIssue> {
  const form = new URLSearchParams();
  form.set('description', params.description);
  for (const id of params.attachmentIds ?? []) {
    form.append('attachmentId[]', String(id));
  }
  return backlogPatchForm<BacklogIssue>(config, `/api/v2/issues/${params.issueIdOrKey}`, form);
}

/** Browser URL of an issue. `baseUrl` is the full space URL (from backlogBaseUrl). */
export function buildIssueUrl(baseUrl: string, issueKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/view/${issueKey}`;
}

/** Browser URL of a project page. */
export function buildProjectUrl(baseUrl: string, projectKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/projects/${projectKey}`;
}

/** Total issue count of a project. GET /api/v2/projects/:id doesn't include it, so this calls the
 * issue count endpoint. */
export async function getIssueCount(config: BacklogClientConfig, projectId: number): Promise<number> {
  const result = await backlogGet<{ count: number }>(config, '/api/v2/issues/count', { 'projectId[]': String(projectId) });
  return result.count;
}
