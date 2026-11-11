# Examples

Everything you need to try the full AI Auto Test flow (Import -> Sync Test -> Run Tests -> Result) on your own machine in a few minutes.

```
examples/
├── demo-signup-app/              Small Next.js app under test (sign-up form + JSON API)
└── test-cases/
    ├── signup.test-cases.md      50 test cases as Markdown tables (25 UI + 25 API)
    ├── signup.test-cases.xlsx    The same 50 test cases as a multi-sheet Excel workbook
    └── build-xlsx.mjs            Regenerates the .xlsx from the .md
```

## The demo app

`demo-signup-app` is a Next.js (App Router, TypeScript) app with:

- **`/customer-signup`**: a customer sign-up form with 11 fields: full name, date of birth, gender, ID number / citizen ID number (which one is shown depends on the gender), email, phone number, occupation, company name, referral code and a terms checkbox.
- **`POST /api/customers`**: the JSON API behind the form. It needs the header `Authorization: Bearer <TEST_TOKEN>`, re-runs the same validation on the server and also checks the referral code whitelist and uniqueness of email / ID numbers.

The form and the API share one schema (`lib/customerFields.ts`), so the error messages are identical in both places.

### Run it

Requirements: Node.js 20 or later.

```bash
cd examples/demo-signup-app
npm install
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000/customer-signup>. The dev server always uses port 3000.

### Token

`.env.example` contains `TEST_TOKEN=demo-secret-token`. The API rejects any other bearer token with `401 {"error":{"message":"Unauthorized"}}`.

Keep the value `demo-secret-token`: the sign-up page is a plain browser form with no login, so it sends this same demo token itself. If you change `TEST_TOKEN`, the API tests follow the new value but the form will start getting 401 responses.

AI Auto Test reads the token from `.env.local` (or `.env.example`) of the workspace, so you do not have to type it.

Quick check from a terminal:

```bash
curl -s -X POST http://localhost:3000/api/customers \
  -H 'Authorization: Bearer demo-secret-token' \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"A"}'
# {"statusCode":400,"error":"Bad Request","field":"fullName","message":"Full name must be at least 2 characters"}
```

### Validation rules at a glance

| Field | Rule |
|---|---|
| fullName | Required, 2-100 characters, letters and spaces only |
| dateOfBirth | Required, `dd/mm/yyyy` in the API (the form uses a date picker), a real calendar date, not in the future, age 18 or older |
| gender | Required, `MALE` or `FEMALE` |
| idNumber | Shown and required only when gender is `MALE`: 9 or 12 digits. Ignored for `FEMALE` |
| citizenIdNumber | Shown and required only when gender is `FEMALE`: exactly 12 digits. Ignored for `MALE` |
| email | Required, valid format, at most 254 characters (the form input stops at 254), unique |
| phone | Required, starts with `0` or `+84`, then 3/5/7/8/9, then 8 digits (e.g. `0912345678`) |
| occupation | Optional: `EMPLOYEE`, `FREELANCER`, `STUDENT` or `UNEMPLOYED` |
| companyName | Required when occupation is `EMPLOYEE`, at most 150 characters |
| referralCode | Optional, letters and digits, at most 20 characters, must be `WELCOME10` or `FRIEND2026` (server-side check) |
| agreeToTerms | Must be checked / `true` |

Successful sign-ups return `201` with the created customer. Errors return `400` or `409` with `{ "statusCode", "error", "field", "message" }`.

### Seed data and the in-memory store

The API keeps customers in memory. On every start it holds two seeded customers that the duplicate tests rely on:

| Email | Gender | ID number | Citizen ID number |
|---|---|---|---|
| `existing.customer@example.com` | MALE | `111111111111` | - |
| `jane.doe@example.com` | FEMALE | - | `222222222222` |

Every successful sign-up is kept until the server restarts. If a happy-path test registers a fixed email (for example `andrew.nolan@example.com`), running it a second time returns `409 Conflict`. Restart `npm run dev` between runs, or let the generated scripts use unique emails and ID numbers.

### Intentional bugs

None. The current app is meant to pass all 50 test cases, so a run that fails points at the generated script, the environment or the test case itself, not at the app. To see the bug reporting part of the extension, break a rule on purpose, for example change `MIN_AGE` in `lib/customerFields.ts` from 18 to 20, or edit one of the error messages, then run the tests again.

Things that commonly trip up generated scripts (not bugs, but worth knowing):

- **TC08** types `31/02/2024`, but the form uses a native date picker that cannot hold an impossible date. A script has to work around this (for example leave the field invalid/empty), while API08 covers the same rule directly.
- **TC11 / TC13**: the ID number fields are hidden for the other gender, so the script must fill one field, then switch the gender.
- **TC16, TC22, TC24, TC25**: these errors come from the server, so they appear in the alert at the top of the form after submitting, not under the field.

## The test cases

Both files contain the same 50 cases: `TC01`-`TC25` test the form, `API01`-`API25` call the API directly. Cases with the same number cover the same rule at the two layers. Expected messages are quoted exactly as the app shows them.

- **`signup.test-cases.md`**: the heading `# Customer Sign-up - Test Cases` gives the function name (`Customer Sign-up`). Line breaks inside a cell use `<br>`.
- **`signup.test-cases.xlsx`**: a workbook shaped like a typical QA spreadsheet, to show how the importer copes with real files:
  - `Cover` and `Revision History` have no test case table and are skipped.
  - `UI` has a title row and an empty row above the header, plus extra `No.` and `Result` columns that are ignored.
  - `API` puts the header on row 1 with a different column order. Columns are matched by name, not position.

