// admin/js/video-catalog.js — 動画マニュアルの目録（SSOT）
// 動画本体は Firebase Storage `training/` に置く（storage.rules で @tadakayo.jp だけ読める）。
// 正本（mp4/srt）は共有ドライブ「TM_介護情報基盤を広め隊/02_マニュアル・ガイドブック/研修動画/CRM操作説明_全7単元/」。
// 差し替え手順: scripts/sync-training-videos.py（srt→vtt 変換とアップロードをまとめて行う）→ ここの version/duration を直す。
export const VIDEO_STORAGE_PREFIX = "training/";

export const VIDEOS = [
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
    roles: ["全員"] },
  { id: "U10", no: 10, title: "事業所の編集と統合", duration: "4分40秒", version: "v1.0", updated: "2026-10-24",
    desc: "2026-10-24 の改修。事業所画面の「…」から事業所名・法人名・住所を直す、重複した事業所を統合する（取り消し・続きの実行もできる）、重複の候補。伴走支援承諾書の表示（未依頼 → 依頼方法未決定 → 依頼済み・署名待ち → 署名済み）", file: "crm-u10",
    roles: ["全員"] },
];

export function findVideo(id) {
  return VIDEOS.find((v) => v.id === id) || null;
}
