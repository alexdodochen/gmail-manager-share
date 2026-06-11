/**
 * ===== Gmail 助理機器人 — 全部程式合併檔（ALL_IN_ONE）=====
 * 用法：在 Apps Script 新專案把預設 Code.gs 內容清空，整檔貼上即可。
 * （Apps Script 所有 .gs 共用全域，合成一檔等價於分七檔。）
 */

// ===================================================================
// ===== Config.gs
// ===================================================================
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

// ===================================================================
// ===== Gemini.gs
// ===================================================================
/** 免費 Gemini API（透過 UrlFetch）：分類、長信摘要、起草回覆。 */

function geminiGenerate(instruction, content, asJson) {
  var payload = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: [{ text: content }] }],
    generationConfig: { temperature: 0.3 }
  };
  if (asJson) payload.generationConfig.responseMimeType = 'application/json';
  var opts = {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  var chain = GEMINI_MODEL_CHAIN();

  // 整條鏈最多跑 2 輪：第 1 輪全部 429（配額/每分鐘 RPM 限流）時，等待後再整輪重試一次，
  // 專救每分鐘 RPM 暫時性塞車；第 2 輪仍全爆才丟 QUOTA 中止本輪（避免燒光 Apps Script 6 分鐘）。
  // 因 GmailBot 一遇 QUOTA 就停掉整批，這個等待最多只會付一次，不會拖垮本輪。
  for (var round = 0; round < 2; round++) {
    var r = tryGeminiChain(chain, opts);
    if (r.ok) return r.text;
    if (!r.allQuota) throw new Error('Gemini 失敗（已試 ' + chain.length + ' 個模型）：' + r.err);
    if (round === 0) { Utilities.sleep(20000); continue; }
    throw new Error('QUOTA 所有 Gemini 模型都被限流/配額用完：' + r.err);
  }
}

// 依序試整條模型鏈。成功回 {ok:true, text}；失敗回 {ok:false, allQuota, err}。
// allQuota=true 代表每個模型都因 429 失敗（值得等一下重試）；false 代表夾雜其他錯（直接放棄這封）。
function tryGeminiChain(chain, opts) {
  var quotaCount = 0, lastErr = '';
  for (var mi = 0; mi < chain.length; mi++) {
    var model = chain[mi];
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
              + model + ':generateContent?key=' + getApiKey();
    // 每個模型最多試 2 次（針對 503 忙碌做輕度退避）。
    for (var attempt = 0; attempt < 2; attempt++) {
      var resp = UrlFetchApp.fetch(url, opts);
      var code = resp.getResponseCode();
      var text = resp.getContentText();
      if (code === 200) {
        try {
          var j = JSON.parse(text);
          if (mi > 0) Logger.log('（已自動切換至備援模型 ' + model + '）');
          return { ok: true, text: j.candidates[0].content.parts[0].text };
        } catch (e) { lastErr = 'parse: ' + e + ' / ' + text.slice(0, 200); break; }
      } else if (code === 429) {
        quotaCount++; lastErr = '429 ' + model + ' 配額/限流'; break;   // 換下一個模型
      } else if (code === 503) {
        if (attempt === 0) { Utilities.sleep(2000); lastErr = '503 ' + model + ' 忙碌'; continue; }
        lastErr = '503 ' + model + ' 忙碌'; break;
      } else {
        lastErr = code + ' ' + model + ': ' + text.slice(0, 200); break;
      }
    }
  }
  return { ok: false, allQuota: quotaCount >= chain.length, err: lastErr };
}

function geminiClassify(mail) {
  var cats = CATEGORIES.map(function (c) { return '- ' + c.key + ': ' + c.desc; }).join('\n');
  var instruction =
    '你是一位協助成大醫院心臟內科醫師整理 Gmail 的助理。請閱讀單封 email，輸出 JSON。\n' +
    'category 必須從下列代號擇一：\n' + cats + '\n\n' +
    '欄位：category, importance(1~5整數), is_real_person(bool), needs_reply(bool), ' +
    'is_urgent(bool), language("zh"或"en"), tldr(繁體中文1~2句重點), ' +
    'todos(陣列，每項{"task":"...","due":"YYYY-MM-DD或空"}), intro(一句繁體中文介紹這封信). \n' +
    '判斷：needs_reply 僅在「需要醫師親自回覆」才 true；is_urgent 為今明兩天且重要。只輸出 JSON。';
  var content =
    '寄件者：' + mail.sender + '\n主旨：' + mail.subject + '\n收件：' + (mail.to || '') +
    '\n內文（節錄）：\n' + mail.body.slice(0, 4000);

  var raw = geminiGenerate(instruction, content, true);
  var d = safeJson(raw);
  if (!validKey(d.category)) d.category = 'hosp_info';
  d.importance = d.importance || 2;
  d.is_real_person = !!d.is_real_person;
  d.needs_reply = !!d.needs_reply;
  d.is_urgent = !!d.is_urgent;
  d.language = d.language || 'zh';
  d.tldr = d.tldr || (mail.snippet || '').slice(0, 120);
  d.todos = d.todos || [];
  d.intro = d.intro || d.tldr;
  return d;
}

function geminiSummarizeLong(mail) {
  var instruction = '你是醫師的閱讀助理，請用繁體中文 3 行條列重點摘要這封長信。只輸出條列，不要前言。';
  return geminiGenerate(instruction, mail.body.slice(0, 7000), false).trim();
}

function geminiDraftReply(mail) {
  var instruction =
    '你是成大醫院心臟內科醫師的 email 助理。請依來信內容，用「與來信相同的語言」起草一封得體、' +
    '專業、簡潔的回覆。中文用繁體。資訊不足處用 [括號] 佔位讓醫師補。只輸出信件正文。';
  var content = '來信寄件者：' + mail.sender + '\n主旨：' + mail.subject +
                '\n內文：\n' + mail.body.slice(0, 5000);
  return geminiGenerate(instruction, content, false).trim();
}

