"""免費 Gemini API 封裝：分類、抽待辦/截止、長信摘要、生成回覆草稿。"""
import json
import time

from google import genai
from google.genai import types

import config

_CLASSIFY_INSTRUCTION = """你是一位協助成大醫院心臟內科醫師整理 Gmail 的助理。
請閱讀單封 email，輸出 JSON。分類務必從下列代號擇一（category）：
{cats}

判斷準則：
- is_real_person：寄件者是真人本人手打的信（非系統自動、非電子報、非群發通知）→ true。
- needs_reply：此信明確需要醫師「親自回覆」才算 true（被問問題、被請託、要確認出席）。純通知/報名連結不算。
- is_urgent：時間緊迫且重要（今明兩天的會議/排班變動、急事請託、當天截止）→ true。
- importance：1~5，5 最重要（病人安全、上級交辦、accept/reject、薪資異常屬高分；促銷電子報屬 1）。
- tldr：用繁體中文 1~2 句講重點。
- todos：抽出「該做的事」陣列，每項 {{"task": "...", "due": "YYYY-MM-DD 或 空字串"}}；沒有就空陣列。
- intro：一句繁體中文，向醫師「介紹」這封信是什麼、為何分這類（報告會用到）。
只輸出 JSON，不要多餘文字。"""

_DRAFT_INSTRUCTION = """你是成大醫院心臟內科醫師的 email 助理。
請依來信內容，用「與來信相同的語言」起草一封得體、專業、簡潔的回覆。
- 語氣：禮貌、專業、適度親切；中文用繁體。
- 若資訊不足，保留 [括號] 佔位讓醫師補。
- 只輸出信件正文，不要主旨、不要解釋。"""


