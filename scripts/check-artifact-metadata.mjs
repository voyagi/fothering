#!/usr/bin/env node
// check-artifact-metadata.mjs - binary artifacts must not carry identity or tool metadata.
//
// The text scanners (the slop gate, check-ship-artifacts' content rules) skip every binary
// container BY CONSTRUCTION, so an image's EXIF/tEXt block, a PDF's Producer/Author fields and
// an Office file's docProps can ship a machine username, a personal email, or a generator name
// with nothing ever reading them. This gate reads exactly those regions in every TRACKED file
// of the covered formats.
//
// COVERED: PNG (tEXt/zTXt/iTXt/eXIf chunks), JPEG (APPn + COM segments, which is where EXIF and
// XMP live), PDF (plaintext Producer/Creator/Author/Title values and uncompressed XMP packets),
// and OOXML docx/xlsx/pptx (docProps/*.xml out of the zip).
// STATED RESIDUALS, so a clean run is read at its true width: a PDF whose metadata sits in
// COMPRESSED object streams is not decoded; formats not listed (webp, tiff, mp4...) are not
// read. A finding here is real; "clean" covers the listed regions only.
//
// WHAT IT LOOKS FOR, in metadata text only (never in pixel or content data):
//   1. a home-directory path (C:\Users\<name>, /home/<name>, /Users/<name>) - a username leak
//   2. an email address - artifacts should not embed authorship addresses
//   3. an AI generator name in creator/producer-style text - a disclosure decision that must be
//      made deliberately (see the AI Act determination file), never shipped by accident
//   4. any literal from ARTIFACT_METADATA_MARKERS (comma-separated, case-insensitive) - the
//      per-machine place for names that must never ship; NEVER write those names into a file.
//
// Exit codes: 0 clean, 1 findings, 2 could not run (unreadable or unparsable tracked artifact).
//
// Usage: node scripts/check-artifact-metadata.mjs [--selftest]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { inflateSync, inflateRawSync, deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const COVERED_EXT_RE = /\.(png|jpe?g|pdf|docx|xlsx|pptx)$/i;
const MAX_BYTES = 64 * 1024 * 1024;

const HOME_PATH_RE = /[A-Za-z]:\\+Users\\+[^\\\s"'<>|]+|\/(?:home|Users)\/[^\/\s"'<>|]+/;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/;
const AI_TOOL_RE = /\b(Claude|Anthropic|ChatGPT|OpenAI|GPT-[45o]|Copilot|Midjourney|DALL[- ]?E|Stable Diffusion|Gemini)\b/;

function extraMarkers() {
  return String(process.env.ARTIFACT_METADATA_MARKERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function judge(text, source, findings, markers) {
  if (!text) return;
  let m = HOME_PATH_RE.exec(text);
  if (m) findings.push({ source, why: `home-directory path "${m[0].slice(0, 80)}"` });
  m = EMAIL_RE.exec(text);
  if (m) findings.push({ source, why: `email address "${m[0]}"` });
  m = AI_TOOL_RE.exec(text);
  if (m) findings.push({ source, why: `AI generator name "${m[1]}"` });
  const lower = text.toLowerCase();
  for (const marker of markers) {
    if (lower.includes(marker.toLowerCase())) findings.push({ source, why: `configured marker "${marker}"` });
  }
}

// --- extractors: each returns an array of { where, text } or throws on a malformed container.
function pngMeta(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG (bad signature)');
  const out = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'tEXt') {
      out.push({ where: 'tEXt', text: data.toString('latin1').replace(/\0/g, ' ') });
    } else if (type === 'zTXt') {
      const nul = data.indexOf(0);
      if (nul !== -1) {
        const keyword = data.toString('latin1', 0, nul);
        let inflated = '';
        try { inflated = inflateSync(data.subarray(nul + 2)).toString('latin1'); } catch { /* judged below as raw */ }
        out.push({ where: 'zTXt', text: `${keyword} ${inflated || data.toString('latin1')}` });
      }
    } else if (type === 'iTXt') {
      // keyword\0 compFlag(1) compMethod(1) lang\0 translated\0 text
      const nul = data.indexOf(0);
      if (nul !== -1) {
        const compressed = data[nul + 1] === 1;
        let rest = data.subarray(nul + 3);
        const lang = rest.indexOf(0);
        rest = rest.subarray(lang + 1);
        const trans = rest.indexOf(0);
        const textBytes = rest.subarray(trans + 1);
        let text = '';
        if (compressed) { try { text = inflateSync(textBytes).toString('utf8'); } catch { text = textBytes.toString('latin1'); } }
        else text = textBytes.toString('utf8');
        out.push({ where: 'iTXt', text: `${data.toString('latin1', 0, nul)} ${text}` });
      }
    } else if (type === 'eXIf') {
      out.push({ where: 'eXIf', text: data.toString('latin1') });
    }
    if (type === 'IEND') break;
    off += 12 + len; // length + type + data + crc
  }
  return out;
}

function jpegMeta(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG (bad signature)');
  const out = [];
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break; // entropy-coded data reached; metadata segments live before it
    const marker = buf[off + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
    const len = buf.readUInt16BE(off + 2);
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      out.push({ where: `segment 0xFF${marker.toString(16).toUpperCase()}`, text: buf.toString('latin1', off + 4, off + 2 + len) });
    }
    off += 2 + len;
  }
  return out;
}

