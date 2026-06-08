"""集中設定：15 類分類定義、規則式寄件者對應、執行參數。"""
import os
from dotenv import load_dotenv

load_dotenv()

# ── 基本路徑 ────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CRED_DIR = os.path.join(BASE_DIR, "credentials")
CREDENTIALS_FILE = os.path.join(CRED_DIR, "credentials.json")  # Google Cloud OAuth client
TOKEN_FILE = os.path.join(CRED_DIR, "token.json")              # 首次授權後自動產生
DB_FILE = os.path.join(BASE_DIR, "gmail_bot.db")
LOG_FILE = os.path.join(BASE_DIR, "gmail_bot.log")

# ── 環境變數 ────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
# 自動 fallback 模型鏈：第一順位用 GEMINI_MODEL，碰到 429/503 就依序往下換。
# 三個模型各有獨立免費配額，等於把額度疊起來用。可用 GEMINI_MODELS（逗號分隔）覆寫整條鏈。
_custom_chain = os.getenv("GEMINI_MODELS", "")
if _custom_chain:
    GEMINI_MODEL_CHAIN = [s.strip() for s in _custom_chain.split(",") if s.strip()]
else:
    _defaults = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"]
    GEMINI_MODEL_CHAIN = [GEMINI_MODEL] + [m for m in _defaults if m != GEMINI_MODEL]
MY_EMAIL = os.getenv("MY_EMAIL", "")
FOLLOWUP_DAYS = int(os.getenv("FOLLOWUP_DAYS", "4"))
TLDR_MIN_CHARS = int(os.getenv("TLDR_MIN_CHARS", "1500"))
ENABLE_URGENT_ALERT = os.getenv("ENABLE_URGENT_ALERT", "true").lower() == "true"

# Gmail OAuth scopes：讀信 + 改標籤 + 建草稿 + 寄報告
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
]

LABEL_PREFIX = "🤖"  # 機器人標籤都放在 🤖/ 之下，與你手動標籤互不干擾

# ── 15 類分類定義 ───────────────────────────────────────────
# key: 內部代號 | label: Gmail 子標籤名 | group: 報告分群 | emoji | desc: 給 Gemini 看的說明
CATEGORIES = [
    # A 群：要我動手（報告置頂）
    {"key": "reply",     "label": f"{LABEL_PREFIX}/需回覆",   "group": "A", "emoji": "🔴",
     "desc": "真人寄來、且明確需要我親自回覆的信（同事、合作者、學生、朋友的提問或請求）。不含系統自動信、電子報、純通知。"},
    {"key": "todo",      "label": f"{LABEL_PREFIX}/待辦",     "group": "A", "emoji": "🟠",
     "desc": "有具體該做的事或截止日：報名、申請、繳交、填表、投稿截止、補件、開會回覆出席等。"},
    {"key": "review",    "label": f"{LABEL_PREFIX}/論文審稿", "group": "A", "emoji": "📝",
     "desc": "期刊投稿/審稿相關：reviewer 邀請、審稿提醒、revision 要求、accept/reject/major-minor 決議、editor 來信。"},
    {"key": "booking",   "label": f"{LABEL_PREFIX}/訂位預約", "group": "A", "emoji": "📅",
     "desc": "餐廳訂位、診所/檢查預約、飯店、票券等預約確認或變更通知。"},

    # B 群：工作學術資訊
    {"key": "hosp_work", "label": f"{LABEL_PREFIX}/醫院工作", "group": "B", "emoji": "🏥",
     "desc": "臨床/科務實際工作：排班值班、會診、病人相關、科內行政交辦、研究計畫執行事務。"},
    {"key": "hosp_info", "label": f"{LABEL_PREFIX}/醫院通知", "group": "B", "emoji": "📢",
     "desc": "醫院公布欄/行政公告：組織異動、總務、人事、一般周知，無需我特別行動。"},
    {"key": "society",   "label": f"{LABEL_PREFIX}/學會",     "group": "B", "emoji": "🎓",
     "desc": "醫學會/學會：心臟學會(TSOC)、內科醫學會、CME/學分、講座、研討會、scholarship、選舉通知。"},
    {"key": "journal",   "label": f"{LABEL_PREFIX}/期刊",     "group": "B", "emoji": "📚",
     "desc": "期刊目次(TOC)、研究電子報、論文新刊通知、徵稿(call for abstracts)、醫學新知電子報。"},

    # C 群：財務 / 生活 / 噪音
    {"key": "salary",    "label": f"{LABEL_PREFIX}/薪水",     "group": "C", "emoji": "💰",
     "desc": "薪資、值班費、加班費、獎金、入帳通知、扣繳憑單等與我收入有關的信。"},
    {"key": "card",      "label": f"{LABEL_PREFIX}/消費通知", "group": "C", "emoji": "💳",
     "desc": "信用卡/簽帳卡單筆或彙整消費授權通知（純通知，非促銷）。"},
    {"key": "bill",      "label": f"{LABEL_PREFIX}/帳單",     "group": "C", "emoji": "🧾",
     "desc": "帳單、繳費、電子發票、發票中獎、保費、稅單等。"},
    {"key": "shopping",  "label": f"{LABEL_PREFIX}/購物",     "group": "C", "emoji": "📦",
     "desc": "網購訂單、出貨、物流、取貨、退款（蝦皮、Uber Eats、各電商）。"},
    {"key": "security",  "label": f"{LABEL_PREFIX}/帳號安全", "group": "C", "emoji": "🔐",
     "desc": "帳號登入/安全提醒、OAuth 授權、密碼、驗證碼、Google/GitHub 等系統安全通知。"},
    {"key": "promo",     "label": f"{LABEL_PREFIX}/促銷",     "group": "C", "emoji": "🏷️",
     "desc": "純廣告促銷：銀行貸款/信用卡優惠、百貨折扣、品牌行銷、投資講座推銷等。"},
    {"key": "news",      "label": f"{LABEL_PREFIX}/電子報",   "group": "C", "emoji": "📰",
     "desc": "非醫學的訂閱電子報/新聞（The Economist、財經、NGO 募款等）。"},
]
CATEGORY_BY_KEY = {c["key"]: c for c in CATEGORIES}
VALID_KEYS = [c["key"] for c in CATEGORIES]

