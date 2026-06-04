import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ログインユーザーのロール情報を取得（未登録ならnull）
export async function getMyRole(db, email){
  try{
    const s = await getDoc(doc(db, "users", email));
    if(s.exists()){
      const d = s.data();
      return { role: d.role || "staff", active: d.active !== false, name: d.name || "" };
    }
  }catch(e){ console.warn("getMyRole error:", e.message); }
  return null;
}

// アクセス拒否画面（body差し替え）
export function showAccessDenied(email, msg){
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;padding:24px;text-align:center;font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif;background:#FAFAF8;color:#2C2416">
      <i class="ti ti-lock" style="font-size:44px;color:#9a8e78" aria-hidden="true"></i>
      <div style="font-size:17px;font-weight:700">${(msg||"アクセス権限がありません")}</div>
      <div style="font-size:13px;color:#6a5e48;max-width:440px;line-height:1.7">
        このアカウント（${String(email||"").replace(/</g,"&lt;")}）は<strong>ユーザー登録がありません</strong>。<br>
        管理者にユーザー登録（ロール付与）を依頼してください。
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
  return r;
}