/** 每週重點摘要：把一週重要信件交 Gemini 統整成「本週重點 / 下週注意」。 */
function geminiWeeklyDigest(records) {
  // 只挑重要/需動作的信給 AI，控制 token 用量
  var picked = records.filter(function (m) {
    return m.category === 'reply' || m.needsReply || m.isUrgent ||
           Number(m.importance) >= 3 || (m.todos && m.todos.length);
  }).slice(0, 60);
  if (!picked.length) return '';
  var lines = picked.map(function (m) {
    var c = catByKey(m.category);
    return '- [' + (c ? c.label.split('/')[1] : m.category) + '｜重要度' + m.importance + '] ' +
           (m.subject || '').slice(0, 80) + '：' + (m.tldr || '').slice(0, 100);
  }).join('\n');
  var instruction =
    '你是成大醫院心臟內科醫師的一週秘書。以下是這位醫師過去一週收到、已分類的重要信件清單。' +
    '請用繁體中文，幫他統整成「本週重點」與「下週該注意」兩段條列（各 3~6 點），' +
    '聚焦：需回覆的人事、截止日/待辦、審稿/投稿進度、醫院與學會重要事項、財務異常。' +
    '語氣精簡專業，不要寒暄、不要逐封重述，只給洞見與提醒。';
  return geminiGenerate(instruction, '本週信件清單：\n' + lines, false).trim();
}

function safeJson(raw) {
  raw = (raw || '').trim();
  if (raw.indexOf('```') === 0) { raw = raw.replace(/```json|```/g, '').trim(); }
  try { return JSON.parse(raw); } catch (e) {}
  var s = raw.indexOf('{'), e2 = raw.lastIndexOf('}');
  if (s >= 0 && e2 > s) { try { return JSON.parse(raw.slice(s, e2 + 1)); } catch (e) {} }
  return {};
}

// ===================================================================
// ===== Classifier.gs
// ===================================================================
/** 混合式分類：規則優先（省 Gemini 額度），其餘交 Gemini。 */

function ruleClassify(mail) {
  var sender = (mail.senderEmail || '').toLowerCase();
  var senderFull = (mail.sender || '').toLowerCase();
  var subject = (mail.subject || '').toLowerCase();
  for (var i = 0; i < SENDER_RULES.length; i++) {
    var needle = SENDER_RULES[i][0].toLowerCase();
    var kw = SENDER_RULES[i][1];
    var cat = SENDER_RULES[i][2];
    if (sender.indexOf(needle) >= 0 || senderFull.indexOf(needle) >= 0) {
      if (kw === null || subject.indexOf(kw.toLowerCase()) >= 0) return cat;
    }
  }
  return null;
}

function classify(mail) {
  var ruleCat = ruleClassify(mail);

  // 1) 規則命中且屬低價值通知 → 直接用，不呼叫 Gemini
  if (ruleCat && LOW_VALUE_CATS[ruleCat]) {
    var c = catByKey(ruleCat);
    return {
      category: ruleCat, importance: 1,
      is_real_person: false, needs_reply: false, is_urgent: false,
      language: 'zh', tldr: (mail.snippet || '').slice(0, 120), todos: [],
      intro: c.emoji + ' ' + c.label + '（規則自動歸類）：' + mail.subject.slice(0, 60),
      classified_by: 'rule'
    };
  }

  // 2) 其餘交 Gemini
  var d = geminiClassify(mail);
  d.classified_by = 'gemini';
  // 規則對高價值類別有強意見、但 Gemini 落到噪音類 → 採信規則
  if (ruleCat && !LOW_VALUE_CATS[ruleCat] && LOW_VALUE_CATS[d.category]) {
    d.category = ruleCat;
  }
  return d;
}

// ===================================================================
// ===== Storage.gs
// ===================================================================
/** 用一份 Google Sheet 當紀錄（你可隨時打開查看）。 */

var HEADERS = ['msgId','threadId','dateMs','sender','senderEmail','subject','category',
               'importance','isRealPerson','needsReply','isUrgent','tldr','todosJson',
               'draftMade','processedAt'];

function getLogSheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('GmailBot_Log（Gmail 機器人紀錄）');
    props.setProperty('SHEET_ID', ss.getId());
    var sh0 = ss.getActiveSheet();
    sh0.setName('log');
    sh0.appendRow(HEADERS);
  }
  return ss.getSheetByName('log');
}

function getProcessedIds() {
  var sh = getLogSheet();
  var last = sh.getLastRow();
  var ids = {};
  if (last < 2) return ids;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) ids[vals[i][0]] = true;
  return ids;
}

function appendRecord(r) {
  getLogSheet().appendRow([
    r.msgId, r.threadId, r.dateMs, r.sender, r.senderEmail, r.subject, r.category,
    r.importance, r.isRealPerson ? 1 : 0, r.needsReply ? 1 : 0, r.isUrgent ? 1 : 0,
    r.tldr, JSON.stringify(r.todos || []), r.draftMade ? 1 : 0, r.processedAt
  ]);
}

function getRecordsBetween(startMs, endMs) {
  var sh = getLogSheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var ms = Number(rows[i][2]);
    if (ms >= startMs && ms < endMs) {
      out.push({
        msgId: rows[i][0], threadId: rows[i][1], dateMs: ms,
        sender: rows[i][3], senderEmail: rows[i][4], subject: rows[i][5],
        category: rows[i][6], importance: Number(rows[i][7]),
        isRealPerson: rows[i][8], needsReply: rows[i][9], isUrgent: rows[i][10],
        tldr: rows[i][11], todos: safeJson(rows[i][12]) || [], draftMade: rows[i][13]
      });
    }
  }
  return out;
}

/** 刪除超過 N 天的舊紀錄，避免 Sheet 無限變大。 */
function pruneOld(days) {
  var sh = getLogSheet();
  var last = sh.getLastRow();
  if (last < 2) return;
  var cutoff = Date.now() - days * 86400000;
  var msVals = sh.getRange(2, 3, last - 1, 1).getValues();
  // 由下往上刪，避免列號位移
  for (var i = msVals.length - 1; i >= 0; i--) {
    if (Number(msVals[i][0]) < cutoff) sh.deleteRow(i + 2);
  }
}

