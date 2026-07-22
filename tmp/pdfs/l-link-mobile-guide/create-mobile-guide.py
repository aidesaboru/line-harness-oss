from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image as PILImage
from reportlab.graphics import renderPDF
from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph


ROOT = Path('/Users/shinichi/Project/ec-owner-line-harness')
ASSET_DIR = ROOT / 'apps/web/public/brand'
SCREENSHOT_DIR = ROOT / 'tmp/pdfs/l-link-mobile-guide/screenshots'
OUT_DIR = ROOT / 'output/pdf'
OUT_PDF = OUT_DIR / 'Lリンク_モバイル利用ガイド.pdf'
APP_URL = 'https://ec-owner-line-harness-admin.pages.dev'

PAGE_W, PAGE_H = A4
GREEN = colors.HexColor('#06C755')
GREEN_DARK = colors.HexColor('#008A3E')
GREEN_SOFT = colors.HexColor('#EAFBF0')
NAVY = colors.HexColor('#0F172A')
SLATE = colors.HexColor('#475569')
MUTED = colors.HexColor('#64748B')
LINE = colors.HexColor('#DCE5EF')
PANEL = colors.HexColor('#F8FAFC')
BLUE_SOFT = colors.HexColor('#EFF6FF')
BLUE = colors.HexColor('#2563EB')
AMBER_SOFT = colors.HexColor('#FFF7ED')
AMBER = colors.HexColor('#C2410C')
WHITE = colors.white


def find_font(patterns: list[str]) -> Path:
    roots = [
        Path('/System/Library/Fonts'),
        Path('/System/Library/Fonts/Supplemental'),
        Path('/Library/Fonts'),
        Path.home() / 'Library/Fonts',
    ]
    for pattern in patterns:
        for root in roots:
            matches = sorted(root.glob(pattern))
            if matches:
                return matches[0]
    raise FileNotFoundError(f'Japanese font not found: {patterns}')


REGULAR_FONT = find_font(['Arial Unicode.ttf', 'AppleGothic.ttf', 'ヒラ*角* W3.ttc'])
BOLD_FONT = find_font(['Arial Unicode.ttf', 'AppleGothic.ttf', 'ヒラ*角* W6.ttc', 'ヒラ*角* W7.ttc'])
pdfmetrics.registerFont(TTFont('JP', str(REGULAR_FONT), subfontIndex=0))
pdfmetrics.registerFont(TTFont('JPBold', str(BOLD_FONT), subfontIndex=0))


def style(name: str, size: float, leading: float, color=NAVY, bold=False, align=TA_LEFT) -> ParagraphStyle:
    return ParagraphStyle(
        name,
        fontName='JPBold' if bold else 'JP',
        fontSize=size,
        leading=leading,
        textColor=color,
        alignment=align,
        splitLongWords=True,
        wordWrap='CJK',
        spaceAfter=0,
        spaceBefore=0,
    )


STYLES = {
    'eyebrow': style('eyebrow', 8.5, 11, GREEN_DARK, True),
    'title': style('title', 26, 34, NAVY, True),
    'h1': style('h1', 21, 27, NAVY, True),
    'h2': style('h2', 12, 16, NAVY, True),
    'body': style('body', 10, 16, SLATE),
    'body_bold': style('body_bold', 10, 15, NAVY, True),
    'small': style('small', 8.2, 12, MUTED),
    'tiny': style('tiny', 7.2, 10, MUTED),
    'url': style('url', 5.8, 8, MUTED),
    'white': style('white', 9, 12, WHITE, True, TA_CENTER),
    'step': style('step', 11, 15, NAVY, True),
    'center': style('center', 9, 13, SLATE, False, TA_CENTER),
}


def draw_paragraph(c: canvas.Canvas, text: str, style_name: str, x: float, y_top: float, width: float, height: float) -> float:
    paragraph = Paragraph(text, STYLES[style_name])
    _, used_h = paragraph.wrap(width, height)
    paragraph.drawOn(c, x, y_top - used_h)
    return used_h


def rounded_panel(c: canvas.Canvas, x: float, y: float, w: float, h: float, fill=PANEL, stroke=LINE, radius=6 * mm):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(0.7)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def pill(c: canvas.Canvas, text: str, x: float, y: float, w: float, fill, text_color):
    c.setFillColor(fill)
    c.setStrokeColor(fill)
    c.roundRect(x, y, w, 8 * mm, 4 * mm, fill=1, stroke=0)
    paragraph = Paragraph(text, style('pill', 8, 10, text_color, True, TA_CENTER))
    paragraph.wrapOn(c, w, 8 * mm)
    paragraph.drawOn(c, x, y + 2.3 * mm)


