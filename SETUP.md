# Gmail 機器人 — 安裝設定指南（照著做一次即可）

全程約 20 分鐘。完成後機器人會在每天 **08:00 / 17:00 / 22:30** 自動跑。

---

## 步驟 1：安裝 Python 套件

開 PowerShell，切到本資料夾 `C:\AI\Gmail`：

```powershell
cd C:\AI\Gmail
python -m venv venv                 # 建虛擬環境（建議）
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

> 若 `Activate.ps1` 被擋，先執行一次：
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

---

## 步驟 2：申請免費 Gemini API Key

1. 到 **https://aistudio.google.com/apikey** （用你的 Google 帳號登入）
2. 按「Create API key」→ 複製金鑰
3. 把專案裡的 `.env.example` 複製成 `.env`，填入：

```
GEMINI_API_KEY=貼上你的金鑰
MY_EMAIL=your_email@gmail.com
```

> 免費層 `gemini-2.5-flash` 每天約 1500 次請求，你的信量綽綽有餘。

---

## 步驟 3：開啟 Gmail API、下載 OAuth 憑證

1. 到 **https://console.cloud.google.com/** → 建立一個新專案（例：`gmail-bot`）
2. 左側「API 和服務」→「啟用 API 和服務」→ 搜尋 **Gmail API** → 啟用
3. 「OAuth 同意畫面」→ 選 **External** → 填 App 名稱、你的 email → 在「Test users」加入你自己的 Gmail
4. 「憑證」→「建立憑證」→ **OAuth 用戶端 ID** → 應用程式類型選 **桌面應用程式**
5. 下載 JSON，改名為 **`credentials.json`**，放到 `C:\AI\Gmail\credentials\` 資料夾內

```
C:\AI\Gmail\credentials\credentials.json   ← 放這裡
```

---

## 步驟 4：首次授權 + 自我檢查

```powershell
python main.py test
```

- 第一次會跳出瀏覽器要你登入 Google 並同意授權 → 同意後會自動產生 `credentials\token.json`
- 看到三個 ✅（.env / Gmail / Gemini 連線）就成功了

---

## 步驟 5：建立標籤 + 跑一次看看

```powershell
python main.py setup-labels      # 在 Gmail 建立 🤖/ 系列標籤
python main.py morning           # 實跑一次：分類、加標籤、備草稿、寄一份報告給自己
```

去 Gmail 看：信件被加上 `🤖/期刊`、`🤖/薪水`… 標籤，且收到一封統整報告。

---

## 步驟 6：設定每天自動執行（Windows 工作排程器）

以**系統管理員**開 PowerShell：

```powershell
cd C:\AI\Gmail
.\register_tasks.ps1
```

完成！會建立 3 個排程工作：
| 工作 | 時間 | 內容 |
|---|---|---|
| `GmailBot_Morning` | 08:00 | 每日完整統整（昨 0800→今 0800） |
| `GmailBot_Afternoon` | 17:00 | 白天進度快報 |
| `GmailBot_Night` | 22:30 | 當日收尾＋明天注意 |

> 電腦關機時段會跳過，開機後若錯過會自動補跑一次。
> 要移除排程：`.\register_tasks.ps1 -Remove`

---

## 日常使用

- **草稿**：需你回覆的真人信，草稿已備在 Gmail 草稿匣，過目後送出即可（機器人不會自動寄）。
- **報告**：三個時段會寄 email 給自己。
- **調整**：分類規則在 `config.py` 的 `SENDER_RULES`；門檻在 `.env`。
- **隨時手動跑**：`python main.py process`（只整理不出報告）。

## 疑難排解
- 額度不足 (429)：把 `.env` 的 `GEMINI_MODEL` 改成 `gemini-2.0-flash`。
- 要重新授權：刪掉 `credentials\token.json` 再 `python main.py test`。
- 看紀錄：`gmail_bot.log`。
