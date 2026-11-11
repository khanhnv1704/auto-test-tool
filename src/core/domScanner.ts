import { chromium, Locator, Page } from '@playwright/test';
import { FunctionField } from '../types';

const NAV_TIMEOUT_MS = 15_000;

interface FieldDomInfo {
  tag: string;
  type?: string | null;
  options?: (string | null)[];
  role?: string | null;
}

function describeInfo(info: FieldDomInfo): string {
  if (info.role === 'combobox') {
    const options = (info.options ?? []).filter(Boolean).join(', ');
    return (
      'custom combobox (role="combobox", NOT a native <select>; e.g. a shadcn/ui Select built on ' +
      "Radix UI). Use getByRole('combobox', { name: <field name> }).click() then " +
      "getByRole('option', { name: <value> }).click(); do NOT use .selectOption()" +
      (options ? `. Options: ${options}` : '')
    );
  }
  if (info.tag === 'select') {
    const options = (info.options ?? []).filter(Boolean).join(', ');
    return `native <select> element${options ? `, options: ${options}` : ''}`;
  }
  if (info.tag === 'input' && info.type === 'checkbox') return '<input type="checkbox"> element';
  if (info.tag === 'input' && info.type === 'radio') {
    return `<input type="radio"> element. Use getByRole('radio', { name: <value> }).check()`;
  }
  if (info.tag === 'input') return `<input type="${info.type ?? 'text'}"> element`;
  if (info.role === 'checkbox') {
    return `custom role="checkbox" element (not a native <input>). Use getByRole('checkbox', { name: <field name> }).check()/.uncheck()`;
  }
  if (info.role === 'radio') {
    return `custom role="radio" element (not a native <input>). Use getByRole('radio', { name: <value> }).check()`;
  }
  if (info.role) return `role="${info.role}" element`;
  return `<${info.tag}> element`;
}

/** A custom combobox (e.g. shadcn/ui Select on Radix UI) only renders its options (often via a portal)
 * after it is opened, unlike a native <select>. Open it, read the options, then close it with Escape
 * so later scan/set steps start from a clean state. */
async function readComboboxOptions(page: Page, trigger: Locator): Promise<string[]> {
  try {
    await trigger.click();
    const options = await page.getByRole('option').allTextContents();
    await page.keyboard.press('Escape');
    return options.map((o) => o.trim()).filter(Boolean);
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    return [];
  }
}

async function describeField(page: Page, label: string): Promise<string | undefined> {
  const locator = page.getByLabel(label, { exact: false }).first();
  if ((await locator.count()) === 0) return undefined;

  const info = (await locator.evaluate((el: any) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? el.type : undefined;
    const options = tag === 'select' ? Array.from(el.options).map((o: any) => o.textContent?.trim() ?? null) : undefined;
    const role = el.getAttribute('role');
    return { tag, type, options, role };
  })) as FieldDomInfo;

  if (info.role === 'combobox') {
    info.options = await readComboboxOptions(page, locator);
  }

  return describeInfo(info);
}

/** Sets a trigger field's value (from a "<Field>=<Value>" showIf) so its dependent fields appear in the DOM. */
async function setFieldValue(page: Page, label: string, value: string): Promise<void> {
  const locator = page.getByLabel(label, { exact: false }).first();
  const { tag, role } = await locator.evaluate((el: any) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') }));

  if (role === 'combobox') {
    await locator.click();
    await page.getByRole('option', { name: value, exact: true }).click();
    return;
  }

  if (tag === 'select') {
    await locator.selectOption({ label: value });
    return;
  }

  const radio = page.getByRole('radio', { name: value });
  if ((await radio.count()) > 0) {
    await radio.check();
    return;
  }

  await locator.fill(value);
}

/**
 * Scans the live screen with an in-process Playwright browser to learn which widget each field really
 * renders (select/checkbox/radio/text...), so the LLM doesn't have to guess from a prose type such as
 * "enum(Individual,Company)", which doesn't say whether it is a <select> or a radio group.
 *
 * Never throws: any failure (app not running, browser not installed, field not found...) yields {} and
 * script generation falls back to the spec description alone.
 *
 * Limitation: a field whose showIf trigger is itself hidden (nested conditions) is not scanned.
 */
export async function scanScreenFields(screenUrl: string, fields: FunctionField[]): Promise<Record<string, string>> {
  const hints: Record<string, string> = {};
  if (!screenUrl || fields.length === 0) return hints;

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(screenUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    const unconditional = fields.filter((f) => !f.showIf);
    const conditional = fields.filter((f) => f.showIf);

    for (const field of unconditional) {
      const hint = await describeField(page, field.name);
      if (hint) hints[field.name] = hint;
    }

    const byCondition = new Map<string, FunctionField[]>();
    for (const field of conditional) {
      const group = byCondition.get(field.showIf as string) ?? [];
      group.push(field);
      byCondition.set(field.showIf as string, group);
    }

    for (const [condition, group] of byCondition) {
      const match = condition.match(/^(.+?)=(.+)$/);
      if (!match) continue;
      const triggerName = match[1].trim();
      const triggerValue = match[2].trim();
      try {
        await setFieldValue(page, triggerName, triggerValue);
        for (const field of group) {
          const hint = await describeField(page, field.name);
          if (hint) hints[field.name] = hint;
        }
      } catch {
        // Skip this group: its fields get no domHint and the prompt falls back to the spec description.
      }
    }
  } catch (err) {
    console.warn(`[domScanner] Skipping DOM scan for ${screenUrl} (using the spec description):`, err);
  } finally {
    await browser?.close().catch(() => {});
  }

  return hints;
}
