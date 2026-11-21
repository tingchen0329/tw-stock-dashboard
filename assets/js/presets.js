/**
 * 選股條件預設值（純資料；網頁 screen.js 與 scripts/build_overview.mjs 的回測共用）
 * op：'>=' 至少、'<=' 至多、'>' 大於。value 為 null 代表預設不使用（使用者可自行填入）
 */
export const TW_PRESETS = {
  growth: {
    label: '成長型',
    desc: '營收與獲利同步成長、本業賺錢，估值不過熱',
    sort: { key: 'revCumYoY', dir: -1 },
    criteria: [
      { key: 'revYoY', op: '>=', value: 20, label: '月營收年增', unit: '%' },
      { key: 'revCumYoY', op: '>=', value: 15, label: '今年累計營收年增', unit: '%' },
      { key: 'eps', op: '>', value: 0, label: '今年累計 EPS', unit: '元' },
      { key: 'om', op: '>=', value: 5, label: '營業利益率', unit: '%' },
      { key: 'roe', op: '>=', value: 12, label: 'ROE（推估）', unit: '%' },
      { key: 'pe', op: '<=', value: 35, label: '本益比', unit: '倍' },
      { key: 'volume', op: '>=', value: 500, label: '成交量', unit: '張' },
      { key: 'big1000Chg', op: '>=', value: null, label: '千張大戶週增減', unit: '百分點' },
      { key: 'retail10Chg', op: '<=', value: null, label: '10 張以下散戶週增減', unit: '百分點' },
    ],
  },
  yield: {
    label: '殖利率型',
    desc: '高殖利率、仍在獲利、營收沒有明顯衰退，估值偏低',
    sort: { key: 'yield', dir: -1 },
    criteria: [
      { key: 'yield', op: '>=', value: 5, label: '殖利率', unit: '%' },
      { key: 'eps', op: '>', value: 0, label: '今年累計 EPS', unit: '元' },
      { key: 'roe', op: '>=', value: 8, label: 'ROE（推估）', unit: '%' },
      { key: 'pe', op: '<=', value: 18, label: '本益比', unit: '倍' },
      { key: 'revCumYoY', op: '>=', value: -10, label: '今年累計營收年增', unit: '%' },
      { key: 'volume', op: '>=', value: 300, label: '成交量', unit: '張' },
      { key: 'big1000', op: '>=', value: null, label: '千張大戶持股', unit: '%' },
    ],
  },
};

/** 美股（S&P 500）：資料來自 SEC 財報與 Yahoo 股價，欄位與台股不同 */
export const US_PRESETS = {
  growth: {
    label: '成長型',
    desc: '最新一季營收與 EPS 雙位數成長、淨利率與 ROE 高，估值不過熱',
    sort: { key: 'revYoY', dir: -1 },
    criteria: [
      { key: 'revYoY', op: '>=', value: 15, label: '季營收年增', unit: '%' },
      { key: 'epsYoY', op: '>=', value: 15, label: '季 EPS 年增', unit: '%' },
      { key: 'netMargin', op: '>=', value: 10, label: '淨利率', unit: '%' },
      { key: 'roe', op: '>=', value: 15, label: 'ROE', unit: '%' },
      { key: 'pe', op: '<=', value: 40, label: '本益比', unit: '倍' },
    ],
  },
  yield: {
    label: '殖利率型',
    desc: '高殖利率、仍在獲利、營收沒有明顯衰退，估值偏低',
    sort: { key: 'yield', dir: -1 },
    criteria: [
      { key: 'yield', op: '>=', value: 3, label: '殖利率', unit: '%' },
      { key: 'epsTTM', op: '>', value: 0, label: '近四季 EPS', unit: '美元' },
      { key: 'roe', op: '>=', value: 10, label: 'ROE', unit: '%' },
      { key: 'pe', op: '<=', value: 20, label: '本益比', unit: '倍' },
      { key: 'revYoY', op: '>=', value: -5, label: '季營收年增', unit: '%' },
    ],
  },
};

