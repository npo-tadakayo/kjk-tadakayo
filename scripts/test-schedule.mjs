// 予定（訪問カレンダー）の純粋な関数のテスト。node scripts/test-schedule.mjs
import assert from "node:assert/strict";
import * as S from "../admin/js/schedule-core.js";

let n = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// JST の今日（UTC 15:00 以降は翌日）
eq(S.todayYmdJst(new Date("2026-10-27T14:59:59Z")), "2026-10-27", "UTC 14:59 はまだ同じ日");
eq(S.todayYmdJst(new Date("2026-10-27T15:00:00Z")), "2026-10-28", "UTC 15:00 = JST 0:00 は翌日");
eq(S.todayYmdJst(new Date("2026-12-31T15:00:00Z")), "2027-01-01", "年またぎ");

// 日付の検査・加減算
eq(S.isYmd("2026-02-29"), false); eq(S.isYmd("2028-02-29"), true); eq(S.isYmd("2026-1-1"), false);
eq(S.addDays("2026-12-31", 1), "2027-01-01"); eq(S.addDays("2026-03-01", -1), "2026-02-28");
eq(S.addMonths("2026-01-31", 1), "2026-02-01"); eq(S.addMonths("2026-12-15", 1), "2027-01-01");
eq(S.addMonths("2026-01-15", -1), "2025-12-01");

// 週は日曜始まり（2026-10-28 は水曜）
eq(S.weekdayOf("2026-10-28"), 3);
eq(S.rangeOf("week", "2026-10-28"), { from: "2026-10-25", to: "2026-10-31" });
eq(S.rangeOf("week", "2026-10-25"), { from: "2026-10-25", to: "2026-10-31" }, "日曜はその日が週の先頭");
eq(S.rangeOf("week", "2026-10-31"), { from: "2026-10-25", to: "2026-10-31" }, "土曜は週の最後");
eq(S.rangeOf("week", "2026-12-31"), { from: "2026-12-27", to: "2027-01-02" }, "年またぎの週");
eq(S.rangeOf("day", "2026-10-28"), { from: "2026-10-28", to: "2026-10-28" });

// 月グリッド：前後の月を含めて週単位
const oct = S.monthGrid("2026-10-28");
eq(oct.length, 5); eq(oct[0][0], "2026-09-27"); eq(oct[4][6], "2026-10-31");
eq(oct.every((w) => w.length === 7), true);
const feb = S.monthGrid("2026-02-10"); // 2/1 が日曜・28日が土曜 → ちょうど4週
eq(feb.length, 4); eq(feb[0][0], "2026-02-01"); eq(feb[3][6], "2026-02-28");
const dec = S.monthGrid("2026-12-01");
eq(dec[dec.length - 1][6], "2027-01-02", "月末の週は翌年にまたがる");
eq(S.shiftDate("month", "2026-12-15", 1), "2027-01-01");
eq(S.shiftDate("week", "2026-12-30", 1), "2027-01-06");
eq(S.shiftDate("day", "2026-01-01", -1), "2025-12-31");

// URL
eq(S.parseQuery("", "2026-10-28"), { view: "day", date: "2026-10-28", assignee: "", pref: "" }, "既定は今日の日ビュー");
eq(S.parseQuery("?view=month&date=2026-11-05&assignee=__me&pref=%E6%9D%B1%E4%BA%AC%E9%83%BD", "2026-10-28"),
  { view: "month", date: "2026-11-05", assignee: "__me", pref: "東京都" });
eq(S.parseQuery("?view=year&date=2026-13-40", "2026-10-28").view, "day", "不正な view は既定");
eq(S.parseQuery("?view=week&date=bad", "2026-10-28").date, "2026-10-28", "不正な date は今日");
const q = { view: "week", date: "2026-10-28", assignee: "a@tadakayo.jp", pref: "大分県" };
eq(S.parseQuery(S.buildQuery(q), "2000-01-01"), q, "buildQuery と parseQuery は往復できる");
eq(S.buildQuery({ view: "day", date: "2026-10-28", assignee: "", pref: "" }), "?view=day&date=2026-10-28");

