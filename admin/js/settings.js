import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast1");

function $(id){ return document.getElementById(id); }
function toast(m){const t=$("toast");t.textContent=m;t.style.display="block";clearTimeout(t._t);t._t=setTimeout(()=>t.style.display="none",2500);}

// サイドメニューは sidebar.js（SSOT・非module）が #nav に描画する。ここでは扱わない。

function escAttr(s){ return String(s||"").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
function addSenderRow(d){
  const wrap=document.createElement("div");
  wrap.className="sender-row";
  wrap.style.cssText="border:1px solid var(--color-line);border-radius:8px;padding:10px 12px;margin-bottom:8px";
  wrap.innerHTML=`
    <div style="display:flex;gap:8px;align-items:flex-end">
      <div class="form-group" style="flex:1;margin:0"><label class="form-label">差出人名</label><input class="form-control s-name" type="text" value="${escAttr(d.name)}" placeholder="NPO法人タダカヨ 介護情報基盤伴走支援事業"></div>
      <button class="btn btn-danger s-del" type="button" style="font-size:12px;padding:6px 10px"><i class="ti ti-trash" aria-hidden="true"></i></button>
    </div>
    <div class="form-row" style="margin-top:8px">
      <div class="form-group" style="margin:0"><label class="form-label">郵便番号</label><input class="form-control s-postal" type="text" value="${escAttr(d.postal)}" placeholder="000-0000"></div>
      <div class="form-group" style="margin:0"><label class="form-label">電話番号</label><input class="form-control s-phone" type="text" value="${escAttr(d.phone)}"></div>
    </div>
    <div class="form-group" style="margin:8px 0 0"><label class="form-label">住所</label><input class="form-control s-address" type="text" value="${escAttr(d.address)}"></div>`;
  wrap.querySelector(".s-del").addEventListener("click",()=>wrap.remove());
  $("sendersList").appendChild(wrap);
}
function renderSenders(list){ $("sendersList").innerHTML=""; (list.length?list:[{}]).forEach(addSenderRow); }
function collectSenders(){
  return Array.from(document.querySelectorAll("#sendersList .sender-row")).map(r=>({
    name:r.querySelector(".s-name").value.trim(),
    postal:r.querySelector(".s-postal").value.trim(),
    phone:r.querySelector(".s-phone").value.trim(),
    address:r.querySelector(".s-address").value.trim(),
  })).filter(s=>s.name||s.address||s.postal||s.phone);
}

// 印影画像（発注書の角印）。data URI を appConfig/settings.poSealImage に保存
let poSealImage = "";
function updateSealPreview(){
  const pv = $("poSealPreview");
  if (poSealImage){ $("poSealImg").src = poSealImage; pv.style.display = "flex"; }
  else { pv.style.display = "none"; }
}
// アップロード画像を「黒背景→透過＋縮小」してdata URI化（Pillowのalpha=最大チャンネル方式をcanvasで再現）
function processSealImage(file){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=>{
      const max = 200;
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * sc));
      const h = Math.max(1, Math.round(img.height * sc));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h); const p = d.data;
      for (let i=0; i<p.length; i+=4){ p[i+3] = Math.max(p[i], p[i+1], p[i+2]); } // alpha=max(R,G,B)
      ctx.putImageData(d, 0, 0);
      resolve(cv.toDataURL("image/png"));
    };
    img.onerror = reject;
    const fr = new FileReader();
    fr.onload = ()=>{ img.src = fr.result; };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

const DEFAULT_PO_MAIL_BODY = `{{仕入先名}}
{{担当者}}

平素より大変お世話になっております。NPO法人タダカヨ 介護情報基盤伴走支援事業でございます。

下記のとおり発注いたします。発注書を添付いたしましたので、ご確認のほどよろしくお願いいたします。

■ 発注番号: {{発注番号}}
■ 品目: {{品目}}
■ 金額（税別）: {{金額}}
■ 希望納期: {{希望納期}}

お手数ですが、発注書にご署名・ご捺印の上、ご返送いただけますと幸いです。
何卒よろしくお願い申し上げます。

NPO法人タダカヨ 介護情報基盤伴走支援事業`;

const testFn = httpsCallable(functions, "testChatNotify");

onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db,user,{adminOnly:true}))) return;
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", ()=>signOut(auth).then(()=>location.href="/index.html"));

  const snap = await getDoc(doc(db,"appConfig","settings"));
  const s = snap.exists() ? snap.data() : {};
  $("chatWebhookUrl").value = s.chatWebhookUrl || "";
  $("gmailSender").value = s.gmailSender || "kjk-staff@tadakayo.jp";
  // 差出人リスト（旧単一値があれば移行）
  let senders = Array.isArray(s.senders) ? s.senders.slice() : [];
  if (!senders.length && s.senderName) senders = [{ name:s.senderName, postal:s.senderPostal||"", address:s.senderAddress||"", phone:s.senderPhone||"" }];
  renderSenders(senders);
  $("addSenderBtn").addEventListener("click", ()=>{ addSenderRow({}); });
  // 発注書（発行元・発注者）
  $("poIssuerName").value = s.poIssuerName || "";
  $("poIssuerAddr").value = s.poIssuerAddr || "";
  $("poIssuerRep").value = s.poIssuerRep || "";
  // 発注者一覧（旧単一値 poOrdererName があれば移行）
  $("poOrderers").value = (Array.isArray(s.poOrderers) ? s.poOrderers : (s.poOrdererName ? [s.poOrdererName] : [])).join("\n");
  $("poSealText").value = s.poSealText || "";
  poSealImage = s.poSealImage || "";
  updateSealPreview();
  $("poSealFile").addEventListener("change", async (e)=>{
    const f = e.target.files && e.target.files[0]; if(!f) return;
    try{ poSealImage = await processSealImage(f); updateSealPreview(); toast("印影を読み込みました（黒背景を透過処理）。「保存」で確定します"); }
    catch(_){ toast("画像の読み込みに失敗しました"); }
  });
  $("poSealClear").addEventListener("click", ()=>{ poSealImage=""; $("poSealFile").value=""; updateSealPreview(); });
  // 仕入先（ABサークル）— 確定値を初期表示（未保存でも見える。発注機能側にもフォールバックあり）
  $("supplierName").value = s.supplierName || "AB Circle Japan 株式会社";
  $("supplierContact").value = s.supplierContact || "野田 様";
  $("supplierEmail").value = s.supplierEmail || "h.noda@abcircle.com";
  $("supplierCc").value = s.supplierCc || "n.taniguchi@abcircle.com, s.oda@abcircle.co.jp";
  $("supplierPostal").value = s.supplierPostal || "";
  $("supplierAddress").value = s.supplierAddress || "";
  // 発注メール定型文（未保存ならデフォルト文面）
  $("poMailSubject").value = s.poMailSubject || "【発注書送付】NPO法人タダカヨ（{{発注番号}}）";
  $("poMailBody").value = s.poMailBody || DEFAULT_PO_MAIL_BODY;
  $("subsidyDeadline").value = s.subsidyDeadline || "";
  $("invoiceIssuerName").value = s.invoiceIssuerName || "";
  $("invoiceRegNo").value = s.invoiceRegNo || "";
  $("billingBankName").value = s.billingBankName || "";
  $("billingBranchName").value = s.billingBranchName || "";
  $("billingAccountType").value = s.billingAccountType || "普通";
  $("billingAccountNumber").value = s.billingAccountNumber || "";
  $("billingAccountHolder").value = s.billingAccountHolder || "";
  $("loadingEl").style.display = "none";
  $("form").style.display = "block";

  $("saveBtn").addEventListener("click", async ()=>{
    const st=$("saveStatus");
    try{
      await setDoc(doc(db,"appConfig","settings"),{
        chatWebhookUrl: $("chatWebhookUrl").value.trim(),
        gmailSender: $("gmailSender").value.trim(),
        senders: collectSenders(),
        poIssuerName: $("poIssuerName").value.trim(),
        poIssuerAddr: $("poIssuerAddr").value.trim(),
        poIssuerRep: $("poIssuerRep").value.trim(),
        poOrderers: $("poOrderers").value.split("\n").map(x=>x.trim()).filter(Boolean),
        poOrdererName: ($("poOrderers").value.split("\n").map(x=>x.trim()).filter(Boolean)[0]) || "",
        poSealText: $("poSealText").value.trim(),
        poSealImage: poSealImage || "",
        supplierName: $("supplierName").value.trim(),
        supplierContact: $("supplierContact").value.trim(),
        supplierEmail: $("supplierEmail").value.trim(),
        supplierCc: $("supplierCc").value.trim(),
        supplierPostal: $("supplierPostal").value.trim(),
        supplierAddress: $("supplierAddress").value.trim(),
        poMailSubject: $("poMailSubject").value.trim(),
        poMailBody: $("poMailBody").value,
        subsidyDeadline: $("subsidyDeadline").value || "",
        invoiceIssuerName: $("invoiceIssuerName").value.trim(),
        invoiceRegNo: $("invoiceRegNo").value.trim(),
        billingBankName: $("billingBankName").value.trim(),
        billingBranchName: $("billingBranchName").value.trim(),
        billingAccountType: $("billingAccountType").value,
        billingAccountNumber: $("billingAccountNumber").value.trim(),
        billingAccountHolder: $("billingAccountHolder").value.trim(),
        updatedAt: serverTimestamp(), updatedBy: user.email,
      },{merge:true});
      st.style.color="var(--color-success)"; st.textContent="保存しました（反映まで最大60秒）";
      toast("設定を保存しました");
    }catch(e){ st.style.color="var(--color-danger)"; st.textContent=`保存に失敗: ${e.message}`; }
  });

  $("testBtn").addEventListener("click", async ()=>{
    const st=$("saveStatus"); st.style.color="var(--color-ink-muted)"; st.innerHTML='<i class="ti ti-loader-2 ti-spin"></i> 送信中...';
    try{ await testFn({}); st.style.color="var(--color-success)"; st.textContent="Chatにテスト通知を送信しました（保存済みURLへ）"; }
    catch(e){ st.style.color="var(--color-danger)"; st.textContent=`テスト失敗: ${e.message}`; }
  });
});
