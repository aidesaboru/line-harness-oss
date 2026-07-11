from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable,
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path("/Users/shinichi/Project/ec-owner-line-harness")
SCREENSHOT_DIR = ROOT / "tmp/pdfs/line-harness-manual/screenshots"
OUT_DIR = ROOT / "output/pdf"
OUT_PDF = OUT_DIR / "line-harness-user-manual.pdf"

def find_font(patterns: list[str]) -> Path:
    roots = [
        Path("/System/Library/Fonts"),
        Path("/System/Library/Fonts/Supplemental"),
        Path("/Library/Fonts"),
        Path.home() / "Library/Fonts",
    ]
    for pattern in patterns:
        for root in roots:
            matches = sorted(root.glob(pattern))
            if matches:
                return matches[0]
    raise FileNotFoundError(f"Japanese font not found: {patterns}")


JP_REGULAR = find_font(["Arial Unicode.ttf", "AppleGothic.ttf", "ヒラ*角* W3.ttc"])
JP_BOLD = find_font(["Arial Unicode.ttf", "AppleGothic.ttf", "ヒラ*角* W6.ttc", "ヒラ*角* W7.ttc"])

pdfmetrics.registerFont(TTFont("JPGothic", str(JP_REGULAR), subfontIndex=0))
pdfmetrics.registerFont(TTFont("JPGothicBold", str(JP_BOLD), subfontIndex=0))

PAGE_SIZE = landscape(A4)
PAGE_WIDTH, PAGE_HEIGHT = PAGE_SIZE
GREEN = colors.HexColor("#06C755")
DARK = colors.HexColor("#111827")
MUTED = colors.HexColor("#64748B")
LINE = colors.HexColor("#E2E8F0")
SOFT_GREEN = colors.HexColor("#EAFBF0")
SOFT_GRAY = colors.HexColor("#F8FAFC")
AMBER = colors.HexColor("#F59E0B")
RED = colors.HexColor("#EF4444")


class ColorBar(Flowable):
    def __init__(self, width: float, height: float, color):
        super().__init__()
        self.width = width
        self.height = height
        self.color = color

    def draw(self):
        self.canv.setFillColor(self.color)
        self.canv.roundRect(0, 0, self.width, self.height, 3, fill=1, stroke=0)


def build_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    styles = {
        "Title": ParagraphStyle(
            "Title",
            parent=base["Title"],
            fontName="JPGothicBold",
            fontSize=31,
            leading=38,
            textColor=DARK,
            alignment=TA_LEFT,
            spaceAfter=8,
        ),
        "Subtitle": ParagraphStyle(
            "Subtitle",
            parent=base["Normal"],
            fontName="JPGothicBold",
            fontSize=13,
            leading=20,
            textColor=MUTED,
            spaceAfter=12,
        ),
        "H1": ParagraphStyle(
            "H1",
            parent=base["Heading1"],
            fontName="JPGothicBold",
            fontSize=19,
            leading=25,
            textColor=DARK,
            spaceAfter=7,
        ),
        "H2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName="JPGothicBold",
            fontSize=13,
            leading=18,
            textColor=DARK,
            spaceBefore=4,
            spaceAfter=5,
        ),
        "Body": ParagraphStyle(
            "Body",
            parent=base["Normal"],
            fontName="JPGothic",
            fontSize=10.4,
            leading=16,
            textColor=colors.HexColor("#334155"),
            spaceAfter=6,
        ),
        "BodyBold": ParagraphStyle(
            "BodyBold",
            parent=base["Normal"],
            fontName="JPGothicBold",
            fontSize=10.5,
            leading=16,
            textColor=colors.HexColor("#1F2937"),
            spaceAfter=5,
        ),
        "Small": ParagraphStyle(
            "Small",
            parent=base["Normal"],
            fontName="JPGothic",
            fontSize=8.6,
            leading=12.5,
            textColor=MUTED,
            spaceAfter=4,
        ),
        "Tiny": ParagraphStyle(
            "Tiny",
            parent=base["Normal"],
            fontName="JPGothic",
            fontSize=7.2,
            leading=10,
            textColor=MUTED,
        ),
        "StepNo": ParagraphStyle(
            "StepNo",
            parent=base["Normal"],
            fontName="JPGothicBold",
            fontSize=15,
            leading=17,
            alignment=TA_CENTER,
            textColor=colors.white,
        ),
        "CoverBadge": ParagraphStyle(
            "CoverBadge",
            parent=base["Normal"],
            fontName="JPGothicBold",
            fontSize=9,
            leading=12,
            textColor=GREEN,
            alignment=TA_CENTER,
        ),
    }
    return styles


