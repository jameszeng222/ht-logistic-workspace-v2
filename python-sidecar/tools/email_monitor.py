"""Read-only IMAP monitoring and lightweight logistics email extraction."""

from __future__ import annotations

import email
import imaplib
import re
from datetime import timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parsedate_to_datetime
from html import unescape
from typing import Any


ACTION_TERMS = (
    "action required", "delivery failed", "clearance", "customs", "on hold",
    "补充", "需要", "请协助", "失败", "未能", "清关", "扣关", "退运",
    "付款", "关税", "截止", "逾期", "异常", "无法派送", "联系收件人",
)
COMPLETED_TERMS = (
    "delivered", "completed", "resolved", "case closed", "已完成", "已签收",
    "已解决", "处理完成", "已收讫", "无需处理",
)
OBSERVE_TERMS = (
    "processing", "pending approval", "under review", "等待审批", "处理中",
    "审批中", "观察", "预计", "30-45", "30–45",
)


def decode_value(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def text_from_message(message: Message) -> str:
    plain: list[str] = []
    html: list[str] = []
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.get_content_disposition() == "attachment":
            continue
        content_type = part.get_content_type()
        if content_type not in {"text/plain", "text/html"}:
            continue
        try:
            payload = part.get_payload(decode=True) or b""
            charset = part.get_content_charset() or "utf-8"
            value = payload.decode(charset, errors="replace")
        except Exception:
            continue
        (plain if content_type == "text/plain" else html).append(value)
    text = "\n".join(plain or html)
    text = re.sub(r"<style\b[^>]*>.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<script\b[^>]*>.*?</script>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", unescape(text)).strip()


def _first_match(patterns: list[str], text: str) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.I)
        if match:
            return match.group(1).strip()
    return ""


def _received_at(message: Message) -> str:
    raw = message.get("Date")
    if not raw:
        return ""
    try:
        value = parsedate_to_datetime(raw)
        if value.tzinfo:
            value = value.astimezone(timezone.utc)
        return value.isoformat(timespec="minutes")
    except Exception:
        return decode_value(raw)


def analyze_message(raw_message: bytes, account: str, uid: int) -> dict[str, Any]:
    message = email.message_from_bytes(raw_message)
    subject = decode_value(message.get("Subject"))
    sender = decode_value(message.get("From"))
    recipient = decode_value(message.get("To"))
    body = text_from_message(message)
    combined = f"{subject} {body}"
    lowered = combined.lower()

    reference = _first_match([
        r"(?:ref(?:erence)?)[\s:#<\-]*([A-Z0-9-]{6,20})",
        r"参考号[\s:：#<\-]*([A-Z0-9-]{6,20})",
    ], combined)
    tracking = _first_match([
        r"(?:wb|awb|waybill|tracking(?:\s+number)?|dhl(?:\s+单号)?)[\s:：#-]*([0-9]{10})",
        r"(?:运单号|单号)[\s:：#-]*([0-9]{10})",
        r"\b([0-9]{10})\b",
    ], combined)
    if tracking == reference:
        tracking = ""

    deadline = _first_match([
        r"((?:20)?\d{2}-\d{1,2}-\d{1,2})",
        r"((?:20)?\d{2}/\d{1,2}/\d{1,2})",
        r"((?:20)?\d{2}年\d{1,2}月\d{1,2}日)",
        r"(\d{1,2}月\d{1,2}日)",
    ], combined)

    completed = any(term in lowered for term in COMPLETED_TERMS)
    action_required = any(term in lowered for term in ACTION_TERMS)
    observing = any(term in lowered for term in OBSERVE_TERMS)
    if completed:
        status = "已完成"
        attention = False
    elif action_required:
        status = "待处理"
        attention = True
    elif observing:
        status = "观察中"
        attention = True
    else:
        status = "待确认"
        attention = False

    if any(term in lowered for term in ("clearance", "customs", "清关", "扣关")):
        reason = "货件涉及清关或资料补充，需要确认是否会影响放行。"
        action = "核对邮件要求、货件资料和收件人信息，准备后回复 DHL。"
    elif any(term in lowered for term in ("delivery failed", "failed delivery", "派送失败", "无法派送", "联系收件人")):
        reason = "DHL 未能完成派送或联系收件人，货件可能被退回。"
        action = "尽快确认收件人的有效电话、邮箱和地址，并回复 DHL。"
    elif any(term in lowered for term in ("payment", "付款", "关税", "税金")):
        reason = "邮件涉及付款、税金或费用确认。"
        action = "核对金额和付款状态，保留凭证并确认 DHL 已收到。"
    elif any(term in lowered for term in ("return", "退运")):
        reason = "货件处于退运流程，需要持续跟进审批和时间节点。"
        action = "记录当前进度和预计周期，到期前主动向 DHL 复查。"
    elif observing:
        reason = "事项仍在处理中，需要在后续节点复查。"
        action = "保留邮件并按预计时间复查进展。"
    elif completed:
        reason = "邮件显示事项已完成，暂时无需进一步操作。"
        action = "归档留存即可。"
    else:
        reason = "DHL 相关邮件，尚未识别到明确的紧急处理要求。"
        action = "人工快速确认邮件内容后决定是否跟进。"

    summary_source = body or subject
    summary = summary_source[:260].strip()
    if len(summary_source) > 260:
        summary += "..."

    return {
        "account": account,
        "uid": uid,
        "receivedAt": _received_at(message),
        "from": sender,
        "to": recipient,
        "subject": subject or "（无主题）",
        "reference": reference,
        "tracking": tracking,
        "status": status,
        "attention": attention,
        "reason": reason,
        "summary": summary,
        "action": action,
        "deadline": deadline,
    }


