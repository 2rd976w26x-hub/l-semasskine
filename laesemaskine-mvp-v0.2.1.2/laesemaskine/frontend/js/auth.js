document.addEventListener("DOMContentLoaded", () => {
  const loginToast = qs("#loginToast");
  const regToast = qs("#regToast");

  qs("#btnLogin").addEventListener("click", async () => {
    showToast(loginToast, "Logger ind…");
    try {
      const data = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: qs("#loginUser").value,
          password: qs("#loginPass").value
        })
      });
      showToast(loginToast, "Logget ind ✔", "good");
      if (data.user.role === "admin") window.location.href = "/laesemaskine/admin.html";
      else window.location.href = "/laesemaskine/elev.html";
    } catch (e) {
      showToast(loginToast, "Kunne ikke logge ind: " + e.message, "bad");
    }
  });

  qs("#btnRegister").addEventListener("click", async () => {
    showToast(regToast, "Opretter…");
    try {
      const data = await api("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          username: qs("#regUser").value,
          password: qs("#regPass").value,
          role: qs("#regRole").value
        })
      });
      showToast(regToast, "Oprettet ✔", "good");
      if (data.user.role === "admin") window.location.href = "/laesemaskine/admin.html";
      else window.location.href = "/laesemaskine/elev.html";
    } catch (e) {
      showToast(regToast, "Kunne ikke oprette: " + e.message, "bad");
    }
  });
});
