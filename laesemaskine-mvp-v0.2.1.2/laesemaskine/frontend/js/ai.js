// Speech-to-text wrapper (Browser SpeechRecognition)
// Improves: empty results + wrong first alternative

function makeRecognizer(lang = "da-DK") {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = false;
  rec.maxAlternatives = 5; // important
  rec.continuous = false;
  return rec;
}

async function listenOnce({ lang = "da-DK", timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const rec = makeRecognizer(lang);
    if (!rec) {
      reject(new Error("Talegenkendelse er ikke understøttet i denne browser."));
      return;
    }

    let done = false;

    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { rec.stop(); } catch (e) {}
      reject(new Error("Timeout: jeg kunne ikke høre noget. Prøv igen."));
    }, timeoutMs);

    rec.onresult = (ev) => {
      if (done) return;
      done = true;
      clearTimeout(t);

      // Collect alternatives
      const alts = [];
      const res0 = (ev.results && ev.results[0]);
      if (res0) {
        for (let i = 0; i < res0.length; i++) {
          const tr = res0[i]?.transcript ?? "";
          if (tr && tr.trim()) alts.push(tr.trim());
        }
      }

      if (!alts.length) {
        const text = (ev.results && ev.results[0])?.[0]?.transcript || "";
        resolve({ text: (text || "").trim(), alternatives: [] });
      } else {
        resolve({ text: alts[0], alternatives: alts });
      }
    };

    rec.onerror = (ev) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(new Error(ev.error || "Talegenkendelse fejlede"));
    };

    rec.onspeechend = () => {
      // Stop when user stops speaking (helps avoid empty end states)
      try { rec.stop(); } catch (e) {}
    };

    try {
      rec.start();
    } catch (e) {
      clearTimeout(t);
      reject(new Error("Kunne ikke starte mikrofon. Tjek tilladelser."));
    }
  });
}