S = build_styles()


def p(text: str, style: str = "Body") -> Paragraph:
    return Paragraph(text, S[style])


def bullet(items: list[str], font_size: float = 9.7) -> ListFlowable:
    style = ParagraphStyle(
        f"Bullet{font_size}",
        parent=S["Body"],
        fontSize=font_size,
        leading=14.2,
        leftIndent=0,
    )
    return ListFlowable(
        [ListItem(Paragraph(item, style), leftIndent=8) for item in items],
        bulletType="bullet",
        start="circle",
        leftIndent=12,
        bulletFontName="JPGothicBold",
        bulletFontSize=6,
        bulletColor=GREEN,
    )


def note_box(title: str, body: str, color=SOFT_GREEN, width: float = 250 * mm) -> Table:
    content = [
        [p(title, "BodyBold")],
        [p(body, "Body")],
    ]
    table = Table(content, colWidths=[width])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), color),
        ("BOX", (0, 0), (-1, -1), 0.7, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def step_card(no: str, title: str, body: str, width: float) -> Table:
    no_cell = Table([[p(no, "StepNo")]], colWidths=[14 * mm], rowHeights=[14 * mm])
    no_cell.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN),
        ("BOX", (0, 0), (-1, -1), 0, GREEN),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    inner = [
        [no_cell, [p(title, "BodyBold"), p(body, "Small")]],
    ]
    table = Table(inner, colWidths=[18 * mm, width - 18 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.8, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def screenshot_image(name: str, max_w: float, max_h: float) -> Image:
    image_path = SCREENSHOT_DIR / name
    img = Image(str(image_path))
    ratio = min(max_w / img.imageWidth, max_h / img.imageHeight)
    img.drawWidth = img.imageWidth * ratio
    img.drawHeight = img.imageHeight * ratio
    return img


def section_page(title: str, lead: str, screenshot: str, look: list[str], do: list[str], caution: str | None = None):
    left_w = 180 * mm
    right_w = 82 * mm
    image = screenshot_image(screenshot, left_w, 126 * mm)
    right = [p("ここを見る", "H2"), bullet(look), Spacer(1, 5), p("この画面でやること", "H2"), bullet(do)]
    if caution:
        right += [Spacer(1, 5), note_box("注意", caution, colors.HexColor("#FFF7ED"), width=right_w - 8 * mm)]
    body = Table(
        [[image, right]],
        colWidths=[left_w, right_w],
        hAlign="LEFT",
    )
    body.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return [p(title, "H1"), p(lead, "Subtitle"), body, PageBreak()]


def cover_page():
    badge = Table([[p("現状版 / 2026年6月29日", "CoverBadge")]], colWidths=[48 * mm], rowHeights=[8 * mm])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SOFT_GREEN),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#BBF7D0")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    flow = [
        ColorBar(45 * mm, 5, GREEN),
        Spacer(1, 16),
        badge,
        Spacer(1, 22),
        p("LINE Harness<br/>操作マニュアル", "Title"),
        p("個別チャットを確認し、必要な問い合わせをチケット化し、二次対応まで回すための使い方をまとめたPDFです。", "Subtitle"),
        Spacer(1, 18),
        note_box(
            "このPDFの読み方",
            "実際の操作画面のスクリーンショットを左に置き、右側に「どこを見るか」「何をするか」を書いています。はじめて触る人でも、上から順番に読めば一通りの流れが分かる構成です。",
        ),
        Spacer(1, 14),
        p("スクリーンショット内の顧客名・会話内容は、説明用のサンプルです。実顧客データは入れていません。", "Small"),
        PageBreak(),
    ]
    return flow


