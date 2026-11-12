# 🎒 MyLMS Pocket (`pocket.mylms.ai`)

**Open-Source Offline-First Educational Player with On-Device Validation, Mother-DB Sync & Human-Scale AI Tutor (`≤10B`)**

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Architecture: Offline-First PWA](https://img.shields.io/badge/PWA-Offline--First-10b981)](https://pocket.mylms.ai)
[![AI Scale: <=10B Open-Source](https://img.shields.io/badge/SLM-%E2%89%A410B%20Llama--3.1--8B-3b82f6)](https://pocket.mylms.ai)

**MyLMS Pocket** is an open-source, lightweight, offline-first Progressive Web App (PWA) companion derived from the MyLMS learning environment (`plataforma.mylms.ai`). It enables students in low-connectivity or zero-connectivity regions to download structured course packages when connected, study completely offline (including local objective question grading and interactive flashcards), and automatically synchronize their progress and answers back to the central MyLMS database when connectivity returns.

---

## ✨ Key Features (Mozilla Human-Scale AI Aligned)

1. **📦 Self-Contained Course Packages (`.mylms-pocket.json`):**
   - Courses are exported from the MyLMS Backoffice or downloaded directly via `GET /v1/offline/courses/:slug/package`.
   - Includes modules, lessons, Markdown slides, images, GIFs, audio, optional video manifests, flashcards, and objective questions with SHA-256 verification hashes.
2. **📴 100% Offline Study Engine (`IndexedDB` + `CacheStorage`):**
   - Full Service Worker (`sw.js`) caches the application shell and downloaded course media assets.
   - Instant local grading of objective exercises on the student's device without server round-trips.
3. **🔄 Resilient Sync Queue (`POST /v1/offline/sync`):**
   - Every lesson start, slide view, question attempt, and lesson completion is stored in an local `IndexedDB` `sync_queue` store with client timestamps.
   - Automatically flushes idempotently to the MyLMS mother database (`LessonProgress` & `UserQuestionAnswer`) as soon as `online` status is restored.
4. **🧠 Open-Source Small Language Model Tutor (`≤10B` Parameters):**
   - Contextual Q&A grounded in the active lesson and slide using open-weight small language models (`Llama-3.1-8B-Instruct` — `8B` parameters, strictly `≤10B`) with zero dependency on proprietary frontier models (no GPT-4o / Gemini dependency), plus a deterministic local pedagogical fallback when completely offline.

---

## 🚀 Quick Start

```bash
git clone https://github.com/MyLMS-AI/mylms-pocket.git
cd mylms-pocket
MYLMS_API_URL=https://plataforma.mylms.ai PORT=3090 node server.mjs
```

## 📄 License

Released under the **MIT License**.