class GeminiClient:
    def __init__(self):
        if not config.GEMINI_API_KEY:
            raise ValueError("缺少 GEMINI_API_KEY，請在 .env 填入（https://aistudio.google.com/apikey）。")
        self.client = genai.Client(api_key=config.GEMINI_API_KEY)
        self.model = config.GEMINI_MODEL
        self.model_chain = config.GEMINI_MODEL_CHAIN

    def _generate(self, instruction, content, as_json=False):
        """依模型鏈自動 fallback：429(配額/RPM)直接換下一個模型；503(忙碌)退避重試一次再換。
        整條鏈最多跑 2 輪：第 1 輪全部 429 時等 20 秒再整輪重試一次（救每分鐘 RPM 暫時性限流），
        第 2 輪仍全爆才丟 QUOTA。夾雜其他錯則放棄這封。"""
        cfg = types.GenerateContentConfig(
            system_instruction=instruction,
            temperature=0.3,
            response_mime_type="application/json" if as_json else "text/plain",
        )
        for round_ in range(2):
            ok, text, all_quota, last_err = self._try_chain(content, cfg)
            if ok:
                return text
            if not all_quota:
                raise last_err if last_err else RuntimeError("Gemini 失敗")
            if round_ == 0:
                time.sleep(20)
                continue
            raise RuntimeError("QUOTA 所有 Gemini 模型都被限流/配額用完：" + str(last_err)[:150])

    def _try_chain(self, content, cfg):
        """依序試整條模型鏈。回 (ok, text, all_quota, last_err)。
        all_quota=True 代表每個模型都因 429 失敗（值得等一下重試）。"""
        last_err = None
        quota_count = 0
        for mi, model in enumerate(self.model_chain):
            for attempt in range(2):  # 每個模型最多試 2 次（為 503 退避）
                try:
                    resp = self.client.models.generate_content(
                        model=model, contents=content, config=cfg
                    )
                    if mi > 0:
                        import logging
                        logging.getLogger("gmailbot").info("（已自動切換至備援模型 %s）", model)
                    return True, resp.text, False, None
                except Exception as e:
                    last_err = e
                    msg = str(e).lower()
                    if "429" in msg or "resource_exhausted" in msg or "quota" in msg:
                        quota_count += 1
                        break  # 此模型配額用完 → 換下一個模型
                    if "503" in msg or "unavailable" in msg or "overloaded" in msg:
                        if attempt == 0:
                            time.sleep(2)
                            continue  # 退避後重試同一模型一次
                        break  # 仍忙碌 → 換下一個模型
                    break  # 其他錯誤 → 換下一個模型
        return False, None, quota_count >= len(self.model_chain), last_err

    def classify(self, mail):
        cats = "\n".join(f"- {c['key']}: {c['desc']}" for c in config.CATEGORIES)
        instruction = _CLASSIFY_INSTRUCTION.format(cats=cats)
        content = (
            f"寄件者：{mail['sender']}\n"
            f"主旨：{mail['subject']}\n"
            f"收件：{mail.get('to','')}\n"
            f"內文（節錄）：\n{mail['body'][:4000]}"
        )
        raw = self._generate(instruction, content, as_json=True)
        data = self._safe_json(raw)
        if data.get("category") not in config.VALID_KEYS:
            data["category"] = "hosp_info"  # 保底，避免壞掉
        data.setdefault("importance", 2)
        data.setdefault("is_real_person", False)
        data.setdefault("needs_reply", False)
        data.setdefault("is_urgent", False)
        data.setdefault("tldr", mail.get("snippet", "")[:120])
        data.setdefault("todos", [])
        data.setdefault("intro", data["tldr"])
        return data

    def summarize_long(self, mail):
        instruction = "你是醫師的閱讀助理，請用繁體中文 3 行條列重點摘要這封長信。只輸出條列，不要前言。"
        return self._generate(instruction, mail["body"][:7000]).strip()

    def draft_reply(self, mail):
        content = (
            f"來信寄件者：{mail['sender']}\n"
            f"主旨：{mail['subject']}\n"
            f"內文：\n{mail['body'][:5000]}"
        )
        return self._generate(_DRAFT_INSTRUCTION, content).strip()

    def weekly_digest(self, records):
        """把過去一週的重要信件清單交給 Gemini，統整成『本週重點 / 下週注意』。"""
        import json as _json
        picked = []
        for m in records:
            has_todo = bool(_json.loads(m.get("todos") or "[]")) if not isinstance(m.get("todos"), list) else bool(m.get("todos"))
            if (m.get("category") == "reply" or m.get("needs_reply") or m.get("is_urgent")
                    or int(m.get("importance") or 0) >= 3 or has_todo):
                picked.append(m)
            if len(picked) >= 60:
                break
        if not picked:
            return ""
        lines = []
        for m in picked:
            c = config.CATEGORY_BY_KEY.get(m.get("category"), {})
            label = (c.get("label") or m.get("category", "")).split("/")[-1]
            lines.append(f"- [{label}｜重要度{m.get('importance')}] "
                         f"{(m.get('subject') or '')[:80]}：{(m.get('tldr') or '')[:100]}")
        instruction = (
            "你是成大醫院心臟內科醫師的一週秘書。以下是這位醫師過去一週收到、已分類的重要信件清單。"
            "請用繁體中文，幫他統整成「本週重點」與「下週該注意」兩段條列（各 3~6 點），"
            "聚焦：需回覆的人事、截止日/待辦、審稿/投稿進度、醫院與學會重要事項、財務異常。"
            "語氣精簡專業，不要寒暄、不要逐封重述，只給洞見與提醒。"
        )
        return self._generate(instruction, "本週信件清單：\n" + "\n".join(lines)).strip()

    @staticmethod
    def _safe_json(raw):
        raw = (raw or "").strip()
        if raw.startswith("```"):
            raw = raw.strip("`")
            raw = raw[raw.find("{"):]
        try:
            return json.loads(raw)
        except Exception:
            start, end = raw.find("{"), raw.rfind("}")
            if start >= 0 and end > start:
                try:
                    return json.loads(raw[start:end + 1])
                except Exception:
                    pass
        return {}
