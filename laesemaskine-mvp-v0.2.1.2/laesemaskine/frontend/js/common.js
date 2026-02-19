const LM = {
  version: "0.2.1.2.2",
  apiBase: "/laesemaskine/api",
};

function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }

function showToast(a, b=null, c="") {
  // Supported call patterns:
  // 1) showToast(elOrSelector, msg, kind)
  // 2) showToast(msg, kind)
  // 3) showToast(msg)

  let elOrSel = null;
  let msg = "";
  let kind = "";

  if (c !== "" || (typeof a !== "string" && a)) {
    // pattern 1
    elOrSel = a;
    msg = b || "";
    kind = c || "";
  } else if (typeof a === "string" && (b === null || typeof b === "string")) {
    // pattern 2 or 3
    msg = a;
    kind = b || "";
    elOrSel = "#toast";
  } else {
    msg = String(a || "");
    kind = String(b || "");
    elOrSel = "#toast";
  }

  let el = null;
  if (typeof elOrSel === "string") el = qs(elOrSel);
  else el = elOrSel;

  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.style.display = "none";
    document.body.appendChild(el);
  }

  el.textContent = msg;
  el.className = "toast" + (kind ? " " + kind : "");
  el.style.display = "block";
  clearTimeout(el._t);
  el._t = setTimeout(() => { try { el.style.display = "none"; } catch(e){} }, 2200);
}

async function api(path, opts={}) {
  const res = await fetch(LM.apiBase + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = (data && data.error) ? data.error : ("http_" + res.status);
    const msg = (data && data.message) ? data.message : err;
    const ex = new Error(msg);
    ex.code = err;
    ex.httpStatus = res.status;
    throw ex;
  }
  return data;
}

async function requireAuth(roles=null) {
  const me = await api("/me");
  if (roles && !roles.includes(me.user.role)) {
    window.location.href = "/laesemaskine/elev.html";
    return null;
  }
  return me;
}

function setFooter() {
  qsa(".js-version").forEach(el => el.textContent = LM.version);
}
document.addEventListener("DOMContentLoaded", setFooter);


// ---------- IndexedDB helpers (session audio temp storage) ----------
const LM_IDB_NAME = "laesemaskine_audio";
const LM_IDB_STORE = "blobs";

function lmIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LM_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LM_IDB_STORE)) {
        db.createObjectStore(LM_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function lmStoreBlob(key, blob) {
  const db = await lmIdbOpen();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(LM_IDB_STORE, "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(LM_IDB_STORE).put(blob, key);
  });
}

async function lmGetBlob(key) {
  const db = await lmIdbOpen();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(LM_IDB_STORE, "readonly");
    const req = tx.objectStore(LM_IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function lmDeleteBlob(key) {
  const db = await lmIdbOpen();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(LM_IDB_STORE, "readwrite");
    const req = tx.objectStore(LM_IDB_STORE).delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}


// ---------- Reusable table: sorting + filtering (Læsemaskine koncept v1) ----------
function lmCreateTable(opts){
  const { container, columns, items, rowHtml, onRowClick } = opts;
  let data = items || [];
  let sortState = [];   // [{col,dir}]
  let filters = {};     // col -> {raw}
  let activeMenuEl = null;
  let activeModalEl = null;

  const funnelSvg = '<svg class="funnelIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path></svg>';
  const clearSvg = funnelSvg + '<span class="redX"><svg class="xIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>';

  function escHtml(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  function closeMenu(){ if (activeMenuEl && activeMenuEl.parentNode) activeMenuEl.parentNode.removeChild(activeMenuEl); activeMenuEl=null; }
  function closeModal(){ if (activeModalEl && activeModalEl.parentNode) activeModalEl.parentNode.removeChild(activeModalEl); activeModalEl=null; }

  function headerLabel(label, col){
    const idx = sortState.findIndex(s => s.col === col);
    if (idx === -1) return label + ' <span class="sortHint">↕</span>';
    const s = sortState[idx];
    const arrow = s.dir === "asc" ? "↓" : "↑";
    return `${label} <span class="sortArrow">${arrow}</span><span class="sortRank">${idx+1}</span>`;
  }

  function colDef(col){ return columns.find(c=>c.key===col); }
  function getCell(it, col){
    const c = colDef(col);
    if (c && c.get) return c.get(it);
    return it[col];
  }

  function applySort(arr){
    if (!sortState.length) return arr.slice();
    const out = arr.slice();
    out.sort((a,b)=>{
      for (const s of sortState){
        const c = colDef(s.col) || {};
        const va = getCell(a, s.col);
        const vb = getCell(b, s.col);
        let cmp = 0;
        if (c.type === "number"){
          cmp = (Number(va)||0) - (Number(vb)||0);
        } else if (c.type === "date"){ // compare ISO string
          cmp = String(va||"").localeCompare(String(vb||""));
        } else {
          cmp = String(va||"").localeCompare(String(vb||""), "da");
        }
        if (cmp !== 0) return s.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
    return out;
  }

  // Text custom syntax: AND space, OR |, NOT !, * wildcard (full match)
  function parseTextExpr(raw){
    raw = (raw||"").trim();
    if (!raw) return null;
    const orParts = raw.split("|").map(x => x.trim()).filter(Boolean);
    const groups = orParts.map(part => {
      const andTokens = part.replace(/&/g, " ").split(/\s+/).map(t=>t.trim()).filter(Boolean);
      return andTokens.map(tok => {
        let neg = false;
        if (tok.startsWith("!")) { neg = true; tok = tok.slice(1); }
        tok = tok.trim();
        if (!tok) return null;

        const lit = tok.replace(/\\\*/g, "__LITSTAR__");
        let rx = lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        rx = rx.replace(/\*/g, ".*");
        rx = rx.replace(/__LITSTAR__/g, "\\*");
        const re = new RegExp("^" + rx + "$", "i");
        return { neg, re };
      }).filter(Boolean);
    });
    return { groups };
  }

  function matchText(value, expr){
    const v = String(value||"");
    for (const g of expr.groups){
      let ok = true;
      for (const t of g){
        const hit = t.re.test(v);
        if (t.neg ? hit : !hit) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  function parseRangeExpr(raw){
    raw = (raw||"").trim();
    if (!raw) return null;
    const dots = raw.split("..");
    if (dots.length === 2) return { op:"between", a:dots[0].trim(), b:dots[1].trim() };
    const m = raw.match(/^(>=|<=|!=|=|>|<)\s*(.+)$/);
    if (m) return { op:m[1], a:m[2].trim() };
    return { op:"auto", a:raw };
  }

  function matchNumber(value, expr){
    const n = Number(value);
    if (expr.op === "between"){
      const a = Number(expr.a), b = Number(expr.b);
      if (Number.isNaN(a) || Number.isNaN(b)) return true;
      return n >= Math.min(a,b) && n <= Math.max(a,b);
    }
    if (expr.op === "auto"){
      const a = Number(expr.a);
      if (Number.isNaN(a)) return true;
      return n === a;
    }
    const a = Number(expr.a);
    if (Number.isNaN(a)) return true;
    if (expr.op === ">") return n > a;
    if (expr.op === ">=") return n >= a;
    if (expr.op === "<") return n < a;
    if (expr.op === "<=") return n <= a;
    if (expr.op === "=") return n === a;
    if (expr.op === "!=") return n !== a;
    return true;
  }

  // Special: date filter from dropdown is exact date (YYYY-MM-DD) -> match whole day in timestamp (startsWith)
  function matchDate(value, raw){
    const v = String(value||"");
    const parts = String(raw||"").split("|").map(x=>x.trim()).filter(Boolean);
    // if it's a list of plain dates, match startsWith for any date
    const allDates = parts.length && parts.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p));
    if (allDates){
      return parts.some(d => v.startsWith(d));
    }
    // range/operators supported
    const expr = parseRangeExpr(raw);
    if (!expr) return true;
    if (expr.op === "between"){
      const lo = (expr.a < expr.b) ? expr.a : expr.b;
      const hi = (expr.a < expr.b) ? expr.b : expr.a;
      return v >= lo && v <= hi;
    }
    if (expr.op === "auto"){
      const te = parseTextExpr(expr.a);
      if (!te) return true;
      return matchText(v, te);
    }
    const a = expr.a;
    if (!a) return true;
    if (expr.op === ">") return v > a;
    if (expr.op === ">=") return v >= a;
    if (expr.op === "<") return v < a;
    if (expr.op === "<=") return v <= a;
    if (expr.op === "=") return v === a;
    if (expr.op === "!=") return v !== a;
    return true;
  }

  function applyFilters(arr){
    const keys = Object.keys(filters);
    if (!keys.length) return arr;
    return arr.filter(it => {
      for (const col of keys){
        const f = filters[col];
        if (!f || !f.raw) continue;
        const c = colDef(col) || {};
        const val = getCell(it, col);

        if (c.type === "number"){
          // Exact from dropdown is plain number or OR-list; support range via custom
          const raw = String(f.raw||"");
          if (raw.includes("..") || /^[<>!=]=?/.test(raw.trim())){
            if (!matchNumber(val, parseRangeExpr(raw))) return false;
          } else if (raw.includes("|")){
            const set = new Set(raw.split("|").map(x=>x.trim()).filter(Boolean));
            if (!set.has(String(val))) return false;
          } else {
            if (String(val) !== raw.trim()) return false;
          }
        } else if (c.type === "date"){
          if (!matchDate(val, f.raw)) return false;
        } else {
          // TEXT: exact match (unless user uses custom with wildcard/NOT/OR/AND)
          const raw = String(f.raw||"").trim();
          // If raw includes syntax, use parser; else exact (case-insensitive)
          const hasSyntax = raw.includes("*") || raw.includes("|") || raw.includes("!") || /\s/.test(raw);
          if (hasSyntax){
            const expr = parseTextExpr(raw);
            if (expr && !matchText(val, expr)) return false;
          } else {
            if (String(val||"").toLowerCase() !== raw.toLowerCase()) return false;
          }
        }
      }
      return true;
    });
  }

  function uniqueVariants(col){
    const c = colDef(col) || {};
    const vals = new Map();
    for (const it of data){
      let v = getCell(it, col);
      if (c.type === "date"){
        // dropdown shows date-only
        v = String(v||"").slice(0,10);
      }
      v = (v == null) ? "" : String(v);
      vals.set(v, (vals.get(v)||0)+1);
    }
    return Array.from(vals.entries())
      .sort((a,b)=> String(a[0]).localeCompare(String(b[0]), "da"))
      .map(([v,cnt])=>({v, cnt}));
  }

  function openCustomModal(col){
    closeModal();
    const cur = (filters[col] && filters[col].raw) ? filters[col].raw : "";

    const wrap = document.createElement("div");
    wrap.className = "modalOverlay";
    const card = document.createElement("div");
    card.className = "modalCard";
    wrap.appendChild(card);

    card.innerHTML = `
      <div class="row" style="justify-content:space-between; align-items:center">
        <b>Custom filter: ${escHtml(colDef(col)?.label || col)}</b>
        <button class="ghost small" id="cmClose">✕</button>
      </div>
      <div class="muted small" style="margin-top:6px">Tekst: * wildcard, AND = mellemrum, OR = |, NOT = !</div>
      <div class="muted small" style="margin-top:4px">Tal: >=10 eller 10..20 • Dato: 2026-02-01..2026-02-10</div>
      <textarea id="cmInput" rows="3" style="width:100%; margin-top:10px" placeholder="Skriv custom filter…"></textarea>
      <div class="row" style="justify-content:flex-end; gap:8px; margin-top:10px">
        <button class="ghost small" id="cmClear">Ryd</button>
        <button class="primary small" id="cmApply">Anvend</button>
      </div>
    `;
    document.body.appendChild(wrap);
    activeModalEl = wrap;

    const input = wrap.querySelector("#cmInput");
    input.value = cur;

    wrap.querySelector("#cmClose").onclick = () => closeModal();
    wrap.querySelector("#cmClear").onclick = () => { input.value=""; input.focus(); };
    wrap.querySelector("#cmApply").onclick = () => {
      const raw = (input.value||"").trim();
      if (!raw) delete filters[col];
      else filters[col] = { raw };
      closeModal();
      render();
    };
    input.onkeydown = (e) => {
      if (e.key === "Escape") closeModal();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) wrap.querySelector("#cmApply").click();
    };
    wrap.addEventListener("mousedown", (ev)=>{ if (ev.target===wrap) closeModal(); });
    setTimeout(()=>input.focus(),0);
  }

  function openValueMenu(col, anchorEl){
    closeMenu();
    const rect = anchorEl.getBoundingClientRect();
    const variants = uniqueVariants(col);

    // preselect OR-set
    let pre = [];
    if (filters[col] && filters[col].raw){
      pre = String(filters[col].raw).split("|").map(x=>x.trim()).filter(Boolean);
    }
    const preSet = new Set(pre);

    const menu = document.createElement("div");
    menu.className = "filterMenu";
    menu.style.left = Math.max(10, rect.left + window.scrollX - 10) + "px";
    menu.style.top = (rect.bottom + window.scrollY + 6) + "px";

    const rows = variants.map((x,i)=>`
      <tr class="fmRow" data-val="${escHtml(x.v)}">
        <td class="fmCell fmCheckCell"><input type="checkbox" class="fmCheck" id="fmChk_${i}" ${preSet.has(x.v) ? "checked":""}/></td>
        <td class="fmCell fmValCell"><label for="fmChk_${i}">${escHtml(x.v||"—")}</label></td>
        <td class="fmCell muted small" style="text-align:right">${x.cnt}</td>
      </tr>
    `).join("");

    menu.innerHTML = `
      <div class="filterMenuHead">
        <b>${escHtml(colDef(col)?.label || col)}</b>
        <button class="ghost small" id="fmClose" title="Luk">✕</button>
      </div>
      <div class="filterMenuHelp muted small">Vælg værdier (OR). Dato-filter matcher hele dagen.</div>

      <div class="filterMenuTableWrap">
        <table class="fmTable">
          <thead>
            <tr><th class="fmTh" style="width:34px"></th><th class="fmTh">Værdi</th><th class="fmTh" style="text-align:right">Antal</th></tr>
          </thead>
          <tbody>
            <tr class="fmRow fmCustom" id="fmCustomRow">
              <td class="fmCell"></td>
              <td class="fmCell"><b>Custom…</b></td>
              <td class="fmCell muted small" style="text-align:right">AND / OR / !</td>
            </tr>
            <tr class="fmSep"><td colspan="3"></td></tr>
            ${rows}
          </tbody>
        </table>
      </div>

      <div class="filterMenuFoot">
        <button class="ghost small" id="fmClearCol">Ryd kolonne</button>
        <button class="primary small" id="fmApply">Anvend</button>
      </div>
    `;
    document.body.appendChild(menu);
    activeMenuEl = menu;

    menu.querySelector("#fmClose").onclick = () => closeMenu();
    menu.querySelector("#fmClearCol").onclick = () => { delete filters[col]; closeMenu(); render(); };
    menu.querySelector("#fmApply").onclick = () => {
      const checked = Array.from(menu.querySelectorAll("input.fmCheck"))
        .filter(c=>c.checked)
        .map(c=>c.closest("tr")?.getAttribute("data-val") || "")
        .map(x=>x.trim()).filter(Boolean);

      if (!checked.length) delete filters[col];
      else filters[col] = { raw: checked.join(" | ") };

      closeMenu();
      render();
    };

    Array.from(menu.querySelectorAll("tr.fmRow")).forEach(tr=>{
      tr.addEventListener("click", (ev)=>{
        if (tr.id === "fmCustomRow"){
          closeMenu();
          openCustomModal(col);
          return;
        }
        const cb = tr.querySelector("input.fmCheck");
        if (!cb) return;
        if (ev.target && ev.target.classList && ev.target.classList.contains("fmCheck")) return;
        cb.checked = !cb.checked;
      });
    });

    setTimeout(()=>{
      const onDoc = (ev)=>{
        if (!activeMenuEl){ document.removeEventListener("mousedown", onDoc, true); return; }
        if (activeMenuEl.contains(ev.target)) return;
        closeMenu();
        document.removeEventListener("mousedown", onDoc, true);
      };
      document.addEventListener("mousedown", onDoc, true);
    },0);
  }

  function wire(){
    const table = container.querySelector("table.lmTable");
    if (!table) return;

    Array.from(table.querySelectorAll("th[data-col]")).forEach(th=>{
      th.addEventListener("click",(ev)=>{
        const col = th.getAttribute("data-col");
        if (!col) return;
        const cdef = colDef(col);
        if (cdef && cdef.sort === false) return;
        const existingIdx = sortState.findIndex(s=>s.col===col);
        const ctrl = ev.ctrlKey || ev.metaKey;

        if (!ctrl){
          let dir = "asc";
          if (existingIdx !== -1) dir = sortState[existingIdx].dir === "asc" ? "desc" : "asc";
          sortState = [{ col, dir }];
        } else {
          if (existingIdx === -1) sortState.push({ col, dir:"asc" });
          else {
            const cur = sortState[existingIdx];
            cur.dir = cur.dir === "asc" ? "desc" : "asc";
            sortState[existingIdx] = cur;
          }
        }
        render();
      });
    });

    Array.from(table.querySelectorAll(".filterBtn")).forEach(btn=>{
      btn.addEventListener("click",(ev)=>{
        ev.preventDefault(); ev.stopPropagation();
        const col = btn.getAttribute("data-fcol");
        if (!col) return;
        openValueMenu(col, btn);
      });
    });

    const topClear = container.querySelector(".btnClearAllFiltersTop");
    if (topClear) topClear.onclick = ()=>{ filters = {}; render(); };

    if (onRowClick){
      Array.from(table.querySelectorAll("tbody tr[data-rowidx]")).forEach(tr=>{
        tr.addEventListener("click", ()=>{
          const idx = parseInt(tr.getAttribute("data-rowidx"),10);
          if (!Number.isFinite(idx)) return;
          onRowClick(data[idx], tr);
        });
      });
    }
  }

  function render(){
    const filtered = applyFilters(data);
    const sorted = applySort(filtered);

    const thead = columns.map(c=>{
      const sortable = (c.sort !== false);
      const filterable = (c.filter !== false);
      const thAttr = sortable ? `data-col="${c.key}" style="cursor:pointer"` : `data-col=""`;
      const label = sortable ? headerLabel(c.label || c.key, c.key) : (c.label || c.key);
      const fbtn = filterable ? `<button class="filterBtn" data-fcol="${c.key}" title="Filter">${funnelSvg}</button>` : ``;
      return `
      <th ${thAttr}>
        <div class="thwrap">
          <span class="thlabel">${label}</span>
          ${fbtn}
        </div>
      </th>`;
    }).join("");

    const rows = sorted.map((it,i)=> rowHtml(it, i)).join("");

    container.innerHTML = `
      <div class="row" style="justify-content:flex-end; align-items:center; margin-bottom:8px">
        <button class="clearFiltersBtn btnClearAllFiltersTop" title="Ryd alle filtre">${clearSvg}</button>
      </div>
      <table class="table lmTable">
        <thead><tr>${thead}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    wire();
  }

  render();
  return {
    setItems: (items)=>{ data = items||[]; render(); },
    getState: ()=>({ sortState, filters })
  };
}