// ===================================================================
// ===== GmailBot.gs
// ===================================================================
/** 核心流程：讀信 → 分類 → 加標籤 → 需回覆真人信備草稿 → 緊急即時提醒。 */

var _labelCache = {};
function ensureLabel(name) {
  if (_labelCache[name]) return _labelCache[name];
  var lb = GmailApp.getUserLabelByName(name);
  if (!lb) lb = GmailApp.createLabel(name);
  _labelCache[name] = lb;
  return lb;
}

/** 把 GmailMessage 轉成統一物件。 */
function readMessage(msg) {
  var from = msg.getFrom();
  var m = from.match(/<([^>]+)>/);
  var email = (m ? m[1] : from).trim().toLowerCase();
  var body = msg.getPlainBody() || '';
  body = body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, 8000);
  return {
    msgId: msg.getId(),
    sender: from,
    senderEmail: email,
    subject: msg.getSubject() || '(無主旨)',
    to: msg.getTo(),
    dateMs: msg.getDate().getTime(),
    snippet: body.slice(0, 160),
    body: body,
    _msg: msg
  };
}

function processInbox() {
  var processed = getProcessedIds();
  var threads = GmailApp.search('in:inbox newer_than:3d', 0, 60);
  var urgent = [];
  var newCount = 0;
  var quotaHit = false;

  for (var t = 0; t < threads.length && !quotaHit; t++) {
    var thread = threads[t];
    var msgs = thread.getMessages();
    for (var i = 0; i < msgs.length; i++) {
      var gmsg = msgs[i];
      var id = gmsg.getId();
      if (processed[id]) continue;
      try {
        var mail = readMessage(gmsg);
        mail.threadId = thread.getId();
        // 略過機器人自己寄給自己的通知信（🚨緊急提醒 / 📬每日報告 / 📅週報）。否則它們會被
        // 當新信重新分類，且報告裡的待辦會改帶「通知信」的 threadId → 點待辦連結會跳到通知信
        // 而非來源信。對話串裡我自己的回覆也一併略過（不需分類自己的寄件）。
        if (mail.senderEmail === MY_EMAIL().toLowerCase()) { processed[id] = true; continue; }
        var r = classify(mail);
        var cat = catByKey(r.category);

        // 長信 TL;DR
        if (mail.body.length >= TLDR_MIN_CHARS() && r.importance >= 3) {
          try { r.tldr = geminiSummarizeLong(mail); } catch (e) {}
        }

        // 加標籤
        thread.addLabel(ensureLabel(cat.label));

        // 需回覆的真人信 → 備草稿
        var draftMade = false;
        if (r.is_real_person && r.needs_reply) {
          try {
            var body = geminiDraftReply(mail);
            gmsg.createDraftReply(body);
            thread.addLabel(ensureLabel(catByKey('reply').label));
            draftMade = true;
          } catch (e) {}
        }

        appendRecord({
          msgId: id, threadId: mail.threadId, dateMs: mail.dateMs,
          sender: mail.sender, senderEmail: mail.senderEmail, subject: mail.subject,
          category: r.category, importance: r.importance,
          isRealPerson: r.is_real_person, needsReply: r.needs_reply,
          isUrgent: r.is_urgent, tldr: r.tldr, todos: r.todos,
          draftMade: draftMade, processedAt: new Date().toISOString()
        });
        processed[id] = true;
        newCount++;
        if (r.is_urgent) urgent.push({subject: mail.subject, sender: mail.senderEmail, tldr: r.tldr});
      } catch (err) {
        Logger.log('處理 ' + id + ' 失敗：' + err);
        // 只有「所有備援模型都被限流/配額用完」(QUOTA) 才停掉整批；單封的零星錯誤跳過續跑下一封。
        if (String(err).indexOf('QUOTA') >= 0) {
          Logger.log('⚠️ Gemini 配額/限流：三個備援模型都滿了，已中止本輪。稍等 1–2 分鐘再跑即可（已處理的不會重做）。');
          quotaHit = true;
          break;
        }
      }
    }
  }

  if (urgent.length && ENABLE_URGENT_ALERT()) sendUrgentAlert(urgent);
  Logger.log('本輪新處理 ' + newCount + ' 封；緊急 ' + urgent.length + ' 封');
  return newCount;
}

function sendUrgentAlert(urgent) {
  var html = ['<h3>🚨 緊急信提醒</h3><ul>'];
  for (var i = 0; i < urgent.length; i++) {
    html.push('<li><b>' + esc(urgent[i].subject) + '</b><br><span style="color:#666">' +
              esc(urgent[i].sender) + '｜' + esc(urgent[i].tldr) + '</span></li>');
  }
  html.push('</ul>');
  sendHtmlSelf('🚨 緊急信 ' + urgent.length + ' 封需注意', html.join(''));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===================================================================
// ===== Reporter.gs
// ===================================================================
/** 報告：每日 22:30 完整統整 + 每週五週報（HTML email 寄給自己，標題可點擊直接跳到該封信）。 */

// 報告中視為「噪音／不需處理」的類別：收合成一行數字，不逐封列出
var LOW_VALUE_REPORT = {promo:1, news:1, shopping:1, card:1, bill:1, security:1};

// Pin the link to the account by IDENTITY (authuser=<email>), never by POSITION (u/0):
// u/0 = "first signed-in account", which opens the wrong mailbox when several Google
// accounts are signed in. MY_EMAIL() = the account that authorized this script, so the
// report links always resolve to the exact mailbox being reported on.
function mailUrl(threadId) {
  return 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(MY_EMAIL()) + '#all/' + threadId;
}
// 標題連結＝桌機跳轉（手機版 Gmail 不吃 hash route、googlegmail:// 在信內被 sanitizer 砍，
// 兩條路都驗證死過）。手機改走 viewLink：信內放 https Web App 連結（sanitizer 不砍），
// doGet 直接渲染該信內容＋「在 Gmail App 開啟」按鈕（googlegmail:// 從網頁發起不經 sanitizer）。
function mailLink(threadId, html) {
  if (!threadId) return html;
  return '<a href="' + mailUrl(threadId) + '" style="color:#1a73e8;text-decoration:none">' + html + '</a>' +
         viewLink(threadId);
}

// Map astral (4-byte) subject emoji to BMP look-alikes. GmailApp corrupts surrogate pairs,
// and a Subject header can't use HTML entities, so the only safe option is a BMP glyph.
var SUBJECT_EMOJI_BMP = { '📬': '✉', '🚨': '⚠', '🌅': '☀', '🌙': '☾' };

// Convert astral code points (U+10000+) to HTML numeric entities so GmailApp — which
// CESU-8-corrupts UTF-16 surrogate pairs into 6 replacement chars — never receives a raw
// 4-byte char. BMP chars pass through; the mail client renders &#NNNN; back into the emoji.
function astralToEntities(s) {
  return String(s).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function (pair) {
    return '&#' + pair.codePointAt(0) + ';';
  });
}
function safeSubject(s) {
  s = String(s);
  for (var k in SUBJECT_EMOJI_BMP) s = s.split(k).join(SUBJECT_EMOJI_BMP[k]);
  // Drop any astral emoji with no BMP twin (e.g. 📅) — no entity option in a Subject header.
  return s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').replace(/^ +/, '').replace(/ {2,}/g, ' ');
}

