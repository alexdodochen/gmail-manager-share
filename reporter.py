"""產生三時段統整報告（HTML email 寄給自己）。"""
import json
from datetime import datetime, timedelta, timezone

import config
import database as db

TZ = timezone(timedelta(hours=8))  # 台灣時間


def _now():
    return datetime.now(TZ)


def _window(mode, now):
    """回傳 (start, end, 標題)。"""
    today_8 = now.replace(hour=8, minute=0, second=0, microsecond=0)
    if mode == "morning":      # 08:00 主報告：昨 0800 → 今 0800
        return today_8 - timedelta(days=1), today_8, "🌅 每日完整統整（昨日 08:00 → 今日 08:00）"
    if mode == "afternoon":    # 17:00：今 0800 → 現在
        return today_8, now, "☀️ 白天進度快報（今日 08:00 → 17:00）"
    # night 22:30：今 0800 → 現在 + 明日注意
    return today_8, now, "🌙 當日收尾（今日 08:00 → 22:30）＋明天注意"


def _esc(s):
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# 報告中視為「噪音／不需處理」的類別：收合成一行數字，不逐封列出
LOW_VALUE_REPORT = {"promo", "news", "shopping", "card", "bill", "security"}


def _mail_url(thread_id):
    return f"https://mail.google.com/mail/u/0/#all/{thread_id}"


def _link(thread_id, inner):
    # 手機深連結走不通，報告只保留桌機可點標題（見 memory/gmail-mobile-deeplink-dead-end.md）。
    if not thread_id:
        return inner
    return f'<a href="{_mail_url(thread_id)}" style="color:#1a73e8;text-decoration:none">{inner}</a>' 


def _stars(imp):
    return "⭐" * max(0, int(imp or 0) - 3)


