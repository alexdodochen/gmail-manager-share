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

/** 📱 手機看信頁：doGet 以擁有者身分讀取該 thread 最新一封信，直接渲染內容（手機看信的最終解）。
 *  「跳轉 app 到指定信件」（googlegmail:///cv）實機判死：hex 與 RFC822 兩種 id、
 *  Safari 與 Gmail 內建瀏覽器都試過 — app 會醒來但停在原畫面，現代 Gmail iOS 已不處理 /cv，
 *  勿再嘗試。改附「↩️ 在 Gmail App 回覆」（googlegmail:///co 撰寫路徑，仍受支援）＋桌機連結。 */
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
  var fromEmail = String(last.getReplyTo() || last.getFrom() || '');
  var em = fromEmail.match(/<([^>]+)>/);
  fromEmail = em ? em[1] : fromEmail.trim();
  var replyUrl = 'googlegmail:///co?to=' + encodeURIComponent(fromEmail) +
                 '&subject=' + encodeURIComponent('Re: ' + subject);
  // 信件原始 HTML：去掉 <script> 再嵌入（HtmlService 本身已跑在 googleusercontent 沙箱網域）。
  var body = (last.getBody() || '').replace(/<script[\s\S]*?<\/script>/gi, '');
  if (!body) body = '<pre style="white-space:pre-wrap">' + esc(last.getPlainBody() || '') + '</pre>';
  var html =
    '<div style="font-family:-apple-system,\'Microsoft JhengHei\',sans-serif;max-width:680px;margin:16px auto;padding:0 12px;color:#222">' +
    '<h2 style="margin:8px 0;font-size:20px">' + esc(subject) + '</h2>' +
    '<div style="color:#666;font-size:13px;margin-bottom:12px">' + esc(from) + '　' + esc(date) +
    (msgs.length > 1 ? '　（此串共 ' + msgs.length + ' 封，顯示最新一封）' : '') + '</div>' +
    // target="_blank" 是必要的：HtmlService 頁面跑在 sandboxed iframe 裡，iframe 內直接導向
    // custom scheme 會被 sandbox 默默擋掉；開新視窗（allow-popups-to-escape-sandbox）才出得去。
    '<div style="margin:12px 0">' +
    '<a href="' + replyUrl + '" target="_blank" rel="noopener" style="display:inline-block;padding:10px 18px;margin:2px 6px 2px 0;' +
    'background:#1a73e8;color:#fff;border-radius:8px;font-weight:bold;text-decoration:none">↩️ 在 Gmail App 回覆</a>' +
    '<a href="' + mailUrl(threadId) + '" target="_blank" rel="noopener" style="display:inline-block;padding:10px 18px;margin:2px 0;' +
    'background:#f1f3f4;color:#222;border-radius:8px;text-decoration:none">🖥️ 桌機版開啟</a></div>' +
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
