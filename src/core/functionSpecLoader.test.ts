import { describe, it, expect } from 'vitest';
import { parseUserRequirement, parseSystemRequirement, buildFunctionSpec, diffFunctionSpec } from './functionSpecLoader';

const USER_REQUIREMENT = `
# Function: Customer sign-up

## Screen
URL: http://localhost:3000/customer-signup

Fields:
- Full name | text | required
- Gender | enum(Male,Female) | required
- ID card number | text | required | showIf: Gender=Male
- Citizen ID | text | required | showIf: Gender=Female
- Email | text | required | format=email
`;

const SYSTEM_REQUIREMENT = `
# Function: Customer sign-up

## API
Endpoint: POST /customers
Auth: bearer
RequestBody:
- fullName: string, required
- gender: string, required, enum(MALE,FEMALE)
- idNumber: string, required if gender=MALE
- citizenIdNumber: string, required if gender=FEMALE
Responses:
- 201: Created
- 400: Validation error
- 401: Unauthorized

## Business Rules
### Functional
- idNumber is required when gender=MALE, citizenIdNumber is required when gender=FEMALE
- email must be unique in the system

### Non-Functional
- The API only accepts calls with a valid Bearer token; missing/invalid token → 401
- Text fields (fullName, email...) must be protected against injection (SQL/XSS)
`;

describe('parseUserRequirement', () => {
  it('extracts functionId, screen URL, and fields including conditional showIf', () => {
    const req = parseUserRequirement(USER_REQUIREMENT);
    expect(req.functionId).toBe('Customer sign-up');
    expect(req.screenUrl).toBe('http://localhost:3000/customer-signup');
    expect(req.fields).toHaveLength(5);

    const idCard = req.fields.find((f) => f.name === 'ID card number');
    expect(idCard?.required).toBe(true);
    expect(idCard?.showIf).toBe('Gender=Male');
  });

  it('does not pick up API/Business Rules content even if present in the same file', () => {
    const combined = `${USER_REQUIREMENT}\n${SYSTEM_REQUIREMENT}`;
    const req = parseUserRequirement(combined);
    expect(req.fields).toHaveLength(5);
  });
});

describe('parseSystemRequirement', () => {
  it('parses the API endpoint with auth, request fields, and responses', () => {
    const req = parseSystemRequirement(SYSTEM_REQUIREMENT);
    expect(req.endpoints).toHaveLength(1);

    const [endpoint] = req.endpoints;
    expect(endpoint.key).toBe('POST /customers');
    expect(endpoint.security).toBe(true);
    expect(endpoint.requestBody).toMatchObject({
      fields: expect.arrayContaining(['idNumber: string, required if gender=MALE'])
    });
    expect(endpoint.responses).toMatchObject({ '201': 'Created', '401': 'Unauthorized' });
  });

  it('splits business rules into functional and non-functional', () => {
    const req = parseSystemRequirement(SYSTEM_REQUIREMENT);
    expect(req.functionalRules).toHaveLength(2);
    expect(req.nonFunctionalRules).toHaveLength(2);
    expect(req.nonFunctionalRules[0]).toContain('Bearer token');
  });

  it('marks Auth: none as no security required', () => {
    const req = parseSystemRequirement(SYSTEM_REQUIREMENT.replace('Auth: bearer', 'Auth: none'));
    expect(req.endpoints[0].security).toBe(false);
  });
});

describe('buildFunctionSpec', () => {
  it('merges the user and system requirement documents into 1 FunctionSpec', () => {
    const spec = buildFunctionSpec(USER_REQUIREMENT, SYSTEM_REQUIREMENT);
    expect(spec.functionId).toBe('Customer sign-up');
    expect(spec.screenUrl).toBe('http://localhost:3000/customer-signup');
    expect(spec.fields).toHaveLength(5);
    expect(spec.endpoints).toHaveLength(1);
    expect(spec.functionalRules).toHaveLength(2);
    expect(spec.nonFunctionalRules).toHaveLength(2);
  });
});

describe('diffFunctionSpec', () => {
  it('treats the whole function as changed on first run', () => {
    const spec = buildFunctionSpec(USER_REQUIREMENT, SYSTEM_REQUIREMENT);
    const { changed, unchanged } = diffFunctionSpec(spec, {});
    expect(changed).toHaveLength(1);
    expect(unchanged).toHaveLength(0);
  });

  it('treats the whole function as unchanged when neither document changed', () => {
    const spec = buildFunctionSpec(USER_REQUIREMENT, SYSTEM_REQUIREMENT);
    const first = diffFunctionSpec(spec, {});
    const second = diffFunctionSpec(spec, first.newHashes);
    expect(second.changed).toHaveLength(0);
    expect(second.unchanged).toHaveLength(1);
  });

  it('re-flags the whole function when only the System Requirement doc changes', () => {
    const spec = buildFunctionSpec(USER_REQUIREMENT, SYSTEM_REQUIREMENT);
    const first = diffFunctionSpec(spec, {});

    const updatedSpec = buildFunctionSpec(
      USER_REQUIREMENT,
      SYSTEM_REQUIREMENT.replace('Auth: bearer', 'Auth: bearer\nRateLimit: 100/min')
    );
    const second = diffFunctionSpec(updatedSpec, first.newHashes);
    expect(second.changed).toHaveLength(1);
  });
});
