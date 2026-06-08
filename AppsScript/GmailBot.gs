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
