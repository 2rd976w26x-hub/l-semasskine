document.addEventListener("DOMContentLoaded", async () => {
  const toastGroup = qs("#toastGroup");
  const toastUser = qs("#toastUser");

  try { await requireAuth(["admin"]); } catch (e) { window.location.href="/laesemaskine/index.html"; return; }

  qs("#btnLogout").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" });
    window.location.href="/laesemaskine/index.html";
  });
  qs("#btnToElev").addEventListener("click", () => window.location.href="/laesemaskine/elev.html");

  async function refreshGroups() {
    const g = await api("/admin/groups");
    const list = qs("#groups");
    const sel = qs("#stuGroup");
    sel.innerHTML = "";
    list.innerHTML = g.groups.map(gr => {
      return `<div class="row" style="justify-content:space-between; padding:8px 0">
        <div><b>${gr.name}</b> <span class="muted">(#${gr.id})</span></div>
      </div>`;
    }).join("") || "Ingen grupper endnu.";

    g.groups.forEach(gr => {
      const opt = document.createElement("option");
      opt.value = gr.id;
      opt.textContent = `${gr.name} (#${gr.id})`;
      sel.appendChild(opt);
    });
  }

  async function refreshOverview() {
    const o = await api("/admin/overview");
    const el = qs("#overview");
    if (!o.students.length) {
      el.textContent = "Ingen elever endnu.";
      return;
    }
    const rows = o.students.map(s => {
      const name = s.display_name ? `${s.display_name} (${s.username})` : s.username;
      const lvl = s.last_level ?? "–";
      const mst = s.last_mastery ?? "–";
      const grp = s.group_name ?? "–";
      return `<tr data-uid="${s.id}" style="cursor:pointer"><td>${name}</td><td>${grp}</td><td>${lvl}</td><td>${mst}</td></tr>`;
    }).join("");
    
    
    el.innerHTML = `<table class="table">
      <thead><tr><th>Elev</th><th>Gruppe</th><th>Niveau</th><th>Mestring</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    // row click -> load details
    Array.from(el.querySelectorAll("tbody tr[data-uid]")).forEach(tr => {
      tr.addEventListener("click", async () => {
        const uid = tr.getAttribute("data-uid");
        const detail = qs("#studentDetail");
        if (!detail) return;
        detail.textContent = "Indlæser elev-detaljer…";
        try {
          
          const diff = await api(`/admin/student/${uid}/difficulty`);

          function li(group, x){
            const pct = (x.wrong_rate*100).toFixed(0);
            return `<li><a href="#" class="js-drill" data-group="${group}" data-key="${x.key}">${x.key}: ${pct}% fejl (${x.wrong}/${x.total})</a></li>`;
          }

          const listCat = (diff.by_interessekategori || []).slice(0,8).map(x => li("interessekategori", x)).join("") || "<li>—</li>";
          const listPat = (diff.by_stavemoenster || []).slice(0,8).map(x => li("stavemoenster", x)).join("") || "<li>—</li>";
          const listOb  = (diff.by_ordblind_type || []).slice(0,8).map(x => li("ordblind_type", x)).join("") || "<li>—</li>";

          detail.innerHTML = `
            <div class="row" style="gap:18px; align-items:flex-start">
              <div style="flex:1">
                <b>Svære interessekategorier</b>
                <ul style="margin:8px 0 0 18px; padding:0">${listCat}</ul>
              </div>
              <div style="flex:1">
                <b>Svære stavemønstre</b>
                <ul style="margin:8px 0 0 18px; padding:0">${listPat}</ul>
              </div>
              <div style="flex:1">
                <b>Svære ordblind-typer</b>
                <ul style="margin:8px 0 0 18px; padding:0">${listOb}</ul>
              </div>
            </div>
            <div style="margin-top:12px" class="muted small">
              Tip: Procenter er baseret på alle gemte ord-svar for eleven.
            </div>
          `;

          // drilldown click handlers
          const panel = qs("#drilldownPanel");
          const titleEl = qs("#drilldownTitle");
          const bodyEl = qs("#drilldownBody");
          const closeBtn = qs("#btnCloseDrilldown");
          if (closeBtn) closeBtn.onclick = () => { if(panel) panel.style.display="none"; };

          Array.from(detail.querySelectorAll(".js-drill")).forEach(a => {
            a.addEventListener("click", async (ev) => {
              ev.preventDefault();
              const group = a.getAttribute("data-group");
              const key = a.getAttribute("data-key");
              if (!group || !key) return;

              if (panel) panel.style.display = "";
              if (titleEl) titleEl.textContent = `${key} – detaljer`;
              if (bodyEl) bodyEl.textContent = "Indlæser…";

              try {
                const data = await api(`/admin/student/${uid}/drilldown?group=${encodeURIComponent(group)}&key=${encodeURIComponent(key)}`);
                const items = data.items || [];
                if (!items.length) {
                  if (bodyEl) bodyEl.textContent = "Ingen ord fundet for denne kategori.";
                  return;
                }

                
                // Sortable table (multi-column with Ctrl)
                let sortState = []; // [{col, dir}] dir: "asc"|"desc"

                function getValue(it, col){
                  if (col === "expected") return (it.expected || "").toLowerCase();
                  if (col === "recognized") return ((it.recognized || "").toLowerCase());
                  if (col === "correct") return it.correct ? 1 : 0;
                  if (col === "niveau") return (it.niveau == null ? -1 : Number(it.niveau));
                  if (col === "timestamp") return (it.timestamp || "");
                  return "";
                }

                function compare(a, b, col, dir){
                  const va = getValue(a, col);
                  const vb = getValue(b, col);
                  let c = 0;
                  if (typeof va === "number" && typeof vb === "number") c = va - vb;
                  else c = String(va).localeCompare(String(vb), "da");
                  return dir === "asc" ? c : -c;
                }

                function applySort(itemsArr){
                  if (!sortState.length) return itemsArr;
                  const out = itemsArr.slice();
                  out.sort((a,b)=>{
                    for (let i=0;i<sortState.length;i++){
                      const s = sortState[i];
                      const c = compare(a,b,s.col,s.dir);
                      if (c !== 0) return c;
                    }
                    return 0;
                  });
                  return out;
                }

                function headerLabel(text, col){
                  const idx = sortState.findIndex(s => s.col === col);
                  if (idx === -1) return `${text} <span class="muted">↕</span>`;
                  const dir = sortState[idx].dir;
                  let arrow;
                  if (col === "timestamp") {
                    // For time: ▼ = newest→oldest (desc), ▲ = oldest→newest (asc)
                    arrow = dir === "asc" ? "▲" : "▼";
                  } else {
                    // For text: ▼ = A→Z (asc), ▲ = Z→A (desc)
                    arrow = dir === "asc" ? "▼" : "▲";
                  }
                  const order = idx + 1;
                  return `${text} <span class="muted">${arrow}</span> <span class="badge small">${order}</span>`;
                }

                function renderTable(itemsArr){
                  const filtered = applyFilters(itemsArr);
                  const sorted = applySort(filtered);

                  const rows = sorted.map(it => {
                    const ok = it.correct ? "✔" : "✖";
                    const heard = (it.recognized || "").trim() || "—";
                    const lvl = (it.niveau != null) ? it.niveau : "—";
                    return `<tr>
                      <td><b>${it.expected}</b></td>
                      <td class="muted">${heard}</td>
                      <td>${ok}</td>
                      <td class="muted">${lvl}</td>
                      <td class="muted">${it.timestamp}</td>
                    </tr>`;
                  }).join("");

                  bodyEl.innerHTML = `
                    <div class="row" style="justify-content:flex-end; align-items:center; margin-bottom:8px">
                      <button class="clearFiltersBtn" id="btnClearAllFiltersTop" title="Ryd alle filtre"><svg class="funnelIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path></svg><span class="redX"><svg class="xIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span></button>
                    </div>

                    <table class="table small" id="drillTable"><colgroup><col/><col/><col class="col-ok"/><col class="col-niv"/><col class="col-ts"/></colgroup>
                      <thead>
                        <tr>
                          <th data-col="expected" style="cursor:pointer">
                            <div class="thwrap">
                              <span class="thlabel">${headerLabel("Ord","expected")}</span>
                              <button class="filterBtn" data-fcol="expected" title="Filter"><svg class="funnelIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path></svg></button>
                            </div>
                          </th>
                          <th data-col="recognized" style="cursor:pointer">
                            <div class="thwrap">
                              <span class="thlabel">${headerLabel("Hørt","recognized")}</span>
                              <button class="filterBtn" data-fcol="recognized" title="Filter"><svg class="funnelIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path></svg></button>
                            </div>
                          </th>
                          <th data-col="correct" style="cursor:pointer; width:60px">
                            <div class="thwrap">
                              <span class="thlabel">${headerLabel("","correct")}</span>
                              <button class="filterBtn" data-fcol="correct" title="Filter"><svg class="funnelIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path></svg></button>
                            </div>
                          </th>
                          <th data-col="niveau" style="cursor:pointer; width:70px">
                            <div class="thwrap">
                              <span class="thlabel">${headerLabel("Niv.","niveau")}</span>
                              <button class="filterBtn" data-fcol="niveau" title="Filter"><svg class="funnelIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path></svg></button>
                            </div>
                          </th>
                          <th data-col="timestamp" style="cursor:pointer">
                            <div class="thwrap">
                              <span class="thlabel">${headerLabel("Tidspunkt","timestamp")}</span>
                              <button class="filterBtn" data-fcol="timestamp" title="Filter"><svg class="funnelIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path></svg></button>
                            </div>
                          </th>
                        </tr>
                      </thead>
                      <tbody>${rows}</tbody>
                    </table>
                  `;

                  wireTable(itemsArr);
                }

                // ---------- Filtering (custom syntax) ----------
                let filters = {}; // col -> {raw}
                let DRILL_ITEMS = [];

                function normalizeText(s){ return (s||"").toLowerCase(); }

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

                function parseRangeExpr(raw){
                  raw = (raw||"").trim();
                  if (!raw) return null;
                  const dots = raw.split("..");
                  if (dots.length === 2) return { op: "between", a: dots[0].trim(), b: dots[1].trim() };
                  const m = raw.match(/^(>=|<=|!=|=|>|<)\s*(.+)$/);
                  if (m) return { op: m[1], a: m[2].trim() };
                  return { op: "auto", a: raw };
                }

                function matchText(value, expr){
                  const v = normalizeText(value);
                  for (const g of expr.groups) {
                    let ok = true;
                    for (const t of g) {
                      const hit = t.re.test(v);
                      if (t.neg ? hit : !hit) { ok = false; break; }
                    }
                    if (ok) return true;
                  }
                  return false;
                }

                function matchNumber(value, expr){
                  const n = Number(value);
                  if (expr.op === "between") {
                    const a = Number(expr.a), b = Number(expr.b);
                    if (Number.isNaN(a) || Number.isNaN(b)) return true;
                    return n >= Math.min(a,b) && n <= Math.max(a,b);
                  }
                  if (expr.op === "auto") {
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

                function matchDate(value, expr){
                  const v = (value || "");
                  const isPlainDate = (s) => {
                    if (typeof s !== "string") return false;
                    if (s.length !== 10) return false;
                    if (s[4] !== "-" || s[7] !== "-") return false;
                    const digits = s.replace(/-/g, "");
                    return /^\d+$/.test(digits);
                  };

                  if (expr.op === "between") {
                    const a = expr.a, b = expr.b;
                    if (!a || !b) return true;
                    const lo = (a < b) ? a : b;
                    const hi = (a < b) ? b : a;
                    return v >= lo && v <= hi;
                  }
                  if (expr.op === "auto") {
                    const raw = String(expr.a || "").trim();
                    if (raw){
                      const parts = raw.split("|").map(x=>x.trim()).filter(Boolean);
                      const allDates = parts.length && parts.every(isPlainDate);
                      if (allDates){
                        return parts.some(d => v.startsWith(d));
                      }
                      if (isPlainDate(raw)){
                        return v.startsWith(raw);
                      }
                    }
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


                function applyFilters(itemsArr){
                  if (!Object.keys(filters).length) return itemsArr;
                  return itemsArr.filter(it => {
                    for (const col in filters) {
                      const f = filters[col];
                      if (!f || !f.raw) continue;

                      if (col === "expected" || col === "recognized") {
                        const expr = parseTextExpr(f.raw);
                        if (!expr) continue;
                        const val = (col === "expected") ? it.expected : (it.recognized || "");
                        if (!matchText(val, expr)) return false;
                      } else if (col === "correct") {
                        const rawStr = String(f.raw || "");
                        const parts = rawStr.split("|").map(x=>x.trim()).filter(Boolean);
                        const r = rawStr.toLowerCase().trim();
                        const hasOk = parts.includes("✔");
                        const hasBad = parts.includes("✖");
                        const wantCorrect = hasOk || (r === "1" || r === "true" || r === "ok" || r === "rigtig" || r === "✔");
                        const wantWrong = hasBad || (r === "0" || r === "false" || r === "fejl" || r === "forkert" || r === "✖");
                        if (wantCorrect && !it.correct) return false;
                        if (wantWrong && it.correct) return false;
                      } else if (col === "niveau") {
                        const raw = String(f.raw || "").trim();
                        if (!raw) continue;
                        // exact OR from dropdown (e.g. "3 | 4 | 5")
                        if (raw.includes("|") && !raw.includes("..") && !/^(>=|<=|!=|=|>|<)\s*/.test(raw)) {
                          const set = new Set(raw.split("|").map(x=>x.trim()).filter(Boolean));
                          const v = (it.niveau != null) ? String(it.niveau) : "—";
                          if (!set.has(v)) return false;
                        } else {
                          const expr = parseRangeExpr(raw);
                          if (!expr) continue;
                          if (!matchNumber(it.niveau == null ? -1 : it.niveau, expr)) return false;
                        }
                      
} else if (col === "timestamp") {
                        const expr = parseRangeExpr(f.raw);
                        if (!expr) continue;
                        if (!matchDate(it.timestamp, expr)) return false;
                      }
                    }
                    return true;
                  });
                }

                // ---------- Dropdown menu ----------
                let activeMenuEl = null;
                let activeModalEl = null;

                function escHtml(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
                function colLabel(col){ const m = { expected:"Ord", recognized:"Hørt", correct:"✔/✖", niveau:"Niv.", timestamp:"Tidspunkt" }; return m[col] || col; }
                function getColVariant(it, col){
                  if (col === "expected") return it.expected || "";
                  if (col === "recognized") return (it.recognized || "").trim() || "—";
                  if (col === "correct") return it.correct ? "✔" : "✖";
                  if (col === "niveau") return (it.niveau != null ? String(it.niveau) : "—");
                  if (col === "timestamp") return (it.timestamp || "").slice(0, 10);
                  return "";
                }
                function uniqueVariants(itemsArr, col){
                  const vals = new Map();
                  for (const it of itemsArr) {
                    const v = getColVariant(it, col);
                    vals.set(v, (vals.get(v)||0) + 1);
                  }
                  return Array.from(vals.entries())
                    .sort((a,b)=> String(a[0]).localeCompare(String(b[0]), "da"))
                    .map(([v,c])=>({v,c}));
                }
                function closeMenu(){ if (activeMenuEl && activeMenuEl.parentNode) activeMenuEl.parentNode.removeChild(activeMenuEl); activeMenuEl=null; }
                function closeModal(){ if (activeModalEl && activeModalEl.parentNode) activeModalEl.parentNode.removeChild(activeModalEl); activeModalEl=null; }

                function openValueMenu(col, anchorEl, itemsArr){
                  closeMenu();
                  const rect = anchorEl.getBoundingClientRect();
                  const variants = uniqueVariants(itemsArr, col);

                  // preselect from existing filter (supports OR via |)
                  let pre = [];
                  if (filters[col] && filters[col].raw){
                    pre = String(filters[col].raw).split("|").map(x=>x.trim()).filter(Boolean);
                  }
                  const preSet = new Set(pre);

                  const menu = document.createElement("div");
                  menu.className = "filterMenu";
                  menu.style.left = Math.max(10, rect.left + window.scrollX - 10) + "px";
                  menu.style.top = (rect.bottom + window.scrollY + 6) + "px";

                  const rows = variants.map((x, i) => `
                    <tr class="fmRow" data-val="${escHtml(x.v)}">
                      <td class="fmCell fmCheckCell">
                        <input type="checkbox" class="fmCheck" id="fmChk_${i}" ${preSet.has(x.v) ? "checked" : ""}/>
                      </td>
                      <td class="fmCell fmValCell"><label for="fmChk_${i}">${escHtml(x.v)}</label></td>
                      <td class="fmCell muted small" style="text-align:right">${x.c}</td>
                    </tr>
                  `).join("");

                  menu.innerHTML = `
                    <div class="filterMenuHead">
                      <b>${escHtml(colLabel(col))}</b>
                      <button class="ghost small" id="fmClose" title="Luk">✕</button>
                    </div>
                    <div class="filterMenuHelp muted small">Vælg én eller flere værdier (OR). Scroll hvis mange.</div>

                    <div class="filterMenuTableWrap">
                      <table class="fmTable">
                        <thead>
                          <tr>
                            <th class="fmTh" style="width:34px"></th>
                            <th class="fmTh">Værdi</th>
                            <th class="fmTh" style="text-align:right">Antal</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr class="fmRow fmCustom" id="fmCustomRow">
                            <td class="fmCell"></td>
                            <td class="fmCell"><b>Custom…</b></td>
                            <td class="fmCell muted small" style="text-align:right">AND / OR / !</td>
                          </tr>
                          <tr class="fmSep"><td colspan="3"></td></tr>
                          ${rows}
                          <tr style="display:none">
                            <td class="fmCell"></td>
                            <td class="fmCell"><b>Custom…</b></td>
                            <td class="fmCell muted small" style="text-align:right">AND / OR / !</td>
                          </tr>
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

                  menu.querySelector("#fmClearCol").onclick = () => {
                    delete filters[col];
                    closeMenu();
                    renderTable(DRILL_ITEMS);
                  };

                  menu.querySelector("#fmApply").onclick = () => {
                    const checked = Array.from(menu.querySelectorAll("input.fmCheck"))
                      .filter(c=>c.checked)
                      .map(c=>c.closest("tr")?.getAttribute("data-val") || "")
                      .map(x=>x.trim())
                      .filter(Boolean);

                    if (!checked.length){
                      delete filters[col];
                    } else if (col === "correct"){
                      // correct supports ✔ / ✖
                      const hasOk = checked.includes("✔");
                      const hasBad = checked.includes("✖");
                      if (hasOk && hasBad) delete filters[col];
                      else filters[col] = { raw: hasOk ? "✔" : "✖" };
                    } else {
                      filters[col] = { raw: checked.join(" | ") };
                    }
                    closeMenu();
                    renderTable(DRILL_ITEMS);
                  };

                  // row click toggles checkbox, except custom
                  Array.from(menu.querySelectorAll("tr.fmRow")).forEach(tr => {
                    tr.addEventListener("click", (ev) => {
                      if (tr.id === "fmCustomRow") {
                        closeMenu();
                        openCustomModal(col);
                        return;
                      }
                      const cb = tr.querySelector("input.fmCheck");
                      if (!cb) return;
                      // if click on checkbox itself, default toggle already happened
                      if (ev.target && ev.target.classList && ev.target.classList.contains("fmCheck")) return;
                      cb.checked = !cb.checked;
                    });
                  });

                  setTimeout(()=>{
                    const onDoc = (ev) => {
                      if (!activeMenuEl) { document.removeEventListener("mousedown", onDoc, true); return; }
                      if (activeMenuEl.contains(ev.target)) return;
                      closeMenu();
                      document.removeEventListener("mousedown", onDoc, true);
                    };
                    document.addEventListener("mousedown", onDoc, true);
                  },0);
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
                      <b>Custom filter: ${escHtml(colLabel(col))}</b>
                      <button class="ghost small" id="cmClose">✕</button>
                    </div>
                    <div class="muted small" style="margin-top:6px">Syntaks: * wildcard, mellemrum AND, | OR, ! NOT</div>
                    <div class="muted small" style="margin-top:4px">Eksempler: <span class="mono">kat* hund | ko</span>, <span class="mono">>=10</span>, <span class="mono">2026-02-01..2026-02-10</span></div>
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
                    renderTable(DRILL_ITEMS);
                  };

                  input.onkeydown = (e) => {
                    if (e.key === "Escape") closeModal();
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) wrap.querySelector("#cmApply").click();
                  };
                  wrap.addEventListener("mousedown", (ev)=>{ if (ev.target===wrap) closeModal(); });
                  setTimeout(()=>input.focus(),0);
                }

                function openFilter(col, anchorEl, itemsArr){ openValueMenu(col, anchorEl, itemsArr); }

                function wireTable(itemsArr){
                  DRILL_ITEMS = itemsArr;
                  const table = document.querySelector("#drillTable");
                  if (!table) return;

                  Array.from(table.querySelectorAll("th[data-col]")).forEach(th => {
                    th.addEventListener("click", (ev) => {
                      const col = th.getAttribute("data-col");
                      if (!col) return;

                      const existingIdx = sortState.findIndex(s => s.col === col);
                      const ctrl = ev.ctrlKey || ev.metaKey;

                      if (!ctrl) {
                        let dir = "asc";
                        if (existingIdx !== -1) dir = sortState[existingIdx].dir === "asc" ? "desc" : "asc";
                        sortState = [{ col, dir }];
                      } else {
                        if (existingIdx === -1) sortState.push({ col, dir: "asc" });
                        else {
                          const cur = sortState[existingIdx];
                          cur.dir = cur.dir === "asc" ? "desc" : "asc";
                          sortState[existingIdx] = cur;
                        }
                      }
                      renderTable(itemsArr);
                    });
                  });

                  Array.from(document.querySelectorAll(".filterBtn")).forEach(btn => {
                    btn.addEventListener("click", (ev) => {
                      ev.preventDefault(); ev.stopPropagation();
                      const col = btn.getAttribute("data-fcol");
                      if (!col) return;
                      openFilter(col, btn, itemsArr);
                    });
                  });

                  const topClear = document.querySelector("#btnClearAllFiltersTop");
                  if (topClear) topClear.onclick = () => { filters = {}; renderTable(itemsArr); };
                }

                // initial render (default: timestamp desc, newest first)
                sortState = [{ col: "timestamp", dir: "desc" }];
                renderTable(items);

              } catch (e) {
                if (bodyEl) bodyEl.textContent = "Kunne ikke hente detaljer.";
              }
            });
          });
} catch (e) {
          detail.textContent = "Kunne ikke hente elev-detaljer.";
        }
      });
    });
}

  qs("#btnCreateGroup").addEventListener("click", async () => {
    showToast(toastGroup, "Opretter…");
    try {
      await api("/admin/groups", {
        method: "POST",
        body: JSON.stringify({ name: qs("#groupName").value })
      });
      showToast(toastGroup, "Gruppe oprettet ✔", "good");
      qs("#groupName").value = "";
      await refreshGroups();
    } catch (e) {
      showToast(toastGroup, "Fejl: " + e.message, "bad");
    }
  });

  qs("#btnCreateUser").addEventListener("click", async () => {
    showToast(toastUser, "Opretter elev…");
    try {
      await api("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: qs("#stuUser").value,
          password: qs("#stuPass").value,
          display_name: qs("#stuName").value,
          group_id: qs("#stuGroup").value
        })
      });
      showToast(toastUser, "Elev oprettet ✔", "good");
      qs("#stuUser").value="";
      qs("#stuPass").value="";
      qs("#stuName").value="";
      await refreshOverview();
    } catch (e) {
      showToast(toastUser, "Fejl: " + e.message, "bad");
    }
  });


  async function refreshDisputes() {
    const el = qs("#disputes");
    if (!el) return;
    try {
      const d = await api("/admin/disputes");
      const items = d.disputes || [];
      if (!items.length) {
        el.textContent = "Ingen fejlmeldinger endnu.";
        return;
      }
      const rows = items.map(x => {
        const name = x.student_name ? `${x.student_name} (${x.student})` : x.student;
        const audio = x.audio_path ? `<audio controls preload="none" style="width:220px" src="/laesemaskine/${x.audio_path}"></audio>` : "<span class=\"muted\">—</span>";
        const note = x.note ? x.note : "—";
        return `<tr data-did="${x.id}">
          <td>${x.status}</td>
          <td>${name}</td>
          <td><b>${x.expected}</b></td>
          <td class="muted">${x.recognized || "—"}</td>
          <td class="muted">${note}</td>

          <td>${(function(){const v=x.error_type||"";const opts=["","missing_ending","extra_ending","near_match","vowel_swap","cluster_issue","other"];return `<select class="js-etype">${opts.map(o=>`<option value="${o}" ${o===v?"selected":""}>${o||"—"}</option>`).join("")}</select>`;})()}</td>
          <td>${audio}</td>
          <td>
            <button class="ghost js-sendai">Send til AI</button>
            <button class="ghost js-reject">Afvis</button>
            <button class="ghost js-delclip">Slet klip</button>
          </td>
        </tr>`;
      }).join("");
      el.innerHTML = `<table class="table">
        <thead><tr><th>Status</th><th>Elev</th><th>Ord</th><th>Hørt</th><th>Note</th><th>Fejltype</th><th>Lyd</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

      Array.from(el.querySelectorAll("tr[data-did]")).forEach(tr => {
        const did = tr.getAttribute("data-did");
        const sendai = tr.querySelector(".js-sendai");
        const reject = tr.querySelector(".js-reject");
        const delclip = tr.querySelector(".js-delclip");

        if (sendai) sendai.addEventListener("click", async () => {
          try{
            const et = tr.querySelector(".js-etype");
            const error_type = et ? (et.value || null) : null;
            await api(`/admin/disputes/${did}/send_to_ai`, { method:"POST", body: JSON.stringify({ error_type }) });
            showToast("Sendt til AI-kø (godkendt).", "ok");
            await refreshDisputes();
          }catch(e){
            console.error(e);
            showToast("Kunne ikke sende til AI.", "bad");
          }
        });
        if (reject) reject.addEventListener("click", async () => {
          try{
            await api(`/admin/disputes/${did}`, { method:"PATCH", body: JSON.stringify({ status:"rejected" }) });
            showToast("Afvist.", "ok");
            await refreshDisputes();
          }catch(e){
            console.error(e);
            showToast("Kunne ikke afvise.", "bad");
          }
        });
        if (delclip) delclip.addEventListener("click", async () => {
          try{
            await api(`/admin/disputes/${did}/audio`, { method:"DELETE" });
            showToast("Klip slettet.", "ok");
            await refreshDisputes();
          }catch(e){
            console.error(e);
            showToast("Kunne ikke slette klip.", "bad");
          }
        });
      });
    } catch (e) {
      el.textContent = "Kunne ikke hente fejlmeldinger.";
    }
  }

  await refreshGroups();
  await refreshOverview();
  await refreshDisputes();
});
