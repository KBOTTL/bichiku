// わが家の備蓄帳 — GitHub Pages + Firebase 版
import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ---------- 定数 ---------- */
const CATS = {
  water:  { label:"水",     unit:"L",  perDay:3, perHint:"1本あたりの量（L）。2Lペットボトルなら 2", defPer:2, defCount:"本" },
  staple: { label:"主食",   unit:"食", perDay:3, perHint:"1個で何食分か。アルファ米・パックご飯なら 1", defPer:1, defCount:"個" },
  main:   { label:"おかず", unit:"食", perDay:3, perHint:"1個で何食分か。缶詰・レトルトなら 1", defPer:1, defCount:"個" },
  other:  { label:"その他", unit:null, perDay:0, perHint:"", defPer:1, defCount:"個" },
};
const COUNT_UNITS = ["個","本","缶","袋","箱","パック","食"];
const NEED_CATS = ["water","staple","main"];

/* ---------- 状態 ---------- */
const S = {
  items: [], shop: [], logs: [], settings: { people: 0, days: 7 },
  loaded: false, tab: "stock", filter: "all", q: "", user: null, unsub: []
};

const $ = (s, r=document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = (v, d=0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const fmt = n => (Math.round(n*10)/10).toLocaleString("ja-JP");

/* ---------- Firebase ---------- */
if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("ここに")) {
  showBanner("config.js に Firebase の設定がまだ入っていません。README の手順 1 を確認してください。");
  throw new Error("firebaseConfig missing");
}
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
auth.languageCode = "ja";
let db;
try {
  // 端末内にデータを保存し、電波がなくても在庫を見られるようにする
  db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch {
  db = initializeFirestore(fbApp, {});
}

// 書き込みはオフラインでも即座に画面へ反映される。サーバー確認は待たない。
function w(p){ p.catch(writeErr); }

/* ---------- 日付 ---------- */
function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function daysLeft(exp){
  if(!exp) return null;
  const [y,m,d] = exp.split("-").map(Number); if(!y||!m||!d) return null;
  const t = new Date(); const a = Date.UTC(t.getFullYear(),t.getMonth(),t.getDate()); const b = Date.UTC(y,m-1,d);
  return Math.round((b-a)/86400000);
}
function status(dl){ if(dl===null) return "none"; if(dl<0) return "bad"; if(dl<=30) return "warn"; if(dl<=90) return "soon"; return "ok"; }
function leftLabel(dl){
  if(dl===null) return "期限なし";
  if(dl<0) return `${-dl}日超過`;
  if(dl===0) return "今日まで";
  if(dl<=90) return `あと${dl}日`;
  const mo = Math.floor(dl/30.4); return mo>=24 ? `あと${Math.floor(dl/365)}年` : `あと${mo}か月`;
}
function fmtDate(exp){ if(!exp) return "—"; const [y,m,d]=exp.split("-"); return `${y}.${m}.${d}`; }
function amount(it){ return num(it.qty)*num(it.perUnit,1); }

function coverage(){
  const p = num(S.settings.people), days = num(S.settings.days,7);
  return NEED_CATS.map(k => {
    const c = CATS[k];
    let have=0, expiring=0;
    for(const it of S.items){ if(it.category!==k) continue; const dl=daysLeft(it.expiry); if(dl!==null && dl<0) continue; have+=amount(it); if(dl!==null && dl<=30) expiring+=amount(it); }
    const perDayAll = c.perDay*p, need = perDayAll*days;
    return { k, c, have, expiring, need, daysCovered: perDayAll>0 ? have/perDayAll : null };
  });
}

/* ---------- 画面切り替え ---------- */
function showScreen(name){
  $("#login").hidden = name!=="login";
  $("#verify").hidden = name!=="verify";
  $("#app").hidden = name!=="app";
  $("#acctBtn").hidden = name==="login";
  if(name!=="app") $("#fab").hidden = true;
}
function showBanner(t){ const b=$("#banner"); b.textContent=t; b.hidden=!t; }

/* ---------- 描画 ---------- */
function renderHeader(){
  $("#today").textContent = todayStr().replaceAll("-",".");
  let ex=0, soon=0;
  for(const it of S.items){ const dl=daysLeft(it.expiry); if(dl===null) continue; if(dl<0) ex++; else if(dl<=30) soon++; }
  $("#tExpired b").textContent = S.loaded ? ex : "–";
  $("#tSoon b").textContent = S.loaded ? soon : "–";
  const cov = coverage();
  const min = S.settings.people>0 ? Math.min(...cov.map(c=>c.daysCovered ?? 0)) : null;
  $("#tDays b").textContent = (!S.loaded || min===null) ? "–" : `${Math.floor(min*10)/10}`;
  $("#tDays span").textContent = S.settings.people>0 ? `備え（${S.settings.people}人で何日分）` : "備え（人数を設定）";
  $("#nStock").textContent = S.items.length ? S.items.length : "";
  const open = S.shop.filter(s=>!s.done).length; $("#nShop").textContent = open ? open : "";
  $("#fab").hidden = $("#app").hidden || S.tab==="log" || S.tab==="need";
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-selected", String(b.dataset.tab===S.tab)));
}

function renderStock(){
  const chips = [["all","すべて"],...Object.entries(CATS).map(([k,c])=>[k,c.label]),["alert","要注意"]];
  let items = S.items.slice();
  if(S.filter==="alert") items = items.filter(it=>{const dl=daysLeft(it.expiry); return dl!==null && dl<=30;});
  else if(S.filter!=="all") items = items.filter(it=>it.category===S.filter);
  if(S.q){ const q=S.q.toLowerCase(); items = items.filter(it=>(it.name||"").toLowerCase().includes(q)||(it.location||"").toLowerCase().includes(q)); }
  items.sort((a,b)=>{ const da=daysLeft(a.expiry), dbb=daysLeft(b.expiry); return (da??1e9)-(dbb??1e9) || String(a.name).localeCompare(String(b.name),"ja"); });

  let body;
  if(!S.loaded) body = `<div class="empty"><strong>読み込み中…</strong></div>`;
  else if(!S.items.length) body = `<div class="empty"><strong>まだ備蓄が登録されていません</strong>右下の「＋ 追加」から、水・主食・おかずなどを登録してください。<br>品名・数量・賞味期限・保管場所を入れると、期限が近い順に並びます。</div>`;
  else if(!items.length) body = `<div class="empty"><strong>該当するものはありません</strong>絞り込みを「すべて」に戻すと全件表示されます。</div>`;
  else body = `<ul class="list">${items.map(it=>{
      const dl=daysLeft(it.expiry), st=status(dl), c=CATS[it.category]||CATS.other;
      const amt = c.unit ? `（${fmt(amount(it))}${c.unit}）` : "";
      return `<li><button class="row ${st}" data-item="${esc(it.id)}" type="button"><span class="stripe"></span>
        <span class="main"><span class="name"><span class="cat">${esc(c.label)}</span>${esc(it.name)}</span>
        <span class="meta">${fmt(num(it.qty))}${esc(it.countUnit||"個")}${amt}${it.location?` ・ ${esc(it.location)}`:""}</span></span>
        <span class="exp">${fmtDate(it.expiry)}<span class="left">${leftLabel(dl)}</span></span></button></li>`;}).join("")}</ul>`;

  $("#view").innerHTML = `
    <div class="tools">
      <div class="chips">${chips.map(([k,l])=>`<button class="chip" data-filter="${k}" aria-pressed="${S.filter===k}" type="button">${l}</button>`).join("")}</div>
      <input class="search" id="q" type="search" placeholder="品名・保管場所で検索" value="${esc(S.q)}" aria-label="検索">
    </div>${body}`;
}

function renderNeed(){
  const p=num(S.settings.people), days=num(S.settings.days,7);
  const gauges = coverage().map(g=>{
    const pct = g.need>0 ? Math.min(100, g.have/g.need*100) : 0;
    const cls = g.have<=0 ? "none" : (g.have<g.need ? "short":"");
    const short = Math.max(0, g.need-g.have);
    const verdict = p<=0 ? `<span class="note">人数を設定すると判定します</span>`
      : (short>0 ? `<span class="verdict short">あと ${fmt(short)}${g.c.unit} 不足</span>` : `<span class="verdict ok">${days}日分 足りています</span>`);
    const dc = g.daysCovered===null ? "" : ` ・ 約${Math.floor(g.daysCovered*10)/10}日分`;
    const exp = g.expiring>0 ? `<div class="note">うち ${fmt(g.expiring)}${g.c.unit} が30日以内に期限切れ。早めに食べて買い足しを。</div>` : "";
    return `<div class="gauge">
      <div class="top"><h3>${g.c.label}</h3><span class="nums">${fmt(g.have)} / ${fmt(g.need)} ${g.c.unit}${dc}</span></div>
      <div class="bar" role="img" aria-label="${g.c.label} ${Math.round(pct)}%"><i class="${cls}" style="width:${pct}%"></i></div>
      <div>${verdict}</div>${exp}
      <div class="note">目安：1人1日 ${g.c.perDay}${g.c.unit}</div></div>`;
  }).join("");
  $("#view").innerHTML = `<div class="need">
    <div class="house">
      <div class="stepper"><span class="lbl">人数</span><button type="button" data-step="people" data-d="-1" aria-label="人数を減らす">−</button><output>${p}</output><button type="button" data-step="people" data-d="1" aria-label="人数を増やす">＋</button><span class="note">人</span></div>
      <div class="stepper"><span class="lbl">日数</span><button type="button" data-step="days" data-d="-1" aria-label="日数を減らす">−</button><output>${days}</output><button type="button" data-step="days" data-d="1" aria-label="日数を増やす">＋</button><span class="note">日分</span></div>
    </div>
    <p class="note" style="margin:0">最低3日分、できれば1週間分が目安とされています。期限切れの品は数えていません。</p>
    ${gauges}
  </div>`;
}

function renderShop(){
  const open = S.shop.filter(s=>!s.done).sort((a,b)=>num(b.at)-num(a.at));
  const add = `<form class="shop-add" id="shopForm"><input id="shopName" placeholder="買い足すものを追加（例：2L水 6本）" aria-label="買い足すもの"><button class="btn primary" type="submit">追加</button></form>`;
  const list = !S.loaded ? `<div class="empty"><strong>読み込み中…</strong></div>`
    : !open.length ? `<div class="empty"><strong>買い足しリストは空です</strong>在庫を「使った・食べた」で減らすと、ここに自動で追加されます。</div>`
    : `<ul class="list">${open.map(s=>{const c=CATS[s.category];
        return `<li class="srow"><div class="main"><div class="name">${c?`<span class="cat">${esc(c.label)}</span>`:""}${esc(s.name)}</div>
        <div class="note">${s.qty?`${fmt(num(s.qty))}${esc(s.countUnit||"個")} ・ `:""}${s.reason?esc(s.reason)+" ・ ":""}${new Date(num(s.at)).toLocaleDateString("ja-JP")}</div></div>
        <button class="btn primary" data-bought="${esc(s.id)}" type="button">買った</button><button class="btn" data-shopdel="${esc(s.id)}" type="button" aria-label="リストから外す">×</button></li>`;}).join("")}</ul>`;
  $("#view").innerHTML = add + list + (open.length?`<p class="note">「買った」を押すと、在庫の登録画面が開きます。</p>`:"");
}

function renderLog(){
  $("#view").innerHTML = !S.logs.length ? `<div class="empty"><strong>まだ記録はありません</strong>在庫の品を「使った・食べた」「処分した」で減らすと、ここに履歴が残ります。</div>`
    : `<ul class="log">${S.logs.map(l=>{const d=new Date(num(l.at));
      return `<li><time>${d.getMonth()+1}/${d.getDate()}</time><div><b>${esc(l.name)}</b> を ${fmt(num(l.qty))}${esc(l.countUnit||"個")} ${l.kind==="discard"?"処分":"消費"}</div>
      <div class="who">${l.byName?esc(l.byName)+" ・ ":""}${l.kind==="discard"?"期限切れなどで処分":"ローリングストック"}</div></li>`;}).join("")}</ul>`;
}

function render(){
  if($("#app").hidden) return;
  renderHeader();
  if(S.tab==="stock") renderStock(); else if(S.tab==="need") renderNeed(); else if(S.tab==="shop") renderShop(); else renderLog();
}

/* ---------- トースト・シート ---------- */
let toastT;
function toast(msg){ clearTimeout(toastT); $("#toastRoot").innerHTML=`<div class="toast" role="status">${esc(msg)}</div>`; toastT=setTimeout(()=>$("#toastRoot").innerHTML="",2600); }
function closeSheet(){ $("#sheetRoot").innerHTML=""; }
function openSheet(html){
  $("#sheetRoot").innerHTML = `<div class="sheet-back" id="back"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  $("#back").addEventListener("click", e=>{ if(e.target.id==="back") closeSheet(); });
}
function writeErr(e){
  if(e && e.code==="permission-denied") toast("このアカウントには編集する権限がありません");
  else toast("保存できませんでした。もう一度お試しください");
  console.error(e);
}

/* ---------- 商品名の自動入力 ---------- */
async function lookupProduct(code){
  // 1) 家族で登録済みの商品
  try{ const snap = await getDoc(doc(db,"products",code)); if(snap.exists()) return { ...snap.data(), source:"family" }; }catch{}
  // 2) Open Food Facts（日本の商品は登録が少なめ）
  if(!navigator.onLine) return null;
  try{
    const ctl = new AbortController(); const t = setTimeout(()=>ctl.abort(), 5000);
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_ja,brands`, { signal: ctl.signal });
    clearTimeout(t);
    if(!r.ok) return null;
    const j = await r.json();
    const p = j && j.product; if(!p) return null;
    const name = p.product_name_ja || p.product_name; if(!name) return null;
    return { name: p.brands ? `${name}（${p.brands.split(",")[0]}）` : name, source:"off" };
  }catch{ return null; }
}