def build_report(mode):
    now = _now()
    start, end, title = _window(mode, now)
    msgs = db.get_messages_between(start.astimezone(timezone.utc).isoformat(),
                                   end.astimezone(timezone.utc).isoformat())

    # 依分群與類別整理
    by_cat = {}
    for m in msgs:
        by_cat.setdefault(m["category"], []).append(m)

    # 待辦/截止彙整（含 thread_id 以便點擊）
    todos = []
    for m in msgs:
        for t in json.loads(m.get("todos") or "[]"):
            if t.get("task"):
                todos.append({"task": t["task"], "due": t.get("due", ""),
                              "subject": m["subject"], "thread_id": m.get("thread_id")})
    todos.sort(key=lambda x: (x["due"] == "", x["due"]))

    # 要動手的真人信（依重要度）
    action = sorted([m for m in msgs if m["category"] == "reply" or m["needs_reply"]],
                    key=lambda m: -int(m["importance"]))
    drafted = [m for m in action if m["draft_id"]]

    # 重點信件：重要度 ≥ 3、非需回覆、非噪音 → 依重要度
    highlights = sorted(
        [m for m in msgs if not (m["category"] == "reply" or m["needs_reply"])
         and int(m["importance"]) >= 3 and m["category"] not in LOW_VALUE_REPORT],
        key=lambda m: -int(m["importance"]))

    html = [f"""<div style="font-family:-apple-system,'Microsoft JhengHei',sans-serif;max-width:680px;margin:auto;color:#222">
<h2 style="margin-bottom:4px">{_esc(title)}</h2>
<div style="color:#888;font-size:13px">產生時間 {now.strftime('%Y-%m-%d %H:%M')}　共處理 {len(msgs)} 封　（點標題可直接開信）</div>
<hr style="border:none;border-top:1px solid #eee">"""]

    if not action and not highlights and not todos:
        html.append('<p style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:8px;padding:12px">'
                    '✅ 本時段沒有需要你處理的重要信件，其餘皆為通知類已自動歸檔。</p>')

    # 1) 需要你回覆（可點擊、依重要度）
    if action:
        html.append('<h3>🔴 需要你回覆</h3><ul>')
        for m in action:
            tag = '　<span style="color:#0a7">✅ 已備草稿</span>' if m["draft_id"] else ''
            html.append(f'<li>{_stars(m["importance"])}{_link(m.get("thread_id"), f"<b>{_esc(m['subject'])}</b>")}<br>'
                        f'<span style="color:#666;font-size:13px">{_esc(m["sender_email"])}｜{_esc(m["tldr"])}</span>{tag}</li>')
        html.append('</ul>')
        if drafted:
            html.append(f'<p style="font-size:13px;color:#0a7">📝 已在草稿匣備好 {len(drafted)} 封回覆草稿，請過目後送出。</p>')

    # 2) 重點信件（依重要性）
    if highlights:
        html.append('<h3>⭐ 重點信件（依重要性）</h3><ul>')
        for m in highlights[:10]:
            c = config.CATEGORY_BY_KEY.get(m["category"], {})
            html.append(f'<li>{_stars(m["importance"])}{c.get("emoji","")} '
                        f'{_link(m.get("thread_id"), f"<b>{_esc(m['subject'])[:60]}</b>")} '
                        f'<span style="color:#888;font-size:12px">— {_esc(m["sender_email"])}</span><br>'
                        f'<span style="color:#666;font-size:13px">{_esc(m["tldr"])[:90]}</span></li>')
        html.append('</ul>')

    # 3) 待辦 / 截止日（可點擊）
    if todos:
        html.append('<h3>🟠 待辦 / 截止日</h3><ul>')
        for t in todos[:15]:
            due = f'<b style="color:#c00">[{_esc(t["due"])}]</b> ' if t["due"] else ''
            html.append(f'<li>{due}{_link(t.get("thread_id"), _esc(t["task"]))}'
                        f'　<span style="color:#888;font-size:12px">— {_esc(t["subject"])[:40]}</span></li>')
        html.append('</ul>')

    # 4) 分群分類：高價值展開（依重要度），噪音收合
    for grp in ("A", "B", "C"):
        grp_cats = [c for c in config.CATEGORIES if c["group"] == grp and c["key"] in by_cat]
        if not grp_cats:
            continue
        rich = [c for c in grp_cats if c["key"] not in LOW_VALUE_REPORT]
        noise = [c for c in grp_cats if c["key"] in LOW_VALUE_REPORT]
        html.append(f'<h3>{_esc(config.GROUP_TITLES[grp])}</h3>')
        for c in rich:
            items = sorted(by_cat[c["key"]], key=lambda m: -int(m["importance"]))
            html.append(f'<details open><summary style="cursor:pointer;font-weight:bold">{c["emoji"]} {_esc(c["label"].split("/")[-1])}（{len(items)}）</summary><ul style="margin-top:4px">')
            for m in items[:8]:
                html.append(f'<li>{_stars(m["importance"])}{_link(m.get("thread_id"), f"<b>{_esc(m['subject'])[:60]}</b>")} '
                            f'<span style="color:#888;font-size:12px">— {_esc(m["sender_email"])}</span>'
                            f'<br><span style="color:#666;font-size:13px">{_esc(m["tldr"])[:90]}</span></li>')
            if len(items) > 8:
                html.append(f'<li style="color:#888">…還有 {len(items)-8} 封</li>')
            html.append('</ul></details>')
        if noise:
            parts = "　｜　".join(f'{c["emoji"]}{_esc(c["label"].split("/")[-1])} {len(by_cat[c["key"]])}' for c in noise)
            html.append(f'<p style="font-size:13px;color:#999;background:#fafafa;padding:8px 10px;border-radius:8px">'
                        f'🔕 其他通知（已歸檔、不需處理）：{parts}</p>')

    # 5) 跟催提醒（可點擊）
    fu = db.get_pending_followups()
    if fu:
        html.append('<h3>⏰ 跟催提醒（你寄出後對方還沒回）</h3><ul>')
        for f in fu[:10]:
            html.append(f'<li>{_link(f.get("thread_id"), f"<b>{_esc(f['subject'])[:60]}</b>")} → {_esc(f["recipient"])[:40]}'
                        f'<span style="color:#888;font-size:12px">（{_esc(f["sent_date"])[:16]}）</span></li>')
        html.append('</ul>')

    # 6) 夜間：明天注意
    if mode == "night":
        tmr = (now + timedelta(days=1)).strftime("%Y-%m-%d")
        tmr_todos = [t for t in todos if t["due"] and t["due"] <= tmr]
        html.append('<h3>📌 明天注意</h3>')
        if tmr_todos:
            html.append('<ul>' + ''.join(
                f'<li><b style="color:#c00">[{_esc(t["due"])}]</b> {_link(t.get("thread_id"), _esc(t["task"]))}</li>' for t in tmr_todos
            ) + '</ul>')
        else:
            html.append('<p style="color:#888">目前沒有明天到期的待辦 👍</p>')

    html.append('<hr style="border:none;border-top:1px solid #eee"><div style="color:#aaa;font-size:12px">🤖 Gmail 助理自動生成</div></div>')
    return title, "\n".join(html)


