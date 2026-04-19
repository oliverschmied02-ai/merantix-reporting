import { APP } from '../state.js';
import { parseDE, parseDateDE, parseStapel } from './utils.js';

export function tryDecode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(buf);
    } catch {
      return new TextDecoder('iso-8859-1').decode(buf);
    }
  }
}

export function parseIndexXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const tables = [];
  for (const tbl of doc.getElementsByTagName('Table')) {
    const get = tag => tbl.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
    const url = get('URL');
    if (!url) continue;
    const name = get('Name') || url;
    const vl = tbl.getElementsByTagName('VariableLength')[0];
    const delimiter = vl
      ? tbl.getElementsByTagName('ColumnDelimiter')[0]?.textContent || ';'
      : ';';
    const columns = [];
    for (const tag of ['VariableColumn', 'FixedColumn'])
      for (const col of tbl.getElementsByTagName(tag)) {
        const n = col.getElementsByTagName('Name')[0]?.textContent?.trim() || '';
        if (n) columns.push(n);
      }
    tables.push({ name, url, delimiter, columns });
  }
  return tables;
}

export function parseSachkontenstamm(content, info) {
  const cols = info.columns;
  const ki = cols.indexOf('Ktonr'), ti = cols.indexOf('Text');
  if (ki < 0 || ti < 0) return;
  const res = Papa.parse(content, { delimiter: info.delimiter || ';', quoteChar: '"', skipEmptyLines: true });
  for (const row of res.data) {
    const k = parseInt(row[ki]), t = String(row[ti] || '').trim();
    if (!isNaN(k) && t) APP.accountNames.set(k, t);
  }
}

export function parseBSP(content, info) {
  const cols = info.columns;
  const fi = n => cols.indexOf(n);
  const IDX = {
    ktonr:  fi('Ktonr'),
    gktonr: fi('GKtonr'),
    soll:   fi('Umsatz_Soll'),
    haben:  fi('Umsatz_Haben'),
    datum:  fi('Belegdatum'),
    text:   fi('Buchungstext'),
    beleg1: fi('Beleg1'),
    stapel: fi('Stapelnummer'),
    bsnr:   fi('BSNr'),
  };
  if (IDX.ktonr < 0 || IDX.soll < 0 || IDX.haben < 0)
    throw new Error('Pflichtfelder nicht in index.xml');

  const res = Papa.parse(content, {
    delimiter: info.delimiter || ';',
    quoteChar: '"',
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  const txns = [];

  for (const row of res.data) {
    if (row.length <= Math.max(IDX.ktonr, IDX.soll, IDX.haben)) continue;
    const ktonr = parseInt(row[IDX.ktonr]);
    if (isNaN(ktonr)) continue;

    const gktonr   = IDX.gktonr >= 0 ? parseInt(row[IDX.gktonr]) : NaN;
    const soll     = parseDE(IDX.soll  >= 0 ? row[IDX.soll]  : 0);
    const haben    = parseDE(IDX.haben >= 0 ? row[IDX.haben] : 0);
    const datum    = IDX.datum  >= 0 ? parseDateDE(row[IDX.datum]) : null;
    const text     = IDX.text   >= 0 ? String(row[IDX.text]  || '').trim() : '';
    const stapelRaw= IDX.stapel >= 0 ? String(row[IDX.stapel]|| '').trim() : '';
    const b1       = IDX.beleg1 >= 0 ? String(row[IDX.beleg1]|| '').trim() : '';
    const bsnr     = IDX.bsnr   >= 0 ? String(row[IDX.bsnr]  || '').trim() : '';

    const sp = parseStapel(stapelRaw);
    const wjMonth  = sp?.month || null;
    const wjYear   = sp?.year  || null;
    const beleg    = b1 || bsnr || stapelRaw.slice(0, 20);

    txns.push({ ktonr, gktonr: isNaN(gktonr) ? null : gktonr, soll, haben, datum, text, beleg, wjMonth, wjYear, stapelRaw });
  }
  return txns;
}
