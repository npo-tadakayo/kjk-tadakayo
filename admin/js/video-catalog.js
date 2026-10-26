// admin/js/video-catalog.js — 動画マニュアルの目録（SSOT）
// 動画本体は Firebase Storage `training/` に置く（storage.rules で @tadakayo.jp だけ読める）。
// 正本（mp4/srt）は共有ドライブ「TM_介護情報基盤を広め隊/02_マニュアル・ガイドブック/研修動画/」
//   CRM: CRM操作説明_全7単元/ ／ 伴走支援: 研修動画/ 直下のガイドブック PART0〜3（ご案内動画は制作フォルダ。sync スクリプト参照）。
// 差し替え手順: scripts/sync-training-videos.py（字幕→vtt 変換とアップロードをまとめて行う）→ ここの version/duration を直す。
// group: "learn"＝はじめての方（L-*）／"guide"＝伴走支援の手順（G*）／"crm"＝CRMの使い方／"notice"＝改修のお知らせ（notice: true）。label は画面の見出し（「単元1」「PART0」）、mark は一覧の丸の中の文字。
// note は再生欄の下の注記（無ければ区分ごとの決まり文句）。notice: true は「改修のお知らせ」（新人の必修にしない。2026-10-24 育成コース）。
export const VIDEO_STORAGE_PREFIX = "training/";

export const GROUPS = [
  { id: "learn", title: "はじめての方", icon: "ti-school", desc: "育成コースの進め方・伴走支援者になるまで・10の約束" },
  { id: "guide", title: "伴走支援の手順", icon: "ti-book", desc: "介護情報基盤とは何か、支援先で何をどの順に設定するか（ガイドブック）" },
  { id: "crm", title: "CRMの使い方", icon: "ti-device-desktop", desc: "案件・伴走支援の記録・Web申し込み・発注・請求" },
  { id: "notice", title: "改修のお知らせ", icon: "ti-speakerphone", desc: "画面が変わったときの説明（一部は旧画面）" },
];

// 目的別のおすすめの順番（2026-10-26 動画ページの整理）。押すとこの順で一覧を出し、「次は」もこの順で案内する
export const PATHS = [
  { id: "new", title: "はじめて伴走支援に入る", icon: "ti-route", ids: ["L-0", "L-A", "L-B", "G-A", "G0", "G1", "G2", "G3", "U1", "U2", "U7", "U8"] },
  { id: "supply", title: "発注・出荷を担当する", icon: "ti-truck", ids: ["U3", "U5"] },
  { id: "billing", title: "請求・入金を担当する", icon: "ti-receipt", ids: ["U4"] },
  { id: "admin", title: "管理者・トレーナー", icon: "ti-user-cog", ids: ["U6", "L-T"] },
];

const GUIDE = [
  // 育成コースの使い方（2026-10-25・次田さんの声・架空データで撮影。字幕は映像に焼き込み済みなので vtt は置かない）
  { id: "L-0", label: "進め方", mark: "進", title: "育成コースの進め方（新人の方へ）", duration: "2分27秒", version: "v1.0", updated: "2026-10-25",
    desc: "育成コースの開き方、次にやること、動画・確認テスト・10の約束、練習モードの判定、OJTに入れます、評価シート、独り立ち", file: "learn-course",
    roles: ["新人"], note: "新しく伴走支援に入る方が、最初に見る動画です。育成コースの画面の使い方を説明しています（画面は架空のデータです）。" },
  { id: "L-T", label: "見守り方", mark: "守", title: "新人の見守り方（トレーナー・管理者の方へ）", duration: "1分56秒", version: "v1.0", updated: "2026-10-25",
    desc: "練習生ロールの設定、受講中の方の一覧、OJTの実施の記録、評価シート（8つの観点）、バッジの付与、スタッフへのロール変更", file: "learn-trainer",
    roles: ["トレーナー", "管理者"], note: "トレーナーと管理者向けの動画です。新人の方の進み具合の見方から、評価・バッジの付与までを説明しています（画面は架空のデータです）。" },
  // 育成コース STEP1 の新しい動画（2026-10-24）。長さは仮（mp4 ができたら実測値に直す）
  { id: "L-A", label: "はじめに", mark: "始", title: "伴走支援者になるまで", duration: "2分30秒", version: "v1.0", updated: "2026-10-24",
    desc: "独り立ちまでの7つのステップ、見学者・トレーニング生・伴走支援者・トレーナー、OJTと評価シート、報酬とバッジの意味", file: "learn-intro",
    roles: ["全員"], note: "育成コースの STEP1 で見る動画です。独り立ちまでの道のりと、立場・報酬・バッジの意味を説明しています。" },
  { id: "L-B", label: "約束", mark: "約", title: "伴走支援者の約束", duration: "4分07秒", version: "v1.1", updated: "2026-10-26",
    desc: "個人情報・安全・困ったときの止め方。10の約束（承諾書§4〜§7に合わせたもの）", file: "learn-pledge",
    roles: ["全員"], note: "育成コースの STEP1 で見る動画です。事業所と取り交わす伴走支援承諾書（§4〜§7）に合わせた、伴走支援者が必ず守る10の約束です。" },
  { id: "G-A", label: "ご案内", mark: "案", title: "事業所向け「伴走支援のご案内」", duration: "3分30秒", version: "v1.1", updated: "2026-10-26",
    desc: "事業所の方にお送りしている動画。4つの段階、事前に準備するもの、当日のお願い、設定中の注意（証明書の画面で「キャンセル」を押さない）、助成金は後払い", file: "guide-annai",
    roles: ["全員"], note: "申し込みのあった事業所の方にお送りしている動画です。事業所が何を聞いているかを知っておくために見てください。" },
  { id: "G0", label: "PART0", mark: "0", title: "まるわかり編", duration: "11分14秒", version: "Ver.2026-1.1", updated: "2026-08-16",
    desc: "介護情報基盤の3つの層、ケアプーとの関係、公式の手順、導入パターンの診断、助成金、チェックリスト", file: "guide-part0",
    roles: ["全員"] },
  { id: "G1", label: "PART1", mark: "1", title: "介護情報基盤ポータル編", duration: "10分18秒", version: "Ver.2026-1.1", updated: "2026-08-16",
    desc: "STEP 00〜03：初回の利用登録、アプリの利用申請、申請台数の決め方。トークスクリプトとよくある質問", file: "guide-part1",
    roles: ["全員"] },
  { id: "G2", label: "PART2", mark: "2", title: "アプリ＋ICカードリーダー編", duration: "5分50秒", version: "Ver.2026-1.1", updated: "2026-08-16",
    desc: "STEP 04：マイナ資格確認アプリとカードリーダー（閲覧する事業所だけ）", file: "guide-part2",
    roles: ["全員"] },
  { id: "G3", label: "PART3", mark: "3", title: "介護WEBサービス編", duration: "11分44秒", version: "Ver.2026-1.1", updated: "2026-08-16",
    desc: "STEP 05〜10：介護WEBサービスの設定と、ケアプーからの引っ越し", file: "guide-part3",
    roles: ["全員"] },
].map((v) => ({ ...v, group: v.id.startsWith("L-") ? "learn" : "guide" }));