Edit the Markdown and run `node examples/test-cases/build-xlsx.mjs` from the repository root (after `npm install` there) to regenerate the workbook.

## Try the full flow

Requirements: the extension built or installed in VS Code, the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) installed and logged in (`claude` on your PATH), and the demo app running (see above).

1. **Open the app as the workspace.** In VS Code, `File > Open Folder...` and pick `examples/demo-signup-app`. Generated scripts, the Playwright config and results are written into this folder (`.aitest/`, `playwright.config.ts`, `test-results/`; all git-ignored).
2. **Install the Playwright browser** once, in that folder: `npx playwright install chromium`.
3. **Import.** Open the AI Auto Test view in the activity bar and choose Import (or run `AI Auto Test: Import Test Cases (Markdown / Excel)`), then pick one of the files in `examples/test-cases/`:
   - Markdown: creates one function, `Customer Sign-up`, with 50 test cases.
   - Excel: pick the `UI` and `API` sheets (`Cover` and `Revision History` are listed as skipped), then choose **Merge the sheets into one function** to get the same 50 cases in one function, or **One function per sheet** to get `UI` and `API` separately.
4. **Sync Test.** Open the function and click Sync Test. Enter the screen URL `http://localhost:3000/customer-signup` and the API base URL `http://localhost:3000`, pick a model and start. Claude Code writes one Playwright script per test case. Later syncs only regenerate cases whose text changed.
5. **Run Tests.** Run the function. Pass/fail results, screenshots and other evidence appear in the report, where failing cases can be analyzed and turned into bug reports.

To see how changes flow through, edit a case in the Markdown or Excel file, reload it from the source file, and sync again: only that case is regenerated.

## What to expect from the first run

Not every generated script is right the first time, and that is part of the demo. In our runs with the default `haiku` model, about a quarter of the API scripts failed for script reasons, not app reasons:

- The script sent `dateOfBirth` as `1990-01-01` although the API expects `dd/mm/yyyy`.
- The script reused a fixed ID number. The demo API keeps data in memory, so a second run gets `409 Conflict`. Restart the dev server between runs.

Open a failed case and click **Analyze this failure**: the analysis should point at the script, not the app. Fix the test case wording (or the script) and sync again, or switch to a stronger model in the Sync modal.

Context written outside the table (like the notes at the top of `signup.test-cases.md`) is never sent to the LLM. Put what a case needs into its own row.
