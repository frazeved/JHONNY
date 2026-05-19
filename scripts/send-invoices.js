require('dotenv').config();
const { google }   = require('googleapis');
const nodemailer   = require('nodemailer');
const { ImapFlow } = require('imapflow');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');

const SHEET_ID = '1y0iL7PJldbVQmPIAnJi9wvA2hvjB8_aK2bU2kxvUf5Q';
const TAB_NAME = 'Warehouse Now Database';

const TO      = 'invoices@urbanout.com';
const CC      = [
  'support@creativetwotwelve.com',       // Flavio Azevedo
  'logistics@creativetwotwelve.com',     // Eduardo Moraes
  'inspection@creativetwotwelve.com',    // Julian Fajardo
  'paula@creativetwotwelve.com',         // Paula Erthal
  'rafaela.neves@farmrio.com',           // Rafaela Neves
  'ozan.guruscu@creativetwotwelve.com',  // Ozan Guruscu
].join(', ');

const SIGNATURE = `\nBest regards,\nEduardo Moraes\nLogistics Team\n305 CONSULTING AND PRODUCTION\n1800 NW 15TH Avenue, Suite 110\nPompano Beach, Florida 33069`;

function colIndex(headers, ...keys) {
  return headers.findIndex(h => keys.some(k => h.toLowerCase().includes(k.toLowerCase())));
}

async function getSheetData(poNumbers) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth   = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: TAB_NAME });
  const rows = res.data.values || [];
  if (rows.length < 2) throw new Error('No data in sheet');

  const H = rows[0].map(h => (h || '').trim());
  const C = {
    po:       colIndex(H, 'po#', 'po number'),
    tracking: colIndex(H, 'tracking number', 'tracking'),
    invLink:  colIndex(H, 'invoice link'),
  };

  if (C.po < 0)       throw new Error('PO# column not found');
  if (C.tracking < 0) throw new Error('TRACKING NUMBER column not found');
  if (C.invLink < 0)  throw new Error('INVOICE LINK column not found');

  const get = (row, i) => i >= 0 ? (row[i] || '').trim() : '';
  const result = [];

  for (let i = 1; i < rows.length; i++) {
    const po = get(rows[i], C.po);
    if (!po || !poNumbers.includes(po)) continue;
    result.push({
      poNumber:    po,
      tracking:    get(rows[i], C.tracking),
      invoiceLink: get(rows[i], C.invLink),
    });
  }

  // Preserve the order the user passed in
  result.sort((a, b) => poNumbers.indexOf(a.poNumber) - poNumbers.indexOf(b.poNumber));
  return result;
}

function extractFileId(webViewLink) {
  const m = webViewLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function downloadPDF(fileId, poNumber, tmpDir) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth  = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });

  const dest    = path.join(tmpDir, `INV ${poNumber}.pdf`);
  const writer  = fs.createWriteStream(dest);

  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return dest;
}

async function run() {
  const missing = ['GMAIL_FROM', 'GMAIL_APP_PASSWORD', 'GOOGLE_SERVICE_ACCOUNT_JSON']
    .filter(v => !process.env[v]);
  if (missing.length) { console.error(`Missing env vars: ${missing.join(', ')}`); process.exit(1); }

  const poNumbers = (process.env.PO_NUMBERS || '').split(',').map(p => p.trim()).filter(Boolean);
  if (!poNumbers.length) { console.error('PO_NUMBERS env var is required'); process.exit(1); }

  console.log(`=== INVOICE EMAIL SENDER ===\nPOs: ${poNumbers.join(', ')}\n`);

  // 1. Read sheet
  const pos = await getSheetData(poNumbers);
  console.log(`Found ${pos.length} of ${poNumbers.length} POs in sheet`);

  const missing2 = poNumbers.filter(p => !pos.find(r => r.poNumber === p));
  if (missing2.length) console.warn(`Not found in sheet: ${missing2.join(', ')}`);

  // 2. Download PDFs
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoices-'));
  const attachments = [];

  for (const { poNumber, invoiceLink } of pos) {
    if (!invoiceLink) { console.warn(`PO ${poNumber}: no invoice link — skipping attachment`); continue; }
    const fileId = extractFileId(invoiceLink);
    if (!fileId) { console.warn(`PO ${poNumber}: could not extract file ID from ${invoiceLink}`); continue; }

    try {
      const localPath = await downloadPDF(fileId, poNumber, tmpDir);
      attachments.push({ filename: `INV ${poNumber}.pdf`, path: localPath });
      console.log(`Downloaded: INV ${poNumber}.pdf`);
    } catch (e) {
      console.warn(`PO ${poNumber}: download failed — ${e.message}`);
    }
  }

  // 3. Build email body
  const subject = `Invoices POs ${poNumbers.map(p => `#${p}`).join(' ')}`;

  const trackingLines = pos
    .map(({ poNumber, tracking }) =>
      `PO ${poNumber}: Tracking Number ${tracking || '(not found)'}`)
    .join('\n');

  const body = `Invoices are attached to this email for your records. Below are the tracking details for the respective PO numbers:\n\n${trackingLines}${SIGNATURE}`;

  // 4. Build raw MIME message
  const builder = nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
  const info = await builder.sendMail({
    from:        `Eduardo Moraes <${process.env.GMAIL_FROM}>`,
    to:          TO,
    cc:          CC,
    subject,
    text:        body,
    attachments,
  });

  // 5. Save to Gmail Drafts via IMAP
  const imap = new ImapFlow({
    host:   'imap.gmail.com',
    port:   993,
    secure: true,
    auth:   { user: process.env.GMAIL_FROM, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
  });

  await imap.connect();
  await imap.append('[Gmail]/Drafts', info.message, ['\\Draft', '\\Seen']);
  await imap.logout();

  console.log(`\nDraft saved to Gmail Drafts folder`);
  console.log(`Subject: ${subject}`);
  console.log(`To: ${TO} | CC: ${CC}`);
  console.log(`Attachments: ${attachments.map(a => a.filename).join(', ') || 'none'}`);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
