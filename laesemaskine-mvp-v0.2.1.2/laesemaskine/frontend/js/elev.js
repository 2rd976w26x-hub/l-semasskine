document.addEventListener("DOMContentLoaded", async () => {
  const toast = qs("#toast");
  let me;
  try {
    me = await requireAuth(["elev","admin"]);
  } catch (e) {
    window.location.href = "/laesemaskine/index.html";
    return;
  }

  qs("#btnLogout").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" });
    window.location.href = "/laesemaskine/index.html";
  });

  // Determine starting level: last session level if available in mastery list
  const mastery = me.mastery || [];
  let lastLevel = mastery.length ? mastery[mastery.length - 1].level : 1;
  qs("#startLevel").value = lastLevel || 1;
  qs("#kpiLevel").textContent = lastLevel || "–";

  const list = qs("#masteryList");
  if (!mastery.length) {
    list.textContent = "Ingen data endnu. Start en træning 🙂";
  } else {
    list.innerHTML = mastery
      .slice(-12)
      .map(m => `Niveau <b>${m.level}</b>: ${"★".repeat(m.mastery_1_10)}<span class="muted">${"★".repeat(10-m.mastery_1_10)}</span>`)
      .join("<br/>");
  }

  qs("#btnStart").addEventListener("click", async () => {
    showToast(toast, "Starter session…");
    try {
      const feedback_mode = qs("#feedbackMode").value;
      const startLevel = parseInt(qs("#startLevel").value || "1", 10);
      const s = await api("/sessions/start", {
        method: "POST",
        body: JSON.stringify({ feedback_mode })
      });
      // Save session context for training page
      const ctx = {
        session_id: s.session_id,
        feedback_mode,
        startLevel,
      };
      sessionStorage.setItem("lm_session_ctx", JSON.stringify(ctx));
      window.location.href = "/laesemaskine/traening.html";
    } catch (e) {
      showToast(toast, "Kunne ikke starte: " + e.message, "bad");
    }
  });
});
