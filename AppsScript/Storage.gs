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
