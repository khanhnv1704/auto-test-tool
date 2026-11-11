import { describe, it, expect } from 'vitest';
// Imported from templates/ (copied verbatim to <functionDir>/generated/support/ by evidenceSupport.ts),
// so this tests the exact file that runs in the target project.
import { renderApiEvidenceHtml } from '../../templates/evidence';

describe('renderApiEvidenceHtml', () => {
  it('highlights the status code when highlightField is "status"', () => {
    const html = renderApiEvidenceHtml({
      method: 'POST',
      url: 'http://localhost:4000/customers',
      status: 401,
      body: '{\n  "error": "Unauthorized"\n}',
      highlightField: 'status',
      note: 'Expect 401 when the Bearer token is missing'
    });

    expect(html).toContain('class="status hl"');
    expect(html).toContain('>401<');
    expect(html).toContain('Expect 401 when the Bearer token is missing');
  });

  it('wraps the target field value in <mark> when highlighting a response body field', () => {
    const html = renderApiEvidenceHtml({
      method: 'POST',
      url: 'http://localhost:4000/customers',
      status: 400,
      body: '{\n  "error": {\n    "message": "Invalid email"\n  }\n}',
      highlightField: 'error.message',
      note: 'Validation message is correct'
    });

    expect(html).toContain('<mark>"message": "Invalid email"</mark>');
  });

  it('escapes HTML/script content in the response body so an XSS payload cannot execute in the evidence page', () => {
    const html = renderApiEvidenceHtml({
      method: 'POST',
      url: 'http://localhost:4000/customers',
      status: 201,
      body: '{\n  "fullName": "<script>alert(1)</script>"\n}',
      highlightField: 'fullName',
      note: 'XSS payload is stored safely and not executed'
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders a Request Body section above Response when requestBody is provided', () => {
    const html = renderApiEvidenceHtml({
      method: 'POST',
      url: 'http://localhost:4000/customers',
      status: 201,
      body: '{\n  "id": "abc123"\n}',
      requestBody: '{\n  "fullName": "Jane Doe",\n  "gender": "MALE"\n}',
      highlightField: 'status',
      note: 'Customer created successfully'
    });

    expect(html).toContain('Request Body');
    expect(html).toContain('Jane Doe');
    expect(html.indexOf('Request Body')).toBeLessThan(html.indexOf('Response'));
  });

  it('omits the Request Body section entirely when requestBody is absent or "-"', () => {
    const withoutBody = renderApiEvidenceHtml({
      method: 'GET',
      url: 'http://localhost:4000/customers/1',
      status: 200,
      body: '{}',
      highlightField: 'status',
      note: 'Get customer details'
    });
    expect(withoutBody).not.toContain('Request Body');

    const withDash = renderApiEvidenceHtml({
      method: 'GET',
      url: 'http://localhost:4000/customers/1',
      status: 200,
      body: '{}',
      requestBody: '-',
      highlightField: 'status',
      note: 'Get customer details'
    });
    expect(withDash).not.toContain('Request Body');
  });
});
