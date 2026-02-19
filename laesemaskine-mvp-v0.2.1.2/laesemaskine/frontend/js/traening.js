document.addEventListener("DOMContentLoaded", async () => {
  const toast = qs("#toast");
  const btnDetails = qs("#btnDetails");
  let detailedFeedback = (localStorage.getItem("lm_detailed_feedback") === "1");
  function renderDetailsBtn(){ if(btnDetails) btnDetails.textContent = "🧠 Detaljeret feedback: " + (detailedFeedback ? "ON" : "OFF"); }
  renderDetailsBtn();
  if(btnDetails) btnDetails.addEventListener("click", ()=>{ detailedFeedback = !detailedFeedback; localStorage.setItem("lm_detailed_feedback", detailedFeedback ? "1" : "0"); renderDetailsBtn(); });

  function clearToast() {
    if (!toast) return;
    toast.style.display = "none";
    toast.textContent = "";
    toast.className = "toast";
  }

  const wordEl = qs("#word");
  const barOverall = qs("#barOverall");
  const wordBar = qs("#wordBar");
  const phaseLabel = qs("#phaseLabel");
  const counter = qs("#counter");

  // Auth
  let me = null;
  try { me = await requireAuth(["elev","admin"]); } catch (e) { window.location.href="/laesemaskine/index.html"; return; }
  const masteryByLevel = {};
  try {
    (me && me.mastery ? me.mastery : []).forEach(m => { masteryByLevel[Number(m.level)] = Number(m.mastery_1_10); });
  } catch (e) {}
  function getMastery(lvl){ const v = masteryByLevel[Number(lvl)]; return (v>=1 && v<=10) ? v : 5; }

  // Load session context
  const ctxRaw = sessionStorage.getItem("lm_session_ctx");
  if (!ctxRaw) { window.location.href="/laesemaskine/elev.html"; return; }
  const ctx = JSON.parse(ctxRaw);

  const feedbackMode = ctx.feedback_mode || "per_word";
  let level = parseInt(ctx.startLevel || "1", 10);
  const adaptive = new AdaptiveLevel(level);

  const levelStats = {}; // {level:{total,correct, speedSum, speedCount}}
  function statFor(lvl){ lvl=Number(lvl); if(!levelStats[lvl]) levelStats[lvl]={total:0,correct:0,speedSum:0,speedCount:0}; return levelStats[lvl]; }
  let words = [];
  let idx = 0;
  let correctTotal = 0;

  // Session recording v2
  let sessionRecorder = null;
  let sessionStream = null;
  let sessionChunks = [];
  let sessionStartPerf = 0;
  let currentWordStartMs = 0;
  let sessionAudioKey = null;
  let sessionAudioReady = false;
  const micStatusEl = qs("#micStatus");
  function setMicStatus(t){ if(micStatusEl){ micStatusEl.textContent = t || ""; } }
  async function startSessionRecording() {
    // Records the entire test session in one blob (stored locally), used only if a word is disputed.
    sessionAudioReady = false;
    sessionChunks = [];
    sessionAudioKey = null;

    if (!navigator.mediaDevices || !window.MediaRecorder) {
      return;
    }
    try {
      sessionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      sessionRecorder = new MediaRecorder(sessionStream);
      sessionRecorder.ondataavailable = (e) => { if (e.data && e.data.size) sessionChunks.push(e.data); };
      sessionRecorder.start(); // continuous
      sessionStartPerf = performance.now();
    } catch (e) {
      // If mic permission denied, we continue without audio.
      sessionRecorder = null;
      sessionStream = null;
    }
  }

  async function stopSessionRecordingAndStore() {
    // Stop recorder and store blob in IndexedDB (temporary). Also stores key in sessionStorage for resultat.html.
    if (!sessionRecorder) return;
    await new Promise((resolve) => {
      sessionRecorder.onstop = () => resolve(true);
      try { sessionRecorder.stop(); } catch (e) { resolve(true); }
    });
    try { if (sessionStream) sessionStream.getTracks().forEach(t => t.stop()); } catch (e) {}

    const mime = (sessionRecorder && sessionRecorder.mimeType) ? sessionRecorder.mimeType : "audio/webm";
    const blob = sessionChunks.length ? new Blob(sessionChunks, { type: mime || "audio/webm" }) : null;
    sessionChunks = [];
    sessionRecorder = null;
    sessionStream = null;

    if (!blob) return;

    sessionAudioKey = `lm_audio_${ctx.session_id}_${Date.now()}`;
    try {
      await lmStoreBlob(sessionAudioKey, blob);
      sessionStorage.setItem("lm_session_audio_key", sessionAudioKey);
      sessionStorage.setItem("lm_session_audio_sid", String(ctx.session_id));
      sessionStorage.setItem("lm_session_audio_mime", blob.type || mime || "audio/webm");
      sessionStorage.setItem("lm_session_audio_created_at", new Date().toISOString());
      sessionAudioReady = true;
    } catch (e) {
      // If storage fails, we continue without audio evidence.
    }
  }


  function setProgress() { /* overall progress handled in nextWord */
    const pct = Math.round((idx / 20) * 100);
    barOverall.style.width = pct + "%";
    counter.textContent = `${idx}/20`;
  }



  // --- Timing engine v0.2.1.2.2 ---
  const PRE_MS = 2000;
  const POST_MS = 2000;
  const MIN_TOTAL_MS = 7000;
  const MAX_TOTAL_MS = 15000;

  function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
  function lerp(a,b,t){ return a + (b-a)*t; }

  function baseTotalMsForLevel(lvl){
    // Level 1 ~ 12000ms, Level 30 ~ 7000ms
    const t = clamp((Number(lvl)-1)/29, 0, 1);
    return Math.round(lerp(12000, 7000, t));
  }

  function masteryAdjMs(mastery_1_10){
    const t = clamp((Number(mastery_1_10)-1)/9, 0, 1);
    // mastery 1 => +3000ms, mastery 10 => -2000ms
    return Math.round(lerp(3000, -2000, t));
  }

  function perfAdjMs(lvl){
    const st = statFor(lvl);
    if (!st.total) return 0;
    const acc = st.correct / st.total;
    if (acc < 0.70) return Math.round((0.70 - acc) * 6000); // up to ~4200ms
    if (acc > 0.90) return Math.round(-(acc - 0.90) * 3000); // small bonus
    return 0;
  }

  function totalMsForLevel(lvl){
    const base = baseTotalMsForLevel(lvl);
    const m = masteryAdjMs(getMastery(lvl));
    const p = perfAdjMs(lvl);
    return clamp(base + m + p, MIN_TOTAL_MS, MAX_TOTAL_MS);
  }

  function visibleMsForLevel(lvl){
    const total = totalMsForLevel(lvl);
    return clamp(total - (PRE_MS + POST_MS), 3000, 11000);
  }

  function setWordBarPct(pct){
    if(!wordBar) return;
    wordBar.style.width = clamp(pct,0,100).toFixed(1) + "%";
  }

  async function animateWordBar(totalMs, cancelRef){
    // Runs bar 0..100 over totalMs
    const t0 = performance.now();
    return new Promise((resolve) => {
      function tick(){
        const t = performance.now() - t0;
        if (cancelRef && cancelRef.cancelled) { setWordBarPct(100); resolve(true); return; }
        const pct = (t / totalMs) * 100;
        setWordBarPct(pct);
        if (t >= totalMs) { setWordBarPct(100); resolve(true); return; }
        requestAnimationFrame(tick);
      }
      setWordBarPct(0);
      requestAnimationFrame(tick);
    });
  }

  async function loadWordsForLevel(lvl) {
    // band = +/-1 for variety after level 1
    const band = (lvl <= 2) ? 0 : 1;
    const res = await api(`/words?level=${lvl}&count=20&band=${band}`);
    return res.words;
  }


async function nextWord() {
    // overall progress
    const pct = Math.round((idx / 20) * 100);
    if (barOverall) barOverall.style.width = pct + "%";
    counter.textContent = `${idx}/20`;

    if (idx >= 20) {
      try {
        const fin = await api(`/sessions/${ctx.session_id}/finish`, { method: "POST", body: JSON.stringify({ estimated_level: adaptive.level }) });
        sessionStorage.setItem("lm_last_result", JSON.stringify(fin.session));
      } catch (e) {
        sessionStorage.setItem("lm_last_result", JSON.stringify({ estimated_level: adaptive.level, correct_total: correctTotal, total_words: 20 }));
      }
      await stopSessionRecordingAndStore();
      window.location.href = "/laesemaskine/resultat.html";
      return;
    }

    const w = words[idx];
    const lvl = Number(w.niveau || adaptive.level || level);
    const totalMs = totalMsForLevel(lvl);
    const visibleMs = visibleMsForLevel(lvl);

    // phase 1: pre-roll
    if (phaseLabel) phaseLabel.textContent = "Klar…";
    wordEl.textContent = "—";
    // start listening immediately to avoid missing first word
    setMicStatus("🎤 Lytter…");
    const listenT0 = performance.now();
    const listenPromise = listenOnce({ lang: "da-DK", timeoutMs: totalMs + 3000 }).catch(err => ({ _err: err }));

    // bar animation in parallel
    const barCancel = { cancelled: false };
    const barPromise = animateWordBar(totalMs, barCancel);

    // record timing markers for audio clipping
    const nowMs = sessionStartPerf ? (performance.now() - sessionStartPerf) : 0;
    const wordVisibleStartMs = Math.round(nowMs + PRE_MS);
    const wordVisibleEndMs = Math.round(nowMs + PRE_MS + visibleMs);
    const clipStartMs = Math.max(0, wordVisibleStartMs - PRE_MS);
    const clipEndMs = wordVisibleEndMs + POST_MS;

    // wait pre-roll then show word
    await new Promise(r => setTimeout(r, PRE_MS));
    if (phaseLabel) phaseLabel.textContent = "Sig ordet";
    wordEl.textContent = w.ord;

    // Allow early advance: as soon as we have heard something, submit and move on.
    const fullWindowPromise = (async () => {
      await new Promise(r => setTimeout(r, visibleMs));
      if (phaseLabel) phaseLabel.textContent = "Pause…";
      wordEl.textContent = "—";
      await new Promise(r => setTimeout(r, POST_MS));
      return { _type: "timeout" };
    })();

    const first = await Promise.race([
      listenPromise.then(res => ({ _type: "heard", res })).catch(err => ({ _type: "heard", res: { _err: err } })),
      fullWindowPromise
    ]);

    // If we got a result early, jump to next word (no need to wait for full bar)
    if (first && first._type === "heard") {
      const res = first.res;
      setMicStatus("");

      let heard = "";
      if (res && res._err) heard = "";
      else heard = (res && res.text) ? res.text : "";

      const responseMs = Math.round(Math.max(0, (performance.now() - listenT0) - PRE_MS));

      // stop bar and snap to end
      barCancel.cancelled = true;
      await barPromise;

      // Submit answer
      await submitAnswer(w, heard || "", responseMs, false, { start_ms: clipStartMs, end_ms: clipEndMs, visible_ms: visibleMs, level: lvl });

      // brief feedback flash ✓/✗ then continue
      const ok = heard ? isCorrect(w.ord, heard) : false;
      wordEl.textContent = ok ? "✓" : "✗";
      if (phaseLabel) phaseLabel.textContent = ok ? "Godt!" : "Prøv igen";
      await new Promise(r => setTimeout(r, 250));
      wordEl.textContent = "—";
      if (phaseLabel) phaseLabel.textContent = "Klar…";

      // Next word
      idx += 1;
      await nextWord();
      return;
    }

    // Otherwise we completed the full window; now resolve recognition (may still be running until timeout)
    await barPromise;

    const res = await listenPromise;
    setMicStatus("");

    let heard = "";
    let err = null;
    if (res && res._err) err = res._err;
    else heard = (res && res.text) ? res.text : "";

    // compute response time vs visible start (proxy)
    const responseMs = Math.round(Math.max(0, (performance.now() - listenT0) - PRE_MS));

    // Submit (skip if nothing heard -> empty string)
    await submitAnswer(w, heard || "", responseMs, false, { start_ms: clipStartMs, end_ms: clipEndMs, visible_ms: visibleMs, level: lvl });

    // brief feedback flash ✓/✗ then continue
    const ok = heard ? isCorrect(w.ord, heard) : false;
    wordEl.textContent = ok ? "✓" : "✗";
    if (phaseLabel) phaseLabel.textContent = ok ? "Godt!" : "Prøv igen";
    await new Promise(r => setTimeout(r, 250));
    wordEl.textContent = "—";
    if (phaseLabel) phaseLabel.textContent = "Klar…";

    idx += 1;
    await nextWord();
    return;


    // Next word (after submit)
  }

  // Load initial word set
  showToast(toast, "Henter ord…");
  try {
    words = await loadWordsForLevel(level);
    if (words.length < 20) throw new Error("For få ord i ordlisten.");
    showToast(toast, "Klar ✅", "good");
    // Start session recording v2 (one continuous recording)
    await startSessionRecording();
  } catch (e) {
    showToast(toast, "Kunne ikke hente ord: " + e.message, "bad");
    return;
  }


  qs("#btnExit").addEventListener("click", () => {
    window.location.href = "/laesemaskine/elev.html";
  });

  qs("#btnSkip").addEventListener("click", async () => {
    await submitAnswer(words[idx], "", 0, true);
      if (feedbackMode === "after_test") { clearToast(); }
  });

  async function submitAnswer(w, recognized, ms, skipped=false, timing=null) {
    const startedLevel = adaptive.level;
    try {
      const r = await api(`/sessions/${ctx.session_id}/answer`, {
        method: "POST",
        body: JSON.stringify({
          word_id: w.id,
          expected: w.ord,
          recognized: recognized,
          response_time_ms: ms,
          start_ms: (timing && typeof timing.start_ms==="number") ? Math.round(timing.start_ms) : Math.round(currentWordStartMs || 0),
          end_ms: (timing && typeof timing.end_ms==="number") ? Math.round(timing.end_ms) : Math.round(sessionStartPerf ? (performance.now() - sessionStartPerf) : 0)
        })
      });
      if (r.correct) correctTotal++;
      // per-level stats for timing adaptation
      const lvl = (timing && timing.level) ? Number(timing.level) : Number(w.niveau || adaptive.level);
      const st = statFor(lvl);
      st.total += 1;
      if (r.correct) st.correct += 1;
      const vms = (timing && timing.visible_ms) ? Number(timing.visible_ms) : null;
      if (r.correct && vms && ms != null) {
        const speedNorm = Math.max(0, Math.min(1, 1 - (Number(ms) / Number(vms))));
        st.speedSum += speedNorm; st.speedCount += 1;
      }

      adaptive.record(r.correct);
      if (feedbackMode === "per_word") {
        if (r.correct) {
          showToast(toast, "Yes! ✔", "good");
        } else {
          const diag = r.diagnostics || null;
          const msg = (skipped ? "Sprunget" : (detailedFeedback && diag && diag.message_detail ? diag.message_detail : "Ikke helt – prøv næste"));
          showToast(toast, msg, "bad");
        }
      }
    } catch (e) {
      // fallback: local correctness check
      const correct = (recognized || "").trim().toLowerCase() === (w.ord || "").trim().toLowerCase();
      if (correct) correctTotal++;
      const lvl = (timing && timing.level) ? Number(timing.level) : Number(w.niveau || adaptive.level);
      const st = statFor(lvl);
      st.total += 1;
      if (correct) st.correct += 1;
      const vms = (timing && timing.visible_ms) ? Number(timing.visible_ms) : null;
      if (correct && vms && ms != null) {
        const speedNorm = Math.max(0, Math.min(1, 1 - (Number(ms) / Number(vms))));
        st.speedSum += speedNorm; st.speedCount += 1;
      }

      adaptive.record(correct);
      if (feedbackMode === "per_word") {
        if (correct) {
          showToast(toast, "Yes! ✔", "good");
        } else {
          const msg = (skipped ? "Sprunget" : (detailedFeedback ? "Ikke helt – prøv næste" : "Ikke helt – prøv næste"));
          showToast(toast, msg, "bad");
        }
      }
    }

    idx++;
    setProgress();

    // If level shifted a lot, refresh pool for new level but keep remaining count
    if (adaptive.level !== startedLevel && idx < 20) {
      try {
        const remaining = 20 - idx;
        const fresh = await api(`/words?level=${adaptive.level}&count=${remaining}&band=1`);
        // replace remaining segment
        words.splice(idx, remaining, ...fresh.words.slice(0, remaining));
      } catch (e) {
        // ignore
      }
    }
    await nextWord();
  }

  function normalizeDanish(s) {
    // Compatibility: avoid Unicode property escapes (\p{..}) and replaceAll
    s = (s || "").toLowerCase().trim();
    // keep a-z, 0-9 and Danish letters
    s = s.replace(/[^a-z0-9æøå]/g, "");
    // normalize common digraphs (optional)
    s = s.replace(/aa/g, "å").replace(/ae/g, "æ").replace(/oe/g, "ø");
    return s;
  }

  
  // Simple Levenshtein distance
  function levenshtein(a, b) {
    a = a || ""; b = b || "";
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  function isCloseEnough(expected, candidate) {
    const e = normalizeDanish(expected);
    const c = normalizeDanish(candidate);
    if (!e || !c) return false;
    if (e === c) return true;

    const dist = levenshtein(e, c);
    if (e.length >= 7) return dist <= 2;
    if (e.length >= 4) return dist <= 1;
    return false;
  }

  function bestCandidate(expected, listenObj) {
    const alts = [(listenObj && listenObj.text), ...((listenObj && listenObj.alternatives) || [])].filter(Boolean);
    for (const a of alts) {
      if (isCloseEnough(expected, a)) return a;
    }
    return (alts[0] || "").trim();
  }

  
  function normalizeDanish(s) {
    s = (s || "").toLowerCase();
    s = s.replace(/[^a-z0-9æøå]/g, "");
    return s;
  }

  function isCorrect(expected, heard) {
    expected = normalizeDanish(expected);
    heard = normalizeDanish(heard);
    return expected === heard;
  }



  // start
  idx = 0;
  await nextWord();
});
