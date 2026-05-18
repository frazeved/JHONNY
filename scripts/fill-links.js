// fill-links.js
// Scans Drive folders for PO, AL, PL, FedEx and Invoice files, matches by PO# in filename,
// fills PO LINK / AL LINK / PL LINK / FEDEX LABEL LINK / INVOICE LINK columns in the sheet (skips if already filled).

require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID     = '1y0iL7PJldbVQmPIAnJi9wvA2hvjB8_aK2bU2kxvUf5Q';
const TAB_NAME     = 'Warehouse Now Database';
const PO_FOLDER      = '1E_VSIJItfiaOSVLjzWALkUCS_kTo9XDb';
const AL_PL_FOLDER   = '1k4k8EpLdhw4EyUvQMn35ZwiRgvqsniJq';
const FEDEX_FOLDER   = '1ufkdrO23m2C-MrmhR1iKN3QFSJFwuQPY';
const INVOICE_FOLDER = '1r1qElg8MpRatZQ-kBBFSYJQUhIl1V1mQ';

function colIndex(headers, ...keys) {
  return headers.findIndex(h => keys.some(k => h.toLowerCase().includes(k.toLowerCase())));
}
function colLetter(i) {
  let col = '', n = i;
  while (n >= 0) { col = String.fromCharCode(65 + (n % 26)) + col; n = Math.floor(n / 26) - 1; }
  return col;
}

// Extract PO# — first 5–8 digit sequence not surrounded by other digits
function extractPO(filename) {
  const m = filename.match(/(?<!\d)(\d{5,8})(?!\d)/);
  return m ? m[1] : null;
}

// Distinguish AL vs PL by filename keywords
function classifyAlPl(filename) {
  const up = filename.toUpperCase();
  if (up.includes('PACK') || up.includes(' PL ') || up.startsWith('PL ') || up.startsWith('PL_')) return 'pl';
  return 'al';
}

