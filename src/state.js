import { deepClone } from './lib/utils.js';
import { DEFAULT_PL_DEF } from './data/default-pl.js';

export const APP = {
  allTransactions: [],
  accountNames: new Map(),
  plData: null,
  drillTxns: [],
  drillMeta: {},
  expandedItems: new Set(),
  expandedSubs: new Set(),
  selectedTransactions: new Set(),
  viewMode: 'monat',
  years: [],
  loadedYears: new Set(), // tracks which fiscal years have been fetched
  companyName: '',
  plDef: deepClone(DEFAULT_PL_DEF),
  acctMap: new Map(),
  rules: [],
  loadedFiles: [],
  kpiOrder: null,
};

export function resetAPP() {
  APP.allTransactions = [];
  APP.accountNames = new Map();
  APP.plData = null;
  APP.drillTxns = [];
  APP.drillMeta = {};
  APP.expandedItems = new Set();
  APP.expandedSubs = new Set();
  APP.selectedTransactions = new Set();
  APP.viewMode = 'monat';
  APP.years = [];
  APP.loadedYears = new Set();
  APP.companyName = '';
  APP.plDef = deepClone(DEFAULT_PL_DEF);
  APP.acctMap = new Map();
  APP.rules = [];
  APP.loadedFiles = [];
}
