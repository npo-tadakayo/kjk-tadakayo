// 入金明細（銀行のCSV）の取り込み画面。供給管理の出荷タブから開く（2026-10-21 設計 §7）。
// 流れ: ファイル → 先頭5行で列の割り当て（プリセット保存可）→ 照合表 → 「選んだ n件を入金として記録」。
// 🔴 確定は必ず人。最初から選ばれているのは bank-match.js の autoSelect（コードと金額の両方が1対1で一致）だけ。
// 🔴 CSV 全体は保存しない。記録した行だけ bankTxns/{hash} に最小限（日付・金額・正規化名義・出荷）を残し、二重取り込みを防ぐ。
// 列の割り当て（プリセット）と名義の学習は bankConfig/ に置く（appConfig は管理者専用なので使わない）。
// 照合・記録の判定は bank-match.js（部品）と supply-rules.js（画面の判定）に寄せ、ここは画面と書き込みだけ。

// 練習モードでは練習DBに書く（db は supply.js から渡される。書き込みの作成者の印は fs.js が付ける・2026-10-21）
import { doc, getDoc, setDoc, runTransaction, serverTimestamp, arrayUnion }
  from "/js/fs.js";
import { decodeBankFile, parseCsv, mapRows, hashRows, buildCandidates, autoSelect, bankTxnIdCandidates, pickFreeTxnId } from "/js/bank-match.js";
import { guessMapping, toMapRowsMapping, initialSelection, groupByShipment, bankPaymentOf, bankTxnDocOf,
  applyBankPayments, payConfirmText, aliasLearnings, remainOf } from "/js/supply-rules.js";

function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function yen(n){return "¥"+Number(n||0).toLocaleString("ja-JP");}
const $ = (id) => document.getElementById(id);

const PRESETS_REF = (db) => doc(db, "bankConfig", "presets");
const ALIASES_REF = (db) => doc(db, "bankConfig", "payerAliases");
const COL_IDS = { date:"bankColDate", deposit:"bankColDeposit", withdrawal:"bankColWithdrawal", amount:"bankColAmount", payer:"bankColPayer", balance:"bankColBalance" };
const OPTIONAL_COLS = ["withdrawal", "balance"];

/**
 * 画面を初期化する（ログイン・権限の確認のあとで1回だけ呼ぶ）。
 * @param {{db:any, getShipments:()=>object[], getUser:()=>any, toast:(m:string)=>void, isViewer:boolean}} ctx
 */