/* ---------- 登録・編集フォーム ---------- */
function itemForm(it={}, opts={}){
  const cat = it.category || "staple";
  const c = CATS[cat];
  openSheet(`<h2>${it.id?"在庫を編集":"備蓄を追加"}</h2>
  <form id="itemForm" class="form" autocomplete="off">
    <div class="field full"><label for="fBarcode">バーコード（任意）</label>
      <div class="inline"><input id="fBarcode" inputmode="numeric" placeholder="JANコード" value="${esc(it.barcode||"")}">
      <label class="btn" for="fPhoto">撮影して読む</label><input id="fPhoto" type="file" accept="image/*" capture="environment" hidden></div>
      <span class="hint" id="bcHint">バーコードを撮影すると、分かる商品は品名が自動で入ります。</span></div>
    <div class="field full"><label for="fName">品名</label><input id="fName" required placeholder="例：アルファ米 五目ごはん" value="${esc(it.name||"")}"></div>
    <div class="field"><label for="fCat">種類</label><select id="fCat">${Object.entries(CATS).map(([k,v])=>`<option value="${k}" ${k===cat?"selected":""}>${v.label}</option>`).join("")}</select></div>
    <div class="field"><label for="fExp">賞味期限</label><input id="fExp" type="date" value="${esc(it.expiry||"")}"></div>
    <div class="field"><label for="fQty">数量</label><div class="inline"><input id="fQty" type="number" min="0" step="1" inputmode="numeric" value="${esc(it.qty ?? 1)}">
      <select id="fCount" aria-label="数える単位" style="width:auto">${COUNT_UNITS.map(u=>`<option ${u===(it.countUnit||c.defCount)?"selected":""}>${u}</option>`).join("")}</select></div></div>
    <div class="field" id="perWrap" ${c.unit?"":"hidden"}><label for="fPer" id="perLabel">1${esc(it.countUnit||c.defCount)}あたり（${c.unit||""}）</label><input id="fPer" type="number" min="0" step="0.1" inputmode="decimal" value="${esc(it.perUnit ?? c.defPer)}"><span class="hint" id="perHint">${esc(c.perHint)}</span></div>
    <div class="field full"><label for="fLoc">保管場所（任意）</label><input id="fLoc" placeholder="例：玄関収納、キッチン下" value="${esc(it.location||"")}" list="locList">
      <datalist id="locList">${[...new Set(S.items.map(i=>i.location).filter(Boolean))].map(l=>`<option value="${esc(l)}">`).join("")}</datalist></div>
    <div class="actions full">
      ${it.id?`<button class="btn danger" type="button" id="delBtn">削除</button><span class="spacer"></span>`:""}
      <button class="btn" type="button" id="cancelBtn">キャンセル</button>
      <button class="btn primary" type="submit">${it.id?"保存":"登録"}</button></div>
  </form>`);
  const syncCat = () => {
    const cc=CATS[$("#fCat").value];
    $("#perWrap").hidden = !cc.unit;
    $("#perLabel").textContent = `1${$("#fCount").value}あたり（${cc.unit||""}）`;
    $("#perHint").textContent = cc.perHint;
  };
  $("#fCat").addEventListener("change", ()=>{ const cc=CATS[$("#fCat").value]; if(!it.id){ $("#fPer").value=cc.defPer; $("#fCount").value=cc.defCount; } syncCat(); });
  $("#fCount").addEventListener("change", syncCat);
  $("#cancelBtn").addEventListener("click", closeSheet);
  const hint = (t, cls="") => { $("#bcHint").textContent=t; $("#bcHint").className="hint "+cls; };
  const applyProduct = async code => {
    if(!code) return;
    hint("商品を調べています…");
    const p = await lookupProduct(code);
    if(!$("#fBarcode")) return; // シートが閉じられた
    if(p){
      if(!$("#fName").value) $("#fName").value = p.name||"";
      if(p.category){ $("#fCat").value=p.category; }
      if(p.countUnit) $("#fCount").value=p.countUnit;
      if(p.perUnit!=null) $("#fPer").value=p.perUnit;
      syncCat();
      hint(p.source==="family" ? `登録済みの商品です：${p.name}。期限と数量を入れてください。` : `商品データベースで見つかりました。品名を確認して、種類を選んでください。`, "good");
    } else hint("この商品は見つかりませんでした。品名を入れて登録すると、次回から自動で入ります。");
  };
  $("#fBarcode").addEventListener("change", e=>{ const v=e.target.value.replace(/\D/g,""); e.target.value=v; if(!it.name) applyProduct(v); });
  $("#fPhoto").addEventListener("change", async e=>{
    const file=e.target.files&&e.target.files[0]; if(!file) return;
    hint("読み取り中…");
    try{ const code = await decodeBarcode(file);
      if(code){ $("#fBarcode").value=code; hint(`読み取りました：${code}`,"good"); if(!it.name) applyProduct(code); }
      else hint("バーコードが見つかりませんでした。バーコードを大きく写し、ピントを合わせて撮り直すか、数字を直接入力してください。","err");
    }catch{ hint("読み取り機能を読み込めませんでした。数字を直接入力してください。","err"); }
    e.target.value="";
  });
  if(it.id){
    const del=$("#delBtn"); let armed=false;
    del.addEventListener("click", ()=>{
      if(!armed){ armed=true; del.classList.add("armed"); del.textContent="本当に削除"; setTimeout(()=>{armed=false;del.classList.remove("armed");del.textContent="削除";},3000); return; }
      w(deleteDoc(doc(db,"items",it.id))); closeSheet(); toast("削除しました");
    });
  }
  $("#itemForm").addEventListener("submit", e=>{
    e.preventDefault();
    const name=$("#fName").value.trim(); if(!name){ $("#fName").focus(); return; }
    const k=$("#fCat").value;
    const body = { name, category:k, qty:Math.max(0,num($("#fQty").value,1)), countUnit:$("#fCount").value,
      perUnit: CATS[k].unit ? Math.max(0,num($("#fPer").value,CATS[k].defPer)) : 1,
      expiry:$("#fExp").value||"", location:$("#fLoc").value.trim(), barcode:$("#fBarcode").value.replace(/\D/g,""), updatedAt:Date.now() };
    w(setDoc(it.id ? doc(db,"items",it.id) : doc(collection(db,"items")), body));
    if(body.barcode) w(setDoc(doc(db,"products",body.barcode), {name:body.name,category:k,countUnit:body.countUnit,perUnit:body.perUnit}));
    if(opts.shopId) w(deleteDoc(doc(db,"shopping",opts.shopId)));
    closeSheet(); toast(it.id?"保存しました":"登録しました");
  });
}