def overview_page():
    cards = [
        step_card("1", "LINEが届く", "顧客からのメッセージは「個別チャット」に溜まります。まずは未読や未対応を確認します。", 82 * mm),
        step_card("2", "返信する", "その場で返せる内容は、個別チャットから返信します。返信不要なら解決済みにします。", 82 * mm),
        step_card("3", "チケット化する", "判断に迷う問い合わせ、期限や担当者を決めたい問い合わせは「チケット管理」に回します。", 82 * mm),
        step_card("4", "二次対応へ回す", "専門判断が必要なものは、二次対応者に確認依頼します。回答が来たら一次担当が顧客へ返します。", 82 * mm),
    ]
    table = Table([cards[:2], cards[2:]], colWidths=[126 * mm, 126 * mm], rowHeights=[33 * mm, 33 * mm])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    items = [
        ["よく使う画面", "何をする場所か"],
        ["個別チャット", "LINEのやり取りを見る、返信する、返信不要を解決済みにする場所"],
        ["チケット管理", "問い合わせを担当者・期限・緊急度つきで管理する場所"],
        ["二次対応", "オーナーや詳しい担当者が、自分宛の確認依頼に回答する場所"],
        ["顧客管理", "顧客番号、法人名、担当者名、タグなどの基本情報を整える場所"],
        ["マニュアル", "対応ルールや判断基準を検索・更新する場所"],
    ]
    matrix = Table(
        [[p(c, "BodyBold" if r == 0 else "Body") for c in row] for r, row in enumerate(items)],
        colWidths=[48 * mm, 205 * mm],
    )
    matrix.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("BOX", (0, 0), (-1, -1), 0.7, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return [
        p("まず全体像", "H1"),
        p("LINE Harnessは、LINE対応を「見逃さない」「担当を決める」「二次確認まで残す」ための作業台です。難しく考えず、下の流れだけ先に押さえてください。", "Subtitle"),
        table,
        Spacer(1, 10),
        matrix,
        PageBreak(),
    ]


def daily_page():
    rows = [
        ["タイミング", "見る画面", "やること"],
        ["朝", "個別チャット", "未読・未対応を確認し、その場で返せるものは返信する"],
        ["対応中", "チケット管理", "期限・緊急度・担当者を見て、優先順位を決める"],
        ["判断に迷う時", "チケット管理 → 二次対応", "問い合わせ内容を入れて、オーナーや詳しい担当者へ確認依頼する"],
        ["回答が来た時", "二次対応 / チケット管理", "二次回答を見て、顧客への返信文を作る"],
        ["終わった時", "個別チャット / チケット管理", "返信不要や対応完了は解決済み・完了にする"],
        ["随時", "顧客管理 / マニュアル", "顧客情報や対応ルールを更新し、次の人が迷わない状態にする"],
    ]
    table = Table(
        [[p(c, "BodyBold" if r == 0 else "Body") for c in row] for r, row in enumerate(rows)],
        colWidths=[45 * mm, 63 * mm, 145 * mm],
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), SOFT_GREEN),
        ("BOX", (0, 0), (-1, -1), 0.7, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return [
        p("1日の運用チェック", "H1"),
        p("毎日見る順番を固定すると、対応漏れが減ります。まずはこの順番で運用してください。", "Subtitle"),
        table,
        Spacer(1, 12),
        note_box(
            "迷った時の考え方",
            "「その場で返せるか」「誰かの判断が必要か」「期限を決めるべきか」で分けます。判断が必要なら、個別チャットだけで抱え込まずチケットにします。",
        ),
        PageBreak(),
    ]


def caution_page():
    rows = [
        ["場面", "やること", "理由"],
        ["お礼だけ届いた", "個別チャットで解決済みにする", "返信不要なのに未対応として残るのを防ぐため"],
        ["期限が近い", "チケット管理で緊急度と期限を確認する", "見落とすと顧客返信が遅れるため"],
        ["専門判断が必要", "二次対応へ回す", "一次担当だけで判断ミスをしないため"],
        ["顧客情報が空欄", "顧客管理で埋める", "次の担当者が過去情報を探す時間を減らすため"],
        ["対応ルールが変わった", "マニュアルを更新する", "人によって案内内容がズレるのを防ぐため"],
    ]
    table = Table(
        [[p(c, "BodyBold" if r == 0 else "Body") for c in row] for r, row in enumerate(rows)],
        colWidths=[58 * mm, 86 * mm, 109 * mm],
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("BOX", (0, 0), (-1, -1), 0.7, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return [
        p("運用で気をつけること", "H1"),
        p("LINE Harnessは、問い合わせを整理する道具です。最後は担当者が「対応完了にしてよいか」「誰に確認するか」を決めます。", "Subtitle"),
        table,
        Spacer(1, 12),
        note_box(
            "このマニュアルの位置づけ",
            "これは初回運用のベース版です。実際に使いながら「ここが分かりにくい」「この手順を足したい」という声を集めて、次の版で更新していく前提です。",
            color=colors.HexColor("#F8FAFC"),
        ),
    ]


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(DARK)
    canvas.setFont("JPGothicBold", 8)
    canvas.drawString(14 * mm, 10 * mm, "LINE Harness 操作マニュアル")
    canvas.setFillColor(MUTED)
    canvas.setFont("JPGothic", 8)
    canvas.drawRightString(PAGE_WIDTH - 14 * mm, 10 * mm, f"{doc.page}")
    canvas.restoreState()


def build_pdf():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    story = []
    story.extend(cover_page())
    story.extend(overview_page())
    story.extend(section_page(
        "チケット管理",
        "問い合わせを「付箋のようなチケット」として並べ、担当者・期限・緊急度を見ながら進める画面です。",
        "01-ticket-management.png",
        [
            "左の「チケット一覧」で、未完了の問い合わせを確認します。",
            "赤い「大至急」や期限表示は、先に見るべきものです。",
            "右側では件名、問い合わせ内容、担当者、期限、緊急度を編集します。",
            "下の会話ログで、どんなLINEの流れからチケットになったか確認できます。",
        ],
        [
            "新しい問い合わせは「新規チケット」から作成します。",
            "判断が必要なものは、一次担当者と二次対応者を入れます。",
            "返答方針が決まったら、返信案をコピーするかチャットで返信します。",
            "対応が終わったら「完了」にして一覧から外します。",
        ],
        "チケットは「作ったら終わり」ではなく、返信・確認・完了まで進めて初めて片付きます。",
    ))
    story.extend(section_page(
        "個別チャット",
        "顧客とのLINE会話を見る画面です。ここで返信、メモ、解決済みへの変更を行います。",
        "02-chat.png",
        [
            "左のリストで未読・対応中・解決済みを切り替えます。",
            "中央がLINE風の会話ログです。画像やPDFもここから開きます。",
            "右側の顧客詳細で、顧客番号や法人名などを確認できます。",
            "下の入力欄から返信します。現在はShift+Enterで送信する運用です。",
        ],
        [
            "すぐ返せる内容は、そのまま返信します。",
            "返信不要のお礼やスタンプだけなら、解決済みにします。",
            "判断が必要なら、チケット管理でチケット化します。",
            "LINE公式側で送った文章は「公式送信を記録」で残します。",
        ],
        "送信取り消しはLINE側の仕様上、相手の画面から完全に消せる機能ではありません。送信前チェックを優先してください。",
    ))
    story.extend(section_page(
        "二次対応",
        "オーナーや詳しい担当者が、自分宛の確認依頼だけを見る画面です。",
        "03-escalations.png",
        [
            "上部の「未回答」「回答済み」で確認状況を切り替えます。",
            "依頼内容には、一次担当者が何を判断してほしいかが書かれます。",
            "期限が赤い場合は、優先的に回答します。",
            "「チケットを開く」で元の問い合わせ内容まで戻れます。",
        ],
        [
            "回答要点に、一次担当者へ返す判断を書きます。",
            "情報が足りなければ差し戻します。",
            "回答できたら「回答済みにする」を押します。",
            "一次担当者は回答をもとに顧客返信を作ります。",
        ],
        "二次対応者は、顧客へ直接返す文章ではなく「判断・根拠・方針」を短く返すのが基本です。",
    ))
    story.extend(section_page(
        "顧客管理",
        "顧客番号、法人名、担当者名、店舗名、タグなどを整える画面です。",
        "04-friends.png",
        [
            "検索欄で顧客名を探します。",
            "基本情報の達成数で、入力がどこまで埋まっているか分かります。",
            "黄色い枠は、未入力で目立たせている項目です。",
            "タグで「重要」「確認中」などの分類を付けられます。",
        ],
        [
            "顧客情報が分かったら、その場で入力して保存します。",
            "対応に必要な分類はタグで付けます。",
            "不要な情報は増やしすぎず、引き継ぎに必要な情報だけ残します。",
            "情報が空欄のままなら、次の担当者が迷うので後回しにしないようにします。",
        ],
    ))
    story.extend(section_page(
        "マニュアル",
        "対応ルールや判断基準を検索・更新する画面です。",
        "05-manuals.png",
        [
            "検索欄でタイトル・本文・キーワードを探します。",
            "カテゴリで返金、運営確認、その他などを絞り込めます。",
            "各マニュアルに、本文・キーワード・担当者がまとまっています。",
            "ルールが変わったら、古い案内を残さず更新します。",
        ],
        [
            "よく聞かれる内容はマニュアル化します。",
            "二次対応で判断した内容は、必要ならマニュアルへ反映します。",
            "使わなくなった手順は無効化します。",
            "一次担当者が迷わない言葉で短く書きます。",
        ],
    ))
    story.extend(daily_page())
    story.extend(caution_page())

    doc = SimpleDocTemplate(
        str(OUT_PDF),
        pagesize=PAGE_SIZE,
        rightMargin=14 * mm,
        leftMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=16 * mm,
        title="LINE Harness 操作マニュアル",
        author="Codex",
    )
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return OUT_PDF


if __name__ == "__main__":
    print(build_pdf())