// 予定の元データ
const offices = { o1: { address: "大分県大分市府内町1-1" }, o2: { address: "東京都千代田区1-1" } };
const cases = [
  { _id: "c1", caseNumber: 1, visitDate: "2026-10-28", visitTimeFrom: "15:00", visitTimeTo: "16:00", visitFormat: "onsite",
    status: 7, assignedUserId: "A@tadakayo.jp", assignedUserName: "阿佐野", officeId: "o1", officeName: "ほのぼの", corpName: "法人A", contactPhone: "097-000-0000" },
  { _id: "c2", caseNumber: 2, visitDate: "2026-10-28", status: 3, officeId: "o2", officeName: "アルファ" },
  { _id: "c3", caseNumber: 3, visitDate: "2026-10-28", visitTimeFrom: "09:30", status: 8, assignedUserId: "b@tadakayo.jp", assignedUserName: "紺井", officeId: "o2" },
  { _id: "c4", caseNumber: 4, visitDate: "2026-10-28", status: 4 },                 // 失注
  { _id: "c5", caseNumber: 5, visitDate: "2026-10-28", status: 5, archived: true },   // 対象外
  { _id: "c6", caseNumber: 6, status: 5 },                                            // 日付なし
  { _id: "c7", caseNumber: 7, visitDate: "2026-10-28", visitTimeFrom: "25:00", visitTimeTo: "17:00", visitFormat: "x", status: 2 }, // 不正な時刻
];
const evs = S.toEvents(cases, { officesById: offices });
eq(evs.map((e) => e.id), ["c1", "c2", "c3", "c7"], "失注・対象外・日付なしは出ない");
eq(evs[0].prefecture, "大分県"); eq(evs[1].prefecture, "東京都");
eq(evs[3].timeFrom, null, "不正な時刻は時刻未定"); eq(evs[3].timeTo, null, "開始が無ければ終了も使わない"); eq(evs[3].format, "");
eq(evs.map((e) => e.stage), ["upcoming", "upcoming", "done", "check"]);
eq([1, 2, 3, 4, 5, 6, 7, 8, 13].map(S.stageOf), ["check", "check", "upcoming", null, "upcoming", "upcoming", "upcoming", "done", "done"]);

// 並び：時刻あり（早い順）→ 時刻未定
eq(S.sortEvents(evs).map((e) => e.id), ["c3", "c1", "c2", "c7"]);
eq(S.sortEvents([{ id: "x", caseNumber: 9, timeFrom: null }, { id: "y", caseNumber: 1, timeFrom: null }]).map((e) => e.id), ["y", "x"], "未定同士は案件番号順");

// 絞り込み
const me = "a@tadakayo.jp";
eq(S.filterEvents(evs, { assignee: "__me", myEmail: me }).map((e) => e.id), ["c1"], "自分の予定だけ（大文字小文字は同じ人）");
eq(S.filterEvents(evs, { assignee: "__none", myEmail: me }).map((e) => e.id), ["c2", "c7"], "未割当");
eq(S.filterEvents(evs, { assignee: "b@tadakayo.jp", myEmail: me }).map((e) => e.id), ["c3"]);
eq(S.filterEvents(evs, { pref: "東京都" }).map((e) => e.id), ["c2", "c3"]);
eq(S.filterEvents(evs, { assignee: "b@tadakayo.jp", pref: "大分県", myEmail: me }), [], "両方かけると AND");
eq(S.filterEvents(evs, {}).length, 4);

// 都道府県の取り出し
eq(S.toEvents([{ _id: "z", visitDate: "2026-10-28", status: 3, address: "〒870-0000 大分県大分市1-1" }])[0].prefecture, "大分県");
eq(S.toEvents([{ _id: "z", visitDate: "2026-10-28", status: 3 }])[0].prefecture, "", "住所が無ければ空");
eq(S.prefecturesOf(evs), ["大分県", "東京都"]);

// 期間・日ごと・担当別件数
eq(S.inRange(evs, "2026-10-29", "2026-10-31"), []);
eq([...S.groupByDate(evs).keys()], ["2026-10-28"]);
eq(S.groupByDate(evs).get("2026-10-28").map((e) => e.id), ["c3", "c1", "c2", "c7"]);
eq(S.countByAssignee(evs).map((x) => [x.name, x.count]), [["阿佐野", 1], ["紺井", 1], ["担当未割当", 2]], "未割当は最後");

// 表示文字列
eq(S.timeLabel("15:00", "16:00"), "15:00〜16:00"); eq(S.timeLabel("15:00", null), "15:00〜"); eq(S.timeLabel(null, null), "時刻未定");
eq(S.visitShort("2026-10-28", "15:00"), "10/28 15:00"); eq(S.visitShort("2026-10-28", null), "10/28"); eq(S.visitShort("", "15:00"), "");
eq(S.visitFull("2026-10-28", "15:00"), "2026/10/28 15:00"); eq(S.visitFull("2026-10-28"), "2026/10/28"); eq(S.visitFull(null), "");
eq(S.visitSummary({ visitDate: "2026-10-28", visitTimeFrom: "15:00", visitTimeTo: "16:00", visitFormat: "onsite" }), "2026/10/28 15:00〜16:00（対面）");
eq(S.visitSummary({ visitDate: "2026-10-28" }), "2026/10/28"); eq(S.visitSummary({}), "未設定");
eq(S.titleOf("day", "2026-10-28"), "2026年10月28日（水）"); eq(S.titleOf("month", "2026-10-28"), "2026年10月");
eq(S.titleOf("week", "2026-10-28"), "2026年10月25日〜10月31日");

