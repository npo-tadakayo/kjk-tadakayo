// ログインに失敗したときに画面へ出す日本語の説明（純粋関数・テスト scripts/test-login-errors.mjs）
//
// なぜあるか（2026-11-11）: 11/9〜11/11 に Firebase Auth の承認済みドメインが壊れ、新しくログインする人が
// 「ログインに失敗しました: Firebase: Error (auth/unauthorized-domain).」という英語の表示で止まった。
// 本人の操作の問題なのかシステムの問題なのかが分からず、報告が来るまで3日かかった。
// → エラーの種類ごとに「何が起きたか」「どうすればよいか」を日本語で出し、問い合わせ用にコードを添える。
//
// audience: "staff"（管理画面＝タダカヨの職員）／ "partner"（認定事業者ポータル＝外部の事業者）

const CONTACT = {
  staff: "管理者（次田）",
  partner: "タダカヨの担当者",
};

/** Firebase のエラーからコード（auth/xxx）を取り出す。無ければ "" */
export function authErrorCode(e) {
  if (!e) return "";
  if (typeof e.code === "string" && e.code.startsWith("auth/")) return e.code;
  const m = /\((auth\/[a-z0-9-]+)\)/.exec(String(e.message ?? ""));
  return m ? m[1] : "";
}

/**
 * 画面に出す文。{ text, isSystem } を返す。
 *   isSystem: true … 本人の操作では直らない（システム側の問題）。連絡をお願いする
 */
export function loginErrorMessage(e, audience = "staff") {
  const who = CONTACT[audience] ?? CONTACT.staff;
  const code = authErrorCode(e);
  const tail = code ? `（エラーコード: ${code}）` : "";

  switch (code) {
    case "auth/unauthorized-domain":
      return {
        isSystem: true,
        text: "システム側の設定に問題があり、いまはこの画面からログインできません。" +
          `あなたの操作の問題ではありません。お手数ですが、この表示のまま${who}にご連絡ください。${tail}`,
      };
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/user-cancelled":
      return { isSystem: false, text: "ログインの画面が閉じられました。もう一度ログインのボタンを押してください。" };
    case "auth/popup-blocked":
      return {
        isSystem: false,
        text: "ログイン用の小さな画面が、ブラウザに止められました。" +
          "アドレスバーの右端に出る表示から「ポップアップを許可」を選び、もう一度ボタンを押してください。",
      };
    case "auth/network-request-failed":
      return {
        isSystem: false,
        text: "通信がうまくいきませんでした。インターネットにつながっているかを確かめて、もう一度お試しください。",
      };
    case "auth/too-many-requests":
      return {
        isSystem: false,
        text: "ログインの操作が続いたため、一時的に止まっています。数分おいてから、もう一度お試しください。",
      };
    case "auth/user-disabled":
      return { isSystem: true, text: `このアカウントは使えない状態になっています。${who}にご連絡ください。${tail}` };
    case "auth/operation-not-allowed":
    case "auth/invalid-api-key":
    case "auth/app-not-authorized":
    case "auth/internal-error":
      return {
        isSystem: true,
        text: `システム側の問題でログインできません。お手数ですが、この表示のまま${who}にご連絡ください。${tail}`,
      };
    default:
      if (!code && e?.message && /[ぁ-んァ-ヶ一-龠]/.test(e.message)) {
        // 画面側で作った日本語のエラー（「@tadakayo.jp のアカウントのみ…」など）はそのまま出す
        return { isSystem: false, text: e.message };
      }
      return {
        isSystem: !!code,
        text: "ログインに失敗しました。もう一度お試しください。" +
          `続くときは、この表示のまま${who}にご連絡ください。${tail}`,
      };
  }
}