/**
 * Send an HTML email to self. Body astral emoji are HTML-entity-encoded and subject astral
 * emoji are mapped to BMP, so GmailApp.sendEmail never receives a raw 4-byte character
 * (it would split surrogate pairs into CESU-8 and corrupt them). Needs no Gmail API / extra scope.
 */
function sendHtmlSelf(subject, html) {
  GmailApp.sendEmail(MY_EMAIL(), safeSubject(subject), '', { htmlBody: astralToEntities(html) });
}
function stars(imp) {
  var n = Math.max(0, Number(imp) - 3), s = '';
  for (var i = 0; i < n; i++) s += '⭐';
  return s;
}
function byImpDesc(a, b) { return Number(b.importance) - Number(a.importance); }

function windowFor(mode, now) {
  var today8 = new Date(now); today8.setHours(8, 0, 0, 0);
  var DAY = 86400000;
  if (mode === 'morning')
    return {start: today8.getTime() - DAY, end: today8.getTime(),
            title: '🌅 每日完整統整（昨日 08:00 → 今日 08:00）'};
  if (mode === 'afternoon')
    return {start: today8.getTime(), end: now.getTime(),
            title: '☀️ 白天進度快報（今日 08:00 → 17:00）'};
  return {start: now.getTime() - DAY, end: now.getTime(),
          title: '🌙 每日完整統整（過去 24 小時）＋明天注意'};
}

