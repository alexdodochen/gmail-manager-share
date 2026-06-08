"""Gmail API 封裝：授權、抓信、加標籤、建草稿、寄報告、查跟催。"""
import base64
import os
import re
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.utils import parsedate_to_datetime

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

import config


class GmailClient:
    def __init__(self):
        self.service = self._authenticate()
        self._label_cache = None

    # ── 授權 ────────────────────────────────────────────
    def _authenticate(self):
        creds = None
        if os.path.exists(config.TOKEN_FILE):
            creds = Credentials.from_authorized_user_file(config.TOKEN_FILE, config.SCOPES)
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                if not os.path.exists(config.CREDENTIALS_FILE):
                    raise FileNotFoundError(
                        f"找不到 {config.CREDENTIALS_FILE}，請依 SETUP.md 從 Google Cloud 下載 OAuth 憑證。"
                    )
                flow = InstalledAppFlow.from_client_secrets_file(config.CREDENTIALS_FILE, config.SCOPES)
                creds = flow.run_local_server(port=0)
            os.makedirs(config.CRED_DIR, exist_ok=True)
            with open(config.TOKEN_FILE, "w", encoding="utf-8") as f:
                f.write(creds.to_json())
        return build("gmail", "v1", credentials=creds, cache_discovery=False)

    # ── 標籤 ────────────────────────────────────────────
    def _all_labels(self, refresh=False):
        if self._label_cache is None or refresh:
            res = self.service.users().labels().list(userId="me").execute()
            self._label_cache = {l["name"]: l["id"] for l in res.get("labels", [])}
        return self._label_cache

    def ensure_label(self, name):
        """取得標籤 id；不存在就建立（含巢狀 🤖/xxx）。"""
        labels = self._all_labels()
        if name in labels:
            return labels[name]
        body = {"name": name, "labelListVisibility": "labelShow",
                "messageListVisibility": "show"}
        created = self.service.users().labels().create(userId="me", body=body).execute()
        self._label_cache[name] = created["id"]
        return created["id"]

    def add_label(self, msg_id, label_name):
        label_id = self.ensure_label(label_name)
        self.service.users().messages().modify(
            userId="me", id=msg_id, body={"addLabelIds": [label_id]}
        ).execute()

    # ── 讀信 ────────────────────────────────────────────
    def list_inbox(self, query="in:inbox", max_results=80):
        msgs, token = [], None
        while len(msgs) < max_results:
            res = self.service.users().messages().list(
                userId="me", q=query, maxResults=min(100, max_results - len(msgs)),
                pageToken=token,
            ).execute()
            msgs.extend(res.get("messages", []))
            token = res.get("nextPageToken")
            if not token:
                break
        return msgs

    def get_message(self, msg_id):
        m = self.service.users().messages().get(userId="me", id=msg_id, format="full").execute()
        headers = {h["name"].lower(): h["value"] for h in m["payload"].get("headers", [])}
        sender = headers.get("from", "")
        body = self._extract_body(m["payload"])
        try:
            dt = parsedate_to_datetime(headers.get("date", ""))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            date_utc = dt.astimezone(timezone.utc).isoformat()
        except Exception:
            date_utc = datetime.now(timezone.utc).isoformat()
        return {
            "msg_id": m["id"],
            "thread_id": m["threadId"],
            "sender": sender,
            "sender_email": self._email_only(sender),
            "subject": headers.get("subject", "(無主旨)"),
            "to": headers.get("to", ""),
            "date_utc": date_utc,
            "snippet": m.get("snippet", ""),
            "body": body,
            "label_ids": m.get("labelIds", []),
        }

    @staticmethod
    def _email_only(sender):
        m = re.search(r"<([^>]+)>", sender)
        return (m.group(1) if m else sender).strip().lower()

    def _extract_body(self, payload):
        """遞迴抓 text/plain；沒有就退而求其次抓 html 去標籤。"""
        def walk(part):
            mime = part.get("mimeType", "")
            data = part.get("body", {}).get("data")
            if mime == "text/plain" and data:
                return self._decode(data)
            for sub in part.get("parts", []) or []:
                got = walk(sub)
                if got:
                    return got
            if mime == "text/html" and data:
                html = self._decode(data)
                return re.sub(r"<[^>]+>", " ", html)
            return ""
        text = walk(payload) or ""
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()[:8000]

    @staticmethod
    def _decode(data):
        return base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="replace")

    # ── 草稿 / 寄信 ─────────────────────────────────────
    def create_draft(self, to, subject, body, thread_id=None, in_reply_to=None):
        mime = MIMEText(body, "plain", "utf-8")
        mime["To"] = to
        mime["From"] = config.MY_EMAIL
        mime["Subject"] = subject
        if in_reply_to:
            mime["In-Reply-To"] = in_reply_to
            mime["References"] = in_reply_to
        raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
        message = {"raw": raw}
        if thread_id:
            message["threadId"] = thread_id
        draft = self.service.users().drafts().create(
            userId="me", body={"message": message}
        ).execute()
        return draft["id"]

    def send_email(self, to, subject, body, html=False):
        subtype = "html" if html else "plain"
        mime = MIMEText(body, subtype, "utf-8")
        mime["To"] = to
        mime["From"] = config.MY_EMAIL
        mime["Subject"] = subject
        raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
        return self.service.users().messages().send(
            userId="me", body={"raw": raw}
        ).execute()

    # ── 跟催：找我寄出、對方還沒回的 thread ───────────────
    def find_unanswered_sent(self, days):
        """回傳 [{thread_id, subject, recipient, sent_date}]：我最後一封寄出後對方未回。"""
        q = f"in:sent newer_than:{days + 21}d older_than:{days}d"
        sent = self.list_inbox(query=q, max_results=40)
        results = []
        seen = set()
        for s in sent:
            tid = s["threadId"]
            if tid in seen:
                continue
            seen.add(tid)
            thread = self.service.users().threads().get(userId="me", id=tid, format="metadata").execute()
            msgs = thread.get("messages", [])
            if not msgs:
                continue
            last = msgs[-1]
            last_from = next((h["value"] for h in last["payload"]["headers"]
                              if h["name"].lower() == "from"), "")
            # 最後一封還是我寄的 → 對方尚未回覆
            if config.MY_EMAIL.lower() in last_from.lower():
                hdrs = {h["name"].lower(): h["value"] for h in last["payload"]["headers"]}
                results.append({
                    "thread_id": tid,
                    "subject": hdrs.get("subject", "(無主旨)"),
                    "recipient": hdrs.get("to", ""),
                    "sent_date": hdrs.get("date", ""),
                })
        return results
