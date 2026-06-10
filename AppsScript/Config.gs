/**
 * 集中設定：15 類分類、規則式寄件者對應、參數。
 * 機密(Gemini API key)放在「專案設定 → 指令碼屬性」，不寫在程式碼裡。
 */

// ── 參數（可在「指令碼屬性」覆寫，否則用預設）──────────────
function getApiKey() {
  var k = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!k) throw new Error('尚未設定 GEMINI_API_KEY，請到「專案設定 → 指令碼屬性」新增。');
  return k;
}
function prop(key, def) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === '') ? def : v;
}
function GEMINI_MODEL() { return prop('GEMINI_MODEL', 'gemini-2.5-flash'); }
// 自動 fallback 模型鏈：第一順位用 GEMINI_MODEL，失敗(429/503)就依序往下換。
// 三個模型各有獨立免費配額，等於把額度疊起來用。可用 GEMINI_MODELS（逗號分隔）覆寫整條鏈。
function GEMINI_MODEL_CHAIN() {
  var custom = prop('GEMINI_MODELS', '');
  if (custom) return custom.split(',').map(function (s) { return s.trim(); }).filter(String);
  var first = GEMINI_MODEL();
  var defaults = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
  var chain = [first];
  for (var i = 0; i < defaults.length; i++)
    if (defaults[i] !== first) chain.push(defaults[i]);
  return chain;
}
function MY_EMAIL()     { return Session.getEffectiveUser().getEmail(); }
function FOLLOWUP_DAYS(){ return parseInt(prop('FOLLOWUP_DAYS', '4'), 10); }
function TLDR_MIN_CHARS(){ return parseInt(prop('TLDR_MIN_CHARS', '1500'), 10); }
function ENABLE_URGENT_ALERT(){ return prop('ENABLE_URGENT_ALERT', 'true') === 'true'; }

var LABEL_PREFIX = '🤖';

// ── 15 類分類定義 ───────────────────────────────────────────
var CATEGORIES = [
  // A 群：要我動手
  {key:'reply',    label:LABEL_PREFIX+'/需回覆',   group:'A', emoji:'🔴',
   desc:'真人寄來、且明確需要我親自回覆的信（同事、合作者、學生、朋友的提問或請求）。不含系統自動信、電子報、純通知。'},
  {key:'todo',     label:LABEL_PREFIX+'/待辦',     group:'A', emoji:'🟠',
   desc:'有具體該做的事或截止日：報名、申請、繳交、填表、投稿截止、補件、開會回覆出席等。'},
  {key:'review',   label:LABEL_PREFIX+'/論文審稿', group:'A', emoji:'📝',
   desc:'期刊投稿/審稿相關：reviewer 邀請、審稿提醒、revision 要求、accept/reject/major-minor 決議、editor 來信。'},
  {key:'booking',  label:LABEL_PREFIX+'/訂位預約', group:'A', emoji:'📅',
   desc:'餐廳訂位、診所/檢查預約、飯店、票券等預約確認或變更通知。'},
  // B 群：工作學術資訊
  {key:'hosp_work',label:LABEL_PREFIX+'/醫院工作', group:'B', emoji:'🏥',
   desc:'臨床/科務實際工作：排班值班、會診、病人相關、科內行政交辦、研究計畫執行事務。'},
  {key:'hosp_info',label:LABEL_PREFIX+'/醫院通知', group:'B', emoji:'📢',
   desc:'醫院公布欄/行政公告：組織異動、總務、人事、一般周知，無需我特別行動。'},
  {key:'society',  label:LABEL_PREFIX+'/學會',     group:'B', emoji:'🎓',
   desc:'醫學會/學會：心臟學會(TSOC)、內科醫學會、CME/學分、講座、研討會、scholarship、選舉通知。'},
  {key:'journal',  label:LABEL_PREFIX+'/期刊',     group:'B', emoji:'📚',
   desc:'期刊目次(TOC)、研究電子報、論文新刊通知、徵稿(call for abstracts)、醫學新知電子報。'},
  // C 群：財務 / 生活 / 噪音
  {key:'salary',   label:LABEL_PREFIX+'/薪水',     group:'C', emoji:'💰',
   desc:'薪資、值班費、加班費、獎金、入帳通知、扣繳憑單等與我收入有關的信。'},
  {key:'card',     label:LABEL_PREFIX+'/消費通知', group:'C', emoji:'💳',
   desc:'信用卡/簽帳卡單筆或彙整消費授權通知（純通知，非促銷）。'},
  {key:'bill',     label:LABEL_PREFIX+'/帳單',     group:'C', emoji:'🧾',
   desc:'帳單、繳費、電子發票、發票中獎、保費、稅單等。'},
  {key:'shopping', label:LABEL_PREFIX+'/購物',     group:'C', emoji:'📦',
   desc:'網購訂單、出貨、物流、取貨、退款（蝦皮、Uber Eats、各電商）。'},
  {key:'security', label:LABEL_PREFIX+'/帳號安全', group:'C', emoji:'🔐',
   desc:'帳號登入/安全提醒、OAuth 授權、密碼、驗證碼、Google/GitHub 等系統安全通知。'},
  {key:'promo',    label:LABEL_PREFIX+'/促銷',     group:'C', emoji:'🏷️',
   desc:'純廣告促銷：銀行貸款/信用卡優惠、百貨折扣、品牌行銷、投資講座推銷等。'},
  {key:'news',     label:LABEL_PREFIX+'/電子報',   group:'C', emoji:'📰',
   desc:'非醫學的訂閱電子報/新聞（The Economist、財經、NGO 募款等）。'}
];