function pdfMeta(buf) {
  if (buf.toString('latin1', 0, 5) !== '%PDF-') throw new Error('not a PDF (bad signature)');
  const text = buf.toString('latin1');
  const out = [];
  const fieldRe = /\/(Producer|Creator|Author|Title)\s*\(((?:[^()\\]|\\.){0,1000})\)/g;
  let m;
  while ((m = fieldRe.exec(text)) !== null) out.push({ where: `/${m[1]}`, text: m[2] });
  const xmpRe = /<x:xmpmeta[\s\S]{0,20000}?<\/x:xmpmeta>/g;
  while ((m = xmpRe.exec(text)) !== null) out.push({ where: 'XMP packet', text: m[0] });
  return out;
}

function ooxmlDocProps(buf) {
  // Minimal central-directory reader, docProps/*.xml only. CRCs are not validated: this is a
  // metadata read, not an integrity check.
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const tail = buf.subarray(Math.max(0, buf.length - 65557));
  const eocdRel = tail.lastIndexOf(eocdSig);
  if (eocdRel === -1) throw new Error('not a zip (no end-of-central-directory)');
  const eocd = buf.length - tail.length + eocdRel;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (/^docProps\//i.test(name)) {
      // Sizes in the LOCAL header's name/extra fields differ from the central ones at times;
      // read the local header to find where the data really starts.
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      let xml = '';
      if (method === 0) xml = data.toString('utf8');
      else if (method === 8) { try { xml = inflateRawSync(data).toString('utf8'); } catch { xml = ''; } }
      out.push({ where: name, text: xml });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function scan(cwd) {
  let root, files;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
    files = execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(Boolean);
  } catch (e) {
    console.error(`[artifact-metadata] UNKNOWN: could not enumerate tracked files: ${(e.message || '').split('\n')[0]}`);
    return 2;
  }
  const covered = files.filter((f) => COVERED_EXT_RE.test(f));
  if (covered.length === 0) {
    console.log('[artifact-metadata] clean: no tracked files of the covered formats (png, jpeg, pdf, docx, xlsx, pptx).');
    return 0;
  }
  const markers = extraMarkers();
  const findings = [];
  const unreadable = [];
  for (const f of covered) {
    let buf;
    try {
      buf = readFileSync(join(root, f));
    } catch (e) {
      unreadable.push(`${f} (${(e && e.code) || 'read error'})`);
      continue;
    }
    if (buf.length > MAX_BYTES) {
      unreadable.push(`${f} (too large to scan fully: ${(buf.length / 1048576).toFixed(1)}MB)`);
      continue;
    }
    const ext = f.toLowerCase().match(COVERED_EXT_RE)[1];
    let regions;
    try {
      if (ext === 'png') regions = pngMeta(buf);
      else if (ext === 'jpg' || ext === 'jpeg') regions = jpegMeta(buf);
      else if (ext === 'pdf') regions = pdfMeta(buf);
      else regions = ooxmlDocProps(buf);
    } catch (e) {
      unreadable.push(`${f} (${e.message})`);
      continue;
    }
    for (const r of regions) judge(r.text, `${f} [${r.where}]`, findings, markers);
  }
  // A real finding outranks an incomplete scan: the fix it names is actionable now, while the
  // unreadable files only mean the scan could not see everything.
  if (findings.length) {
    console.error(`[artifact-metadata] ${findings.length} metadata finding(s) in tracked artifacts:`);
    for (const f of findings) console.error(`  ${f.source}  <- ${f.why}`);
    if (unreadable.length) {
      console.error(`[artifact-metadata] AND the scan was incomplete: could not inspect ${unreadable.length} tracked artifact(s): ${unreadable.slice(0, 5).join(', ')}`);
    }
    console.error('');
    console.error('Strip metadata rather than untracking the file (re-export, or exiftool -all=), then');
    console.error('recommit. An AI generator name is also a disclosure decision: record it in the AI Act');
    console.error('determination file, do not just delete the evidence.');
    return 1;
  }
  if (unreadable.length) {
    console.error(`[artifact-metadata] UNKNOWN: could not inspect ${unreadable.length} tracked artifact(s): ${unreadable.slice(0, 5).join(', ')}`);
    console.error('[artifact-metadata] Refusing to report clean on files it could not parse.');
    return 2;
  }
  console.log(`[artifact-metadata] clean (${covered.length} tracked artifact(s), listed regions inspected).`);
  return 0;
}

// --- selftest ---------------------------------------------------------------
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function pngWith(chunks) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...chunks.map(([t, d]) => chunk(t, d)), chunk('IEND', Buffer.alloc(0))]);
}