export function initBankImport(ctx){
  const { db, getShipments, getUser, toast } = ctx;
  let csvRows = [];          // parseCsv の結果（画面の中だけで持つ。保存しない）
  let presets = {};          // 名前 → 割り当て
  let hashed = [];           // hashRows の結果
  let matched = [];          // buildCandidates の結果
  let imported = new Set();  // 既に bankTxns にある hash（＝取込済みの可能性。同じ日付・金額・名義の別の振込もここに入る）
  let recordedNow = new Set(); // この画面で記録した hash（記録済みとして選べなくする）
  let selection = new Map(); // 行番号 → 出荷ID
  let busy = false;

  const btn = $("bankImportBtn");
  if(!btn) return;
  if(ctx.isViewer){ btn.disabled = true; btn.title = "閲覧のみの権限では操作できません"; return; }

  const showErr = (m) => { const e=$("bankError"); e.textContent=m||""; e.style.display=m?"block":"none"; };
  const close = () => { $("bankModal").classList.remove("open"); csvRows=[]; hashed=[]; matched=[]; selection=new Map(); };

  function resetAll(){
    $("bankFile").value = "";
    $("bankFileInfo").textContent = "";
    $("bankMapWrap").style.display = "none";
    $("bankResultWrap").style.display = "none";
    $("bankResultBody").innerHTML = "";
    showErr("");
    csvRows=[]; hashed=[]; matched=[]; imported=new Set(); recordedNow=new Set(); selection=new Map();
    updateCount();
  }

  async function loadPresets(){
    try{
      const s = await getDoc(PRESETS_REF(db));
      presets = (s.exists() && s.data().presets) || {};
    }catch(e){ console.warn("bankConfig/presets:", e.message); presets = {}; }
    const sel = $("bankPreset");
    sel.innerHTML = `<option value="">（選ばない）</option>`
      + Object.keys(presets).sort((a,b)=>a.localeCompare(b,"ja")).map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
  }

  async function open(){
    resetAll();
    $("bankModal").classList.add("open");
    await loadPresets();
  }

  // ===== 2. 列の割り当て =====
  function colCount(){ return csvRows.slice(0, 20).reduce((a,r)=>Math.max(a, r.length), 0); }
  function fillColSelects(){
    const n = colCount();
    for(const [k,id] of Object.entries(COL_IDS)){
      const el = $(id);
      const none = OPTIONAL_COLS.includes(k) ? "（使わない）" : "（選んでください）";
      el.innerHTML = `<option value="">${none}</option>` + Array.from({length:n},(_,i)=>`<option value="${i}">列${i+1}</option>`).join("");
    }
  }
  function renderPreview(){
    const n = colCount();
    $("bankPreviewHead").innerHTML = `<tr><th>行</th>${Array.from({length:n},(_,i)=>`<th>列${i+1}</th>`).join("")}</tr>`;
    $("bankPreviewBody").innerHTML = csvRows.slice(0, 5).map((r,i)=>
      `<tr><td>${i+1}</td>${Array.from({length:n},(_,j)=>`<td>${esc(r[j]??"")}</td>`).join("")}</tr>`).join("");
  }
  function setMode(mode){
    $("bankMode").value = mode === "single" ? "single" : "split";
    const single = $("bankMode").value === "single";
    document.querySelectorAll("#bankModal .bank-split").forEach(x=>x.style.display = single ? "none" : "");
    document.querySelectorAll("#bankModal .bank-single").forEach(x=>x.style.display = single ? "" : "none");
  }
  function applyMapping(m){
    $("bankSkip").value = String(Number(m.skip)||0);
    setMode(m.mode || (Number.isInteger(m.amount) && !Number.isInteger(m.deposit) ? "single" : "split"));
    for(const [k,id] of Object.entries(COL_IDS)){
      const v = m[k];
      $(id).value = Number.isInteger(v) && v < colCount() ? String(v) : "";
    }
  }
  function readMappingUi(){
    const ui = { skip: $("bankSkip").value, mode: $("bankMode").value };
    for(const [k,id] of Object.entries(COL_IDS)) ui[k] = $(id).value;
    return ui;
  }

  async function onFile(e){
    showErr("");
    $("bankResultWrap").style.display = "none";
    selection = new Map(); updateCount();
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    try{
      const { text, encoding } = decodeBankFile(await f.arrayBuffer());
      csvRows = parseCsv(text).filter(r => r.some(c => String(c||"").trim() !== ""));
      if(!csvRows.length){ showErr("読み込める行がありません"); return; }
      $("bankFileInfo").textContent = `${f.name}（${encoding === "shift_jis" ? "Shift_JIS" : "UTF-8"}・${csvRows.length}行）`;
      fillColSelects();
      renderPreview();
      applyMapping(guessMapping(csvRows));
      $("bankPreset").value = "";
      $("bankMapWrap").style.display = "block";
    }catch(err){ showErr(`ファイルを読めませんでした: ${err.message}`); }
  }

  async function savePreset(){
    showErr("");
    const name = $("bankPresetName").value.trim();
    if(!name){ showErr("割り当ての名前を入れてください"); return; }
    const r = toMapRowsMapping(readMappingUi());
    if(r.error){ showErr(r.error); return; }
    const user = getUser();
    // merge は入れ子の項目も混ぜるので、使わない列も null で書いて前の割り当ての残りを消す
    const full = { mode: $("bankMode").value, skip: r.mapping.skip };
    for(const k of Object.keys(COL_IDS)) full[k] = Number.isInteger(r.mapping[k]) ? r.mapping[k] : null;
    try{
      await setDoc(PRESETS_REF(db), {
        presets: { [name]: full },
        updatedAt: serverTimestamp(), updatedBy: user.displayName||user.email,
      }, { merge: true });
      await loadPresets();
      $("bankPreset").value = name;
      toast(`列の割り当て「${name}」を保存しました`);
    }catch(e){ showErr(`保存に失敗: ${e.message}`); }
  }

  // ===== 3. 照合 =====
  async function runMatch(){
    showErr("");
    const r = toMapRowsMapping(readMappingUi());
    if(r.error){ showErr(r.error); return; }
    const btnM = $("bankMatchBtn"); btnM.disabled = true;
    try{
      const { rows, skipped } = mapRows(csvRows, r.mapping);
      hashed = await hashRows(rows);
      // 取込済みの判定（記録した行だけ bankTxns にある）
      const exists = await Promise.all(hashed.map(h => getDoc(doc(db, "bankTxns", h.hash)).then(s=>s.exists()).catch(()=>false)));
      imported = new Set(hashed.filter((h,i)=>exists[i]).map(h=>h.hash));
      recordedNow = new Set();
      let aliases = {};
      try{ const s = await getDoc(ALIASES_REF(db)); aliases = (s.exists() && s.data().aliases) || {}; }
      catch(e){ console.warn("bankConfig/payerAliases:", e.message); }
      matched = buildCandidates(hashed, getShipments(), { aliases });
      selection = initialSelection(autoSelect(matched), hashed, imported);
      const outs = skipped.filter(x=>x.reason==="出金").length;
      $("bankResultInfo").textContent = `入金 ${hashed.length}行（うち取込済みの可能性 ${imported.size}行・最初から選択 ${selection.size}行）`
        + `／読み飛ばし ${skipped.length}行（出金 ${outs}・その他 ${skipped.length-outs}）`;
      renderResult();
      $("bankResultWrap").style.display = "block";
    }catch(e){ showErr(`照合に失敗: ${e.message}`); }
    finally{ btnM.disabled = false; }
  }

  function openShipmentsForPick(){
    // 候補に出なかったときに手で選べるように、入金を待っている出荷（発送済・請求済で残額あり）を並べる
    return getShipments().filter(s=>["shipped","invoiced"].includes(s.status||"shipped") && remainOf(s)>0)
      .sort((a,b)=>String(a.soNumber||"").localeCompare(String(b.soNumber||"")));
  }
  function shipLabel(s){
    const bill = s.shipType==="dropship" ? (s.partnerName||s.partnerEmail||"") : (s.company||s.officeName||"");
    return `${s.soNumber||""} ${bill} 残${yen(remainOf(s))}${(s.status||"shipped")==="shipped"?"（未請求）":""}`;
  }
  function renderResult(){
    const others = openShipmentsForPick();
    $("bankResultBody").innerHTML = matched.map(m=>{
      // done … この画面で記録した行（選べない）／maybe … 同じ日付・金額・名義の明細を記録済み（自動では選ばないが、人は選べる）
      const r = m.row, done = recordedNow.has(r.hash), maybe = !done && imported.has(r.hash);
      const cur = selection.get(r.index) || "";
      const candIds = new Set(m.candidates.map(c=>c.shipmentId));
      const opts = `<option value="">（記録しない）</option>`
        + (m.candidates.length ? `<optgroup label="候補">${m.candidates.map(c=>
            `<option value="${esc(c.shipmentId)}"${c.shipmentId===cur?" selected":""}>${esc(shipLabel(c.shipment))}（${c.score}点）</option>`).join("")}</optgroup>` : "")
        + `<optgroup label="その他の入金待ちの出荷">${others.filter(s=>!candIds.has(s._id)).map(s=>
            `<option value="${esc(s._id)}"${s._id===cur?" selected":""}>${esc(shipLabel(s))}</option>`).join("")}</optgroup>`;
      const c = m.candidates.find(x=>x.shipmentId===cur);
      const base = c ? c.reasons.join("・") : (cur ? "手で選択" : (m.candidates.length ? "" : "候補なし"));
      const reasons = done ? "取込済み" : (maybe ? ["取込済みの可能性（同じ日付・金額・名義の明細を記録済み）。別の振込のときだけ選んでください", base].filter(Boolean).join("・") : base);
      return `<tr data-idx="${r.index}"${done||maybe?' style="opacity:.6"':""}>
        <td>${esc(r.date)}</td><td class="num">${yen(r.amount)}</td><td>${esc(r.payer)}</td>
        <td>${done ? `<span class="badge badge-2">取込済み</span>`
          : (maybe ? `<span class="badge badge-5" style="margin-right:4px">取込済みの可能性</span>` : "") + `<select class="form-control bank-pick" data-idx="${r.index}" aria-label="${esc(r.date)} ${esc(yen(r.amount))} を記録する出荷" style="min-width:260px;font-size:12px">${opts}</select>`}</td>
        <td style="font-size:12px">${esc(reasons)}</td><td class="num">${c ? c.score : ""}</td></tr>`;
    }).join("") || `<tr><td colspan="6" style="color:var(--color-ink-muted)">入金の行がありません</td></tr>`;
    document.querySelectorAll("#bankResultBody .bank-pick").forEach(el=>el.addEventListener("change",()=>{
      const idx = Number(el.dataset.idx);
      if(el.value) selection.set(idx, el.value); else selection.delete(idx);
      renderResult();
    }));
    updateCount();
  }
  function updateCount(){
    const n = groupByShipment(selection, hashed, recordedNow).reduce((a,g)=>a+g.rows.length,0);
    $("doBankLabel").textContent = `選んだ ${n}件を入金として記録`;
    $("doBankBtn").disabled = busy || n === 0;
  }

  // ===== 4. 記録 =====
  async function commit(){
    if(busy) return;
    showErr("");
    const user = getUser();
    const by = user.displayName||user.email;
    // 取込済みの可能性がある行も、人が選んだものは対象にする（下で「別の振込として記録しますか？」を確かめる）
    const groups = groupByShipment(selection, hashed, recordedNow);
    if(!groups.length) return;
    const ships = getShipments();
    // 記録の前に、過入金・一部入金・未請求を確かめる（既存の「入金を記録する」と同じ文）
    for(const g of groups){
      const s = ships.find(x=>x._id===g.shipmentId);
      if(!s){ showErr("選んだ出荷が見つかりません。画面を更新してください"); return; }
      g.shipment = s;
      g.expectRemain = remainOf(s);
      const msg = payConfirmText(s, g.amount);
      if(msg && !confirm(`${msg}\n\nこの金額で記録しますか？`)) return;
      const maybe = g.rows.filter(r=>imported.has(r.hash));
      if(maybe.length && !confirm(`${s.soNumber||""}：${maybe.map(r=>`${r.date} ${yen(r.amount)} ${r.payer}`).join("、")} は、同じ日付・金額・名義の明細がすでに記録されています（取込済みの可能性）。\n\n同じ振込を二重に記録していないか確かめてください。別の振込として記録しますか？`)) return;
    }
    busy = true; updateCount();
    const ok = [], ng = [];
    for(const g of groups){
      try{
        const ref = doc(db, "shipments", g.shipmentId);
        await runTransaction(db, async (tx)=>{
          // 読み取りを先にすべて行う（Firestore のトランザクションの決まり）
          const snap = await tx.get(ref);
          if(!snap.exists()) throw new Error("この出荷は削除されています");
          // 取り込み記録のID: 普通は hash。人が「別の振込」と確かめた行（取込済みの可能性）は hash-2, -3 … の空きを探す
          const txnIds = [];
          for(const r of g.rows){
            if(!imported.has(r.hash)){
              if((await tx.get(doc(db, "bankTxns", r.hash))).exists()) throw new Error("この明細はすでに取り込まれています（画面を閉じて照合し直してください）");
              txnIds.push(r.hash); continue;
            }
            const cands = bankTxnIdCandidates(r.hash), ex = [];
            let id = null;
            for(const cid of cands){
              const e = (await tx.get(doc(db, "bankTxns", cid))).exists();
              ex.push(e);
              if(!e){ id = pickFreeTxnId(r.hash, ex); break; }
            }
            if(!id) throw new Error("同じ日付・金額・名義の明細が多すぎます。手で入金を記録してください");
            txnIds.push(id);
          }
          const cur = { _id: snap.id, ...snap.data() };
          // 確認したときと残額が変わっていたら止める（別の人が入金を記録した等）
          if(remainOf(cur) !== g.expectRemain) throw new Error(`残額が変わっています（${yen(g.expectRemain)} → ${yen(remainOf(cur))}）。画面を更新してやり直してください`);
          const recordedAt = new Date().toISOString();
          const pays = g.rows.map((r,i)=>bankPaymentOf(r, { recordedBy: by, recordedAt }, txnIds[i]));
          const { patch } = applyBankPayments(cur, pays);
          tx.update(ref, { ...patch, updatedAt: serverTimestamp(), updatedBy: by });
          // tx の中で「無い」を確かめたIDにだけ書く（同時に別の人が書けば tx がやり直しになる＝create と同じ効き目）
          g.rows.forEach((r,i)=>tx.set(doc(db, "bankTxns", txnIds[i]), { ...bankTxnDocOf(r, cur, by), confirmedAt: serverTimestamp() }));
          g.shipment = cur;
        });
        ok.push(g);
        for(const r of g.rows){ imported.add(r.hash); recordedNow.add(r.hash); }
      }catch(e){ ng.push(`${g.shipment?.soNumber||g.shipmentId}: ${e.message}`); }
    }
    // 名義の学習（正規化名義 → 請求先キー）。失敗しても入金の記録は済んでいるので警告だけ
    if(ok.length){
      const learn = aliasLearnings(ok);
      if(learn.size){
        const aliases = {};
        for(const [k,v] of learn) aliases[k] = arrayUnion(...v);
        try{ await setDoc(ALIASES_REF(db), { aliases, updatedAt: serverTimestamp(), updatedBy: by }, { merge: true }); }
        catch(e){ console.warn("名義の学習の保存に失敗:", e.message); }
      }
    }
    busy = false;
    for(const g of ok) for(const r of g.rows) selection.delete(r.index);
    renderResult();
    const nOk = ok.reduce((a,g)=>a+g.rows.length,0);
    if(ng.length){ showErr(`記録できなかったもの（${ng.length}件）: ${ng.join(" ／ ")}`); }
    if(nOk) toast(`入金を${nOk}件記録しました（出荷 ${ok.length}件）`);
  }

  // ===== イベント =====
  btn.addEventListener("click", open);
  $("closeBankBtn").addEventListener("click", close);
  $("cancelBankBtn").addEventListener("click", close);
  $("bankFile").addEventListener("change", onFile);
  $("bankMode").addEventListener("change", (e)=>setMode(e.target.value));
  $("bankPreset").addEventListener("change", (e)=>{ const p = presets[e.target.value]; if(p){ applyMapping(p); $("bankPresetName").value = e.target.value; } });
  $("bankSavePresetBtn").addEventListener("click", savePreset);
  $("bankMatchBtn").addEventListener("click", runMatch);
  $("doBankBtn").addEventListener("click", commit);
}
