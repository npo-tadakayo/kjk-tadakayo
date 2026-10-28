import "/js/emu.js"; // ローカルのエミュレーター接続（localhost かつ ?emu=1 のときだけ。本番では何もしない）
import { doc, getDoc, getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { setupModeUi } from "/js/mode.js";

// ログインユーザーのロール情報を取得（未登録ならnull）
// ロールは常に本番DBの users で決まる。練習モードの画面は db が練習DBなので、
// 同じ app の既定DB（本番）を取り直して読む（2026-10-20 テストモード）。
export async function getMyRole(db, email){
  try{
    const prod = db && db.app ? getFirestore(db.app) : db;
    const s = await getDoc(doc(prod, "users", email));
    if(s.exists()){
      const d = s.data();
      return { role: d.role || "staff", active: d.active !== false, name: d.name || "" };
    }
  }catch(e){ console.warn("getMyRole error:", e.message); }
  return null;
}

// アクセス拒否画面（body差し替え）
export function showAccessDenied(email, msg, detail){
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;padding:24px;text-align:center;font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif;background:#FAFAF8;color:#2C2416">
      <i class="ti ti-lock" style="font-size:44px;color:#9a8e78" aria-hidden="true"></i>
      <div style="font-size:17px;font-weight:700">${(msg||"アクセス権限がありません")}</div>
      <div style="font-size:13px;color:#6a5e48;max-width:440px;line-height:1.7">
        ${detail ? String(detail).replace(/</g,"&lt;")
          : msg
          ? `このアカウント（${String(email||"").replace(/</g,"&lt;")}）では、この画面を使えません。<br>必要なときは管理者に依頼してください。`
          : `このアカウント（${String(email||"").replace(/</g,"&lt;")}）は<strong>ユーザー登録がありません</strong>。<br>
        管理者にユーザー登録（ロール付与）を依頼してください。`}
      </div>
      <a href="/index.html" style="font-size:13px;color:#3a6e9e">別のアカウントでログインし直す</a>
    </div>`;
}

// ゲート共通処理：登録＋active確認。adminOnly指定時は管理者のみ。
// 通過したら role情報を返す。拒否時はnullを返す（呼び出し側はreturnする）
export async function gateRole(db, user, opts){
  opts = opts || {};
  const r = await getMyRole(db, user.email);
  if(!r || !r.active){ showAccessDenied(user.email); return null; }
  if(opts.adminOnly && r.role !== "admin"){ showAccessDenied(user.email, "この画面は管理者のみ利用できます"); return null; }
  // 練習モード（練習生は常に練習。帯・切替ボタン・ログアウト時の片付け）
  const mode = setupModeUi(r, user);
  if(mode === false) return null; // 練習モードへ読み込み直す
  if(mode === "no-storage"){
    showAccessDenied(user.email, "このブラウザでは練習モードを使えません",
      "練習生のアカウントは、ブラウザに設定を保存できないと使えません（プライベートウィンドウなど）。通常のウィンドウで開いてください。");
    return null;
  }
  return r;
}

// ===== 閲覧のみ（viewer）の画面制御 =====
// Firestore ルール側で書き込みは止めてある（isEditor）。ここは「押しても保存できない
// ボタンを押させない」ための画面側の手当て。押してからエラーで気づく体験を避ける。
//
// 書き込み系のボタンは、文言で見分ける。data 属性を全ページに付けて回るより取りこぼしが
// 少なく、誤って無効化しても「閲覧のみの人が押せない」だけで実害がないため。
// 逆に、検索・絞り込み・印刷・閉じるなど読むための操作は無効化しない。
const WRITE_WORDS = /保存|登録|追加|削除|変更|記録|送信|確定|取り込|統合|調整|入荷|発行|報告|充当|返金|案内|作成|更新|戻す|停止|再開|対象外|修正/;
const KEEP_WORDS = /検索|絞|閉じる|キャンセル|印刷|PDF|開く|戻る|ログアウト|コピー|表示/;

export function isViewer(role){ return !!role && role.role === "viewer"; }

/** 閲覧のみなら、書き込み系のボタンを無効化して画面上部に帯を出す。 */
export function applyViewerMode(role){
  if(!isViewer(role)) return false;

  const disable = (root) => {
    root.querySelectorAll("button, a.btn, input[type=submit]").forEach((b) => {
      if(b.hasAttribute("data-viewer-ok")) return; // 書き込みをしない外部リンク等（例: Googleカレンダーに追加）
      const t = (b.textContent || b.value || "").trim();
      if(!t || KEEP_WORDS.test(t) || !WRITE_WORDS.test(t)) return;
      b.disabled = true;
      b.setAttribute("aria-disabled", "true");
      b.title = "閲覧のみの権限では操作できません";
      b.style.opacity = "0.45";
      b.style.pointerEvents = "none";
    });
  };
  disable(document);
  // あとから描かれる一覧・モーダルにも効かせる
  new MutationObserver(() => disable(document))
    .observe(document.body, { childList: true, subtree: true });

  const bar = document.createElement("div");
  bar.setAttribute("role", "status");
  bar.style.cssText = "position:sticky;top:0;z-index:9999;background:#FCF0F0;border-bottom:2px solid #E33535;"
    + "color:#2C2416;font-size:14px;font-weight:700;padding:10px 16px;text-align:center;"
    + "font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif";
  bar.textContent = "閲覧のみの権限でログインしています。保存・登録・削除はできません。";
  document.body.insertBefore(bar, document.body.firstChild);
  return true;
}