# 報告分群標題
GROUP_TITLES = {
    "A": "🔴 要我動手",
    "B": "🟡 工作 / 學術",
    "C": "💰 財務 / 生活 / 其他",
}

# ── 規則式寄件者對應（命中就不呼叫 Gemini，省免費額度也更快）──
# (寄件 email 子字串 [, 主旨關鍵字]) -> 分類 key
# 主旨關鍵字為 None 表示只看寄件者；填字串則需主旨也含該字才命中。
SENDER_RULES = [
    # 薪水 / 入帳（成大醫院系統信，需先判斷再落到醫院通知）
    ("penet@mail.hosp.ncku.edu.tw", "入帳", "salary"),
    ("penet@mail.hosp.ncku.edu.tw", "值班費", "salary"),
    ("penet@mail.hosp.ncku.edu.tw", "加班費", "salary"),
    ("penet@mail.hosp.ncku.edu.tw", "公布欄", "hosp_info"),
    # 信用卡消費通知（換成你自己發卡行的通知寄件者）
    ("card-notify@your-bank.example", None, "card"),
    ("statement@your-bank.example", None, "card"),
    # 促銷（銀行/券商行銷信；換成你會收到的寄件者）
    ("edm@your-bank.example", None, "promo"),
    ("news-longchamp.com", None, "promo"),
    ("penpeer.co", None, "promo"),
    ("noreply@e.economist.com", None, "promo"),
    # 期刊 / 研究電子報
    ("notification.elsevier.com", None, "journal"),
    ("emails.bmj.com", None, "journal"),
    ("n.nejm.org", None, "journal"),
    ("heartemail.org", None, "journal"),
    ("acc.org", None, "journal"),
    ("cardiologytrials@substack.com", None, "journal"),
    ("sanfordguide.com", None, "journal"),
    # 學會 / CME
    ("tsoc.org.tw", None, "society"),
    # 帳單 / 發票
    ("einvoice.nat.gov.tw", None, "bill"),
    # 購物 / 物流
    ("shopee", None, "shopping"),
    ("uber.com", None, "shopping"),
    # 帳號安全 / 系統
    ("families-noreply@google.com", None, "security"),
    ("calendar-notification@google.com", None, "booking"),
    ("noreply@github.com", None, "security"),
    # 非醫學電子報
    ("newsletters@e.economist.com", None, "news"),
    ("greenpeace.org", None, "news"),
]
