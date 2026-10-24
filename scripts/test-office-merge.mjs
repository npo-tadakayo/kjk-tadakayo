// 事業所の編集・統合の判定（admin/js/office-merge.js・純粋関数）のテスト。node scripts/test-office-merge.mjs
// 設計: docs/顧客情報の修正メニュー_設計_20261024.md §7。Firestore には触れない。
// Functions 側のコピー（functions/office-merge.mjs）も同じ結果になることを確かめる。
import assert from "node:assert/strict";
import * as A from "../admin/js/office-merge.js";
import * as Fn from "../functions/office-merge.mjs";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };
const ta = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };

for (const [label, M] of [["admin", A], ["functions", Fn]]) {
  t(`${label}: 公開する名前`, () => {
    assert.deepEqual(Object.keys(M).sort(), [
      "EDITABLE_FIELDS", "TO_RESTORE_FIELDS", "buildAliases", "canRestoreTo", "checkMerge", "dupCandidates", "dupGroupCount", "nameMatchesOffice",
      "normAddr", "normName", "normPhone", "pickRestorable", "resolveKeep", "resolveMergedId", "resolveMergedIdAsync",
      "validatePatch",
    ]);
    assert.deepEqual(M.EDITABLE_FIELDS, ["officeName", "corpName", "address", "phone", "postalCode"]);
  });
}
const M = A;

t("normName: 空白・括弧・中黒・全角半角・大文字", () => {
  assert.equal(M.normName("（株）タダカヨ　訪問介護"), M.normName("(株)タダカヨ訪問介護"));
  assert.equal(M.normName("「ケア」【センター】"), "ケアセンター");
  assert.equal(M.normName("ケア・プラン"), "ケアプラン");
  assert.equal(M.normName("ケア･プラン"), "ケアプラン"); // 半角中黒
  assert.equal(M.normName("ＡＢＣ　Care"), "abccare");
  assert.equal(M.normName("ｶﾌﾞｼｷ"), "カブシキ");
  assert.equal(M.normName(null), "");
  assert.equal(M.normName(undefined), "");
  assert.equal(M.normName("  "), "");
});

t("normPhone / normAddr", () => {
  assert.equal(M.normPhone("03-1234-5678"), "0312345678");
  assert.equal(M.normPhone("０３（１２３４）５６７８"), "0312345678");
  assert.equal(M.normPhone(null), "");
  assert.equal(M.normAddr("大阪府 豊中市　１－２"), "大阪府豊中市1-2");
  assert.equal(M.normAddr(undefined), "");
});

t("validatePatch: 正常（前後空白を除く・入れた項目だけ）", () => {
  assert.deepEqual(M.validatePatch({ officeName: "  新しい名前 ", phone: "03-1" }), { ok: true, patch: { officeName: "新しい名前", phone: "03-1" } });
  assert.deepEqual(M.validatePatch({ corpName: "" }), { ok: true, patch: { corpName: "" } }); // 法人名は空にできる
  const all = { officeName: "a", corpName: "b", address: "c", phone: "d", postalCode: "e" };
  assert.deepEqual(M.validatePatch(all), { ok: true, patch: all });
  assert.equal(M.validatePatch({ address: "x".repeat(200) }).ok, true);
  assert.equal(M.validatePatch({ address: "  " + "x".repeat(200) + "  " }).ok, true); // 空白を除いて200字
});

t("validatePatch: 拒否", () => {
  for (const bad of [null, undefined, "x", 1, [], [{ officeName: "a" }]]) {
    const r = M.validatePatch(bad);
    assert.equal(r.ok, false); assert.equal(typeof r.error, "string");
  }
  assert.equal(M.validatePatch({}).ok, false);                       // 変更なし
  assert.match(M.validatePatch({ archived: true }).error, /archived/); // 知らない項目
  assert.equal(M.validatePatch({ officeName: "a", mergedInto: "x" }).ok, false);
  assert.equal(M.validatePatch({ officeName: "" }).ok, false);        // 事業所名は空にできない
  assert.equal(M.validatePatch({ officeName: "　 " }).ok, false);
  assert.equal(M.validatePatch({ phone: 312345678 }).ok, false);      // 文字列以外
  assert.equal(M.validatePatch({ phone: null }).ok, false);
  assert.equal(M.validatePatch({ address: "x".repeat(201) }).ok, false);
});

