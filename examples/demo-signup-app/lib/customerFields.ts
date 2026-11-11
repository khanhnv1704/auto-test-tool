/**
 * Single source of truth for the customer sign-up form schema.
 *
 * This module is imported by BOTH:
 *  - the client form page (app/customer-signup/page.tsx), to render inputs
 *    and run client-side validation, and
 *  - the server API route (app/api/customers/route.ts), to run authoritative
 *    server-side validation.
 *
 * Do NOT duplicate this field list anywhere else. Any change here
 * automatically propagates to both the rendered form and the API validation.
 *
 * Kept deliberately small (11 fields) so a full Sync + Run cycle stays in the
 * ~50 test case range, small enough to demo end-to-end in a few minutes, while
 * still covering one gender-conditional field pair ("field only visible and
 * required depending on another field") and one non-gender cross-field rule
 * (occupation -> companyName).
 *
 * Each field owns its `validate` function so the exact wording of every
 * error message lives in exactly one place (see lib/validation.ts for the
 * driver that calls these).
 */

/** A generic bag of form values keyed by field name. */
export type CustomerFormValues = Record<string, unknown>;

export type CustomerFieldType = 'text' | 'date' | 'boolean' | 'enum';

export interface CustomerFieldOption {
  value: string;
  label: string;
}

export interface CustomerField {
  /** Field name used as the form state key / JSON body key / input id. */
  name: string;
  /** Label shown to the user (and matched by getByLabel in tests). */
  label: string;
  type: CustomerFieldType;
  /** Options for `enum` fields, in the order they should be rendered. */
  options?: CustomerFieldOption[];
  /** Max character length enforced directly on the HTML input (the browser
   * truncates the input, no error message is shown). */
  maxLength?: number;
  /**
   * When present, the field is only rendered (and only validated) when this
   * returns true for the current form values. Only the gender-dependent
   * identity document fields (idNumber/citizenIdNumber) use this. The
   * occupation-dependent field (companyName) stays always visible; only its
   * requiredness is conditional.
   */
  showIf?: (values: CustomerFormValues) => boolean;
  /**
   * Returns the exact error message for this field's current value, or null
   * if valid. Called only when the field is visible (showIf passed, if any);
   * see validateField in lib/validation.ts.
   */
  validate: (value: unknown, values: CustomerFormValues) => string | null;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

const isMale = (values: CustomerFormValues) => values.gender === 'MALE';
const isFemale = (values: CustomerFormValues) => values.gender === 'FEMALE';
const isEmployee = (values: CustomerFormValues) => values.occupation === 'EMPLOYEE';

const FULL_NAME_RE = /^[\p{L}\s]+$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Starts with 0 or +84, then 3/5/7/8/9, followed by 8 digits (e.g. 0912345678).
const PHONE_RE = /^(0|\+84)[35789]\d{8}$/;
const ID_NUMBER_RE = /^(\d{9}|\d{12})$/;
const CITIZEN_ID_RE = /^\d{12}$/;
const REFERRAL_CODE_RE = /^[a-zA-Z0-9]+$/;
const OCCUPATION_VALUES = ['EMPLOYEE', 'FREELANCER', 'STUDENT', 'UNEMPLOYED'];
const MIN_AGE = 18;

/** Parses a strict "dd/mm/yyyy" string, rejecting dates that don't exist on
 * the calendar (e.g. "31/02/2024"). `new Date(y, m, d)` silently rolls those
 * over into the next month instead of erroring, so the result is checked
 * against the input components to catch that. */
function parseDMY(value: string): Date | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** Age in whole years as of "today" (the machine clock at request/render time). */
export function calculateAge(dateOfBirth: unknown): number | null {
  if (typeof dateOfBirth !== 'string') return null;
  const birth = parseDMY(dateOfBirth.trim());
  if (!birth) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age -= 1;
  }
  return age;
}

