"""Gmail 機器人主程式。

用法：
  python main.py process     只讀信、分類、加標籤、備草稿（不出報告）
  python main.py morning     處理 + 寄「每日完整統整」(08:00)
  python main.py afternoon   處理 + 寄「白天進度快報」(17:00)
  python main.py night       處理 + 寄「當日收尾+明天注意」(22:30)
  python main.py weekly      處理 + 寄「本週總摘要+重要提醒」(每週五 22:30)
  python main.py setup-labels  只建立 🤖/ 標籤
  python main.py test          連線自我檢查（不改信箱）
"""
import sys
import logging
import json
from datetime import datetime, timezone

import config
import database as db
from gmail_client import GmailClient
from gemini_client import GeminiClient
import classifier
import reporter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(config.LOG_FILE, encoding="utf-8"),
              logging.StreamHandler()],
)
log = logging.getLogger("gmailbot")


def process_inbox(gmail, gemini, max_results=80):
    """讀取收件匣未處理的信，分類、加標籤、必要時備草稿與緊急提醒。"""
    msgs = gmail.list_inbox(query="in:inbox newer_than:3d", max_results=max_results)
    log.info("收件匣抓到 %d 封，開始處理新信…", len(msgs))
    new_count = 0
    for ref in msgs:
        mid = ref["id"]
        if db.is_processed(mid):
            continue
        try:
            mail = gmail.get_message(mid)
            # 略過機器人自己寄給自己的通知信（緊急提醒/每日報告/週報）。否則它們會被當新信重新
            # 分類，且報告裡的待辦會改帶「通知信」的 thread_id → 點待辦連結會跳到通知信而非來源信。
            if (mail.get("sender_email") or "").lower() == config.MY_EMAIL.lower():
                continue   # 不存檔，否則通知信本身會出現在報告分類統計裡
            result = classifier.classify(mail, gemini)
            cat = config.CATEGORY_BY_KEY[result["category"]]

            # 長信 TL;DR
            if len(mail["body"]) >= config.TLDR_MIN_CHARS and result.get("importance", 2) >= 3:
                try:
                    result["tldr"] = gemini.summarize_long(mail)
                except Exception as e:
                    log.warning("摘要失敗 %s", e)

            # 加標籤
            gmail.add_label(mid, cat["label"])

            # 備草稿：需回覆的真人信，或重要度 ≥ DRAFT_IMPORTANCE 的重要真人信
            # （重要但 AI 沒判「需回覆」也先備好，寧可多備不漏備；草稿絕不自動寄）。
            # 非真人信（電子報/no-reply）一律不備：回了也進黑洞，只會堆草稿垃圾。
            draft_id = None
            if result.get("is_real_person") and (
                result.get("needs_reply")
                or int(result.get("importance", 2)) >= config.DRAFT_IMPORTANCE
            ):
                try:
                    body = gemini.draft_reply(mail)
                    reply_to = mail["sender_email"]
                    subj = mail["subject"]
                    if not subj.lower().startswith("re:"):
                        subj = "Re: " + subj
                    draft_id = gmail.create_draft(reply_to, subj, body, thread_id=mail["thread_id"])
                    # 「需回覆」標籤只貼給真正 needs_reply 的信；重要度觸發的保留原分類標籤。
                    if result.get("needs_reply"):
                        gmail.add_label(mid, config.CATEGORY_BY_KEY["reply"]["label"])
                    log.info("已備草稿：%s", mail["subject"][:40])
                except Exception as e:
                    log.warning("草稿失敗 %s", e)

            rec = {
                "msg_id": mid, "thread_id": mail["thread_id"],
                "sender": mail["sender"], "sender_email": mail["sender_email"],
                "subject": mail["subject"], "date_utc": mail["date_utc"],
                "category": result["category"], "importance": int(result.get("importance", 2)),
                "is_real_person": int(bool(result.get("is_real_person"))),
                "needs_reply": int(bool(result.get("needs_reply"))),
                "is_urgent": int(bool(result.get("is_urgent"))),
                "language": result.get("language", "zh"),
                "tldr": result.get("tldr", ""), "todos": result.get("todos", []),
                "draft_id": draft_id, "alerted": 0,
                "classified_by": result.get("classified_by", "gemini"),
                "processed_at": datetime.now(timezone.utc).isoformat(),
            }
            db.save_message(rec)
            new_count += 1
        except Exception as e:
            log.exception("處理信件 %s 失敗：%s", mid, e)
            # 只有「所有備援模型都被限流/配額用完」(QUOTA) 才停掉整批；單封零星錯誤跳過續跑下一封。
            if "QUOTA" in str(e):
                log.warning("⚠️ Gemini 配額/限流：三個備援模型都滿了，已中止本輪。稍等 1–2 分鐘再跑即可（已處理的不會重做）。")
                break
    log.info("本輪新處理 %d 封。", new_count)
    return new_count


def send_urgent_alerts(gmail):
    urgent = db.get_unalerted_urgent()
    if not urgent or not config.ENABLE_URGENT_ALERT:
        return
    log.info("發現 %d 封緊急信，寄出即時提醒。", len(urgent))
    lines = ["<h3>🚨 緊急信提醒</h3><ul>"]
    for m in urgent:
        lines.append(f'<li><b>{m["subject"]}</b><br>'
                     f'<span style="color:#666">{m["sender_email"]}｜{m["tldr"]}</span></li>')
        db.mark_alerted(m["msg_id"])
    lines.append("</ul>")
    gmail.send_email(config.MY_EMAIL, f"🚨 緊急信 {len(urgent)} 封需注意", "\n".join(lines), html=True)


def refresh_followups(gmail):
    try:
        for f in gmail.find_unanswered_sent(config.FOLLOWUP_DAYS):
            db.upsert_followup(f["thread_id"], f["subject"], f["recipient"], f["sent_date"])
    except Exception as e:
        log.warning("跟催掃描失敗：%s", e)


def setup_labels(gmail):
    for c in config.CATEGORIES:
        gmail.ensure_label(c["label"])
        log.info("確保標籤：%s", c["label"])


def run(mode):
    db.init_db()
    gmail = GmailClient()
    if mode == "setup-labels":
        setup_labels(gmail)
        return
    gemini = GeminiClient()
    process_inbox(gmail, gemini)
    send_urgent_alerts(gmail)
    refresh_followups(gmail)
    if mode in ("morning", "afternoon", "night"):
        subj = reporter.send_report(gmail, mode)
        log.info("已寄出報告：%s", subj)
    elif mode == "weekly":
        subj = reporter.send_weekly_report(gmail, gemini)
        log.info("已寄出週報：%s", subj)


def test():
    print("檢查設定…")
    assert config.GEMINI_API_KEY, "❌ 缺 GEMINI_API_KEY"
    assert config.MY_EMAIL, "❌ 缺 MY_EMAIL"
    db.init_db()
    print("✅ .env 與資料庫 OK")
    gmail = GmailClient()
    profile = gmail.service.users().getProfile(userId="me").execute()
    print(f"✅ Gmail 連線 OK：{profile['emailAddress']}（共 {profile['messagesTotal']} 封）")
    gemini = GeminiClient()
    print("✅ Gemini 連線 OK：", gemini._generate("只回覆 OK 兩個字", "ping").strip()[:20])
    print("全部正常，可以排程了。")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "process"
    if mode == "test":
        test()
    elif mode in ("process", "morning", "afternoon", "night", "weekly", "setup-labels"):
        run(mode)
    else:
        print(__doc__)
        sys.exit(1)
