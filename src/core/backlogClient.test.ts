import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  backlogBaseUrl,
  buildIssueUrl,
  buildProjectUrl,
  pickBugIssueType,
  pickDefaultPriority,
  listProjects,
  listIssueTypes,
  listPriorities,
  createIssue,
  updateIssue,
  getIssueCount,
  uploadAttachment,
  BacklogClientConfig
} from './backlogClient';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body
  } as unknown as Response;
}

describe('backlogBaseUrl', () => {
  it('builds the international .backlog.com domain from the space key by default', () => {
    expect(backlogBaseUrl('example')).toBe('https://example.backlog.com');
  });

  it('uses the override verbatim (minus trailing slashes) when given', () => {
    expect(backlogBaseUrl('example', 'https://example.backlogtool.com/')).toBe('https://example.backlogtool.com');
  });
});

describe('buildIssueUrl', () => {
  it('appends /view/<issueKey> to the base url', () => {
    expect(buildIssueUrl('https://example.backlog.com', 'DEMO-42')).toBe('https://example.backlog.com/view/DEMO-42');
  });

  it('tolerates a trailing slash on the base url', () => {
    expect(buildIssueUrl('https://example.backlog.com/', 'DEMO-42')).toBe('https://example.backlog.com/view/DEMO-42');
  });
});

describe('buildProjectUrl', () => {
  it('appends /projects/<projectKey> to the base url', () => {
    expect(buildProjectUrl('https://example.backlog.com', 'DEMO')).toBe('https://example.backlog.com/projects/DEMO');
  });

  it('tolerates a trailing slash on the base url', () => {
    expect(buildProjectUrl('https://example.backlog.com/', 'DEMO')).toBe('https://example.backlog.com/projects/DEMO');
  });
});

describe('pickBugIssueType', () => {
  it('returns undefined for an empty list', () => {
    expect(pickBugIssueType([])).toBeUndefined();
  });

  it('prefers an issue type whose name matches "bug" (case-insensitive)', () => {
    const types = [{ id: 1, name: 'Task' }, { id: 2, name: 'Bug' }, { id: 3, name: 'Feature' }];
    expect(pickBugIssueType(types)?.id).toBe(2);
  });

  it('falls back to the first item when nothing matches', () => {
    const types = [{ id: 1, name: 'Task' }, { id: 2, name: 'Feature' }];
    expect(pickBugIssueType(types)?.id).toBe(1);
  });
});

describe('pickDefaultPriority', () => {
  it('prefers a priority named "Normal"', () => {
    const priorities = [{ id: 1, name: 'High' }, { id: 2, name: 'Normal' }, { id: 3, name: 'Low' }];
    expect(pickDefaultPriority(priorities)?.id).toBe(2);
  });

  it('falls back to the first item when nothing matches', () => {
    const priorities = [{ id: 1, name: 'High' }, { id: 3, name: 'Low' }];
    expect(pickDefaultPriority(priorities)?.id).toBe(1);
  });
});

function makeConfig(fetchImpl: BacklogClientConfig['fetchImpl']): BacklogClientConfig {
  return { baseUrl: 'https://example.backlog.com', apiKey: 'secret', fetchImpl };
}

describe('listProjects / listIssueTypes / listPriorities', () => {
  it('GETs the expected path with apiKey as a query param, and returns the parsed body', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/v2/projects');
      expect(url).toContain('apiKey=secret');
      return jsonResponse([{ id: 1, projectKey: 'DEMO', name: 'AI Auto Test' }]);
    });

    const result = await listProjects(makeConfig(fetchImpl as never));
    expect(result).toEqual([{ id: 1, projectKey: 'DEMO', name: 'AI Auto Test' }]);
  });

  it('listIssueTypes hits the per-project issueTypes endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/v2/projects/12345/issueTypes');
      return jsonResponse([{ id: 2, name: 'Bug' }]);
    });
    const result = await listIssueTypes(makeConfig(fetchImpl as never), 12345);
    expect(result).toEqual([{ id: 2, name: 'Bug' }]);
  });

  it('listPriorities hits the space-wide priorities endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/v2/priorities');
      return jsonResponse([{ id: 3, name: 'Normal' }]);
    });
    const result = await listPriorities(makeConfig(fetchImpl as never));
    expect(result).toEqual([{ id: 3, name: 'Normal' }]);
  });

  it('throws a readable error combining Backlog\'s error messages on a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'Invalid API key' }] }, false, 401));
    await expect(listProjects(makeConfig(fetchImpl as never))).rejects.toThrow(/Invalid API key/);
  });
});

