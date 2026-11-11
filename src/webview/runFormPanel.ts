import { ScheduleType } from '../types';
import { escapeHtml, nonce, renderPopupPage } from './popupModal';
import { MainPanel } from './mainPanel';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VIEW_ID = 'runForm';

export interface RunFormData {
  functionId: string;
  defaultWorkers: number;
  /** Prefilled from the function's meta.screenUrl origin (see resolveRunBaseUrls in extension.ts). */
  defaultWebBaseUrl?: string;
  /** Prefilled from the function's meta.apiBaseUrl (see resolveRunBaseUrls in extension.ts). */
  defaultApiBaseUrl?: string;
}

export type RunMode = 'now' | ScheduleType;

export interface RunFormResult {
  mode: RunMode;
  time: string;
  date?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  workers: number;
  /** Empty means reuse the value saved by the last Sync Test. Set it to point this run at another
   * environment (e.g. staging) without regenerating scripts. */
  webBaseUrl?: string;
  apiBaseUrl?: string;
  /** Show a real browser window (headed) or run headless. Defaults to headed. */
  headed: boolean;
}

/**
 * "▶ Run Tests" form: run now or schedule, with time/day, worker count and base URLs in one modal
 * (see runFunctionTests in extension.ts). `functionId` is fixed by the sidebar row that opened it.
 */
export class RunFormPanel {
  static show(data: RunFormData, onSubmit: (result: RunFormResult) => void): void {
    MainPanel.show(VIEW_ID, 'AI Auto Test — Run Tests', render(data), (msg: { command?: string } & Partial<RunFormResult>) => {
      if (msg?.command === 'submit' && typeof msg.mode === 'string' && typeof msg.workers === 'number') {
        onSubmit({
          mode: msg.mode as RunMode,
          time: msg.time ?? '09:00',
          date: msg.date,
          dayOfWeek: msg.dayOfWeek,
          dayOfMonth: msg.dayOfMonth,
          workers: msg.workers,
          webBaseUrl: msg.webBaseUrl,
          apiBaseUrl: msg.apiBaseUrl,
          headed: msg.headed ?? true
        });
      } else if (msg?.command === 'cancel') {
        MainPanel.closeIfCurrent(VIEW_ID);
      }
    });
  }

  static close(): void {
    MainPanel.closeIfCurrent(VIEW_ID);
  }
}

