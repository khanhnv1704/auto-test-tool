import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanScreenFields } from './domScanner';
import { FunctionField } from '../types';

const HTML_FIXTURE = `<!doctype html>
<html>
<body>
  <form>
    <label for="customerType">Customer type</label>
    <select id="customerType">
      <option value="">-- Select --</option>
      <option value="INDIVIDUAL">Individual</option>
      <option value="COMPANY">Company</option>
    </select>

    <label for="agree">I agree to the terms</label>
    <input id="agree" type="checkbox" />

    <label for="idNumber">ID number</label>
    <input id="idNumber" type="text" style="display: none" />
  </form>
  <script>
    // "ID number" is only shown when Customer type = Individual (showIf).
    document.getElementById('customerType').addEventListener('change', (e) => {
      const idField = document.getElementById('idNumber');
      idField.style.display = e.target.value === 'INDIVIDUAL' ? '' : 'none';
    });
  </script>
</body>
</html>`;

describe('scanScreenFields', () => {
  let fixturePath: string;
  let fixtureUrl: string;

  beforeAll(() => {
    fixturePath = path.join(os.tmpdir(), `dom-scan-fixture-${process.pid}.html`);
    fs.writeFileSync(fixturePath, HTML_FIXTURE);
    fixtureUrl = `file://${fixturePath}`;
  });

  afterAll(() => {
    fs.rmSync(fixturePath, { force: true });
  });

  it('describes a <select> field with its options', async () => {
    const fields: FunctionField[] = [{ name: 'Customer type', type: 'enum(Individual,Company)', required: true }];
    const hints = await scanScreenFields(fixtureUrl, fields);
    expect(hints['Customer type']).toContain('<select>');
    expect(hints['Customer type']).toContain('Individual');
    expect(hints['Customer type']).toContain('Company');
  });

  it('describes a checkbox field', async () => {
    const fields: FunctionField[] = [{ name: 'I agree to the terms', type: 'boolean', required: true }];
    const hints = await scanScreenFields(fixtureUrl, fields);
    expect(hints['I agree to the terms']).toContain('checkbox');
  });

  it('scans a conditional field by first setting its trigger value', async () => {
    const fields: FunctionField[] = [
      { name: 'Customer type', type: 'enum(Individual,Company)', required: true },
      { name: 'ID number', type: 'text', required: true, showIf: 'Customer type=Individual' }
    ];
    const hints = await scanScreenFields(fixtureUrl, fields);
    expect(hints['ID number']).toContain('<input type="text">');
  });

  it('resolves to {} without throwing when the screen fails to load', async () => {
    const fields: FunctionField[] = [{ name: 'Customer type', type: 'enum(Individual,Company)', required: true }];
    const hints = await scanScreenFields('file:///nonexistent/path/does-not-exist.html', fields);
    expect(hints).toEqual({});
  });
});

// Mimics the DOM of a Radix UI custom combobox (e.g. shadcn/ui Select): the trigger is a
// <button role="combobox"> (not a native <select>), and the role="listbox"/"option" elements only
// appear after it is clicked open, like Radix rendering through a portal.
const COMBOBOX_HTML_FIXTURE = `<!doctype html>
<html>
<body>
  <form>
    <label for="customerType">Customer type</label>
    <button id="customerType" type="button" role="combobox" aria-expanded="false">-- Select --</button>
    <div id="listbox-container"></div>

    <label for="idNumber">ID number</label>
    <input id="idNumber" type="text" style="display: none" />
  </form>
  <script>
    var trigger = document.getElementById('customerType');
    var container = document.getElementById('listbox-container');
    var idField = document.getElementById('idNumber');

    function openListbox() {
      container.innerHTML = '<div role="listbox"><div role="option">Individual</div><div role="option">Company</div></div>';
      trigger.setAttribute('aria-expanded', 'true');
      container.querySelectorAll('[role="option"]').forEach(function (opt) {
        opt.addEventListener('click', function () {
          trigger.textContent = opt.textContent;
          closeListbox();
          idField.style.display = opt.textContent === 'Individual' ? '' : 'none';
        });
      });
    }
    function closeListbox() {
      container.innerHTML = '';
      trigger.setAttribute('aria-expanded', 'false');
    }
    trigger.addEventListener('click', function () {
      if (trigger.getAttribute('aria-expanded') === 'true') closeListbox();
      else openListbox();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeListbox();
    });
  </script>
</body>
</html>`;

describe('scanScreenFields — custom combobox (role="combobox", e.g. shadcn/ui Select)', () => {
  let fixturePath: string;
  let fixtureUrl: string;

  beforeAll(() => {
    fixturePath = path.join(os.tmpdir(), `dom-scan-combobox-fixture-${process.pid}.html`);
    fs.writeFileSync(fixturePath, COMBOBOX_HTML_FIXTURE);
    fixtureUrl = `file://${fixturePath}`;
  });

  afterAll(() => {
    fs.rmSync(fixturePath, { force: true });
  });

  it('describes it as a combobox (not a native <select>) and reads its options by opening it', async () => {
    const fields: FunctionField[] = [{ name: 'Customer type', type: 'enum(Individual,Company)', required: true }];
    const hints = await scanScreenFields(fixtureUrl, fields);
    expect(hints['Customer type']).toContain('custom combobox');
    expect(hints['Customer type']).toContain('do NOT use .selectOption()');
    expect(hints['Customer type']).toContain('Individual');
    expect(hints['Customer type']).toContain('Company');
  });

  it('scans a field conditional on a combobox value by clicking the trigger then the option', async () => {
    const fields: FunctionField[] = [
      { name: 'Customer type', type: 'enum(Individual,Company)', required: true },
      { name: 'ID number', type: 'text', required: true, showIf: 'Customer type=Individual' }
    ];
    const hints = await scanScreenFields(fixtureUrl, fields);
    expect(hints['ID number']).toContain('<input type="text">');
  });
});
