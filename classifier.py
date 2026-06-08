"""混合式分類：先用規則命中常見寄件者（省 Gemini 額度），其餘交給 Gemini。"""
import config


def rule_classify(mail):
    """命中回傳 category key；未命中回傳 None。"""
    sender = mail["sender_email"].lower()
    sender_full = mail["sender"].lower()
    subject = mail["subject"].lower()
    for rule in config.SENDER_RULES:
        needle, kw, cat = rule
        needle = needle.lower()
        if needle in sender or needle in sender_full:
            if kw is None or kw.lower() in subject:
                return cat
    return None


# 規則命中的這些類別屬「純通知/噪音」，不必再花 Gemini 做深判斷
_LOW_VALUE_CATS = {"card", "promo", "news", "shopping", "bill", "security"}


def classify(mail, gemini):
    """
    回傳分類結果 dict。策略：
      1. 規則命中且屬低價值通知 → 直接用規則結果，不呼叫 Gemini。
      2. 規則命中但屬可能要動作的類（薪水/醫院/學會/期刊）→ 用規則類別，
         但仍輕量補 tldr/todos（呼叫 Gemini）。
      3. 規則沒命中 → 完全交給 Gemini。
    """
    rule_cat = rule_classify(mail)

    if rule_cat and rule_cat in _LOW_VALUE_CATS:
        cat = config.CATEGORY_BY_KEY[rule_cat]
        return {
            "category": rule_cat,
            "importance": 1,
            "is_real_person": False,
            "needs_reply": False,
            "is_urgent": False,
            "language": "zh",
            "tldr": mail.get("snippet", "")[:120],
            "todos": [],
            "intro": f"{cat['emoji']} {cat['label']}（規則自動歸類）：{mail['subject'][:60]}",
            "classified_by": "rule",
        }

    # 其餘一律問 Gemini（含規則命中的高價值類別，讓它補 tldr/todos/intro 並校正）
    data = gemini.classify(mail)
    data["classified_by"] = "gemini"
    # 若規則對高價值類別有強意見，且 Gemini 落在噪音類，採信規則
    if rule_cat and rule_cat not in _LOW_VALUE_CATS and data["category"] in _LOW_VALUE_CATS:
        data["category"] = rule_cat
    data.setdefault("language", "zh")
    return data