function jpegWith(app1Text) {
  const payload = Buffer.from('Exif\0\0' + app1Text, 'latin1');
  const seg = Buffer.alloc(4);
  seg[0] = 0xff; seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg, payload, Buffer.from([0xff, 0xd9])]);
}

function zipWith(entries) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const [name, xml] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(xml, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(off, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    off += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-meta-st-'));
  git(['init'], root);
  git(['config', 'user.email', 'selftest@example.invalid'], root);
  git(['config', 'user.name', 'selftest'], root);
  const noHooks = join(root, '.no-hooks');
  mkdirSync(noHooks);
  git(['config', 'core.hooksPath', noHooks], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(['add', '-A', '-f'], root);
  git(['commit', '-m', 'fixture'], root);
  return root;
}
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const bareFixture = fixture;
  // Shadow fixture() so every temp repo lands in roots and is cleaned in the finally below.
  const fixtureTracked = (files) => { const r = bareFixture(files); roots.push(r); return r; };
  const runCli = (cwd, env = {}) => {
    try {
      const out = execFileSync(process.execPath, [self], {
        cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe',
        env: { ...process.env, ARTIFACT_METADATA_MARKERS: '', ...env },
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status == null ? -1 : e.status, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
    }
  };
  const check = (name, got, wantCode, wantRe) => {
    if (got.code !== wantCode || !wantRe.test(got.out)) {
      failures++;
      console.error(`SELFTEST FAIL: ${name} -> exit ${got.code} wanted ${wantCode}; ${wantRe.test(got.out) ? 'output matched' : 'output missed ' + wantRe}`);
    } else console.log(`selftest ok: ${name}`);
  };
  const t = (s) => Buffer.from(s, 'latin1');
  try {
    check('a repo with no covered artifacts is clean',
      runCli(fixtureTracked({ 'README.md': '# x\n' })), 0, /no tracked files of the covered formats/);
    check('a clean PNG passes',
      runCli(fixtureTracked({ 'img/logo.png': pngWith([['tEXt', t('Software\0ImageMagick 7')]]) })), 0, /clean \(1 tracked/);
    check('a PNG tEXt home path is caught',
      runCli(fixtureTracked({ 'img/shot.png': pngWith([['tEXt', t('Source\0C:\\Users\\testuser\\shots')]]) })), 1, /home-directory path/);
    check('a PNG zTXt email is caught (compressed text is inflated)',
      runCli(fixtureTracked({ 'img/shot.png': pngWith([['zTXt', Buffer.concat([t('Comment\0\0'), deflateSync(t('by tester@person.invalid'))])]]) })), 1, /email address/);
    check('a JPEG APP1 AI generator name is caught',
      runCli(fixtureTracked({ 'img/hero.jpg': jpegWith('Generator: Midjourney v6') })), 1, /AI generator name "Midjourney"/);
    check('a clean JPEG passes',
      runCli(fixtureTracked({ 'img/hero.jpg': jpegWith('NIKON D3500') })), 0, /clean \(1 tracked/);
    check('a PDF Producer AI name is caught',
      runCli(fixtureTracked({ 'docs/spec.pdf': t('%PDF-1.4\n1 0 obj\n<< /Producer (Reports by ChatGPT) >>\nendobj\ntrailer\n%%EOF\n') })), 1, /AI generator name "ChatGPT"/);
    check('a clean PDF passes',
      runCli(fixtureTracked({ 'docs/spec.pdf': t('%PDF-1.4\n1 0 obj\n<< /Producer (LibreOffice 7.4) >>\nendobj\ntrailer\n%%EOF\n') })), 0, /clean \(1 tracked/);
    check('a docx docProps creator home path is caught',
      runCli(fixtureTracked({ 'docs/brief.docx': zipWith([['docProps/core.xml', '<cp:coreProperties><dc:creator>C:/Users/testuser</dc:creator></cp:coreProperties>']]) })), 1, /home-directory path/);
    check('a clean docx passes',
      runCli(fixtureTracked({ 'docs/brief.docx': zipWith([['docProps/core.xml', '<cp:coreProperties><dc:creator>Brightlabs</dc:creator></cp:coreProperties>'], ['word/document.xml', '<w:document/>']]) })), 0, /clean \(1 tracked/);
    check('a configured marker is caught when set',
      runCli(fixtureTracked({ 'img/x.png': pngWith([['tEXt', t('Author\0made by secretname here')]]) }), { ARTIFACT_METADATA_MARKERS: 'secretname' }), 1, /configured marker "secretname"/);
    check('the same file is clean without the marker configured',
      runCli(fixtureTracked({ 'img/x.png': pngWith([['tEXt', t('Author\0made by secretname here')]]) })), 0, /clean/);
    check('a malformed covered file is UNKNOWN, exit 2',
      runCli(fixtureTracked({ 'img/broken.png': t('this is not a png at all') })), 2, /UNKNOWN: could not inspect/);
    check('a finding beside a malformed file is a finding, exit 1, with the scan gap named',
      runCli(fixtureTracked({
        'img/broken.png': t('this is not a png at all'),
        'img/hero.jpg': jpegWith('Generator: Midjourney v6'),
      })), 1, /metadata finding\(s\)[\s\S]*Midjourney[\s\S]*AND the scan was incomplete[\s\S]*Strip metadata/);
    const notRepo = mkdtempSync(join(tmpdir(), 'artifact-meta-st-nr-'));
    roots.push(notRepo);
    check('a non-repo is UNKNOWN, exit 2', runCli(notRepo), 2, /UNKNOWN: could not enumerate/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[artifact-metadata] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[artifact-metadata] selftest passed: each leak class fires per format, clean artifacts pass.');
  return 0;
}

if (process.argv.includes('--selftest')) {
  process.env.GIT_STRIP_CANARY = 'planted';
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete process.env[key];
  }
  if (process.env.GIT_STRIP_CANARY !== undefined) {
    console.error('[artifact-metadata] the GIT_* environment strip did not run; refusing to build fixtures.');
    process.exit(2);
  }
  process.exit(selftest());
}
process.exit(scan(process.cwd()));
