import { NextRequest, NextResponse } from 'next/server';
import { validateAll, CustomerFormValues } from '@/lib/validation';

/**
 * NOTE ON PERSISTENCE: this route keeps its "database" in a plain
 * module-level array/variable. This is only acceptable because this whole
 * app is a throwaway demo used as a target for automated test
 * generation (AI Auto Test). The store resets on every server restart and
 * is obviously not fit for production use. It's just enough state within a
 * single running process for a duplicate-email/id test to actually get a
 * real 409, and for a newly-created record to be found by a follow-up
 * request in the same run.
 */
interface StoredCustomer {
  id: string;
  fullName: string;
  dateOfBirth: string;
  gender: string;
  idNumber: string | null;
  citizenIdNumber: string | null;
  email: string;
  phone: string;
  occupation: string | null;
  companyName: string | null;
  referralCode: string | null;
  createdAt: string;
}

function orNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const customers: StoredCustomer[] = [
  {
    id: 'seed-1',
    fullName: 'John Smith',
    dateOfBirth: '01/01/1990',
    gender: 'MALE',
    idNumber: '111111111111',
    citizenIdNumber: null,
    email: 'existing.customer@example.com',
    phone: '0912345678',
    occupation: null,
    companyName: null,
    referralCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'seed-2',
    fullName: 'Jane Doe',
    dateOfBirth: '01/01/1992',
    gender: 'FEMALE',
    idNumber: null,
    citizenIdNumber: '222222222222',
    email: 'jane.doe@example.com',
    phone: '0912345679',
    occupation: null,
    companyName: null,
    referralCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

let nextId = customers.length + 1;

const REFERRAL_WHITELIST = ['WELCOME10', 'FRIEND2026'];

function getExpectedToken(): string {
  // Fall back to the same value documented in .env.example so the app still
  // works out of the box even if a developer forgets to copy .env.example
  // to .env.local before running `npm run dev`.
  return process.env.TEST_TOKEN || 'demo-secret-token';
}

function unauthorized() {
  return NextResponse.json({ error: { message: 'Unauthorized' } }, { status: 401 });
}

/**
 * Error body for 400/409 responses: { statusCode, error, field, message }. This is the shape the
 * API test cases in examples/test-cases assert on.
 */
function errorResponse(status: 400 | 409, error: 'Bad Request' | 'Conflict', field: string, message: string) {
  return NextResponse.json({ statusCode: status, error, field, message }, { status });
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = match?.[1];

  if (!token || token !== getExpectedToken()) {
    return unauthorized();
  }

  let body: CustomerFormValues;
  try {
    body = (await request.json()) as CustomerFormValues;
  } catch {
    return NextResponse.json({ error: { message: 'Invalid request body' } }, { status: 400 });
  }

  // Full server-side validation, independent of whatever the client already
  // checked — the client's own validation is not trusted here.
  const errors = validateAll(body);
  const firstErrorKey = Object.keys(errors)[0];
  if (firstErrorKey) {
    return errorResponse(400, 'Bad Request', firstErrorKey, errors[firstErrorKey]);
  }

  const referralCode = orNull(body.referralCode);
  if (referralCode && !REFERRAL_WHITELIST.includes(referralCode)) {
    return errorResponse(400, 'Bad Request', 'referralCode', 'Invalid referral code');
  }

  const gender = String(body.gender ?? '');
  // The ID document field that does not belong to the selected gender is ignored (not validated, not
  // stored); see API11/API13 in the test cases.
  const idNumber = gender === 'MALE' ? orNull(body.idNumber) : null;
  const citizenIdNumber = gender === 'FEMALE' ? orNull(body.citizenIdNumber) : null;
  const email = String(body.email ?? '').trim().toLowerCase();

  const conflict = customers.find((existing) => {
    if (existing.email.toLowerCase() === email) return true;
    if (idNumber && existing.idNumber === idNumber) return true;
    if (citizenIdNumber && existing.citizenIdNumber === citizenIdNumber) return true;
    return false;
  });

  if (conflict) {
    // Never leak another existing customer's idNumber/citizenIdNumber: `field` only names the field that
    // conflicts, it does NOT include any value from the existing record.
    if (conflict.email.toLowerCase() === email) {
      return errorResponse(409, 'Conflict', 'email', 'This email is already registered. Please use a different email.');
    }
    if (idNumber && conflict.idNumber === idNumber) {
      return errorResponse(409, 'Conflict', 'idNumber', 'This ID number is already registered. Please check and try again.');
    }
    return errorResponse(409, 'Conflict', 'citizenIdNumber', 'This citizen ID number is already registered. Please check and try again.');
  }

  const record: StoredCustomer = {
    id: `cust-${nextId++}`,
    fullName: String(body.fullName ?? '').trim(),
    dateOfBirth: String(body.dateOfBirth ?? '').trim(),
    gender,
    idNumber,
    citizenIdNumber,
    email,
    phone: String(body.phone ?? '').trim(),
    occupation: orNull(body.occupation),
    companyName: orNull(body.companyName),
    referralCode,
    createdAt: new Date().toISOString(),
  };
  customers.push(record);

  return NextResponse.json(record, { status: 201 });
}
