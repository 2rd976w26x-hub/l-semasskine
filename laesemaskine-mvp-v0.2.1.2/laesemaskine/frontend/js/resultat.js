document.addEventListener("DOMContentLoaded", async () => {
  try { await requireAuth(["elev","admin"]); } catch (e) { window.location.href="/laesemaskine/index.html"; return; }

    const detailedFeedback = (localStorage.getItem("lm_detailed_feedback") === "1");

const rRaw = sessionStorage.getItem("lm_last_result");

  // Session recording v2: full round audio is stored locally after test and only uploaded if a word is disputed.
  let sessionAudioUploaded = false;
  let disputesSent = 0;
  let sessionAudioKey = sessionStorage.getItem("lm_session_audio_key");
  let sessionAudioSid = sessionStorage.getItem("lm_session_audio_sid");
  let sessionAudioMime = sessionStorage.getItem("lm_session_audio_mime") || "audio/webm";

  async function ensureSessionAudioUploaded(statusEl) {
    if (sessionAudioUploaded) return true;
    if (!sessionAudioKey || !sessionAudioSid) return false;
    try {
      const blob = await lmGetBlob(sessionAudioKey);
      if (!blob) return false;

      if (statusEl) statusEl.textContent = "Uploader optagelse…";
      const fd = new FormData();
      fd.append("audio", blob, "session_audio.webm");
      fd.append("mime", blob.type || sessionAudioMime);

      const res = await fetch(LM.apiBase + `/sessions/${sessionAudioSid}/audio`, {
        method: "POST",
        body: fd,
        credentials: "include"
      });
      if (!res.ok) throw new Error("Upload fejlede");

      sessionAudioUploaded = true;
      if (statusEl) statusEl.textContent = "Optagelse gemt til fejlmelding ✔";
      return true;
    } catch (e) {
      if (statusEl) statusEl.textContent = "Kunne ikke uploade optagelse: " + e.message;
      return false;
    }
  }

  async function cleanupSessionAudio() {
    try { if (sessionAudioKey) await lmDeleteBlob(sessionAudioKey); } catch (e) {}
    sessionStorage.removeItem("lm_session_audio_key");
    sessionStorage.removeItem("lm_session_audio_sid");
    sessionStorage.removeItem("lm_session_audio_mime");
    sessionStorage.removeItem("lm_session_audio_created_at");
    sessionAudioKey = null;
  }
  // --- Session-optagelse v2: klip + afspil + upload ved fejlmelding ---
  function showModal(el, on){
    if (!el) return;
    el.style.display = on ? "flex" : "none";
  }
  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  function audioBufferToWavBlob(buffer) {
    // Downmix to mono for simplicity
    const numCh = buffer.numberOfChannels;
    const sr = buffer.sampleRate;
    const len = buffer.length;

    const mono = new Float32Array(len);
    for (let ch=0; ch<numCh; ch++){
      const data = buffer.getChannelData(ch);
      for (let i=0; i<len; i++) mono[i] += data[i] / numCh;
    }

    // 16-bit PCM WAV
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample; // mono
    const byteRate = sr * blockAlign;
    const dataSize = len * bytesPerSample;
    const bufferSize = 44 + dataSize;
    const ab = new ArrayBuffer(bufferSize);
    const dv = new DataView(ab);

    function writeStr(off, s){
      for (let i=0; i<s.length; i++) dv.setUint8(off+i, s.charCodeAt(i));
    }
    writeStr(0, "RIFF");
    dv.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    dv.setUint32(16, 16, true); // PCM fmt chunk size
    dv.setUint16(20, 1, true);  // PCM
    dv.setUint16(22, 1, true);  // channels
    dv.setUint32(24, sr, true);
    dv.setUint32(28, byteRate, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, 16, true); // bits
    writeStr(36, "data");
    dv.setUint32(40, dataSize, true);

    let o = 44;
    for (let i=0; i<len; i++){
      const s = clamp(mono[i], -1, 1);
      const v = s < 0 ? s * 0x8000 : s * 0x7fff;
      dv.setInt16(o, v, true);
      o += 2;
    }

    return new Blob([ab], { type: "audio/wav" });
  }

  async function extractWavClipFromSession(sessionBlob, startMs, endMs) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arr = await sessionBlob.arrayBuffer();
    const full = await audioCtx.decodeAudioData(arr);

    const sr = full.sampleRate;
    const startS = Math.floor((Math.max(0, startMs) / 1000) * sr);
    const endS = Math.floor((Math.max(startMs, endMs) / 1000) * sr);
    const a = clamp(startS, 0, full.length-1);
    const b = clamp(endS, a+1, full.length);

    const clipLen = b - a;
    const clip = audioCtx.createBuffer(full.numberOfChannels, clipLen, sr);
    for (let ch=0; ch<full.numberOfChannels; ch++){
      const src = full.getChannelData(ch);
      const dst = clip.getChannelData(ch);
      for (let i=0; i<clipLen; i++) dst[i] = src[a+i];
    }
    return audioBufferToWavBlob(clip);
  }


  // Auto-delete if the student does not dispute shortly after the round.
  setTimeout(() => {
    if (disputesSent === 0) cleanupSessionAudio();
  }, 3 * 60 * 1000);

  window.addEventListener("beforeunload", () => {
    if (disputesSent === 0) cleanupSessionAudio();
  });


  async function postDispute(session_word_id, note, statusEl) {
    // Upload full session audio ONCE (only when disputing a word)
    const okUpload = await ensureSessionAudioUploaded(statusEl);
    if (!okUpload) {
      throw new Error("Optagelsen kunne ikke gemmes. Tjek at du har tilladt mikrofon og gennemført en runde med session-optagelse.");
    }
    await api("/disputes", { method: "POST", body: JSON.stringify({ session_word_id, note }) });
  }

  const r = rRaw ? JSON.parse(rRaw) : null;

  const correct = r?.correct_total ?? 0;
  const total = r?.total_words ?? 20;
  const level = r?.estimated_level ?? "–";

  qs("#kpiCorrect").textContent = `${correct}/${total}`;
  qs("#kpiLevel").textContent = level;

  // stars: 0..10 based on correctness
  const stars = Math.max(1, Math.min(10, Math.round((correct/total) * 10)));
  qs("#stars").textContent = "★".repeat(stars) + "☆".repeat(10 - stars);

  qs("#btnBack").addEventListener("click", () => window.location.href="/laesemaskine/elev.html");
  qs("#btnDash").addEventListener("click", () => window.location.href="/laesemaskine/elev.html");

  // Load per-word results (if available)
  try {
    // We can infer last session by reading recent sessions, then fetch details
    const sessions = await api("/me/sessions");
    const last = sessions.sessions && sessions.sessions[0];
    if (last && last.id) {
      const det = await api(`/sessions/${last.id}`);
      const items = det.items || [];
      const el = qs("#wordResults");
      if (el) {
        if (!items.length) {
          el.textContent = "Ingen ord-resultater fundet.";
        } else {
          // Sortering + filtrering (Læsemaskine-koncept v1)
          lmCreateTable({
            container: el,
            columns: [
              { key:"idx", label:"#", type:"number", get: (_it, i)=> (i+1) },
              { key:"expected", label:"Ord", type:"text", get: it => it.expected },
              { key:"recognized", label:"Hørt", type:"text", get: it => (it.recognized || "—") },
              { key:"correct", label:"Rigtig", type:"text", get: it => (it.correct ? "✔" : "✖") },
              { key:"action", label:"", type:"text", filter:false, sort:false, get: _ => "" },
            ],
            items,
            rowHtml: (it, i) => {
              return `<tr data-rowidx="${i}">
                <td>${i+1}</td>
                <td><b>${it.expected}</b></td>
                <td class="muted">${it.recognized || "—"}${(detailedFeedback && it.diagnostics && it.diagnostics.message_detail && !it.correct) ? `<div class="muted small" style="margin-top:4px">${it.diagnostics.message_detail}</div>` : ""}</td>
                <td>${it.correct ? "✔" : "✖"}</td>
                <td><button class="ghost small js-dispute" data-swid="${it.session_word_id}" data-idx="${i}">Fejlmeld</button></td>
              </tr>`;
            }
          });
          // attach dispute handlers (modal with audio clip)
          const modal = qs("#disputeModal");
          const dmTitle = qs("#dmTitle");
          const dmMeta = qs("#dmMeta");
          const dmAudio = qs("#dmAudio");
          const dmAudioStatus = qs("#dmAudioStatus");
          const dmNote = qs("#dmNote");
          const dmStatus = qs("#dmStatus");
          const dmClose = qs("#dmClose");
          const dmCancel = qs("#dmCancel");
          const dmSend = qs("#dmSend");

          let activeSw = null;
          let activeItem = null;
          let activeClipBlob = null;
          let activeErrorType = null;
          let activeClipUrl = null;

          function resetModal(){
            activeSw = null;
            activeItem = null;
            activeClipBlob = null;
            if (activeClipUrl){ try { URL.revokeObjectURL(activeClipUrl); } catch(e){} }
            activeClipUrl = null;
            if (dmAudio){ dmAudio.removeAttribute("src"); dmAudio.load(); }
            if (dmNote) dmNote.value = "";
            if (dmStatus) dmStatus.textContent = "";
            if (dmAudioStatus) dmAudioStatus.textContent = "";
            if (dmSend) dmSend.disabled = false;
          }

          function closeDisputeModal(){
            resetModal();
            showModal(modal, false);
          }

          if (dmClose) dmClose.onclick = closeDisputeModal;
          if (dmCancel) dmCancel.onclick = closeDisputeModal;
          if (modal) modal.addEventListener("mousedown", (ev)=>{ if (ev.target === modal) closeDisputeModal(); });

          // delegated dispute click handler (survives re-render from sort/filter)
          const itemById = new Map(items.map(x => [Number(x.session_word_id), x]));

          if (el) el.addEventListener("click", async (ev) => {
            const btn = ev.target && ev.target.closest ? ev.target.closest(".js-dispute") : null;
            if (!btn) return;

            const swid = Number(btn.getAttribute("data-swid"));
            const it = itemById.get(swid);
            if (!swid || !it) {
              console.warn("Fejlmeld: kunne ikke finde item", { swid, it });
              return;
            }

            resetModal();
            activeSw = swid;
            activeItem = it;
              activeErrorType = (it && it.diagnostics && it.diagnostics.error_type) ? it.diagnostics.error_type : (it.error_type || null);

            const ok = it.correct ? "✔" : "✖";
            const heard = (it.recognized || "").trim() || "—";
            if (dmTitle) dmTitle.textContent = `Fejlmeld: ${it.expected}`;
            if (dmMeta) dmMeta.textContent = `Hørt: ${heard}  •  Resultat: ${ok}`;
            if (dmAudioStatus) dmAudioStatus.textContent = "Forbereder lydklip…";

            showModal(modal, true);

            try {
              const key = sessionStorage.getItem("lm_session_audio_key");
              if (!key) throw new Error("Ingen session-optagelse fundet (tillad mikrofon under testen).");
              const sessBlob = await lmGetBlob(key);
              if (!sessBlob) throw new Error("Kunne ikke hente optagelsen (den kan være slettet).");

              const startMs = (it.start_ms != null) ? it.start_ms : 0;
              const endMs = (it.end_ms != null) ? it.end_ms : 0;
              if (!endMs || endMs <= startMs) throw new Error("Mangler tidsstempler for ordet.");

              const clip = await extractWavClipFromSession(sessBlob, startMs, endMs);
              activeClipBlob = clip;
              activeClipUrl = URL.createObjectURL(clip);
              if (dmAudio){
                dmAudio.src = activeClipUrl;
                dmAudio.load();
              }
              if (dmAudioStatus) dmAudioStatus.textContent = "Klar – tryk play og lyt ✔";
            } catch (e) {
              if (dmAudioStatus) dmAudioStatus.textContent = "Kunne ikke lave klip: " + e.message;
            }
          });


          if (dmSend){
            dmSend.addEventListener("click", async () => {
              if (!activeSw) return;
              if (dmStatus) dmStatus.textContent = "Sender…";
              try {
                const fd = new FormData();
                fd.append("session_word_id", String(activeSw));
                fd.append("note", dmNote ? (dmNote.value || "") : "");
                if (activeErrorType) fd.append("error_type", activeErrorType);
                if (activeClipBlob){
                  fd.append("audio", activeClipBlob, `clip_${activeSw}.wav`);
                }
                const res = await fetch(LM.apiBase + "/disputes", { method:"POST", body: fd, credentials:"include" });
                if (!res.ok) throw new Error("Fejlmelding kunne ikke sendes");
                disputesSent += 1;
                if (dmStatus) dmStatus.textContent = "Fejlmelding sendt ✔ (afventer lærer)";
                dmSend.disabled = true;
              } catch (e) {
                if (dmStatus) dmStatus.textContent = "Kunne ikke sende: " + e.message;
              }
            });
          }


        }
      }
    }
  } catch (e) {
    const el = qs("#wordResults");
    if (el) el.textContent = "Kunne ikke hente ord-resultater.";
  }

  qs("#btnAgain").addEventListener("click", () => window.location.href="/laesemaskine/elev.html");
});