describe('createIssue', () => {
  it('POSTs form-urlencoded body (not JSON) with the required fields', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/api/v2/issues');
      expect((init?.headers as Record<string, string>)?.['Content-Type']).toBe('application/x-www-form-urlencoded');
      const body = new URLSearchParams(init?.body as string);
      expect(body.get('projectId')).toBe('12345');
      expect(body.get('summary')).toBe('Bug: something broke');
      expect(body.get('issueTypeId')).toBe('2');
      expect(body.get('priorityId')).toBe('3');
      expect(body.getAll('attachmentId[]')).toEqual(['10', '11']);
      return jsonResponse({ id: 999, issueKey: 'DEMO-42' });
    });

    const result = await createIssue(makeConfig(fetchImpl as never), {
      projectId: 12345,
      summary: 'Bug: something broke',
      issueTypeId: 2,
      priorityId: 3,
      description: 'details',
      attachmentIds: [10, 11]
    });
    expect(result).toEqual({ id: 999, issueKey: 'DEMO-42' });
  });

  it('omits attachmentId[] entirely when no attachments are given', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      expect(body.getAll('attachmentId[]')).toEqual([]);
      return jsonResponse({ id: 1, issueKey: 'DEMO-1' });
    });

    await createIssue(makeConfig(fetchImpl as never), {
      projectId: 1,
      summary: 's',
      issueTypeId: 1,
      priorityId: 1,
      description: 'd'
    });
  });
});

describe('updateIssue', () => {
  it('PATCHes form-urlencoded body to the issue path (no projectId/summary — only description/attachments change)', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/api/v2/issues/DEMO-42');
      expect(init?.method).toBe('PATCH');
      expect((init?.headers as Record<string, string>)?.['Content-Type']).toBe('application/x-www-form-urlencoded');
      const body = new URLSearchParams(init?.body as string);
      expect(body.get('description')).toBe('updated details');
      expect(body.getAll('attachmentId[]')).toEqual(['20']);
      return jsonResponse({ id: 999, issueKey: 'DEMO-42' });
    });

    const result = await updateIssue(makeConfig(fetchImpl as never), {
      issueIdOrKey: 'DEMO-42',
      description: 'updated details',
      attachmentIds: [20]
    });
    expect(result).toEqual({ id: 999, issueKey: 'DEMO-42' });
  });

  it('throws a readable error on a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'No such issue' }] }, false, 404));
    await expect(updateIssue(makeConfig(fetchImpl as never), { issueIdOrKey: 'DEMO-999', description: 'x' })).rejects.toThrow(
      /No such issue/
    );
  });
});

describe('getIssueCount', () => {
  it('GETs the issue count endpoint with projectId[] and returns the count', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/v2/issues/count');
      expect(url).toContain('projectId%5B%5D=12345');
      return jsonResponse({ count: 128 });
    });

    const result = await getIssueCount(makeConfig(fetchImpl as never), 12345);
    expect(result).toBe(128);
  });
});

describe('uploadAttachment', () => {
  it('uploads the file as multipart form data and returns the attachment id', async () => {
    const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-backlog-')), 'evidence.png');
    fs.writeFileSync(tmpFile, Buffer.from('fake-png-bytes'));

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/api/v2/space/attachment');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      return jsonResponse({ id: 7, name: 'evidence.png' });
    });

    const result = await uploadAttachment(makeConfig(fetchImpl as never), tmpFile);
    expect(result).toEqual({ id: 7, name: 'evidence.png' });
  });
});