// List all files in a folder recursively (follows subfolders like MAY, JUNE, etc.)
async function listFiles(drive, folderId) {
  const results = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType, webViewLink)',
      pageToken,
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const sub = await listFiles(drive, f.id);
        results.push(...sub);
      } else {
        results.push(f);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return results;
}

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth   = new google.auth.GoogleAuth({ credentials, scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
  ]});
  const sheets = google.sheets({ version: 'v4', auth });
  const drive  = google.drive({ version: 'v3', auth });

  // ── Read sheet ────────────────────────────────────────────────────────────────
  console.log('Reading sheet…');
  const r    = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: TAB_NAME });
  const rows = r.data.values || [];
  if (rows.length < 2) { console.log('No data'); return; }

  const H = rows[0].map(h => (h || '').trim());
  const C = {
    po:      colIndex(H, 'po#', 'po number'),
    poLink:  colIndex(H, 'po link'),
    alLink:  colIndex(H, 'al link', 'anthro label link'),
    plLink:  colIndex(H, 'pl link', 'packing list link'),
    fxLink:  colIndex(H, 'fedex label link', 'fedex link'),
    alCheck: colIndex(H, 'anthro label 🏷️', 'anthro label 🏷'),
    plCheck: colIndex(H, 'packing list'),
    fxCheck: colIndex(H, 'fedex label 🏷️', 'fedex label 🏷'),
    invLink: colIndex(H, 'invoice link'),
  };
  console.log(`Columns: PO#=${colLetter(C.po)} | PO LINK=${colLetter(C.poLink)} | AL LINK=${colLetter(C.alLink)} | PL LINK=${colLetter(C.plLink)} | FEDEX LABEL LINK=${colLetter(C.fxLink)} | INVOICE LINK=${colLetter(C.invLink)}`);

  const get = (row, i) => i >= 0 ? (row[i] || '').trim() : '';

  // PO# → { rowIndex (1-based), row }
  const poMap = {};
  for (let i = 1; i < rows.length; i++) {
    const po = get(rows[i], C.po);
    if (po) poMap[po] = { rowIndex: i + 1, row: rows[i] };
  }
  console.log(`${Object.keys(poMap).length} POs in sheet`);

  // ── Scan Drive folders ────────────────────────────────────────────────────────
  console.log('Scanning PO folder…');
  const poFiles = await listFiles(drive, PO_FOLDER);
  console.log(`  ${poFiles.length} files found`);

  console.log('Scanning AL/PL folder…');
  const alPlFiles = await listFiles(drive, AL_PL_FOLDER);
  console.log(`  ${alPlFiles.length} files found`);

  console.log('Scanning FedEx folder…');
  const fxFiles = await listFiles(drive, FEDEX_FOLDER);
  console.log(`  ${fxFiles.length} files found`);

  console.log('Scanning Invoice folder…');
  const invFiles = await listFiles(drive, INVOICE_FOLDER);
  console.log(`  ${invFiles.length} files found`);

  const updates = [];

  for (const file of poFiles) {
    const po = extractPO(file.name);
    if (!po || !poMap[po]) continue;
    const { rowIndex, row } = poMap[po];
    if (C.poLink >= 0 && !get(row, C.poLink)) {
      updates.push({ range: `${TAB_NAME}!${colLetter(C.poLink)}${rowIndex}`, values: [[file.webViewLink]] });
      row[C.poLink] = file.webViewLink;
      console.log(`  PO  PO ${po} ← ${file.name}`);
    }
  }

  for (const file of alPlFiles) {
    const po = extractPO(file.name);
    if (!po || !poMap[po]) continue;
    const { rowIndex, row } = poMap[po];
    const type = classifyAlPl(file.name);
    if (type === 'al' && C.alLink >= 0 && !get(row, C.alLink)) {
      updates.push({ range: `${TAB_NAME}!${colLetter(C.alLink)}${rowIndex}`, values: [[file.webViewLink]] });
      row[C.alLink] = file.webViewLink;
      if (C.alCheck >= 0) updates.push({ range: `${TAB_NAME}!${colLetter(C.alCheck)}${rowIndex}`, values: [['✅']] });
      console.log(`  AL  PO ${po} ← ${file.name}`);
    } else if (type === 'pl' && C.plLink >= 0 && !get(row, C.plLink)) {
      updates.push({ range: `${TAB_NAME}!${colLetter(C.plLink)}${rowIndex}`, values: [[file.webViewLink]] });
      row[C.plLink] = file.webViewLink;
      if (C.plCheck >= 0) updates.push({ range: `${TAB_NAME}!${colLetter(C.plCheck)}${rowIndex}`, values: [['✅']] });
      console.log(`  PL  PO ${po} ← ${file.name}`);
    }
  }

  for (const file of fxFiles) {
    const po = extractPO(file.name);
    if (!po || !poMap[po]) continue;
    const { rowIndex, row } = poMap[po];
    if (C.fxLink >= 0 && !get(row, C.fxLink)) {
      updates.push({ range: `${TAB_NAME}!${colLetter(C.fxLink)}${rowIndex}`, values: [[file.webViewLink]] });
      row[C.fxLink] = file.webViewLink;
      if (C.fxCheck >= 0) updates.push({ range: `${TAB_NAME}!${colLetter(C.fxCheck)}${rowIndex}`, values: [['✅']] });
      console.log(`  FX  PO ${po} ← ${file.name}`);
    }
  }

  for (const file of invFiles) {
    const po = extractPO(file.name);
    if (!po || !poMap[po]) continue;
    const { rowIndex, row } = poMap[po];
    if (C.invLink >= 0 && !get(row, C.invLink)) {
      updates.push({ range: `${TAB_NAME}!${colLetter(C.invLink)}${rowIndex}`, values: [[file.webViewLink]] });
      row[C.invLink] = file.webViewLink;
      console.log(`  INV PO ${po} ← ${file.name}`);
    }
  }

  if (!updates.length) {
    console.log('\nNo new links to fill — all already up to date.');
    return;
  }

  console.log(`\nWriting ${updates.length} link(s) to sheet…`);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: updates },
  });
  console.log(`Done — ${updates.length} link(s) filled.`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