function buildReport(mode) {
  var now = new Date();
  var w = windowFor(mode, now);
  var msgs = getRecordsBetween(w.start, w.end);

  var byCat = {};
  for (var i = 0; i < msgs.length; i++)
    (byCat[msgs[i].category] = byCat[msgs[i].category] || []).push(msgs[i]);

  // 待辦/截止
  var todos = [];
  for (var j = 0; j < msgs.length; j++) {
    var ts = msgs[j].todos || [];
    for (var k = 0; k < ts.length; k++)
      if (ts[k] && ts[k].task)
        todos.push({task: ts[k].task, due: ts[k].due || '', subject: msgs[j].subject, threadId: msgs[j].threadId});
  }
  todos.sort(function (a, b) {
    if (!a.due && b.due) return 1; if (a.due && !b.due) return -1;
    return a.due < b.due ? -1 : (a.due > b.due ? 1 : 0);
  });

  var action = msgs.filter(function (m) { return m.category === 'reply' || m.needsReply; }).sort(byImpDesc);
  var drafted = action.filter(function (m) { return m.draftMade; });

  // 重點信件：重要度 ≥ 3、且不是需回覆（避免和上面重複）、且非純噪音 → 依重要度排序
  var highlights = msgs.filter(function (m) {
    return !(m.category === 'reply' || m.needsReply) && Number(m.importance) >= 3 && !LOW_VALUE_REPORT[m.category];
  }).sort(byImpDesc);

  var h = [];
  h.push('<div style="font-family:-apple-system,\'Microsoft JhengHei\',sans-serif;max-width:680px;margin:auto;color:#222">');
  h.push('<h2 style="margin-bottom:4px">' + esc(w.title) + '</h2>');
  h.push('<div style="color:#888;font-size:13px">產生時間 ' +
         Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd HH:mm') +
         '　共處理 ' + msgs.length + ' 封　（點標題可直接開信）</div>' +
         '<hr style="border:none;border-top:1px solid #eee">');

  // 沒有需處理的重要信時，明確告知
  if (!action.length && !highlights.length && !todos.length) {
    h.push('<p style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:8px;padding:12px">' +
           '✅ 本時段沒有需要你處理的重要信件，其餘皆為通知類已自動歸檔。</p>');
  }

  // 🔴 需要你回覆（可點擊、依重要度）
  if (action.length) {
    h.push('<h3>🔴 需要你回覆</h3><ul>');
    action.forEach(function (m) {
      var tag = m.draftMade ? '　<span style="color:#0a7">✅ 已備草稿</span>' : '';
      h.push('<li>' + stars(m.importance) + mailLink(m.threadId, '<b>' + esc(m.subject) + '</b>') +
             '<br><span style="color:#666;font-size:13px">' + esc(m.senderEmail) + '｜' + esc(m.tldr) + '</span>' + tag + '</li>');
    });
    h.push('</ul>');
    if (drafted.length) h.push('<p style="font-size:13px;color:#0a7">📝 已在草稿匣備好 ' +
                               drafted.length + ' 封回覆草稿，請過目後送出。</p>');
  }

  // ⭐ 重點信件（依重要性）
  if (highlights.length) {
    h.push('<h3>⭐ 重點信件（依重要性）</h3><ul>');
    highlights.slice(0, 10).forEach(function (m) {
      var c = catByKey(m.category);
      h.push('<li>' + stars(m.importance) + (c ? c.emoji : '') + ' ' +
             mailLink(m.threadId, '<b>' + esc(m.subject).slice(0, 60) + '</b>') +
             ' <span style="color:#888;font-size:12px">— ' + esc(m.senderEmail) + '</span><br>' +
             '<span style="color:#666;font-size:13px">' + esc(m.tldr).slice(0, 90) + '</span></li>');
    });
    h.push('</ul>');
  }

  // 🟠 待辦 / 截止日（可點擊）
  if (todos.length) {
    h.push('<h3>🟠 待辦 / 截止日</h3><ul>');
    todos.slice(0, 15).forEach(function (t) {
      var due = t.due ? '<b style="color:#c00">[' + esc(t.due) + ']</b> ' : '';
      h.push('<li>' + due + mailLink(t.threadId, esc(t.task)) +
             '　<span style="color:#888;font-size:12px">— ' + esc(t.subject).slice(0, 40) + '</span></li>');
    });
    h.push('</ul>');
  }

  // 分類明細：高價值類別展開（依重要度），噪音類別收合成一行
  ['A', 'B', 'C'].forEach(function (grp) {
    var grpCats = CATEGORIES.filter(function (c) { return c.group === grp && byCat[c.key]; });
    if (!grpCats.length) return;
    var rich = grpCats.filter(function (c) { return !LOW_VALUE_REPORT[c.key]; });
    var noise = grpCats.filter(function (c) { return LOW_VALUE_REPORT[c.key]; });
    h.push('<h3>' + esc(GROUP_TITLES[grp]) + '</h3>');
    rich.forEach(function (c) {
      var items = byCat[c.key].slice().sort(byImpDesc);
      h.push('<details open><summary style="cursor:pointer;font-weight:bold">' + c.emoji + ' ' +
             esc(c.label.split('/')[1]) + '（' + items.length + '）</summary><ul style="margin-top:4px">');
      items.slice(0, 8).forEach(function (m) {
        h.push('<li>' + stars(m.importance) + mailLink(m.threadId, '<b>' + esc(m.subject).slice(0, 60) + '</b>') +
               ' <span style="color:#888;font-size:12px">— ' + esc(m.senderEmail) + '</span><br>' +
               '<span style="color:#666;font-size:13px">' + esc(m.tldr).slice(0, 90) + '</span></li>');
      });
      if (items.length > 8) h.push('<li style="color:#888">…還有 ' + (items.length - 8) + ' 封</li>');
      h.push('</ul></details>');
    });
    if (noise.length) {
      var parts = noise.map(function (c) { return c.emoji + esc(c.label.split('/')[1]) + ' ' + byCat[c.key].length; });
      h.push('<p style="font-size:13px;color:#999;background:#fafafa;padding:8px 10px;border-radius:8px">' +
             '🔕 其他通知（已歸檔、不需處理）：' + parts.join('　｜　') + '</p>');
    }
  });

  // ⏰ 跟催（可點擊）
  var fu = findFollowups();
  if (fu.length) {
    h.push('<h3>⏰ 跟催提醒（你寄出後對方還沒回）</h3><ul>');
    fu.slice(0, 10).forEach(function (f) {
      h.push('<li>' + mailLink(f.threadId, '<b>' + esc(f.subject).slice(0, 60) + '</b>') +
             ' → ' + esc(f.recipient).slice(0, 40) +
             '<span style="color:#888;font-size:12px">（' + esc(f.sentDate).slice(0, 16) + '）</span>' +
             dismissLink(f.threadId) + '</li>');
    });
    h.push('</ul>');
  }

  // 夜間：明天注意
  if (mode === 'night') {
    var tmr = Utilities.formatDate(new Date(now.getTime() + 86400000), 'Asia/Taipei', 'yyyy-MM-dd');
    var tmrTodos = todos.filter(function (t) { return t.due && t.due <= tmr; });
    h.push('<h3>📌 明天注意</h3>');
    if (tmrTodos.length) {
      h.push('<ul>');
      tmrTodos.forEach(function (t) {
        h.push('<li><b style="color:#c00">[' + esc(t.due) + ']</b> ' + mailLink(t.threadId, esc(t.task)) + '</li>');
      });
      h.push('</ul>');
    } else h.push('<p style="color:#888">目前沒有明天到期的待辦 👍</p>');
  }

  h.push('<hr style="border:none;border-top:1px solid #eee"><div style="color:#aaa;font-size:12px">🤖 Gmail 助理自動生成</div></div>');
  return {title: w.title, html: h.join('\n')};
}

function sendReport(mode) {
  var r = buildReport(mode);
  var subject = '📬 ' + r.title + '　' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm');
  sendHtmlSelf(subject, r.html);
  return subject;
}

// ── 跟催「一鍵結案」Web App ───────────────────────────────────
// 報告每筆跟催附一個「✅ 已完成」連結 → 點了打到 doGet → 該信貼上結案標籤 → 之後不再提醒。
// 桌機/手機都能用（純 https GET，不會被 Gmail 濾掉）。需先部署 Web App 並把 /exec 網址存進
// 指令碼屬性 WEBAPP_URL；未設定前連結自動隱藏（功能優雅退場，報告照常）。
var FOLLOWUP_DONE_LABEL = LABEL_PREFIX + '/跟催結案';

// 防止信件被轉寄後遭隨手亂點：帶一把存在指令碼屬性的隨機 key（setup 時自動產生）。
function dismissKey() {
  var props = PropertiesService.getScriptProperties();
  var k = props.getProperty('DISMISS_KEY');
  if (!k) { k = Utilities.getUuid().replace(/-/g, ''); props.setProperty('DISMISS_KEY', k); }
  return k;
}

