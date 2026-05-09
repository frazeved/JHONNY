require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID  = '1y0iL7PJldbVQmPIAnJi9wvA2hvjB8_aK2bU2kxvUf5Q';
const SHEET_GID = 99866922;
const TAB_NAME  = 'Warehouse Now Database';

const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;

const FEDEX_BASE      = process.env.FEDEX_ENV === 'production'
  ? 'https://apis.fedex.com'
  : 'https://apis-sandbox.fedex.com';
const FEDEX_OAUTH_URL = `${FEDEX_BASE}/oauth/token`;
const FEDEX_TRACK_URL = `${FEDEX_BASE}/track/v1/trackingnumbers`;

function colIndex(headers, ...keywords) {
  return headers.findIndex(h =>
    keywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );
}

function colLetter(index) {
  let col = '';
  let i = index;
  while (i >= 0) {
    col = String.fromCharCode(65 + (i % 26)) + col;
    i = Math.floor(i / 26) - 1;
  }
  return col;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
        if (c === '\r') i++;
        row.push(field); field = '';
        if (row.some(f => f.trim())) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (row.length) { row.push(field); if (row.some(f => f.trim())) rows.push(row); }
  return rows;
}

async function getFedExToken() {
  console.log('Getting FedEx token…');
  const res = await fetch(FEDEX_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.FEDEX_API_KEY,
      client_secret: process.env.FEDEX_API_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`FedEx OAuth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`FedEx OAuth: no token in response: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function trackBatch(token, trackingNumbers) {
  const res = await fetch(FEDEX_TRACK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-locale': 'en_US',
    },
    body: JSON.stringify({
      includeDetailedScans: false,
      trackingInfo: trackingNumbers.map(n => ({
        trackingNumberInfo: { trackingNumber: n },
      })),
    }),
  });
  if (!res.ok) throw new Error(`FedEx Track failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`FedEx base: ${FEDEX_BASE}`);
  console.log(`Tab: "${TAB_NAME}"`);

  // Step 1 — Read sheet via public CSV (no auth needed)
  console.log('Step 1: Reading sheet CSV…');
  const csvRes = await fetch(CSV_URL);
  if (!csvRes.ok) throw new Error(`CSV fetch failed: ${csvRes.status}`);
  const rows = parseCSV(await csvRes.text());
  if (rows.length < 2) { console.log('Sheet has no data'); return; }
  console.log(`Read ${rows.length - 1} data rows`);

  const headers = rows[0];
  console.log('Headers:', headers.slice(0, 10).join(' | '));

  const awbCol = colIndex(headers,
    'awb', 'tracking number', 'tracking #', 'fedex tracking', 'fedex trk', 'trk#', 'airway'
  );
  let stsCol = colIndex(headers,
    'fedex status', 'delivery status', 'fed ex status', 'fedex delivery'
  );

  if (awbCol < 0) throw new Error('AWB/Tracking column not found. Headers: ' + headers.join(' | '));
  console.log(`AWB column: ${colLetter(awbCol)} (index ${awbCol})`);

  // Step 2 — Auth Google Sheets (write only)
  console.log('Step 2: Authenticating Google Sheets for writing…');
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  console.log(`Service account: ${credentials.client_email}`);

  // Step 3 — Create FEDEX STATUS column if missing
  if (stsCol < 0) {
    stsCol = headers.length;
    console.log(`Creating FEDEX STATUS header at column ${colLetter(stsCol)}…`);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB_NAME}!${colLetter(stsCol)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['FEDEX STATUS']] },
    });
    console.log('Header created');
  } else {
    console.log(`FEDEX STATUS column: ${colLetter(stsCol)} (index ${stsCol})`);
  }

  // Step 4 — Collect tracking numbers
  const toTrack = [];
  for (let i = 1; i < rows.length; i++) {
    const trk = (rows[i][awbCol] || '').trim();
    if (trk) toTrack.push({ rowIndex: i, tracking: trk });
  }
  if (!toTrack.length) { console.log('No tracking numbers found in sheet'); return; }
  console.log(`Found ${toTrack.length} shipment(s) to track`);

  // Step 5 — FedEx tracking
  const token = await getFedExToken();
  console.log('FedEx token OK');

  const BATCH = 30;
  const updates = [];

  for (let i = 0; i < toTrack.length; i += BATCH) {
    const batch = toTrack.slice(i, i + BATCH);
    console.log(`Tracking batch: ${batch.map(b => b.tracking).join(', ')}`);
    const result = await trackBatch(token, batch.map(b => b.tracking));

    for (const item of (result.output?.completeTrackResults || [])) {
      const entry = batch.find(b => b.tracking === item.trackingNumber);
      if (!entry) continue;
      const tr = item.trackResults?.[0];
      const status = tr?.latestStatusDetail?.statusByLocale
                   || tr?.latestStatusDetail?.description
                   || 'Unknown';
      const updatedAt = new Date().toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      updates.push({ rowIndex: entry.rowIndex, value: `${status} · ${updatedAt}` });
    }
  }

  if (!updates.length) { console.log('No status updates from FedEx'); return; }

  // Step 6 — Write statuses back
  console.log(`Writing ${updates.length} status update(s) to sheet…`);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map(u => ({
        range: `${TAB_NAME}!${colLetter(stsCol)}${u.rowIndex + 1}`,
        values: [[u.value]],
      })),
    },
  });

  console.log(`✓ Done — updated ${updates.length} FedEx status(es)`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  if (err.response?.data) console.error('API response:', JSON.stringify(err.response.data));
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