function itemDetail(it){
  const dl=daysLeft(it.expiry), c=CATS[it.category]||CATS.other;
  const max=Math.max(1,num(it.qty));
  openSheet(`<h2>${esc(it.name)}</h2>
    <dl class="detail-dl"><dt>種類</dt><dd>${esc(c.label)}</dd>
    <dt>数量</dt><dd>${fmt(num(it.qty))}${esc(it.countUnit||"個")}${c.unit?`（${fmt(amount(it))}${c.unit}）`:""}</dd>
    <dt>賞味期限</dt><dd>${fmtDate(it.expiry)}　${leftLabel(dl)}</dd>
    ${it.location?`<dt>保管場所</dt><dd>${esc(it.location)}</dd>`:""}
    ${it.barcode?`<dt>JAN</dt><dd style="font-family:var(--f-mono)">${esc(it.barcode)}</dd>`:""}</dl>
    <div class="field" style="margin-top:12px"><span class="lbl">減らす数</span>
      <div class="stepper"><button type="button" id="cMinus" aria-label="減らす">−</button><output id="cOut">1</output><button type="button" id="cPlus" aria-label="増やす">＋</button><span class="note">/ ${fmt(num(it.qty))}${esc(it.countUnit||"個")}</span></div></div>
    <div class="seg" style="margin-top:10px" role="group" aria-label="理由"><button type="button" data-kind="eat" aria-pressed="true">使った・食べた</button><button type="button" data-kind="discard" aria-pressed="false">処分した</button></div>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="cShop" checked> 買い足しリストに追加する</label>
    <div class="actions"><button class="btn" type="button" id="editBtn">編集</button><span class="spacer"></span><button class="btn" type="button" id="closeBtn">閉じる</button><button class="btn primary" type="button" id="useBtn">在庫を減らす</button></div>`);
  $("#closeBtn").addEventListener("click", closeSheet);
  let n=1, kind="eat";
  $("#cMinus").addEventListener("click",()=>{n=Math.max(1,n-1);$("#cOut").textContent=n;});
  $("#cPlus").addEventListener("click",()=>{n=Math.min(max,n+1);$("#cOut").textContent=n;});
  document.querySelectorAll(".seg button").forEach(b=>b.addEventListener("click",()=>{kind=b.dataset.kind;document.querySelectorAll(".seg button").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));}));
  $("#editBtn").addEventListener("click",()=>itemForm(it));
  $("#useBtn").addEventListener("click", ()=>{
    const left = Math.max(0, num(it.qty)-n), at=Date.now();
    if(left<=0) w(deleteDoc(doc(db,"items",it.id)));
    else w(updateDoc(doc(db,"items",it.id), {qty:left, updatedAt:at}));
    const u=S.user;
    w(setDoc(doc(collection(db,"logs")), {name:it.name, qty:n, countUnit:it.countUnit||"個", kind, category:it.category||"other",
      by:u?u.uid:"", byName:u?(u.displayName||(u.email||"").split("@")[0]):"", at}));
    if($("#cShop").checked) w(setDoc(doc(collection(db,"shopping")), {name:it.name, qty:n, countUnit:it.countUnit||"個", category:it.category||"other",
      perUnit:it.perUnit??1, barcode:it.barcode||"", location:it.location||"", reason:kind==="discard"?"処分した分":"使った分", done:false, at}));
    closeSheet(); toast(left<=0?`${it.name} を使い切りました`:`残り ${fmt(left)}${it.countUnit||"個"}`);
  });
}