t("resolveKeep: 指定どおり・省略は to・片方が空なら値のある方", () => {
  const from = { officeName: "旧", corpName: "法人F", address: "", phone: "06-1", postalCode: "" };
  const to = { officeName: "新", corpName: "", address: "東京都", phone: "03-1", postalCode: "" };
  assert.deepEqual(M.resolveKeep(from, to, { officeName: "from", phone: "to" }),
    { officeName: "旧", corpName: "法人F", address: "東京都", phone: "03-1", postalCode: "" });
  assert.deepEqual(M.resolveKeep(from, to, {}),
    { officeName: "新", corpName: "法人F", address: "東京都", phone: "03-1", postalCode: "" }); // corpName は to が空 → from
  assert.deepEqual(M.resolveKeep(from, to, { address: "from" }).address, "東京都");           // from が空 → to
  assert.deepEqual(M.resolveKeep(from, to).officeName, "新");
  assert.deepEqual(M.resolveKeep(from, to, { officeName: "bogus" }).officeName, "新");          // 不正値は to
  assert.deepEqual(M.resolveKeep({ officeName: "  空白 " }, {}, {}).officeName, "空白");         // 前後空白を除く
  assert.deepEqual(M.resolveKeep(null, null, null), { officeName: "", corpName: "", address: "", phone: "", postalCode: "" });
  // 残す値は EDITABLE_FIELDS だけ
  assert.deepEqual(Object.keys(M.resolveKeep({ aliases: ["x"], mergedInto: "y" }, {}, {})), M.EDITABLE_FIELDS);
});

t("buildAliases: 和集合・最終名と空を除く・normName で重複除去（最初の表記）", () => {
  const to = { officeName: "タダカヨ訪問", aliases: ["旧A", "（株）旧B"] };
  const from = { officeName: "タダカヨ 訪問介護", aliases: ["(株)旧B", "旧C", "", null] };
  assert.deepEqual(M.buildAliases(to, from, "タダカヨ訪問"), ["旧A", "（株）旧B", "旧C", "タダカヨ 訪問介護"]);
  // 最終名が from の名前なら、to の旧名が aliases に入る
  assert.deepEqual(M.buildAliases(to, from, "タダカヨ　訪問介護"), ["旧A", "（株）旧B", "旧C", "タダカヨ訪問"]);
  // 最終名は表記違いでも除く
  assert.deepEqual(M.buildAliases({ officeName: "A B" }, { officeName: "AB" }, "ＡＢ"), []);
  assert.deepEqual(M.buildAliases({}, {}, "x"), []);
  assert.deepEqual(M.buildAliases(null, null, ""), []);
  // 編集で旧名を足す形（updateOffice）
  assert.deepEqual(M.buildAliases({ aliases: ["前の前"], officeName: "前" }, {}, "今"), ["前の前", "前"]);
  // 前の名前に戻したら aliases から外れる
  assert.deepEqual(M.buildAliases({ aliases: ["前の前"], officeName: "前" }, {}, "前の前"), ["前"]);
});

t("checkMerge: 拒否の条件", () => {
  const o = { officeName: "x" };
  assert.deepEqual(M.checkMerge(o, o, "a", "a").code, "invalid-argument");
  assert.equal(M.checkMerge(o, o, "", "b").code, "invalid-argument");
  assert.equal(M.checkMerge(o, o, "a", null).code, "invalid-argument");
  assert.equal(M.checkMerge(o, o, 1, "b").code, "invalid-argument");
  assert.equal(M.checkMerge(null, o, "a", "b").code, "not-found");
  assert.equal(M.checkMerge(o, undefined, "a", "b").code, "not-found");
  assert.equal(M.checkMerge(o, { mergedInto: "c" }, "a", "b").code, "failed-precondition");
  assert.equal(M.checkMerge({ mergedInto: "c", mergeStatus: "done" }, o, "a", "b").code, "failed-precondition");
  assert.equal(M.checkMerge({ mergedInto: "c", mergeStatus: "running" }, o, "a", "b").code, "failed-precondition");
  const done = M.checkMerge({ mergedInto: "b", mergeStatus: "done" }, o, "a", "b");
  assert.equal(done.ok, false); assert.equal(done.code, "failed-precondition"); assert.match(done.error, /統合済み/);
  // to が統合済みなら、再開でも断る（統合先が別に消えた）
  assert.equal(M.checkMerge({ mergedInto: "b", mergeStatus: "running" }, { mergedInto: "z" }, "a", "b").code, "failed-precondition");
  // 画面に出す文言は日本語
  for (const r of [M.checkMerge(o, o, "a", "a"), M.checkMerge(null, o, "a", "b")]) assert.match(r.error, /[ぁ-んァ-ン一-龥]/);
});

t("checkMerge: 正常・再開", () => {
  assert.deepEqual(M.checkMerge({ officeName: "x" }, { officeName: "y" }, "a", "b"), { ok: true, resume: false });
  assert.deepEqual(M.checkMerge({ mergedInto: "b", mergeStatus: "running" }, {}, "a", "b"), { ok: true, resume: true });
  assert.deepEqual(M.checkMerge({ archived: true }, {}, "a", "b"), { ok: true, resume: false }); // 非表示の事業所も統合できる
});

