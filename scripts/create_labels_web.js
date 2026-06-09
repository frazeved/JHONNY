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

async function dismissCookieBanner(page) {
  await page.evaluate(() => {
    const el = document.getElementById('usercentrics-cmp-ui');
    if (el) el.remove();
  });
}

async function login(page) {
  console.log('  Navigating to FedEx Shipping Plus...');
  await page.goto('https://www.fedex.com/shippingplus/en-us/shipment/create', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await page.waitForTimeout(2000);

  if (page.url().includes('login')) {
    console.log('  Login page detected, signing in...');
    const pwdInput = page.locator('input[type="password"]');
    await pwdInput.waitFor({ state: 'visible', timeout: 25000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => { const el = document.getElementById('usercentrics-cmp-ui'); if (el) el.remove(); });
    // FedEx login: id="username", id="password", id="login_button"
    await page.locator('#username').fill(process.env.FEDEX_WEB_USER);
    await pwdInput.click({ force: true });
    await pwdInput.fill(process.env.FEDEX_WEB_PASSWORD);
    await page.locator('#login_button').click();
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
  await dismissCookieBanner(page);

  // ── Deliver To ──────────────────────────────────────────────────────────────
  await page.getByLabel('CONTACT NAME').fill(to.contact);
  await page.getByLabel('COMPANY').fill(to.company || to.contact);
  await page.getByLabel('PHONE NUMBER').fill(to.phone || '3055550000');
  await page.getByLabel('ADDRESS LINE 1').fill(to.street[0]);
  if (to.street[1]) {
    const line2 = page.getByLabel('ADDRESS LINE 2');
    if (await line2.count()) await line2.fill(to.street[1]);
  }

  // ZIP — auto-fills CITY and STATE dropdowns
  await page.getByLabel('ZIP CODE').fill(to.zip);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(2000);
  console.log('  ZIP entered — city/state should auto-fill');

  // ── Service: FedEx Ground ────────────────────────────────────────────────────
  // The template pre-selects FedEx Ground; verify and select if needed
  const serviceLabel = page.getByLabel('SERVICE');
  const serviceVal = await serviceLabel.inputValue().catch(() => '');
  if (!serviceVal.toLowerCase().includes('ground')) {
    await serviceLabel.click();
    await page.waitForTimeout(400);
    await page.getByRole('option', { name: /fedex ground/i }).first().click()
      .catch(() => page.locator('text=FedEx Ground').first().click());
    await page.waitForTimeout(500);
  }

  // ── Package details ──────────────────────────────────────────────────────────
  // Set package count
  const packagesInput = page.getByLabel('PACKAGES');
  await packagesInput.triple_click().catch(() => packagesInput.click());
  await packagesInput.fill(String(boxes));
  await page.keyboard.press('Tab');

  // Weight — template may already have 20 lb; overwrite to be safe
  const weightInput = page.getByLabel('WEIGHT');
  await weightInput.click();
  await weightInput.selectAll().catch(() => {});
  await page.keyboard.press('Control+a');
  await weightInput.fill(String(WEIGHT_LB));

  // Dimensions — three adjacent inputs after WEIGHT, no unique labels
  // Tab from weight through each dim input
  await weightInput.press('Tab');
  await page.keyboard.type(String(DEFAULT_DIMS.l));
  await page.keyboard.press('Tab');
  await page.keyboard.type(String(DEFAULT_DIMS.w));
  await page.keyboard.press('Tab');
  await page.keyboard.type(String(DEFAULT_DIMS.h));
  await page.keyboard.press('Tab');

  // ── Shipment references ──────────────────────────────────────────────────────
  // Check "Add shipment references" if not already checked
  const refCheckbox = page.getByLabel('Add shipment references');
  if (await refCheckbox.count()) {
    if (!(await refCheckbox.isChecked())) {
      await refCheckbox.check();
      await page.waitForTimeout(600);
    }
    // Fill SHIPMENT REFERENCE and P.O. NO.
    const shipRef = page.getByLabel('SHIPMENT REFERENCE');
    if (await shipRef.count()) { await shipRef.fill(''); await shipRef.fill(po); }
    const poNo = page.getByLabel('P.O. NO.');
    if (await poNo.count()) { await poNo.fill(''); await poNo.fill(po); }
  }

  // ── FINALIZE ─────────────────────────────────────────────────────────────────
  await page.locator('button:has-text("FINALIZE")').click();
  await page.waitForURL('**/shipment/finalized**', { timeout: 45000 });
  await page.waitForSelector('text=Shipment created successfully', { timeout: 20000 });

  // ── Extract tracking + cost ──────────────────────────────────────────────────
  const tracking = await page.locator('text=Tracking ID').locator('..').locator('a').first()
    .textContent().then(t => t.trim()).catch(() => '');

  const costRaw = await page.locator('text=Estimated total cost').locator('..').textContent()
    .catch(() => '');
  const costMatch = costRaw.match(/\$([\d.]+)/);
  const cost = costMatch ? costMatch[1] : '';
  console.log(`  Tracking: ${tracking} | Cost: $${cost}`);

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

  const browser = await chromium.launch({ headless: process.env.SHOW !== '1', slowMo: process.env.SHOW === '1' ? 400 : 0 });
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
