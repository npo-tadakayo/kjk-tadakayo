// sendCaseEmail の「準備 → Gmail で送信 → 対応記録」の進め方（2026-11-12・設計書 CRM改善_設計書_20261110 §3 点検4 の根本対応）。
// firebase に依存しない（送信・記録の部分は呼び出し側から関数で渡す）。テスト: node scripts/test-case-mail.mjs（Gmail は呼ばない）
//
// 返事の約束（画面 admin/js/mail-send-guard.js・case-detail.js が読む。解釈は admin/js/record-gaps-case.js の sendResultOf）
//   ・送信済み: { ok: true, sent: true, id, sentAt }            sentAt＝送信が成功した時点のサーバー時刻（ISO）
//   ・送信済み・対応記録だけ失敗: { ok: true, sent: true, id, sentAt, recordError: "<短い理由>" }
//       recordError があるときは、対応記録（activities の gmail_sent）が書けていない。画面が記録だけをやり直す。メールは再送しない
//       案件の更新日時（cases.updatedAt）だけの失敗は recordError にしない（ログだけ。画面の点検3 と同じ扱い）
//   ・送信前の失敗（設定・トークン・本文の組み立て）: CaseMailError("failed-precondition")＝メールは送っていない
//   ・Gmail が 4xx を返した: CaseMailError("failed-precondition")＝送っていない（はっきりした失敗）
//   ・Gmail が 5xx を返した・通信そのものが失敗した: CaseMailError("internal")＝送れたかどうか分からない
//     （画面は internal を「送れたか不明」として、次の送信の前に確認をはさむ）
// 以前は、送信後の記録の失敗も、送信の失敗と同じ HttpsError("internal") だったため、画面は「送れたか不明」としか言えなかった。

class CaseMailError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CaseMailError";
    this.code = code;
  }
}

const msgOf = (e) => String((e && e.message) || e || "不明なエラー");

/** 画面に返す短い理由（長いエラー文・スタックは返さない） */
function shortReason(e, max = 120) {
  const code = e && e.code != null ? String(e.code) : "";
  const m = msgOf(e).replace(/\s+/g, " ").trim();
  const s = code && !m.includes(code) ? `${code}: ${m}` : m;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * @param {object} d
 * @param {() => Promise<any>} d.prepare        送る前の準備（設定・トークン・本文の組み立て）。投げたら「送っていない」
 * @param {(prepared:any) => Promise<{ok:boolean, status:number, json:() => Promise<any>, text:() => Promise<string>}>} d.post
 *        Gmail へ送る（fetch）。投げたら「送れたか不明」
 * @param {(o:{sentAt:string}) => Promise<unknown>} [d.record]  対応記録を書く（案件が無ければ渡さない）
 * @param {() => Promise<unknown>} [d.touch]    案件の更新日時を進める（失敗しても recordError にしない）
 * @param {() => Date} [d.now]
 * @param {(...a:any[]) => void} [d.logError]
 * @returns {Promise<{ok:true, sent:true, id:string, sentAt:string, recordError?:string}>}
 */
async function runCaseMail({ prepare, post, record, touch, now = () => new Date(), logError = console.error }) {
  let prepared;
  try {
    prepared = await prepare();
  } catch (e) {
    logError("sendCaseEmail prepare failed:", e);
    throw new CaseMailError("failed-precondition", `送信の準備に失敗しました（メールは送っていません）: ${shortReason(e)}`);
  }

  let res;
  try {
    res = await post(prepared);
  } catch (e) {
    logError("sendCaseEmail post failed:", e);
    throw new CaseMailError("internal", `送信処理に失敗しました: ${msgOf(e)}`);
  }
  if (!res || !res.ok) {
    const status = Number(res && res.status) || 0;
    let t = "";
    try { t = res ? await res.text() : ""; } catch { /* 本文が読めなくても判定は同じ */ }
    logError("Gmail send failed:", status, t);
    const code = status >= 400 && status < 500 ? "failed-precondition" : "internal";
    throw new CaseMailError(code, `Gmail送信に失敗しました（${status}）。DWD登録と送信元アカウントをご確認ください`);
  }

  // ここから先は送信済み。何が失敗しても投げない（投げると画面が「送れたか不明」と受け取り、二重送信を招く）
  const sentAt = now().toISOString();
  let id = "";
  try { id = String((await res.json())?.id || ""); } catch (e) { logError("sendCaseEmail: 送信は成功・応答の読み取りに失敗:", e); }
  const out = { ok: true, sent: true, id, sentAt };
  if (record) {
    try {
      await record({ sentAt });
    } catch (e) {
      logError("sendCaseEmail: 送信は成功・対応記録の書き込みに失敗:", e);
      out.recordError = `対応記録の書き込みに失敗しました（${shortReason(e)}）`;
      return out;
    }
    if (touch) {
      try { await touch(); } catch (e) { logError("sendCaseEmail: 案件の更新日時の更新に失敗（記録の成否にしない）:", e); }
    }
  }
  return out;
}

module.exports = { runCaseMail, CaseMailError, shortReason };