/* ---------- バーコード ---------- */
let zxingP=null;
function loadZXing(){
  if(window.ZXing) return Promise.resolve();
  if(!zxingP) zxingP = new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js"; s.onload=()=>res(); s.onerror=()=>{zxingP=null;rej(new Error("load"));}; document.head.appendChild(s); });
  return zxingP;
}
async function fileToCanvas(file, maxW){
  const url=URL.createObjectURL(file);
  try{ const img=new Image(); img.src=url; await img.decode();
    const sc=Math.min(1,maxW/Math.max(img.naturalWidth,img.naturalHeight));
    const cv=document.createElement("canvas"); cv.width=Math.round(img.naturalWidth*sc); cv.height=Math.round(img.naturalHeight*sc);
    cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height); return cv;
  } finally { URL.revokeObjectURL(url); }
}
async function decodeBarcode(file){
  const cv = await fileToCanvas(file, 1400);
  if("BarcodeDetector" in window){
    try{ const bd=new window.BarcodeDetector({formats:["ean_13","ean_8","upc_a","upc_e","code_128","itf"]}); const r=await bd.detect(cv); if(r&&r[0]) return r[0].rawValue; }catch{}
  }
  await loadZXing();
  const Z=window.ZXing; const hints=new Map();
  hints.set(Z.DecodeHintType.TRY_HARDER,true);
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS,[Z.BarcodeFormat.EAN_13,Z.BarcodeFormat.EAN_8,Z.BarcodeFormat.UPC_A,Z.BarcodeFormat.UPC_E,Z.BarcodeFormat.CODE_128,Z.BarcodeFormat.ITF]);
  const reader=new Z.MultiFormatReader(); reader.setHints(hints);
  for(const scale of [1, 0.6]){
    let c2=cv;
    if(scale!==1){ c2=document.createElement("canvas"); c2.width=Math.round(cv.width*scale); c2.height=Math.round(cv.height*scale); c2.getContext("2d").drawImage(cv,0,0,c2.width,c2.height); }
    try{ const src=new Z.HTMLCanvasElementLuminanceSource(c2); const r=reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(src))); if(r) return r.getText(); }catch{}
  }
  return null;
}

