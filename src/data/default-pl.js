export const DEFAULT_PL_DEF = [
  {
    id: 'revenue', type: 'section', label: 'Umsatzerlöse & Erträge', normalBalance: 'H',
    subs: [
      { id: 'rev_main',  label: 'Umsatzerlöse',                  accounts: [410000, 440000],                                                             normalBalance: 'H' },
      { id: 'rev_other', label: 'Sonstige betriebliche Erträge', accounts: [484000, 484700, 493000, 494600, 497200],                                     normalBalance: 'H' },
    ],
  },
  { id: 'gross_profit', type: 'computed', label: 'Rohertrag', formula: [['revenue', +1]], level: 'mid' },
  {
    id: 'personnel', type: 'section', label: 'Personalaufwand', normalBalance: 'S',
    subs: [
      { id: 'pers_wages',  label: 'Löhne & Gehälter',    accounts: [600000, 602000, 602700, 603900],        normalBalance: 'S' },
      { id: 'pers_social', label: 'Sozialaufwendungen',  accounts: [606000, 611000, 612000, 613000],        normalBalance: 'S' },
    ],
  },
  {
    id: 'opex', type: 'section', label: 'Sonstige betr. Aufwendungen', normalBalance: 'S',
    subs: [
      { id: 'opex_ext',   label: 'Fremdleistungen',                     accounts: [630300],                                                              normalBalance: 'S' },
      { id: 'opex_events',label: 'Events & Community',                   accounts: [630002, 630100, 663001, 663002],                                     normalBalance: 'S' },
      { id: 'opex_rent',  label: 'Raumkosten & Infrastruktur',           accounts: [631000, 633000, 683500],                                             normalBalance: 'S' },
      { id: 'opex_mktg',  label: 'Marketing & Werbung',                  accounts: [660000, 661000, 662000, 662100, 663000],                             normalBalance: 'S' },
      { id: 'opex_hosp',  label: 'Bewirtung & Repräsentation',           accounts: [664000, 664300, 664400, 664500],                                     normalBalance: 'S' },
      { id: 'opex_travel',label: 'Reisekosten',                          accounts: [665000, 666000, 666300, 666400],                                     normalBalance: 'S' },
      { id: 'opex_it',    label: 'IT, Lizenzen & Software',              accounts: [681000, 683700, 683001],                                             normalBalance: 'S' },
      { id: 'opex_admin', label: 'Verwaltung, Beratung & Büro',          accounts: [680000, 680500, 681500, 682000, 682100, 682500, 682700, 683000, 684500, 685000], normalBalance: 'S' },
      { id: 'opex_insur', label: 'Versicherungen & Beiträge',            accounts: [640000, 642000, 643600],                                             normalBalance: 'S' },
      { id: 'opex_bank',  label: 'Bankgebühren & Geldverkehr',           accounts: [685500],                                                              normalBalance: 'S' },
      { id: 'opex_fx',    label: 'Währungsdifferenzen',                  accounts: [688000, 688100],                                                      normalBalance: 'S' },
      { id: 'opex_misc',  label: 'Periodenfremde Aufwendungen',          accounts: [696000],                                                              normalBalance: 'S' },
    ],
  },
  { id: 'ebitda', type: 'computed', label: 'EBITDA', formula: [['revenue', +1], ['personnel', -1], ['opex', -1]], level: 'major' },
  {
    id: 'depreciation', type: 'section', label: 'Abschreibungen (D&A)', normalBalance: 'S',
    subs: [
      { id: 'dep_sach', label: 'AfA Sachanlagen', accounts: [622000], normalBalance: 'S' },
    ],
  },
  { id: 'ebit', type: 'computed', label: 'EBIT', formula: [['ebitda', +1], ['depreciation', -1]], level: 'major' },
  {
    id: 'financial', type: 'section_mixed', label: 'Finanzergebnis',
    subs: [
      { id: 'fin_inc', label: 'Zinserträge',                             accounts: [711000],         normalBalance: 'H' },
      { id: 'fin_exp', label: 'Zinsaufw. & Steuernebenleistungen',       accounts: [730300, 731000], normalBalance: 'S' },
    ],
  },
  { id: 'ebt', type: 'computed', label: 'EBT (Ergebnis vor Steuern)', formula: [['ebit', +1], ['financial', +1]], level: 'final' },
];
