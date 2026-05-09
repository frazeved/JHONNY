require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID  = '1y0iL7PJldbVQmPIAnJi9wvA2hvjB8_aK2bU2kxvUf5Q';
const SHEET_GID = 99866922;

const FEDEX_OAUTH_URL = 'https://apis.fedex.com/oauth/token';
const FEDEX_TRACK_URL = 'https://apis.fedex.com/track/v1/trackingnumbers';

function colIndex(headers, ...keywords) {
  return headers.findIndex(h =>
    keywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );
}

// Convert 0-based column index → letter(s): 0→A, 25→Z, 26→AA
function colLetter(index) {
  let col = '';
  let i = index;
  while (i >= 0) {
    col = String.fromCharCode(65 + (i % 26)) + col;
    i = Math.floor(i / 26) - 1;
  }
  return col;
}

async function getFedExToken() {
  const res = await fetch(FEDEX_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.FEDEX_API_KEY,
      client_secret: process.env.FEDEX_API_SECRET,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FedEx OAuth failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error(`FedEx OAuth returned no token: ${JSON.stringify(data)}`);
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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FedEx Track API failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function main() {
  // Authenticate with Google Sheets
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Resolve tab name from GID
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMeta = meta.data.sheets.find(s => s.properties.sheetId === SHEET_GID);
  if (!sheetMeta) throw new Error(`No sheet found with GID ${SHEET_GID}`);
  const tabName = sheetMeta.properties.title;
  console.log(`Tab: "${tabName}"`);

  // Read all sheet data
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1:ZZ`,
  });
  const rows = readRes.data.values || [];
  if (rows.length < 2) { console.log('Sheet is empty'); return; }

  const headers = rows[0];

  const awbCol = colIndex(headers,
    'awb', 'tracking number', 'tracking #', 'fedex tracking', 'fedex trk', 'trk#', 'airway'
  );
  let stsCol = colIndex(headers,
    'fedex status', 'delivery status', 'fed ex status', 'fedex delivery'
  );

  if (awbCol < 0) {
    throw new Error('AWB/Tracking column not found. Headers: ' + headers.join(' | '));
  }

  // Create FEDEX STATUS column header if it doesn't exist
  if (stsCol < 0) {
    stsCol = headers.length;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!${colLetter(stsCol)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['FEDEX STATUS']] },
    });
    console.log(`Created "FEDEX STATUS" header at column ${colLetter(stsCol)}`);
  }

  // Collect rows with tracking numbers
  const toTrack = [];
  for (let i = 1; i < rows.length; i++) {
    const trk = (rows[i][awbCol] || '').trim();
    if (trk) toTrack.push({ rowIndex: i, tracking: trk });
  }

  if (!toTrack.length) { console.log('No tracking numbers found in sheet'); return; }
  console.log(`Tracking ${toTrack.length} shipment(s)…`);

  // Get FedEx access token
  const token = await getFedExToken();
  console.log('FedEx token OK');

  // Track in batches of 30 (FedEx API limit)
  const BATCH = 30;
  const updates = [];

  for (let i = 0; i < toTrack.length; i += BATCH) {
    const batch = toTrack.slice(i, i + BATCH);
    console.log(`Batch ${Math.floor(i / BATCH) + 1}: tracking ${batch.map(b => b.tracking).join(', ')}`);

    const result = await trackBatch(token, batch.map(b => b.tracking));

    for (const item of (result.output?.completeTrackResults || [])) {
      const trk   = item.trackingNumber;
      const entry = batch.find(b => b.tracking === trk);
      if (!entry) continue;

      const trackResult = item.trackResults?.[0];
      const status =
        trackResult?.latestStatusDetail?.statusByLocale ||
        trackResult?.latestStatusDetail?.description ||
        'Unknown';

      const updatedAt = new Date().toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      updates.push({ rowIndex: entry.rowIndex, value: `${status} · ${updatedAt}` });
    }
  }

  if (!updates.length) { console.log('No status updates returned from FedEx'); return; }

  // Write all statuses back in one batch
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map(u => ({
        range: `${tabName}!${colLetter(stsCol)}${u.rowIndex + 1}`,
        values: [[u.value]],
      })),
    },
  });

  console.log(`✓ Updated ${updates.length} FedEx status(es) in sheet`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