/* ---------- 操作 ---------- */
document.querySelector("nav.tabs").addEventListener("click", e=>{ const b=e.target.closest("button[data-tab]"); if(!b) return; S.tab=b.dataset.tab; try{localStorage.setItem("bichiku.tab",S.tab);}catch{} render(); });
$("#tExpired").addEventListener("click",()=>{S.tab="stock";S.filter="alert";render();});
$("#tSoon").addEventListener("click",()=>{S.tab="stock";S.filter="alert";render();});
$("#tDays").addEventListener("click",()=>{S.tab="need";render();});
$("#fab").addEventListener("click",()=>{ if(S.tab==="shop"){ const i=$("#shopName"); if(i) i.focus(); return; } itemForm({}); });

$("#view").addEventListener("click", e=>{
  const f=e.target.closest("[data-filter]"); if(f){ S.filter=f.dataset.filter; renderStock(); return; }
  const r=e.target.closest("[data-item]"); if(r){ const it=S.items.find(i=>i.id===r.dataset.item); if(it) itemDetail(it); return; }
  const st=e.target.closest("[data-step]");
  if(st){
    const key=st.dataset.step, d=num(st.dataset.d);
    const next={...S.settings}; next[key]=Math.max(key==="days"?1:0, Math.min(key==="days"?60:30, num(next[key])+d));
    S.settings=next; render(); scheduleSettings(); return;
  }
  const bought=e.target.closest("[data-bought]");
  if(bought){ const s=S.shop.find(x=>x.id===bought.dataset.bought); if(s) itemForm({name:s.name,category:s.category||"other",qty:s.qty||1,countUnit:s.countUnit,perUnit:s.perUnit,barcode:s.barcode,location:s.location},{shopId:s.id}); return; }
  const sd=e.target.closest("[data-shopdel]");
  if(sd) w(deleteDoc(doc(db,"shopping",sd.dataset.shopdel)));
});
$("#view").addEventListener("input", e=>{ if(e.target.id==="q"){ S.q=e.target.value; const pos=e.target.selectionStart; renderStock(); const q=$("#q"); q.focus(); try{q.setSelectionRange(pos,pos);}catch{} } });
$("#view").addEventListener("submit", e=>{
  if(e.target.id!=="shopForm") return; e.preventDefault();
  const v=$("#shopName").value.trim(); if(!v) return;
  w(setDoc(doc(collection(db,"shopping")), {name:v, done:false, at:Date.now(), reason:"手動で追加"})); $("#shopName").value="";
});
document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeSheet(); });

