/**
 * Customer-facing document templates — the proposal shown on the public quote
 * link and the HTML emailed to the client. Table-based markup and inline styles
 * so it survives Outlook, Gmail and print alike.
 */
'use strict';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const LOGO = `<svg viewBox="0 0 100 100" width="42" height="42"><rect width="100" height="100" rx="18" fill="#131c26"/><path d="M22 70 L50 26 L78 70 Z" fill="none" stroke="#f5a524" stroke-width="9" stroke-linejoin="round"/><rect x="42" y="56" width="16" height="14" fill="#f5a524"/></svg>`;

/** The proposal body — shared by the email and the public page. */
function quoteBody({ quote, client, company, totals, items }) {
  const rows = items.map(i => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e6eaef;font-size:14px;color:#131c26">${esc(i.desc)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e6eaef;font-size:14px;color:#47586c;text-align:right">${esc(i.qty)} ${esc(i.unit || '')}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e6eaef;font-size:14px;color:#47586c;text-align:right">${money(i.unit_price)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e6eaef;font-size:14px;color:#131c26;text-align:right;font-weight:600">${money((i.qty || 0) * (i.unit_price || 0))}</td>
    </tr>`).join('');

  const line = (label, value, bold) => `
    <tr>
      <td style="padding:6px 8px;font-size:14px;color:${bold ? '#131c26' : '#47586c'};${bold ? 'font-weight:700' : ''}">${label}</td>
      <td style="padding:6px 8px;font-size:${bold ? '18px' : '14px'};color:#131c26;text-align:right;font-weight:${bold ? '800' : '600'}">${money(value)}</td>
    </tr>`;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #dde3ea;border-radius:12px;overflow:hidden">
    <tr><td style="background:#131c26;padding:24px 28px">
      <table role="presentation" width="100%"><tr>
        <td style="vertical-align:middle;width:52px">${LOGO}</td>
        <td style="vertical-align:middle;padding-left:12px">
          <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:1px">${esc(company.company_name)}</div>
          <div style="color:#f5a524;font-size:11px;letter-spacing:2px;text-transform:uppercase">Proposal</div>
        </td>
        <td style="vertical-align:middle;text-align:right">
          <div style="color:#ffffff;font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:700">${esc(quote.quote_number)}</div>
          <div style="color:#8496aa;font-size:12px">${esc((quote.created_at || '').slice(0, 10))}</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:24px 28px">
      <table role="presentation" width="100%"><tr>
        <td style="vertical-align:top;font-size:13px;color:#47586c;line-height:1.6">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;font-weight:700">Prepared for</div>
          <div style="font-size:15px;color:#131c26;font-weight:700">${esc(client?.name || '')}</div>
          ${client?.contact ? `<div>${esc(client.contact)}</div>` : ''}
          ${client?.address ? `<div>${esc(client.address)}</div>` : ''}
          ${client?.phone ? `<div>${esc(client.phone)}</div>` : ''}
        </td>
        <td style="vertical-align:top;text-align:right;font-size:13px;color:#47586c;line-height:1.6">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;font-weight:700">From</div>
          <div style="font-size:15px;color:#131c26;font-weight:700">${esc(company.company_name)}</div>
          <div>${esc(company.company_address || '')}</div>
          <div>${esc(company.company_phone || '')}</div>
          <div>${esc(company.company_email || '')}</div>
        </td>
      </tr></table>

      <div style="margin-top:22px;padding:16px 18px;background:#f4f5f2;border-left:4px solid #f5a524;border-radius:6px">
        <div style="font-size:17px;font-weight:750;color:#131c26">${esc(quote.title)}</div>
        ${quote.description ? `<div style="font-size:13.5px;color:#47586c;margin-top:6px;line-height:1.6">${esc(quote.description)}</div>` : ''}
      </div>

      <table role="presentation" width="100%" style="margin-top:22px;border-collapse:collapse">
        <tr>
          <th style="text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Scope item</th>
          <th style="text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Qty</th>
          <th style="text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Rate</th>
          <th style="text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Amount</th>
        </tr>
        ${rows || '<tr><td colspan="4" style="padding:14px;color:#8496aa;font-size:13px">Labor and materials as described above.</td></tr>'}
      </table>

      <table role="presentation" width="100%" style="margin-top:14px">
        <tr><td style="width:55%"></td><td>
          <table role="presentation" width="100%" style="background:#f4f5f2;border-radius:8px;padding:6px">
            ${totals.materials ? line('Materials &amp; items', totals.materials) : ''}
            ${totals.labor ? line(`Labor (${quote.labor_hours} hrs)`, totals.labor) : ''}
            ${totals.markup ? line('Overhead', totals.markup) : ''}
            ${totals.tax ? line(`Tax (${quote.tax_pct}%)`, totals.tax) : ''}
            <tr><td colspan="2" style="border-top:2px solid #dde3ea;padding:0"></td></tr>
            ${line('Project total', totals.total, true)}
          </table>
        </td></tr>
      </table>
      ${quote.valid_until ? `<div style="margin-top:12px;font-size:12.5px;color:#8496aa">Valid until ${esc(quote.valid_until)}</div>` : ''}
      ${company.quote_terms ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e6eaef">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;font-weight:700;margin-bottom:6px">Terms</div>
        <div style="font-size:12px;color:#47586c;line-height:1.65">${esc(company.quote_terms)}</div></div>` : ''}
    </td></tr>
  </table>`;
}

/** Full HTML email — proposal plus a call-to-action button. */
function quoteEmail(ctx, { link, message }) {
  const { quote, company, totals } = ctx;
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px 12px;background:#eef1f4;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    ${message ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto 16px">
      <tr><td style="background:#ffffff;border:1px solid #dde3ea;border-radius:12px;padding:20px 24px;font-size:14px;color:#131c26;line-height:1.65;white-space:pre-wrap">${esc(message)}</td></tr>
    </table>` : ''}
    ${quoteBody(ctx)}
    ${link ? `<table role="presentation" width="100%" style="max-width:680px;margin:18px auto 0"><tr><td align="center">
      <a href="${esc(link)}" style="display:inline-block;background:#f5a524;color:#131c26;font-weight:800;font-size:15px;text-decoration:none;padding:14px 34px;border-radius:10px">Review &amp; Approve Online</a>
      <div style="font-size:12px;color:#8496aa;margin-top:10px">Or reply to this email with any questions — ${esc(company.company_phone || '')}</div>
    </td></tr></table>` : ''}
    <div style="max-width:680px;margin:22px auto 0;text-align:center;font-size:11.5px;color:#8496aa">
      ${esc(company.company_name)} · ${esc(company.company_address || '')} · ${esc(company.company_website || '')}<br>
      Quote ${esc(quote.quote_number)} · Total ${money(totals.total)}
    </div>
  </body></html>`;
}

/** Plain-text alternative for mail clients that refuse HTML. */
function quoteText(ctx, link) {
  const { quote, company, totals, items } = ctx;
  return [
    `${company.company_name} — Proposal ${quote.quote_number}`,
    '', quote.title, quote.description || '', '',
    ...items.map(i => `  ${i.qty} ${i.unit || ''} × ${i.desc} — ${money((i.qty || 0) * (i.unit_price || 0))}`),
    '', `PROJECT TOTAL: ${money(totals.total)}`,
    quote.valid_until ? `Valid until ${quote.valid_until}` : '',
    '', link ? `Review and approve online: ${link}` : '',
    '', company.quote_terms || '',
    '', `${company.company_name} · ${company.company_phone || ''} · ${company.company_email || ''}`,
  ].filter(x => x !== null).join('\n');
}

/** The standalone public page the customer opens from the email link. */
function quotePage(ctx, { token, responded }) {
  const { quote, company, totals } = ctx;
  const decided = quote.status === 'accepted' || quote.status === 'declined';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(quote.quote_number)} — ${esc(company.company_name)}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='18' fill='%23131c26'/><path d='M22 70 L50 26 L78 70 Z' fill='none' stroke='%23f5a524' stroke-width='9'/></svg>">
  <style>
    body { margin:0; padding:26px 12px 60px; background:#eef1f4; font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
    .actions { max-width:680px; margin:18px auto 0; background:#fff; border:1px solid #dde3ea; border-radius:12px; padding:22px; text-align:center; }
    .actions h3 { margin:0 0 6px; font-size:16px; color:#131c26; }
    .actions p { margin:0 0 16px; font-size:13px; color:#47586c; }
    .btn { display:inline-block; border:0; border-radius:10px; padding:14px 30px; font-size:15px; font-weight:800; cursor:pointer; text-decoration:none; }
    .accept { background:#2e9e6b; color:#fff; }
    .decline { background:#fff; color:#47586c; border:1px solid #dde3ea; font-weight:600; }
    .print { background:#131c26; color:#fff; }
    .sig { width:100%; max-width:340px; padding:11px; border:1px solid #dde3ea; border-radius:8px; font-size:14px; margin-bottom:14px; }
    .done { max-width:680px; margin:18px auto 0; border-radius:12px; padding:20px; text-align:center; font-size:15px; font-weight:700; }
    .done.ok { background:#e2f4ea; color:#1f7a4d; border:1px solid #b6e0c8; }
    .done.no { background:#f4f5f2; color:#47586c; border:1px solid #dde3ea; }
    @media print { body { background:#fff; padding:0; } .actions, .noprint { display:none !important; } }
  </style></head><body>
  ${quoteBody(ctx)}
  ${decided || responded ? `<div class="done ${quote.status === 'accepted' || responded === 'accepted' ? 'ok' : 'no'}">
      ${quote.status === 'accepted' || responded === 'accepted'
        ? '✓ Thank you — this proposal has been approved. We will be in touch to schedule the work.'
        : 'This proposal has been declined. Thank you for considering us — reach out any time.'}
    </div>`
   : `<div class="actions">
      <h3>Ready to move forward?</h3>
      <p>Approve below and we will schedule your crew. Questions? Call ${esc(company.company_phone || '')}.</p>
      <form method="POST" action="/q/${esc(token)}/respond">
        <input class="sig" name="signature" placeholder="Type your full name to approve" autocomplete="name">
        <div>
          <button class="btn accept" name="decision" value="accepted">Approve This Proposal</button>
          <button class="btn decline" name="decision" value="declined">Decline</button>
        </div>
      </form>
    </div>`}
  <div class="noprint" style="max-width:680px;margin:14px auto 0;text-align:center">
    <a class="btn print" href="javascript:window.print()">Print / Save as PDF</a>
  </div>
  </body></html>`;
}

module.exports = { quoteBody, quoteEmail, quoteText, quotePage, esc, money };
