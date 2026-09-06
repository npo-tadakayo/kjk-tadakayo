#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""タダカヨ認定事業者「タダトモ」書類サンプル v0.3 の HTML を生成する。

Google ドキュメントへの取り込みを前提に、装飾は「1セルの表」で作る。
（div の背景色は Docs 取り込みで落ちるため）
"""
import pathlib

OUT = pathlib.Path(__file__).parent / "v3"
OUT.mkdir(exist_ok=True)

RED = "#E33535"
PINK = "#FFE4EC"
GRAY = "#F5F5F5"
INK = "#000000"
MUTED = "#555555"

SANS = "'Noto Sans JP','Yu Gothic',sans-serif"
SERIF = "'Noto Serif JP','Yu Mincho',serif"

# 角印（請求書・領収書と同じ印影）。Google ドキュメント取り込み時に埋め込まれる。
SEAL_URL = "https://kjk-tadakayo-admin.web.app/images/seal-tadakayo.png"
SEAL = f'<img src="{SEAL_URL}" alt="NPO法人タダカヨの角印" width="72" height="72">'

# 認定マーク（タダトモ）。取り込み時に画像がドキュメントへコピーされるので、
# 一時的に見える URL でも構わない。LP を本番に出したら BADGE_BASE を
# https://kjk.tadakayo.jp/images/badges に戻すこと。
BADGE_BASE = "https://kjk-tadakayo--badge-0906-42gcyz9r.web.app/images/badges"


def badge(name, w=104, alt="タダカヨ認定事業者「タダトモ」の認定マーク"):
    return f'<img src="{BADGE_BASE}/{name}.png" alt="{alt}" width="{w}" height="{w}">'


def box(inner, bg=PINK, border=RED, pad="12pt"):
    """1セルの表で作るコールアウト。左に赤い縦線を立てる。"""
    return (
        f'<table style="width:100%;border-collapse:collapse;margin:14pt 0"><tr>'
        f'<td style="width:4pt;background-color:{border};border:none"></td>'
        f'<td style="background-color:{bg};padding:{pad};border:none;'
        f'font-family:{SANS};font-size:10.5pt;line-height:1.8">{inner}</td>'
        f"</tr></table>"
    )


def head(title, subtitle, badge=None):
    b = ""
    if badge:
        b = (
            f'<p style="margin:0 0 6pt 0;font-family:{SANS};font-size:9pt;'
            f'letter-spacing:1.5pt;color:{RED};font-weight:700">{badge}</p>'
        )
    return (
        f'<table style="width:100%;border-collapse:collapse;margin:0 0 4pt 0"><tr>'
        f'<td style="background-color:{RED};padding:16pt 18pt;border:none">'
        f'<p style="margin:0;font-family:{SANS};font-size:9pt;color:#FFFFFF;'
        f'letter-spacing:2pt">NPO法人タダカヨ　介護情報基盤伴走支援事業</p>'
        f'<p style="margin:6pt 0 0 0;font-family:{SERIF};font-size:22pt;color:#FFFFFF;'
        f'font-weight:700">{title}</p>'
        f'<p style="margin:6pt 0 0 0;font-family:{SANS};font-size:10pt;color:#FFE4EC">'
        f"{subtitle}</p>"
        f"</td></tr></table>" + b
    )


def sec(no, title):
    """赤い番号つきの節見出し。"""
    return (
        f'<table style="width:100%;border-collapse:collapse;margin:20pt 0 8pt 0"><tr>'
        f'<td style="width:26pt;background-color:{RED};padding:5pt 0;border:none;'
        f'text-align:center;font-family:{SANS};font-size:12pt;color:#FFFFFF;'
        f'font-weight:700">{no}</td>'
        f'<td style="padding:5pt 0 5pt 10pt;border:none;border-bottom:1pt solid {RED};'
        f'font-family:{SANS};font-size:13pt;color:{RED};font-weight:700">{title}</td>'
        f"</tr></table>"
    )


def art(num, title):
    """契約書の条見出し。"""
    return (
        f'<table style="width:100%;border-collapse:collapse;margin:16pt 0 6pt 0"><tr>'
        f'<td style="width:3pt;background-color:{RED};border:none"></td>'
        f'<td style="padding:2pt 0 2pt 8pt;border:none;font-family:{SANS};'
        f'font-size:12pt;color:{RED};font-weight:700">第{num}条（{title}）</td>'
        f"</tr></table>"
    )


def p(text, size="10.5pt", color=INK, align="left", margin="6pt 0"):
    return (
        f'<p style="margin:{margin};font-family:{SANS};font-size:{size};'
        f'line-height:1.9;color:{color};text-align:{align}">{text}</p>'
    )


def th(*cells, w=None):
    tds = ""
    for i, c in enumerate(cells):
        width = f"width:{w[i]};" if w else ""
        tds += (
            f'<td style="{width}background-color:{RED};color:#FFFFFF;padding:7pt 9pt;'
            f'border:1pt solid {RED};font-family:{SANS};font-size:10pt;'
            f'font-weight:700">{c}</td>'
        )
    return f"<tr>{tds}</tr>"


def tr(*cells, bg=None, first_bold=False):
    tds = ""
    for i, c in enumerate(cells):
        b = f"background-color:{bg};" if bg else ""
        fw = "font-weight:700;" if (first_bold and i == 0) else ""
        tds += (
            f'<td style="{b}{fw}padding:7pt 9pt;border:1pt solid #D9D9D9;'
            f'font-family:{SANS};font-size:10pt;line-height:1.8;'
            f'vertical-align:top">{c}</td>'
        )
    return f"<tr>{tds}</tr>"


def table(rows):
    return (
        f'<table style="width:100%;border-collapse:collapse;margin:8pt 0">'
        + "".join(rows)
        + "</table>"
    )


BLANK = f"background-color:#FFFFFF"


def field(label, hint=""):
    """記入欄の1行。ラベルはグレー地、記入欄は白。"""
    h = (
        f'<br><span style="font-size:8.5pt;color:{MUTED}">{hint}</span>'
        if hint
        else ""
    )
    return (
        f'<tr><td style="width:38%;background-color:{GRAY};padding:8pt 9pt;'
        f'border:1pt solid #D9D9D9;font-family:{SANS};font-size:10pt;'
        f'font-weight:700;vertical-align:top">{label}{h}</td>'
        f'<td style="padding:8pt 9pt;border:1pt solid #D9D9D9;'
        f'font-family:{SANS};font-size:10pt">&nbsp;</td></tr>'
    )


FOOT = (
    f'<table style="width:100%;border-collapse:collapse;margin:26pt 0 0 0"><tr>'
    f'<td style="border:none;border-top:2pt solid {RED};padding:10pt 0 0 0;'
    f'font-family:{SANS};font-size:9pt;line-height:1.8;color:{MUTED}">'
    f"NPO法人タダカヨ（理事長　佐藤 拡史）　〒143-0014 東京都大田区大森中二丁目1番20-1001号<br>"
    f"介護情報基盤伴走支援事業　kjk-staff@tadakayo.jp　"
    f'<a href="https://kjk.tadakayo.jp" style="color:{RED}">https://kjk.tadakayo.jp</a>'
    f"</td></tr></table>"
)


def page(title, body):
    return (
        "<html><head><meta charset='utf-8'>"
        f"<title>{title}</title></head>"
        f'<body style="font-family:{SANS};color:{INK}">{body}</body></html>'
    )


# ============================================================ 01 認定申請書
b = []
b.append(head("認定申請書", "タダカヨ認定事業者「タダトモ」に申請いただくための書式です", "APPLICATION FORM"))
b.append(
    box(
        "<b>これは検討用のサンプルです。</b>　実際は Web フォームでお受けし、"
        "ご回答はそのまま CRM に入ります。ここでは「何をおうかがいするか」を"
        "確かめるために、書式の形で並べています。<br>"
        f'<span style="color:{MUTED}">作成 2026-09-06 ／ サンプル v0.3 ／ 未承認（次田さん確認待ち）</span>',
        bg=GRAY,
        border="#BBBBBB",
    )
)
b.append(p("NPO法人タダカヨ　御中", size="11pt", margin="18pt 0 4pt 0"))
b.append(
    p(
        "介護情報基盤の導入支援を各地域で担う<b>タダカヨ認定事業者（愛称：タダトモ）</b>として、"
        "下記のとおり申請します。別紙「認定事業者 誓約書兼同意書」の内容を確認し、"
        "これを守ることに同意します。"
    )
)

b.append(sec("1", "申請する法人について"))
b.append(
    table(
        [
            field("法人名（正式名称）"),
            field("法人名（ふりがな）"),
            field("代表者の役職・氏名"),
            field("本社所在地", "郵便番号・都道府県・市町村・番地建物"),
            field("電話番号"),
            field("ホームページ"),
            field("法人番号（13桁）"),
            field("設立年月"),
        ]
    )
)

b.append(sec("2", "介護分野での実績"))
b.append(
    table(
        [
            field("介護・福祉分野での事業年数", "例：8年"),
            field("現在行っている事業", "例：福祉用具貸与、住宅改修、ICT導入支援、居宅介護支援 など"),
            field("介護保険の指定を受けている事業", "種別と事業所番号をご記入ください"),
            field("介護現場の経験がある職員", "□ いる（　　名）　　□ いない"),
            field("保有資格", "介護福祉士・ケアマネジャー・福祉住環境コーディネーター など"),
        ]
    )
)
b.append(
    box(
        "<b>ここをおうかがいする理由</b><br>"
        "介護情報基盤の支援は、機器の設定だけでなく、現場の運び方が分かっていないと"
        "成り立たないためです。<b>年数の長短で判断するものではありません。</b>"
    )
)

b.append(sec("3", "介護情報基盤の支援体制"))
b.append(
    table(
        [
            field("支援を担当する人数"),
            field("タダメンに加入する方", "代表者または主担当者。1名以上。氏名／役職／メールアドレス"),
            field("その他の実務担当者", "ゲストアカウントを発行します。氏名／メールアドレス（人数分）"),
            field("対応できる地域", "都道府県・市町村"),
            field("訪問での支援", "□ できる　　□ オンラインのみ"),
            field("1か月に支援できるおおよその事業所数"),
        ]
    )
)
b.append(
    box(
        "<b>タダメンへの加入について</b><br>"
        "認定事業者になるにあたり、代表者または介護情報基盤事業の主担当者のうち<b>1名以上</b>に"
        "タダメンへご加入いただきます。タダカヨの理念や活動を知っていただいたうえでの"
        "ご参加をお願いしています。その他の実務担当者は、ゲストアカウント（1年ごとに更新）で"
        "ご利用いただけます。"
    )
)

b.append(sec("4", "個人情報の取扱い"))
b.append(
    table(
        [
            field("個人情報の取扱いに関する社内規程", "□ ある　　□ ない（今後整備する）"),
            field("プライバシーマーク・ISMS 等の認証", "□ あり（　　　　　　）　　□ なし"),
            field("支援で知り得た情報の管理方法", "保管場所・持ち出しの可否など"),
        ]
    )
)

b.append(sec("5", "確認事項"))
b.append(p("以下すべてに該当することを確認し、チェックをお願いします。"))
b.append(
    table(
        [
            tr(
                "☐",
                "当法人および役員は、<b>暴力団その他の反社会的勢力に該当せず</b>、これらと関係を持っていません",
            ),
            tr("☐", "<b>介護保険法その他の関係法令に違反する行為</b>を行っていません", bg="#FCFCFC"),
            tr("☐", "別紙「認定事業者 誓約書兼同意書」の内容を確認し、<b>これを守ります</b>"),
            tr("☐", "タダカヨの理念と活動について説明を受け、<b>内容を理解しています</b>", bg="#FCFCFC"),
        ]
    )
)

b.append(sec("6", "申請日・記入者"))
b.append(table([field("申請日"), field("記入者の氏名・役職"), field("連絡先メールアドレス")]))

b.append(
    f'<table style="width:100%;border-collapse:collapse;margin:24pt 0 0 0"><tr>'
    f'<td style="background-color:{GRAY};padding:12pt 14pt;border:1pt dashed #BBBBBB">'
    f'<p style="margin:0 0 6pt 0;font-family:{SANS};font-size:11pt;font-weight:700;'
    f'color:{MUTED}">タダカヨ記入欄　<span style="font-size:9pt;font-weight:400">'
    f"（申請をお受けしたあとに使います）</span></p>"
    f'<table style="width:100%;border-collapse:collapse">'
    + field("受付日")
    + field("説明の場を行った日・担当")
    + field("確認した内容", "事業実態・体制・個人情報")
    + field("認定の可否", "□ 認定　　□ 保留　　□ 不可")
    + field("認定番号", "TDT-000 形式")
    + field("認定日")
    + "</table></td></tr></table>"
)
b.append(FOOT)
(OUT / "01_認定申請書.html").write_text(page("認定申請書", "".join(b)), encoding="utf-8")


# ==================================================== 02 誓約書兼同意書
b = []
b.append(head("誓約書兼同意書", "タダカヨと認定事業者「タダトモ」で取り交わす約束です", "AGREEMENT"))
b.append(
    box(
        "<b>これは検討用のサンプルです。</b>　実際は承諾書と同じオンライン署名"
        "（URLを開いて署名）で取り交わします。<br>"
        f'<span style="color:{MUTED}">作成 2026-09-06 ／ サンプル v0.3 ／ 未承認（次田さん確認待ち）</span>',
        bg=GRAY,
        border="#BBBBBB",
    )
)

b.append(sec("前", "前文"))
b.append(
    p(
        "NPO法人タダカヨ（以下「タダカヨ」）と、末尾に署名する事業者（以下「認定事業者」）は、"
        "介護情報基盤の導入支援を各地域で進めるにあたり、次のとおり約束します。"
    )
)
b.append(p("この制度は2026年度の試行として始めるものです。運用しながら、よりよい形に見直していきます。"))

b.append(art(1, "目的・この認定の位置づけ"))
b.append(
    p(
        "この制度は、介護情報基盤への対応に困っている介護事業所が、<b>身近な地域で相談でき、"
        "無理なく導入を終えられる状態</b>をつくることを目的とします。"
    )
)
b.append(
    p(
        "タダカヨは「お金をかけずに、より良い介護へ」を掲げる非営利の法人です。"
        "認定事業者にも、この考え方に沿った支援をお願いします。"
    )
)
b.append(
    box(
        "<b>国の制度との関係</b><br>"
        "この認定は<b>タダカヨが独自に行うもの</b>であり、国（厚生労働省）が介護情報基盤ポータルに"
        "掲載している「<b>介護事業所向け導入支援事業者</b>」とは別のものです。"
        "国の一覧への掲載を希望される場合は、認定事業者ご自身で厚生労働省へお申し込みください"
        "（タダカヨが代わって申請することはできません）。"
    )
)

b.append(art(2, "認定事業者ができること"))
b.append(p("認定事業者は、認定の期間中、次のことができます。"))
b.append(
    table(
        [
            th("　", "できること", w=["8%", "92%"]),
            tr("1", "「<b>タダカヨ認定事業者</b>」の名称・愛称「<b>タダトモ</b>」および認定マークを、認定番号とあわせて表示すること"),
            tr("2", "カードリーダーを<b>認定事業者価格</b>で仕入れること", bg="#FCFCFC"),
            tr("3", "<b>認定事業者ポータル</b>（発注・出荷状況の確認）を利用すること"),
            tr("4", "タダカヨが用意する<b>ガイドブック・手順書・研修資料</b>を、自社の支援で使うこと", bg="#FCFCFC"),
            tr("5", "認定事業者ごとの<b>専用チャットスペース</b>で、タダカヨへ相談すること"),
            tr("6", "タダカヨの Web サイトの<b>認定事業者一覧に掲載</b>されること", bg="#FCFCFC"),
            tr(
                "7",
                "タダカヨに申し込みのあった事業所について、<b>タダカヨが直接うかがえない場合に、"
                "地域や日程を調整のうえ支援を依頼</b>されることがあります"
                f'<br><span style="font-size:9pt;color:{MUTED}">※ 依頼の有無・件数は保証しません</span>',
            ),
        ]
    )
)

b.append(art(3, "守っていただきたいこと"))
b.append(p("認定事業者は、支援を行うにあたり、次のことを守ります。"))
b.append(
    table(
        [
            tr(
                "1",
                "<b>事業所の立場に立った提案をすること。</b><br>"
                "必要のない機器をあわせて売る、助成金の上限を超える金額を請求するなど、"
                "事業所の不利益になる売り方をしません",
            ),
            tr(
                "2",
                "<b>助成金の申請にあたり、事実と異なる書類を作らないこと。</b><br>"
                "領収書の日付・金額・品名を実際と違う形で作成しません",
                bg="#FCFCFC",
            ),
            tr(
                "3",
                "<b>支援の質を保つこと。</b><br>"
                "タダカヨが用意するガイドブック・手順に沿って支援します。"
                "手順に無いことを行う場合は、事前にタダカヨへ相談します",
            ),
            tr(
                "4",
                "<b>利用者の個人情報を、支援に必要な範囲を超えて取得・保存しないこと。</b><br>"
                "マイナンバーカードの内容を書き写す、控えを取るなどは行いません",
                bg="#FCFCFC",
            ),
            tr(
                "5",
                "<b>タダカヨの事業であるかのような説明をしないこと。</b><br>"
                "支援を行うのは認定事業者自身であり、タダカヨが直接行うものではないことを、"
                "事業所に分かるように伝えます",
            ),
            tr(
                "6",
                "<b>知り得た情報を他に漏らさないこと。</b><br>"
                "支援を通じて知った事業所・利用者・タダカヨの情報を、正当な理由なく第三者に伝えません。"
                "認定が終わったあとも同じです",
                bg="#FCFCFC",
            ),
        ]
    )
)

b.append(art(4, "実績の報告"))
b.append(
    table(
        [
            tr("1", "認定事業者は、自社で対応した介護情報基盤の支援について、<b>毎月、支援した事業所の数</b>をタダカヨへ報告します"),
            tr(
                "2",
                "報告は、認定事業者ポータルの報告画面から行います。<b>入力するのは件数だけ</b>で、"
                "1分ほどで終わります。前月分を<b>翌月10日ごろ</b>を目安にお願いします"
                f'<br><span style="font-size:9pt;color:{MUTED}">※ 日を1日でも過ぎたら遅れ、という趣旨ではありません</span>',
                bg="#FCFCFC",
            ),
            tr(
                "3",
                "タダカヨは、報告された件数を、<b>全国の普及状況の把握・広報・制度の見直し</b>に使います。"
                "事業所名・金額・利用者に関することは報告の対象にしません",
            ),
            tr("4", "支援が0件だった月も、<b>「0件」とご報告ください</b>（報告漏れと区別するためです）", bg="#FCFCFC"),
        ]
    )
)
b.append(
    box(
        "<b>なぜ毎月おうかがいするのか</b><br>"
        "介護情報基盤の対応は2027年1月の統合に向けて動いています。全国でどこまで進んだかを"
        "月ごとに把握できないと、国や自治体への情報提供、広報の打ち手が後手になるためです。"
        "ご負担にならないよう、<b>件数のみ</b>としています。"
    )
)

b.append(art(5, "名称・認定マークの使い方"))
b.append(
    table(
        [
            tr("1", "「タダカヨ認定事業者」の名称と認定マークは、<b>認定の期間中</b>に限り使えます"),
            tr(
                "2",
                "表示するときは、<b>認定番号を併記</b>してください。"
                "認定マークには事業者名と認定番号が入っているので、そのままお使いいただけば満たせます"
                f'<br><span style="font-size:9pt;color:{MUTED}">例：タダカヨ認定事業者　タダトモ TDT-003</span>',
                bg="#FCFCFC",
            ),
            tr(
                "3",
                "名刺・自社サイト・チラシ・提案書に使えます。<b>タダカヨの事業であるかのような表示</b>"
                "（タダカヨのロゴを自社のものとして使う、タダカヨの名前で契約するなど）はできません",
            ),
            tr(
                "4",
                "<b>国の認定であるかのような表示</b>はできません。「厚生労働省認定」「国の指定事業者」"
                "などの表現は使えません",
                bg="#FCFCFC",
            ),
            tr("5", "認定が終わったときは、<b>速やかに表示を取り下げて</b>ください"),
        ]
    )
)
# 認定マークの見本（何を使えるのかを、文章だけでなく現物で示す）
# ※ Google ドキュメントは「表の中の表」を文字列に潰してしまうので、必ず1段の表で作る
b.append(
    f'<table style="width:100%;border-collapse:collapse;margin:12pt 0"><tr>'
    f'<td style="width:4pt;background-color:{RED};border:none"></td>'
    f'<td style="width:116pt;background-color:{PINK};padding:12pt 0 12pt 16pt;'
    f'border:none;text-align:center;vertical-align:middle">'
    f'{badge("tadatomo-generic", 96)}'
    f'<p style="margin:4pt 0 0 0;font-family:{SANS};font-size:8.5pt;color:{MUTED}">'
    f"マークの見本</p></td>"
    f'<td style="background-color:{PINK};padding:12pt 16pt;border:none;'
    f'vertical-align:middle;font-family:{SANS};font-size:10.5pt;line-height:1.8">'
    f"<b>お渡しする認定マーク</b><br>"
    f"認定が決まったら、<b>事業者名と認定番号が入った専用のマーク</b>を PNG（背景透過）でお渡しします。"
    f"名刺に 15mm ほどの大きさで置いても「タダトモ」が読めるようにしています。"
    f'<br><span style="font-size:9pt;color:{MUTED}">※ 上は見本です。実際は認定番号が TDT-001 のように入ります</span>'
    f"</td></tr></table>"
)

b.append(art(6, "個人情報の取扱い"))
b.append(
    table(
        [
            tr("1", "認定事業者が自ら獲得した案件で知り得た個人情報は、<b>認定事業者の責任</b>で取り扱います"),
            tr(
                "2",
                "タダカヨが認定事業者に案件を紹介し、事業所や利用者に関する情報を渡す場合は、"
                "<b>別途「個人情報の取扱いに関する覚書」</b>を結びます",
                bg="#FCFCFC",
            ),
            tr(
                "3",
                "個人情報の漏えい・紛失・不正利用が起きた、またはそのおそれがあるときは、"
                "<b>速やかにタダカヨへ連絡</b>してください",
            ),
        ]
    )
)

b.append(art(7, "タダカヨの案件を受ける場合"))
b.append(
    table(
        [
            tr(
                "1",
                "タダカヨが自ら受けた案件を認定事業者へ依頼する場合は、<b>別途「業務委託基本契約」</b>を結び、"
                "報酬・交通費・支払いの方法を定めます",
            ),
            tr(
                "2",
                "認定事業者は、案件ごとに「<b>自社の事業として行う</b>」か"
                "「<b>タダメンとしてタダカヨの案件を行う</b>」かを選べます",
                bg="#FCFCFC",
            ),
            tr(
                "3",
                "遠方など採算の合いにくい案件については、交通費の支給や、近くの認定事業者への"
                "振り分けなどを、その都度相談します",
            ),
        ]
    )
)

b.append(art(8, "認定の期間と更新"))
b.append(
    table(
        [
            tr(
                "1",
                "認定の期間は、<b>認定日から2027年3月31日まで</b>です"
                f'<br><span style="font-size:9pt;color:{MUTED}">※ 2026年度は試行のため、全社で期間を揃えています</span>',
            ),
            tr(
                "2",
                "期間が終わる1か月前までに、タダカヨから<b>更新のご案内</b>をします。"
                "双方から特に申し出がなければ、<b>1年ごとに更新</b>します",
                bg="#FCFCFC",
            ),
            tr("3", "更新の際は、その年の支援実績と、制度の見直し内容をあわせてご確認いただきます"),
        ]
    )
)

b.append(art(9, "認定の終了"))
b.append(
    table(
        [
            tr("1", "認定事業者から申し出があったときは、<b>いつでも認定を終えられます</b>"),
            tr(
                "2",
                "タダカヨは、次のいずれかに当てはまるとき、<b>双方で話し合ったうえで</b>認定を終えることがあります。"
                "あらかじめ理由をお伝えし、直せるものは直していただく機会を設けます"
                "<br>・第3条の守っていただきたいことに反する<b>重大な行為</b>があったとき"
                "<br>・反社会的勢力に該当することが判明したとき"
                "<br>・事業を停止したとき",
                bg="#FCFCFC",
            ),
            tr(
                "3",
                "<b>第4条の実績報告が滞っていることだけを理由に、認定を終えることはしません。</b>"
                "状況をうかがい、続け方を一緒に考えます",
            ),
            tr(
                "4",
                "認定が終わったあとは、名称・認定マークの表示を取り下げ、アカウントの利用も終了します。"
                "第3条6項（知り得た情報を漏らさないこと）は、認定が終わったあとも続きます",
                bg="#FCFCFC",
            ),
        ]
    )
)

b.append(art(10, "この制度が試行であること"))
b.append(
    table(
        [
            tr("1", "この制度は2026年度の試行として運用します。<b>条件が変わることがあります</b>"),
            tr(
                "2",
                "変わるときは、<b>変更する日の1か月前まで</b>に、専用チャットスペースとメールでお知らせします",
                bg="#FCFCFC",
            ),
            tr("3", "変更に同意いただけない場合は、認定を終えることができます"),
        ]
    )
)

b.append(art(11, "相談"))
b.append(
    p(
        "この誓約書に書かれていないことや、判断に迷うことが起きたときは、"
        "どちらかが一方的に決めるのではなく、<b>話し合って決めます</b>。"
    )
)

b.append(sec("署", "記名・署名"))
b.append(
    # 表の中に表を置くと Docs が潰すので、1段の表で「文面＋角印」を並べる
    f'<table style="width:100%;border-collapse:collapse;margin:14pt 0"><tr>'
    f'<td style="width:4pt;background-color:{RED};border:none"></td>'
    f'<td style="background-color:{GRAY};padding:12pt 0 12pt 12pt;border:none;'
    f'vertical-align:top;font-family:{SANS};font-size:10.5pt;line-height:1.9">'
    f'<span style="font-size:11pt;font-weight:700;color:{RED}">タダカヨ</span><br>'
    "NPO法人タダカヨ<br>理事長　佐藤 拡史<br>"
    "〒143-0014 東京都大田区大森中二丁目1番20-1001号<br>"
    "介護情報基盤伴走支援事業　kjk-staff@tadakayo.jp"
    f'<p style="margin:8pt 0 0 0;font-family:{SANS};font-size:9pt;color:{MUTED};'
    f'line-height:1.8">※ この誓約書は、上記の記名と角印をもってタダカヨの意思表示とし、'
    "認定証の交付をもって認定の成立とします。</p></td>"
    f'<td style="width:86pt;background-color:{GRAY};padding:12pt 12pt 12pt 0;'
    f'border:none;text-align:right;vertical-align:middle">{SEAL}</td>'
    f"</tr></table>"
)
b.append(p("<b>認定事業者</b>", size="11pt", margin="14pt 0 4pt 0"))
b.append(p("上記の内容を確認し、これを守ることに同意します。"))
b.append(
    table(
        [
            field("法人名"),
            field("代表者または主担当者の役職・氏名"),
            f'<tr><td style="width:38%;background-color:{GRAY};padding:8pt 9pt;'
            f'border:1pt solid #D9D9D9;font-family:{SANS};font-size:10pt;font-weight:700">署名日</td>'
            f'<td style="padding:8pt 9pt;border:1pt solid #D9D9D9;font-family:{SANS};'
            f'font-size:10pt;color:{MUTED}">オンライン署名時に自動で記録されます</td></tr>',
        ]
    )
)
b.append(FOOT)
(OUT / "02_誓約書兼同意書.html").write_text(page("誓約書兼同意書", "".join(b)), encoding="utf-8")


# ============================================================ 03 認定証
CERT_NAME = "株式会社介護ITコンシェルジュ"
cert = []
cert.append(
    f'<table style="width:100%;border-collapse:collapse;margin:0"><tr>'
    f'<td style="border:3pt solid {RED};padding:0">'
    f'<table style="width:100%;border-collapse:collapse"><tr>'
    f'<td style="border:1pt solid {RED};padding:20pt 30pt;background-color:#FFFFFF">'
    # ---- 中身 ----
    f'<p style="margin:0;text-align:center;font-family:{SANS};font-size:9pt;'
    f'letter-spacing:4pt;color:{RED}">NPO法人タダカヨ</p>'
    f'<p style="margin:8pt 0 0 0;text-align:center;font-family:{SERIF};font-size:30pt;'
    f'font-weight:700;letter-spacing:14pt;color:{INK}">認定証</p>'
    f'<p style="margin:4pt 0 0 0;text-align:center;font-family:{SANS};font-size:9pt;'
    f'letter-spacing:2pt;color:{MUTED}">CERTIFICATE OF PARTNERSHIP</p>'
    f'<p style="margin:10pt 0 0 0;text-align:right;font-family:{SANS};font-size:10pt;'
    f'color:{MUTED}">認定番号　<span style="color:{RED};font-weight:700;font-size:12pt">TDT-003</span></p>'
    f'<table style="width:100%;border-collapse:collapse;margin:10pt 0 0 0"><tr>'
    f'<td style="border:none;border-bottom:1.5pt solid {INK};padding:4pt 0 6pt 0;'
    f'font-family:{SERIF};font-size:19pt;font-weight:700">{CERT_NAME}　殿</td>'
    f"</tr></table>"
    f'<p style="margin:14pt 0 0 0;font-family:{SANS};font-size:11.5pt;line-height:1.9">'
    f"貴事業者を、介護情報基盤の導入支援を担う</p>"
    f'<table style="width:100%;border-collapse:collapse;margin:8pt 0"><tr>'
    f'<td style="background-color:{PINK};border-left:5pt solid {RED};padding:10pt 18pt">'
    f'<p style="margin:0;text-align:center;font-family:{SERIF};font-size:17pt;'
    f'font-weight:700;color:{RED}">タダカヨ認定事業者「タダトモ」</p></td></tr></table>'
    f'<p style="margin:0 0 12pt 0;font-family:{SANS};font-size:11.5pt;line-height:1.9">'
    f"として認定します。</p>"
    # 認定日・有効期限（左）と、その事業者の認定マーク（右）を横に並べる
    f'<table style="width:100%;border-collapse:collapse;margin:0 0 12pt 0"><tr>'
    f'<td style="border:none;padding:0;vertical-align:middle">'
    f'<table style="width:74%;border-collapse:collapse;margin:0">'
    f'<tr><td style="width:34%;background-color:{GRAY};padding:7pt 10pt;'
    f'border:1pt solid #D9D9D9;font-family:{SANS};font-size:10pt;font-weight:700">認定日</td>'
    f'<td style="padding:7pt 10pt;border:1pt solid #D9D9D9;font-family:{SANS};'
    f'font-size:10pt">2026年9月6日</td></tr>'
    f'<tr><td style="background-color:{GRAY};padding:7pt 10pt;border:1pt solid #D9D9D9;'
    f'font-family:{SANS};font-size:10pt;font-weight:700">有効期限</td>'
    f'<td style="padding:7pt 10pt;border:1pt solid #D9D9D9;font-family:{SANS};'
    f'font-size:10pt">2027年3月31日</td></tr></table>'
    f"</td>"
    f'<td style="border:none;width:104pt;padding:0 0 0 16pt;text-align:right;'
    f'vertical-align:middle">'
    f'{badge("tadatomo-tdt-003", 96, alt="タダカヨ認定事業者「タダトモ」認定番号 TDT-003 株式会社介護ITコンシェルジュ")}'
    f"</td></tr></table>"
    f'<p style="margin:0;font-family:{SANS};font-size:10.5pt;line-height:1.9">'
    f"貴事業者が、介護現場でITを活かし、その経験を地域の事業所へ分けてこられたことを"
    f"確認しました。介護情報基盤への対応に困っている事業所を、地域で支えていただくよう"
    f"お願いいたします。</p>"
    f'<p style="margin:18pt 0 0 0;text-align:center;font-family:{SANS};font-size:11pt">'
    f"2026年9月6日</p>"
    f'<table style="width:100%;border-collapse:collapse;margin:10pt 0 0 0"><tr>'
    f'<td style="border:none;width:26%;padding:0"></td>'
    f'<td style="border:none;text-align:right;vertical-align:bottom;padding:0 10pt 0 0">'
    f'<p style="margin:0;font-family:{SERIF};font-size:13pt;font-weight:700">NPO法人タダカヨ</p>'
    f'<p style="margin:6pt 0 0 0;font-family:{SERIF};font-size:15pt;font-weight:700">'
    f"理事長　佐藤 拡史</p></td>"
    f'<td style="border:none;width:86pt;text-align:left;vertical-align:middle;padding:0">'
    f"{SEAL}</td>"
    f"</tr></table>"
    f'<table style="width:100%;border-collapse:collapse;margin:14pt 0 0 0"><tr>'
    f'<td style="border:none;border-top:1pt solid {RED};padding:6pt 0 0 0;text-align:center;'
    f'font-family:{SANS};font-size:8.5pt;color:{MUTED}">'
    f"〒143-0014 東京都大田区大森中二丁目1番20-1001号　介護情報基盤伴走支援事業　kjk-staff@tadakayo.jp"
    f"</td></tr></table>"
    f"</td></tr></table></td></tr></table>"
)

b = []
b.append(head("認定証", "認定事業者へお渡しする A4・1枚の認定証です", "CERTIFICATE"))
b.append(
    box(
        "<b>これは検討用のサンプルです。</b>　実際は CRM から A4・1枚の PDF で発行し、"
        "額に入れて掲示できる体裁にします。下の枠の中が、そのまま印刷される部分です。<br>"
        f'<span style="color:{MUTED}">作成 2026-09-06 ／ サンプル v0.3 ／ 未承認（次田さん確認待ち）</span>',
        bg=GRAY,
        border="#BBBBBB",
    )
)
b.append(p("<b>■ 印刷される面（A4・縦）</b>　次のページに、そのまま印刷される1枚を置いています。",
           size="11pt", margin="18pt 0 8pt 0"))
# 認定証は1枚に収めたいので前後で改ページする（Google ドキュメント取り込みで効く）
PB = '<hr style="page-break-before:always;display:none">'
b.append(PB)
b.append("".join(cert))
b.append(PB)

b.append(sec("1", "決めておくこと"))
b.append(
    table(
        [
            th("項目", "内容", "補足", w=["24%", "34%", "42%"]),
            tr("認定番号の形式", "<b>TDT-003</b>", "TaDaTomo の頭文字＋3桁。999社まで持てます（2026-09-06 決定）"),
            tr("有効期限", "<b>2027年3月31日</b>", "2026年度は試行のため全社で揃えます（2026-09-06 決定）", bg="#FCFCFC"),
            tr("記名", "<b>理事長　佐藤 拡史</b>", "角印は請求書・発注書と同じものを使います"),
            tr("サイズ・向き", "A4・縦", "額に入れて掲示できる想定です", bg="#FCFCFC"),
            tr("発行の方法", "CRM の認定事業者画面から PDF を発行", "請求書・領収書と同じ仕組みを流用します"),
            tr("更新時", "新しい有効期限で再発行", "<b>認定番号は変えません</b>", bg="#FCFCFC"),
        ]
    )
)

b.append(sec("2", "認定マーク"))
b.append(
    p(
        "名刺・自社サイト・チラシに使う小さなバッジ画像です。認定証とは別に用意します。"
        "<b>仮デザインができました</b>（2026-09-06）。事業者ごとに名前と認定番号を入れて発行します。"
    )
)
b.append(
    f'<table style="width:100%;border-collapse:collapse;margin:10pt 0"><tr>'
    + "".join(
        f'<td style="border:1pt solid #D9D9D9;padding:12pt 8pt;text-align:center;'
        f'background-color:#FFFFFF;vertical-align:top">'
        f"{badge(f, 92, alt=cap)}"
        f'<p style="margin:6pt 0 0 0;font-family:{SANS};font-size:9pt;color:{MUTED}">{cap}</p>'
        f"</td>"
        for f, cap in [
            ("tadatomo-generic", "見本（TDT-000）"),
            ("tadatomo-tdt-001", "TDT-001 株式会社279"),
            ("tadatomo-tdt-002", "TDT-002 株式会社プラスエス"),
            ("tadatomo-tdt-003", "TDT-003 株式会社介護ITコンシェルジュ"),
        ]
    )
    + "</tr></table>"
)
b.append(
    table(
        [
            th("項目", "内容", w=["24%", "76%"]),
            tr("表示例", "タダカヨ認定事業者　タダトモ TDT-003<br>"
                f'<span style="font-size:9pt;color:{MUTED}">※ バッジ本体には「タダトモ」「TDT-003」の2行のみ</span>'),
            tr("色", f'タダカヨレッド <span style="color:{RED};font-weight:700">#E33535</span>', bg="#FCFCFC"),
            tr("使用条件", "誓約書 第5条のとおり（認定期間中のみ・認定番号を併記・終了後は取り下げ）"),
        ]
    )
)
b.append(
    box(
        "ChatGPT への依頼プロンプトは、同じフォルダの"
        "「<b>04_認定マーク_ChatGPT依頼プロンプト</b>」に用意しています。"
    )
)

b.append(sec("3", "発行の流れ（システム側）"))
b.append(
    table(
        [
            th("　", "手順", w=["8%", "92%"]),
            tr("1", "CRM の認定事業者一覧で「<b>認定証を発行</b>」を押す"),
            tr("2", "<code>partners</code> に <code>certNo</code>（認定番号）・<code>certifiedAt</code>（認定日）・"
                "<code>certExpiresAt</code>（有効期限）を保存", bg="#FCFCFC"),
            tr("3", "PDF を作成して認定事業者へメール送付（請求書・領収書と同じ経路）"),
            tr("4", "LP の認定事業者一覧に、同じ認定番号で掲載", bg="#FCFCFC"),
        ]
    )
)
b.append(
    box(
        "<b>いまの状態</b><br>"
        "LP には TDT-001（株式会社279）・TDT-002（株式会社プラスエス）・"
        "TDT-003（株式会社介護ITコンシェルジュ）を手書きで載せています。"
        f"認定番号を <code>partners</code> の <code>certNo</code> に持たせたら、LP 側もそこから出すようにします。",
        bg=GRAY,
        border="#BBBBBB",
    )
)
b.append(FOOT)
(OUT / "03_認定証.html").write_text(page("認定証", "".join(b)), encoding="utf-8")


# ============================================ 04 認定マーク依頼プロンプト
def code(text):
    # Google ドキュメント取り込みでは white-space:pre-wrap が効かないため、
    # 改行は <br>、行頭の空白は &nbsp; に変換して見た目を保つ。
    lines = []
    for line in text.split("\n"):
        stripped = line.lstrip(" ")
        indent = "&nbsp;" * (len(line) - len(stripped))
        lines.append(indent + stripped if stripped else "&nbsp;")
    return (
        f'<table style="width:100%;border-collapse:collapse;margin:10pt 0"><tr>'
        f'<td style="background-color:#F5F5F5;border:1pt solid #DDDDDD;padding:12pt 14pt;'
        f"font-family:'Courier New',monospace;font-size:9pt;line-height:1.6\">"
        + "<br>".join(lines)
        + "</td></tr></table>"
    )


PROMPT_JA = """介護分野のNPO法人「タダカヨ」が、地域で介護情報基盤の導入支援を担う事業者に与える
「認定マーク（バッジ）」をデザインしてください。名刺・自社サイト・チラシに小さく載せます。