let setT=null;
function scheduleSettings(){ clearTimeout(setT); setT=setTimeout(()=>{ w(setDoc(doc(db,"settings","household"), {people:S.settings.people, days:S.settings.days})); setT=null; },700); }

/* ---------- ログイン ---------- */
const loginMsg = (t, cls="") => { $("#loginMsg").textContent=t; $("#loginMsg").className="hint "+cls; };
const AUTH_MSG = {
  "auth/invalid-email":"メールアドレスの形式が正しくありません。",
  "auth/invalid-credential":"メールアドレスかパスワードが違います。",
  "auth/wrong-password":"メールアドレスかパスワードが違います。",
  "auth/user-not-found":"このメールアドレスは登録されていません。「新規登録」を押してください。",
  "auth/email-already-in-use":"このメールアドレスは登録済みです。「ログイン」を押してください。",
  "auth/weak-password":"パスワードは6文字以上にしてください。",
  "auth/too-many-requests":"試行回数が多すぎます。しばらく待ってからお試しください。",
  "auth/network-request-failed":"通信できませんでした。電波の状態を確認してください。",
  "auth/unauthorized-domain":"このサイトのアドレスが Firebase に登録されていません（README 手順 2）。",
  "auth/operation-not-allowed":"このログイン方法が Firebase で有効になっていません（README 手順 2）。",
};
const authErr = e => AUTH_MSG[e && e.code] || `ログインできませんでした（${e && e.code || "不明なエラー"}）`;

