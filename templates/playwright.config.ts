import { defineConfig, devices } from '@playwright/test';

// AI Auto Test runs Playwright headed (`--headed`) so the user can watch the browser. Playwright has no
// CLI flag for slowMo, so the extension passes it via AITEST_SLOW_MO; without it, actions are too fast to
// follow. Applied to the `api` project too, since the API lane still uses `page` to render evidence.
const slowMo = Number(process.env.AITEST_SLOW_MO || 0);

// Generated scripts use relative paths (page.goto('/path') / request.post('/path')) and Playwright prepends
// the project's baseURL. It's read from env so each run can target a different environment (e.g. staging)
// without regenerating scripts. Unset env leaves baseURL undefined (Playwright's default).
const webBaseUrl = process.env.AITEST_WEB_BASE_URL;
const apiBaseUrl = process.env.AITEST_API_BASE_URL;

export default defineConfig({
  // Scripts live in `.aitest/functions/<functionId>/generated/*.spec.ts`. testDir covers all functions;
  // the extension narrows each run by passing the function's generated dir as a CLI file argument.
  testDir: '.aitest/functions',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['json', { outputFile: '.aitest/results/report.json' }]],
  projects: [
    // testMatch routes files by their API-/UI- file name prefix, so a run without --project still runs each
    // file in the right project exactly once. `generated/_stale/` (scripts of removed test cases) MUST be
    // excluded: their relative `./support/evidence` import is one level off there, and a single module
    // load error aborts the whole run (0 tests), not just that file.
    {
      name: 'api',
      testMatch: /^(?!.*[\\/]_stale[\\/]).*(^|[\\/])API-.*\.spec\.ts$/,
      use: { baseURL: apiBaseUrl, launchOptions: { slowMo } }
    },
    {
      name: 'ui',
      testMatch: /^(?!.*[\\/]_stale[\\/]).*(^|[\\/])UI-.*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: webBaseUrl,
        screenshot: 'only-on-failure',
        launchOptions: { slowMo }
      }
    }
  ]
});
