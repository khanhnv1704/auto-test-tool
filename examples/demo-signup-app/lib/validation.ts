/**
 * Shared validation driver for the customer signup form.
 *
 * Both the client form (app/customer-signup/page.tsx) and the server API
 * route (app/api/customers/route.ts) call `validateAll` against the same
 * `CUSTOMER_FIELDS` schema, so the two never drift apart on required-field
 * or format-error messages. The API route independently re-runs this
 * validation server-side (it never trusts the client) and additionally
 * layers on checks that only make sense server-side: the referral code
 * whitelist and email/id-number uniqueness.
 *
 * The actual per-field rules/messages live next to each field definition in
 * customerFields.ts (`field.validate`) — this module just drives the loop.
 */

import { CUSTOMER_FIELDS, CustomerField, CustomerFormValues } from './customerFields';

export { calculateAge } from './customerFields';

/**
 * Validate a single field against the current form values. Returns the
 * exact error message to display, or null if the field is valid
 * (or currently hidden and therefore not validated).
 */
export function validateField(field: CustomerField, values: CustomerFormValues): string | null {
  // Hidden fields (only the gender-conditional ID document fields use showIf)
  // are not validated at all, matching their real conditional visibility.
  if (field.showIf && !field.showIf(values)) {
    return null;
  }
  return field.validate(values[field.name], values);
}

/** Validate every field in CUSTOMER_FIELDS, in schema order. */
export function validateAll(values: CustomerFormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of CUSTOMER_FIELDS) {
    const message = validateField(field, values);
    if (message) {
      errors[field.name] = message;
    }
  }
  return errors;
}

export type { CustomerFormValues };