function dismissLink(threadId) {
  var base = prop('WEBAPP_URL', '');
  if (!base) return '';   // 還沒部署 Web App → 不顯示按鈕
  var url = base + '?t=' + encodeURIComponent(threadId) + '&k=' + encodeURIComponent(dismissKey());
  return ' <a href="' + url + '" style="display:inline-block;padding:2px 10px;margin-left:6px;' +
         'background:#e6f4ea;color:#137333;border-radius:12px;font-size:13px;font-weight:bold;' +
         'text-decoration:none">✅ 已完成</a>';
}

// 📱 手機看信：報告每個標題旁的小 pill → WEBAPP_URL?v=<threadId> → doGet 渲染信件內容。
// 與 dismissLink 同享 DISMISS_KEY 與「未設 WEBAPP_URL 自動隱藏」的優雅退場。
function viewLink(threadId) {
  var base = prop('WEBAPP_URL', '');
  if (!base || !threadId) return '';
  var url = base + '?v=' + encodeURIComponent(threadId) + '&k=' + encodeURIComponent(dismissKey());
  return ' <a href="' + url + '" style="display:inline-block;padding:1px 8px;margin-left:4px;' +
         'background:#e8f0fe;color:#1a73e8;border-radius:12px;font-size:12px;font-weight:bold;' +
         'text-decoration:none">📱</a>';
}

function thread_hasLabel(thread, name) {
  var ls = thread.getLabels();
  for (var i = 0; i < ls.length; i++) if (ls[i].getName() === name) return true;
  return false;
}

// Web App 進入點：報告裡的「✅ 已完成」（?t=）與「📱 手機看信」（?v=）都打到這裡。
function doGet(e) {
  var t = (e && e.parameter && e.parameter.t) || '';
  var v = (e && e.parameter && e.parameter.v) || '';
  var k = (e && e.parameter && e.parameter.k) || '';
  function page(icon, msg) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:-apple-system,sans-serif;max-width:420px;margin:48px auto;text-align:center;color:#222">' +
      '<div style="font-size:48px">' + icon + '</div><p style="font-size:18px">' + msg + '</p>' +
      '<p style="color:#888;font-size:13px">可直接關閉此分頁。</p></div>');
  }
  if (k !== dismissKey()) return page('⚠️', '連結無效或已過期。');
  if (v) {
    try { return viewPage(v); }
    catch (err) { return page('⚠️', '讀取失敗：' + err); }
  }
  try {
    var thread = GmailApp.getThreadById(t);
    if (!thread) return page('⚠️', '找不到這封信（可能已刪除）。');
    thread.addLabel(ensureLabel(FOLLOWUP_DONE_LABEL));
    return page('✅', '已標記「跟催結案」，這封不會再出現在跟催提醒裡。');
  } catch (err) {
    return page('⚠️', '處理失敗：' + err);
  }
}

/** 📱 手機看信頁：doGet 以擁有者身分讀取該 thread 最新一封信，直接渲染內容（手機保證能看到信），
 *  並附「在 Gmail App 開啟」按鈕。googlegmail:// 放在「網頁」上不會被 Gmail 信件 sanitizer 砍
 *  （死掉的是「信內」的 googlegmail href）；message_id 的格式社群有 hex id 與 RFC822 兩派
 *  說法，故主按鈕用 hex id、另附 RFC822 備用連結，實機測試後留下會動的那個。 */
