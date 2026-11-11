import { randomBytes } from 'crypto';
/**
 * Shared style and shell for popup forms that replace showInputBox/showQuickPick. Same look as the
 * test case modals (dimmed overlay + centered card), but the overlay always fills the page since
 * there is no background view. Popups are shown through MainPanel, in the same tab as other views.
 */

/** CSP nonce for inline scripts. Must be unpredictable, so it comes from the crypto RNG. */
export function nonce(): string {
  return randomBytes(16).toString('base64');
}

export function escapeHtml(input: string): string {
  return String(input).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const POPUP_MODAL_STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #1e1e1e;
    color: #ddd;
    font-size: 13px;
  }
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.5);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: #2d2d2d; border: 1px solid #454545; border-radius: 5px;
    width: 480px; max-width: 92vw; max-height: 86vh; overflow-y: auto;
    padding: 16px 18px; box-shadow: 0 8px 24px rgba(0,0,0,.5);
  }
  .modal.wide { width: 620px; }
  .modal h3 {
    margin: 0 0 4px; font-size: 15px;
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }
  .modal .subtitle { color: #9a9a9a; font-size: 12px; margin: 0 0 14px; }
  /* "✕" close button: place it last inside the flex <h3> (or a header row) so it sits on the right. */
  .icon-close-btn { padding: 2px 9px; font-size: 13px; line-height: 1.4; flex-shrink: 0; }
  .field { margin-bottom: 12px; }
  .field label { display: block; margin-bottom: 4px; color: #9a9a9a; font-size: 11.5px; font-weight: 600; }
  .field input, .field select, .field textarea {
    width: 100%; background: #3c3c3c; border: 1px solid #454545; color: #ddd;
    padding: 6px 8px; border-radius: 3px; font-size: 12.5px; font-family: inherit; box-sizing: border-box;
  }
  .field input:disabled, .field select:disabled { opacity: .6; }
  .field textarea { min-height: 60px; resize: vertical; }
  .field-row { display: flex; gap: 10px; }
  .field-row .field { flex: 1; }
  .hint-text { color: #9a9a9a; font-size: 11px; margin-top: 4px; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .toggle-row .field-inline-label { display: inline; margin-bottom: 0; }
  .toggle-row .switch { margin: 0; }
  .switch { position: relative; display: inline-block; flex: none; width: 36px; height: 20px; cursor: pointer; }
  .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .switch-slider { position: absolute; inset: 0; background: #5a5a5a; border-radius: 20px; transition: background .15s; pointer-events: none; }
  .switch-slider::before {
    content: ""; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px;
    background: #fff; border-radius: 50%; transition: transform .15s;
  }
  .switch input:checked + .switch-slider { background: #0e639c; }
  .switch input:checked + .switch-slider::before { transform: translateX(16px); }
  .switch input:focus-visible + .switch-slider { outline: 2px solid #0e639c; outline-offset: 2px; }
  #form-error { color: #f14c4c; font-size: 12px; min-height: 16px; margin-top: 2px; }
  .modal-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  button.btn {
    background: #3a3d41; color: #ddd; border: 1px solid #454545; padding: 6px 14px; border-radius: 3px;
    cursor: pointer; font-size: 12.5px;
  }
  button.btn:hover { background: #45494e; }
  button.btn.primary { background: #0e639c; border-color: #0e639c; }
  button.btn.primary:hover { background: #1177bb; }
  button.btn.danger { background: transparent; border-color: transparent; color: #f14c4c; margin-right: auto; }
  button.btn.danger:hover { background: rgba(241,76,76,.12); }
  button.btn:disabled { opacity: .5; cursor: not-allowed; }
`;

/** Wrap modal content in a full webview page with CSP, nonce and the shared style.
 * `innerHtml` is the content INSIDE `.modal`; this function adds the `.overlay`/`.modal` wrappers. */
export function renderPopupPage(n: string, innerHtml: string, script: string, wide = false): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';" />
    <style>${POPUP_MODAL_STYLE}</style>
  </head>
  <body>
    <div class="overlay">
      <div class="modal${wide ? ' wide' : ''}">${innerHtml}</div>
    </div>
    <script nonce="${n}">${script}</script>
  </body>
  </html>`;
}
