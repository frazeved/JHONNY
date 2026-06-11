require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID         = '1y0iL7PJldbVQmPIAnJi9wvA2hvjB8_aK2bU2kxvUf5Q';
const SHEET_GID        = 99866922;
const TAB_NAME         = 'Warehouse Now Database';
const FEDEX_STATUS_COL = 36; // Column AK (0-based) — hardcoded fallback

const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

const FEDEX_BASE      = process.env.FEDEX_ENV === 'production'
  ? 'https://apis.fedex.com'
  : 'https://apis-sandbox.fedex.com';
const FEDEX_OAUTH_URL = `${FEDEX_BASE}/oauth/token`;
const FEDEX_TRACK_URL = `${FEDEX_BASE}/track/v1/trackingnumbers`;
const FEDEX_REF_URL   = `${FEDEX_BASE}/track/v1/referencenumbers`;

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

function normalizeTracking(raw) {
  if (!raw) return '';
  let text = String(raw).trim();
  text = text.replace(/\bAWB\b[:\s-]*/gi, '');
  text = text.replace(/[^0-9A-Za-z]/g, '');
  return text;
}

function nowLabel() {
  return new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function extractEventDate(item) {
  const tr = item.trackResults?.[0] || item;
  const dates = tr?.dateAndTimes || [];
  const priority = ['ACTUAL_DELIVERY', 'ESTIMATED_DELIVERY', 'ACTUAL_TENDER', 'SHIP'];
  for (const type of priority) {
    const entry = dates.find(d => d.type === type);
    if (entry?.dateTime) {
      return new Date(entry.dateTime).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    }
  }
  if (dates.length > 0 && dates[0].dateTime) {
    return new Date(dates[0].dateTime).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }
  return nowLabel();
}

function extractStatus(item) {
  const tr = item.trackResults?.[0] || item;
  return tr?.latestStatusDetail?.statusByLocale
      || tr?.latestStatusDetail?.description
      || tr?.statusDetail?.statusByLocale
      || tr?.statusDetail?.description
      || tr?.statusCode
      || item?.statusCode
      || null;
}

function extractSpecificDate(item, ...types) {
  const tr = item.trackResults?.[0] || item;
  const dates = tr?.dateAndTimes || [];
  for (const type of types) {
    const entry = dates.find(d => d.type === type);
    if (entry?.dateTime) {
      return new Date(entry.dateTime).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: '2-digit',
      });
    }
  }
  return null;
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

