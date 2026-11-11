import { escapeHtml, nonce, renderPopupPage } from './popupModal';
import { MainPanel } from './mainPanel';

function viewId(panelKey: string): string {
  return `simpleForm:${panelKey}`;
}

export interface SimpleFormField {
  id: string;
  label: string;
  type: 'text' | 'password' | 'select' | 'textarea';
  value?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Only for type='select'. */
  options?: { value: string; label: string }[];
  hint?: string;
  /** Client-side validation regex source, without delimiters (e.g. '^https?://'). */
  pattern?: string;
  patternMessage?: string;
  /** Values that are not allowed (e.g. existing function ids); compared after trimming. */
  forbiddenValues?: string[];
  forbiddenMessage?: string;
}

export interface SimpleFormData {
  /** View key that distinguishes different forms (function/schedule/backlog...). */
  panelKey: string;
  /** Webview tab title (not the `heading` shown in the modal). */
  panelTitle: string;
  heading: string;
  subtitle?: string;
  fields: SimpleFormField[];
  submitLabel: string;
  /** Optional left-aligned secondary button (e.g. "Disconnect"), apart from Cancel/Submit. */
  dangerLabel?: string;
  wide?: boolean;
}

/**
 * Generic popup for static forms (no fields that depend on other fields): add/edit/rename function,
 * default AI model, Backlog credentials/project, etc. Shown through MainPanel in the shared tab;
 * `panelKey` only identifies which view is current.
 */
export class SimpleFormPanel {
  static show(
    data: SimpleFormData,
    onSubmit: (values: Record<string, string>) => void,
    onDanger?: () => void
  ): void {
    const id = viewId(data.panelKey);
    MainPanel.show(id, data.panelTitle, render(data), (msg: { command?: string; values?: Record<string, string> }) => {
      if (msg?.command === 'submit' && msg.values) {
        onSubmit(msg.values);
      } else if (msg?.command === 'danger') {
        onDanger?.();
      } else if (msg?.command === 'cancel') {
        MainPanel.closeIfCurrent(id);
      }
    });
  }

  static close(panelKey: string): void {
    MainPanel.closeIfCurrent(viewId(panelKey));
  }
}

function renderField(f: SimpleFormField): string {
  const hint = f.hint ? `<div class="hint-text">${escapeHtml(f.hint)}</div>` : '';
  if (f.type === 'select') {
    const optionsHtml = (f.options ?? [])
      .map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === f.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)
      .join('');
    return `<div class="field"><label for="${f.id}">${escapeHtml(f.label)}</label><select id="${f.id}" ${f.disabled ? 'disabled' : ''}>${optionsHtml}</select>${hint}</div>`;
  }
  if (f.type === 'textarea') {
    return `<div class="field"><label for="${f.id}">${escapeHtml(f.label)}</label><textarea id="${f.id}" placeholder="${escapeHtml(f.placeholder ?? '')}">${escapeHtml(f.value ?? '')}</textarea>${hint}</div>`;
  }
  return `<div class="field"><label for="${f.id}">${escapeHtml(f.label)}</label><input id="${f.id}" type="${f.type}" value="${escapeHtml(f.value ?? '')}" placeholder="${escapeHtml(f.placeholder ?? '')}" ${f.disabled ? 'disabled' : ''} />${hint}</div>`;
}

function render(data: SimpleFormData): string {
  const n = nonce();
  const fieldsHtml = data.fields.map(renderField).join('');
  const subtitleHtml = data.subtitle ? `<div class="subtitle">${escapeHtml(data.subtitle)}</div>` : '';
  const dangerButtonHtml = data.dangerLabel ? `<button id="danger-button" class="btn danger">${escapeHtml(data.dangerLabel)}</button>` : '';

  const validationsJson = JSON.stringify(
    data.fields.map((f) => ({
      id: f.id,
      required: !!f.required,
      pattern: f.pattern,
      patternMessage: f.patternMessage,
      forbiddenValues: f.forbiddenValues,
      forbiddenMessage: f.forbiddenMessage
    }))
  );

  const script = `
    (function () {
      var vscode = acquireVsCodeApi();
      var validations = ${validationsJson};
      var errorEl = document.getElementById('form-error');

      document.getElementById('submit-button').addEventListener('click', function () {
        var values = {};
        for (var i = 0; i < validations.length; i++) {
          var v = validations[i];
          var el = document.getElementById(v.id);
          var value = el.value.trim();
          if (v.required && !value) {
            errorEl.textContent = 'Required: "' + (el.previousElementSibling ? el.previousElementSibling.textContent : v.id) + '"';
            return;
          }
          if (value && v.pattern && !new RegExp(v.pattern, 'i').test(value)) {
            errorEl.textContent = v.patternMessage || 'Invalid value';
            return;
          }
          if (value && v.forbiddenValues && v.forbiddenValues.indexOf(value) !== -1) {
            errorEl.textContent = v.forbiddenMessage || 'Value already exists';
            return;
          }
          values[v.id] = value;
        }
        errorEl.textContent = '';
        vscode.postMessage({ command: 'submit', values: values });
      });

      var dangerButton = document.getElementById('danger-button');
      if (dangerButton) {
        dangerButton.addEventListener('click', function () {
          vscode.postMessage({ command: 'danger' });
        });
      }

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
    ${subtitleHtml}
    ${fieldsHtml}
    <div id="form-error"></div>
    <div class="modal-footer">
      ${dangerButtonHtml}
      <button id="cancel-button" class="btn">Cancel</button>
      <button id="submit-button" class="btn primary">${escapeHtml(data.submitLabel)}</button>
    </div>`;

  return renderPopupPage(n, inner, script, data.wide);
}
