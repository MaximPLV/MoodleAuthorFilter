(() => {
  const TABLE_SELECTOR = "table#submissions";
  const FILTER_ID = "moodle-author-filter-toggle";
  const EXT_HIDDEN_ATTR = "data-moodle-author-filter-hidden";
  const GRADER_PAGE_ID = "page-mod-assign-grader";
  const GRADING_PAGE_ID = "page-mod-assign-grading";
  const AUTHOR_IDS_PREFIX = "moodleAuthorFilterAuthorIds:";
  const AUTHOR_META_PREFIX = "moodleAuthorFilterAuthorMeta:";
  const FILTER_ENABLED_PREFIX = "moodleAuthorFilterEnabled:";

  function normalize(text) {
    return (text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function getColumnIndices(table) {
    const headers = [...table.querySelectorAll("thead th")];

    const authorGroupIndices = [];
    let usernameIndex = -1;

    headers.forEach((th, index) => {
      const text = normalize(th.textContent);

      if (th.classList.contains("username") || text.includes("vorname")) {
        usernameIndex = index;
      }

      if (text === "autorengruppen") {
        authorGroupIndices.push(index);
      }
    });

    return { usernameIndex, authorGroupIndices };
  }

  function getRowUsername(row, usernameIndex) {
    const cell = row.children[usernameIndex];
    if (!cell) return "";

    const avatar = cell.querySelector(".userinitials");
    if (avatar?.getAttribute("title")) {
      return normalize(avatar.getAttribute("title"));
    }

    const link = cell.querySelector("a");
    return normalize(link?.textContent || cell.textContent);
  }

  function getAuthorNameFromCell(cell) {
    if (!cell) return "";

    // example:
    // Autor: <a href=...>Maxim Poliakov</a><br>Co-Autoren: ...
    const html = cell.innerHTML;
    if (!html.includes("Autor:")) return "";

    const links = [...cell.querySelectorAll("a")];
    if (links.length === 0) return "";

    // first link after "Autor:" is the actual author.
    return normalize(links[0].textContent);
  }

  function extractUserIdFromLink(link) {
    if (!link?.href) return "";
    const match = link.href.match(/[?&]id=(\d+)/);
    return match?.[1] || "";
  }

  function getRowUserId(row, usernameIndex) {
    const cell = row.children[usernameIndex];
    if (!cell) return "";
    return extractUserIdFromLink(cell.querySelector("a[href*='user/view.php?id=']"));
  }

  function getAuthorUserIdFromCell(cell) {
    if (!cell) return "";
    if (!cell.innerHTML.includes("Autor:")) return "";
    const firstLink = cell.querySelector("a[href*='user/view.php?id=']");
    return extractUserIdFromLink(firstLink);
  }

  function isRealSubmissionRow(row) {
    if (!row || row.classList.contains("emptyrow")) return false;
    return /\buser\d+\b/.test(row.className);
  }

  function isAuthorRow(row, usernameIndex, authorGroupIndices) {
    const username = getRowUsername(row, usernameIndex);

    // if there is no author metadata -> normal single person submission.
    const authorCells = authorGroupIndices
      .map((i) => row.children[i])
      .filter(Boolean);

    const hasExplicitAuthorInfo = authorCells.some((cell) =>
      cell.textContent.includes("Autor:")
    );

    if (!hasExplicitAuthorInfo) {
      return true;
    }

    // keep only the row where the visible row user equals the listed author.
    return authorCells.some((cell) => {
      const authorName = getAuthorNameFromCell(cell);
      return authorName && authorName === username;
    });
  }

  function getCourseModuleId() {
    return new URLSearchParams(window.location.search).get("id") || "";
  }

  function readAuthorUserIds(cmid) {
    if (!cmid) return [];
    try {
      const raw = localStorage.getItem(AUTHOR_IDS_PREFIX + cmid);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id) => /^\d+$/.test(String(id)));
    } catch {
      return [];
    }
  }

  function readFilterEnabled(cmid) {
    if (!cmid) return true;
    const raw = localStorage.getItem(FILTER_ENABLED_PREFIX + cmid);
    if (raw === null) return true;
    return raw === "1";
  }

  function writeFilterEnabled(cmid, enabled) {
    if (!cmid) return;
    localStorage.setItem(FILTER_ENABLED_PREFIX + cmid, enabled ? "1" : "0");
  }

  function isFilterEnabledForCurrentAssignment() {
    return readFilterEnabled(getCourseModuleId());
  }

  function readAuthorMeta(cmid) {
    if (!cmid) return null;
    try {
      const raw = localStorage.getItem(AUTHOR_META_PREFIX + cmid);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.totalRows !== "number" ||
        typeof parsed?.authorRows !== "number"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function writeAuthorMeta(cmid, totalRows, authorRows) {
    if (!cmid) return;
    localStorage.setItem(
      AUTHOR_META_PREFIX + cmid,
      JSON.stringify({ totalRows, authorRows })
    );
  }

  function writeAuthorUserIds(cmid, userIds) {
    if (!cmid || !Array.isArray(userIds) || userIds.length === 0) return;
    localStorage.setItem(AUTHOR_IDS_PREFIX + cmid, JSON.stringify(userIds));
  }

  function collectAllowedAuthorUserIds(table, usernameIndex, authorGroupIndices) {
    const rows = [...table.querySelectorAll("tbody tr")].filter(isRealSubmissionRow);
    const seen = new Set();
    const authorIds = [];

    for (const row of rows) {
      const rowUserId = getRowUserId(row, usernameIndex);
      if (!rowUserId || seen.has(rowUserId)) continue;

      const authorCells = authorGroupIndices
        .map((i) => row.children[i])
        .filter(Boolean);
      const explicitAuthorIds = authorCells
        .map(getAuthorUserIdFromCell)
        .filter(Boolean);
      const keep = isAuthorRow(row, usernameIndex, authorGroupIndices);

      if (!keep) continue;

      const resolvedId = explicitAuthorIds[0] || rowUserId;
      if (!seen.has(resolvedId)) {
        seen.add(resolvedId);
        authorIds.push(resolvedId);
      }
    }

    return authorIds;
  }

  function applyFilter(enabled) {
    const table = document.querySelector(TABLE_SELECTOR);
    if (!table) return;

    const { usernameIndex, authorGroupIndices } = getColumnIndices(table);

    if (usernameIndex < 0 || authorGroupIndices.length === 0) {
      console.warn("[Moodle Author Filter] Could not find needed columns.");
      return;
    }

    const rows = [...table.querySelectorAll("tbody tr")].filter(isRealSubmissionRow);
    const cmid = getCourseModuleId();
    const allowedAuthorIds = collectAllowedAuthorUserIds(
      table,
      usernameIndex,
      authorGroupIndices
    );
    writeAuthorUserIds(cmid, allowedAuthorIds);
    writeAuthorMeta(cmid, rows.length, allowedAuthorIds.length);

    let visible = 0;
    let hidden = 0;

    for (const row of rows) {
      const keep = isAuthorRow(row, usernameIndex, authorGroupIndices);

      if (enabled && !keep) {
        row.style.display = "none";
        row.setAttribute(EXT_HIDDEN_ATTR, "1");
        hidden++;
      } else {
        // Only unhide rows that were hidden by this extension.
        if (row.getAttribute(EXT_HIDDEN_ATTR) === "1") {
          row.style.display = "";
          row.removeAttribute(EXT_HIDDEN_ATTR);
        }
        visible++;
      }
    }

    const counter = document.querySelector("#moodle-author-filter-counter");
    if (counter) {
      counter.textContent = enabled
        ? `Showing ${visible}, hidden ${hidden}`
        : "Filter disabled";
    }
  }

  function createToggle() {
    if (document.getElementById(FILTER_ID)) return;

    const container = document.createElement("div");
    container.id = FILTER_ID;
    container.className = "navitem m-0";

    const wrapper = document.createElement("div");
    wrapper.className = "form-check align-self-center";
    wrapper.innerHTML = `
      <input class="form-check-input" type="checkbox" id="moodle-author-filter-checkbox" checked>
      <label class="form-check-label" for="moodle-author-filter-checkbox">Only author submissions</label>
      <span id="moodle-author-filter-counter" style="font-size: 0.9em; color: #555; margin-left: 8px;"></span>
    `;
    container.appendChild(wrapper);

    const tertiaryRow = document.querySelector(
      ".container-fluid.tertiary-navigation.pt-0 .row.pb-2"
    );

    if (tertiaryRow) {
      const divider = document.createElement("div");
      divider.className = "navitem-divider m-0";
      tertiaryRow.appendChild(divider);
      tertiaryRow.appendChild(container);
    } else {
      const table = document.querySelector(TABLE_SELECTOR);
      const fallbackTarget =
        table?.closest(".gradingtable") ||
        document.querySelector("#region-main") ||
        document.body;
      fallbackTarget.prepend(container);
    }

    const checkbox = container.querySelector("#moodle-author-filter-checkbox");
    const cmid = getCourseModuleId();
    checkbox.checked = readFilterEnabled(cmid);

    checkbox.addEventListener("change", () => {
      writeFilterEnabled(cmid, checkbox.checked);
      applyFilter(checkbox.checked);
    });
  }

  function init() {
    if (!document.body?.id?.includes(GRADING_PAGE_ID)) return;

    createToggle();

    const checkbox = document.querySelector("#moodle-author-filter-checkbox");
    applyFilter(checkbox?.checked ?? true);
  }

  function getCurrentGraderUserId() {
    return (
      document
        .querySelector('[data-region="user-info"]')
        ?.getAttribute("data-userid") || ""
    );
  }

  function getAuthorIdsForCurrentAssignment() {
    return readAuthorUserIds(getCourseModuleId());
  }

  function navigateToGraderUser(userId) {
    if (!/^\d+$/.test(String(userId))) return;
    const url = new URL(window.location.href);
    url.searchParams.set("action", "grader");
    url.searchParams.set("userid", String(userId));
    window.location.href = url.toString();
  }

  function setNavButtonDisabled(button, disabled) {
    if (!button) return;
    if (disabled) {
      button.setAttribute("aria-disabled", "true");
      button.style.pointerEvents = "none";
      button.style.opacity = "0.4";
      button.title = "Kein weiterer Autor";
    } else {
      button.removeAttribute("aria-disabled");
      button.style.pointerEvents = "";
      button.style.opacity = "";
      button.title = "";
    }
  }

  function updateGraderCountSummary(authorIds, currentIndex) {
    const summary = document.querySelector('[data-region="user-count-summary"]');
    if (!summary) return;

    const cmid = getCourseModuleId();
    const meta = readAuthorMeta(cmid);
    const baselineTotal =
      typeof meta?.totalRows === "number" ? meta.totalRows : authorIds.length;
    const hiddenCount = Math.max(0, baselineTotal - authorIds.length);
    const visiblePos = currentIndex >= 0 ? currentIndex + 1 : 1;

    summary.textContent = `${visiblePos} von ${authorIds.length}, ${hiddenCount} hidden`;
  }

  function findCurrentIndex(authorIds, currentUserId) {
    return authorIds.findIndex((id) => String(id) === String(currentUserId));
  }

  function wireAuthorOnlyGraderNavigation() {
    if (!document.body?.id?.includes(GRADER_PAGE_ID)) return;
    if (!isFilterEnabledForCurrentAssignment()) return;

    const prevButton = document.querySelector('[data-action="previous-user"]');
    const nextButton = document.querySelector('[data-action="next-user"]');

    if (!prevButton || !nextButton) return;

    const authorIds = getAuthorIdsForCurrentAssignment();
    const currentUserId = getCurrentGraderUserId();
    const currentIndex = findCurrentIndex(authorIds, currentUserId);
    const hasPrev = currentIndex > 0;
    const hasNext = currentIndex >= 0 && currentIndex < authorIds.length - 1;

    if (authorIds.length > 0) {
      updateGraderCountSummary(authorIds, currentIndex);
    }

    setNavButtonDisabled(prevButton, !hasPrev);
    setNavButtonDisabled(nextButton, !hasNext);

    if (document.body.dataset.moodleAuthorFilterGraderWired === "1") return;

    prevButton.addEventListener("click", (event) => {
      event.preventDefault();
      const ids = getAuthorIdsForCurrentAssignment();
      const idx = findCurrentIndex(ids, getCurrentGraderUserId());
      if (idx > 0) {
        navigateToGraderUser(ids[idx - 1]);
      }
    });

    nextButton.addEventListener("click", (event) => {
      event.preventDefault();
      const ids = getAuthorIdsForCurrentAssignment();
      const idx = findCurrentIndex(ids, getCurrentGraderUserId());
      if (idx >= 0 && idx < ids.length - 1) {
        navigateToGraderUser(ids[idx + 1]);
      }
    });

    document.body.dataset.moodleAuthorFilterGraderWired = "1";
  }

  function enforceAuthorOnlyOnGraderEntry() {
    if (!document.body?.id?.includes(GRADER_PAGE_ID)) return;
    if (!isFilterEnabledForCurrentAssignment()) return;
    const authorIds = getAuthorIdsForCurrentAssignment();
    if (authorIds.length === 0) return;

    const currentUserId = getCurrentGraderUserId();
    if (!currentUserId) return;
    if (!authorIds.includes(currentUserId)) {
      navigateToGraderUser(authorIds[0]);
      return;
    }
  }

  init();
  wireAuthorOnlyGraderNavigation();
  enforceAuthorOnlyOnGraderEntry();

  const observer = new MutationObserver(() => {
    clearTimeout(window.__moodleAuthorFilterTimer);
    window.__moodleAuthorFilterTimer = setTimeout(() => {
      init();
      wireAuthorOnlyGraderNavigation();
      enforceAuthorOnlyOnGraderEntry();
    }, 150);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
})();