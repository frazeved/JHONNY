require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID  = '1y0iL7PJldbVQmPIAnJi9wvA2hvjB8_aK2bU2kxvUf5Q';
const TAB_NAME  = 'Warehouse Now Database';
const FEDEX_FOLDER_ID = '1ufkdrO23m2C-MrmhR1iKN3QFSJFwuQPY';

const FEDEX_BASE = process.env.FEDEX_ENV === 'production'
  ? 'https://apis.fedex.com'
  : 'https://apis-sandbox.fedex.com';

const ADDRESS_BOOK = require('../resources/fedex-address-book');

const WEIGHT_LB = 20;
const DEFAULT_DIMS = { l: 20, w: 12, h: 12 };

function colIndex(headers, ...keys) {
  return headers.findIndex(h => keys.some(k => h.toLowerCase().includes(k.toLowerCase())));
}
function colLetter(i) {
  let col = '', n = i;
  while (n >= 0) { col = String.fromCharCode(65 + (n % 26)) + col; n = Math.floor(n / 26) - 1; }
  return col;
}

function currentMonth() {
  return new Date().toLocaleString('en-US', { month: 'long' }).toUpperCase();
}

async function getFedExToken() {
  const res = await fetch(`${FEDEX_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${process.env.FEDEX_API_KEY}&client_secret=${process.env.FEDEX_API_SECRET}`,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`FedEx token error: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function createShipment(token, { po, to, boxes, dims }) {
  const packages = Array.from({ length: boxes }, (_, i) => ({
    sequenceNumber: i + 1,
    weight:     { units: 'LB', value: WEIGHT_LB },
    dimensions: { length: dims.l, width: dims.w, height: dims.h, units: 'IN' },
  }));

  const payload = {
    labelResponseOptions: 'LABEL',
    requestedShipment: {
      shipper: {
        contact: { personName: ADDRESS_BOOK.SHIP_FROM.contact, companyName: ADDRESS_BOOK.SHIP_FROM.company, phoneNumber: ADDRESS_BOOK.SHIP_FROM.phone },
        address: { streetLines: ADDRESS_BOOK.SHIP_FROM.street, city: ADDRESS_BOOK.SHIP_FROM.city, stateOrProvinceCode: ADDRESS_BOOK.SHIP_FROM.state, postalCode: ADDRESS_BOOK.SHIP_FROM.zip, countryCode: ADDRESS_BOOK.SHIP_FROM.country },
      },
      recipients: [{
        contact: { personName: to.contact, companyName: to.company, phoneNumber: to.phone || '3055550000' },
        address: { streetLines: to.street, city: to.city, stateOrProvinceCode: to.state, postalCode: to.zip, countryCode: to.country },
      }],
      serviceType: 'FEDEX_GROUND',
      packagingType: 'YOUR_PACKAGING',
      pickupType: 'USE_SCHEDULED_PICKUP',
      shippingChargesPayment: {
        paymentType: 'SENDER',
        payor: { responsibleParty: { accountNumber: { value: process.env.FEDEX_ACCOUNT_NUMBER } } },
      },
      labelSpecification: { labelFormatType: 'COMMON2D', imageType: 'PDF', labelStockType: 'PAPER_4X6' },
      customerReferences: [{ customerReferenceType: 'CUSTOMER_REFERENCE', value: po }],
      requestedPackageLineItems: packages,
    },
    accountNumber: { value: process.env.FEDEX_ACCOUNT_NUMBER },
  };

  const res = await fetch(`${FEDEX_BASE}/ship/v1/shipments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-locale': 'en_US' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`FedEx ship error: ${JSON.stringify(data.errors || data)}`);
  return data;
}

async function uploadToAppsScript(pdfBase64, filename, month) {
  const scriptUrl    = process.env.GDRIVE_APPS_SCRIPT_URL;
  const scriptSecret = process.env.GDRIVE_APPS_SCRIPT_SECRET;
  if (!scriptUrl) throw new Error('GDRIVE_APPS_SCRIPT_URL not set');

  const body = JSON.stringify({ secret: scriptSecret, pdf: pdfBase64, filename, folderId: FEDEX_FOLDER_ID, month });
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'manual' };
  let resp = await fetch(scriptUrl, opts);
  let hops = 0;
  while ([301,302,307,308].includes(resp.status) && hops++ < 5) {
    resp = await fetch(resp.headers.get('location'), opts);
  }

  const text = await resp.text();
  try {
    const result = JSON.parse(text);
    if (result.webViewLink) return result.webViewLink;
  } catch (_) {}

  // fallback: look up by filename in Drive
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth  = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });
  const r = await drive.files.list({
    q: `name='${filename}' and trashed=false`,
    fields: 'files(id,webViewLink)',
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  if (r.data.files.length > 0) return r.data.files[0].webViewLink;
  throw new Error(`Upload may have succeeded but file not found in Drive for ${filename}`);
}

async function run() {
  const filterPOs = process.env.PO_NUMBERS
    ? process.env.PO_NUMBERS.split(',').map(p => p.trim()).filter(Boolean)
    : null;

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth   = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const r      = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: TAB_NAME });
  const rows   = r.data.values || [];
  if (rows.length < 2) throw new Error('No data in sheet');

  const H = rows[0].map(h => (h || '').trim());
  const C = {
    po:       colIndex(H, 'po#', 'po number'),
    status:   colIndex(H, 'status'),
    shipTo:   colIndex(H, 'ship to'),
    boxes:    colIndex(H, 'box', 'carton', 'ctns', 'ctn qty'),
    fxLink:   colIndex(H, 'fedex label link', 'fedex link'),
    style:    colIndex(H, 'style#', 'style'),
    shipType: colIndex(H, 'shipping type'),
    carrier:  colIndex(H, 'carrier'),
    tracking: colIndex(H, 'tracking #', 'tracking number', 'tracking no'),
    cost:     colIndex(H, 'shipping cost', 'freight cost'),
    fxCheck:  colIndex(H, '🏷️', 'fedex label 🏷'),
  };

  console.log('Columns:', Object.entries(C).map(([k,v]) => `${k}=${v >= 0 ? colLetter(v) : 'N/A'}`).join(' | '));

  let lastStyle = '';
  const poRows = [];
  for (let i = 1; i < rows.length; i++) {
    const row    = rows[i];
    const style  = (row[C.style] || '').trim() || lastStyle;
    if ((row[C.style] || '').trim()) lastStyle = style;
    const po     = (row[C.po] || '').trim();
    const status = (row[C.status] || '').trim().toLowerCase();
    if (!po) continue;
    if (filterPOs && !filterPOs.includes(po)) continue;
    poRows.push({ rowIndex: i + 1, po, style, status, row });
  }

  if (!poRows.length) { console.log('No matching POs found.'); return; }
  console.log(`Processing ${poRows.length} PO(s): ${poRows.map(r => r.po).join(', ')}`);

  const token = await getFedExToken();
  console.log('FedEx token OK');

  const month = currentMonth();
  console.log(`Saving to folder: ${month}`);

  let ok = 0, fail = 0;
  const updates = [];

  for (const { rowIndex, po, row } of poRows) {
    console.log(`\n── PO ${po}`);
    try {
      const shipToCode = (row[C.shipTo] || '').trim().toUpperCase();
      const to = ADDRESS_BOOK[shipToCode];
      if (!to) throw new Error(`Unknown SHIP TO code: "${shipToCode}" — add it to fedex-address-book.js`);

      const boxCount = parseInt(row[C.boxes] || '1') || 1;
      console.log(`  Ship To: ${shipToCode} (${to.city}, ${to.state}) | Boxes: ${boxCount}`);

      const data = await createShipment(token, { po, to, boxes: boxCount, dims: DEFAULT_DIMS });
      const shipment = data.output?.transactionShipments?.[0];
      const tracking = shipment?.masterTrackingNumber;
      console.log(`  Tracking: ${tracking}`);

      // Extract shipping cost
      const rateDetails = shipment?.completedShipmentDetail?.shipmentRating?.shipmentRateDetails;
      const shippingCost = rateDetails?.[0]?.totalNetCharge?.amount ?? '';

      // Collect all label PDFs (one per box)
      const pieces = shipment?.pieceResponses || [];
      const labelBuffers = [];
      for (const piece of pieces) {
        const doc = piece?.packageDocuments?.[0];
        if (doc?.encodingType === 'BASE64' && doc?.docType === 'LABEL') {
          labelBuffers.push(Buffer.from(doc.encodedLabel, 'base64'));
        }
      }
      if (!labelBuffers.length) throw new Error('No label PDF returned by FedEx');

      // Upload each label; store first link in sheet
      let firstLink = null;
      for (let b = 0; b < labelBuffers.length; b++) {
        const filename = labelBuffers.length === 1 ? `FDEX ${po}.pdf` : `FDEX ${po} BOX${b+1}.pdf`;
        const b64      = labelBuffers[b].toString('base64');
        const link     = await uploadToAppsScript(b64, filename, month);
        console.log(`  Uploaded: ${filename} → ${link}`);
        if (b === 0) firstLink = link;
      }

      updates.push({ rowIndex, po, link: firstLink, tracking, shippingCost });
      ok++;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      fail++;
    }
  }

  // Write all columns back to sheet
  if (updates.length) {
    const data = [];
    for (const u of updates) {
      if (C.fxLink >= 0)   data.push({ range: `${TAB_NAME}!${colLetter(C.fxLink)}${u.rowIndex}`,   values: [[u.link]] });
      if (C.shipType >= 0) data.push({ range: `${TAB_NAME}!${colLetter(C.shipType)}${u.rowIndex}`, values: [['FEDEX GROUND']] });
      if (C.carrier >= 0)  data.push({ range: `${TAB_NAME}!${colLetter(C.carrier)}${u.rowIndex}`,  values: [['FEDEX']] });
      if (C.tracking >= 0) data.push({ range: `${TAB_NAME}!${colLetter(C.tracking)}${u.rowIndex}`, values: [[u.tracking || '']] });
      if (C.cost >= 0)     data.push({ range: `${TAB_NAME}!${colLetter(C.cost)}${u.rowIndex}`,     values: [[u.shippingCost]] });
      if (C.fxCheck >= 0)  data.push({ range: `${TAB_NAME}!${colLetter(C.fxCheck)}${u.rowIndex}`,  values: [['✅']] });
    }
    if (data.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data },
      });
      console.log(`\nSheet updated for ${updates.length} PO(s)`);
    }
  }

  console.log(`\n=== Done: ${ok} label(s) created, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