function viewPage(threadId) {
  var thread = GmailApp.getThreadById(threadId);
  if (!thread) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:-apple-system,sans-serif;max-width:420px;margin:48px auto;text-align:center;color:#222">' +
      '<div style="font-size:48px">⚠️</div><p style="font-size:18px">找不到這封信（可能已刪除）。</p></div>')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var msgs = thread.getMessages();
  var last = msgs[msgs.length - 1];
  var subject = last.getSubject() || '(無主旨)';
  var from = last.getFrom() || '';
  var date = Utilities.formatDate(last.getDate(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  var rfc = String(last.getHeader('Message-ID') || '').replace(/[<>]/g, '');
  function appUrl(mid) {
    return 'googlegmail:///cv?account_id=' + encodeURIComponent(MY_EMAIL()) +
           '&message_id=' + encodeURIComponent(mid) + '&view=cv';
  }
  // 信件原始 HTML：去掉 <script> 再嵌入（HtmlService 本身已跑在 googleusercontent 沙箱網域）。
  var body = (last.getBody() || '').replace(/<script[\s\S]*?<\/script>/gi, '');
  if (!body) body = '<pre style="white-space:pre-wrap">' + esc(last.getPlainBody() || '') + '</pre>';
  var html =
    '<div style="font-family:-apple-system,\'Microsoft JhengHei\',sans-serif;max-width:680px;margin:16px auto;padding:0 12px;color:#222">' +
    '<h2 style="margin:8px 0;font-size:20px">' + esc(subject) + '</h2>' +
    '<div style="color:#666;font-size:13px;margin-bottom:12px">' + esc(from) + '　' + esc(date) +
    (msgs.length > 1 ? '　（此串共 ' + msgs.length + ' 封，顯示最新一封）' : '') + '</div>' +
    '<div style="margin:12px 0">' +
    '<a href="' + appUrl(last.getId()) + '" style="display:inline-block;padding:10px 18px;margin:2px 6px 2px 0;' +
    'background:#1a73e8;color:#fff;border-radius:8px;font-weight:bold;text-decoration:none">📨 在 Gmail App 開啟</a>' +
    '<a href="' + mailUrl(threadId) + '" style="display:inline-block;padding:10px 18px;margin:2px 0;' +
    'background:#f1f3f4;color:#222;border-radius:8px;text-decoration:none">🖥️ 桌機版開啟</a></div>' +
    (rfc ? '<div style="font-size:12px;color:#888;margin-bottom:8px">App 按鈕沒反應？' +
           '<a href="' + appUrl(rfc) + '">改試備用格式</a></div>' : '') +
    '<hr style="border:none;border-top:1px solid #eee">' +
    '<div style="font-size:15px;line-height:1.6;overflow-x:auto;word-break:break-word">' + body + '</div></div>';
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle(safeSubject(subject));
}

/** Follow-ups: threads I sent where the other party hasn't replied (includes threadId for direct-open links).
 *  已貼「🤖/跟催結案」標籤者（使用者按過「✅ 已完成」）自動略過。 */
function findFollowups() {
  var days = FOLLOWUP_DAYS();
  var q = 'in:sent newer_than:' + (days + 21) + 'd older_than:' + days + 'd';
  var threads = GmailApp.search(q, 0, 30);
  var me = MY_EMAIL().toLowerCase();
  var out = [];
  for (var i = 0; i < threads.length; i++) {
    if (thread_hasLabel(threads[i], FOLLOWUP_DONE_LABEL)) continue;   // 已結案 → 不再提醒
    var msgs = threads[i].getMessages();
    var last = msgs[msgs.length - 1];
    // 收件人裡至少要有一個「不是我自己」的對象，才算「等對方回」；
    // bot 自己寄給自己的報告/緊急提醒是 me→me，沒有外部收件人 → 略過。
    var to = last.getTo() || '';
    var hasOther = to.split(',').some(function (r) {
      return r.toLowerCase().indexOf(me) < 0 && r.replace(/[\s<>"']/g, '').length > 0;
    });
    if (last.getFrom().toLowerCase().indexOf(me) >= 0 && hasOther) {
      out.push({subject: last.getSubject() || '(無主旨)', recipient: last.getTo(),
                threadId: threads[i].getId(),
                sentDate: Utilities.formatDate(last.getDate(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm')});
    }
  }
  return out;
}

/** 每週五 22:30：過去 7 天總摘要 ＋ 重要提醒 highlight（可點擊）。 */
function buildWeeklyReport() {
  var now = new Date();
  var DAY = 86400000;
  var start = now.getTime() - 7 * DAY;
  var msgs = getRecordsBetween(start, now.getTime());

  var byCat = {};
  for (var i = 0; i < msgs.length; i++)
    (byCat[msgs[i].category] = byCat[msgs[i].category] || []).push(msgs[i]);

  var action = msgs.filter(function (m) { return m.category === 'reply' || m.needsReply; }).sort(byImpDesc);
  var drafted = action.filter(function (m) { return m.draftMade; });
  var urgent = msgs.filter(function (m) { return m.isUrgent; });
  var important = msgs.filter(function (m) { return Number(m.importance) >= 4 && !LOW_VALUE_REPORT[m.category]; }).sort(byImpDesc);

  var todos = [];
  for (var j = 0; j < msgs.length; j++) {
    var ts = msgs[j].todos || [];
    for (var k = 0; k < ts.length; k++)
      if (ts[k] && ts[k].task)
        todos.push({task: ts[k].task, due: ts[k].due || '', subject: msgs[j].subject, threadId: msgs[j].threadId});
  }
  todos.sort(function (a, b) {
    if (!a.due && b.due) return 1; if (a.due && !b.due) return -1;
    return a.due < b.due ? -1 : (a.due > b.due ? 1 : 0);
  });

  var fu = findFollowups();

  var aiSummary = '';
  try { aiSummary = geminiWeeklyDigest(msgs); } catch (e) {}

  var fmt = function (ms) { return Utilities.formatDate(new Date(ms), 'Asia/Taipei', 'MM/dd'); };
  var title = '📅 本週總摘要（' + fmt(start) + ' → ' + fmt(now.getTime()) + '）';

  var h = [];
  h.push('<div style="font-family:-apple-system,\'Microsoft JhengHei\',sans-serif;max-width:680px;margin:auto;color:#222">');
  h.push('<h2 style="margin-bottom:4px">' + esc(title) + '</h2>');
  h.push('<div style="color:#888;font-size:13px">產生時間 ' +
         Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd HH:mm') +
         '　本週共處理 ' + msgs.length + ' 封　（點標題可直接開信）</div>');

  // ── 重要提醒 highlight ──
  var hl = [];
  if (action.length)  hl.push('🔴 <b>' + action.length + '</b> 封需回覆' + (drafted.length ? '（已備 ' + drafted.length + ' 封草稿）' : ''));
  var dueTodos = todos.filter(function (t) { return t.due; });
  if (dueTodos.length) hl.push('🟠 <b>' + dueTodos.length + '</b> 項有截止日待辦');
  if (urgent.length)  hl.push('🚨 <b>' + urgent.length + '</b> 封緊急信');
  if (fu.length)      hl.push('⏰ <b>' + fu.length + '</b> 封寄出未獲回覆');
  if (hl.length) {
    h.push('<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:10px;padding:12px 14px;margin:12px 0">' +
           '<div style="font-weight:bold;margin-bottom:6px">⚡ 本週重要提醒</div>' +
           '<div style="font-size:14px;line-height:1.9">' + hl.join('　｜　') + '</div></div>');
  }

  // ── Gemini 本週重點 ──
  if (aiSummary) {
    h.push('<h3>⭐ 本週重點（AI 統整）</h3>');
    h.push('<div style="font-size:14px;line-height:1.8;white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:8px">' +
           esc(aiSummary) + '</div>');
  }

  // ── 需回覆 ──
  if (action.length) {
    h.push('<h3>🔴 需要你回覆</h3><ul>');
    action.forEach(function (m) {
      var tag = m.draftMade ? '　<span style="color:#0a7">✅ 已備草稿</span>' : '';
      h.push('<li>' + stars(m.importance) + mailLink(m.threadId, '<b>' + esc(m.subject) + '</b>') +
             '<br><span style="color:#666;font-size:13px">' + esc(m.senderEmail) + '｜' + esc(m.tldr) + '</span>' + tag + '</li>');
    });
    h.push('</ul>');
  }

  // ── 待辦 / 截止 ──
  if (todos.length) {
    h.push('<h3>🟠 待辦 / 截止日</h3><ul>');
    todos.slice(0, 20).forEach(function (t) {
      var due = t.due ? '<b style="color:#c00">[' + esc(t.due) + ']</b> ' : '';
      h.push('<li>' + due + mailLink(t.threadId, esc(t.task)) +
             '　<span style="color:#888;font-size:12px">— ' + esc(t.subject).slice(0, 40) + '</span></li>');
    });
    h.push('</ul>');
  }

  // ── 本週重要事件（重要度 ≥ 4，依重要度）──
  if (important.length) {
    h.push('<h3>⭐ 本週重要事件</h3><ul>');
    important.slice(0, 15).forEach(function (m) {
      var c = catByKey(m.category);
      h.push('<li>' + stars(m.importance) + (c ? c.emoji : '') + ' ' +
             mailLink(m.threadId, '<b>' + esc(m.subject).slice(0, 60) + '</b>') +
             ' <span style="color:#888;font-size:12px">— ' + esc(m.senderEmail) + '</span><br>' +
             '<span style="color:#666;font-size:13px">' + esc(m.tldr).slice(0, 100) + '</span></li>');
    });
    h.push('</ul>');
  }

  // ── 跟催 ──
  if (fu.length) {
    h.push('<h3>⏰ 跟催提醒（你寄出後對方還沒回）</h3><ul>');
    fu.slice(0, 15).forEach(function (f) {
      h.push('<li>' + mailLink(f.threadId, '<b>' + esc(f.subject).slice(0, 60) + '</b>') +
             ' → ' + esc(f.recipient).slice(0, 40) +
             '<span style="color:#888;font-size:12px">（' + esc(f.sentDate).slice(0, 16) + '）</span>' +
             dismissLink(f.threadId) + '</li>');
    });
    h.push('</ul>');
  }

  // ── 本週分類統計 ──
  var keys = Object.keys(byCat).sort(function (a, b) { return byCat[b].length - byCat[a].length; });
  if (keys.length) {
    var counts = keys.map(function (kk) {
      var c = catByKey(kk); return (c ? c.emoji + c.label.split('/')[1] : kk) + ' ' + byCat[kk].length;
    }).join('　｜　');
    h.push('<h3>📊 本週分類統計</h3>');
    h.push('<p style="font-size:13px;background:#f6f8fa;padding:10px;border-radius:8px">' + esc(counts) + '</p>');
  }

  h.push('<hr style="border:none;border-top:1px solid #eee"><div style="color:#aaa;font-size:12px">🤖 Gmail 助理 — 每週五自動生成</div></div>');
  return {title: title, html: h.join('\n')};
}

function sendWeeklyReport() {
  var r = buildWeeklyReport();
  var subject = '📅 ' + r.title + '　' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm');
  sendHtmlSelf(subject, r.html);
  return subject;
}

// ===================================================================
// ===== Triggers.gs
// ===================================================================
/**
 * 進入點與排程。第一次請手動執行 setup()（會要求授權），之後全自動。
 */

// ── 排程進入點 ──────────────────────────────────────────
// 註：期刊週報專案改在週五 07:00 先跑，優先取得當天最好的 Gemini 模型；
//     本 bot 每天只在 22:30 跑一次完整統整（過去 24h），週五另加 22:30 週報。
// runMorning/runAfternoon 保留供手動測試用（testMorningReport 等），但不再排程。
function runMorning()   { processInbox(); Logger.log(sendReport('morning')); }
function runAfternoon() { processInbox(); Logger.log(sendReport('afternoon')); }
function runNight()     { processInbox(); pruneOld(7); Logger.log(sendReport('night')); }
function runWeekly()    { processInbox(); Logger.log(sendWeeklyReport()); }   // 每週五 22:30 額外的一週總摘要

// 只整理、不出報告（想手動測分類時用）
function runProcessOnly() { Logger.log('新處理 ' + processInbox() + ' 封'); }

// ── 一次性安裝 ──────────────────────────────────────────
function setup() {
  // 1) 建立 15 個 🤖/ 標籤，外加跟催「結案」標籤
  for (var i = 0; i < CATEGORIES.length; i++) ensureLabel(CATEGORIES[i].label);
  ensureLabel(FOLLOWUP_DONE_LABEL);
  // 2) 建立紀錄用的 Google Sheet
  getLogSheet();
  // 3) 安裝時間觸發器
  installTriggers();
  // 4) 產生跟催「一鍵結案」用的金鑰（Web App 連結會帶上）
  dismissKey();
  Logger.log('✅ setup 完成：標籤、紀錄表、每日 22:30 統整觸發器都建好了。');
  Logger.log('紀錄表網址：' + SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SHEET_ID')).getUrl());
  Logger.log('📌 若要啟用「✅ 已完成」一鍵結案與「📱 手機看信」：右上「部署→新增部署→類型選「網頁應用程式」'
    + '→執行身分=我、誰可存取=「任何人」→部署，複製 /exec 網址，貼到「專案設定→指令碼屬性」'
    + '新增 WEBAPP_URL=該網址。未設定前報告照常，只是不顯示這兩種按鈕。');
}

function installTriggers() {
  // 先清掉本專案舊的觸發器，避免重複
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) ScriptApp.deleteTrigger(triggers[i]);

  ScriptApp.newTrigger('runNight').timeBased().everyDays(1).atHour(22).nearMinute(30).create();
  // 每週五 22:30 額外寄「本週總摘要」（與當晚夜報並存，故週五會收到兩封）
  ScriptApp.newTrigger('runWeekly').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(22).nearMinute(30).create();
  Logger.log('已安裝 1 個每日 22:30 統整觸發器 ＋ 1 個每週五 22:30 週報觸發器（誤差約 ±15 分）。');
}

// ── 自我檢查（不改信箱，只測 Gemini 連線）─────────────────
function testGemini() {
  var out = geminiGenerate('只回覆「OK」兩個字', 'ping', false);
  Logger.log('Gemini 回應：' + out);
}

// 想手動跑一次完整早報看看效果：
function testMorningReport() { processInbox(); Logger.log(sendReport('morning')); }

// 想手動跑一次「本週總摘要」看看效果：
function testWeeklyReport() { processInbox(); Logger.log(sendWeeklyReport()); }
