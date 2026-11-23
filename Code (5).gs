/* =========================================================
   VERVAL NOTA — versi ringkas (hanya menu VERVAL)
   Browser -> Apps Script -> IPubers
   ========================================================= */

const VERVAL_ALLOWED_HOSTS = [
  'ext-ipubers.rms-pi.com',
  'ipubers.pupuk-indonesia.com'
];
const VERVAL_PRIMARY_HOST = 'ext-ipubers.rms-pi.com';

function doGet() {
  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle('VERVAL Nota')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* Mengambil PDF dan mengirimnya sebagai base64 agar browser dapat mengubahnya menjadi JPG.
   Karakter "\" pada link (mis. noNota=S09NP1\400403) diperbaiki dulu karena ditolak UrlFetchApp. */
function fetchVervalPdf(url) {
  const MAX_BYTES = 15 * 1024 * 1024;
  const raw = String(url || '').trim().replace(/&amp;/gi, '&').replace(/ /g, '%20');
  const m = raw.match(/^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i);
  const host = m ? m[1].toLowerCase() : '';
  const allowed = VERVAL_ALLOWED_HOSTS.concat(['firebasestorage.googleapis.com']);
  if (!m || allowed.indexOf(host) === -1) return { ok: false, message: 'Alamat PDF tidak diizinkan.' };

  const candidates = /\\/.test(raw) ? [raw.replace(/\\/g, '%2F'), raw.replace(/\\/g, '/')] : [raw];
  let last = 'Gagal mengambil PDF.';

  for (let i = 0; i < candidates.length; i++) {
    try {
      const res = UrlFetchApp.fetch(candidates[i], {
        method: 'get', followRedirects: true, muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
          'Accept': 'application/pdf,application/octet-stream,*/*',
          'Referer': 'https://ext-ipubers.rms-pi.com/'
        }
      });
      const status = res.getResponseCode();
      if (status < 200 || status >= 300) { last = 'HTTP ' + status; continue; }
      const bytes = res.getContent();
      if (!bytes || !bytes.length) { last = 'File PDF kosong.'; continue; }
      if (bytes.length > MAX_BYTES) return { ok: false, message: 'Ukuran PDF melebihi batas.' };
      return { ok: true, status: status, size: bytes.length, base64: Utilities.base64Encode(bytes) };
    } catch (e) {
      last = e && e.message ? e.message : String(e);
    }
  }
  return { ok: false, message: last };
}

/* Mengambil seluruh nota dalam satu panggilan (fetchAll per chunk internal). */
function fetchVervalAll(urls) {
  urls = Array.isArray(urls) ? urls : [];
  if (!urls.length) return { ok: true, total: 0, results: [] };

  const INTERNAL_CHUNK = 25;
  const out = new Array(urls.length);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://ext-ipubers.rms-pi.com/'
  };

  for (let start = 0; start < urls.length; start += INTERNAL_CHUNK) {
    const end = Math.min(urls.length, start + INTERNAL_CHUNK);
    const jobs = [];

    for (let i = start; i < end; i++) {
      const checked = normalizeVervalUrl_(urls[i]);
      if (!checked.ok) {
        out[i] = { index: i, ok: false, status: 0, url: String(urls[i] || ''),
                   message: checked.message || 'URL nota tidak valid.' };
        continue;
      }
      jobs.push({ index: i, url: checked.url });
    }
    if (!jobs.length) continue;

    try {
      const responses = UrlFetchApp.fetchAll(jobs.map(job => ({
        url: job.url, method: 'get', followRedirects: true,
        muteHttpExceptions: true, headers: headers
      })));

      responses.forEach((response, n) => {
        const job = jobs[n];
        const status = response.getResponseCode();
        const h = response.getHeaders();
        const contentType = String(h['Content-Type'] || h['content-type'] || '');
        const html = response.getContentText() || '';
        const ok = status >= 200 && status < 400 && html.length > 0;
        out[job.index] = {
          index: job.index, ok: ok, status: status, url: job.url,
          contentType: contentType,
          html: ok ? slimVervalHtml_(html) : '',
          message: ok ? '' : ('HTTP ' + status + (html ? ' • respons nota tidak valid.' : ' • respons kosong.'))
        };
      });
    } catch (e) {
      jobs.forEach(job => {
        out[job.index] = { index: job.index, ok: false, status: 0, url: job.url,
          message: 'Gagal mengambil nota: ' + (e && e.message ? e.message : String(e)) };
      });
    }
  }

  for (let i = 0; i < urls.length; i++) {
    if (!out[i]) out[i] = { index: i, ok: false, status: 0, url: urls[i],
                            message: 'Tidak ada respons dari server.' };
  }
  return { ok: true, total: urls.length, results: out };
}

/* Memangkas HTML nota: buang script, style, komentar, dan gambar base64. */
function slimVervalHtml_(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])data:[^"']*\2/gi, '$1$2$2');
}

/* Normalisasi dan validasi URL nota (hanya host IPubers yang diizinkan). */
function normalizeVervalUrl_(input) {
  let raw = String(input || '').trim();
  const urlRe = /https:\/\/(?:ext-ipubers\.rms-pi\.com|ipubers\.pupuk-indonesia\.com)\/public\/download\/bukti-transaksi\/V2(?:\?[^\s\]\)<>|]*)?/i;
  const m = raw.match(urlRe);
  if (m && m[0]) raw = m[0];

  raw = raw.replace(/\\&/g, '&').replace(/&amp;/gi, '&').replace(/[\[\]()<>|]/g, '').trim();

  const strict = raw.match(
    /^https:\/\/(ext-ipubers\.rms-pi\.com|ipubers\.pupuk-indonesia\.com)(\/public\/download\/bukti-transaksi\/V2)(\?[^\s]*)?$/i
  );
  if (!strict) {
    return { ok: false, status: 400, message: 'Link tidak valid setelah ekstraksi: ' + raw };
  }

  const host = strict[1].toLowerCase();
  const finalHost = host === 'ipubers.pupuk-indonesia.com' ? VERVAL_PRIMARY_HOST : host;
  return { ok: true, url: 'https://' + finalHost + strict[2] + (strict[3] || '') };
}
