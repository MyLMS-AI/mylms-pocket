(function () {
  const DB_NAME = "mylms_pocket_db";
  const DB_VERSION = 1;
  const MEDIA_CACHE = "mylms-pocket-media-v1";

  const state = {
    view: "catalog",
    theme: localStorage.getItem("mylms_pocket_theme_v2") || "light",
    simulatedOffline: false,
    onlineCourses: [],
    downloadedPackages: [],
    syncQueue: [],
    activePkg: null,
    activeLessonId: null,
    activeSlideIndex: 0,
    selectedOptions: [],
    questionResult: null,
    flashcardFlipped: false,
    tutorMessages: [],
    tutorLoading: false,
    studentEmail: localStorage.getItem("mylms_pocket_email") || "andre@glededu.com",
    downloadingSlug: null,
    downloadProgress: 0,
  };

  function applyTheme() {
    const html = document.documentElement;
    if (state.theme === "light") {
      html.classList.remove("dark");
    } else {
      html.classList.add("dark");
    }
    const btn = document.getElementById("btnThemeToggle");
    if (btn) {
      btn.textContent = state.theme === "dark" ? "☀️" : "🌙";
    }
  }

  function isEffectivelyOnline() {
    return navigator.onLine && !state.simulatedOffline;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("packages")) {
          db.createObjectStore("packages", { keyPath: "slug" });
        }
        if (!db.objectStoreNames.contains("sync_queue")) {
          db.createObjectStore("sync_queue", { keyPath: "eventId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPut(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbDelete(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function refreshLocalState() {
    state.downloadedPackages = await dbGetAll("packages");
    state.syncQueue = await dbGetAll("sync_queue");
    updateHeaderUi();
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "220 KB";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function render10Segments(percent) {
    const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
    let segs = "";
    for (let i = 0; i < 10; i++) {
      const threshold = ((i + 1) / 10) * 100;
      const done = p >= threshold;
      segs += `<span class="mylms-seg ${done ? "done" : ""}"></span>`;
    }
    return `<div class="mylms-segments">${segs}</div>`;
  }

  function renderMarkdown(md) {
    if (!md) return "";
    let html = escapeHtml(md);
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" style="color:var(--primary);font-weight:700">$1</a>');
    html = html.replace(/^### (.*)$/gm, '<h3 style="margin:14px 0 6px;font-size:17px">$1</h3>');
    html = html.replace(/^## (.*)$/gm, '<h2 style="margin:16px 0 8px;color:var(--primary);font-size:19px">$1</h2>');
    html = html.replace(/^# (.*)$/gm, '<h1 style="margin:16px 0 10px;font-size:21px">$1</h1>');
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/`([^`]+)`/g, '<code style="background:var(--surface-950);padding:2px 6px;border-radius:5px;font-size:13px">$1</code>');
    html = html.replace(/\n\n+/g, "</p><p style='margin:0 0 12px'>");
    html = html.replace(/\n/g, "<br/>");
    return `<p style="margin:0 0 12px">${html}</p>`;
  }

  async function enqueueSyncEvent(ev) {
    const item = {
      eventId: `${ev.type}_${ev.lessonId || ""}_${ev.questionId || ""}_${Date.now()}`,
      clientTimestamp: new Date().toISOString(),
      ...ev,
    };
    await dbPut("sync_queue", item);
    state.syncQueue = await dbGetAll("sync_queue");
    updateHeaderUi();
    if (isEffectivelyOnline()) {
      syncNow(true);
    }
  }

  async function syncNow(silent = false) {
    const queue = await dbGetAll("sync_queue");
    if (queue.length === 0) {
      if (!silent) alert("✅ Fila sincronizada! Nenhum evento pendente no aparelho.");
      return;
    }
    if (!isEffectivelyOnline()) {
      if (!silent) alert("✈️ Você está em Modo Offline. Seus eventos estão salvos no IndexedDB e serão sincronizados automaticamente assim que a internet voltar!");
      return;
    }
    try {
      const res = await fetch("/api/offline/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: state.studentEmail,
          events: queue,
        }),
      });
      if (!res.ok) throw new Error("Status " + res.status);
      const data = await res.json();
      for (const r of data.results || []) {
        if (r.status === "synced" || r.status === "skipped") {
          await dbDelete("sync_queue", r.eventId);
        }
      }
      state.syncQueue = await dbGetAll("sync_queue");
      updateHeaderUi();
      if (!silent) {
        alert(`🚀 Sincronização concluída! ${data.syncedCount || queue.length} eventos gravados no banco-mãe do MyLMS.`);
      }
      render();
    } catch (err) {
      if (!silent) {
        alert("⚠️ Não foi possível contatar o servidor agora. Seus dados continuam seguros no IndexedDB.");
      }
    }
  }

  async function fetchOnlineCatalog() {
    if (!isEffectivelyOnline()) return;
    try {
      const res = await fetch("/api/offline/courses");
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) {
          state.onlineCourses = list;
          render();
        }
      }
    } catch {}
  }

  async function downloadCoursePackage(slug, includeVideo = false) {
    state.downloadingSlug = slug;
    state.downloadProgress = 15;
    render();
    try {
      const res = await fetch(`/api/offline/courses/${encodeURIComponent(slug)}/package?email=${encodeURIComponent(state.studentEmail)}`);
      if (!res.ok) throw new Error("Falha ao baixar pacote (" + res.status + ")");
      const bundle = await res.json();
      state.downloadProgress = 55;
      render();

      const assets = [
        ...((bundle.mediaManifest && bundle.mediaManifest.coreAssets) || []),
        ...(includeVideo ? (bundle.mediaManifest && bundle.mediaManifest.videoAssets) || [] : []),
      ];

      if ("caches" in window && assets.length > 0) {
        const cache = await caches.open(MEDIA_CACHE);
        let done = 0;
        for (const asset of assets.slice(0, 35)) {
          try {
            await cache.add(new Request(asset.url, { mode: "no-cors" }));
          } catch {}
          done++;
          state.downloadProgress = 55 + Math.round((done / Math.min(assets.length, 35)) * 40);
          render();
        }
      }

      const record = {
        slug: bundle.course.slug,
        courseId: bundle.course.id,
        downloadedAt: new Date().toISOString(),
        includeVideo,
        bundle,
        localProgress: {
          completedLessonIds: (bundle.userProgressSnapshot && bundle.userProgressSnapshot.completedLessonIds) || [],
          answeredQuestions: (bundle.userProgressSnapshot && bundle.userProgressSnapshot.answeredQuestionsMap) || {},
        },
      };

      await dbPut("packages", record);
      await refreshLocalState();
      state.downloadingSlug = null;
      state.downloadProgress = 0;
      openCoursePlayer(record.slug);
    } catch (err) {
      state.downloadingSlug = null;
      state.downloadProgress = 0;
      alert("Erro ao baixar pacote: " + (err.message || err));
      render();
    }
  }

  function openCoursePlayer(slug) {
    const pkg = state.downloadedPackages.find((p) => p.slug === slug);
    if (!pkg) return;
    state.activePkg = pkg;
    const firstMod = pkg.bundle.modules[0];
    const firstLesson = firstMod && firstMod.lessons[0];
    state.activeLessonId = firstLesson ? firstLesson.id : null;
    state.activeSlideIndex = 0;
    state.selectedOptions = [];
    state.questionResult = null;
    state.flashcardFlipped = false;
    state.view = "player";
    if (firstLesson) {
      enqueueSyncEvent({
        type: "LESSON_START",
        courseId: pkg.courseId,
        lessonId: firstLesson.id,
      });
    }
    render();
  }

  function getActiveLessonAndSlide() {
    if (!state.activePkg) return { lesson: null, slide: null, slides: [] };
    for (const mod of state.activePkg.bundle.modules || []) {
      for (const les of mod.lessons || []) {
        if (les.id === state.activeLessonId) {
          const slides = les.slides || [];
          return {
            lesson: les,
            slides,
            slide: slides[state.activeSlideIndex] || null,
          };
        }
      }
    }
    return { lesson: null, slide: null, slides: [] };
  }

  async function validateOfflineQuestion(question) {
    if (!question || state.selectedOptions.length === 0) return;
    const correctList = (question.correctAnswers || []).map((a) => String(a).trim().toLowerCase());
    const selectedList = state.selectedOptions.map((a) => String(a).trim().toLowerCase());

    let isCorrect = false;
    if (correctList.length > 0) {
      isCorrect =
        selectedList.length === correctList.length &&
        selectedList.every((s) => correctList.includes(s));
    } else {
      isCorrect = state.selectedOptions.length > 0;
    }

    const points = isCorrect ? 10 : 0;
    state.questionResult = {
      isCorrect,
      correctAnswers: question.correctAnswers || [],
      points,
    };

    if (state.activePkg) {
      state.activePkg.localProgress.answeredQuestions[question.id] = {
        completed: isCorrect,
        points,
        selectedAnswers: state.selectedOptions,
      };
      await dbPut("packages", state.activePkg);
      await enqueueSyncEvent({
        type: "QUESTION_ANSWER",
        courseId: state.activePkg.courseId,
        lessonId: state.activeLessonId,
        questionId: question.id,
        selectedAnswers: state.selectedOptions,
        isCorrect,
        points,
      });
    }
    render();
  }

  async function completeCurrentLesson() {
    const { lesson } = getActiveLessonAndSlide();
    if (!lesson || !state.activePkg) return;
    const doneSet = new Set(state.activePkg.localProgress.completedLessonIds || []);
    doneSet.add(lesson.id);
    state.activePkg.localProgress.completedLessonIds = Array.from(doneSet);
    await dbPut("packages", state.activePkg);
    await enqueueSyncEvent({
      type: "LESSON_COMPLETE",
      courseId: state.activePkg.courseId,
      lessonId: lesson.id,
      timeSpentSeconds: 120,
    });
    render();
  }

  async function askTutor(questionText) {
    if (!questionText.trim()) return;
    const { lesson, slide } = getActiveLessonAndSlide();
    state.tutorMessages.push({ role: "user", content: questionText });
    state.tutorLoading = true;
    render();

    const slideText = [
      slide && slide.title ? slide.title : "",
      slide && slide.markdown ? slide.markdown : "",
      slide && slide.question ? slide.question.statement : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (isEffectivelyOnline()) {
      try {
        const res = await fetch("/api/offline/tutor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            courseTitle: state.activePkg ? state.activePkg.bundle.course.title : "",
            lessonTitle: lesson ? lesson.title : "",
            slideTitle: slide ? slide.title : "",
            slideContent: slideText,
            question: questionText,
            history: state.tutorMessages.slice(-6),
          }),
        });
        if (res.ok) {
          const data = await res.json();
          state.tutorMessages.push({
            role: "assistant",
            content: data.answer,
            meta: `${data.model} • ${data.parameterScale}`,
          });
          state.tutorLoading = false;
          render();
          return;
        }
      } catch {}
    }

    const cleanSnippet = slideText.replace(/[#*`>_~-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 360);
    state.tutorMessages.push({
      role: "assistant",
      content: cleanSnippet
        ? `📴 **[Modo Offline Local ≤10B]** Baseado no pacote baixado deste slide:\n\n"${cleanSnippet}..."\n\n💡 Foque nos conceitos-chave acima para responder à questão sobre *"${questionText}"*.`
        : `📴 **[Modo Offline Local ≤10B]** Revise o enunciado do slide atual e verifique as alternativas destacadas no pacote local!`,
      meta: "On-Device Pedagogical Engine (Zero Frontier Dependency)",
    });
    state.tutorLoading = false;
    render();
  }

  function updateHeaderUi() {
    const pill = document.getElementById("netStatusPill");
    if (pill) {
      const online = isEffectivelyOnline();
      pill.className = "pill " + (online ? "pill-online" : "pill-offline");
      pill.textContent = online
        ? "● Online"
        : state.simulatedOffline
        ? "✈️ Modo Avião"
        : "📴 Offline";
    }
    const qCount = document.getElementById("syncQueueCount");
    if (qCount) {
      qCount.textContent = String(state.syncQueue.length);
    }
    const simBtn = document.getElementById("navSimOfflineBtn");
    if (simBtn) {
      simBtn.textContent = state.simulatedOffline
        ? "🌐 Desativar Modo Avião Simulado"
        : "✈️ Simular Modo Avião (Teste Offline)";
    }
  }

  function renderCatalog() {
    const downloadedMap = new Map(state.downloadedPackages.map((p) => [p.slug, p]));
    const allCourses = [...state.onlineCourses];
    for (const pkg of state.downloadedPackages) {
      if (!allCourses.some((c) => c.slug === pkg.slug)) {
        allCourses.unshift({
          id: pkg.courseId,
          slug: pkg.slug,
          title: pkg.bundle.course.title,
          description: pkg.bundle.course.description,
          image: pkg.bundle.course.image,
          stats: pkg.bundle.stats,
        });
      }
    }

    const cardsHtml = allCourses
      .map((c) => {
        const localPkg = downloadedMap.get(c.slug);
        const totalLessons = (c.stats && c.stats.lessonsCount) || 0;
        const doneLessons = localPkg ? (localPkg.localProgress.completedLessonIds || []).length : 0;
        const pct = totalLessons > 0 ? Math.min(100, Math.round((doneLessons / totalLessons) * 100)) : 0;
        const isDownloading = state.downloadingSlug === c.slug;
        const coverImg = c.image || "/bg-hero-dark.png";

        return `
          <article class="course-card">
            <div class="course-cover">
              <img src="${escapeHtml(coverImg)}" alt="${escapeHtml(c.title)}" loading="lazy" onerror="this.src='/bg-hero-dark.png'" />
              <div class="course-cover-overlay"></div>
              <div class="course-cover-badges">
                <span class="badge-status ${localPkg ? "badge-downloaded" : "badge-cloud"}">
                  ${localPkg ? "✓ Baixado no Aparelho" : "☁️ Pacote Disponível"}
                </span>
                <span class="badge-size">
                  📦 ${formatBytes(c.stats && c.stats.estimatedSizeNoVideoBytes)}
                </span>
              </div>
              <div class="course-cover-title">
                <span>CURSO • MYLMS POCKET</span>
                <h3>${escapeHtml(c.title)}</h3>
              </div>
            </div>

            <div class="course-body">
              <div>
                <p class="course-desc">
                  ${escapeHtml(c.description || "Curso interativo com slides, questões corrigidas localmente no aparelho e sincronização inteligente.")}
                </p>
                <div class="course-meta" style="margin-top:8px">
                  <span>📚 ${(c.stats && c.stats.modulesCount) || 1} mód.</span>
                  <span>•</span>
                  <span>🎯 ${totalLessons} aulas</span>
                  <span>•</span>
                  <span>📑 ${(c.stats && c.stats.slidesCount) || 0} slides</span>
                </div>
              </div>

              <div>
                <div class="mylms-seg-row">
                  <span class="mylms-seg-label">${pct}% concluído</span>
                  ${render10Segments(pct)}
                </div>

                ${
                  isDownloading
                    ? `
                      <div style="margin-top:10px">
                        <div style="font-size:12px;color:var(--primary);font-weight:700;margin-bottom:4px">
                          Salvando no IndexedDB... ${state.downloadProgress}%
                        </div>
                        ${render10Segments(state.downloadProgress)}
                      </div>
                    `
                    : `
                      <div style="display:flex;gap:8px;margin-top:12px">
                        ${
                          localPkg
                            ? `
                              <button type="button" class="btn btn-primary" style="flex:1" data-action="open-course" data-slug="${escapeHtml(c.slug)}">
                                ▶ Continuar Estudo
                              </button>
                              <button type="button" class="btn" title="Atualizar pacote" data-action="download-course" data-slug="${escapeHtml(c.slug)}">
                                🔄
                              </button>
                            `
                            : `
                              <button type="button" class="btn btn-primary" style="flex:1" data-action="download-course" data-slug="${escapeHtml(c.slug)}">
                                ⬇ Baixar Pacote (${formatBytes(c.stats && c.stats.estimatedSizeNoVideoBytes)})
                              </button>
                            `
                        }
                      </div>
                    `
                }
              </div>
            </div>
          </article>
        `;
      })
      .join("");

    return `
      <section class="mylms-hero">
        <img src="/bg-hero-dark.png" alt="" class="mylms-hero-bg" />
        <div class="mylms-hero-gradient"></div>
        <div class="mylms-hero-content">
          <div class="mylms-hero-kicker">
            <span>📚 CONTINUE DE ONDE PAROU • MODO OFFLINE</span>
          </div>
          <h1>Estude seus cursos do MyLMS em qualquer lugar, mesmo sem internet</h1>
          <p>
            Baixe o pacote leve do curso quando tiver conexão, responda às atividades com <strong>correção instantânea no seu aparelho</strong> e sincronize automaticamente com a plataforma principal.
          </p>
          <div class="badge-row">
            <span class="tag">⚡ PWA Offline-First (IndexedDB)</span>
            <span class="tag">🧠 Tutor IA Open-Source ≤10B</span>
            <span class="tag">🔓 Open-Source (MIT)</span>
          </div>
        </div>
        <div class="mylms-hero-actions">
          <button type="button" class="btn btn-primary" data-action="toggle-sim-offline">
            ${state.simulatedOffline ? "🌐 Voltar para Modo Online" : "✈️ Testar em Modo Avião"}
          </button>
          <button type="button" class="btn" data-action="import-json">
            📂 Importar Pacote (.json)
          </button>
        </div>
      </section>

      <div class="section-bar">
        <h2>
          <span style="color:var(--primary)">▍</span> Meus Cursos (${allCourses.length}) • Baixados no Aparelho (${state.downloadedPackages.length})
        </h2>
        <span style="font-size:12px;color:var(--muted-foreground)">
          Aluno: <strong style="color:var(--foreground)">${escapeHtml(state.studentEmail)}</strong>
        </span>
      </div>

      <div class="grid-courses">
        ${cardsHtml || '<div class="course-card"><div class="course-body"><p class="course-desc">Carregando catálogo de cursos do MyLMS...</p></div></div>'}
      </div>
    `;
  }

  function renderPlayer() {
    const pkg = state.activePkg;
    if (!pkg) return renderCatalog();
    const { lesson, slide, slides } = getActiveLessonAndSlide();
    const doneIds = new Set(pkg.localProgress.completedLessonIds || []);
    const slidePercent =
      slides.length > 1 ? Math.round((state.activeSlideIndex / (slides.length - 1)) * 100) : 100;

    const sidebarModulesHtml = (pkg.bundle.modules || [])
      .map(
        (m, mIdx) => `
          <div style="margin-bottom:12px">
            <div class="module-title">
              Módulo ${mIdx + 1}: ${escapeHtml(m.title)}
            </div>
            ${(m.lessons || [])
              .map((l) => {
                const isDone = doneIds.has(l.id);
                const isActive = l.id === state.activeLessonId;
                return `
                  <button
                    type="button"
                    class="lesson-btn ${isActive ? "active" : ""}"
                    data-action="select-lesson"
                    data-lesson="${escapeHtml(l.id)}"
                  >
                    <span class="lesson-icon-box ${isDone ? "done" : ""}">
                      ${isDone ? "✓" : "📖"}
                    </span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                      ${escapeHtml(l.title)}
                    </span>
                    <span style="font-size:11px;color:var(--muted-foreground)">${(l.slides || []).length}s</span>
                  </button>
                `;
              })
              .join("")}
          </div>
        `
      )
      .join("");

    let slideBodyHtml = "";
    if (!slide) {
      slideBodyHtml = `<p style="color:var(--muted-foreground)">Esta aula não possui slides cadastrados.</p>`;
    } else if (slide.question) {
      const q = slide.question;
      const options = Array.isArray(q.possibleAnswers) ? q.possibleAnswers : [];
      slideBodyHtml = `
        <div style="margin-bottom:16px">
          <span class="tag" style="margin-bottom:10px;display:inline-block">
            ❓ Questão Objetiva • Correção Local Offline
          </span>
          <div class="slide-content">${renderMarkdown(q.statement || slide.markdown || slide.title)}</div>
        </div>
        <div>
          ${options
            .map((opt, idx) => {
              const optStr = String(opt);
              const isSelected = state.selectedOptions.includes(optStr);
              let cls = "option-btn";
              if (state.questionResult) {
                const isRight = (state.questionResult.correctAnswers || [])
                  .map((a) => String(a).trim().toLowerCase())
                  .includes(optStr.trim().toLowerCase());
                if (isRight) cls += " correct";
                else if (isSelected) cls += " wrong";
              } else if (isSelected) {
                cls += " selected";
              }
              return `
                <button
                  type="button"
                  class="${cls}"
                  data-action="toggle-option"
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
              <div class="feedback-box ${state.questionResult.isCorrect ? "feedback-ok" : "feedback-err"}">
                <strong>
                  ${
                    state.questionResult.isCorrect
                      ? "✓ Resposta Correta! (+10 pts registrados na fila de sincronização)."
                      : "✕ Resposta Incorreta. Confira o gabarito abaixo:"
                  }
                </strong>
                ${
                  !state.questionResult.isCorrect && state.questionResult.correctAnswers.length
                    ? `<div style="margin-top:6px">Gabarito: <strong>${escapeHtml(state.questionResult.correctAnswers.join(", "))}</strong></div>`
                    : ""
                }
              </div>
            `
            : ""
        }
      `;
    } else if (slide.flashcardFront || slide.flashcardBack) {
      slideBodyHtml = `
        <div style="text-align:center;padding:28px 18px;background:var(--surface-950);border:1px solid var(--border);border-radius:16px">
          <div style="font-size:11px;color:var(--primary);margin-bottom:8px;font-weight:800">
            🃏 FLASHCARD INTERATIVO (${state.flashcardFlipped ? "VERSO" : "FRENTE"})
          </div>
          <div style="font-size:18px;font-weight:700;margin-bottom:18px">
            ${escapeHtml(state.flashcardFlipped ? slide.flashcardBack : slide.flashcardFront)}
          </div>
          <button type="button" class="btn btn-primary" data-action="flip-flashcard">
            🔄 Virar Cartão
          </button>
        </div>
      `;
    } else {
      slideBodyHtml = `
        <div class="slide-content">
          ${renderMarkdown(slide.markdown || slide.title || "Conteúdo da aula")}
        </div>
      `;
    }

    const isQuestionSlide = Boolean(slide && slide.question);
    const needVerifyQuestion = isQuestionSlide && !state.questionResult;

    return `
      <!-- Header do AVA idêntico ao ContentLesson do MyLMS -->
      <div class="ava-header-bar">
        <div style="display:flex;align-items:center;gap:12px;min-width:0">
          <button type="button" class="ava-exit-btn" data-action="back-catalog">
            <span class="ava-exit-icon">↖</span>
            <span>Sair da atividade</span>
          </button>
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${escapeHtml(pkg.bundle.course.title)}
            </div>
            <div style="font-size:11px;color:var(--muted-foreground)">
              ${escapeHtml(lesson ? lesson.title : "")}
            </div>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:10px">
          ${render10Segments(slidePercent)}
          <span style="font-size:13px;font-weight:800">${slidePercent}%</span>
        </div>

        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;font-weight:700;color:var(--primary);background:var(--surface-950);padding:6px 12px;border-radius:999px">
            Slide ${slides.length ? state.activeSlideIndex + 1 : 0}/${slides.length}
          </span>
        </div>
      </div>

      <div class="player-shell">
        <div class="ava-main-col">
          <!-- Container principal do slide com fundo dots.png igual ao MyLMS -->
          <section class="slide-card">
            <div class="slide-dots-bg"></div>
            <div class="slide-inner">
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:800">
                ${escapeHtml(slide ? slide.title : "Aula")}
              </h1>
              ${slideBodyHtml}
            </div>
          </section>

          <!-- Barra inferior do AVA (Anterior / Pular / Confirmar / Seguinte) -->
          <div class="ava-bottom-bar">
            <button
              type="button"
              class="btn btn-ghost-brand"
              data-action="prev-slide"
              ${state.activeSlideIndex <= 0 ? "disabled" : ""}
            >
              Anterior
            </button>

            <div style="display:flex;align-items:center;gap:10px">
              ${
                isQuestionSlide && state.activeSlideIndex < slides.length - 1
                  ? `
                    <button type="button" class="btn btn-ghost-brand" data-action="next-slide">
                      Pular
                    </button>
                  `
                  : ""
              }
              ${
                needVerifyQuestion
                  ? `
                    <button
                      type="button"
                      class="btn btn-primary"
                      data-action="check-answer"
                      ${state.selectedOptions.length === 0 ? "disabled" : ""}
                    >
                      Confirmar
                    </button>
                  `
                  : state.activeSlideIndex < slides.length - 1
                  ? `
                    <button type="button" class="btn btn-primary" data-action="next-slide">
                      Seguinte
                    </button>
                  `
                  : `
                    <button type="button" class="btn btn-primary" data-action="complete-lesson">
                      Concluir
                    </button>
                  `
              }
            </div>
          </div>

          <!-- Tutor IA Open-Source <=10B -->
          <div class="tutor-box">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
              <strong style="font-size:13px;color:var(--primary)">
                ✨ Copilot MyLMS Pocket • Tutor IA Open-Source (Llama-3.1-8B • ≤10B)
              </strong>
              <span style="font-size:11px;color:var(--muted-foreground)">Human-Scale AI • Offline Ready</span>
            </div>
            <div id="tutorHistory">
              ${state.tutorMessages
                .map(
                  (m) => `
                    <div class="chat-msg ${m.role === "user" ? "chat-user" : "chat-ai"}">
                      <div>${renderMarkdown(m.content)}</div>
                      ${m.meta ? `<div style="font-size:10px;color:var(--muted-foreground);margin-top:4px">${escapeHtml(m.meta)}</div>` : ""}
                    </div>
                  `
                )
                .join("")}
              ${state.tutorLoading ? `<div class="chat-msg chat-ai">⏳ Consultando Tutor SLM ≤10B...</div>` : ""}
            </div>
            <form id="tutorForm" style="display:flex;gap:8px;margin-top:8px">
              <input
                id="tutorInput"
                type="text"
                placeholder="Tire uma dúvida sobre este slide..."
                class="mylms-input"
                style="flex:1;min-width:0"
              />
              <button type="submit" class="btn btn-primary">Perguntar</button>
            </form>
          </div>
        </div>

        <!-- Sidebar Direita de Módulos e Aulas (Estilo LessonsAside do MyLMS) -->
        <aside class="sidebar-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <strong style="font-size:14px">Conteúdo do Curso</strong>
            <span style="font-size:11px;color:var(--primary);font-weight:700">Offline Ativo</span>
          </div>
          ${sidebarModulesHtml}
        </aside>
      </div>
    `;
  }

  function render() {
    applyTheme();
    updateHeaderUi();
    const root = document.getElementById("appRoot");
    if (!root) return;
    root.innerHTML = state.view === "player" ? renderPlayer() : renderCatalog();

    const tutorForm = document.getElementById("tutorForm");
    if (tutorForm) {
      tutorForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = document.getElementById("tutorInput");
        if (input && input.value.trim()) {
          askTutor(input.value.trim());
        }
      });
    }
  }

  function closeDrawer() {
    const drawer = document.getElementById("mobileDrawer");
    const overlay = document.getElementById("drawerOverlay");
    const btn = document.getElementById("btnMobileMenu");
    if (drawer) drawer.classList.remove("open");
    if (overlay) overlay.classList.remove("open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function openDrawer() {
    const drawer = document.getElementById("mobileDrawer");
    const overlay = document.getElementById("drawerOverlay");
    const btn = document.getElementById("btnMobileMenu");
    if (drawer) drawer.classList.add("open");
    if (overlay) overlay.classList.add("open");
    if (btn) btn.setAttribute("aria-expanded", "true");
  }

  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action");

    if (action === "download-course") {
      downloadCoursePackage(target.getAttribute("data-slug"), false);
    } else if (action === "open-course") {
      openCoursePlayer(target.getAttribute("data-slug"));
    } else if (action === "back-catalog") {
      state.view = "catalog";
      render();
    } else if (action === "select-lesson") {
      state.activeLessonId = target.getAttribute("data-lesson");
      state.activeSlideIndex = 0;
      state.selectedOptions = [];
      state.questionResult = null;
      state.flashcardFlipped = false;
      render();
    } else if (action === "prev-slide") {
      if (state.activeSlideIndex > 0) {
        state.activeSlideIndex--;
        state.selectedOptions = [];
        state.questionResult = null;
        state.flashcardFlipped = false;
        render();
      }
    } else if (action === "next-slide") {
      const { slides } = getActiveLessonAndSlide();
      if (state.activeSlideIndex < slides.length - 1) {
        state.activeSlideIndex++;
        state.selectedOptions = [];
        state.questionResult = null;
        state.flashcardFlipped = false;
        render();
      }
    } else if (action === "toggle-option") {
      const opt = target.getAttribute("data-option");
      const { slide } = getActiveLessonAndSlide();
      const qType = slide && slide.question ? slide.question.type : "";
      if (qType === "MULTIPLE_CHOICE" && (slide.question.correctAnswers || []).length > 1) {
        if (state.selectedOptions.includes(opt)) {
          state.selectedOptions = state.selectedOptions.filter((o) => o !== opt);
        } else {
          state.selectedOptions.push(opt);
        }
      } else {
        state.selectedOptions = [opt];
      }
      state.questionResult = null;
      render();
    } else if (action === "check-answer") {
      const { slide } = getActiveLessonAndSlide();
      if (slide && slide.question) {
        validateOfflineQuestion(slide.question);
      }
    } else if (action === "flip-flashcard") {
      state.flashcardFlipped = !state.flashcardFlipped;
      render();
    } else if (action === "complete-lesson") {
      completeCurrentLesson();
    } else if (action === "toggle-sim-offline") {
      state.simulatedOffline = !state.simulatedOffline;
      if (isEffectivelyOnline()) syncNow(true);
      render();
    } else if (action === "import-json") {
      const fileIn = document.getElementById("fileImportInput");
      if (fileIn) fileIn.click();
    }
  });

  window.addEventListener("DOMContentLoaded", async () => {
    applyTheme();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    let deferredPrompt = null;
    const installBtn = document.getElementById("btnInstallPwa");
    window.addEventListener("beforeinstallprompt", (ev) => {
      ev.preventDefault();
      deferredPrompt = ev;
      if (installBtn) installBtn.style.display = "inline-flex";
    });
    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          await deferredPrompt.userChoice;
          deferredPrompt = null;
          installBtn.style.display = "none";
        }
      });
    }

    document.getElementById("btnThemeToggle")?.addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      localStorage.setItem("mylms_pocket_theme_v2", state.theme);
      applyTheme();
    });

    document.getElementById("btnMobileMenu")?.addEventListener("click", () => {
      const drawer = document.getElementById("mobileDrawer");
      if (drawer && drawer.classList.contains("open")) closeDrawer();
      else openDrawer();
    });
    document.getElementById("btnCloseDrawer")?.addEventListener("click", closeDrawer);
    document.getElementById("drawerOverlay")?.addEventListener("click", closeDrawer);

    document.getElementById("navCatalogBtn")?.addEventListener("click", () => {
      state.view = "catalog";
      closeDrawer();
      render();
    });
    document.getElementById("navImportBtn")?.addEventListener("click", () => {
      closeDrawer();
      document.getElementById("fileImportInput")?.click();
    });
    document.getElementById("navSimOfflineBtn")?.addEventListener("click", () => {
      state.simulatedOffline = !state.simulatedOffline;
      closeDrawer();
      if (isEffectivelyOnline()) syncNow(true);
      render();
    });
    document.getElementById("btnSyncNow")?.addEventListener("click", () => syncNow(false));

    const emailIn = document.getElementById("studentEmailInput");
    if (emailIn) emailIn.value = state.studentEmail;
    document.getElementById("btnSaveEmail")?.addEventListener("click", () => {
      if (emailIn && emailIn.value.trim()) {
        state.studentEmail = emailIn.value.trim();
        localStorage.setItem("mylms_pocket_email", state.studentEmail);
        closeDrawer();
        render();
      }
    });

    document.getElementById("fileImportInput")?.addEventListener("change", async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const bundle = JSON.parse(text);
        if (!bundle.course || !bundle.modules) throw new Error("Formato de pacote inválido");
        const record = {
          slug: bundle.course.slug,
          courseId: bundle.course.id,
          downloadedAt: new Date().toISOString(),
          includeVideo: false,
          bundle,
          localProgress: {
            completedLessonIds: (bundle.userProgressSnapshot && bundle.userProgressSnapshot.completedLessonIds) || [],
            answeredQuestions: (bundle.userProgressSnapshot && bundle.userProgressSnapshot.answeredQuestionsMap) || {},
          },
        };
        await dbPut("packages", record);
        await refreshLocalState();
        openCoursePlayer(record.slug);
      } catch (err) {
        alert("Erro ao importar arquivo JSON: " + (err.message || err));
      }
    });

    window.addEventListener("online", () => {
      updateHeaderUi();
      syncNow(true);
    });
    window.addEventListener("offline", () => updateHeaderUi());

    await refreshLocalState();
    render();
    await fetchOnlineCatalog();

    const params = new URLSearchParams(window.location.search);
    const targetCourse = params.get("course");
    if (targetCourse) {
      const existing = state.downloadedPackages.find((p) => p.slug === targetCourse || p.courseId === targetCourse);
      if (existing) {
        openCoursePlayer(existing.slug);
      } else if (isEffectivelyOnline()) {
        downloadCoursePackage(targetCourse, false);
      }
    }
  });
})();
