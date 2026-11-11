// Generated and overwritten by AI Auto Test on every "Generate Tests" — do NOT edit by hand, changes will
// be lost on the next generate. The source lives in the extension's templates/evidence.ts.
//
// Evidence helpers for the UI and API lanes: outline in red the item being asserted and print the test
// case's note on the image, so each screenshot is self-explanatory.
import * as fs from 'fs';
import * as path from 'path';
import type { Locator, Page, APIResponse, TestInfo } from '@playwright/test';

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'evidence';
}

// functionId and round can't be derived from this file's location (the same copy serves every round), so
// they come from AITEST_FUNCTION_ID/AITEST_ROUND set by the extension when spawning Playwright. Mirrors
// roundResultsDir() in liveReporter.js (a custom reporter, so the two can't share code).
function evidenceDir(tcId: string): string {
  const dir = path.join(
    process.cwd(),
    '.aitest',
    'functions',
    process.env.AITEST_FUNCTION_ID || '_unknown',
    'results',
    `round-${process.env.AITEST_ROUND || '0'}`,
    'evidence',
    sanitizeFileName(tcId)
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEvidenceNote(dir: string, testTitle: string, note: string, screenshotPath: string): void {
  const notePath = path.join(dir, 'result.md');
  const line = `## ${testTitle}\n\n- To confirm: ${note}\n- Evidence screenshot: ${path.basename(screenshotPath)}\n\n`;
  fs.appendFileSync(notePath, line);
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ApiEvidenceHtmlInput {
  method: string;
  url: string;
  status: number;
  body: string;
  /** Request body sent, shown above the response so the evidence is self-contained. Empty/'-' when the
   * request has no body (e.g. GET). */
  requestBody?: string;
  /** "status" to highlight the status code, or a response body field path (e.g. "error.message"; its last segment is matched) to highlight that value. */
  highlightField: string;
  note: string;
}

/**
 * Renders an API request/response as a minimal HTML page with the asserted part highlighted in red.
 * Pure function (no Playwright), so it can be unit tested without a browser.
 */
export function renderApiEvidenceHtml(input: ApiEvidenceHtmlInput): string {
  const { method, url, status, body, requestBody, highlightField, note } = input;
  const isStatusHighlight = highlightField.trim().toLowerCase() === 'status';
  const leafKey = highlightField.split('.').pop() ?? highlightField;

  const escapedBody = escapeHtml(body);
  const bodyHtml =
    !isStatusHighlight && leafKey
      ? escapedBody.replace(
          new RegExp(`("${escapeRegExp(leafKey)}"\\s*:\\s*[^\\n,}]*)`),
          '<mark>$1</mark>'
        )
      : escapedBody;

  const requestBodySection =
    requestBody && requestBody.trim() && requestBody.trim() !== '-'
      ? `<div class="section-label">Request Body</div><pre class="request">${escapeHtml(requestBody)}</pre>`
      : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  /* "Noto Sans Mono" comes first because default monospace fonts on many Linux machines (e.g. DejaVu Sans
     Mono) lack precomposed glyphs for some accented characters, so diacritics render detached from their
     letters in the screenshot. The UA stylesheet sets pre's font-family directly (it doesn't inherit from
     body), so the stack must be declared on the pre rule too.
  */
  body { font-family: "Noto Sans Mono", ui-monospace, monospace; padding: 16px; background: #fff; color: #111; }
  .meta { margin-bottom: 12px; font-size: 14px; }
  .status { padding: 2px 8px; border-radius: 4px; }
  .status.hl { background: red; color: #fff; border: 2px solid red; font-weight: bold; }
  .note { display: inline-block; background: red; color: #fff; padding: 4px 8px; border-radius: 4px; margin-bottom: 12px; font-size: 13px; }
  .section-label { font-weight: bold; margin: 12px 0 4px; }
  pre { font-family: "Noto Sans Mono", ui-monospace, monospace; border: 3px solid red; padding: 12px; white-space: pre-wrap; word-break: break-word; margin: 0; }
  pre.request { border-color: #888; }
  mark { background: #ffecec; border: 2px solid red; padding: 0 2px; }
</style></head>
<body>
  <div class="meta"><b>${escapeHtml(method)}</b> ${escapeHtml(url)} &rarr; <span class="status${isStatusHighlight ? ' hl' : ''}">${status}</span></div>
  <div class="note">To confirm: ${escapeHtml(note)}</div>
  ${requestBodySection}
  <div class="section-label">Response</div>
  <pre>${bodyHtml}</pre>
</body></html>`;
}

/**
 * UI evidence: outlines the asserted locator's bounding box in red with a note label, takes a screenshot,
 * then removes the overlay so the app's DOM is left untouched.
 */
export async function captureUiEvidence(opts: {
  page: Page;
  testInfo: TestInfo;
  locator: Locator;
  tcId: string;
  testTitle: string;
  note: string;
}): Promise<string> {
  const { page, testInfo, locator, tcId, testTitle, note } = opts;
  // Wait for the page to settle so the screenshot doesn't catch a spinner. Short timeout + catch so pages
  // with long-polling/websockets (never idle) don't hang the capture.
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const box = await locator.boundingBox().catch(() => null);

  if (box) {
    await page.evaluate(
      ({ x, y, width, height, note }) => {
        const highlight = document.createElement('div');
        highlight.setAttribute('data-aitest-evidence', '1');
        Object.assign(highlight.style, {
          position: 'fixed',
          left: `${x - 4}px`,
          top: `${y - 4}px`,
          width: `${width + 8}px`,
          height: `${height + 8}px`,
          border: '3px solid red',
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.25)',
          zIndex: '2147483647',
          pointerEvents: 'none'
        });
        document.body.appendChild(highlight);

        const label = document.createElement('div');
        label.setAttribute('data-aitest-evidence', '1');
        label.textContent = note;
        Object.assign(label.style, {
          position: 'fixed',
          left: `${x}px`,
          top: `${y + height + 6}px`,
          background: 'red',
          color: 'white',
          font: '12px/1.4 sans-serif',
          padding: '2px 6px',
          borderRadius: '3px',
          zIndex: '2147483647',
          maxWidth: '360px'
        });
        document.body.appendChild(label);
      },
      { x: box.x, y: box.y, width: box.width, height: box.height, note }
    );
  }

  const dir = evidenceDir(tcId);
  const screenshotPath = path.join(dir, `${sanitizeFileName(testTitle)}.png`);
  await page.screenshot({ path: screenshotPath });

  await page.evaluate(() => {
    document.querySelectorAll('[data-aitest-evidence]').forEach((el) => el.remove());
  });

  writeEvidenceNote(dir, testTitle, note, screenshotPath);
  await testInfo.attach('evidence', { path: screenshotPath, contentType: 'image/png' });
  return screenshotPath;
}

/**
 * API evidence: there is no UI to highlight, so the request/response is rendered as HTML
 * (renderApiEvidenceHtml) and screenshotted with the `page` fixture. `page` is used purely for rendering,
 * never to call the API or navigate the app (that still goes through request.post/get/...).
 */
export async function captureApiEvidence(opts: {
  page: Page;
  testInfo: TestInfo;
  response: APIResponse;
  /** HTTP method used (e.g. 'POST') — APIResponse doesn't expose it. */
  method: string;
  /** Request body sent (e.g. JSON.stringify(payload)); empty/'-' when there is none (e.g. GET). */
  requestBody?: string;
  tcId: string;
  testTitle: string;
  highlightField: string;
  note: string;
}): Promise<string> {
  const { page, testInfo, response, method, requestBody, tcId, testTitle, highlightField, note } = opts;

  let bodyText: string;
  try {
    bodyText = JSON.stringify(await response.json(), null, 2);
  } catch {
    bodyText = await response.text().catch(() => '');
  }

  const html = renderApiEvidenceHtml({
    method,
    url: response.url(),
    status: response.status(),
    body: bodyText,
    requestBody,
    highlightField,
    note
  });

  await page.setContent(html);

  const dir = evidenceDir(tcId);
  const screenshotPath = path.join(dir, `${sanitizeFileName(testTitle)}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  writeEvidenceNote(dir, testTitle, note, screenshotPath);
  await testInfo.attach('evidence', { path: screenshotPath, contentType: 'image/png' });
  return screenshotPath;
}
