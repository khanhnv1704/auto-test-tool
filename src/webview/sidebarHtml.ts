import { nonce } from './popupModal';

/**
 * Sidebar CSS. Backgrounds, borders and text use `--vscode-*` variables so they follow the active theme;
 * only the accent/success/danger colors are fixed so chips and the stepper stay consistent in every theme.
 */
const STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--vscode-sideBar-background);
    color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
    font-size: var(--vscode-font-size, 13px);
    overflow-x: hidden;
  }
  button { font: inherit; color: inherit; cursor: pointer; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  :root {
    --accent: #3b82f6;
    --accent-soft: rgba(59,130,246,.16);
    --success: #22c55e;
    --success-soft: rgba(34,197,94,.16);
    --danger: #ef4444;
    --danger-soft: rgba(239,68,68,.16);
  }

  .header {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 10px;
  }
  .header .title { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }

  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
    border-radius: 4px; border: none; background: transparent; color: var(--vscode-icon-foreground, currentColor);
    padding: 0; flex-shrink: 0;
  }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .icon-btn.danger:hover { color: var(--danger); background: var(--danger-soft); }
  .icon-btn svg, .ico svg { width: 14px; height: 14px; display: block; }
  .ico { display: inline-flex; flex-shrink: 0; }

  .section-head {
    display: flex; align-items: center; gap: 6px; padding: 6px 10px 4px; margin-top: 6px;
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground)); user-select: none;
  }
  .section-head svg { width: 13px; height: 13px; opacity: .8; }
  .section-head .grow { flex: 1; }
  .section-head .icon-btn { width: 19px; height: 19px; }
  .section-head .icon-btn svg { width: 12px; height: 12px; }

  .empty-row { padding: 5px 10px 5px 30px; color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); font-size: 12.3px; }

  .row {
    display: flex; align-items: center; gap: 6px; padding: 5px 8px; margin: 0 4px; border-radius: 4px; cursor: pointer;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row .chev {
    width: 14px; height: 14px; flex-shrink: 0; color: var(--vscode-icon-foreground); transition: transform .12s;
    display: flex; align-items: center; justify-content: center;
  }
  .row .chev.open { transform: rotate(90deg); }
  .row .row-icon { color: var(--accent); }
  .row .row-icon.muted { color: var(--vscode-icon-foreground); opacity: .7; }
  .row .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.6px; }
  .row .count { flex-shrink: 0; font-size: 10.6px; color: var(--vscode-descriptionForeground); }
  .row .actions { display: flex; gap: 2px; flex-shrink: 0; opacity: 0; }
  .row:hover .actions, .row:focus-within .actions { opacity: 1; }
  .row .actions .icon-btn { width: 20px; height: 20px; }
  .row .actions .icon-btn svg { width: 12px; height: 12px; }

  .chip {
    display: inline-flex; align-items: center; gap: 3px; font-size: 9.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .02em; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; white-space: nowrap; border: none;
  }
  .chip svg { width: 9px; height: 9px; }
  .chip.idle { background: var(--vscode-badge-background, rgba(128,128,128,.2)); color: var(--vscode-badge-foreground, var(--vscode-descriptionForeground)); }
  .chip.progress { background: var(--accent-soft); color: var(--accent); }
  .chip.done { background: var(--success-soft); color: var(--success); }
  .chip.warn { background: var(--danger-soft); color: var(--danger); }

  .workflow {
    margin: 2px 6px 8px 30px; padding: 8px 8px 6px; border-radius: 6px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    background: var(--vscode-editor-background);
  }
  .wf-steps { display: flex; align-items: flex-start; }
  .wf-step {
    flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px;
    cursor: pointer; padding: 2px 0; border-radius: 4px; border: none; background: transparent;
  }
  .wf-step:hover .wf-label { color: var(--accent); }
  .wf-circle {
    width: 19px; height: 19px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-size: 8.5px; font-weight: 700; border: 1.5px solid transparent; flex-shrink: 0;
  }
  .wf-circle svg { width: 10px; height: 10px; }
  .wf-step.idle .wf-circle { border-color: var(--vscode-widget-border, var(--vscode-panel-border)); color: var(--vscode-descriptionForeground); }
  .wf-step.progress .wf-circle { background: var(--accent); color: #fff; box-shadow: 0 0 0 3px var(--accent-soft); }
  .wf-step.done .wf-circle { background: var(--success); color: #fff; }
  .wf-step.warn .wf-circle { background: var(--danger); color: #fff; }
  .wf-label {
    font-size: 8px; line-height: 1.15; text-align: center; text-transform: uppercase; letter-spacing: .02em;
    font-weight: 600; color: var(--vscode-descriptionForeground); max-width: 58px;
  }
  .wf-step.progress .wf-label, .wf-step.done .wf-label { color: var(--vscode-foreground); }
  .wf-step.warn .wf-label { color: var(--danger); }
  .wf-connector { flex: 0 0 auto; width: 8px; height: 1.5px; margin: 9px 1px 0; background: var(--vscode-widget-border, var(--vscode-panel-border)); }
  .wf-connector.done { background: var(--success); }

  .wf-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
  .link-btn { background: none; border: none; padding: 0; font-size: 11px; color: var(--accent); }
  .link-btn:hover { text-decoration: underline; }

  .round-list { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--vscode-widget-border, var(--vscode-panel-border)); }
  .round-row { display: flex; align-items: center; gap: 6px; padding: 3px 2px; border-radius: 4px; cursor: pointer; font-size: 11.5px; }
  .round-row:hover { background: var(--vscode-list-hoverBackground); }
  .round-row.pass .r-icon { color: var(--success); }
  .round-row.fail .r-icon { color: var(--danger); }
  .round-row .r-label { flex-shrink: 0; }
  .round-row .r-desc { flex: 1; font-size: 10.5px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .round-row .icon-btn { width: 18px; height: 18px; opacity: 0; }
  .round-row:hover .icon-btn { opacity: 1; }
`;

const SHELL_HTML = `
  <div class="header">
    <span class="title">AI Auto Test</span>
    <button class="icon-btn" id="btn-refresh" title="Refresh">
      <svg viewBox="0 0 16 16" fill="none"><path d="M13 8a5 5 0 10-1.6 3.7M13 4v4h-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>

  <div class="section-head">
    <svg viewBox="0 0 16 16" fill="none"><path d="M2 4h5l1.5 2H14v7H2V4z" stroke="currentColor" stroke-width="1.3"/></svg>
    <span class="grow">Project</span>
  </div>
  <div id="section-project"></div>

  <div class="section-head">
    <svg viewBox="0 0 16 16" fill="none"><path d="M2.5 3.5h4l1 1.5h6v7h-11v-8.5z" stroke="currentColor" stroke-width="1.3"/></svg>
    <span class="grow">Functions</span>
    <button class="icon-btn" id="btn-add-function" title="Add function">
      <svg viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
  </div>
  <div id="section-functions"></div>

  <div class="section-head">
    <svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
    <span class="grow">Test schedules</span>
    <button class="icon-btn" id="btn-add-schedule" title="Add test schedule">
      <svg viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
  </div>
  <div id="section-schedules"></div>

  <div class="section-head">
    <svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.2"/><path d="M8 2.5v1.6M8 11.9v1.6M2.5 8h1.6M11.9 8h1.6M4.2 4.2l1.1 1.1M10.7 10.7l1.1 1.1M11.8 4.2l-1.1 1.1M5.3 10.7l-1.1 1.1" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
    <span class="grow">Settings</span>
  </div>
  <div id="section-settings"></div>
`;

/**
 * Client-side JS for the webview. It is embedded in a TS template literal, so it must not use
 * backticks or `\${}`; build dynamic text with `+` instead.
 */
const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();

  var ICONS = {
    fn: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 3l8 5-8 5V3z" fill="currentColor"/></svg>',
    edit: '<svg viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-8 8H3v-3l8-8z" stroke="currentColor" stroke-width="1.3"/></svg>',
    trash: '<svg viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.6 9h5.8l.6-9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8l3.5 3.5L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    file: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 2h6l3 3v9H4V2z" stroke="currentColor" stroke-width="1.2"/></svg>',
    robot: '<svg viewBox="0 0 16 16" fill="none"><rect x="3" y="5.5" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 5.5V3" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="9" r=".9" fill="currentColor"/><circle cx="10" cy="9" r=".9" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 3l9 5-9 5V3z" fill="currentColor"/></svg>',
    history: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 3a5 5 0 105 5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3l2 1" stroke="currentColor" stroke-width="1.3"/></svg>',
    graph: '<svg viewBox="0 0 16 16" fill="none"><path d="M2.5 13.5V2.5M2.5 13.5h11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M4.5 11l2.5-3 2 2 3.5-4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    link: '<svg viewBox="0 0 16 16" fill="none"><path d="M6.5 9.5l3-3M6 5l1-1a2.5 2.5 0 013.5 3.5l-1 1M10 11l-1 1A2.5 2.5 0 015.5 8.5l1-1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    unlink: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 5.5l5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    calendar: '<svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    plug: '<svg viewBox="0 0 16 16" fill="none"><path d="M6 3v3M10 3v3M4.5 6h7v2a3.5 3.5 0 01-3.5 3.5A3.5 3.5 0 014.5 8V6z" stroke="currentColor" stroke-width="1.2"/><path d="M8 11.5V14" stroke="currentColor" stroke-width="1.2"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
  };

  function icon(name, extraClass) {
    var span = document.createElement('span');
    span.className = 'ico' + (extraClass ? ' ' + extraClass : '');
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === undefined || child === null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  var state = { model: null, expandedFn: {}, expandedRounds: {} };

  function sendCommand(command) {
    var args = Array.prototype.slice.call(arguments, 1);
    vscode.postMessage({ type: 'command', command: command, args: args });
  }

  function requestRefresh() {
    vscode.postMessage({ type: 'ready' });
  }

  function mount(id) {
    var el = document.getElementById(id);
    el.innerHTML = '';
    return el;
  }

  function describeSchedule(s) {
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    if (s.type === 'once') return 'Once ' + s.date + ' ' + s.time;
    if (s.type === 'daily') return 'Daily ' + s.time;
    if (s.type === 'weekly') return 'Weekly ' + days[s.dayOfWeek || 0] + ' ' + s.time;
    if (s.type === 'monthly') return 'Monthly, day ' + s.dayOfMonth + ' ' + s.time;
    return '';
  }

  function stepIconName(key) {
    if (key === 'import') return 'file';
    if (key === 'sync') return 'robot';
    if (key === 'run') return 'play';
    return 'history';
  }

  function stepShortLabel(key) {
    if (key === 'import') return 'Import';
    if (key === 'sync') return 'Sync';
    if (key === 'run') return 'Run';
    return 'Result';
  }

  function renderChip(step) {
    return h('span', { class: 'chip ' + step.tone, title: step.label },
      icon(stepIconName(step.key)),
      document.createTextNode(stepShortLabel(step.key))
    );
  }

  function renderProject(project) {
    var root = mount('section-project');
    root.appendChild(h('div', { class: 'row', tabindex: '0', role: 'button', onclick: function () { sendCommand('aitest.showProjectSetting'); } },
      icon(project ? 'link' : 'unlink', 'row-icon' + (project ? '' : ' muted')),
      h('span', { class: 'label', text: project ? project.projectName : 'No Backlog project connected' }),
      project ? h('span', { class: 'count', text: project.spaceKey + ' · ' + project.projectKey }) : null
    ));
  }

  function toggleFn(id) {
    if (state.expandedFn[id]) delete state.expandedFn[id];
    else state.expandedFn[id] = true;
    render();
  }

  function renderFunctionRow(fn) {
    var expanded = !!state.expandedFn[fn.id];
    var row = h('div', { class: 'row', tabindex: '0', role: 'button', 'aria-expanded': expanded ? 'true' : 'false', onclick: function () { toggleFn(fn.id); } },
      icon('chevron', 'chev' + (expanded ? ' open' : '')),
      icon('fn', 'row-icon'),
      h('span', { class: 'label', text: fn.id }),
      h('span', { class: 'count', text: fn.testCaseCount + (fn.testCaseCount === 1 ? ' case' : ' cases') }),
      renderChip(fn.step),
      h('span', { class: 'actions' },
        h('button', { class: 'icon-btn', title: 'Edit function', onclick: function (e) { e.stopPropagation(); sendCommand('aitest.editFunction', fn.id); } }, icon('edit')),
        h('button', { class: 'icon-btn danger', title: 'Delete function', onclick: function (e) { e.stopPropagation(); sendCommand('aitest.deleteFunction', fn.id); } }, icon('trash'))
      )
    );
    return row;
  }

  function stepTone(idx, currentIdx, currentTone) {
    if (idx < currentIdx) return 'done';
    if (idx > currentIdx) return 'idle';
    return currentTone === 'warn' ? 'warn' : currentTone === 'done' ? 'done' : 'progress';
  }

  function renderWorkflow(fn) {
    var order = ['import', 'sync', 'run', 'result'];
    var steps = [
      { key: 'import', label: 'Import test cases', command: 'aitest.showFunctionTestCases' },
      { key: 'sync', label: 'Sync Test', command: 'aitest.showFunctionTestCases' },
      { key: 'run', label: 'Run Tests', command: 'aitest.runTests' },
      { key: 'result', label: 'Result', command: 'aitest.showSummaryReport' }
    ];
    var currentIdx = order.indexOf(fn.step.key);
    var wrap = h('div', { class: 'workflow' });
    var stepsRow = h('div', { class: 'wf-steps' });

    steps.forEach(function (s, idx) {
      var tone = stepTone(idx, currentIdx, fn.step.tone);
      var circle = h('div', { class: 'wf-circle' });
      if (tone === 'done') circle.appendChild(icon('check'));
      else if (tone === 'warn') circle.textContent = '!';
      else circle.textContent = String(idx + 1).length < 2 ? '0' + (idx + 1) : String(idx + 1);
      stepsRow.appendChild(h('button', { class: 'wf-step ' + tone, type: 'button', title: s.label, onclick: function () {
        sendCommand(s.command, fn.id);
        if (s.key === 'result') { state.expandedRounds[fn.id] = true; render(); }
      } }, circle, h('span', { class: 'wf-label', text: s.label })));
      if (idx < steps.length - 1) stepsRow.appendChild(h('div', { class: 'wf-connector' + (idx < currentIdx ? ' done' : '') }));
    });
    wrap.appendChild(stepsRow);

    wrap.appendChild(h('div', { class: 'wf-foot' },
      renderChip(fn.step),
      h('button', { class: 'link-btn', type: 'button', onclick: function () { sendCommand('aitest.renameFunction', fn.id); } }, 'Rename')
    ));

    if (state.expandedRounds[fn.id]) {
      wrap.appendChild(renderRoundList(fn));
    }

    return wrap;
  }

  function renderRoundList(fn) {
    var box = h('div', { class: 'round-list' });
    box.appendChild(h('div', { class: 'round-row', tabindex: '0', role: 'button', onclick: function () { sendCommand('aitest.showSummaryReport', fn.id); } },
      icon('graph', 'r-icon'),
      h('span', { class: 'r-label', text: 'Summary report' })
    ));
    var rounds = fn.rounds.slice().reverse();
    if (!rounds.length) {
      box.appendChild(h('div', { class: 'empty-row', text: 'No runs yet' }));
    }
    rounds.forEach(function (r) {
      box.appendChild(h('div', { class: 'round-row ' + (r.failed > 0 ? 'fail' : 'pass'), tabindex: '0', role: 'button', onclick: function () { sendCommand('aitest.showReport', fn.id, r.round); } },
        icon(r.failed > 0 ? 'error' : 'check', 'r-icon'),
        h('span', { class: 'r-label', text: 'Round ' + r.round }),
        h('span', { class: 'r-desc', text: r.passed + '/' + r.total + ' pass, ' + r.failed + ' fail' }),
        h('button', { class: 'icon-btn danger', title: 'Delete round', onclick: function (e) { e.stopPropagation(); sendCommand('aitest.deleteRound', fn.id, r.round); } }, icon('trash'))
      ));
    });
    return box;
  }

  function renderFunctions(functions) {
    var root = mount('section-functions');
    if (!functions.length) {
      root.appendChild(h('div', { class: 'empty-row', text: 'No functions yet. Click ➕ to add one.' }));
      return;
    }
    functions.forEach(function (fn) {
      root.appendChild(renderFunctionRow(fn));
      if (state.expandedFn[fn.id]) root.appendChild(renderWorkflow(fn));
    });
  }

  function renderSchedules(schedules) {
    var root = mount('section-schedules');
    if (!schedules.length) {
      root.appendChild(h('div', { class: 'empty-row', text: 'No schedules yet. Click ➕ to add one.' }));
      return;
    }
    schedules.forEach(function (s) {
      root.appendChild(h('div', { class: 'row', tabindex: '0', role: 'button', onclick: function () { sendCommand('aitest.editSchedule', s.id); } },
        icon('calendar', 'row-icon'),
        h('span', { class: 'label', text: s.functionId }),
        h('span', { class: 'count', text: describeSchedule(s) }),
        h('span', { class: 'actions' },
          h('button', { class: 'icon-btn', title: 'Edit schedule', onclick: function (e) { e.stopPropagation(); sendCommand('aitest.editSchedule', s.id); } }, icon('edit')),
          h('button', { class: 'icon-btn danger', title: 'Delete schedule', onclick: function (e) { e.stopPropagation(); sendCommand('aitest.deleteSchedule', s.id); } }, icon('trash'))
        )
      ));
    });
  }

  function renderSettings(settings) {
    var root = mount('section-settings');
    root.appendChild(h('div', { class: 'row', tabindex: '0', role: 'button', onclick: function () { sendCommand('aitest.changeDefaultModel'); } },
      icon('robot', 'row-icon'),
      h('span', { class: 'label', text: 'Default AI model' }),
      h('span', { class: 'count', text: settings.modelLabel })
    ));
    root.appendChild(h('div', { class: 'row', tabindex: '0', role: 'button', onclick: function () { sendCommand('aitest.openMcpSetting'); } },
      icon('plug', 'row-icon'),
      h('span', { class: 'label', text: 'Integrations' }),
      h('span', { class: 'count', text: settings.backlogConnected ? '1 connected' : 'not connected' })
    ));
  }

  function render() {
    if (!state.model) return;
    renderProject(state.model.project);
    renderFunctions(state.model.functions);
    renderSchedules(state.model.schedules);
    renderSettings(state.model.settings);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = e.target.closest ? e.target.closest('[role="button"][tabindex]') : null;
    if (el) { e.preventDefault(); el.click(); }
  });

  document.getElementById('btn-refresh').addEventListener('click', requestRefresh);
  document.getElementById('btn-add-function').addEventListener('click', function () { sendCommand('aitest.addFunction'); });
  document.getElementById('btn-add-schedule').addEventListener('click', function () { sendCommand('aitest.addSchedule'); });

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg && msg.type === 'model') {
      state.model = msg.model;
      render();
    }
  });

  requestRefresh();
})();
`;

export function getSidebarHtml(): string {
  const n = nonce();
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';" />
    <style>${STYLE}</style>
  </head>
  <body>
    ${SHELL_HTML}
    <script nonce="${n}">${SCRIPT}</script>
  </body>
  </html>`;
}
