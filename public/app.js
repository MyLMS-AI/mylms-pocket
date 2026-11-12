(function () {
  "use strict";

  const DB_NAME = "mylms_pocket_db";
  const DB_VERSION = 2;
  const MEDIA_CACHE_NAME = "mylms-pocket-media-v1";
  const THEME_KEY = "mylms_pocket_theme";
  const USER_STORAGE_KEY = "mylms_pocket_user";
  const EMAIL_STORAGE_KEY = "mylms_pocket_email";
  const LAST_ACTIVE_KEY = "mylms_pocket_last_active";

  const state = {
    view: "catalog", // "catalog" | "downloaded" | "course-dashboard" | "player" | "curation"
    simulatedOffline: false,
    user: loadSavedUser(),
    studentEmail: localStorage.getItem(EMAIL_STORAGE_KEY) || "andre@glededu.com",
    lastActive: loadLastActive(), // { slug, lessonIdx, slideIdx, updatedAt }
    catalog: [],
    curationList: [],
    curationSearch: "",
    curationSavingId: null,
    packagesMap: {}, // slug -> package
    progressMap: {}, // lessonId -> { completed, score, slideIdx, updatedAt }
    syncQueue: [],
    activeCourseSlug: null,
    activeLessonIdx: 0,
    activeSlideIdx: 0,
    selectedOption: null,
    questionResult: null,
    downloadingSlug: null,
    downloadProgress: 0,
    tutorMessages: [
      {
        role: "assistant",
        text: "Olá! Sou seu Tutor IA no MyLMS Pocket. Posso tirar dúvidas sobre esta aula mesmo quando você estiver sem internet.",
      },
    ],
    tutorLoading: false,
    syncing: false,
    toastMessage: null,
    deferredInstallPrompt: null,
    theme: localStorage.getItem(THEME_KEY) || "light",
    authModal: {
      open: false,
      step: "email", // "email" | "otp"
      email: "",
      otp: "",
      loading: false,
      error: null,
      info: null,
      pendingAction: null, // { type: "download", slug, includeVideo } | { type: "sync" } | null
    },
  };

  function loadSavedUser() {
    try {
      const raw = localStorage.getItem(USER_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveUser(user) {
    state.user = user;
    if (user) {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
      if (user.email) {
        state.studentEmail = user.email;
        localStorage.setItem(EMAIL_STORAGE_KEY, user.email);
      }
    } else {
      localStorage.removeItem(USER_STORAGE_KEY);
    }
    updateTopbarStatus();
  }

  function loadLastActive() {
    try {
      const raw = localStorage.getItem(LAST_ACTIVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveLastActive(slug, lessonIdx, slideIdx) {
    if (!slug) return;
    const entry = {
      slug,
      lessonIdx: Number(lessonIdx) || 0,
      slideIdx: Number(slideIdx) || 0,
      updatedAt: new Date().toISOString(),
    };
    state.lastActive = entry;
    try {
      localStorage.setItem(LAST_ACTIVE_KEY, JSON.stringify(entry));
    } catch {}
  }

  function isUserAdmin() {
    if (!state.user) return false;
    const r = String(state.user.role || "").toLowerCase();
    return r === "super-admin" || r === "admin" || r === "owner" || state.user.email === "andre@glededu.com";
  }

  function applyTheme(theme) {
    state.theme = theme === "dark" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, state.theme);
    const root = document.documentElement;
    if (state.theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }

    const logoSrc = state.theme === "dark" ? "/logo-mylms-light.png" : "/logo-mylms-dark.png";
    document.querySelectorAll(".brand-logo").forEach((img) => {
      img.setAttribute("src", logoSrc);
    });

    const btnTheme = document.getElementById("btnThemeToggle");
    if (btnTheme) {
      btnTheme.textContent = state.theme === "dark" ? "☀️" : "🌙";
    }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("packages")) {
          db.createObjectStore("packages", { keyPath: "slug" });
        }
        if (!db.objectStoreNames.contains("progress")) {
          db.createObjectStore("progress", { keyPath: "lessonId" });
        }
        if (!db.objectStoreNames.contains("syncQueue")) {
          db.createObjectStore("syncQueue", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("catalogCache")) {
          db.createObjectStore("catalogCache", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const req = tx.objectStore(storeName).put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDelete(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const req = tx.objectStore(storeName).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function idbClear(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const req = tx.objectStore(storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function isEffectiveOnline() {
    return navigator.onLine && !state.simulatedOffline;
  }

  function showToast(msg) {
    state.toastMessage = msg;
    renderToast();
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      state.toastMessage = null;
      renderToast();
    }, 3800);
  }

  function renderToast() {
    let el = document.getElementById("pocketToast");
    if (!state.toastMessage) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "pocketToast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.innerHTML = `<span style="color:var(--primary);font-size:16px">●</span> <span>${escapeHtml(state.toastMessage)}</span>`;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function markdownToHtml(md) {
    if (!md) return "<p style='color:var(--muted-foreground)'>Conteúdo desta etapa pronto para leitura.</p>";
    let html = escapeHtml(md);

    // Markdown tables support
    html = html.replace(/((?:^\|.*\|\r?\n)+)/gm, (tableBlock) => {
      const rows = tableBlock.trim().split(/\r?\n/).filter(Boolean);
      if (rows.length < 2) return tableBlock;
      let out = "<table>";
      rows.forEach((row, rIdx) => {
        if (/^\|[\s\-:|]+\|$/.test(row.trim())) return;
        const cells = row
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
        const tag = rIdx === 0 ? "th" : "td";
        out += "<tr>" + cells.map((c) => `<${tag}>${c}</${tag}>`).join("") + "</tr>";
      });
      out += "</table>";
      return out;
    });

    html = html
      .replace(/^### (.*$)/gm, "<h3>$1</h3>")
      .replace(/^## (.*$)/gm, "<h2>$1</h2>")
      .replace(/^# (.*$)/gm, "<h1>$1</h1>")
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>")
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" loading="lazy" />')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" style="color:var(--brand-color);text-decoration:underline;font-weight:600">$1</a>')
      .replace(/^- (.*$)/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>");
    html = html
      .split(/\n{2,}/)
      .map((block) => {
        const b = block.trim();
        if (!b) return "";
        if (/^<(h1|h2|h3|ul|img|table|pre)/.test(b)) return b;
        return `<p>${b.replace(/\n/g, "<br/>")}</p>`;
      })
      .join("\n");
    return html;
  }

  async function loadLocalState() {
    const [pkgs, prog, queue, catCache] = await Promise.all([
      idbGetAll("packages"),
      idbGetAll("progress"),
      idbGetAll("syncQueue"),
      idbGetAll("catalogCache"),
    ]);

    state.packagesMap = {};
    for (const p of pkgs) {
      if (p && p.slug) state.packagesMap[p.slug] = p;
    }

    state.progressMap = {};
    for (const item of prog) {
      if (item && item.lessonId) state.progressMap[item.lessonId] = item;
    }

    state.syncQueue = queue || [];

    if (catCache.length > 0 && Array.isArray(catCache[0].courses)) {
      state.catalog = catCache[0].courses;
    }
  }

  async function checkActiveSession() {
    if (!isEffectiveOnline()) return;
    try {
      const res = await fetch("/api/auth/get-session", { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.user && data.user.email) {
        saveUser({
          id: data.user.id,
          name: data.user.name || data.user.email.split("@")[0],
          email: data.user.email,
          role: data.user.role || "student",
        });
      }
    } catch {}
  }

  async function fetchCatalogFromApi() {
    if (!isEffectiveOnline()) return;
    try {
      const res = await fetch("/api/offline/courses");
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data && Array.isArray(data.courses) ? data.courses : null;
      if (list) {
        state.catalog = list;
        await idbPut("catalogCache", { id: "latest", courses: list, updatedAt: Date.now() });
        render();
      }
    } catch {}
  }

  async function fetchCurationCatalog() {
    if (!isEffectiveOnline()) {
      showToast("Conecte-se à internet para gerenciar a curadoria de cursos.");
      return;
    }
    try {
      const res = await fetch("/api/offline/admin/courses", { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data && Array.isArray(data.courses) ? data.courses : null;
      if (list) {
        state.curationList = list;
        render();
      }
    } catch {}
  }

  async function toggleCourseCuration(courseId, nextEnabled, featured) {
    state.curationSavingId = courseId;
    render();
    try {
      const res = await fetch(`/api/offline/admin/courses/${encodeURIComponent(courseId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          enabled: nextEnabled,
          featured: Boolean(featured),
        }),
      });
      if (!res.ok) throw new Error("Falha ao atualizar curadoria");
      state.curationList = state.curationList.map((c) =>
        c.id === courseId ? { ...c, offlineEnabled: nextEnabled, offlineFeatured: Boolean(featured) } : c
      );
      await fetchCatalogFromApi();
      showToast(nextEnabled ? "Curso aprovado para o MyLMS Pocket!" : "Curso ocultado do MyLMS Pocket.");
    } catch (err) {
      showToast("Erro: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      state.curationSavingId = null;
      render();
    }
  }

  // =========================================================================
  // Autenticação Oficial MyLMS (BetterAuth E-mail + Código OTP / GLED99)
  // =========================================================================
  function openAuthModal(pendingAction = null) {
    state.authModal.open = true;
    state.authModal.step = "email";
    state.authModal.email = (state.user && state.user.email) || state.studentEmail || "";
    state.authModal.otp = "";
    state.authModal.loading = false;
    state.authModal.error = null;
    state.authModal.info = null;
    state.authModal.pendingAction = pendingAction;
    renderAuthModal();
  }

  function closeAuthModal() {
    state.authModal.open = false;
    state.authModal.loading = false;
    state.authModal.error = null;
    renderAuthModal();
  }

  async function requestMyLmsOtp(emailInput) {
    const email = String(emailInput || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      state.authModal.error = "Informe seu e-mail cadastrado no MyLMS.";
      renderAuthModal();
      return;
    }

    state.authModal.email = email;
    state.authModal.loading = true;
    state.authModal.error = null;
    state.authModal.info = null;
    renderAuthModal();

    try {
      const res = await fetch("/api/auth/secure/email-otp/send-verification-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, type: "sign-in" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || "Não foi possível enviar o código de acesso.");
      }
      state.authModal.step = "otp";
      state.authModal.info = `Enviamos um código de 6 dígitos para ${email}.`;
    } catch (err) {
      state.authModal.error = err instanceof Error ? err.message : "Erro ao enviar código.";
    } finally {
      state.authModal.loading = false;
      renderAuthModal();
    }
  }

  async function verifyMyLmsOtp(otpInput) {
    const email = state.authModal.email;
    const otp = String(otpInput || "").trim().toUpperCase();
    if (otp.length < 6) {
      state.authModal.error = "Digite os 6 caracteres do código de verificação.";
      renderAuthModal();
      return;
    }

    state.authModal.loading = true;
    state.authModal.error = null;
    renderAuthModal();

    try {
      const res = await fetch("/api/auth/secure/sign-in/email-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, otp }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user) {
        throw new Error(data.message || "Código inválido ou expirado. Verifique e tente novamente.");
      }

      saveUser({
        id: data.user.id,
        name: data.user.name || email.split("@")[0],
        email: data.user.email || email,
        role: data.user.role || (email === "andre@glededu.com" ? "super-admin" : "student"),
      });

      const pending = state.authModal.pendingAction;
      closeAuthModal();
      showToast(`Bem-vindo(a), ${state.user.name}! Conta MyLMS conectada.`);
      render();

      if (pending) {
        if (pending.type === "download" && pending.slug) {
          await downloadCoursePackage(pending.slug, Boolean(pending.includeVideo));
        } else if (pending.type === "sync") {
          await syncPendingEvents();
        }
      }
    } catch (err) {
      state.authModal.error = err instanceof Error ? err.message : "Falha na autenticação.";
      state.authModal.loading = false;
      renderAuthModal();
    }
  }

  async function signOutMyLms() {
    try {
      await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
    } catch {}
    saveUser(null);
    showToast("Você saiu da sua conta MyLMS. Cursos já baixados continuam no aparelho.");
    render();
  }

  function renderAuthModal() {
    const overlay = document.getElementById("authModalOverlay");
    const body = document.getElementById("authModalBody");
    if (!overlay || !body) return;

    if (!state.authModal.open) {
      overlay.classList.remove("open");
      overlay.setAttribute("aria-hidden", "true");
      return;
    }

    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");

    const logoSrc = state.theme === "dark" ? "/logo-mylms-light.png" : "/logo-mylms-dark.png";

    if (state.user && state.authModal.step === "email" && !state.authModal.pendingAction) {
      body.innerHTML = `
        <div style="text-align:center;margin-bottom:18px">
          <img src="${logoSrc}" alt="MyLMS" class="brand-logo" style="height:32px;margin:0 auto 12px" />
          <h2 id="authModalTitle" style="margin:0;font-size:20px;font-weight:800">Sua Conta MyLMS</h2>
          <p style="margin:6px 0 0;font-size:13px;color:var(--muted-foreground)">Conectado para baixar cursos e sincronizar progresso</p>
        </div>
        <div style="padding:14px;border-radius:14px;background:var(--surface-950);border:1px solid var(--border);margin-bottom:18px">
          <div style="font-size:15px;font-weight:800">${escapeHtml(state.user.name)}</div>
          <div style="font-size:13px;color:var(--muted-foreground);margin-top:2px">${escapeHtml(state.user.email)}</div>
          <div style="margin-top:8px">
            <span class="pill pill-cached">✓ Conta Oficial MyLMS Ativa</span>
          </div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button type="button" class="btn" id="btnSwitchAccount">Trocar Conta</button>
          <button type="button" class="btn btn-danger" id="btnSignOutModal">Sair da Conta</button>
        </div>
      `;

      const btnSwitch = document.getElementById("btnSwitchAccount");
      if (btnSwitch) {
        btnSwitch.onclick = () => {
          state.user = null;
          renderAuthModal();
        };
      }
      const btnOut = document.getElementById("btnSignOutModal");
      if (btnOut) {
        btnOut.onclick = () => signOutMyLms().then(closeAuthModal);
      }
      return;
    }

    if (state.authModal.step === "email") {
      body.innerHTML = `
        <div style="text-align:center;margin-bottom:18px">
          <img src="${logoSrc}" alt="MyLMS" class="brand-logo" style="height:32px;margin:0 auto 12px" />
          <h2 id="authModalTitle" style="margin:0;font-size:20px;font-weight:800">Entrar com sua conta MyLMS</h2>
          <p style="margin:6px 0 0;font-size:13px;color:var(--muted-foreground)">
            Use o mesmo e-mail da plataforma <strong>MyLMS</strong> para liberar o download dos seus cursos e sincronizar seu certificado.
          </p>
        </div>
        ${
          state.authModal.error
            ? `<div style="padding:10px 12px;border-radius:10px;background:rgba(218,30,40,0.12);border:1px solid rgba(218,30,40,0.4);color:var(--danger);font-size:13px;margin-bottom:12px">${escapeHtml(state.authModal.error)}</div>`
            : ""
        }
        <form id="authEmailForm" style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label for="authEmailField" style="display:block;font-size:12px;font-weight:700;margin-bottom:6px;color:var(--muted-foreground)">SEU E-MAIL DO MYLMS</label>
            <input
              id="authEmailField"
              type="email"
              required
              class="input"
              placeholder="seu.email@instituicao.com"
              value="${escapeHtml(state.authModal.email)}"
              style="width:100%"
            />
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;height:46px;font-size:14px" ${state.authModal.loading ? "disabled" : ""}>
            ${state.authModal.loading ? "Enviando código..." : "Receber Código de Acesso →"}
          </button>
        </form>
      `;

      const form = document.getElementById("authEmailForm");
      if (form) {
        form.onsubmit = (e) => {
          e.preventDefault();
          const field = document.getElementById("authEmailField");
          requestMyLmsOtp(field ? field.value : "");
        };
      }
    } else {
      body.innerHTML = `
        <div style="text-align:center;margin-bottom:16px">
          <img src="${logoSrc}" alt="MyLMS" class="brand-logo" style="height:30px;margin:0 auto 10px" />
          <h2 id="authModalTitle" style="margin:0;font-size:20px;font-weight:800">Digite o código de verificação</h2>
          <p style="margin:6px 0 0;font-size:13px;color:var(--muted-foreground)">
            Enviado para <strong>${escapeHtml(state.authModal.email)}</strong>
          </p>
        </div>
        ${
          state.authModal.error
            ? `<div style="padding:10px 12px;border-radius:10px;background:rgba(218,30,40,0.12);border:1px solid rgba(218,30,40,0.4);color:var(--danger);font-size:13px;margin-bottom:12px">${escapeHtml(state.authModal.error)}</div>`
            : ""
        }
        <form id="authOtpForm" style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label for="authOtpField" style="display:block;font-size:12px;font-weight:700;margin-bottom:6px;color:var(--muted-foreground)">CÓDIGO DE 6 CARACTERES</label>
            <input
              id="authOtpField"
              type="text"
              maxlength="6"
              required
              class="input"
              placeholder="000000"
              value="${escapeHtml(state.authModal.otp)}"
              style="width:100%;text-align:center;font-size:22px;font-weight:800;letter-spacing:0.3em;text-transform:uppercase;height:52px"
            />
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;height:46px;font-size:14px" ${state.authModal.loading ? "disabled" : ""}>
            ${state.authModal.loading ? "Validando acesso..." : "Confirmar e Entrar"}
          </button>
          <button type="button" id="btnBackToEmail" class="btn" style="width:100%">
            ← Alterar e-mail ou reenviar
          </button>
        </form>
      `;

      const otpForm = document.getElementById("authOtpForm");
      if (otpForm) {
        otpForm.onsubmit = (e) => {
          e.preventDefault();
          const field = document.getElementById("authOtpField");
          verifyMyLmsOtp(field ? field.value : "");
        };
      }
      const btnBack = document.getElementById("btnBackToEmail");
      if (btnBack) {
        btnBack.onclick = () => {
          state.authModal.step = "email";
          state.authModal.error = null;
          renderAuthModal();
        };
      }
      const otpInput = document.getElementById("authOtpField");
      if (otpInput) otpInput.focus();
    }
  }

  // =========================================================================
  // Download, Importação & Sincronização de Cursos
  // =========================================================================
  async function downloadCoursePackage(slug, includeVideo = false) {
    if (!state.user) {
      openAuthModal({ type: "download", slug, includeVideo });
      return;
    }

    if (!isEffectiveOnline()) {
      showToast("Conecte-se à internet para baixar este curso para o aparelho.");
      return;
    }

    state.downloadingSlug = slug;
    state.downloadProgress = 15;
    render();
    try {
      const emailParam = state.user.email || state.studentEmail;
      const res = await fetch(
        `/api/offline/courses/${encodeURIComponent(slug)}/package?email=${encodeURIComponent(emailParam)}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Falha ao baixar pacote (" + res.status + ")");
      const bundle = await res.json();
      state.downloadProgress = 80;
      render();

      const storedPkg = {
        ...bundle,
        slug: bundle.course.slug,
        includeVideo,
        savedAt: new Date().toISOString(),
      };
      await idbPut("packages", storedPkg);
      state.packagesMap[storedPkg.slug] = storedPkg;

      if (bundle.userProgress && typeof bundle.userProgress === "object") {
        for (const [lessonId, p] of Object.entries(bundle.userProgress)) {
          if (!state.progressMap[lessonId]) {
            const entry = {
              lessonId,
              courseId: bundle.course.id,
              completed: Boolean(p.completed),
              score: Number(p.score) || 100,
              slideIdx: 0,
              updatedAt: p.completedAt || new Date().toISOString(),
            };
            await idbPut("progress", entry);
            state.progressMap[lessonId] = entry;
          }
        }
      }

      state.downloadingSlug = null;
      state.downloadProgress = 100;
      showToast(`Curso "${bundle.course.title}" salvo no aparelho para estudo offline!`);
      render();

      // Background media pre-caching so UI is instant (<1s)
      const assets = [
        ...((bundle.mediaManifest && bundle.mediaManifest.coreAssets) || []),
        ...(includeVideo ? (bundle.mediaManifest && bundle.mediaManifest.optionalVideoAssets) || [] : []),
      ].slice(0, 40);

      if ("caches" in window && assets.length > 0) {
        caches.open(MEDIA_CACHE_NAME).then((cache) => {
          Promise.allSettled(
            assets
              .filter((a) => a && a.url)
              .map((a) => cache.add(new Request(a.url, { mode: "no-cors" })))
          );
        }).catch(() => {});
      }
    } catch (err) {
      state.downloadingSlug = null;
      state.downloadProgress = 0;
      showToast("Erro ao baixar curso: " + (err instanceof Error ? err.message : String(err)));
      render();
    }
  }

  async function removeOfflinePackage(slug) {
    await idbDelete("packages", slug);
    delete state.packagesMap[slug];
    if (state.lastActive && state.lastActive.slug === slug) {
      state.lastActive = null;
      localStorage.removeItem(LAST_ACTIVE_KEY);
    }
    showToast("Curso removido do armazenamento deste aparelho.");
    render();
  }

  function exportLocalPackageJson(slug) {
    const pkg = state.packagesMap[slug];
    if (!pkg) return;
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mylms-pocket-${slug}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Arquivo .json do curso exportado.");
  }

  async function importPackageFromFile(file) {
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      if (!bundle || !bundle.course || !bundle.course.slug || !Array.isArray(bundle.modules)) {
        throw new Error("Arquivo JSON não é um pacote válido do MyLMS Pocket.");
      }
      const storedPkg = {
        ...bundle,
        slug: bundle.course.slug,
        savedAt: new Date().toISOString(),
      };
      await idbPut("packages", storedPkg);
      state.packagesMap[storedPkg.slug] = storedPkg;
      showToast(`Curso "${bundle.course.title}" importado e pronto para estudo!`);
      openCourseDashboard(storedPkg.slug);
    } catch (err) {
      showToast("Falha na importação: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  function flattenLessons(pkg) {
    const list = [];
    if (!pkg || !Array.isArray(pkg.modules)) return list;
    for (const mod of pkg.modules) {
      for (const les of mod.lessons || []) {
        list.push({
          ...les,
          moduleTitle: mod.title,
          moduleId: mod.id,
        });
      }
    }
    return list;
  }

  function computeCourseProgress(pkg) {
    const lessons = flattenLessons(pkg);
    if (lessons.length === 0) return { completed: 0, total: 0, pct: 0, nextLessonIdx: 0, nextSlideIdx: 0 };
    let completed = 0;
    let firstIncompleteIdx = -1;

    lessons.forEach((l, idx) => {
      const p = state.progressMap[l.id];
      if (p && p.completed) {
        completed++;
      } else if (firstIncompleteIdx === -1) {
        firstIncompleteIdx = idx;
      }
    });

    let nextLessonIdx = firstIncompleteIdx >= 0 ? firstIncompleteIdx : 0;
    let nextSlideIdx = 0;

    if (state.lastActive && state.lastActive.slug === pkg.slug) {
      const candidateIdx = Number(state.lastActive.lessonIdx) || 0;
      if (candidateIdx >= 0 && candidateIdx < lessons.length) {
        nextLessonIdx = candidateIdx;
        const maxSlides = (lessons[candidateIdx].slides || []).length;
        const sIdx = Number(state.lastActive.slideIdx) || 0;
        nextSlideIdx = sIdx >= 0 && sIdx < maxSlides ? sIdx : 0;
      }
    } else {
      const targetLesson = lessons[nextLessonIdx];
      if (targetLesson && state.progressMap[targetLesson.id]) {
        nextSlideIdx = Number(state.progressMap[targetLesson.id].slideIdx) || 0;
      }
    }

    return {
      completed,
      total: lessons.length,
      pct: Math.round((completed / lessons.length) * 100),
      nextLessonIdx,
      nextSlideIdx,
    };
  }

  function openCourseDashboard(slug) {
    const pkg = state.packagesMap[slug];
    if (!pkg) {
      showToast("Baixe este curso primeiro para abrir o painel de aulas.");
      return;
    }
    state.activeCourseSlug = slug;
    state.view = "course-dashboard";
    closeMobileDrawer();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resumeCourseStudy(slug, explicitLessonIdx = null, explicitSlideIdx = null) {
    const pkg = state.packagesMap[slug];
    if (!pkg) {
      downloadCoursePackage(slug, false);
      return;
    }
    const lessons = flattenLessons(pkg);
    if (lessons.length === 0) {
      showToast("Este curso ainda não possui aulas publicadas.");
      return;
    }

    const prog = computeCourseProgress(pkg);
    const lessonIdx =
      explicitLessonIdx !== null && explicitLessonIdx !== undefined
        ? Number(explicitLessonIdx)
        : prog.nextLessonIdx;
    const safeLessonIdx = Math.max(0, Math.min(lessons.length - 1, lessonIdx));

    const slidesCount = (lessons[safeLessonIdx].slides || []).length;
    const rawSlideIdx =
      explicitSlideIdx !== null && explicitSlideIdx !== undefined
        ? Number(explicitSlideIdx)
        : explicitLessonIdx !== null
        ? 0
        : prog.nextSlideIdx;
    const safeSlideIdx = slidesCount > 0 ? Math.max(0, Math.min(slidesCount - 1, rawSlideIdx)) : 0;

    state.activeCourseSlug = slug;
    state.activeLessonIdx = safeLessonIdx;
    state.activeSlideIdx = safeSlideIdx;
    state.selectedOption = null;
    state.questionResult = null;
    state.view = "player";

    saveLastActive(slug, safeLessonIdx, safeSlideIdx);
    closeMobileDrawer();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveSlideCheckpoint(courseId, lessonId, slideIdx) {
    const existing = state.progressMap[lessonId];
    const record = {
      lessonId,
      courseId,
      completed: existing ? Boolean(existing.completed) : false,
      score: existing ? Number(existing.score) || 100 : 0,
      slideIdx: Number(slideIdx) || 0,
      updatedAt: new Date().toISOString(),
    };
    await idbPut("progress", record);
    state.progressMap[lessonId] = record;
  }

  async function markLessonCompleted(courseId, lessonId, score = 100, slideIdx = 0) {
    const now = new Date().toISOString();
    const record = {
      lessonId,
      courseId,
      completed: true,
      score,
      slideIdx,
      updatedAt: now,
    };
    await idbPut("progress", record);
    state.progressMap[lessonId] = record;

    const syncEvent = {
      courseId,
      lessonId,
      completed: true,
      score,
      completedAt: now,
    };
    await idbPut("syncQueue", syncEvent);
    state.syncQueue = await idbGetAll("syncQueue");
    updateTopbarStatus();

    if (isEffectiveOnline()) {
      await syncPendingEvents(true);
    } else {
      showToast("Progresso salvo no aparelho! Será sincronizado quando houver conexão.");
    }
  }

  async function syncPendingEvents(silent = false) {
    if (state.syncing) return;
    const queue = await idbGetAll("syncQueue");
    if (queue.length === 0) {
      if (!silent) showToast("Seu progresso já está 100% sincronizado com o MyLMS.");
      return;
    }
    if (!isEffectiveOnline()) {
      if (!silent) showToast("Sem internet no momento. Seus dados estão salvos no aparelho.");
      return;
    }

    state.syncing = true;
    updateTopbarStatus();
    try {
      const emailToSync = (state.user && state.user.email) || state.studentEmail;
      const res = await fetch("/api/offline/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: emailToSync,
          events: queue.map((q) => ({
            courseId: q.courseId,
            lessonId: q.lessonId,
            completed: q.completed,
            score: q.score,
            completedAt: q.completedAt,
          })),
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      await idbClear("syncQueue");
      state.syncQueue = [];
      showToast(`Sincronizado com o MyLMS (${data.syncedCount || queue.length} aula(s) atualizada(s))!`);
    } catch {
      if (!silent) showToast("Não foi possível sincronizar agora. Tentaremos novamente.");
    } finally {
      state.syncing = false;
      updateTopbarStatus();
      render();
    }
  }

  function localSmallestTutorFallback(question, pkg, lesson, slide) {
    const q = (question || "").toLowerCase();
    const slideText = (slide && slide.content ? slide.content : "").replace(/[#*_`>-]/g, "").trim();
    const sentences = slideText
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);

    const keywords = q
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3);

    const matched = sentences.filter((s) => keywords.some((k) => s.toLowerCase().includes(k))).slice(0, 3);
    const excerpt = (matched.length > 0 ? matched : sentences.slice(0, 3)).join(" ");

    let reply = `📚 **Resumo da Aula (${lesson ? lesson.title : pkg.course.title}):**\n\n`;
    if (excerpt) {
      reply += `${excerpt}\n\n`;
    } else {
      reply += `Esta etapa aborda **${slide ? slide.title : "os conceitos centrais da aula"}**.\n\n`;
    }

    if (slide && slide.question && slide.question.explanation) {
      reply += `💡 **Dica da Atividade:** ${slide.question.explanation}`;
    } else {
      reply += `💡 **Dica de Estudo:** Releia os pontos destacados acima e avance para a atividade prática para fixar o conteúdo.`;
    }
    return reply;
  }

  async function askTutor(questionText) {
    const q = (questionText || "").trim();
    if (!q || state.tutorLoading) return;

    const pkg = state.packagesMap[state.activeCourseSlug];
    if (!pkg) return;
    const lessons = flattenLessons(pkg);
    const lesson = lessons[state.activeLessonIdx] || lessons[0];
    const slides = (lesson && lesson.slides) || [];
    const slide = slides[state.activeSlideIdx] || slides[0];

    state.tutorMessages.push({ role: "user", text: q });
    state.tutorLoading = true;
    render();

    if (!isEffectiveOnline()) {
      const localAnswer = localSmallestTutorFallback(q, pkg, lesson, slide);
      state.tutorMessages.push({
        role: "assistant",
        text: localAnswer,
        meta: "Tutor Local Offline",
      });
      state.tutorLoading = false;
      render();
      return;
    }

    try {
      const res = await fetch("/api/offline/tutor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          courseTitle: pkg.course.title,
          lessonTitle: lesson ? lesson.title : "",
          slideContent: slide ? slide.content : "",
        }),
      });
      if (!res.ok) throw new Error("Offline tutor fallback");
      const data = await res.json();
      state.tutorMessages.push({
        role: "assistant",
        text: data.answer || localSmallestTutorFallback(q, pkg, lesson, slide),
        meta: "Tutor IA MyLMS",
      });
    } catch {
      const localAnswer = localSmallestTutorFallback(q, pkg, lesson, slide);
      state.tutorMessages.push({
        role: "assistant",
        text: localAnswer,
        meta: "Tutor Local Offline",
      });
    } finally {
      state.tutorLoading = false;
      render();
    }
  }

  // =========================================================================
  // Topbar, Drawer & Telas do Aluno (100% Padrão AVA MyLMS)
  // =========================================================================
  function updateTopbarStatus() {
    const netPill = document.getElementById("netStatusPill");
    const syncCountEl = document.getElementById("syncQueueCount");
    const simBtn = document.getElementById("navSimOfflineBtn");
    const authBtn = document.getElementById("btnAuthHeader");
    const adminNavBtn = document.getElementById("navAdminCurationBtn");
    const drawerAuthCard = document.getElementById("drawerAuthCard");

    const online = isEffectiveOnline();
    if (netPill) {
      netPill.className = "pill " + (online ? "pill-online" : "pill-offline");
      netPill.innerHTML = online ? "● Online" : "⚡ Sem Internet";
    }
    if (syncCountEl) {
      syncCountEl.textContent = String(state.syncQueue.length);
    }
    if (simBtn) {
      simBtn.innerHTML = state.simulatedOffline
        ? "🌐 Voltar ao Modo Online"
        : "✈️ Testar Modo Sem Internet";
    }
    if (authBtn) {
      if (state.user) {
        const firstName = (state.user.name || state.user.email).split(" ")[0];
        authBtn.innerHTML = `👤 <span class="auth-label-text">${escapeHtml(firstName)}</span>`;
      } else {
        authBtn.innerHTML = `🔑 <span class="auth-label-text">Entrar</span>`;
      }
    }
    if (adminNavBtn) {
      adminNavBtn.style.display = isUserAdmin() ? "flex" : "none";
    }
    if (drawerAuthCard) {
      if (state.user) {
        drawerAuthCard.innerHTML = `
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted-foreground)">Aluno Conectado</div>
          <div style="font-size:14px;font-weight:800;margin-top:4px">${escapeHtml(state.user.name)}</div>
          <div style="font-size:12px;color:var(--muted-foreground);word-break:break-all">${escapeHtml(state.user.email)}</div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button type="button" class="btn btn-sm" id="btnDrawerAccount" style="flex:1">Minha Conta</button>
            <button type="button" class="btn btn-sm btn-danger" id="btnDrawerLogout">Sair</button>
          </div>
        `;
        const bAcc = document.getElementById("btnDrawerAccount");
        if (bAcc) bAcc.onclick = () => { closeMobileDrawer(); openAuthModal(); };
        const bOut = document.getElementById("btnDrawerLogout");
        if (bOut) bOut.onclick = () => { closeMobileDrawer(); signOutMyLms(); };
      } else {
        drawerAuthCard.innerHTML = `
          <div style="font-size:12px;font-weight:700;color:var(--foreground)">Conecte sua conta MyLMS</div>
          <p style="font-size:12px;color:var(--muted-foreground);margin:4px 0 10px">Faça login com seu e-mail para baixar novos cursos e sincronizar seu progresso.</p>
          <button type="button" class="btn btn-primary btn-sm" id="btnDrawerLogin" style="width:100%">🔑 Entrar com E-mail MyLMS</button>
        `;
        const bLog = document.getElementById("btnDrawerLogin");
        if (bLog) bLog.onclick = () => { closeMobileDrawer(); openAuthModal(); };
      }
    }
  }

  function openMobileDrawer() {
    const drawer = document.getElementById("mobileDrawer");
    const overlay = document.getElementById("drawerOverlay");
    const btn = document.getElementById("btnMobileMenu");
    if (drawer) drawer.classList.add("open");
    if (overlay) overlay.classList.add("open");
    if (btn) btn.setAttribute("aria-expanded", "true");
  }

  function closeMobileDrawer() {
    const drawer = document.getElementById("mobileDrawer");
    const overlay = document.getElementById("drawerOverlay");
    const btn = document.getElementById("btnMobileMenu");
    if (drawer) drawer.classList.remove("open");
    if (overlay) overlay.classList.remove("open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function renderDrawerLessons() {
    const container = document.getElementById("drawerLessonsContainer");
    if (!container) return;
    if ((state.view !== "player" && state.view !== "course-dashboard") || !state.activeCourseSlug) {
      container.innerHTML = "";
      return;
    }
    const pkg = state.packagesMap[state.activeCourseSlug];
    if (!pkg) {
      container.innerHTML = "";
      return;
    }
    const lessons = flattenLessons(pkg);
    container.innerHTML = `
      <div class="lesson-group-title">Aulas de ${escapeHtml(pkg.course.title)}</div>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${lessons
          .map((l, idx) => {
            const p = state.progressMap[l.id];
            const done = p && p.completed;
            const active = state.view === "player" && idx === state.activeLessonIdx;
            return `
              <button
                type="button"
                class="lesson-item ${active ? "active" : ""}"
                data-drawer-lesson-idx="${idx}"
              >
                <span class="lesson-check ${done ? "done" : ""}">${done ? "✓" : idx + 1}</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(l.title)}</span>
              </button>
            `;
          })
          .join("")}
      </div>
    `;

    container.querySelectorAll("[data-drawer-lesson-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-drawer-lesson-idx")) || 0;
        resumeCourseStudy(state.activeCourseSlug, idx, 0);
      });
    });
  }

  function getPreferredResumePackage() {
    const downloadedList = Object.values(state.packagesMap);
    if (downloadedList.length === 0) return null;
    if (state.lastActive && state.lastActive.slug && state.packagesMap[state.lastActive.slug]) {
      return state.packagesMap[state.lastActive.slug];
    }
    return downloadedList[0];
  }

  function renderCatalogView(root) {
    const downloadedList = Object.values(state.packagesMap);
    const resumePkg = getPreferredResumePackage();
    const resumeProg = resumePkg ? computeCourseProgress(resumePkg) : null;
    const resumeLessons = resumePkg ? flattenLessons(resumePkg) : [];
    const resumeCurrentLesson =
      resumePkg && resumeLessons.length > 0
        ? resumeLessons[resumeProg.nextLessonIdx] || resumeLessons[0]
        : null;

    const catalogToRender =
      state.view === "downloaded"
        ? downloadedList.map((p) => ({
            id: p.course.id,
            title: p.course.title,
            slug: p.course.slug,
            description: p.course.description,
            thumbnailUrl: p.course.thumbnailUrl,
            modulesCount: (p.modules || []).length,
            lessonsCount: flattenLessons(p).length,
            estimatedTextKb: p.stats ? p.stats.estimatedTextKb : 18,
          }))
        : state.catalog.length > 0
        ? state.catalog
        : downloadedList.map((p) => ({
            id: p.course.id,
            title: p.course.title,
            slug: p.course.slug,
            description: p.course.description,
            thumbnailUrl: p.course.thumbnailUrl,
            modulesCount: (p.modules || []).length,
            lessonsCount: flattenLessons(p).length,
            estimatedTextKb: p.stats ? p.stats.estimatedTextKb : 18,
          }));

    const greetingName = state.user ? state.user.name.split(" ")[0] : null;

    root.innerHTML = `
      <!-- Banner Principal do Aluno (100% focado no estudo) -->
      <section class="mylms-hero">
        <div class="mylms-hero-content">
          <div class="mylms-hero-text">
            <span class="pill pill-cached">
              ${state.user ? `✓ Olá, ${escapeHtml(greetingName)}` : "📲 Estudo Offline MyLMS"}
            </span>
            <h1>
              ${
                resumePkg
                  ? `Continue de onde parou: ${escapeHtml(resumePkg.course.title)}`
                  : "Seus Cursos Sempre com Você"
              }
            </h1>
            <p>
              ${
                resumePkg && resumeCurrentLesson
                  ? `Próxima etapa: <strong>${escapeHtml(resumeCurrentLesson.title)}</strong> (${resumeProg.completed}/${resumeProg.total} aulas concluídas • ${resumeProg.pct}%).`
                  : state.user
                  ? "Baixe seus cursos em segundos para estudar no celular ou computador mesmo sem conexão com a internet."
                  : "Entre com sua conta do MyLMS para baixar seus cursos no aparelho e estudar sem precisar de internet."
              }
            </p>
          </div>

          <div class="mylms-hero-actions">
            ${
              resumePkg
                ? `
                  <button type="button" class="btn btn-primary" id="btnHeroResume" style="width:100%;height:46px;font-size:14px">
                    ▶ Continuar Estudando
                  </button>
                  <button type="button" class="btn" id="btnHeroDashboard" style="width:100%">
                    📋 Ver Módulos e Aulas (${resumeProg.pct}%)
                  </button>
                `
                : state.user
                ? `
                  <div style="font-size:13px;font-weight:700;color:var(--foreground)">
                    Escolha um curso abaixo e toque em <strong>Baixar Curso</strong>.
                  </div>
                `
                : `
                  <button type="button" class="btn btn-primary" id="btnHeroLogin" style="width:100%;height:46px;font-size:14px">
                    🔑 Entrar com Conta MyLMS
                  </button>
                `
            }
          </div>
        </div>
      </section>

      <!-- Abas do Aluno -->
      <div class="section-header">
        <div>
          <h2 class="section-title">
            ${state.view === "downloaded" ? "📲 Cursos Salvos neste Aparelho" : "📚 Cursos Disponíveis para Você"}
          </h2>
          <p class="section-sub">
            ${
              state.view === "downloaded"
                ? `${downloadedList.length} curso(s) pronto(s) para abrir imediatamente sem internet`
                : `${catalogToRender.length} curso(s) selecionado(s) e otimizado(s) para estudo offline`
            }
          </p>
        </div>

        <div class="tab-pills">
          <button type="button" class="btn ${state.view === "catalog" ? "btn-primary" : ""}" id="tabAllBtn">
            Todos os Cursos (${state.catalog.length || catalogToRender.length})
          </button>
          <button type="button" class="btn ${state.view === "downloaded" ? "btn-primary" : ""}" id="tabDownloadedBtn">
            Salvos no Aparelho (${downloadedList.length})
          </button>
          ${
            isUserAdmin()
              ? `<button type="button" class="btn" id="tabAdminCurationBtn">⚙️ Curadoria Offline</button>`
              : ""
          }
        </div>
      </div>

      ${
        catalogToRender.length === 0
          ? `
            <div style="padding:40px 24px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:16px">
              <h3 style="margin:0 0 8px;font-size:18px;font-weight:800">Nenhum curso salvo neste aparelho ainda</h3>
              <p style="margin:0 0 18px;color:var(--muted-foreground);font-size:14px">
                Acesse a aba <strong>Todos os Cursos</strong> para baixar suas aulas em poucos segundos.
              </p>
              <button type="button" class="btn btn-primary" id="btnEmptyGoCatalog">Ver Cursos Disponíveis</button>
            </div>
          `
          : `
            <div class="grid-courses">
              ${catalogToRender
                .map((course) => {
                  const savedPkg = state.packagesMap[course.slug];
                  const isDownloading = state.downloadingSlug === course.slug;
                  const prog = savedPkg ? computeCourseProgress(savedPkg) : null;
                  const cleanDesc = (course.description || "Conteúdo interativo com aulas, atividades práticas e tutor IA.")
                    .replace(/<[^>]*>/g, "")
                    .trim();

                  return `
                    <article class="course-card">
                      <div class="course-thumb" ${savedPkg ? `data-open-dashboard="${escapeHtml(course.slug)}" style="cursor:pointer"` : ""}>
                        ${
                          course.thumbnailUrl
                            ? `<img src="${escapeHtml(course.thumbnailUrl)}" alt="${escapeHtml(course.title)}" loading="lazy" />`
                            : ""
                        }
                        <div class="course-thumb-badges">
                          <span class="pill ${savedPkg ? "pill-cached" : "pill-online"}">
                            ${savedPkg ? "✓ Salvo no Aparelho" : `${course.lessonsCount || 0} aulas`}
                          </span>
                          ${
                            savedPkg && prog
                              ? `<span class="pill" style="background:rgba(15,15,15,0.85);color:#fdb913;border-color:rgba(253,185,19,0.4)">${prog.pct}% concluído</span>`
                              : ""
                          }
                        </div>
                      </div>

                      <div class="course-body">
                        <h3 class="course-title">${escapeHtml(course.title)}</h3>
                        <p class="course-desc">${escapeHtml(cleanDesc)}</p>

                        <div class="course-meta">
                          <span>📦 ${course.modulesCount || 1} módulo(s)</span>
                          <span>📖 ${course.lessonsCount || 0} aula(s)</span>
                        </div>

                        ${
                          savedPkg && prog
                            ? `
                              <div>
                                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;color:var(--muted-foreground);font-weight:600">
                                  <span>Seu progresso</span>
                                  <span style="color:var(--brand-color);font-weight:700">${prog.completed}/${prog.total} aulas (${prog.pct}%)</span>
                                </div>
                                <div class="progress-bar">
                                  <div class="progress-fill" style="width:${prog.pct}%"></div>
                                </div>
                              </div>
                            `
                            : ""
                        }

                        ${
                          isDownloading
                            ? `
                              <div>
                                <div style="font-size:12px;color:var(--brand-color);font-weight:700;margin-bottom:5px">
                                  Salvando aulas no aparelho... ${state.downloadProgress}%
                                </div>
                                <div class="progress-bar">
                                  <div class="progress-fill" style="width:${state.downloadProgress}%"></div>
                                </div>
                              </div>
                            `
                            : ""
                        }

                        <div class="course-actions">
                          ${
                            savedPkg
                              ? `
                                <button type="button" class="btn btn-primary" data-resume-course="${escapeHtml(course.slug)}" style="flex:1">
                                  ▶ ${prog && prog.completed > 0 ? "Continuar Estudando" : "Iniciar Curso"}
                                </button>
                                <button type="button" class="btn" data-open-dashboard="${escapeHtml(course.slug)}" title="Ver lista de módulos e aulas">
                                  📋 Aulas
                                </button>
                                <button type="button" class="btn btn-danger" data-delete-course="${escapeHtml(course.slug)}" title="Remover download deste aparelho">
                                  🗑️
                                </button>
                              `
                              : `
                                <button
                                  type="button"
                                  class="btn btn-primary"
                                  data-download-course="${escapeHtml(course.slug)}"
                                  style="flex:1"
                                  ${isDownloading ? "disabled" : ""}
                                >
                                  ${state.user ? "⬇️ Baixar Curso Offline" : "🔑 Entrar e Baixar Curso"}
                                </button>
                              `
                          }
                        </div>
                      </div>
                    </article>
                  `;
                })
                .join("")}
            </div>
          `
      }
    `;

    const btnHeroResume = document.getElementById("btnHeroResume");
    if (btnHeroResume && resumePkg) {
      btnHeroResume.onclick = () => resumeCourseStudy(resumePkg.slug);
    }
    const btnHeroDashboard = document.getElementById("btnHeroDashboard");
    if (btnHeroDashboard && resumePkg) {
      btnHeroDashboard.onclick = () => openCourseDashboard(resumePkg.slug);
    }
    const btnHeroLogin = document.getElementById("btnHeroLogin");
    if (btnHeroLogin) {
      btnHeroLogin.onclick = () => openAuthModal();
    }
    const tabAll = document.getElementById("tabAllBtn");
    if (tabAll) {
      tabAll.onclick = () => {
        state.view = "catalog";
        render();
      };
    }
    const tabDown = document.getElementById("tabDownloadedBtn");
    if (tabDown) {
      tabDown.onclick = () => {
        state.view = "downloaded";
        render();
      };
    }
    const tabCur = document.getElementById("tabAdminCurationBtn");
    if (tabCur) {
      tabCur.onclick = () => {
        state.view = "curation";
        fetchCurationCatalog();
        render();
      };
    }
    const emptyGo = document.getElementById("btnEmptyGoCatalog");
    if (emptyGo) {
      emptyGo.onclick = () => {
        state.view = "catalog";
        render();
      };
    }

    root.querySelectorAll("[data-download-course]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.getAttribute("data-download-course");
        if (slug) downloadCoursePackage(slug, false);
      });
    });

    root.querySelectorAll("[data-resume-course]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.getAttribute("data-resume-course");
        if (slug) resumeCourseStudy(slug);
      });
    });

    root.querySelectorAll("[data-open-dashboard]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.getAttribute("data-open-dashboard");
        if (slug) openCourseDashboard(slug);
      });
    });

    root.querySelectorAll("[data-delete-course]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.getAttribute("data-delete-course");
        if (slug) removeOfflinePackage(slug);
      });
    });
  }

  // =========================================================================
  // Painel de Módulos e Aulas do Curso (Idêntico ao /home/course/[slug] MyLMS)
  // =========================================================================
  function renderCourseDashboardView(root) {
    const pkg = state.packagesMap[state.activeCourseSlug];
    if (!pkg) {
      state.view = "catalog";
      renderCatalogView(root);
      return;
    }

    const lessons = flattenLessons(pkg);
    const prog = computeCourseProgress(pkg);
    const nextLesson = lessons[prog.nextLessonIdx] || lessons[0];
    const cleanDesc = (pkg.course.description || "").replace(/<[^>]*>/g, "").trim();

    let globalLessonCursor = 0;

    root.innerHTML = `
      <div style="margin-bottom:14px">
        <button type="button" class="btn" id="btnBackToCatalogFromDash">
          ← Voltar para Meus Cursos
        </button>
      </div>

      <section class="course-dash-hero">
        <div class="course-dash-top">
          <div class="course-dash-info">
            <span class="pill pill-cached">✓ Curso Disponível Offline</span>
            <h1>${escapeHtml(pkg.course.title)}</h1>
            ${cleanDesc ? `<p>${escapeHtml(cleanDesc)}</p>` : ""}
          </div>

          <div class="course-dash-cta">
            <button type="button" class="btn btn-primary" id="btnDashContinue" style="height:46px;padding:0 22px;font-size:14px">
              ▶ ${prog.completed > 0 ? "Continuar Estudando" : "Começar Agora"}
            </button>
            <button type="button" class="btn" id="btnDashExportJson" title="Exportar backup .json deste curso">
              💾 Exportar .json
            </button>
          </div>
        </div>

        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:700;margin-bottom:6px">
            <span>Progresso Geral do Curso</span>
            <span style="color:var(--brand-color)">${prog.completed} de ${prog.total} aulas concluídas (${prog.pct}%)</span>
          </div>
          <div class="progress-bar" style="height:10px">
            <div class="progress-fill" style="width:${prog.pct}%"></div>
          </div>
          ${
            nextLesson
              ? `<div style="margin-top:8px;font-size:12px;color:var(--muted-foreground)">Próxima aula recomendada: <strong style="color:var(--foreground)">${escapeHtml(nextLesson.title)}</strong></div>`
              : ""
          }
        </div>
      </section>

      <div class="section-header">
        <div>
          <h2 class="section-title">Conteúdo do Curso</h2>
          <p class="section-sub">${(pkg.modules || []).length} módulo(s) • ${lessons.length} aula(s) • Toque em qualquer aula para abrir</p>
        </div>
      </div>

      <div>
        ${(pkg.modules || [])
          .map((mod, mIdx) => {
            const modLessons = mod.lessons || [];
            const modCompleted = modLessons.filter((l) => state.progressMap[l.id] && state.progressMap[l.id].completed).length;
            return `
              <div class="module-accordion-card">
                <div class="module-accordion-head">
                  <div style="display:flex;align-items:center;gap:10px;min-width:0">
                    <span class="module-badge-idx">Módulo ${mIdx + 1}</span>
                    <h3 style="margin:0;font-size:16px;font-weight:800">${escapeHtml(mod.title)}</h3>
                  </div>
                  <span style="font-size:12px;font-weight:700;color:var(--muted-foreground)">
                    ${modCompleted}/${modLessons.length} concluídas
                  </span>
                </div>

                <div>
                  ${modLessons
                    .map((les) => {
                      const idx = globalLessonCursor++;
                      const p = state.progressMap[les.id];
                      const isDone = p && p.completed;
                      const isCurrent = idx === prog.nextLessonIdx;
                      const slidesCount = (les.slides || []).length;

                      return `
                        <button
                          type="button"
                          class="lesson-dash-row ${isCurrent ? "current" : ""}"
                          data-dash-lesson-idx="${idx}"
                        >
                          <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1">
                            <span class="lesson-check ${isDone ? "done" : ""}">
                              ${isDone ? "✓" : idx + 1}
                            </span>
                            <div style="min-width:0;flex:1">
                              <div style="font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                                ${escapeHtml(les.title)}
                              </div>
                              <div style="font-size:11px;color:var(--muted-foreground)">
                                ${slidesCount} etapa(s) interativa(s) ${isDone ? "• Concluída" : isCurrent ? "• Continue daqui" : ""}
                              </div>
                            </div>
                          </div>
                          <span style="font-size:12px;font-weight:800;color:var(--brand-color);white-space:nowrap">
                            ${isDone ? "Revisar →" : "Estudar →"}
                          </span>
                        </button>
                      `;
                    })
                    .join("")}
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;

    const btnBack = document.getElementById("btnBackToCatalogFromDash");
    if (btnBack) {
      btnBack.onclick = () => {
        state.view = "catalog";
        render();
      };
    }
    const btnCont = document.getElementById("btnDashContinue");
    if (btnCont) {
      btnCont.onclick = () => resumeCourseStudy(pkg.slug);
    }
    const btnExp = document.getElementById("btnDashExportJson");
    if (btnExp) {
      btnExp.onclick = () => exportLocalPackageJson(pkg.slug);
    }

    root.querySelectorAll("[data-dash-lesson-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-dash-lesson-idx")) || 0;
        resumeCourseStudy(pkg.slug, idx, 0);
      });
    });
  }

  // =========================================================================
  // Aba de Curadoria Offline (Exclusiva para Administradores)
  // =========================================================================
  function renderCurationView(root) {
    const q = (state.curationSearch || "").trim().toLowerCase();
    const list = state.curationList.filter(
      (c) => !q || c.title.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q)
    );
    const enabledCount = state.curationList.filter((c) => c.offlineEnabled).length;

    root.innerHTML = `
      <div style="margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <button type="button" class="btn" id="btnBackFromCuration">
          ← Voltar aos Cursos
        </button>
        <a href="https://admin.plataforma.mylms.ai/pt-BR/backoffice/offline" target="_blank" rel="noreferrer" class="btn">
          🌐 Abrir Painel Completo no Backoffice MyLMS
        </a>
      </div>

      <div class="curation-toolbar">
        <div>
          <h2 style="margin:0;font-size:20px;font-weight:800">⚙️ Curadoria de Cursos Offline (MyLMS Pocket)</h2>
          <p style="margin:4px 0 0;font-size:13px;color:var(--muted-foreground)">
            Selecione apenas os cursos com conteúdo completo que devem aparecer para os alunos no MyLMS Pocket (${enabledCount} aprovados de ${state.curationList.length}).
          </p>
        </div>
        <div style="min-width:240px;flex:1;max-width:340px">
          <input
            id="curationSearchInput"
            type="search"
            class="input"
            placeholder="Buscar curso por título ou slug..."
            value="${escapeHtml(state.curationSearch)}"
          />
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px">
        ${
          list.length === 0
            ? `<div style="padding:28px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:16px;color:var(--muted-foreground)">Carregando lista de cursos para curadoria...</div>`
            : list
                .map((c) => {
                  const saving = state.curationSavingId === c.id;
                  return `
                    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:14px 16px;background:var(--card);border:1px solid ${c.offlineEnabled ? "rgba(253,185,19,0.55)" : "var(--border)"};border-radius:14px">
                      <div style="min-width:220px;flex:1">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                          <strong style="font-size:15px">${escapeHtml(c.title)}</strong>
                          <span class="pill ${c.offlineEnabled ? "pill-cached" : ""}">
                            ${c.offlineEnabled ? "✓ Visível no Pocket" : "Oculto"}
                          </span>
                        </div>
                        <div style="font-size:12px;color:var(--muted-foreground);margin-top:4px">
                          Slug: <code>${escapeHtml(c.slug)}</code> • ${c.modulesCount || 0} módulo(s) • ${c.lessonsCount || 0} aula(s) • ${c.slidesCount || 0} slides
                        </div>
                      </div>
                      <div style="display:flex;align-items:center;gap:8px">
                        <button
                          type="button"
                          class="btn ${c.offlineEnabled ? "btn-danger" : "btn-primary"}"
                          data-toggle-curation="${escapeHtml(c.id)}"
                          data-next-enabled="${c.offlineEnabled ? "0" : "1"}"
                          ${saving ? "disabled" : ""}
                        >
                          ${saving ? "Salvando..." : c.offlineEnabled ? "Ocultar do Pocket" : "✓ Aprovar no Pocket"}
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join("")
        }
      </div>
    `;

    const btnBack = document.getElementById("btnBackFromCuration");
    if (btnBack) {
      btnBack.onclick = () => {
        state.view = "catalog";
        render();
      };
    }

    const searchInput = document.getElementById("curationSearchInput");
    if (searchInput) {
      searchInput.oninput = (e) => {
        state.curationSearch = e.target.value || "";
        renderCurationView(root);
      };
    }

    root.querySelectorAll("[data-toggle-curation]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const courseId = btn.getAttribute("data-toggle-curation");
        const nextEnabled = btn.getAttribute("data-next-enabled") === "1";
        if (courseId) toggleCourseCuration(courseId, nextEnabled, false);
      });
    });
  }

  // =========================================================================
  // Player de Aula Interativo (Padrão AVA MyLMS Mobile-First)
  // =========================================================================
  function renderPlayerView(root) {
    const pkg = state.packagesMap[state.activeCourseSlug];
    if (!pkg) {
      state.view = "catalog";
      renderCatalogView(root);
      return;
    }

    const lessons = flattenLessons(pkg);
    if (lessons.length === 0) {
      root.innerHTML = `
        <div style="padding:36px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:16px">
          <h3 style="margin:0 0 12px">Este curso não possui aulas publicadas</h3>
          <button type="button" class="btn btn-primary" id="btnBackCatalogEmpty">← Voltar para Meus Cursos</button>
        </div>
      `;
      const b = document.getElementById("btnBackCatalogEmpty");
      if (b) b.onclick = () => { state.view = "catalog"; render(); };
      return;
    }

    const lesson = lessons[state.activeLessonIdx] || lessons[0];
    const slides = (lesson && lesson.slides && lesson.slides.length > 0)
      ? lesson.slides
      : [
          {
            id: lesson.id + "-default",
            title: lesson.title,
            type: "content",
            content: lesson.description || "Conteúdo da aula disponível para estudo.",
            question: null,
          },
        ];

    if (state.activeSlideIdx >= slides.length) state.activeSlideIdx = 0;
    const slide = slides[state.activeSlideIdx];
    const prog = computeCourseProgress(pkg);
    const lessonProg = state.progressMap[lesson.id];
    const isLessonDone = Boolean(lessonProg && lessonProg.completed);
    const slidePct = Math.round(((state.activeSlideIdx + 1) / slides.length) * 100);

    const groupedByModule = (pkg.modules || []).map((mod) => ({
      ...mod,
      items: (mod.lessons || []).map((l) => {
        const globalIdx = lessons.findIndex((x) => x.id === l.id);
        return { ...l, globalIdx };
      }),
    }));

    let questionBlockHtml = "";
    if (slide.question && Array.isArray(slide.question.options) && slide.question.options.length > 0) {
      const q = slide.question;
      questionBlockHtml = `
        <div class="question-box">
          <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:var(--brand-color);margin-bottom:6px">
            🎯 Atividade Prática
          </div>
          <h4>${escapeHtml(q.stem)}</h4>
          <div>
            ${q.options
              .map((opt, idx) => {
                const optStr = typeof opt === "string" ? opt : opt.text || opt.label || JSON.stringify(opt);
                let cls = "option-btn";
                if (state.selectedOption === optStr) cls += " selected";
                if (state.questionResult) {
                  if (optStr === q.correctAnswer) cls += " correct";
                  else if (state.selectedOption === optStr && !state.questionResult.correct) cls += " wrong";
                }
                return `
                  <button
                    type="button"
                    class="${cls}"
                    data-option="${escapeHtml(optStr)}"
                  >
                    <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1">
                      <span class="option-letter">${String.fromCharCode(65 + idx)}</span>
                      <span style="flex:1;word-break:break-word">${escapeHtml(optStr)}</span>
                    </div>
                    <span class="option-num">${idx + 1}</span>
                  </button>
                `;
              })
              .join("")}
          </div>
          ${
            state.questionResult
              ? `
                <div class="feedback-banner ${state.questionResult.correct ? "ok" : "err"}">
                  <strong>${state.questionResult.correct ? "✅ Resposta Correta!" : "❌ Tente novamente:"}</strong>
                  <div style="margin-top:4px">${escapeHtml(
                    q.explanation ||
                      (state.questionResult.correct
                        ? "Excelente! Você dominou este conceito."
                        : `A alternativa correta é: ${q.correctAnswer}`)
                  )}</div>
                </div>
              `
              : `
                <div style="margin-top:12px;display:flex;justify-content:flex-end">
                  <button type="button" class="btn btn-primary" id="btnVerifyAnswer" ${!state.selectedOption ? "disabled" : ""}>
                    Confirmar Resposta
                  </button>
                </div>
              `
          }
        </div>
      `;
    }

    root.innerHTML = `
      <div class="player-layout">
        <!-- Menu Lateral de Módulos e Aulas (Desktop) -->
        <aside class="sidebar-lessons">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
            <button type="button" class="btn btn-sm" id="btnBackToCourseDash" style="flex:1">
              📋 Painel do Curso
            </button>
            <button type="button" class="btn btn-sm" id="btnBackToCatalog" title="Voltar para Todos os Cursos">
              🏠 Início
            </button>
          </div>

          <div style="padding:12px;border-radius:10px;background:var(--surface-950);border:1px solid var(--border);margin-bottom:12px">
            <div style="font-size:13px;font-weight:800;margin-bottom:6px;line-height:1.3">${escapeHtml(pkg.course.title)}</div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted-foreground);margin-bottom:5px;font-weight:600">
              <span>Progresso do Curso</span>
              <span style="color:var(--brand-color);font-weight:700">${prog.completed}/${prog.total} (${prog.pct}%)</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width:${prog.pct}%"></div>
            </div>
          </div>

          ${groupedByModule
            .map(
              (mod, mIdx) => `
                <div class="lesson-group-title">Módulo ${mIdx + 1}: ${escapeHtml(mod.title)}</div>
                ${mod.items
                  .map((item) => {
                    const p = state.progressMap[item.id];
                    const done = p && p.completed;
                    const active = item.globalIdx === state.activeLessonIdx;
                    return `
                      <button
                        type="button"
                        class="lesson-item ${active ? "active" : ""}"
                        data-lesson-idx="${item.globalIdx}"
                      >
                        <span class="lesson-check ${done ? "done" : ""}">${done ? "✓" : item.globalIdx + 1}</span>
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.title)}</span>
                      </button>
                    `;
                  })
                  .join("")}
              `
            )
            .join("")}
        </aside>

        <!-- Área Principal da Aula -->
        <div>
          <!-- Barra de Topo da Aula -->
          <div class="ava-header-bar">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
              <button type="button" class="btn btn-sm" id="btnMobileBackDash">
                ← Curso
              </button>
              <div class="ava-breadcrumb" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                <strong>${escapeHtml(lesson.title)}</strong>
              </div>
            </div>

            <div class="ava-step-progress">
              <span>Etapa ${state.activeSlideIdx + 1} de ${slides.length}</span>
              <div class="ava-step-track">
                <div class="ava-step-fill" style="width:${slidePct}%"></div>
              </div>
              <span class="pill ${isLessonDone ? "pill-cached" : ""}" style="font-size:11px">
                ${isLessonDone ? "✓ Concluída" : "Em estudo"}
              </span>
            </div>
          </div>

          <!-- Card do Slide -->
          <div class="slide-card">
            <div class="slide-inner">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
                <span class="pill pill-cached">
                  Etapa ${state.activeSlideIdx + 1} de ${slides.length}
                </span>
                ${
                  slides.length > 1
                    ? `<div style="display:flex;gap:4px;flex-wrap:wrap">
                        ${slides
                          .map(
                            (_, sIdx) => `
                              <button
                                type="button"
                                data-jump-slide="${sIdx}"
                                aria-label="Ir para etapa ${sIdx + 1}"
                                style="width:28px;height:28px;border-radius:8px;border:1px solid ${
                                  sIdx === state.activeSlideIdx ? "var(--primary)" : "var(--border)"
                                };background:${
                                  sIdx === state.activeSlideIdx ? "var(--primary)" : "var(--surface-950)"
                                };color:${
                                  sIdx === state.activeSlideIdx ? "#0f0f0f" : "var(--muted-foreground)"
                                };font-size:11px;font-weight:800;cursor:pointer"
                              >${sIdx + 1}</button>
                            `
                          )
                          .join("")}
                      </div>`
                    : ""
                }
              </div>

              <h1 style="margin:0 0 14px;font-size:22px;font-weight:800;line-height:1.3">
                ${escapeHtml(slide.title || lesson.title)}
              </h1>

              <div class="slide-content">
                ${markdownToHtml(slide.content)}
              </div>

              ${questionBlockHtml}
            </div>
          </div>

          <!-- Barra Inferior de Navegação -->
          <div class="ava-bottom-bar">
            <button
              type="button"
              class="btn"
              id="btnPrevSlide"
              ${state.activeSlideIdx === 0 && state.activeLessonIdx === 0 ? "disabled" : ""}
            >
              ← Anterior
            </button>

            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
              ${
                state.activeSlideIdx < slides.length - 1
                  ? `<button type="button" class="btn btn-primary" id="btnNextSlide">Próximo →</button>`
                  : `<button type="button" class="btn btn-primary" id="btnCompleteLesson">
                      ${
                        state.activeLessonIdx < lessons.length - 1
                          ? "✅ Concluir e Próxima Aula →"
                          : "🏆 Concluir Curso!"
                      }
                    </button>`
              }
            </div>
          </div>

          <!-- Tutor IA de Dúvidas da Aula -->
          <div class="tutor-panel">
            <div class="tutor-header">
              <div>
                <strong style="font-size:14px">🤖 Tutor de Dúvidas da Aula</strong>
                <div style="font-size:12px;color:var(--muted-foreground)">
                  Tire dúvidas sobre <em>${escapeHtml(lesson.title)}</em> (funciona online e offline)
                </div>
              </div>
              <span class="pill ${isEffectiveOnline() ? "pill-online" : "pill-offline"}">
                ${isEffectiveOnline() ? "● Online" : "⚡ Modo Local Offline"}
              </span>
            </div>

            <div class="tutor-messages" id="tutorMessagesBox">
              ${state.tutorMessages
                .map(
                  (m) => `
                    <div class="msg ${m.role === "user" ? "msg-user" : "msg-ai"}">
                      <div>${markdownToHtml(m.text)}</div>
                      ${
                        m.meta
                          ? `<div style="margin-top:6px;font-size:11px;color:var(--muted-foreground);font-weight:600">⚙️ ${escapeHtml(m.meta)}</div>`
                          : ""
                      }
                    </div>
                  `
                )
                .join("")}
            </div>

            <form class="tutor-input-row" id="tutorForm">
              <input
                type="text"
                id="tutorQuestionInput"
                class="input"
                placeholder="Ex.: Resuma os pontos principais desta aula..."
                ${state.tutorLoading ? "disabled" : ""}
              />
              <button type="submit" class="btn btn-primary" ${state.tutorLoading ? "disabled" : ""}>
                ${state.tutorLoading ? "Respondendo..." : "Perguntar"}
              </button>
            </form>
          </div>
        </div>
      </div>
    `;

    const backDash = document.getElementById("btnBackToCourseDash");
    if (backDash) backDash.onclick = () => openCourseDashboard(pkg.slug);

    const mobileBackDash = document.getElementById("btnMobileBackDash");
    if (mobileBackDash) mobileBackDash.onclick = () => openCourseDashboard(pkg.slug);

    const backCat = document.getElementById("btnBackToCatalog");
    if (backCat) {
      backCat.onclick = () => {
        state.view = "catalog";
        render();
      };
    }

    root.querySelectorAll("[data-lesson-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-lesson-idx")) || 0;
        resumeCourseStudy(pkg.slug, idx, 0);
      });
    });

    root.querySelectorAll("[data-jump-slide]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sIdx = Number(btn.getAttribute("data-jump-slide")) || 0;
        state.activeSlideIdx = sIdx;
        state.selectedOption = null;
        state.questionResult = null;
        saveLastActive(pkg.slug, state.activeLessonIdx, sIdx);
        saveSlideCheckpoint(pkg.course.id, lesson.id, sIdx);
        render();
      });
    });

    root.querySelectorAll("[data-option]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.questionResult && state.questionResult.correct) return;
        state.selectedOption = btn.getAttribute("data-option");
        state.questionResult = null;
        render();
      });
    });

    const verifyBtn = document.getElementById("btnVerifyAnswer");
    if (verifyBtn && slide.question) {
      verifyBtn.onclick = () => {
        const correct = state.selectedOption === slide.question.correctAnswer;
        state.questionResult = { correct };
        render();
      };
    }

    const prevBtn = document.getElementById("btnPrevSlide");
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (state.activeSlideIdx > 0) {
          state.activeSlideIdx--;
        } else if (state.activeLessonIdx > 0) {
          state.activeLessonIdx--;
          const prevLesson = lessons[state.activeLessonIdx];
          state.activeSlideIdx = Math.max(0, ((prevLesson && prevLesson.slides) || []).length - 1);
        }
        state.selectedOption = null;
        state.questionResult = null;
        saveLastActive(pkg.slug, state.activeLessonIdx, state.activeSlideIdx);
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
    }

    const nextBtn = document.getElementById("btnNextSlide");
    if (nextBtn) {
      nextBtn.onclick = () => {
        state.activeSlideIdx++;
        state.selectedOption = null;
        state.questionResult = null;
        saveLastActive(pkg.slug, state.activeLessonIdx, state.activeSlideIdx);
        saveSlideCheckpoint(pkg.course.id, lesson.id, state.activeSlideIdx);
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
    }

    const completeBtn = document.getElementById("btnCompleteLesson");
    if (completeBtn) {
      completeBtn.onclick = async () => {
        const score = state.questionResult ? (state.questionResult.correct ? 100 : 70) : 100;
        await markLessonCompleted(pkg.course.id, lesson.id, score, state.activeSlideIdx);
        if (state.activeLessonIdx < lessons.length - 1) {
          state.activeLessonIdx++;
          state.activeSlideIdx = 0;
          state.selectedOption = null;
          state.questionResult = null;
          saveLastActive(pkg.slug, state.activeLessonIdx, 0);
          render();
          window.scrollTo({ top: 0, behavior: "smooth" });
        } else {
          showToast("🎉 Parabéns! Você concluiu todas as aulas deste curso!");
          openCourseDashboard(pkg.slug);
        }
      };
    }

    const tutorForm = document.getElementById("tutorForm");
    if (tutorForm) {
      tutorForm.onsubmit = (e) => {
        e.preventDefault();
        const input = document.getElementById("tutorQuestionInput");
        if (input && input.value.trim()) {
          askTutor(input.value.trim());
        }
      };
    }
  }

  function render() {
    updateTopbarStatus();
    renderDrawerLessons();
    renderAuthModal();

    const root = document.getElementById("appRoot");
    if (!root) return;

    if (state.view === "player") {
      renderPlayerView(root);
    } else if (state.view === "course-dashboard") {
      renderCourseDashboardView(root);
    } else if (state.view === "curation") {
      renderCurationView(root);
    } else {
      renderCatalogView(root);
    }
  }

  function bindGlobalEvents() {
    const btnMobileMenu = document.getElementById("btnMobileMenu");
    if (btnMobileMenu) {
      btnMobileMenu.addEventListener("click", () => {
        const drawer = document.getElementById("mobileDrawer");
        if (drawer && drawer.classList.contains("open")) closeMobileDrawer();
        else openMobileDrawer();
      });
    }

    const btnCloseDrawer = document.getElementById("btnCloseDrawer");
    if (btnCloseDrawer) btnCloseDrawer.addEventListener("click", closeMobileDrawer);

    const overlay = document.getElementById("drawerOverlay");
    if (overlay) overlay.addEventListener("click", closeMobileDrawer);

    const btnCloseAuth = document.getElementById("btnCloseAuthModal");
    if (btnCloseAuth) btnCloseAuth.addEventListener("click", closeAuthModal);

    const authOverlay = document.getElementById("authModalOverlay");
    if (authOverlay) {
      authOverlay.addEventListener("click", (e) => {
        if (e.target === authOverlay) closeAuthModal();
      });
    }

    const btnAuthHeader = document.getElementById("btnAuthHeader");
    if (btnAuthHeader) {
      btnAuthHeader.addEventListener("click", () => openAuthModal());
    }

    const brandHome = document.getElementById("brandHomeLink");
    if (brandHome) {
      brandHome.addEventListener("click", (e) => {
        e.preventDefault();
        state.view = "catalog";
        closeMobileDrawer();
        render();
      });
    }

    const btnTheme = document.getElementById("btnThemeToggle");
    if (btnTheme) {
      btnTheme.addEventListener("click", () => {
        applyTheme(state.theme === "dark" ? "light" : "dark");
      });
    }

    const navCatalog = document.getElementById("navCatalogBtn");
    if (navCatalog) {
      navCatalog.addEventListener("click", () => {
        state.view = "catalog";
        closeMobileDrawer();
        render();
      });
    }

    const navDown = document.getElementById("navDownloadedBtn");
    if (navDown) {
      navDown.addEventListener("click", () => {
        state.view = "downloaded";
        closeMobileDrawer();
        render();
      });
    }

    const navAdminCuration = document.getElementById("navAdminCurationBtn");
    if (navAdminCuration) {
      navAdminCuration.addEventListener("click", () => {
        state.view = "curation";
        closeMobileDrawer();
        fetchCurationCatalog();
        render();
      });
    }

    const navImport = document.getElementById("navImportBtn");
    const fileInput = document.getElementById("fileImportInput");
    if (navImport && fileInput) {
      navImport.addEventListener("click", () => {
        closeMobileDrawer();
        fileInput.click();
      });
      fileInput.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) importPackageFromFile(f);
        fileInput.value = "";
      });
    }

    const navSim = document.getElementById("navSimOfflineBtn");
    if (navSim) {
      navSim.addEventListener("click", () => {
        state.simulatedOffline = !state.simulatedOffline;
        closeMobileDrawer();
        showToast(
          state.simulatedOffline
            ? "✈️ Modo Sem Internet ativado! Estude suas aulas salvas no aparelho."
            : "🌐 Conexão restabelecida! Sincronizando progresso com o MyLMS..."
        );
        render();
        if (!state.simulatedOffline) syncPendingEvents(true);
      });
    }

    const btnSync = document.getElementById("btnSyncNow");
    if (btnSync) {
      btnSync.addEventListener("click", () => syncPendingEvents(false));
    }

    window.addEventListener("online", () => {
      updateTopbarStatus();
      syncPendingEvents(true);
    });

    window.addEventListener("offline", () => {
      updateTopbarStatus();
    });

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      const btn = document.getElementById("btnInstallPwa");
      if (btn) {
        btn.style.display = "inline-flex";
        btn.onclick = async () => {
          if (!state.deferredInstallPrompt) return;
          state.deferredInstallPrompt.prompt();
          await state.deferredInstallPrompt.userChoice;
          state.deferredInstallPrompt = null;
          btn.style.display = "none";
        };
      }
    });
  }

  async function init() {
    applyTheme(state.theme);
    bindGlobalEvents();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    await loadLocalState();
    render();

    await checkActiveSession();
    await fetchCatalogFromApi();

    const params = new URLSearchParams(window.location.search);
    const wantedCourse = params.get("course");
    if (wantedCourse) {
      if (state.packagesMap[wantedCourse]) {
        openCourseDashboard(wantedCourse);
      } else if (state.user && isEffectiveOnline()) {
        await downloadCoursePackage(wantedCourse, false);
        if (state.packagesMap[wantedCourse]) {
          openCourseDashboard(wantedCourse);
        }
      } else {
        openAuthModal({ type: "download", slug: wantedCourse, includeVideo: false });
      }
    }
  }

  init();
})();
