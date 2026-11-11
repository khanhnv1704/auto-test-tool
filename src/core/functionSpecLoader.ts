import { diffByHash } from './hash';
import { ApiEndpoint, DiffResult, FunctionField, FunctionSpec, HashDiff } from '../types';

type BusinessRuleMode = 'none' | 'functional' | 'non-functional';

interface InProgressEndpoint {
  key: string;
  method: string;
  path: string;
  auth: boolean;
  requestFields: string[];
  responses: Record<string, string>;
  mode: 'none' | 'requestBody' | 'responses';
}

function parseFieldLine(line: string): FunctionField {
  const parts = line
    .replace(/^-\s*/, '')
    .split('|')
    .map((p) => p.trim());
  const [name, type, requiredRaw, ...rest] = parts;

  let constraint: string | undefined;
  let showIf: string | undefined;
  for (const part of rest) {
    if (/^showIf:/i.test(part)) {
      showIf = part.replace(/^showIf:\s*/i, '').trim();
    } else if (part) {
      constraint = constraint ? `${constraint}, ${part}` : part;
    }
  }

  return { name, type: type ?? '', required: /^required$/i.test(requiredRaw ?? ''), constraint, showIf };
}

function extractFunctionId(content: string): string {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('# Function:')) {
      return line.slice('# Function:'.length).trim();
    }
  }
  return 'function';
}

export interface UserRequirement {
  functionId: string;
  screenUrl: string;
  fields: FunctionField[];
}

/**
 * Parses a "User Requirement" doc: the screen description (fields plus cross-field visibility, e.g. a
 * field shown only for a given Gender) in business/UI terms. Kept separate from the System Requirement
 * (parseSystemRequirement below) so BA and Dev can write the two docs independently. Format:
 *
 *   # Function: <name>
 *   ## Screen
 *   URL: <screen url>
 *   Fields:
 *   - <name> | <type> | required|optional | <constraint>... | showIf: <Field>=<Value>
 */
export function parseUserRequirement(content: string): UserRequirement {
  const functionId = extractFunctionId(content);
  let screenUrl = '';
  const fields: FunctionField[] = [];
  let inScreenSection = false;
  let inFieldsList = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^##\s*Screen/i.test(line)) {
      inScreenSection = true;
      inFieldsList = false;
      continue;
    }
    if (/^##\s/.test(line)) {
      inScreenSection = false;
      continue;
    }
    if (!inScreenSection) continue;

    if (line.startsWith('URL:')) {
      screenUrl = line.slice('URL:'.length).trim();
    } else if (/^Fields:/i.test(line)) {
      inFieldsList = true;
    } else if (inFieldsList && line.startsWith('-')) {
      fields.push(parseFieldLine(line));
    }
  }

  return { functionId, screenUrl, fields };
}

export interface SystemRequirement {
  functionId: string;
  endpoints: ApiEndpoint[];
  functionalRules: string[];
  nonFunctionalRules: string[];
}

/**
 * Parses a "System Requirement" doc: API endpoints plus Business Rules split into Functional and
 * Non-Functional, in dev-facing terms. The split lets the API lane cover more than the UI lane (see
 * buildFunctionApiPrompt/buildFunctionUiPrompt). Format:
 *
 *   # Function: <name>
 *   ## API
 *   Endpoint: <METHOD> <path>
 *   Auth: bearer|none
 *   RequestBody:
 *   - <field>: <description>
 *   Responses:
 *   - <status>: <description>
 *   ## Business Rules
 *   ### Functional
 *   - <rule>
 *   ### Non-Functional
 *   - <rule>
 */