t("resolveMergedId: 鎖・循環・行き先なし・5段まで", () => {
  const db = {
    a: { mergedInto: "b" }, b: { mergedInto: "c" }, c: {},
    x: { mergedInto: "y" }, y: { mergedInto: "x" },       // 循環
    m: { mergedInto: "gone" },                             // 行き先が無い
    s: { mergedInto: "s" },                                // 自分自身
    h0: { mergedInto: "h1" }, h1: { mergedInto: "h2" }, h2: { mergedInto: "h3" }, h3: { mergedInto: "h4" },
    h4: { mergedInto: "h5" }, h5: { mergedInto: "h6" }, h6: {},
  };
  const get = (id) => db[id];
  assert.equal(M.resolveMergedId("a", get), "c");
  assert.equal(M.resolveMergedId("b", get), "c");
  assert.equal(M.resolveMergedId("c", get), "c");
  assert.equal(M.resolveMergedId("x", get), "y");      // y→x で循環に気づいて止まる
  assert.equal(M.resolveMergedId("y", get), "x");
  assert.equal(M.resolveMergedId("m", get), "m");
  assert.equal(M.resolveMergedId("s", get), "s");
  assert.equal(M.resolveMergedId("nothing", get), "nothing");
  assert.equal(M.resolveMergedId("h0", get), "h5");    // 5段で止まる
  assert.equal(M.resolveMergedId("h1", get), "h6");
  assert.equal(M.resolveMergedId("", get), "");
  assert.equal(M.resolveMergedId(null, get), null);
});

await ta("resolveMergedIdAsync: 同期版と同じ結果・読む回数", async () => {
  const db = { a: { mergedInto: "b" }, b: { mergedInto: "c" }, c: {}, x: { mergedInto: "y" }, y: { mergedInto: "x" }, m: { mergedInto: "gone" } };
  let reads = 0;
  const get = async (id) => { reads++; return db[id]; };
  assert.equal(await M.resolveMergedIdAsync("a", get), "c");
  assert.equal(reads, 3);
  assert.equal(await M.resolveMergedIdAsync("x", get), "y");
  assert.equal(await M.resolveMergedIdAsync("m", get), "m");
  assert.equal(await M.resolveMergedIdAsync("c", get), "c");
  assert.equal(await M.resolveMergedIdAsync("", get), "");
  assert.equal(await Fn.resolveMergedIdAsync("a", get), "c");
});

t("nameMatchesOffice: 完全一致は必ず true（従来の findActiveCase と互換）", () => {
  assert.equal(M.nameMatchesOffice("A事業所", "A事業所", null), true);
  assert.equal(M.nameMatchesOffice("", "", null), true);
  assert.equal(M.nameMatchesOffice(undefined, "", undefined), true);
  assert.equal(M.nameMatchesOffice("", undefined, {}), true);
  // 記号だけで正規化すると空になる名前も、完全一致なら true
  assert.equal(M.nameMatchesOffice("（）", "（）", null), true);
});

t("nameMatchesOffice: 正規化・事業所の現在名・aliases", () => {
  const office = { officeName: "タダカヨ訪問介護", aliases: ["旧タダカヨ", "（株）昔の名前"] };
  assert.equal(M.nameMatchesOffice("タダカヨ 訪問介護", "別の写し", office), true); // 現在名と正規化一致
  assert.equal(M.nameMatchesOffice("旧タダカヨ", "タダカヨ訪問介護", office), true);
  assert.equal(M.nameMatchesOffice("(株)昔の名前", "x", office), true);
  assert.equal(M.nameMatchesOffice("Ａ事業所", "a事業所", null), true);              // 写しと正規化一致
  assert.equal(M.nameMatchesOffice("別の事業所", "タダカヨ訪問介護", office), false);
  assert.equal(M.nameMatchesOffice("", "タダカヨ訪問介護", office), false);           // 空は一致させない
  assert.equal(M.nameMatchesOffice("（）", "x", { officeName: "【】" }), false);       // 正規化で空どうしは一致させない
  assert.equal(M.nameMatchesOffice("旧タダカヨ", "x", { aliases: "旧タダカヨ" }), false); // aliases が配列でなければ見ない
  assert.equal(M.nameMatchesOffice("x", "y", undefined), false);
});

t("pickRestorable: いまも残す側を指すものだけ", () => {
  const ids = ["c1", "c2", "c3", "c4"];
  const cur = { c1: "to", c2: "other", c3: "to" }; // c4 は削除済み
  assert.deepEqual(M.pickRestorable(ids, cur, "to"), ["c1", "c3"]);
  assert.deepEqual(M.pickRestorable(ids, new Map(Object.entries(cur)), "to"), ["c1", "c3"]);
  assert.deepEqual(M.pickRestorable(ids, (id) => cur[id], "to"), ["c1", "c3"]);
  assert.deepEqual(M.pickRestorable(ids, cur, ""), []);
  assert.deepEqual(M.pickRestorable(null, cur, "to"), []);
  assert.deepEqual(M.pickRestorable(["toString"], {}, "to"), []); // 継承したプロパティを拾わない
});