def send_report(gmail, mode):
    title, html = build_report(mode)
    subject = f"📬 {title}　{_now().strftime('%m/%d %H:%M')}"
    gmail.send_email(config.MY_EMAIL, subject, html, html=True)
    return subject


def build_weekly_report(gemini=None):
    """每週五 22:30：過去 7 天總摘要 ＋ 重要提醒 highlight。"""
    now = _now()
    start = now - timedelta(days=7)
    msgs = db.get_messages_between(start.astimezone(timezone.utc).isoformat(),
                                   now.astimezone(timezone.utc).isoformat())

    by_cat = {}
    for m in msgs:
        by_cat.setdefault(m["category"], []).append(m)

    action = sorted([m for m in msgs if m["category"] == "reply" or m["needs_reply"]],
                    key=lambda m: -int(m["importance"]))
    drafted = [m for m in action if m["draft_id"]]
    urgent = [m for m in msgs if m["is_urgent"]]
    important = sorted([m for m in msgs if int(m["importance"]) >= 4 and m["category"] not in LOW_VALUE_REPORT],
                       key=lambda m: -int(m["importance"]))

    todos = []
    for m in msgs:
        for t in json.loads(m.get("todos") or "[]"):
            if t.get("task"):
                todos.append({"task": t["task"], "due": t.get("due", ""),
                              "subject": m["subject"], "thread_id": m.get("thread_id")})
    todos.sort(key=lambda x: (x["due"] == "", x["due"]))

    fu = db.get_pending_followups()

    ai_summary = ""
    if gemini is not None:
        try:
            ai_summary = gemini.weekly_digest(msgs)
        except Exception:
            ai_summary = ""

    title = f"📅 本週總摘要（{start.strftime('%m/%d')} → {now.strftime('%m/%d')}）"
    html = [f"""<div style="font-family:-apple-system,'Microsoft JhengHei',sans-serif;max-width:680px;margin:auto;color:#222">
<h2 style="margin-bottom:4px">{_esc(title)}</h2>
<div style="color:#888;font-size:13px">產生時間 {now.strftime('%Y-%m-%d %H:%M')}　本週共處理 {len(msgs)} 封</div>"""]

    # ── 重要提醒 highlight（置頂醒目框）──
    hl = []
    if action:
        hl.append(f"🔴 <b>{len(action)}</b> 封需回覆" + (f"（已備 {len(drafted)} 封草稿）" if drafted else ""))
    due_todos = [t for t in todos if t["due"]]
    if due_todos:
        hl.append(f"🟠 <b>{len(due_todos)}</b> 項有截止日待辦")
    if urgent:
        hl.append(f"🚨 <b>{len(urgent)}</b> 封緊急信")
    if fu:
        hl.append(f"⏰ <b>{len(fu)}</b> 封寄出未獲回覆")
    if hl:
        html.append('<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:10px;padding:12px 14px;margin:12px 0">'
                    '<div style="font-weight:bold;margin-bottom:6px">⚡ 本週重要提醒</div>'
                    f'<div style="font-size:14px;line-height:1.9">{"　｜　".join(hl)}</div></div>')

    # ── Gemini 本週重點 ──
    if ai_summary:
        html.append('<h3>⭐ 本週重點（AI 統整）</h3>')
        html.append('<div style="font-size:14px;line-height:1.8;white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:8px">'
                    f'{_esc(ai_summary)}</div>')

    # ── 需回覆（可點擊、依重要度）──
    if action:
        html.append('<h3>🔴 需要你回覆</h3><ul>')
        for m in action:
            tag = '　<span style="color:#0a7">✅ 已備草稿</span>' if m["draft_id"] else ''
            html.append(f'<li>{_stars(m["importance"])}{_link(m.get("thread_id"), f"<b>{_esc(m['subject'])}</b>")}<br>'
                        f'<span style="color:#666;font-size:13px">{_esc(m["sender_email"])}｜{_esc(m["tldr"])}</span>{tag}</li>')
        html.append('</ul>')

    # ── 待辦 / 截止（可點擊）──
    if todos:
        html.append('<h3>🟠 待辦 / 截止日</h3><ul>')
        for t in todos[:20]:
            due = f'<b style="color:#c00">[{_esc(t["due"])}]</b> ' if t["due"] else ''
            html.append(f'<li>{due}{_link(t.get("thread_id"), _esc(t["task"]))}　<span style="color:#888;font-size:12px">— {_esc(t["subject"])[:40]}</span></li>')
        html.append('</ul>')

    # ── 本週重要事件（重要度 ≥ 4，依重要度、可點擊）──
    if important:
        html.append('<h3>⭐ 本週重要事件</h3><ul>')
        for m in important[:15]:
            c = config.CATEGORY_BY_KEY.get(m["category"], {})
            html.append(f'<li>{_stars(m["importance"])}{c.get("emoji","")} {_link(m.get("thread_id"), f"<b>{_esc(m['subject'])[:60]}</b>")} '
                        f'<span style="color:#888;font-size:12px">— {_esc(m["sender_email"])}</span><br>'
                        f'<span style="color:#666;font-size:13px">{_esc(m["tldr"])[:100]}</span></li>')
        html.append('</ul>')

    # ── 跟催（可點擊）──
    if fu:
        html.append('<h3>⏰ 跟催提醒（你寄出後對方還沒回）</h3><ul>')
        for f in fu[:15]:
            html.append(f'<li>{_link(f.get("thread_id"), f"<b>{_esc(f['subject'])[:60]}</b>")} → {_esc(f["recipient"])[:40]}'
                        f'<span style="color:#888;font-size:12px">（{_esc(f["sent_date"])[:16]}）</span></li>')
        html.append('</ul>')

    # ── 本週分類統計 ──
    if by_cat:
        counts = " ｜ ".join(
            f"{config.CATEGORY_BY_KEY[k]['emoji']}{config.CATEGORY_BY_KEY[k]['label'].split('/')[-1]} {len(v)}"
            for k, v in sorted(by_cat.items(), key=lambda kv: -len(kv[1])) if k in config.CATEGORY_BY_KEY
        )
        html.append('<h3>📊 本週分類統計</h3>')
        html.append(f'<p style="font-size:13px;background:#f6f8fa;padding:10px;border-radius:8px">{_esc(counts)}</p>')

    html.append('<hr style="border:none;border-top:1px solid #eee"><div style="color:#aaa;font-size:12px">🤖 Gmail 助理 — 每週五自動生成</div></div>')
    return title, "\n".join(html)


def send_weekly_report(gmail, gemini=None):
    title, html = build_weekly_report(gemini)
    subject = f"📅 {title}　{_now().strftime('%m/%d %H:%M')}"
    gmail.send_email(config.MY_EMAIL, subject, html, html=True)
    return subject
