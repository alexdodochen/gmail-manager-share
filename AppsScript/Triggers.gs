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
