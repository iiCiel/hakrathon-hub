'use strict';
// Minimal readers for the two Office files the organizers send: an .xlsx (first sheet) and a .docx.
// No extra dependency: both are zip files of XML, read with adm-zip (already used for team zips).
const AdmZip = require('adm-zip');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});

function zipText(zip, name) {
  const e = zip.getEntry(name);
  return e ? e.getData().toString('utf8') : '';
}

// "B12" -> column index 1
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// First worksheet as an array of rows (arrays of strings). Empty rows are kept as [] so callers can see the gaps.
function readXlsx(file) {
  const zip = new AdmZip(file);
  const shared = [...zipText(zip, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unxml(t[1])).join(''));
  const rels = zipText(zip, 'xl/_rels/workbook.xml.rels');
  const wb = zipText(zip, 'xl/workbook.xml');
  const firstRid = (wb.match(/<sheet\b[^>]*r:id="([^"]+)"/) || [])[1];
  let target = firstRid && (rels.match(new RegExp(`<Relationship\\b[^>]*Id="${firstRid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstRid}"`)) || [])[1];
  target = target ? `xl/${target.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = zipText(zip, target);
  if (!sheet) throw new Error('No worksheet found in this .xlsx file.');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = rm[1] || rm[3] || '';
    const rNo = Number((attrs.match(/\br="(\d+)"/) || [])[1]) || rows.length + 1;
    while (rows.length < rNo - 1) rows.push([]);
    const cells = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1];
      const ref = (a.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const type = (a.match(/\bt="(\w+)"/) || [])[1];
      const body = cm[2] || '';
      let v = '';
      if (type === 'inlineStr') v = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unxml(t[1])).join('');
      else {
        const raw = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (raw != null) v = type === 's' ? shared[Number(raw)] ?? '' : unxml(raw);
      }
      cells[ref ? colIndex(ref) : cells.length] = v;
    }
    rows.push(Array.from(cells, (x) => x ?? ''));
  }
  return rows;
}

// A .docx body in reading order: { type: 'p', text } and { type: 'table', rows: [[cell text]] }.
function readDocx(file) {
  const zip = new AdmZip(file);
  const xml = zipText(zip, 'word/document.xml');
  const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [])[1] || '';
  const paraText = (p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] != null ? unxml(m[1]) : ' ')).join('').replace(/\s+/g, ' ').trim();
  const out = [];
  // Walk top-level <w:p> and <w:tbl> blocks (tables here are not nested).
  const re = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p\b(?:[^>]*)?>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
  for (const m of body.matchAll(re)) {
    if (m[1] != null) {
      const rows = [...m[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map((tr) =>
        [...tr[1].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((tc) =>
          [...tc[1].matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((p) => paraText(p[1])).filter(Boolean).join('\n')));
      out.push({ type: 'table', rows: rows.filter((r) => r.some(Boolean)) });
    } else if (m[2] != null) {
      const t = paraText(m[2]);
      if (t) out.push({ type: 'p', text: t });
    }
  }
  return out;
}

module.exports = { readXlsx, readDocx };