def page_header(c: canvas.Canvas, title: str, lead: str, page_no: int):
    x = 15 * mm
    y = PAGE_H - 14 * mm
    c.setFillColor(GREEN)
    c.roundRect(x, y - 3 * mm, 20 * mm, 2.3 * mm, 1.1 * mm, fill=1, stroke=0)
    draw_paragraph(c, title, 'h1', x, y - 9 * mm, 150 * mm, 18 * mm)
    draw_paragraph(c, lead, 'body', x, y - 21 * mm, 170 * mm, 18 * mm)
    pill(c, f'{page_no} / 3', PAGE_W - 33 * mm, PAGE_H - 20 * mm, 18 * mm, colors.HexColor('#EEF2F7'), SLATE)


def footer(c: canvas.Canvas, page_no: int):
    c.setStrokeColor(LINE)
    c.setLineWidth(0.5)
    c.line(15 * mm, 12 * mm, PAGE_W - 15 * mm, 12 * mm)
    draw_paragraph(c, 'Lリンク モバイル利用ガイド  |  社内共有用', 'tiny', 15 * mm, 9.4 * mm, 110 * mm, 7 * mm)
    draw_paragraph(c, f'2026.07.22  |  {page_no}', 'tiny', PAGE_W - 50 * mm, 9.4 * mm, 35 * mm, 7 * mm)


def pil_reader(path: Path, crop: tuple[int, int, int, int] | None = None) -> ImageReader:
    image = PILImage.open(path).convert('RGB')
    if crop:
        image = image.crop(crop)
    buffer = BytesIO()
    image.save(buffer, format='PNG', optimize=True)
    buffer.seek(0)
    return ImageReader(buffer)