const CRM = [
  { id: "U1", no: 1, title: "はじめに・全体像", duration: "5分25秒", version: "v1.2", updated: "2026-09-14",
    desc: "何のためのシステムか。5つの段階・13ステータス・4つのメニュー", file: "crm-u1",
    roles: ["全員"] },
  { id: "U2", no: 2, title: "案件を進める", duration: "6分42秒", version: "v1.2", updated: "2026-09-14",
    desc: "案件一覧／新規登録／ステータス／記録／カンバン／報告書PDF／AI", file: "crm-u2",
    roles: ["全員"] },
  { id: "U3", no: 3, title: "発注と出荷", duration: "5分59秒", version: "v1.2", updated: "2026-09-14",
    desc: "ABサークルへの発注、入荷登録、出荷、直送、送料", file: "crm-u3",
    roles: ["供給管理"] },
  { id: "U4", no: 4, title: "請求・入金・経理報告", duration: "5分49秒", version: "v1.2", updated: "2026-09-14",
    desc: "請求書、領収証（用途区分A/B）、入金、未集金、返金明細書", file: "crm-u4",
    roles: ["供給管理", "経理"] },
  { id: "U5", no: 5, title: "認定事業者とのやりとり", duration: "3分40秒", version: "v1.3", updated: "2026-09-14",
    desc: "ポータル登録、発注ファイルの取り込み、卸価格", file: "crm-u5",
    roles: ["供給管理"] },
  { id: "U6", no: 6, title: "設定と管理", duration: "5分05秒", version: "v1.2", updated: "2026-09-14",
    desc: "ユーザー管理、通知先、書類、紹介元の種類、料金・送料", file: "crm-u6",
    roles: ["管理者"] },
  { id: "U7", no: 7, title: "伴走支援の記録", duration: "6分17秒", version: "v1.2", updated: "2026-09-14",
    desc: "事前確認 → 当日 → 書類チェック → 申請情報 → アフター", file: "crm-u7",
    roles: ["全員"] },
  { id: "U8", no: 8, title: "Webからの申し込み", duration: "8分14秒", version: "v1.2", updated: "2026-09-20",
    desc: "問い合わせ → 見積もり → 申し込み → 出荷の下書き。見積もりカード、内容を変更する。9/14 追加: ご希望の3択・複数事業所まとめ見積もり・スタッフの見積もり作成と見積書PDF。9/20 追加: 法人あての合計見積書", file: "crm-u8",
    roles: ["全員"] },
  { id: "U9", no: 9, title: "10月の改修のお知らせ", duration: "5分10秒", version: "v1.0", updated: "2026-10-20",
    desc: "2026-10-19 の改修。初期連絡5営業日、Chatの投稿先4つ・通知に地域、発送済にする→出荷指示の投稿、レターパックの宛名印刷（A4）、追跡番号の写真、請求書の発行日と支払期限（発行日から14日）、失注の理由、訪問予定日、事業所の一覧。※2026-10-21 から出荷は「出荷を依頼する」→「発送済にする」の2段階になりました（動画は旧画面）", file: "crm-u9",
    roles: ["全員"], notice: true },
  { id: "U10", no: 10, title: "事業所の編集と統合", duration: "4分40秒", version: "v1.0", updated: "2026-10-24",
    desc: "2026-10-24 の改修。事業所画面の「…」から事業所名・法人名・住所を直す、重複した事業所を統合する（取り消し・続きの実行もできる）、重複の候補。伴走支援承諾書の表示（未依頼 → 依頼方法未決定 → 依頼済み・署名待ち → 署名済み）", file: "crm-u10",
    roles: ["全員"] },
].map((v) => ({ ...v, group: v.notice ? "notice" : "crm", label: `単元${v.no}`, mark: String(v.no) }));

export const VIDEOS = [...GUIDE, ...CRM];

export function findPath(id) {
  return PATHS.find((p) => p.id === id) || null;
}

export function findVideo(id) {
  return VIDEOS.find((v) => v.id === id) || null;
}