function render(data: RunFormData): string {
  const n = nonce();
  const dayOptionsHtml = DAY_NAMES.map((d, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('');

  const script = `
    (function () {
      var vscode = acquireVsCodeApi();
      var modeSelect = document.getElementById('mode');
      var timeField = document.getElementById('time-field');
      var extraField = document.getElementById('extra-field');
      var submitButton = document.getElementById('submit-button');
      var errorEl = document.getElementById('form-error');

      function renderModeFields() {
        var mode = modeSelect.value;
        timeField.style.display = mode === 'now' ? 'none' : '';
        if (mode === 'once') {
          extraField.innerHTML = '<div class="field"><label for="date">Run date</label><input id="date" type="date" /></div>';
        } else if (mode === 'weekly') {
          extraField.innerHTML = '<div class="field"><label for="dayOfWeek">Day of week</label><select id="dayOfWeek">${dayOptionsHtml}</select></div>';
        } else if (mode === 'monthly') {
          extraField.innerHTML = '<div class="field"><label for="dayOfMonth">Day of month (1-31)</label><input id="dayOfMonth" type="number" min="1" max="31" value="1" /></div>';
        } else {
          extraField.innerHTML = '';
        }
        submitButton.textContent = mode === 'now' ? '▶ Run now' : '📅 Save schedule';
      }

      modeSelect.addEventListener('change', renderModeFields);
      renderModeFields();

      submitButton.addEventListener('click', function () {
        var mode = modeSelect.value;
        var workersInput = document.getElementById('workers');
        var workers = parseInt(workersInput.value, 10);
        if (!workers || workers < 1) {
          errorEl.textContent = 'Workers must be a positive integer';
          return;
        }

        var webBaseUrl = document.getElementById('webBaseUrl').value.trim();
        var apiBaseUrl = document.getElementById('apiBaseUrl').value.trim();
        if (webBaseUrl && !/^https?:\\/\\//i.test(webBaseUrl)) {
          errorEl.textContent = 'Invalid web base URL (must start with http:// or https://)';
          return;
        }
        if (apiBaseUrl && !/^https?:\\/\\//i.test(apiBaseUrl)) {
          errorEl.textContent = 'Invalid API base URL (must start with http:// or https://)';
          return;
        }

        var payload = {
          command: 'submit',
          mode: mode,
          workers: workers,
          webBaseUrl: webBaseUrl || undefined,
          apiBaseUrl: apiBaseUrl || undefined,
          headed: document.getElementById('headed').checked
        };
        if (mode !== 'now') {
          var time = document.getElementById('time').value;
          if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(time)) {
            errorEl.textContent = 'Invalid time (use HH:mm)';
            return;
          }
          payload.time = time;
          if (mode === 'once') {
            var date = document.getElementById('date').value;
            if (!date) { errorEl.textContent = 'Select a run date'; return; }
            payload.date = date;
          } else if (mode === 'weekly') {
            payload.dayOfWeek = parseInt(document.getElementById('dayOfWeek').value, 10);
          } else if (mode === 'monthly') {
            payload.dayOfMonth = parseInt(document.getElementById('dayOfMonth').value, 10);
          }
        }
        errorEl.textContent = '';
        vscode.postMessage(payload);
      });

      document.getElementById('cancel-button').addEventListener('click', function () {
        vscode.postMessage({ command: 'cancel' });
      });
      document.getElementById('close-button').addEventListener('click', function () {
        vscode.postMessage({ command: 'cancel' });
      });
      document.querySelector('.overlay').addEventListener('click', function (e) {
        if (e.target.classList.contains('overlay')) vscode.postMessage({ command: 'cancel' });
      });
    })();
  `;

  const inner = `
    <h3>▶ Run Tests — ${escapeHtml(data.functionId)} <button id="close-button" class="btn icon-close-btn" title="Close">✕</button></h3>
    <div class="field-row">
      <div class="field">
        <label for="mode">Run</label>
        <select id="mode">
          <option value="now">Run now</option>
          <option value="once">Schedule once</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </div>
      <div class="field" id="time-field">
        <label for="time">Time</label>
        <input id="time" type="time" value="09:00" />
      </div>
    </div>
    <div id="extra-field"></div>
    <div class="field">
      <label for="workers">Parallel workers</label>
      <input id="workers" type="number" min="1" max="8" value="${data.defaultWorkers}" />
      <div class="hint-text">In headed mode each worker opens its own browser window. More workers run faster but are harder to watch at once.</div>
    </div>
    <div class="field">
      <div class="toggle-row">
        <label for="headed" class="field-inline-label">Show browser (headed)</label>
        <label class="switch">
          <input id="headed" type="checkbox" checked />
          <span class="switch-slider"></span>
        </label>
      </div>
      <div class="hint-text">Turn off to run headless: faster, no browser windows, good when you don't need to watch.</div>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="webBaseUrl">Web base URL</label>
        <input id="webBaseUrl" type="text" placeholder="http://localhost:3000" value="${escapeHtml(data.defaultWebBaseUrl ?? '')}" />
      </div>
      <div class="field">
        <label for="apiBaseUrl">API base URL</label>
        <input id="apiBaseUrl" type="text" placeholder="http://localhost:3000" value="${escapeHtml(data.defaultApiBaseUrl ?? '')}" />
      </div>
    </div>
    <div class="hint-text">Defaults come from the last Sync Test. Change them only to run against another environment (e.g. staging) without re-syncing. Test scripts store paths; these base URLs are prepended at run time.</div>
    <div id="form-error"></div>
    <div class="modal-footer">
      <button id="cancel-button" class="btn">Cancel</button>
      <button id="submit-button" class="btn primary">▶ Run now</button>
    </div>`;

  return renderPopupPage(n, inner, script);
}