def draw_phone(c: canvas.Canvas, image_path: Path, x: float, y: float, w: float, h: float, crop=None):
    shadow = 2.2 * mm
    c.setFillColor(colors.Color(0.1, 0.16, 0.25, alpha=0.12))
    c.roundRect(x + shadow, y - shadow, w, h, 7 * mm, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setStrokeColor(colors.HexColor('#CBD5E1'))
    c.setLineWidth(1)
    c.roundRect(x, y, w, h, 7 * mm, fill=1, stroke=1)
    pad = 2.2 * mm
    image = pil_reader(image_path, crop)
    c.saveState()
    clip_path = c.beginPath()
    clip_path.roundRect(x + pad, y + pad, w - 2 * pad, h - 2 * pad, 5 * mm)
    c.clipPath(clip_path, stroke=0, fill=0)
    c.drawImage(image, x + pad, y + pad, w - 2 * pad, h - 2 * pad, preserveAspectRatio=False, mask='auto')
    c.restoreState()


def draw_qr(c: canvas.Canvas, url: str, x: float, y: float, size: float):
    widget = qr.QrCodeWidget(url)
    x1, y1, x2, y2 = widget.getBounds()
    drawing = Drawing(size, size, transform=[size / (x2 - x1), 0, 0, size / (y2 - y1), 0, 0])
    drawing.add(widget)
    renderPDF.draw(drawing, c, x, y)


def draw_check(c: canvas.Canvas, x: float, y: float, text: str, width: float):
    c.setFillColor(GREEN)
    c.circle(x + 3 * mm, y - 3 * mm, 3 * mm, fill=1, stroke=0)
    c.setStrokeColor(WHITE)
    c.setLineWidth(1.4)
    c.line(x + 1.5 * mm, y - 3 * mm, x + 2.7 * mm, y - 4.2 * mm)
    c.line(x + 2.7 * mm, y - 4.2 * mm, x + 4.8 * mm, y - 1.7 * mm)
    draw_paragraph(c, text, 'body_bold', x + 9 * mm, y + 0.2 * mm, width - 9 * mm, 16 * mm)


def draw_step(c: canvas.Canvas, number: str, title: str, body: str, x: float, y_top: float, w: float):
    c.setFillColor(GREEN)
    c.circle(x + 5 * mm, y_top - 5 * mm, 5 * mm, fill=1, stroke=0)
    draw_paragraph(c, number, 'white', x, y_top - 1.1 * mm, 10 * mm, 8 * mm)
    draw_paragraph(c, title, 'step', x + 14 * mm, y_top, w - 14 * mm, 11 * mm)
    draw_paragraph(c, body, 'small', x + 14 * mm, y_top - 9 * mm, w - 14 * mm, 18 * mm)


def cover_page(c: canvas.Canvas):
    c.setFillColor(WHITE)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(GREEN_SOFT)
    c.rect(PAGE_W - 78 * mm, 0, 78 * mm, PAGE_H, fill=1, stroke=0)

    icon_path = ASSET_DIR / 'l-link-icon.png'
    wordmark_path = ASSET_DIR / 'l-link-wordmark.png'
    c.drawImage(str(icon_path), 15 * mm, PAGE_H - 29 * mm, 15 * mm, 15 * mm, preserveAspectRatio=True, mask='auto')
    c.drawImage(str(wordmark_path), 33 * mm, PAGE_H - 27 * mm, 46 * mm, 8.4 * mm, preserveAspectRatio=True, mask='auto')
    pill(c, '社内共有用', 15 * mm, PAGE_H - 47 * mm, 31 * mm, colors.HexColor('#E2FBEA'), GREEN_DARK)

    draw_paragraph(c, 'Lリンク<br/>モバイル利用ガイド', 'title', 15 * mm, PAGE_H - 60 * mm, 112 * mm, 55 * mm)
    draw_paragraph(
        c,
        'スマートフォンのホーム画面に追加すれば、<br/>アプリのようにすぐ開いて利用できます。',
        'body',
        15 * mm,
        PAGE_H - 117 * mm,
        108 * mm,
        34 * mm,
    )

    pill(c, 'App Store / Google Play の申請不要', 15 * mm, PAGE_H - 145 * mm, 77 * mm, BLUE_SOFT, BLUE)
    draw_check(c, 15 * mm, PAGE_H - 162 * mm, '個別チャット・社内チャットを確認', 104 * mm)
    draw_check(c, 15 * mm, PAGE_H - 177 * mm, '通知・チケットをスマホで確認', 104 * mm)
    draw_check(c, 15 * mm, PAGE_H - 192 * mm, 'PCと同じアカウントで利用', 104 * mm)

    rounded_panel(c, 15 * mm, 28 * mm, 106 * mm, 48 * mm, WHITE, LINE, 5 * mm)
    draw_qr(c, APP_URL, 21 * mm, 34 * mm, 35 * mm)
    draw_paragraph(c, 'スマホで開く', 'h2', 62 * mm, 67 * mm, 52 * mm, 10 * mm)
    draw_paragraph(c, 'カメラでQRコードを読み取るか、下記URLをSafari / Chromeで開きます。', 'small', 62 * mm, 57 * mm, 52 * mm, 20 * mm)
    draw_paragraph(c, '管理画面URL: ' + APP_URL.removeprefix('https://'), 'url', 62 * mm, 39 * mm, 52 * mm, 14 * mm)

    draw_phone(
        c,
        SCREENSHOT_DIR / '03-support.png',
        PAGE_W - 68.5 * mm,
        77 * mm,
        59 * mm,
        127.6 * mm,
    )
    footer(c, 1)
    c.showPage()


def install_page(c: canvas.Canvas):
    c.setFillColor(WHITE)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    page_header(c, 'ホーム画面に追加する', '初回だけ設定すれば、次回からホーム画面のLリンクアイコンで開けます。', 2)

    draw_phone(
        c,
        SCREENSHOT_DIR / '05-install-guide.png',
        18 * mm,
        54 * mm,
        68 * mm,
        147.1 * mm,
    )

    right_x = 99 * mm
    right_w = 93 * mm
    draw_step(c, '1', 'ブラウザでLリンクを開く', 'iPhoneはSafari、AndroidはChromeを推奨します。', right_x, 229 * mm, right_w)
    draw_step(c, '2', 'APIキーでログイン', '社内で案内されているAPIキーを入力します。', right_x, 199 * mm, right_w)
    draw_step(c, '3', '右上の追加アイコンを押す', '画面右上にある下向き矢印のアイコンです。', right_x, 169 * mm, right_w)

    rounded_panel(c, right_x, 81 * mm, right_w, 67 * mm, BLUE_SOFT, colors.HexColor('#BFDBFE'), 4 * mm)
    pill(c, 'iPhone / iPad', right_x + 6 * mm, 136 * mm, 35 * mm, colors.HexColor('#DBEAFE'), BLUE)
    draw_paragraph(c, 'Safariの共有メニューを開く', 'body_bold', right_x + 6 * mm, 128 * mm, 81 * mm, 12 * mm)
    draw_paragraph(c, '「ホーム画面に追加」→ 右上の「追加」を選択します。', 'body', right_x + 6 * mm, 116 * mm, 81 * mm, 25 * mm)
    draw_paragraph(c, '※ ChromeではなくSafariで開いてください。', 'small', right_x + 6 * mm, 94 * mm, 81 * mm, 13 * mm)

    rounded_panel(c, right_x, 35 * mm, right_w, 39 * mm, GREEN_SOFT, colors.HexColor('#BBF7D0'), 4 * mm)
    pill(c, 'Android', right_x + 6 * mm, 62 * mm, 26 * mm, colors.HexColor('#DCFCE7'), GREEN_DARK)
    draw_paragraph(c, '表示された案内で「インストール」を選択します。', 'body', right_x + 6 * mm, 55 * mm, 81 * mm, 22 * mm)

    rounded_panel(c, 18 * mm, 18 * mm, 174 * mm, 12 * mm, AMBER_SOFT, colors.HexColor('#FED7AA'), 3 * mm)
    draw_paragraph(c, 'APIキーは社外に共有しないでください。紛失・変更時は管理者へ連絡してください。', 'small', 23 * mm, 26 * mm, 164 * mm, 9 * mm)
    footer(c, 2)
    c.showPage()


def capability_item(c: canvas.Canvas, x: float, y_top: float, title: str, body: str, accent):
    c.setFillColor(accent)
    c.roundRect(x, y_top - 8 * mm, 3 * mm, 8 * mm, 1.3 * mm, fill=1, stroke=0)
    draw_paragraph(c, title, 'h2', x + 7 * mm, y_top, 50 * mm, 10 * mm)
    draw_paragraph(c, body, 'small', x + 7 * mm, y_top - 10 * mm, 50 * mm, 20 * mm)


def features_page(c: canvas.Canvas):
    c.setFillColor(WHITE)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    page_header(c, 'スマホでできること', '下部メニューから、日常的に使う4つの画面へすぐ移動できます。', 3)

    draw_phone(c, SCREENSHOT_DIR / '02-notifications.png', 16 * mm, 89 * mm, 52 * mm, 112.5 * mm)
    draw_phone(c, SCREENSHOT_DIR / '03-support.png', 73 * mm, 89 * mm, 52 * mm, 112.5 * mm)
    draw_paragraph(c, '通知センター', 'center', 16 * mm, 82 * mm, 52 * mm, 12 * mm)
    draw_paragraph(c, 'チケット管理', 'center', 73 * mm, 82 * mm, 52 * mm, 12 * mm)

    rounded_panel(c, 132 * mm, 92 * mm, 60 * mm, 141 * mm, PANEL, LINE, 5 * mm)
    capability_item(c, 139 * mm, 221 * mm, '個別', 'LINEの確認・返信・対応状況の更新', GREEN)
    capability_item(c, 139 * mm, 190 * mm, '社内', '相談・メンション・スレッド返信', BLUE)
    capability_item(c, 139 * mm, 159 * mm, '通知', '大至急・自分宛て・未読を確認', colors.HexColor('#DC2626'))
    capability_item(c, 139 * mm, 128 * mm, 'チケット', '担当・期限・二次対応を管理', colors.HexColor('#7C3AED'))

    rounded_panel(c, 18 * mm, 34 * mm, 174 * mm, 33 * mm, GREEN_SOFT, colors.HexColor('#BBF7D0'), 4 * mm)
    draw_paragraph(c, '使い始める前に', 'h2', 24 * mm, 59 * mm, 42 * mm, 10 * mm)
    draw_paragraph(c, '通知を確認する', 'body_bold', 70 * mm, 59 * mm, 35 * mm, 10 * mm)
    draw_paragraph(c, '未読や自分宛てを確認', 'small', 70 * mm, 49 * mm, 35 * mm, 14 * mm)
    draw_paragraph(c, '画面を更新する', 'body_bold', 111 * mm, 59 * mm, 35 * mm, 10 * mm)
    draw_paragraph(c, '表示が古い場合は更新', 'small', 111 * mm, 49 * mm, 35 * mm, 14 * mm)
    draw_paragraph(c, '困ったとき', 'body_bold', 152 * mm, 59 * mm, 34 * mm, 10 * mm)
    draw_paragraph(c, '画面と時刻を添えて共有', 'small', 152 * mm, 49 * mm, 34 * mm, 14 * mm)

    rounded_panel(c, 18 * mm, 18 * mm, 174 * mm, 11 * mm, BLUE_SOFT, colors.HexColor('#BFDBFE'), 3 * mm)
    draw_paragraph(c, 'ホーム画面に追加しても中身はWeb版です。更新内容は自動で反映されます。', 'small', 23 * mm, 26 * mm, 164 * mm, 8 * mm)
    footer(c, 3)
    c.showPage()


def create_pdf():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUT_PDF), pagesize=A4)
    c.setTitle('Lリンク モバイル利用ガイド')
    c.setAuthor('Lリンク運用チーム')
    c.setSubject('スマートフォンでLリンクをホーム画面に追加して利用する方法')
    cover_page(c)
    install_page(c)
    features_page(c)
    c.save()
    print(OUT_PDF)


if __name__ == '__main__':
    create_pdf()
