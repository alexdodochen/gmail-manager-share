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