def _raw_message(fetch_result: list[Any]) -> bytes:
    for item in fetch_result:
        if isinstance(item, tuple) and len(item) > 1 and isinstance(item[1], bytes):
            return item[1]
    return b""


def scan_account(config: dict[str, Any]) -> dict[str, Any]:
    account = str(config.get("email") or "").strip()
    password = str(config.get("password") or "")
    host = str(config.get("host") or "imap.exmail.qq.com").strip()
    port = int(config.get("port") or 993)
    mailbox = str(config.get("mailbox") or "INBOX")
    keywords = [str(value).lower() for value in config.get("keywords", ["dhl"]) if str(value).strip()]
    known = {int(value) for value in config.get("knownUids", []) if str(value).isdigit()}
    last_uid = int(config.get("lastUid") or 0)
    if not account or not password:
        raise ValueError("邮箱或客户端专用密码未配置")

    client: imaplib.IMAP4_SSL | None = None
    try:
        client = imaplib.IMAP4_SSL(host, port, timeout=30)
        client.login(account, password)
        status, _ = client.select(mailbox, readonly=True)
        if status != "OK":
            raise RuntimeError("无法以只读方式打开收件箱")
        status, data = client.uid("search", None, "ALL")
        if status != "OK":
            raise RuntimeError("无法读取邮件 UID")
        all_uids = [int(value) for value in (data[0] or b"").split() if value.isdigit()]
        highest_uid = max(all_uids, default=last_uid)
        candidates = sorted(
            set(all_uids[-100:]).union(uid for uid in all_uids if uid > last_uid),
            reverse=True,
        )[:250]
        candidates = [uid for uid in candidates if uid not in known]
        messages: list[dict[str, Any]] = []
        scanned: list[int] = []
        for uid in candidates:
            status, fetched = client.uid("fetch", str(uid), "(BODY.PEEK[HEADER])")
            if status != "OK":
                continue
            raw_header = _raw_message(fetched)
            if not raw_header:
                continue
            scanned.append(uid)
            parsed = email.message_from_bytes(raw_header)
            header_text = " ".join([
                decode_value(parsed.get("From")),
                decode_value(parsed.get("To")),
                decode_value(parsed.get("Cc")),
                decode_value(parsed.get("Subject")),
            ]).lower()
            if keywords and not any(keyword in header_text for keyword in keywords):
                continue
            status, fetched = client.uid("fetch", str(uid), "(BODY.PEEK[TEXT]<0.65536>)")
            raw_body = _raw_message(fetched) if status == "OK" else b""
            raw = raw_header + b"\r\n" + raw_body
            messages.append(analyze_message(raw, account, uid))
        return {
            "email": account,
            "status": "ok",
            "lastUid": highest_uid,
            "scannedUids": scanned,
            "messages": messages,
        }
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass


def scan_accounts(accounts: list[dict[str, Any]]) -> dict[str, Any]:
    results = []
    messages: list[dict[str, Any]] = []
    for account in accounts:
        email_address = str(account.get("email") or "")
        try:
            result = scan_account(account)
        except Exception as error:
            result = {
                "email": email_address,
                "status": "error",
                "error": str(error),
                "lastUid": int(account.get("lastUid") or 0),
                "scannedUids": [],
                "messages": [],
            }
        results.append({key: value for key, value in result.items() if key != "messages"})
        messages.extend(result.get("messages", []))
    messages.sort(key=lambda item: (item.get("receivedAt", ""), item.get("uid", 0)), reverse=True)
    return {"status": "ok", "accounts": results, "messages": messages}