$("#googleBtn").addEventListener("click", async ()=>{
  const provider = new GoogleAuthProvider();
  try{ await signInWithPopup(auth, provider); }
  catch(e){
    if(["auth/popup-blocked","auth/operation-not-supported-in-this-environment","auth/cancelled-popup-request"].includes(e.code)){
      try{ await signInWithRedirect(auth, provider); }catch(e2){ loginMsg(authErr(e2),"err"); }
    } else if(e.code!=="auth/popup-closed-by-user") loginMsg(authErr(e),"err");
  }
});
getRedirectResult(auth).catch(e=>loginMsg(authErr(e),"err"));
$("#emailIn").addEventListener("click", async ()=>{
  try{ await signInWithEmailAndPassword(auth, $("#lEmail").value.trim(), $("#lPass").value); }catch(e){ loginMsg(authErr(e),"err"); }
});
$("#emailUp").addEventListener("click", async ()=>{
  try{ const c = await createUserWithEmailAndPassword(auth, $("#lEmail").value.trim(), $("#lPass").value); await sendEmailVerification(c.user); }
  catch(e){ loginMsg(authErr(e),"err"); }
});
$("#resetBtn").addEventListener("click", async ()=>{
  const em=$("#lEmail").value.trim(); if(!em){ loginMsg("メールアドレスを入力してから押してください。","err"); return; }
  try{ await sendPasswordResetEmail(auth, em); loginMsg("パスワード再設定のメールを送りました。","good"); }catch(e){ loginMsg(authErr(e),"err"); }
});
$("#verifiedBtn").addEventListener("click", async ()=>{
  const u=auth.currentUser; if(!u) return;
  await u.reload(); await u.getIdToken(true);
  if(auth.currentUser.emailVerified) startApp(auth.currentUser);
  else { $("#verifyMsg").textContent="まだ確認が済んでいません。メールのリンクを開いてから押してください。"; $("#verifyMsg").className="hint err"; }
});
$("#resendBtn").addEventListener("click", async ()=>{
  try{ await sendEmailVerification(auth.currentUser); $("#verifyMsg").textContent="確認メールを再送しました。"; $("#verifyMsg").className="hint good"; }
  catch(e){ $("#verifyMsg").textContent=authErr(e); $("#verifyMsg").className="hint err"; }
});
$("#acctBtn").addEventListener("click", ()=>signOut(auth));

