import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBSP } from '../src/lib/parser.js';

// PapaParse is a browser global in the app; stub it with a minimal splitter.
globalThis.Papa = {
  parse(content, opts) {
    const delim = opts.delimiter || ';';
    return { data: content.trim().split(/\r?\n/).map(line => line.split(delim)) };
  },
};

const INFO = {
  delimiter: ';',
  columns: ['Ktonr', 'GKtonr', 'Umsatz_Soll', 'Umsatz_Haben', 'Belegdatum',
            'Buchungstext', 'Beleg1', 'Stapelnummer', 'BSNr'],
};

const HEADER = INFO.columns.join(';');

test('parseBSP: falls back to Belegdatum when Stapelnummer carries no period', () => {
  // Stapelnummer "12345" does NOT match /^(\d{2})-(\d{4})/ — the old code left
  // wjMonth/wjYear null, so the booking never reached the P&L.
  const content = `${HEADER}\n4400;1200;0;1.190,00;15.03.2024;Umsatz;RE1;12345;7\n`;
  const txns = parseBSP(content, INFO);
  assert.equal(txns.length, 1);
  assert.equal(txns[0].wjMonth, 3);
  assert.equal(txns[0].wjYear, 2024);
  assert.equal(txns[0].haben, 1190);
});

test('parseBSP: still prefers the Stapelnummer period when it is present', () => {
  // Stapel says period 06/2024; Belegdatum says März — Stapel must win.
  const content = `${HEADER}\n4400;1200;0;500,00;15.03.2024;Umsatz;RE1;06-2024/001;7\n`;
  const txns = parseBSP(content, INFO);
  assert.equal(txns[0].wjMonth, 6);
  assert.equal(txns[0].wjYear, 2024);
});

test('parseBSP: leaves period null when neither Stapel nor Belegdatum is usable', () => {
  const content = `${HEADER}\n4400;1200;0;500,00;;Umsatz;RE1;12345;7\n`;
  const txns = parseBSP(content, INFO);
  assert.equal(txns[0].wjMonth, null);
  assert.equal(txns[0].wjYear, null);
});
