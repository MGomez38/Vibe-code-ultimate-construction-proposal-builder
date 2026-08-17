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

// ---------------------------------------------------------------- shared chrome
function docShell({ company, docLabel, number, date, client, accent = '#f5a524' }) {
  return `
    <tr><td style="background:#131c26;padding:24px 28px">
      <table role="presentation" width="100%"><tr>
        <td style="vertical-align:middle;width:52px">${LOGO}</td>
        <td style="vertical-align:middle;padding-left:12px">
          <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:1px">${esc(company.company_name)}</div>
          <div style="color:${accent};font-size:11px;letter-spacing:2px;text-transform:uppercase">${esc(docLabel)}</div>
        </td>
        <td style="vertical-align:middle;text-align:right">
          <div style="color:#ffffff;font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:700">${esc(number)}</div>
          <div style="color:#8496aa;font-size:12px">${esc(date || '')}</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:22px 28px 0">
      <table role="presentation" width="100%"><tr>
        <td style="vertical-align:top;font-size:13px;color:#47586c;line-height:1.6">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;font-weight:700">${docLabel.includes('INVOICE') ? 'Bill to' : 'Prepared for'}</div>
          <div style="font-size:15px;color:#131c26;font-weight:700">${esc(client?.name || '')}</div>
          ${client?.contact ? `<div>${esc(client.contact)}</div>` : ''}
          ${client?.address ? `<div>${esc(client.address)}</div>` : ''}
        </td>
        <td style="vertical-align:top;text-align:right;font-size:13px;color:#47586c;line-height:1.6">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;font-weight:700">From</div>
          <div style="font-size:15px;color:#131c26;font-weight:700">${esc(company.company_name)}</div>
          <div>${esc(company.company_address || '')}</div>
          <div>${esc(company.company_phone || '')}</div>
          <div>${esc(company.company_email || '')}</div>
        </td>
      </tr></table>
    </td></tr>`;
}