/* ---------- データ購読 ---------- */
function stopApp(){ S.unsub.forEach(f=>f()); S.unsub=[]; S.items=[]; S.shop=[]; S.logs=[]; S.loaded=false; closeSheet(); }
function startApp(user){
  stopApp();
  S.user=user; showBanner(""); showScreen("app"); render();
  const onErr = e => {
    if(e && e.code==="permission-denied"){
      stopApp(); showScreen("login");
      loginMsg(`${user.email} はこの備蓄帳の家族に登録されていません。登録してあるアカウントでログインし直してください。`,"err");
      signOut(auth);
    } else showBanner("データの同期が止まりました。ページを開き直してください。");
  };
  S.unsub.push(onSnapshot(collection(db,"items"), s=>{ S.items=s.docs.map(d=>({id:d.id,...d.data()})); S.loaded=true; render(); }, onErr));
  S.unsub.push(onSnapshot(collection(db,"shopping"), s=>{ S.shop=s.docs.map(d=>({id:d.id,...d.data()})); render(); }, onErr));
  S.unsub.push(onSnapshot(query(collection(db,"logs"), orderBy("at","desc"), limit(100)), s=>{ S.logs=s.docs.map(d=>({id:d.id,...d.data()})); render(); }, onErr));
  S.unsub.push(onSnapshot(doc(db,"settings","household"), s=>{ if(s.exists() && !setT){ const d=s.data(); S.settings={people:num(d.people),days:num(d.days,7)||7}; render(); } }, onErr));
}

onAuthStateChanged(auth, user=>{
  if(!user){ stopApp(); S.user=null; showScreen("login"); return; }
  const isPassword = user.providerData.some(p=>p.providerId==="password") && !user.providerData.some(p=>p.providerId==="google.com");
  if(isPassword && !user.emailVerified){
    stopApp(); showScreen("verify");
    $("#verifyText").textContent=`${user.email} に確認メールを送りました。メール内のリンクを開いてから「確認した」を押してください。`;
    return;
  }
  startApp(user);
});

/* ---------- その他 ---------- */
try{ const t=localStorage.getItem("bichiku.tab"); if(t && ["stock","need","shop","log"].includes(t)) S.tab=t; }catch{}
const syncOnline = () => { $("#offline").hidden = navigator.onLine; };
addEventListener("online", syncOnline); addEventListener("offline", syncOnline); syncOnline();
$("#today").textContent = todayStr().replaceAll("-",".");
setInterval(()=>{ if(!$("#sheetRoot").innerHTML) render(); }, 60000);
if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
