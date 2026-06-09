// 305 Local Print Agent — run with: node print-agent.js
// Polls the workspace for pending print jobs and sends them to the correct printer.
// Keep this terminal window open while the team is printing.

const https    = require('https');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { execSync } = require('child_process');
const { PDFDocument, degrees } = require('pdf-lib');

const SUMATRA = path.join(__dirname, 'node_modules', 'pdf-to-printer', 'dist', 'SumatraPDF-3.4.6-32.exe');

const WORKSPACE_URL = 'https://workspace305team.onrender.com';
const POLL_MS       = 2000;

const PRINTERS = {
  'fedex-print': '305 LABEL PRINTER',
  'al-print':    '305 LABEL PRINTER',
  'pl-print':    'Brother HL-L6200DW series Printer',
};

// Download PDF through the Render server's pdf-proxy (no local credentials needed)
function downloadPDF(link, dest) {
  const url = `${WORKSPACE_URL}/api/pdf-proxy?link=${encodeURIComponent(link)}`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

// Rotate all pages 270° (equivalent to 90° CW) so a landscape PDF prints
// correctly on portrait thermal stock without relying on driver orientation
async function rotatePdf(inputPath, outputPath) {
  const bytes = fs.readFileSync(inputPath);
  const doc   = await PDFDocument.load(bytes);
  for (const page of doc.getPages()) {
    page.setRotation(degrees(270));
  }
  fs.writeFileSync(outputPath, await doc.save());
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
    await downloadPDF(job.link, tmp);

    if (job.type === 'al-print' || job.type === 'fedex-print') {
      // Rotate landscape PDF 270° so it prints correctly on portrait 4x6 stock
      const rotated = tmp.replace('.pdf', '_r.pdf');
      await rotatePdf(tmp, rotated);
      execSync(
        `"${SUMATRA}" -print-to "${printer}" -print-settings "noscale" -silent "${rotated}"`,
        { timeout: 30000 }
      );
      fs.unlink(rotated, () => {});
    } else {
      // Packing list → Brother, duplex long-edge (both sides)
      execSync(
        `"${SUMATRA}" -print-to "${printer}" -print-settings "duplex" -silent "${tmp}"`,
        { timeout: 30000 }
      );
    }

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
console.log('  305 Print Agent  v4');
console.log('  ─────────────────────────────────────────');
console.log('  FedEx / AL Labels  →  305 LABEL PRINTER  (rotate 270 + noscale)');
console.log('  Packing Lists      →  Brother HL-L6200DW  (duplex)');
console.log('  Polling workspace every 2s. Keep this window open.');
console.log('');

setInterval(poll, POLL_MS);
poll(); // first poll immediately
