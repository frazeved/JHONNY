require('dotenv').config();
const { chromium } = require('playwright');
const { google } = require('googleapis');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SHEET_ID      = '1y0iL7PJldbVQmPIAnJi9wvA2hvjB8_aK2bU2kxvUf5Q';
const TAB_NAME      = 'Warehouse Now Database';
const FEDEX_FOLDER_ID = '1ufkdrO23m2C-MrmhR1iKN3QFSJFwuQPY';
const ADDRESS_BOOK  = require('../resources/fedex-address-book');

const WEIGHT_LB   = 20;
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

async function login(page) {
  console.log('  Navigating to FedEx Shipping Plus...');
  await page.goto('https://www.fedex.com/shippingplus/en-us/shipment/create', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await page.waitForTimeout(2000);

  if (!page.url().includes('shippingplus')) {
    console.log('  Login page detected, signing in...');
    await page.waitForSelector('input[name="userid"], #userId, input[type="text"]', { timeout: 15000 });
    await page.locator('input[name="userid"], #userId, input[type="text"]').first().fill(process.env.FEDEX_WEB_USER);
    await page.locator('input[type="password"]').fill(process.env.FEDEX_WEB_PASSWORD);
    await page.locator('button:has-text("LOG IN"), input[value="LOG IN"]').click();
    await page.waitForURL('**/shippingplus/**', { timeout: 30000 });
    console.log('  Logged in OK');
  } else {
    console.log('  Already authenticated');
  }
}

async function createLabelWeb(page, { po, to, boxes }) {
  await page.goto('https://www.fedex.com/shippingplus/en-us/shipment/create', {
    waitUntil: 'networkidle', timeout: 45000,
  });
  await page.waitForSelector('text=Create shipment', { timeout: 20000 });
  await page.waitForTimeout(2000);

  // ── Deliver To ──────────────────────────────────────────────────────────────
  await page.getByLabel('CONTACT NAME').fill(to.contact);
  await page.getByLabel('COMPANY').fill(to.company || to.contact);
  await page.getByLabel('PHONE NUMBER').fill(to.phone || '3055550000');
  await page.getByLabel('ADDRESS LINE 1').fill(to.street[0]);
  if (to.street[1]) {
    const line2 = page.getByLabel('ADDRESS LINE 2');
    if (await line2.count()) await line2.fill(to.street[1]);
  }

  // ZIP — triggers city/state auto-fill
  await page.getByLabel('ZIP CODE').fill(to.zip);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1500);

  // Verify city filled; fill manually if not
  const cityInput = page.getByLabel('CITY');
  if (await cityInput.count() && !(await cityInput.inputValue())) {
    await cityInput.fill(to.city);
  }

  // ── Service: FedEx Ground ────────────────────────────────────────────────────
  // Click SERVICE dropdown trigger
  const serviceDropdown = page.locator('[id*="service"], [name*="service"], label:has-text("SERVICE")').last();
  await serviceDropdown.locator('..').locator('..').click().catch(async () => {
    await page.locator('text=SERVICE').locator('..').click();
  });
  await page.waitForTimeout(500);
  await page.getByRole('option', { name: /fedex ground/i }).first().click().catch(async () => {
    await page.locator('text=FedEx Ground').first().click();
  });
  await page.waitForTimeout(500);

  // ── Package details ──────────────────────────────────────────────────────────
  const packagesInput = page.getByLabel('PACKAGES');
  await packagesInput.fill('');
  await packagesInput.fill(String(boxes));
  await page.keyboard.press('Tab');

  const weightInput = page.getByLabel('WEIGHT');
  await weightInput.fill('');
  await weightInput.fill(String(WEIGHT_LB));
  await page.keyboard.press('Tab');

  // Dimensions L × W × H
  const dimL = page.locator('input[placeholder="L"]').first();
  const dimW = page.locator('input[placeholder="W"]').first();
  const dimH = page.locator('input[placeholder="H"]').first();
  await dimL.fill(String(DEFAULT_DIMS.l));
  await dimW.fill(String(DEFAULT_DIMS.w));
  await dimH.fill(String(DEFAULT_DIMS.h));
  await page.keyboard.press('Tab');

  // ── Shipment reference = PO number ──────────────────────────────────────────
  const refCheckbox = page.getByLabel('Add shipment references');
  if (await refCheckbox.count() && !(await refCheckbox.isChecked())) {
    await refCheckbox.check();
    await page.waitForTimeout(500);
  }
  const refInput = page.getByPlaceholder('Reference').first();
  if (await refInput.count()) await refInput.fill(`PO#${po}`);

  // ── FINALIZE ─────────────────────────────────────────────────────────────────
  await page.locator('button:has-text("FINALIZE")').click();
  await page.waitForURL('**/shipment/finalized**', { timeout: 45000 });
  await page.waitForSelector('text=Shipment created successfully', { timeout: 20000 });

  // ── Extract tracking + cost ──────────────────────────────────────────────────
  const tracking = await page.locator('text=Tracking ID').locator('..').locator('a').first().textContent()
    .then(t => t.trim()).catch(() => '');

  const costRaw = await page.locator('text=Estimated total cost').locator('..').textContent()
    .catch(() => '');
  const costMatch = costRaw.match(/\$([\d.]+)/);
  const cost = costMatch ? costMatch[1] : '';

  // ── Download label PDF ───────────────────────────────────────────────────────
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('button:has-text("DOWNLOAD"), a:has-text("DOWNLOAD")').last().click(),
  ]);

  const tmpPath = path.join(os.tmpdir(), `FDEX_${po}.pdf`);
  await download.saveAs(tmpPath);
  const pdfBase64 = fs.readFileSync(tmpPath).toString('base64');
  fs.unlinkSync(tmpPath);

  return { tracking, cost, pdfBase64 };
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

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth  = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });
  const r = await drive.files.list({
    q: `name='${filename}' and trashed=false`,
    fields: 'files(id,webViewLink)',
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  if (r.data.files.length > 0) return r.data.files[0].webViewLink;
  throw new Error(`Upload succeeded but file not found in Drive for ${filename}`);
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
    const row   = rows[i];
    const style = (row[C.style] || '').trim() || lastStyle;
    if ((row[C.style] || '').trim()) lastStyle = style;
    const po = (row[C.po] || '').trim();
    if (!po) continue;
    if (filterPOs && !filterPOs.includes(po)) continue;
    poRows.push({ rowIndex: i + 1, po, style, row });
  }

  if (!poRows.length) { console.log('No matching POs found.'); return; }
  console.log(`Processing ${poRows.length} PO(s): ${poRows.map(r => r.po).join(', ')}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page    = await context.newPage();

  try {
    await login(page);

    const month = currentMonth();
    let ok = 0, fail = 0;
    const updates = [];

    for (const { rowIndex, po, row } of poRows) {
      console.log(`\n── PO ${po}`);
      try {
        const shipToCode = (row[C.shipTo] || '').trim().toUpperCase();
        const to = ADDRESS_BOOK[shipToCode];
        if (!to) throw new Error(`Unknown SHIP TO code: "${shipToCode}"`);

        const boxCount = parseInt(row[C.boxes] || '1') || 1;
        console.log(`  Ship To: ${shipToCode} (${to.city}, ${to.state}) | Boxes: ${boxCount}`);

        const { tracking, cost, pdfBase64 } = await createLabelWeb(page, { po, to, boxes: boxCount });
        console.log(`  Tracking: ${tracking} | Cost: $${cost}`);

        const filename = `FDEX ${po}.pdf`;
        const link = await uploadToAppsScript(pdfBase64, filename, month);
        console.log(`  Uploaded: ${filename} → ${link}`);

        updates.push({ rowIndex, po, link, tracking, shippingCost: cost });
        ok++;
      } catch (err) {
        console.error(`  FAILED: ${err.message}`);
        await page.screenshot({ path: path.join(os.tmpdir(), `error_${po}.png`) }).catch(() => {});
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
  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
