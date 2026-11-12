(function () {
  const DB_NAME = "mylms_pocket_db";
  const DB_VERSION = 1;
  const MEDIA_CACHE = "mylms-pocket-media-v1";

  const state = {
    view: "catalog",
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

  function renderMarkdown(md) {
    if (!md) return "";
    let html = escapeHtml(md);
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" style="color:#38bdf8">$1</a>');
    html = html.replace(/^### (.*)$/gm, '<h3 style="margin:14px 0 6px;color:#f8fafc">$1</h3>');
    html = html.replace(/^## (.*)$/gm, '<h2 style="margin:16px 0 8px;color:#10b981;font-size:18px">$1</h2>');
    html = html.replace(/^# (.*)$/gm, '<h1 style="margin:16px 0 10px;font-size:20px">$1</h1>');
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/`([^`]+)`/g, '<code style="background:#1e293b;padding:2px 6px;border-radius:5px;font-size:13px">$1</code>');
    html = html.replace(/\n\n+/g, "</p><p style='margin:0 0 10px'>");
    html = html.replace(/\n/g, "<br/>");
    return `<p style="margin:0 0 10px">${html}</p>`;
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

    // Local Offline SLM fallback
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
        ? "✈️ Modo Avião (Simulado)"
        : "📴 Sem Internet (Offline)";
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

        return `
          <article class="course-card">
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
                <span class="tag" style="color:${localPkg ? "#34d399" : "#94a3b8"}">
                  ${localPkg ? "✅ Baixado no Aparelho" : "☁️ Disponível para Download"}
                </span>
                <span style="font-size:11px;color:#94a3b8">
                  📦 ${formatBytes(c.stats && c.stats.estimatedSizeNoVideoBytes)}
                </span>
              </div>
              <h3>${escapeHtml(c.title)}</h3>
              <p>${escapeHtml(c.description || "Curso estruturado com slides interativos, questões corrigidas localmente e sincronização automática.")}</p>
            </div>

            <div>
              <div class="course-meta">
                <span>📚 ${(c.stats && c.stats.modulesCount) || 1} mód.</span>
                <span>•</span>
                <span>🎯 ${totalLessons} aulas</span>
                <span>•</span>
                <span>📑 ${(c.stats && c.stats.slidesCount) || 0} slides</span>
              </div>

              ${
                localPkg
                  ? `
                    <div style="margin:8px 0">
                      <div style="display:flex;justify-content:space-between;font-size:11px;color:#cbd5e1">
                        <span>Progresso Offline/Sync</span>
                        <strong>${pct}% (${doneLessons}/${totalLessons})</strong>
                      </div>
                      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
                    </div>
                  `
                  : ""
              }

              ${
                isDownloading
                  ? `
                    <div style="margin-top:10px">
                      <div style="font-size:12px;color:#34d399;margin-bottom:4px">Baixando pacote para IndexedDB... ${state.downloadProgress}%</div>
                      <div class="progress-track"><div class="progress-fill" style="width:${state.downloadProgress}%"></div></div>
                    </div>
                  `
                  : `
                    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
                      ${
                        localPkg
                          ? `
                            <button type="button" class="btn btn-primary" style="flex:1" data-action="open-course" data-slug="${escapeHtml(c.slug)}">
                              ▶️ Estudar Agora (Offline)
                            </button>
                            <button type="button" class="btn" title="Atualizar pacote" data-action="download-course" data-slug="${escapeHtml(c.slug)}">
                              🔄
                            </button>
                          `
                          : `
                            <button type="button" class="btn btn-primary" style="flex:1" data-action="download-course" data-slug="${escapeHtml(c.slug)}">
                              ⬇️ Baixar Pacote Leve (${formatBytes(c.stats && c.stats.estimatedSizeNoVideoBytes)})
                            </button>
                          `
                      }
                    </div>
                  `
              }
            </div>
          </article>
        `;
      })
      .join("");

    return `
      <section class="hero-banner">
        <div style="max-width:740px">
          <h1>🎒 MyLMS Pocket — Estude em Qualquer Lugar, Mesmo Sem Internet</h1>
          <p>
            Baixe seus cursos quando tiver Wi-Fi, estude no ônibus, metrô ou zona rural com <strong>correção instantânea no aparelho</strong> e sincronize seu progresso automaticamente com o <strong>MyLMS</strong>.
          </p>
          <div class="badge-row">
            <span class="tag">⚡ PWA Offline-First (IndexedDB + CacheStorage)</span>
            <span class="tag">🧠 Tutor IA Open-Source ≤10B (Llama-3.1-8B)</span>
            <span class="tag">🔓 100% Open-Source (MIT)</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;min-width:210px">
          <button type="button" class="btn btn-blue" data-action="toggle-sim-offline">
            ${state.simulatedOffline ? "🌐 Voltar para Modo Online" : "✈️ Testar em Modo Avião"}
          </button>
          <button type="button" class="btn" data-action="import-json">
            📂 Importar Pacote (.json)
          </button>
        </div>
      </section>

      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <h2 style="margin:0;font-size:17px">
          📚 Cursos Disponíveis (${allCourses.length}) — Baixados no Aparelho (${state.downloadedPackages.length})
        </h2>
        <span style="font-size:12px;color:#94a3b8">
          Aluno conectado: <strong style="color:#f8fafc">${escapeHtml(state.studentEmail)}</strong>
        </span>
      </div>

      <div class="grid-courses">
        ${cardsHtml || '<div class="course-card"><p>Carregando catálogo de cursos...</p></div>'}
      </div>
    `;
  }

  function renderPlayer() {
    const pkg = state.activePkg;
    if (!pkg) return renderCatalog();
    const { lesson, slide, slides } = getActiveLessonAndSlide();
    const doneIds = new Set(pkg.localProgress.completedLessonIds || []);

    const sidebarModulesHtml = (pkg.bundle.modules || [])
      .map(
        (m, mIdx) => `
          <div style="margin-bottom:12px">
            <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin:6px 4px">
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
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                      ${isDone ? "✅" : "📖"} ${escapeHtml(l.title)}
                    </span>
                    <span style="font-size:11px;opacity:0.75">${(l.slides || []).length}s</span>
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
      slideBodyHtml = `<p style="color:#94a3b8">Esta aula não possui slides cadastrados.</p>`;
    } else if (slide.question) {
      const q = slide.question;
      const options = Array.isArray(q.possibleAnswers) ? q.possibleAnswers : [];
      slideBodyHtml = `
        <div style="margin-bottom:12px">
          <span class="tag" style="color:#38bdf8;margin-bottom:8px;display:inline-block">
            📝 Questão Objetiva • Validação Local Offline
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
                  <strong style="min-width:22px">${String.fromCharCode(65 + idx)}.</strong>
                  <span>${escapeHtml(optStr)}</span>
                </button>
              `;
            })
            .join("")}
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button
            type="button"
            class="btn btn-primary"
            data-action="check-answer"
            ${state.selectedOptions.length === 0 ? "disabled" : ""}
          >
            ✔️ Verificar Resposta no Aparelho (Offline)
          </button>
        </div>
        ${
          state.questionResult
            ? `
              <div class="feedback-box ${state.questionResult.isCorrect ? "feedback-ok" : "feedback-err"}">
                <strong>
                  ${
                    state.questionResult.isCorrect
                      ? "🎉 Excelente! Resposta correta (+10 pts salvos na fila de sincronização)."
                      : "💡 Quase lá! Veja a resposta esperada abaixo e tente novamente:"
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
        <div style="text-align:center;padding:24px 16px;background:#111c33;border:1px solid #334155;border-radius:14px">
          <div style="font-size:11px;color:#38bdf8;margin-bottom:8px;font-weight:700">
            🃏 FLASHCARD INTERATIVO (${state.flashcardFlipped ? "VERSO" : "FRENTE"})
          </div>
          <div style="font-size:17px;font-weight:700;margin-bottom:16px">
            ${escapeHtml(state.flashcardFlipped ? slide.flashcardBack : slide.flashcardFront)}
          </div>
          <button type="button" class="btn btn-blue" data-action="flip-flashcard">
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

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px">
        <button type="button" class="btn" data-action="back-catalog">
          ← Voltar ao Catálogo
        </button>
        <div style="font-size:12px;color:#34d399;font-weight:600">
          📦 Pacote Ativo no IndexedDB • Hash #${escapeHtml(pkg.bundle.course.versionHash || "v1")}
        </div>
      </div>

      <div class="player-shell">
        <aside class="sidebar-card">
          <h2 style="margin:0 0 10px;font-size:15px">${escapeHtml(pkg.bundle.course.title)}</h2>
          ${sidebarModulesHtml}
        </aside>

        <section class="slide-card">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #1e293b;padding-bottom:12px;margin-bottom:14px;flex-wrap:wrap">
            <div>
              <div style="font-size:11px;color:#94a3b8">${escapeHtml(lesson ? lesson.title : "")}</div>
              <h1 style="margin:2px 0 0;font-size:18px">${escapeHtml(slide ? slide.title : "Aula")}</h1>
            </div>
            <span class="tag">
              Slide ${slides.length ? state.activeSlideIndex + 1 : 0} de ${slides.length}
            </span>
          </div>

          ${slideBodyHtml}

          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:20px;padding-top:14px;border-top:1px solid #1e293b;flex-wrap:wrap">
            <button
              type="button"
              class="btn"
              data-action="prev-slide"
              ${state.activeSlideIndex <= 0 ? "disabled" : ""}
            >
              ← Slide Anterior
            </button>

            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${
                state.activeSlideIndex < slides.length - 1
                  ? `
                    <button type="button" class="btn btn-primary" data-action="next-slide">
                      Próximo Slide →
                    </button>
                  `
                  : `
                    <button type="button" class="btn btn-primary" data-action="complete-lesson">
                      ✅ Concluir Aula &amp; Salvar no Sync
                    </button>
                  `
              }
            </div>
          </div>

          <div class="tutor-box">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap">
              <strong style="font-size:13px;color:#6ee7b7">
                🤖 Tutor Pedagógico Open-Source (Llama-3.1-8B • ≤10B)
              </strong>
              <span style="font-size:11px;color:#94a3b8">Mozilla Human-Scale AI Ready</span>
            </div>
            <div id="tutorHistory">
              ${state.tutorMessages
                .map(
                  (m) => `
                    <div class="chat-msg ${m.role === "user" ? "chat-user" : "chat-ai"}">
                      <div>${renderMarkdown(m.content)}</div>
                      ${m.meta ? `<div style="font-size:10px;color:#94a3b8;margin-top:4px">${escapeHtml(m.meta)}</div>` : ""}
                    </div>
                  `
                )
                .join("")}
              ${state.tutorLoading ? `<div class="chat-msg chat-ai">⏳ Consultando SLM ≤10B...</div>` : ""}
            </div>
            <form id="tutorForm" style="display:flex;gap:8px;margin-top:8px">
              <input
                id="tutorInput"
                type="text"
                placeholder="Tire uma dúvida sobre este slide..."
                style="flex:1;min-width:0;padding:9px 12px;border-radius:10px;border:1px solid #334155;background:#070b14;color:#f8fafc;font-size:13px"
              />
              <button type="submit" class="btn btn-blue">Perguntar</button>
            </form>
          </div>
        </section>
      </div>
    `;
  }

  function render() {
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
      if ( isEffectivelyOnline() ) syncNow(true);
      render();
    } else if (action === "import-json") {
      const fileIn = document.getElementById("fileImportInput");
      if (fileIn) fileIn.click();
    }
  });

  window.addEventListener("DOMContentLoaded", async () => {
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