var GROUP_TITLES = {A:'🔴 要我動手', B:'🟡 工作 / 學術', C:'💰 財務 / 生活 / 其他'};

function catByKey(k) {
  for (var i=0;i<CATEGORIES.length;i++) if (CATEGORIES[i].key===k) return CATEGORIES[i];
  return null;
}
function validKey(k){ return catByKey(k)!==null; }

// ── 規則式寄件者對應（命中就不呼叫 Gemini）─────────────────
// [寄件者子字串, 主旨關鍵字(null=不限), 分類key]
var SENDER_RULES = [
  ['penet@mail.hosp.ncku.edu.tw', '入帳',  'salary'],
  ['penet@mail.hosp.ncku.edu.tw', '值班費','salary'],
  ['penet@mail.hosp.ncku.edu.tw', '加班費','salary'],
  ['penet@mail.hosp.ncku.edu.tw', '公布欄','hosp_info'],
  // 信用卡消費通知（換成你自己發卡行的通知寄件者）
  ['card-notify@your-bank.example', null, 'card'],
  ['statement@your-bank.example', null, 'card'],
  // 促銷（銀行/券商行銷信；換成你會收到的寄件者）
  ['edm@your-bank.example', null, 'promo'],
  ['news-longchamp.com', null, 'promo'],
  ['penpeer.co', null, 'promo'],
  ['noreply@e.economist.com', null, 'promo'],
  ['notification.elsevier.com', null, 'journal'],
  ['emails.bmj.com', null, 'journal'],
  ['n.nejm.org', null, 'journal'],
  ['heartemail.org', null, 'journal'],
  ['acc.org', null, 'journal'],
  ['cardiologytrials@substack.com', null, 'journal'],
  ['sanfordguide.com', null, 'journal'],
  ['tsoc.org.tw', null, 'society'],
  ['einvoice.nat.gov.tw', null, 'bill'],
  ['shopee', null, 'shopping'],
  ['uber.com', null, 'shopping'],
  ['families-noreply@google.com', null, 'security'],
  ['calendar-notification@google.com', null, 'booking'],
  ['noreply@github.com', null, 'security'],
  ['newsletters@e.economist.com', null, 'news'],
  ['greenpeace.org', null, 'news'],
  ['netflix.com', null, 'news']   // 串流服務通知（新片上線等），非醫學期刊
];

var LOW_VALUE_CATS = {card:1, promo:1, news:1, shopping:1, bill:1, security:1};