【この法人について】
- NPO法人タダカヨ。「タダでカイゴをヨクしよう」を掲げ、介護現場のIT活用を無料〜低額で支援している
- 堅苦しくなく、現場の職員に親しまれる雰囲気。ただし認定マークなので信頼感も必要

【必ず守ってほしいこと】
- 色は次の2色だけ。メイン＝赤 #E33535／サブ＝淡いピンク #FFE4EC。白と黒は可
- 文字要素:「タダトモ」を主役にし、その下に小さく「タダカヨ認定事業者」と認定番号「TDT-003」
- 形は円形または盾形（バッジらしい形）
- 背景は透過（PNG）。白背景の上でも、赤背景の上でも成立すること
- 小さくしても読めること。名刺に 15mm 角で載せたとき「タダトモ」がはっきり読めること
  （「タダカヨ認定事業者」は小さくて読めなくてもよい）
- 平面的なフラットデザイン。写実的な質感・グラデーション・立体的な影は使わない
- 人物・キャラクターは入れない（法人キャラクターは別に存在するため、マークには入れない）
- 英語表記は入れない。日本語のみ

【避けてほしいこと】
- 金色・銀色の「賞」のような装飾（表彰状のイメージにしない）
- 医療機関の十字マーク、ハートの多用（介護＝ハートという安易な表現を避ける）
- 月桂樹の葉で囲む定番の勲章デザイン
- 3D風、光沢、ドロップシャドウ