function itemRows(items, priceKey = 'unit_price') {
  return items.map(i => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e6eaef;font-size:14px;color:#131c26">${esc(i.desc)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e6eaef;font-size:14px;color:#47586c;text-align:right">${esc(i.qty)} ${esc(i.unit || '')}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e6eaef;font-size:14px;color:#47586c;text-align:right">${money(i[priceKey])}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e6eaef;font-size:14px;color:#131c26;text-align:right;font-weight:600">${money((i.qty || 0) * (i[priceKey] || 0))}</td>
    </tr>`).join('');
}

function totalLine(label, value, bold, color) {
  return `<tr>
    <td style="padding:6px 8px;font-size:14px;color:${bold ? '#131c26' : '#47586c'};${bold ? 'font-weight:700' : ''}">${label}</td>
    <td style="padding:6px 8px;font-size:${bold ? '18px' : '14px'};color:${color || '#131c26'};text-align:right;font-weight:${bold ? '800' : '600'}">${money(value)}</td>
  </tr>`;
}

// ---------------------------------------------------------------- change orders
function changeOrderBody({ co, job, client, company, totals, items }) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #dde3ea;border-radius:12px;overflow:hidden">
    ${docShell({ company, docLabel: 'Change Order', number: co.co_number, date: (co.created_at || '').slice(0, 10), client, accent: '#7c5cd6' })}
    <tr><td style="padding:22px 28px">
      <div style="padding:14px 16px;background:#f4f5f2;border-left:4px solid #7c5cd6;border-radius:6px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;font-weight:700">Against ${esc(job?.job_number || '')} — ${esc(job?.title || '')}</div>
        <div style="font-size:17px;font-weight:750;color:#131c26;margin-top:4px">${esc(co.title)}</div>
        ${co.description ? `<div style="font-size:13.5px;color:#47586c;margin-top:6px;line-height:1.6">${esc(co.description)}</div>` : ''}
        ${co.reason ? `<div style="font-size:12.5px;color:#8496aa;margin-top:8px">Reason: ${esc(co.reason)}</div>` : ''}
      </div>

      <table role="presentation" width="100%" style="margin-top:20px;border-collapse:collapse">
        <tr>
          <th style="text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Added scope</th>
          <th style="text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Qty</th>
          <th style="text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Rate</th>
          <th style="text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Amount</th>
        </tr>
        ${itemRows(items) || '<tr><td colspan="4" style="padding:14px;color:#8496aa;font-size:13px">Labor as described above.</td></tr>'}
      </table>

      <table role="presentation" width="100%" style="margin-top:14px"><tr><td style="width:55%"></td><td>
        <table role="presentation" width="100%" style="background:#f4f5f2;border-radius:8px;padding:6px">
          ${totals.materials ? totalLine('Materials &amp; items', totals.materials) : ''}
          ${totals.labor ? totalLine(`Labor (${co.labor_hours} hrs)`, totals.labor) : ''}
          ${totals.markup ? totalLine('Overhead', totals.markup) : ''}
          ${totals.tax ? totalLine(`Tax (${co.tax_pct}%)`, totals.tax) : ''}
          <tr><td colspan="2" style="border-top:2px solid #dde3ea;padding:0"></td></tr>
          ${totalLine('Change order total', totals.total, true)}
        </table>
      </td></tr></table>

      <div style="margin-top:16px;padding:12px 14px;background:#f3ecfd;border-radius:8px;font-size:13px;color:#4a2f96;line-height:1.6">
        <b>This changes your contract.</b> Approving adds ${money(totals.total)} to the contract price${Number(co.schedule_days) ? ` and ${co.schedule_days} calendar day${Number(co.schedule_days) === 1 ? '' : 's'} to the schedule` : ''}. Work on this item does not begin until it is approved.
      </div>
    </td></tr>
  </table>`;
}

function changeOrderPage(ctx, { token, responded }) {
  const { co, company, totals } = ctx;
  const decided = co.status === 'approved' || co.status === 'declined' || responded;
  const approved = co.status === 'approved' || responded === 'approved';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(co.co_number)} — ${esc(company.company_name)}</title>
  <style>
    body { margin:0; padding:26px 12px 60px; background:#eef1f4; font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
    .actions { max-width:680px; margin:18px auto 0; background:#fff; border:1px solid #dde3ea; border-radius:12px; padding:22px; text-align:center; }
    .actions h3 { margin:0 0 6px; font-size:16px; color:#131c26; }
    .actions p { margin:0 0 16px; font-size:13px; color:#47586c; }
    .btn { display:inline-block; border:0; border-radius:10px; padding:14px 30px; font-size:15px; font-weight:800; cursor:pointer; text-decoration:none; }
    .accept { background:#2e9e6b; color:#fff; } .decline { background:#fff; color:#47586c; border:1px solid #dde3ea; font-weight:600; }
    .print { background:#131c26; color:#fff; }
    .sig { width:100%; max-width:340px; padding:11px; border:1px solid #dde3ea; border-radius:8px; font-size:14px; margin-bottom:14px; }
    .done { max-width:680px; margin:18px auto 0; border-radius:12px; padding:20px; text-align:center; font-size:15px; font-weight:700; }
    .done.ok { background:#e2f4ea; color:#1f7a4d; border:1px solid #b6e0c8; }
    .done.no { background:#f4f5f2; color:#47586c; border:1px solid #dde3ea; }
    @media print { body { background:#fff; padding:0; } .actions, .noprint { display:none !important; } }
  </style></head><body>
  ${changeOrderBody(ctx)}
  ${decided ? `<div class="done ${approved ? 'ok' : 'no'}">${approved
      ? '✓ Change order approved — thank you. It has been added to your contract and we will schedule the work.'
      : 'This change order was declined. The original scope and contract price stand unchanged.'}</div>`
   : `<div class="actions">
      <h3>Approve this change?</h3>
      <p>We need your go-ahead before this work starts. Questions? Call ${esc(company.company_phone || '')}.</p>
      <form method="POST" action="/co/${esc(token)}/respond">
        <input class="sig" name="signature" placeholder="Type your full name to approve" autocomplete="name">
        <div><button class="btn accept" name="decision" value="approved">Approve Change Order</button>
        <button class="btn decline" name="decision" value="declined">Decline</button></div>
      </form>
    </div>`}
  <div class="noprint" style="max-width:680px;margin:14px auto 0;text-align:center">
    <a class="btn print" href="javascript:window.print()">Print / Save as PDF</a>
  </div></body></html>`;
}

function changeOrderEmail(ctx, { link, message }) {
  const { co, company, totals } = ctx;
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px 12px;background:#eef1f4;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    ${message ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto 16px">
      <tr><td style="background:#ffffff;border:1px solid #dde3ea;border-radius:12px;padding:20px 24px;font-size:14px;color:#131c26;line-height:1.65;white-space:pre-wrap">${esc(message)}</td></tr></table>` : ''}
    ${changeOrderBody(ctx)}
    ${link ? `<table role="presentation" width="100%" style="max-width:680px;margin:18px auto 0"><tr><td align="center">
      <a href="${esc(link)}" style="display:inline-block;background:#7c5cd6;color:#ffffff;font-weight:800;font-size:15px;text-decoration:none;padding:14px 34px;border-radius:10px">Review &amp; Approve Change Order</a>
      <div style="font-size:12px;color:#8496aa;margin-top:10px">Questions? Reply to this email or call ${esc(company.company_phone || '')}</div>
    </td></tr></table>` : ''}
    <div style="max-width:680px;margin:22px auto 0;text-align:center;font-size:11.5px;color:#8496aa">
      ${esc(company.company_name)} · ${esc(co.co_number)} · ${money(totals.total)}</div>
  </body></html>`;
}

// ---------------------------------------------------------------- invoices
function invoiceBody({ inv, job, client, company, totals, items, payments = [] }) {
  const overdue = inv.due_date && totals.balance > 0 && inv.due_date < new Date().toISOString().slice(0, 10);
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #dde3ea;border-radius:12px;overflow:hidden">
    ${docShell({ company, docLabel: 'INVOICE', number: inv.invoice_number, date: inv.issue_date, client, accent: '#2e9e6b' })}
    <tr><td style="padding:22px 28px">
      <table role="presentation" width="100%" style="margin-bottom:18px"><tr>
        <td style="font-size:12.5px;color:#47586c">
          ${job ? `<div><b style="color:#131c26">Project:</b> ${esc(job.job_number)} — ${esc(job.title)}</div>` : ''}
          ${inv.description ? `<div style="margin-top:3px">${esc(inv.description)}</div>` : ''}
        </td>
        <td style="text-align:right;font-size:12.5px;color:#47586c">
          <div><b style="color:#131c26">Terms:</b> ${inv.terms_days ? 'Net ' + inv.terms_days : 'Due on receipt'}</div>
          <div style="margin-top:3px"><b style="color:${overdue ? '#d64545' : '#131c26'}">Due:</b> <span style="color:${overdue ? '#d64545' : 'inherit'};font-weight:${overdue ? '700' : '400'}">${esc(inv.due_date || '—')}${overdue ? ' (past due)' : ''}</span></div>
        </td>
      </tr></table>

      <table role="presentation" width="100%" style="border-collapse:collapse">
        <tr>
          <th style="text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Description</th>
          <th style="text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Qty</th>
          <th style="text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Rate</th>
          <th style="text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;padding:8px;border-bottom:2px solid #dde3ea">Amount</th>
        </tr>
        ${itemRows(items)}
      </table>

      <table role="presentation" width="100%" style="margin-top:14px"><tr><td style="width:50%"></td><td>
        <table role="presentation" width="100%" style="background:#f4f5f2;border-radius:8px;padding:6px">
          ${totalLine('Subtotal', totals.subtotal)}
          ${totals.tax ? totalLine(`Tax (${inv.tax_pct}%)`, totals.tax) : ''}
          ${totals.retainage ? totalLine(`Less retainage (${inv.retainage_pct}%)`, -totals.retainage) : ''}
          <tr><td colspan="2" style="border-top:1px solid #dde3ea;padding:0"></td></tr>
          ${totalLine('Invoice total', totals.total)}
          ${totals.paid ? totalLine('Payments received', -totals.paid, false, '#2e9e6b') : ''}
          <tr><td colspan="2" style="border-top:2px solid #dde3ea;padding:0"></td></tr>
          ${totalLine('Amount due', totals.balance, true, totals.balance > 0 ? (overdue ? '#d64545' : '#131c26') : '#2e9e6b')}
        </table>
      </td></tr></table>

      ${payments.length ? `<div style="margin-top:16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8496aa;font-weight:700;margin-bottom:6px">Payments applied</div>
        ${payments.map(p => `<div style="font-size:12.5px;color:#47586c;padding:4px 0;border-bottom:1px solid #f0f2f5">${esc(p.received_on)} · ${esc(p.method)}${p.reference ? ' ' + esc(p.reference) : ''} — <b style="color:#2e9e6b">${money(p.amount)}</b></div>`).join('')}
      </div>` : ''}

      ${totals.retainage ? `<div style="margin-top:14px;font-size:12px;color:#8496aa;line-height:1.6">Retainage of ${money(totals.retainage)} is held per contract and billed at project closeout.</div>` : ''}
      ${inv.notes ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid #e6eaef;font-size:12.5px;color:#47586c;line-height:1.6">${esc(inv.notes)}</div>` : ''}
      ${totals.balance > 0 && company.payment_link_url ? `
        <table role="presentation" width="100%" style="margin-top:20px"><tr><td align="center">
          <a href="${esc(company.payment_link_url)}" style="display:inline-block;background:#2e9e6b;color:#ffffff;font-weight:800;font-size:16px;text-decoration:none;padding:15px 38px;border-radius:10px">Pay ${money(totals.balance)} Online</a>
          <div style="font-size:12px;color:#8496aa;margin-top:9px">Reference invoice ${esc(inv.invoice_number)} with your payment</div>
        </td></tr></table>` : ''}
      <div style="margin-top:18px;padding:13px 15px;background:#f4f5f2;border-radius:8px;font-size:12.5px;color:#47586c;line-height:1.6">
        <b style="color:#131c26">Remit to:</b> ${esc(company.company_name)}${company.company_address ? ' · ' + esc(company.company_address) : ''}<br>
        ${company.payment_instructions ? esc(company.payment_instructions) + '<br>' : ''}
        Questions about this invoice? ${esc(company.company_phone || '')} · ${esc(company.company_email || '')}
      </div>
    </td></tr>
  </table>`;
}

function invoicePage(ctx) {
  const { inv, company, totals } = ctx;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(inv.invoice_number)} — ${esc(company.company_name)}</title>
  <style>
    body { margin:0; padding:26px 12px 60px; background:#eef1f4; font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
    .btn { display:inline-block; border:0; border-radius:10px; padding:14px 30px; font-size:15px; font-weight:800; text-decoration:none; background:#131c26; color:#fff; }
    .paid { max-width:680px; margin:18px auto 0; background:#e2f4ea; color:#1f7a4d; border:1px solid #b6e0c8; border-radius:12px; padding:18px; text-align:center; font-weight:700; }
    @media print { body { background:#fff; padding:0; } .noprint { display:none !important; } }
  </style></head><body>
  ${invoiceBody(ctx)}
  ${totals.balance <= 0 ? '<div class="paid">✓ Paid in full — thank you.</div>' : ''}
  <div class="noprint" style="max-width:680px;margin:16px auto 0;text-align:center">
    <a class="btn" href="javascript:window.print()">Print / Save as PDF</a>
  </div></body></html>`;
}

function invoiceEmail(ctx, { link, message }) {
  const { inv, company, totals } = ctx;
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px 12px;background:#eef1f4;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    ${message ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto 16px">
      <tr><td style="background:#ffffff;border:1px solid #dde3ea;border-radius:12px;padding:20px 24px;font-size:14px;color:#131c26;line-height:1.65;white-space:pre-wrap">${esc(message)}</td></tr></table>` : ''}
    ${invoiceBody(ctx)}
    ${link ? `<table role="presentation" width="100%" style="max-width:680px;margin:18px auto 0"><tr><td align="center">
      <a href="${esc(link)}" style="display:inline-block;background:#131c26;color:#ffffff;font-weight:800;font-size:15px;text-decoration:none;padding:14px 34px;border-radius:10px">View Invoice Online</a>
    </td></tr></table>` : ''}
    <div style="max-width:680px;margin:22px auto 0;text-align:center;font-size:11.5px;color:#8496aa">
      ${esc(company.company_name)} · ${esc(inv.invoice_number)} · Amount due ${money(totals.balance)}</div>
  </body></html>`;
}

function docText(kind, ctx, link) {
  const { company, totals } = ctx;
  const d = ctx.co || ctx.inv;
  const number = d.co_number || d.invoice_number;
  return [
    `${company.company_name} — ${kind} ${number}`, '',
    d.title || d.description || '', '',
    ...(ctx.items || []).map(i => `  ${i.qty} ${i.unit || ''} × ${i.desc} — ${money((i.qty || 0) * (i.unit_price || 0))}`),
    '', kind === 'Invoice' ? `AMOUNT DUE: ${money(totals.balance)}` : `TOTAL: ${money(totals.total)}`,
    '', link ? `View online: ${link}` : '',
    '', `${company.company_name} · ${company.company_phone || ''} · ${company.company_email || ''}`,
  ].join('\n');
}

module.exports = {
  quoteBody, quoteEmail, quoteText, quotePage,
  changeOrderBody, changeOrderEmail, changeOrderPage,
  invoiceBody, invoiceEmail, invoicePage, docText,
  esc, money,
};
