import { ScheduleType } from '../types';
import { escapeHtml, nonce, renderPopupPage } from './popupModal';
import { MainPanel } from './mainPanel';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VIEW_ID = 'scheduleForm';

export interface ScheduleFormData {
  panelTitle: string;
  heading: string;
  /** Known function (editing a schedule, or adding one from a specific function); shown read-only. */
  functionId?: string;
  /** Used only when `functionId` is unknown (➕ on "Test schedules"); rendered as a select. */
  functionOptions?: string[];
  type: ScheduleType;
  time: string;
  date?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
}

export interface ScheduleFormResult {
  functionId: string;
  type: ScheduleType;
  time: string;
  date?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
}

/**
 * Add/edit test schedule form: type, time and day in one modal (see popupModal.ts). The function field
 * is a select only when no function is preselected.
 */
export class ScheduleFormPanel {
  static show(data: ScheduleFormData, onSubmit: (result: ScheduleFormResult) => void): void {
    MainPanel.show(VIEW_ID, data.panelTitle, render(data), (msg: { command?: string } & Partial<ScheduleFormResult>) => {
      if (msg?.command === 'submit' && typeof msg.functionId === 'string' && typeof msg.type === 'string' && typeof msg.time === 'string') {
        onSubmit({
          functionId: msg.functionId,
          type: msg.type as ScheduleType,
          time: msg.time,
          date: msg.date,
          dayOfWeek: msg.dayOfWeek,
          dayOfMonth: msg.dayOfMonth
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

function render(data: ScheduleFormData): string {
  const n = nonce();
  const dayOptionsHtml = DAY_NAMES.map(
    (d, i) => `<option value="${i}" ${i === (data.dayOfWeek ?? 1) ? 'selected' : ''}>${escapeHtml(d)}</option>`
  ).join('');

  const functionFieldHtml = data.functionId
    ? `<div class="field"><label>Function</label><input type="text" value="${escapeHtml(data.functionId)}" disabled /></div>`
    : `<div class="field"><label for="functionId">Function</label><select id="functionId">${(data.functionOptions ?? [])
        .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
        .join('')}</select></div>`;

  const script = `
    (function () {
      var vscode = acquireVsCodeApi();
      var fixedFunctionId = ${data.functionId ? JSON.stringify(data.functionId) : 'null'};
      var typeSelect = document.getElementById('type');
      var extraField = document.getElementById('extra-field');
      var submitButton = document.getElementById('submit-button');
      var errorEl = document.getElementById('form-error');

      function renderExtraField() {
        var type = typeSelect.value;
        if (type === 'once') {
          extraField.innerHTML = '<div class="field"><label for="date">Run date</label><input id="date" type="date" value="${escapeHtml(data.date ?? '')}" /></div>';
        } else if (type === 'weekly') {
          extraField.innerHTML = '<div class="field"><label for="dayOfWeek">Day of week</label><select id="dayOfWeek">${dayOptionsHtml}</select></div>';
        } else if (type === 'monthly') {
          extraField.innerHTML = '<div class="field"><label for="dayOfMonth">Day of month (1-31)</label><input id="dayOfMonth" type="number" min="1" max="31" value="${data.dayOfMonth ?? 1}" /></div>';
        } else {
          extraField.innerHTML = '';
        }
      }

      typeSelect.addEventListener('change', renderExtraField);
      renderExtraField();

      submitButton.addEventListener('click', function () {
        var functionId = fixedFunctionId || document.getElementById('functionId').value;
        if (!functionId) { errorEl.textContent = 'Select a function'; return; }

        var time = document.getElementById('time').value;
        if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(time)) {
          errorEl.textContent = 'Invalid time (use HH:mm)';
          return;
        }

        var type = typeSelect.value;
        var payload = { command: 'submit', functionId: functionId, type: type, time: time };
        if (type === 'once') {
          var date = document.getElementById('date').value;
          if (!date) { errorEl.textContent = 'Select a run date'; return; }
          payload.date = date;
        } else if (type === 'weekly') {
          payload.dayOfWeek = parseInt(document.getElementById('dayOfWeek').value, 10);
        } else if (type === 'monthly') {
          payload.dayOfMonth = parseInt(document.getElementById('dayOfMonth').value, 10);
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
    <h3>${escapeHtml(data.heading)} <button id="close-button" class="btn icon-close-btn" title="Close">✕</button></h3>
    ${functionFieldHtml}
    <div class="field-row">
      <div class="field">
        <label for="type">Schedule type</label>
        <select id="type">
          <option value="once" ${data.type === 'once' ? 'selected' : ''}>Once</option>
          <option value="daily" ${data.type === 'daily' ? 'selected' : ''}>Daily</option>
          <option value="weekly" ${data.type === 'weekly' ? 'selected' : ''}>Weekly</option>
          <option value="monthly" ${data.type === 'monthly' ? 'selected' : ''}>Monthly</option>
        </select>
      </div>
      <div class="field">
        <label for="time">Time</label>
        <input id="time" type="time" value="${escapeHtml(data.time)}" />
      </div>
    </div>
    <div id="extra-field"></div>
    <div id="form-error"></div>
    <div class="modal-footer">
      <button id="cancel-button" class="btn">Cancel</button>
      <button id="submit-button" class="btn primary">📅 Save schedule</button>
    </div>`;

  return renderPopupPage(n, inner, script);
}