export function parseSystemRequirement(content: string): SystemRequirement {
  const functionId = extractFunctionId(content);
  const endpoints: ApiEndpoint[] = [];
  const functionalRules: string[] = [];
  const nonFunctionalRules: string[] = [];

  type Section = 'none' | 'api' | 'businessRules';
  let section: Section = 'none';
  let ruleMode: BusinessRuleMode = 'none';
  let currentEndpoint: InProgressEndpoint | null = null;

  const flushEndpoint = () => {
    if (!currentEndpoint) return;
    endpoints.push({
      key: currentEndpoint.key,
      method: currentEndpoint.method,
      path: currentEndpoint.path,
      requestBody: { fields: currentEndpoint.requestFields },
      responses: currentEndpoint.responses,
      security: currentEndpoint.auth
    });
    currentEndpoint = null;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^##\s*API/i.test(line)) {
      flushEndpoint();
      section = 'api';
      continue;
    }
    if (/^##\s*Business Rules/i.test(line)) {
      flushEndpoint();
      section = 'businessRules';
      ruleMode = 'none';
      continue;
    }
    if (/^##\s/.test(line)) {
      flushEndpoint();
      section = 'none';
      continue;
    }

    if (section === 'api') {
      if (line.startsWith('Endpoint:')) {
        flushEndpoint();
        const [method, ...pathParts] = line
          .slice('Endpoint:'.length)
          .trim()
          .split(/\s+/);
        const path = pathParts.join(' ');
        currentEndpoint = {
          key: `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          auth: false,
          requestFields: [],
          responses: {},
          mode: 'none'
        };
        continue;
      }
      if (!currentEndpoint) continue;

      if (/^Auth:/i.test(line)) {
        currentEndpoint.auth = !/none/i.test(line.slice('Auth:'.length).trim());
      } else if (/^RequestBody:/i.test(line)) {
        currentEndpoint.mode = 'requestBody';
      } else if (/^Responses:/i.test(line)) {
        currentEndpoint.mode = 'responses';
      } else if (line.startsWith('-') && currentEndpoint.mode === 'requestBody') {
        currentEndpoint.requestFields.push(line.replace(/^-\s*/, ''));
      } else if (line.startsWith('-') && currentEndpoint.mode === 'responses') {
        const match = line.replace(/^-\s*/, '').match(/^(\d{3})\s*:\s*(.*)$/);
        if (match) {
          currentEndpoint.responses[match[1]] = match[2];
        }
      }
      continue;
    }

    if (section === 'businessRules') {
      if (/^###\s*Non-Functional/i.test(line)) {
        ruleMode = 'non-functional';
      } else if (/^###\s*Functional/i.test(line)) {
        ruleMode = 'functional';
      } else if (line.startsWith('-')) {
        const rule = line.replace(/^-\s*/, '');
        if (ruleMode === 'non-functional') {
          nonFunctionalRules.push(rule);
        } else if (ruleMode === 'functional') {
          functionalRules.push(rule);
        }
      }
      continue;
    }
  }

  flushEndpoint();

  return { functionId, endpoints, functionalRules, nonFunctionalRules };
}

/**
 * Merges the User and System Requirement docs into one FunctionSpec for testSuiteGenerator.ts. The docs
 * are separate for authoring; internally they are handled as a single spec.
 */
export function buildFunctionSpec(userRequirementContent: string, systemRequirementContent: string): FunctionSpec {
  const user = parseUserRequirement(userRequirementContent);
  const system = parseSystemRequirement(systemRequirementContent);

  return {
    functionId: user.functionId !== 'function' ? user.functionId : system.functionId,
    screenUrl: user.screenUrl,
    fields: user.fields,
    endpoints: system.endpoints,
    functionalRules: system.functionalRules,
    nonFunctionalRules: system.nonFunctionalRules,
    raw: `${userRequirementContent}\n${systemRequirementContent}`
  };
}

/**
 * Diffs the WHOLE function spec as one unit rather than hashing each field/endpoint like specLoader:
 * cross-field rules (e.g. field A required depending on field B) mean regenerating only the changed
 * field can miss related cases. Any change in either doc (field, endpoint, rule) regenerates the whole
 * function.
 */
export function diffFunctionSpec(
  spec: FunctionSpec,
  previousHashes: Record<string, string>
): DiffResult<FunctionSpec> & Pick<HashDiff, 'newHashes'> {
  const { changedKeys, newHashes } = diffByHash([{ key: spec.functionId, raw: spec.raw }], previousHashes);

  return {
    changed: changedKeys.length ? [spec] : [],
    unchanged: changedKeys.length ? [] : [spec],
    newHashes
  };
}