async function trackBatch(token, trackingNumbers, attempt = 1) {
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
        associatedAccountNumber: process.env.FEDEX_ACCOUNT_NUMBER
          ? { value: process.env.FEDEX_ACCOUNT_NUMBER }
          : undefined,
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Retry once on 503 / service unavailable after a short wait
    if ((res.status === 503 || res.status === 429) && attempt < 3) {
      const wait = attempt * 10000;
      console.log(`  FedEx ${res.status} — retrying in ${wait/1000}s (attempt ${attempt}/3)…`);
      await new Promise(r => setTimeout(r, wait));
      return trackBatch(token, trackingNumbers, attempt + 1);
    }
    throw new Error(`FedEx Track failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function trackByReference(token, po) {
  const today = new Date();
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const fmt = d => d.toISOString().split('T')[0];

  const res = await fetch(FEDEX_REF_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-locale': 'en_US',
    },
    body: JSON.stringify({
      referencesInformation: {
        value: po,
        type: 'PURCHASE_ORDER',
        accountNumber: process.env.FEDEX_ACCOUNT_NUMBER || '',
        shipDateBegin: fmt(sixMonthsAgo),
        shipDateEnd: fmt(today),
      },
    }),
  });
  if (!res.ok) {
    console.log(`  Reference lookup HTTP ${res.status} for PO ${po}`);
    return null;
  }
  return res.json();
}

async function main() {
  console.log(`FedEx base: ${FEDEX_BASE}`);
  console.log(`Tab: "${TAB_NAME}"`);

  // Step 1 — Read sheet
  console.log('Step 1: Reading sheet CSV…');
  const csvRes = await fetch(CSV_URL);
  if (!csvRes.ok) throw new Error(`CSV fetch failed: ${csvRes.status}`);
  const rows = parseCSV(await csvRes.text());
  if (rows.length < 2) { console.log('Sheet has no data'); return; }
  console.log(`Read ${rows.length - 1} data rows`);

  const headers = rows[0];
  console.log('Headers:', headers.slice(0, 10).join(' | '));

  const awbCol = colIndex(headers, 'tracking number');
  const poCol  = colIndex(headers, 'po#', 'po number', 'purchase order');
  const stsColDynamic = colIndex(headers, 'delivery status', 'fedex status');
  const stsCol = stsColDynamic >= 0 ? stsColDynamic : FEDEX_STATUS_COL;
  const delivDateCol   = colIndex(headers, 'delivery date');
  let shippedDateCol   = colIndex(headers, 'fedex pick up', 'fedex pickup');
  if (shippedDateCol < 0) shippedDateCol = colIndex(headers, 'shipped date');

  if (awbCol < 0) throw new Error('AWB/Tracking column not found. Headers: ' + headers.join(' | '));
  console.log(`AWB column: ${colLetter(awbCol)} (index ${awbCol})`);
  console.log(`PO# column: ${poCol >= 0 ? colLetter(poCol) : 'not found'}`);
  console.log(`FEDEX STATUS column: ${colLetter(stsCol)}`);
  console.log(`DELIVERY DATE column: ${delivDateCol >= 0 ? `${colLetter(delivDateCol)} ("${headers[delivDateCol]}")` : 'not found'}`);
  console.log(`PICKUP DATE column:   ${shippedDateCol >= 0 ? `${colLetter(shippedDateCol)} ("${headers[shippedDateCol]}")` : 'not found'}`);

  // Step 2 — Auth Google Sheets
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

  // Step 3 — Ensure header exists
  const headerAtAK = (headers[stsCol] || '').trim();
  if (!headerAtAK) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB_NAME}!${colLetter(stsCol)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['DELIVERY STATUS']] },
    });
    console.log('Header "DELIVERY STATUS" created');
  } else {
    console.log(`Column ${colLetter(stsCol)} header: "${headerAtAK}"`);
  }

  // Step 4 — Separate rows: has tracking vs needs reference search
  const toTrack   = []; // rows with a tracking number
  const refQueue  = []; // rows with no tracking — search by PO#

  for (let i = 1; i < rows.length; i++) {
    const raw      = (rows[i][awbCol] || '').trim();
    const tracking = normalizeTracking(raw);
    const po       = poCol >= 0 ? (rows[i][poCol] || '').trim() : '';

    if (tracking) {
      toTrack.push({ rowIndex: i, raw, tracking, po });
    } else if (po) {
      refQueue.push({ rowIndex: i, po });
    }
  }
  console.log(`Found ${toTrack.length} with tracking, ${refQueue.length} with PO# only`);

  const token = await getFedExToken();
  console.log('FedEx token OK');

  const updates       = []; // delivery status text
  const delivUpdates  = []; // delivery date (ACTUAL_DELIVERY)
  const pickupUpdates = []; // pickup date
  let dateTypesLogged = false; // log date types from first result once

  // Step 5 — Track by tracking number (batches of 30)
  const BATCH = 30;
  for (let i = 0; i < toTrack.length; i += BATCH) {
    const batch = toTrack.slice(i, i + BATCH);
    console.log(`Tracking batch ${Math.floor(i/BATCH)+1}: ${batch.length} numbers`);
    const result = await trackBatch(token, batch.map(b => b.tracking));

    const batchUpdated = new Set();
    for (const item of (result.output?.completeTrackResults || [])) {
      const returnedTracking = normalizeTracking(item.trackingNumber || item.trackingNumberInfo?.trackingNumber || '');
      const entry = batch.find(b => b.tracking === returnedTracking);
      if (!entry) continue;

      const status = extractStatus(item);
      if (status) {
        updates.push({ rowIndex: entry.rowIndex, value: `${status} · ${extractEventDate(item)}` });
        batchUpdated.add(entry.rowIndex);

        // Log available date types from first result to diagnose pickup date
        if (!dateTypesLogged) {
          const tr = item.trackResults?.[0] || item;
          const types = (tr?.dateAndTimes || []).map(d => `${d.type}=${d.dateTime}`);
          console.log(`  Date types in first result: ${types.join(' | ') || 'none'}`);
          dateTypesLogged = true;
        }

        const delivDate  = extractSpecificDate(item, 'ACTUAL_DELIVERY');
        const pickupDate = extractSpecificDate(item, 'ACTUAL_TENDER', 'SHIP', 'ACTUAL_PICKUP', 'SHIP_DATE');
        if (delivDate  && delivDateCol   >= 0) delivUpdates.push({ rowIndex: entry.rowIndex, value: delivDate });
        if (pickupDate && shippedDateCol >= 0) pickupUpdates.push({ rowIndex: entry.rowIndex, value: pickupDate });
      }
    }

    // Tracking number returned no result — queue for reference search
    for (const entry of batch) {
      if (!batchUpdated.has(entry.rowIndex)) {
        console.log(`  No result for tracking ${entry.raw} — queuing PO# ${entry.po} for reference search`);
        if (entry.po) refQueue.push({ rowIndex: entry.rowIndex, po: entry.po });
        else updates.push({ rowIndex: entry.rowIndex, value: `Not Found · ${nowLabel()}` });
      }
    }
  }

  // Step 6 — Reference search by PO# for all queued rows
  if (refQueue.length) {
    console.log(`Step 6: Reference search for ${refQueue.length} PO(s)…`);
    for (const entry of refQueue) {
      console.log(`  Searching PO# ${entry.po}…`);
      const result = await trackByReference(token, entry.po);
      const trackResults = result?.output?.completeTrackResults || [];

      if (trackResults.length > 0) {
        const status = extractStatus(trackResults[0]);
        if (status) {
          console.log(`  Found: ${status}`);
          updates.push({ rowIndex: entry.rowIndex, value: `${status} · ${extractEventDate(trackResults[0])}` });
          const delivDate  = extractSpecificDate(trackResults[0], 'ACTUAL_DELIVERY');
          const pickupDate = extractSpecificDate(trackResults[0], 'ACTUAL_TENDER', 'SHIP');
          if (delivDate  && delivDateCol   >= 0) delivUpdates.push({ rowIndex: entry.rowIndex, value: delivDate });
          if (pickupDate && shippedDateCol >= 0) pickupUpdates.push({ rowIndex: entry.rowIndex, value: pickupDate });
          continue;
        }
      }
      console.log(`  Not found via reference`);
      updates.push({ rowIndex: entry.rowIndex, value: `Not Found · ${nowLabel()}` });
    }
  }

  console.log(`Updates collected — status: ${updates.length}, delivery: ${delivUpdates.length}, pickup: ${pickupUpdates.length}`);
  if (!updates.length) { console.log('No status updates from FedEx'); return; }

  // Step 7 — Write back to sheet (status + delivery date + pickup date)
  console.log(`Writing ${updates.length} status, ${delivUpdates.length} delivery date, ${pickupUpdates.length} pickup date update(s)…`);
  const allWrites = [
    ...updates.map(u => ({
      range: `${TAB_NAME}!${colLetter(stsCol)}${u.rowIndex + 1}`,
      values: [[u.value]],
    })),
    ...delivUpdates.map(u => ({
      range: `${TAB_NAME}!${colLetter(delivDateCol)}${u.rowIndex + 1}`,
      values: [[u.value]],
    })),
    ...pickupUpdates.map(u => ({
      range: `${TAB_NAME}!${colLetter(shippedDateCol)}${u.rowIndex + 1}`,
      values: [[u.value]],
    })),
  ];
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: allWrites },
  });

  console.log(`✓ Done — ${updates.length} status, ${delivUpdates.length} delivery date, ${pickupUpdates.length} pickup date written`);

  // ─── Paul: SAMPLE DATABASE NEW status refresh ──────────────────────────────
  console.log('\nStep 8: Updating Paul SAMPLE DATABASE NEW…');
  const PAUL_GID = 1659676838;
  const paulMeta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' });
  const paulSampleSheet = paulMeta.data.sheets.find(s => s.properties.sheetId === PAUL_GID);
  if (!paulSampleSheet) { console.log('  Paul tab not found (gid 1659676838)'); return; }

  const paulTabName = paulSampleSheet.properties.title;
  const pResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `'${paulTabName}'`, valueRenderOption: 'FORMATTED_VALUE',
  });
  const pRows    = pResp.data.values || [];
  const pHeaders = (pRows[0] || []).map(h => String(h).trim());
  const pTrackI  = pHeaders.findIndex(h => h.toUpperCase().includes('TRACKING'));
  const pStatusI = pHeaders.findIndex(h => h.toUpperCase() === 'FEDEX STATUS');

  if (pTrackI < 0 || pStatusI < 0) {
    console.log(`  Paul: TRACKING col=${pTrackI}, STATUS col=${pStatusI} — skipping`);
    return;
  }
  if (pRows.length < 2) { console.log('  Paul sheet has no data rows'); return; }

  const paulToTrack = [];
  for (let i = 1; i < pRows.length; i++) {
    const trk = normalizeTracking((pRows[i][pTrackI] || '').trim());
    if (trk) paulToTrack.push({ rowIndex: i, tracking: trk });
  }
  console.log(`  ${paulToTrack.length} Paul rows with tracking numbers`);
  if (!paulToTrack.length) return;

  const paulUpdates = [];
  for (let i = 0; i < paulToTrack.length; i += BATCH) {
    const batch  = paulToTrack.slice(i, i + BATCH);
    const result = await trackBatch(token, batch.map(b => b.tracking));
    for (const item of (result.output?.completeTrackResults || [])) {
      const rt    = normalizeTracking(item.trackingNumber || item.trackingNumberInfo?.trackingNumber || '');
      const entry = batch.find(b => b.tracking === rt);
      if (!entry) continue;
      const status = extractStatus(item);
      if (status) paulUpdates.push({ rowIndex: entry.rowIndex, value: `${status} · ${extractEventDate(item)}` });
    }
  }

  if (!paulUpdates.length) { console.log('  Paul: no status updates from FedEx'); return; }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: paulUpdates.map(u => ({
        range: `'${paulTabName}'!${colLetter(pStatusI)}${u.rowIndex + 1}`,
        values: [[u.value]],
      })),
    },
  });
  console.log(`  ✓ Paul: ${paulUpdates.length} status values written`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  if (err.response?.data) console.error('API response:', JSON.stringify(err.response.data));
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
