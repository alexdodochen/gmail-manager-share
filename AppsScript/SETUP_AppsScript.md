# ☁️ 雲端版安裝（Google Apps Script）— 電腦不用開著

程式跑在 Google 伺服器上，綁在你的 Gmail 帳號。**不需要 Google Cloud、不需要憑證檔、電腦關機照跑。**
全程約 10 分鐘，照做一次即可。

---

## 步驟 1：申請免費 Gemini API Key
1. 到 **https://aistudio.google.com/apikey**（用你的 Google 帳號登入）
2. 「Create API key」→ 複製金鑰備用。

---

## 步驟 2：建立 Apps Script 專案
1. 到 **https://script.google.com** → 左上「**新專案**」
2. 把預設的 `Code.gs` 內容清空。
3. 依下表，逐一新增檔案（左側「檔案 +」→「指令碼」），**檔名要一致**，把對應內容整段貼進去：

| 在 Apps Script 新增的檔名 | 貼上這個檔的內容 |
|---|---|
| `Config.gs`    | `Config.gs` |
| `Gemini.gs`    | `Gemini.gs` |
| `Classifier.gs`| `Classifier.gs` |
| `Storage.gs`   | `Storage.gs` |
| `GmailBot.gs`  | `GmailBot.gs` |
| `Reporter.gs`  | `Reporter.gs` |
| `Triggers.gs`  | `Triggers.gs` |

> （`appsscript.json` 是設定檔：點左側齒輪「專案設定」→ 勾「在編輯器顯示 appsscript.json」，再把內容換成本資料夾的 `appsscript.json`。可省略，但建議做，這樣時區才會是台北。）

---

## 步驟 3：填入 Gemini 金鑰（安全存放，不寫在程式裡）
1. 左側齒輪「**專案設定**」→ 最下方「**指令碼屬性**」→「新增指令碼屬性」
2. 屬性名稱填 `GEMINI_API_KEY`，值貼上步驟 1 的金鑰 → 儲存。

> （可選）想換模型可再加一條 `GEMINI_MODEL` = `gemini-2.0-flash`。

---

## 步驟 4：第一次執行 = 授權 + 安裝
1. 上方函式下拉選 **`setup`** → 按「**執行**」。
2. 會跳出授權視窗 → 選你的帳號 → 「進階」→「前往（不安全）」→ 允許。
   （因為是你自己的私人指令碼，這個警告是正常的。）
3. 執行完成後，看「執行紀錄」會出現 ✅ 與一個 **紀錄表網址**（Google Sheet，可隨時打開看分類結果）。

這一步會自動：建立 15 個 `🤖/` 標籤、建立紀錄 Sheet、安裝 08:00 / 17:00 / 22:30 三個每日觸發器，**外加每週五 22:30 的「本週總摘要」觸發器**。

---

## 步驟 5：馬上跑一次看效果
1. 函式下拉選 **`testMorningReport`** → 執行。
2. 去 Gmail 看：信被加上 `🤖/期刊`、`🤖/薪水`… 標籤，並收到一封「🌅 每日完整統整」報告。
3. 需回覆的真人信，草稿會在草稿匣（**不會自動寄出**）。
4. 想預覽每週五的「本週總摘要 + 重要提醒」：函式下拉選 **`testWeeklyReport`** → 執行，會立刻寄一份過去 7 天的週報給你。

完成！之後每天 08:00 / 17:00 / 22:30 會自動跑，**每週五 22:30 再多一份本週總摘要**，**電腦不用開**。
（註：週五 22:30 你會收到兩封 — 當晚夜報 ＋ 本週總摘要。）

---

## 日常 & 調整
- **看排程**：左側「觸發條件」(鬧鐘圖示) 可看到三個 trigger。
- **改分類規則**：編輯 `Config.gs` 的 `SENDER_RULES`，存檔即生效。
- **改參數**：在「指令碼屬性」加 `FOLLOWUP_DAYS`、`TLDR_MIN_CHARS`、`ENABLE_URGENT_ALERT`(true/false)。
- **只整理不出報告**：手動執行 `runProcessOnly`。
- **看紀錄**：打開那份 `GmailBot_Log` Sheet。

## 注意
- 觸發時間有約 ±15 分鐘誤差（Google 免費版特性），不影響使用。
- 單次執行上限 6 分鐘；因大量噪音信走規則、不呼叫 AI，你的日常信量綽綽有餘。
- 免費額度（Gemini 1500 次/天、UrlFetch 2 萬次/天）遠超所需。

---
> 本機 Python 版（`C:\AI\Gmail` 其餘檔案）仍可用，但雲端版不需電腦開機，建議以此為主。