export const CUSTOMER_FIELDS: CustomerField[] = [
  {
    name: 'fullName',
    label: 'Full name',
    type: 'text',
    validate: (value) => {
      if (isEmptyValue(value)) return 'Please enter your full name';
      const v = String(value).trim();
      if (v.length < 2) return 'Full name must be at least 2 characters';
      if (!FULL_NAME_RE.test(v)) return 'Full name must not contain numbers or special characters';
      if (v.length > 100) return 'Full name must be at most 100 characters';
      return null;
    },
  },
  {
    name: 'dateOfBirth',
    label: 'Date of birth',
    type: 'date',
    validate: (value) => {
      if (isEmptyValue(value)) return 'Invalid date of birth';
      const birth = parseDMY(String(value).trim());
      if (!birth) return 'Invalid date of birth';
      if (birth.getTime() > Date.now()) return 'Invalid date of birth';
      const age = calculateAge(value);
      if (age === null || age < MIN_AGE) return 'Customer must be at least 18 years old to sign up';
      return null;
    },
  },
  {
    name: 'gender',
    label: 'Gender',
    type: 'enum',
    options: [
      { value: 'MALE', label: 'Male' },
      { value: 'FEMALE', label: 'Female' },
    ],
    validate: (value) => (isEmptyValue(value) ? 'Please select a gender' : null),
  },
  {
    name: 'idNumber',
    label: 'ID number',
    type: 'text',
    showIf: isMale,
    validate: (value) => (ID_NUMBER_RE.test(String(value ?? '')) ? null : 'ID number must be 9 or 12 digits'),
  },
  {
    name: 'citizenIdNumber',
    label: 'Citizen ID number',
    type: 'text',
    showIf: isFemale,
    validate: (value) => (CITIZEN_ID_RE.test(String(value ?? '')) ? null : 'Citizen ID number must be exactly 12 digits'),
  },
  {
    name: 'email',
    label: 'Email',
    type: 'text',
    // The UI blocks typing/pasting more than 254 characters directly on the input (no message is shown).
    // The server still validates the length for callers that hit the API directly (see validate below).
    maxLength: 254,
    validate: (value) => {
      if (isEmptyValue(value)) return 'Please enter your email';
      const v = String(value);
      if (!EMAIL_RE.test(v)) return 'Invalid email format';
      if (v.length > 254) return 'Email must be at most 254 characters';
      return null;
    },
  },
  {
    name: 'phone',
    label: 'Phone number',
    type: 'text',
    validate: (value) => (PHONE_RE.test(String(value ?? '')) ? null : 'Invalid phone number format (e.g. 0912345678)'),
  },
  {
    name: 'occupation',
    label: 'Occupation',
    type: 'enum',
    options: [
      { value: 'EMPLOYEE', label: 'Employee' },
      { value: 'FREELANCER', label: 'Freelancer' },
      { value: 'STUDENT', label: 'Student' },
      { value: 'UNEMPLOYED', label: 'Unemployed' },
    ],
    validate: (value) => (isEmptyValue(value) || OCCUPATION_VALUES.includes(String(value)) ? null : 'Invalid occupation'),
  },
  {
    name: 'companyName',
    label: 'Company name',
    type: 'text',
    validate: (value, values) => {
      if (isEmployee(values) && isEmptyValue(value)) return 'Please enter your company name';
      if (typeof value === 'string' && value.length > 150) return 'Company name must be at most 150 characters';
      return null;
    },
  },
  {
    name: 'referralCode',
    label: 'Referral code',
    type: 'text',
    maxLength: 20,
    validate: (value) => {
      if (isEmptyValue(value)) return null;
      const v = String(value);
      if (v.length > 20) return 'Referral code must be at most 20 characters';
      if (!REFERRAL_CODE_RE.test(v)) return 'Referral code may only contain letters and numbers';
      return null;
    },
  },
  {
    name: 'agreeToTerms',
    label: 'I agree to the terms of use',
    type: 'boolean',
    validate: (value) => (value === true ? null : 'You must agree to the terms of use to continue'),
  },
];