【出してほしいもの】
- 案を3つ。それぞれ方向性を変える（例: 文字を主役にした案／シンボルを主役にした案／枠の形で見せる案）
- 各案について、白背景版と赤背景版（白ヌキ）の2パターン
- 最後に、どの案がなぜ良いかの短い説明"""

PROMPT_EN = """Design a certification badge for "Tadakayo", a Japanese non-profit that helps
elder-care providers adopt IT. The badge is given to partner companies that
provide on-site support in their region. It will be printed small on business
cards and websites.

Requirements:
- Colors: ONLY red #E33535 (primary) and pale pink #FFE4EC (secondary), plus white and black
- Japanese text on the badge: "タダトモ" as the main element, with smaller
  "タダカヨ認定事業者" and the number "TDT-003" below
- Shape: circular or shield-shaped badge
- Flat vector design. No gradients, no 3D, no gloss, no drop shadows
- Transparent background (PNG). Must work on white and on red backgrounds
- Must stay legible at 15mm on a business card
- No people or mascot characters
- No English text

Avoid:
- Gold/silver "award" ornamentation, laurel wreaths, medal styling
- Medical cross symbols or heavy use of hearts

Deliver 3 distinct concepts (text-led / symbol-led / frame-led),
each in a white-background version and a red-background (knockout white) version."""

b = []
b.append(head("認定マーク 依頼プロンプト", "ChatGPT にそのまま貼って、バッジのデザイン案を出すための文面です", "DESIGN BRIEF"))
b.append(
    box(
        "名刺・自社サイト・チラシに載せる<b>小さなバッジ画像</b>をつくるための依頼文です。"
        "下の枠をまるごとコピーして、ChatGPT に貼ってください。<br>"
        f'<span style="color:{MUTED}">作成 2026-09-06 ／ v0.3</span>',
        bg=GRAY,
        border="#BBBBBB",
    )
)

b.append(sec("0", "いまの仮デザイン"))
b.append(
    f'<table style="width:100%;border-collapse:collapse;margin:10pt 0"><tr>'
    f'<td style="border:none;width:130pt;padding:0;text-align:center;vertical-align:middle">'
    f'{badge("tadatomo-generic", 110)}</td>'
    f'<td style="border:none;padding:0 0 0 16pt;vertical-align:middle;'
    f'font-family:{SANS};font-size:10.5pt;line-height:1.9">'
    f"2026-09-06 に受け取った<b>仮のデザイン</b>です。上に「タダトモ」、中央に二人が並んで歩く円、"
    f"下に「タダカヨ認定事業者」と認定番号が入っています。<br>"
    f"<b>この形で概ね進める前提</b>で、下のプロンプトは<b>詰めたいところを直すため</b>に使ってください。"
    f'<br><span style="font-size:9pt;color:{MUTED}">残っている論点：中央の「2026」の扱い'
    f"（有効期限が2027年3月31日なので、年度表記にするか外すか）【要確定】</span>"
    f"</td></tr></table>"
)

b.append(sec("1", "そのまま貼るプロンプト（日本語）"))
b.append(code(PROMPT_JA))

b.append(sec("2", "そのまま貼るプロンプト（英語）"))
b.append(p(f'<span style="color:{MUTED}">日本語で画像生成が安定しないときに使ってください。</span>'))
b.append(code(PROMPT_EN))

b.append(sec("3", "添えると精度が上がるもの"))
b.append(
    table(
        [
            th("　", "添えるもの", "ひとこと", w=["8%", "38%", "54%"]),
            tr(
                "1",
                "<b>タダカヨのロゴ画像</b><br>"
                f'<span style="font-size:9pt;color:{MUTED}">_ブランド素材/ロゴ/tadakayo_logo.png</span>',
                "「このロゴと並べても喧嘩しないマークにしてください」と添えると、雰囲気が揃います",
            ),
            tr(
                "2",
                "<b>LP の認定事業者セクションの画面</b><br>"
                f'<span style="font-size:9pt;color:{MUTED}">https://kjk.tadakayo.jp/#certified</span>',
                "実際に並ぶ場所を見せると、サイズ感と色の相性を踏まえた案が出ます",
                bg="#FCFCFC",
            ),
            tr(
                "3",
                "<b>追加の一言</b>",
                "案が出たら「<b>名刺に15mmで置いたときのシミュレーション画像</b>も出して」と"
                "頼むと、実用性を確認できます",
            ),
        ]
    )
)

b.append(sec("4", "できあがったあと、こちらでやること"))
b.append(
    table(
        [
            th("　", "やること", w=["8%", "92%"]),
            tr("1", "認定証（03の書類）と LP の認定事業者カードにマークを入れる"),
            tr("2", "<code>partners</code> の認定番号と連動させ、CRM から認定証 PDF を発行するときに差し込む", bg="#FCFCFC"),
            tr("3", "ファイルを <code>_ブランド素材/</code> に置き、使用条件（誓約書 第5条）と一緒に管理する"),
        ]
    )
)
b.append(FOOT)
(OUT / "04_認定マーク依頼プロンプト.html").write_text(
    page("認定マーク 依頼プロンプト", "".join(b)), encoding="utf-8"
)

for f in sorted(OUT.glob("*.html")):
    print(f.name, f.stat().st_size)
