// 305 Local Print Agent — run with: node print-agent.js
// Polls the workspace for pending print jobs and sends them to the correct printer.
// Keep this terminal window open while the team is printing.

require('dotenv').config();
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const { google } = require('googleapis');
const { print } = require('pdf-to-printer');

const WORKSPACE_URL = 'https://workspace305team.onrender.com';
const POLL_MS       = 2000;

const PRINTERS = {
  'fedex-print': '305 LABEL PRINTER',
  'al-print':    '305 LABEL PRINTER',
  'pl-print':    'Brother HL-L6200DW series Printer',
};

async function downloadFromDrive(link, dest) {
  const match = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Invalid Drive link: ' + link);
  const fileId = match[1];

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth  = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });
  const res   = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.data.pipe(file);
    file.on('finish', () => file.close(resolve));
    file.on('error', reject);
  });
}

function apiFetch(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(WORKSPACE_URL + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function processJob(job) {
  const printer = PRINTERS[job.type];
  if (!printer) {
    console.error(`  Unknown type "${job.type}" for job ${job.id} — skipping`);
    return;
  }
  const tmp = path.join(os.tmpdir(), `print_${job.id}.pdf`);
  try {
    process.stdout.write(`  Downloading ${job.po || job.id} → ${printer} … `);
    await downloadFromDrive(job.link, tmp);
    await print(tmp, { printer });
    console.log('done');
  } finally {
    fs.unlink(tmp, () => {});
  }
}

async function poll() {
  try {
    const jobs = await apiFetch('GET', '/api/print-queue/pending');
    for (const job of jobs) {
      // Remove from queue first so another agent doesn't double-print
      await apiFetch('DELETE', `/api/print-queue/${job.id}`);
      await processJob(job);
    }
  } catch (e) {
    if (!e.message.includes('ECONNREFUSED')) {
      console.error('Poll error:', e.message);
    }
  }
}

console.log('');
console.log('  305 Print Agent');
console.log('  ─────────────────────────────────────────');
console.log('  FedEx / AL Labels  →  305 LABEL PRINTER');
console.log('  Packing Lists      →  Brother HL-L6200DW series Printer');
console.log('  Polling workspace every 2s. Keep this window open.');
console.log('');

setInterval(poll, POLL_MS);
poll(); // first poll immediately