t("canRestoreTo: 統合のあと to が編集されていないときだけ戻す", () => {
  assert.deepEqual(M.TO_RESTORE_FIELDS, ["officeName", "corpName", "address", "phone", "postalCode", "prefecture", "city", "addressDetail"]);
  const wrote = { officeName: "残す名", corpName: "法人", address: "大阪府豊中市1", phone: "06", postalCode: "", prefecture: "大阪府", city: "豊中市", addressDetail: "1" };
  assert.equal(M.canRestoreTo({ ...wrote, aliases: ["x"], updatedAt: 1 }, wrote), true); // 対象外の項目は見ない
  assert.equal(M.canRestoreTo({ ...wrote, phone: "07" }, wrote), false);
  assert.equal(M.canRestoreTo({ ...wrote, city: "吹田市" }, wrote), false);
  assert.equal(M.canRestoreTo({ ...wrote, postalCode: undefined }, wrote), true);        // 空と未設定は同じ
  assert.equal(M.canRestoreTo({ ...wrote, officeName: " 残す名 " }, wrote), true);       // 前後空白は同じ
  assert.equal(M.canRestoreTo(wrote, null), false);                                      // 記録が無い（古い統合）
  assert.equal(M.canRestoreTo(null, wrote), false);
});

t("dupCandidates: 名前・電話・住所・自分と統合済みを除く・理由の多い順", () => {
  const me = { id: "1", officeName: "タダカヨ訪問", phone: "03-1234-5678", address: "東京都千代田区1-1" };
  const offices = [
    me,
    { id: "2", officeName: "タダカヨ 訪問", phone: "", address: "" },                         // 名前だけ
    { id: "3", officeName: "別", phone: "0312345678", address: "東京都 千代田区1-1" },         // 電話＋住所
    { id: "4", officeName: "（タダカヨ訪問）", phone: "03-1234-5678", address: "東京都千代田区1-1" }, // 全部
    { id: "5", officeName: "タダカヨ訪問", mergedInto: "1" },                                 // 統合済み
    { id: "6", officeName: "無関係", phone: "1234", address: "大阪府" },
  ];
  assert.deepEqual(M.dupCandidates(me, offices), [
    { id: "4", reasons: ["name", "phone", "address"] },
    { id: "3", reasons: ["phone", "address"] },
    { id: "2", reasons: ["name"] },
  ]);
  // 電話は9桁以上のときだけ・空の名前・空の住所では一致させない
  const short = { id: "a", officeName: "", phone: "1234", address: "" };
  assert.deepEqual(M.dupCandidates(short, [short, { id: "b", officeName: "", phone: "1234", address: "" }]), []);
  assert.deepEqual(M.dupCandidates(null, offices), []);
  assert.deepEqual(M.dupCandidates(me, null), []);
});

t("dupGroupCount: つながる組の数（鎖・統合済み除外・1件は数えない）", () => {
  assert.equal(M.dupGroupCount([]), 0);
  assert.equal(M.dupGroupCount(null), 0);
  // a-b は名前、b-c は電話、c-d は住所 → 鎖で1組。e-f は名前で1組。g は単独
  const offices = [
    { id: "a", officeName: "X事業所", phone: "", address: "" },
    { id: "b", officeName: "X 事業所", phone: "0311112222", address: "" },
    { id: "c", officeName: "Y", phone: "03-1111-2222", address: "大阪府1" },
    { id: "d", officeName: "Z", phone: "", address: "大阪府 1" },
    { id: "e", officeName: "E", phone: "", address: "" },
    { id: "f", officeName: "Ｅ", phone: "", address: "" },
    { id: "g", officeName: "G", phone: "0999999999", address: "" },
  ];
  assert.equal(M.dupGroupCount(offices), 2);
  // 鎖の真ん中が統合済みなら切れる（a と c・d は別。a は単独になる）
  const cut = offices.map((o) => (o.id === "b" ? { ...o, mergedInto: "a" } : o));
  assert.equal(M.dupGroupCount(cut), 2); // c-d と e-f
  // 統合済みとだけ重なるものは組にならない
  assert.equal(M.dupGroupCount([{ id: "1", officeName: "P" }, { id: "2", officeName: "P", mergedInto: "1" }]), 0);
  // 短い電話・空の値ではつながらない
  assert.equal(M.dupGroupCount([{ id: "1", phone: "123" }, { id: "2", phone: "123" }, { id: "3" }, { id: "4" }]), 0);
});

console.log(`OK test-office-merge: ${n} 件合格`);
