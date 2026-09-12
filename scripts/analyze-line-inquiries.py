#!/usr/bin/env python3
"""Convert LINE Official Account CSV exports into privacy-minimized inquiry cases."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

JST = timezone(timedelta(hours=9))
VERSION = "rules-v1"
CATEGORIES: list[tuple[str, tuple[str, ...]]] = [
    ("権利侵害・法務", ("権利侵害", "著作権", "商標", "知的財産", "内容証明", "弁護士", "法的措置", "訴訟", "警告書")),
    ("破産・債務・廃業", ("自己破産", "破産", "倒産", "債務整理", "債務", "廃業")),
    ("税務・確定申告", ("確定申告", "消費税", "インボイス", "税理士", "税務", "税金", "納税")),
    ("事務所への電話", ("事務所へ電話", "事務所に電話", "事務所から電話", "着信", "折り返し", "代表番号")),
    ("契約・退会", ("退会", "解約", "休会", "契約解除", "契約終了", "契約")),
    ("請求・支払い", ("請求書", "請求", "支払い", "支払", "入金", "振込", "決済", "未払い")),
    ("受注・配送・返品", ("返品", "返金", "発送", "配送", "注文", "受注", "キャンセル", "届か")),
    ("広告・集客", ("広告", "集客", "アクセス", "流入", "販促", "クーポン")),
    ("モール・アカウント", ("楽天", "Yahoo", "Amazon", "メルカリ", "ログイン", "パスワード", "アカウント", "認証")),
    ("商品登録・店舗運用", ("商品登録", "出品", "在庫", "価格変更", "商品画像", "商品ページ", "ショップ運営", "店舗運営")),
    ("システム・操作", ("操作方法", "エラー", "不具合", "表示され", "できません", "やり方", "設定方法")),
]
RESOLVED_WORDS = ("解決しました", "解決いたしました", "確認できました", "問題ありません", "完了しました", "ありがとうございます")


@dataclass(frozen=True)
class Message:
    customer_number: str
    sender: str
    at: datetime
    content: str
    source_digest: str


@dataclass
class Episode:
    customer_number: str
    opened_at: datetime
    last_at: datetime
    source_digests: list[str] = field(default_factory=list)
    incoming: list[str] = field(default_factory=list)
    outgoing: list[str] = field(default_factory=list)


def redact(text: str, limit: int = 500) -> str:
    text = re.sub(r"https?://\S+", "[URL]", text, flags=re.I)
    text = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[メール]", text, flags=re.I)
    text = re.sub(r"(?:\+?81[-\s]?)?0\d{1,4}[-\s]\d{1,4}[-\s]\d{3,4}", "[電話番号]", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def customer_number(filename: str) -> str:
    matches = re.findall(r"(?<!\d)(\d{3,4})(?!\d)", filename)
    if matches:
        return matches[-1]
    return "不明-" + hashlib.sha256(filename.encode("utf-8", errors="replace")).hexdigest()[:8]


def read_messages(zip_path: Path) -> list[Message]:
    messages: dict[str, Message] = {}
    with zipfile.ZipFile(zip_path) as archive:
        files = sorted(
            (item for item in archive.infolist() if not item.is_dir() and item.filename.lower().endswith(".csv")),
            key=lambda item: item.filename,
        )
        for item in files:
            number = customer_number(item.filename)
            rows = csv.reader(io.StringIO(archive.read(item).decode("utf-8-sig")))
            for row in list(rows)[4:]:
                if len(row) != 5 or row[0] not in {"User", "Account"}:
                    continue
                try:
                    at = datetime.strptime(f"{row[2]} {row[3]}", "%Y/%m/%d %H:%M:%S").replace(tzinfo=JST)
                except ValueError:
                    continue
                content = row[4].strip()
                if not content:
                    continue
                digest = hashlib.sha256(f"{number}\0{row[0]}\0{at.isoformat()}\0{content}".encode()).hexdigest()
                messages[digest] = Message(number, row[0], at, content, digest)
    return sorted(messages.values(), key=lambda message: (message.customer_number, message.at, message.source_digest))


def build_episodes(messages: Iterable[Message]) -> list[Episode]:
    episodes: list[Episode] = []
    current: Episode | None = None
    for message in messages:
        should_split = current is None or current.customer_number != message.customer_number
        if current and not should_split:
            gap = message.at - current.last_at
            should_split = gap > timedelta(hours=24) or (message.sender == "User" and current.outgoing and gap > timedelta(hours=6))
        if should_split:
            if current and current.incoming:
                episodes.append(current)
            current = Episode(message.customer_number, message.at, message.at)
        assert current is not None
        current.last_at = message.at
        current.source_digests.append(message.source_digest)
        (current.incoming if message.sender == "User" else current.outgoing).append(message.content)
    if current and current.incoming:
        episodes.append(current)
    return episodes


def classify(text: str) -> tuple[str, list[str], float]:
    labels = [category for category, words in CATEGORIES if any(word in text for word in words)]
    return (labels[0] if labels else "その他", labels, 0.86 if labels else 0.35)


def summarize(parts: list[str]) -> str:
    selected = parts[:2] if len(parts) <= 2 else [parts[0], parts[-1]]
    return redact(" / ".join(selected))


def serialize(episode: Episode) -> dict[str, object]:
    incoming_text = " ".join(episode.incoming)
    primary, labels, confidence = classify(incoming_text)
    all_text = incoming_text + " " + " ".join(episode.outgoing)
    if any(word in all_text for word in RESOLVED_WORDS):
        status = "resolved"
    elif episode.outgoing:
        status = "answered"
    else:
        status = "open"
    source_ref = "csv:" + hashlib.sha256("\0".join(episode.source_digests).encode()).hexdigest()[:40]
    return {
        "customerNumber": episode.customer_number,
        "openedAt": episode.opened_at.isoformat(),
        "lastActivityAt": episode.last_at.isoformat(),
        "primaryCategory": primary,
        "labels": labels,
        "inquirySummary": summarize(episode.incoming),
        "resolutionSummary": summarize(episode.outgoing) if episode.outgoing else None,
        "resolutionStatus": status,
        "confidence": confidence,
        "sourceRef": source_ref,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="LINE OA CSV ZIPを問い合わせ案件へ集計します")
    parser.add_argument("zip_path", type=Path)
    parser.add_argument("--cases", type=Path, required=True, help="個人情報を最小化したJSONL出力")
    parser.add_argument("--summary", type=Path, required=True, help="集計JSON出力")
    args = parser.parse_args()
    if not args.zip_path.is_file():
        parser.error("zip_pathが見つかりません")
    cases = [serialize(episode) for episode in build_episodes(read_messages(args.zip_path))]
    categories = Counter(str(case["primaryCategory"]) for case in cases)
    labels = Counter(label for case in cases for label in case["labels"] if isinstance(label, str))
    resolutions = Counter(str(case["resolutionStatus"]) for case in cases)
    customers = {str(case["customerNumber"]) for case in cases}
    summary = {
        "classificationVersion": VERSION,
        "inquiryCases": len(cases),
        "uniqueCustomers": len(customers),
        "primaryCategories": dict(categories.most_common()),
        "labelIncidence": dict(labels.most_common()),
        "resolutionStatuses": dict(resolutions.most_common()),
        "needsReview": sum(1 for case in cases if float(case["confidence"]) < 0.6),
    }
    args.cases.parent.mkdir(parents=True, exist_ok=True)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.cases.write_text("".join(json.dumps(case, ensure_ascii=False) + "\n" for case in cases), encoding="utf-8")
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
