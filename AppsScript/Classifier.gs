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