// Google カレンダー
eq(S.googleCalendarDates("2026-10-28", null, null), "20261028/20261029", "終日は翌日が終了");
eq(S.googleCalendarDates("2026-12-31", null, null), "20261231/20270101", "終日・年またぎ");
eq(S.googleCalendarDates("2026-10-28", "15:00", "16:30"), "20261028T150000/20261028T163000");
eq(S.googleCalendarDates("2026-10-28", "15:00", null), "20261028T150000/20261028T160000", "終了なしは +60 分");
eq(S.googleCalendarDates("2026-10-28", "15:00", "14:00"), "20261028T150000/20261028T160000", "終了が開始以前なら +60 分");
eq(S.googleCalendarDates("2026-10-28", "23:30", null), "20261028T233000/20261029T003000", "日をまたぐ +60 分");
const url = new URL(S.googleCalendarUrl(evs[0]));
eq(url.origin + url.pathname, "https://calendar.google.com/calendar/render");
eq(url.searchParams.get("action"), "TEMPLATE"); eq(url.searchParams.get("ctz"), "Asia/Tokyo");
eq(url.searchParams.get("dates"), "20261028T150000/20261028T160000");
eq(url.searchParams.get("location"), "大分県大分市府内町1-1");
eq(url.searchParams.get("text").includes("ほのぼの"), true);
eq(S.googleMapsUrl("大分県 大分市").startsWith("https://www.google.com/maps/search/?api=1&query="), true);

// 準備の状況
eq(S.latestQuote([{ version: 1, status: "superseded" }, { version: 2, status: "accepted" }]).status, "accepted");
eq(S.latestQuote([]), null);
eq(S.latestShipment([{ status: "canceled" }]), null);
eq(S.latestShipment([{ status: "draft" }, { status: "shipped" }, { status: "requested" }]).status, "shipped");

// 担当者名（メールアドレスを画面に出さない）
const users = [{ _id: "Yoshinao-Tsukuda@tadakayo.jp", name: "次田芳尚" }, { _id: "noname@tadakayo.jp" }];
const names = S.buildUserNames(users, [{ assignedUserId: "k@tadakayo.jp", assignedUserName: "紺井" }]);
eq(S.assigneeNameOf("yoshinao-tsukuda@tadakayo.jp", "", names), "次田芳尚", "名前が空なら users で補う（大文字小文字は同じ人）");
eq(S.assigneeNameOf("a@tadakayo.jp", "阿佐野", names), "阿佐野", "案件に名前があればそれを使う");
eq(S.assigneeNameOf("k@tadakayo.jp", "", names), "紺井", "users に無くても他の案件の名前で補う");
eq(S.assigneeNameOf("noname@tadakayo.jp", "", names), "担当者（未登録）", "name が無い user は未登録");
eq(S.assigneeNameOf("zzz@tadakayo.jp", "", names), "担当者（未登録）");
eq(S.assigneeNameOf("zzz@tadakayo.jp", "", null), "担当者（未登録）", "対応表が無い（users が読めない）ときも");
eq(S.assigneeNameOf("zzz@tadakayo.jp", "zzz@tadakayo.jp", names), "担当者（未登録）", "名前欄にメールが入っていても出さない");
eq(S.assigneeNameOf("", "", names), "", "担当なしは空");
const ev235 = S.toEvents([{ _id: "c235", caseNumber: 235, visitDate: "2026-10-28", status: 7, assignedUserId: "yoshinao-tsukuda@tadakayo.jp", assignedUserName: "" }], { userNames: names })[0];
eq(ev235.assignedUserName, "次田芳尚");
eq(S.filterEvents([ev235], { assignee: "__me", myEmail: "Yoshinao-Tsukuda@tadakayo.jp" }).length, 1, "自分だけは id とメールの一致で判定");
const unk = S.toEvents([{ _id: "u", visitDate: "2026-10-28", status: 7, assignedUserId: "x@tadakayo.jp" }])[0];
eq(unk.assignedUserName, "担当者（未登録）");
eq(S.countByAssignee([ev235, unk]).map((r) => r.name), ["次田芳尚", "担当者（未登録）"]);
eq(S.countByAssignee([unk]).some((r) => r.name.includes("@")), false, "件数のチップにメールが出ない");

console.log(`test-schedule: ${n} checks passed`);
