'use client';

import { FormEvent, useState } from 'react';
import { CUSTOMER_FIELDS, CustomerField, CustomerFormValues } from '@/lib/customerFields';
import { validateAll } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

// Demo-only auth shortcut: this is a same-origin browser form with no real
// login/session, so there is no genuine bearer token to send. The API route
// still enforces `Authorization: Bearer <TEST_TOKEN>` (see app/api/customers/
// route.ts and .env.example) for direct/API-lane callers. For simplicity the
// browser client just sends the same demo token literal here rather than
// wiring up a NEXT_PUBLIC_ env var or a same-origin proxy — this keeps the
// fixture app's client/server contract obvious and single-sourced.
const DEMO_CLIENT_TOKEN = 'demo-secret-token';

// Native <input type="date"> always reads/writes ISO "yyyy-mm-dd" per the HTML spec, regardless of
// locale — but lib/customerFields.ts's parseDMY (shared with server-side validation) requires
// dd/mm/yyyy. Convert at the UI boundary so `values.dateOfBirth` stays dd/mm/yyyy everywhere else.
function isoToDmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function dmyToIso(dmy: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function buildInitialValues(): CustomerFormValues {
  const values: CustomerFormValues = {};
  for (const field of CUSTOMER_FIELDS) {
    values[field.name] = field.type === 'boolean' ? false : '';
  }
  return values;
}

function FieldInput({
  field,
  values,
  onChange,
}: {
  field: CustomerField;
  values: CustomerFormValues;
  onChange: (field: CustomerField, value: string | boolean) => void;
}) {
  const id = field.name;
  const value = values[field.name];

  if (field.type === 'boolean') {
    return (
      <Checkbox
        id={id}
        checked={value === true}
        onCheckedChange={(checked) => onChange(field, checked === true)}
      />
    );
  }

  if (field.type === 'enum') {
    return (
      <Select
        value={typeof value === 'string' ? value : ''}
        onValueChange={(v) => onChange(field, v)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="-- Select --" />
        </SelectTrigger>
        <SelectContent>
          {field.options?.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (field.type === 'date') {
    return (
      <Input
        id={id}
        type="date"
        value={typeof value === 'string' ? dmyToIso(value) : ''}
        onChange={(e) => onChange(field, isoToDmy(e.target.value))}
      />
    );
  }

  return (
    <Input
      id={id}
      type="text"
      value={typeof value === 'string' ? value : ''}
      maxLength={field.maxLength}
      onChange={(e) => onChange(field, e.target.value)}
    />
  );
}

export default function CustomerSignupPage() {
  const [values, setValues] = useState<CustomerFormValues>(buildInitialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function handleChange(field: CustomerField, value: string | boolean) {
    setValues((prev) => ({ ...prev, [field.name]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError(null);

    const nextErrors = validateAll(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEMO_CLIENT_TOKEN}`,
        },
        body: JSON.stringify(values),
      });
      const data: { error?: { message?: string }; id?: string } = await res.json();

      if (!res.ok) {
        setServerError(data?.error?.message ?? 'Something went wrong, please try again');
        return;
      }

      setSubmitted(true);
    } catch {
      setServerError('Unable to connect to the server');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <main className="mx-auto w-full max-w-2xl p-4 sm:p-6">
        <Card className="shadow-sm">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <CheckCircle2 className="size-6" />
            </div>
            <p className="text-lg font-medium">Sign-up successful</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl p-4 sm:p-6">
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">Customer sign-up</CardTitle>
          <CardDescription>Fill in the information below to create a new customer account.</CardDescription>
        </CardHeader>
        <CardContent>
          {serverError && (
            <div
              role="alert"
              data-testid="server-error"
              className="mb-6 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{serverError}</span>
            </div>
          )}
          <form onSubmit={handleSubmit} noValidate className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
            {CUSTOMER_FIELDS.map((field) => {
              if (field.showIf && !field.showIf(values)) {
                return null;
              }
              const error = errors[field.name];
              // The terms checkbox always spans the full row, even in the 2-column layout, so a short
              // confirmation line is not squeezed into half a column.
              const spanFull = field.type === 'boolean';
              return (
                <div key={field.name} className={`field flex flex-col gap-1.5 ${spanFull ? 'sm:col-span-2' : ''}`}>
                  {field.type === 'boolean' ? (
                    <div className="flex items-center gap-2">
                      <FieldInput field={field} values={values} onChange={handleChange} />
                      <Label htmlFor={field.name}>{field.label}</Label>
                    </div>
                  ) : (
                    <>
                      <Label htmlFor={field.name}>{field.label}</Label>
                      <FieldInput field={field} values={values} onChange={handleChange} />
                    </>
                  )}
                  {error && <span className="error text-sm text-destructive">{error}</span>}
                </div>
              );
            })}
            <Button type="submit" disabled={submitting} className="w-full sm:col-span-2">
              Sign up
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
