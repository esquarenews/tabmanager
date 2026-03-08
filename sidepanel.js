const state = {
  windowId: null,
  dashboard: null,
  activeView: "tabs",
  refreshTimer: null
};

const ui = {
  workspaceList: document.querySelector("#workspaceList"),
  workspaceName: document.querySelector("#workspaceName"),
  workspaceMeta: document.querySelector("#workspaceMeta"),
  content: document.querySelector("#content"),
  parkedWorkspaceList: document.querySelector("#parkedWorkspaceList"),
  createWorkspaceButton: document.querySelector("#createWorkspaceButton"),
  settingsRailButton: document.querySelector("#settingsRailButton"),
  sleepButton: document.querySelector("#sleepButton"),
  wakeButton: document.querySelector("#wakeButton"),
  tabButtons: Array.from(document.querySelectorAll(".tab-button")),
  template: document.querySelector("#itemTemplate")
};

const dragState = {
  type: null,
  payload: null
};

const EXPANDED_PARKED_WORKSPACES_MIN_WIDTH = 1700;

function clearDropTargets() {
  for (const node of document.querySelectorAll(".drop-target")) {
    node.classList.remove("drop-target");
  }
}

function beginDrag(type, payload, event) {
  dragState.type = type;
  dragState.payload = payload;
  if (event?.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${type}:${Date.now()}`);
  }
}

function endDrag() {
  dragState.type = null;
  dragState.payload = null;
  clearDropTargets();
}

function moveItemBefore(items, isSource, isTarget) {
  const sourceIndex = items.findIndex(isSource);
  const targetIndex = items.findIndex(isTarget);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(sourceIndex, 1);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(adjustedTargetIndex, 0, moved);
  return next;
}

function workspaceMoveOptions(currentWorkspaceId) {
  if (!state.dashboard?.workspaces) {
    return [];
  }
  return state.dashboard.workspaces
    .filter((workspace) => workspace.id !== currentWorkspaceId)
    .map((workspace) => ({ value: workspace.id, label: workspace.name }));
}

function isBookmarkedInResources(workspace, url) {
  return Array.isArray(workspace?.resources) && workspace.resources.some((resource) => resource.url === url);
}

function createIconActionButton({ icon, title, active = false, className = "", onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-action-button ${className}`.trim();
  button.textContent = icon;
  button.title = title;
  button.setAttribute("aria-label", title);
  if (active) {
    button.classList.add("active");
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function createMoveMenuControl(currentWorkspaceId, onMove) {
  const options = workspaceMoveOptions(currentWorkspaceId);
  if (options.length === 0) {
    return null;
  }

  const details = document.createElement("details");
  details.className = "action-menu";

  const summary = document.createElement("summary");
  summary.className = "icon-action-button icon-arrow-action";
  summary.textContent = "|->";
  summary.title = "Move to workspace";
  summary.setAttribute("aria-label", "Move to workspace");
  details.appendChild(summary);

  const menu = document.createElement("div");
  menu.className = "action-menu-list";

  for (const option of options) {
    const optionButton = document.createElement("button");
    optionButton.type = "button";
    optionButton.className = "action-menu-item";
    optionButton.textContent = option.label;
    optionButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      details.open = false;
      onMove(option.value);
    });
    menu.appendChild(optionButton);
  }

  details.appendChild(menu);
  return details;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function truncateDisplayText(value, maxLength = 56) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 1))}\u2026`;
}

function formatDisplayUrl(url, options = {}) {
  const { baseOnly = false, maxLength = 56 } = options;
  try {
    const parsed = new URL(url);
    if (baseOnly) {
      return truncateDisplayText(parsed.origin, maxLength);
    }
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    const query = parsed.search || "";
    return truncateDisplayText(`${parsed.origin}${path}${query}`, maxLength);
  } catch (error) {
    return truncateDisplayText(url, maxLength);
  }
}

function workspaceInitial(workspaceName) {
  const trimmed = String(workspaceName || "").trim();
  if (!trimmed) {
    return "W";
  }
  return trimmed[0].toUpperCase();
}

function workspaceColor(workspace) {
  return typeof workspace?.color === "string" ? workspace.color : "#2563EB";
}

function buildWorkspaceFaviconDataUrl(letter, color) {
  const safeLetter = String(letter || "W").slice(0, 1).toUpperCase();
  const safeColor = String(color || "#2563EB");
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="4" y="4" width="56" height="56" rx="18" fill="${safeColor}"/>
  <text x="32" y="41" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#FFFFFF" font-weight="700">${safeLetter}</text>
</svg>
  `.trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function applyWorkspaceIdentity(workspace) {
  const letter = workspaceInitial(workspace.name);
  const color = workspaceColor(workspace);
  document.title = `${workspace.name} · Ordinator`;

  let favicon = document.querySelector("link[data-workspace-favicon='1']");
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    favicon.dataset.workspaceFavicon = "1";
    document.head.appendChild(favicon);
  }

  const nextHref = buildWorkspaceFaviconDataUrl(letter, color);
  if (favicon.href !== nextHref) {
    favicon.href = nextHref;
  }
}

function setToast(message, tone = "success") {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("p");
    toast.className = "toast";
    ui.content.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast ${tone}`;
}

function clearToast() {
  const toast = document.querySelector(".toast");
  if (toast) {
    toast.remove();
  }
}

function currentWorkspace() {
  return state.dashboard?.activeWorkspace || null;
}

async function send(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, payload });
  if (!response || !response.ok) {
    throw new Error(response?.error || "Request failed.");
  }
  return response.result;
}

function debounceRefresh() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
  }
  state.refreshTimer = setTimeout(() => {
    void refreshDashboard(true);
  }, 180);
}

function renderWorkspaceList() {
  ui.workspaceList.textContent = "";

  for (const workspace of state.dashboard.workspaces) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.draggable = true;
    const isActive = workspace.id === state.dashboard.activeWorkspaceId;

    if (isActive) {
      button.classList.add("active");
    }

    const label = document.createElement("div");
    label.className = "workspace-label";

    const nameWrap = document.createElement("div");
    nameWrap.className = "workspace-name-wrap";

    const swatchButton = document.createElement("button");
    swatchButton.type = "button";
    swatchButton.className = "workspace-swatch-button";
    swatchButton.title = `Change color for ${workspace.name}`;
    swatchButton.setAttribute("aria-label", `Change color for ${workspace.name}`);

    const swatch = document.createElement("span");
    swatch.className = "workspace-swatch";
    swatch.style.backgroundColor = workspaceColor(workspace);
    swatchButton.appendChild(swatch);

    const swatchPicker = document.createElement("input");
    swatchPicker.type = "color";
    swatchPicker.className = "workspace-color-picker";
    swatchPicker.value = workspaceColor(workspace);
    swatchPicker.tabIndex = -1;

    swatchButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      swatchPicker.click();
    });

    swatchPicker.addEventListener("input", (event) => {
      const color = String(event.target?.value || "").toUpperCase();
      swatch.style.backgroundColor = color;
    });

    swatchPicker.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    swatchPicker.addEventListener("change", (event) => {
      event.stopPropagation();
      const color = String(event.target?.value || "").toUpperCase();
      void runAction(
        () =>
          send("UPDATE_WORKSPACE_COLOR", {
            workspaceId: workspace.id,
            color
          }),
        "Workspace color updated."
      );
    });

    const name = document.createElement("span");
    name.className = "workspace-name";
    name.textContent = workspace.name;

    const count = document.createElement("span");
    count.className = "workspace-count";
    count.textContent = `${workspace.sessionTabs.length} sleep`;

    nameWrap.append(swatchButton, swatchPicker, name);
    label.append(nameWrap, count);
    button.appendChild(label);

    button.addEventListener("dragstart", (event) => {
      beginDrag(
        "workspace",
        {
          workspaceId: workspace.id
        },
        event
      );
    });

    button.addEventListener("dragend", () => {
      endDrag();
    });

    button.addEventListener("dragover", (event) => {
      if (!dragState.type) {
        return;
      }
      const canDropWorkspace = dragState.type === "workspace" && dragState.payload?.workspaceId !== workspace.id;
      const canDropOpenTab = dragState.type === "open-tab" && dragState.payload?.sourceWorkspaceId !== workspace.id;
      const canDropSleepingTab =
        dragState.type === "sleeping-tab" && dragState.payload?.sourceWorkspaceId !== workspace.id;

      if (!canDropWorkspace && !canDropOpenTab && !canDropSleepingTab) {
        return;
      }

      event.preventDefault();
      button.classList.add("drop-target");
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
    });

    button.addEventListener("dragleave", () => {
      button.classList.remove("drop-target");
    });

    button.addEventListener("drop", (event) => {
      event.preventDefault();
      button.classList.remove("drop-target");

      if (dragState.type === "workspace") {
        const sourceWorkspaceId = dragState.payload?.workspaceId;
        if (!sourceWorkspaceId || sourceWorkspaceId === workspace.id) {
          endDrag();
          return;
        }

        const reordered = moveItemBefore(
          state.dashboard.workspaces,
          (item) => item.id === sourceWorkspaceId,
          (item) => item.id === workspace.id
        );

        void runAction(
          () =>
            send("REORDER_WORKSPACES", {
              workspaceOrder: reordered.map((item) => item.id)
            }),
          "Workspace order updated."
        );
        endDrag();
        return;
      }

      if (dragState.type === "open-tab") {
        const sourceWorkspaceId = dragState.payload?.sourceWorkspaceId;
        const tabId = dragState.payload?.tabId;
        if (!Number.isFinite(tabId) || !sourceWorkspaceId || sourceWorkspaceId === workspace.id) {
          endDrag();
          return;
        }

        void runAction(
          () =>
            send("MOVE_OPEN_TAB_TO_WORKSPACE", {
              windowId: state.windowId,
              tabId,
              targetWorkspaceId: workspace.id
            }),
          `Tab moved to "${workspace.name}".`
        );
        endDrag();
        return;
      }

      if (dragState.type === "sleeping-tab") {
        const sourceWorkspaceId = dragState.payload?.sourceWorkspaceId;
        const url = dragState.payload?.url;
        const title = dragState.payload?.title;
        if (!sourceWorkspaceId || sourceWorkspaceId === workspace.id || typeof url !== "string") {
          endDrag();
          return;
        }

        void runAction(
          () =>
            send("MOVE_SLEEPING_TAB_TO_WORKSPACE", {
              sourceWorkspaceId,
              targetWorkspaceId: workspace.id,
              url,
              title
            }),
          `Sleeping tab moved to "${workspace.name}".`
        );
        endDrag();
      }
    });

    button.addEventListener("click", () => {
      if (isActive) {
        return;
      }
      void runAction(
        async () => {
          await send("SWITCH_WORKSPACE", {
            workspaceId: workspace.id,
            windowId: state.windowId
          });
        },
        `Switched to "${workspace.name}".`
      );
    });

    button.addEventListener("dblclick", (event) => {
      event.preventDefault();
      const nextName = window.prompt("Rename workspace", workspace.name);
      if (nextName === null) {
        return;
      }
      void runAction(
        async () => {
          await send("RENAME_WORKSPACE", {
            workspaceId: workspace.id,
            name: nextName,
            windowId: state.windowId
          });
        },
        "Workspace renamed."
      );
    });

    li.appendChild(button);
    ui.workspaceList.appendChild(li);
  }
}

function renderParkedWorkspaceList() {
  ui.parkedWorkspaceList.textContent = "";
  const parkedWorkspaces = Array.isArray(state.dashboard?.parkedWorkspaces) ? state.dashboard.parkedWorkspaces : [];
  const visibleParked = parkedWorkspaces.filter((workspace) => workspace.id !== state.dashboard?.activeWorkspaceId);
  if (visibleParked.length === 0) {
    ui.parkedWorkspaceList.hidden = true;
    return;
  }

  ui.parkedWorkspaceList.hidden = false;
  const showExpanded = window.innerWidth >= EXPANDED_PARKED_WORKSPACES_MIN_WIDTH;

  const heading = document.createElement("p");
  heading.className = "parked-workspace-heading";
  heading.textContent = "Hidden";
  ui.parkedWorkspaceList.appendChild(heading);

  if (!showExpanded) {
    const compactBadge = document.createElement("div");
    compactBadge.className = "parked-workspace-badge compact";
    compactBadge.textContent = `${visibleParked.length} hidden`;
    compactBadge.title = visibleParked.map((workspace) => workspace.name).join(", ");
    ui.parkedWorkspaceList.appendChild(compactBadge);
    return;
  }

  for (const workspace of visibleParked) {
    const badge = document.createElement("div");
    badge.className = "parked-workspace-badge";
    badge.textContent = workspace.name;
    ui.parkedWorkspaceList.appendChild(badge);
  }
}

function makeItemCard({ title, subtitle, actions }) {
  const node = ui.template.content.firstElementChild.cloneNode(true);
  const titleEl = node.querySelector(".item-title");
  const subtitleEl = node.querySelector(".item-subtitle");
  const actionsEl = node.querySelector(".item-actions");

  titleEl.textContent = title;
  subtitleEl.textContent = subtitle;

  for (const action of actions) {
    const button = document.createElement("button");
    button.textContent = action.label;
    if (action.className) {
      button.className = action.className;
    }
    button.addEventListener("click", action.onClick);
    actionsEl.appendChild(button);
  }

  return node;
}

function wireItemCopyOpen(card, openLabel, onOpen) {
  if (typeof onOpen !== "function") {
    return;
  }
  const copyEl = card.querySelector(".item-copy");
  if (!copyEl) {
    return;
  }
  copyEl.classList.add("clickable");
  copyEl.tabIndex = 0;
  copyEl.setAttribute("role", "button");
  copyEl.setAttribute("aria-label", openLabel);
  copyEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen();
  });
  copyEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    onOpen();
  });
}

function renderEmpty(message) {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = message;
  return empty;
}

function renderTabsView(workspace) {
  const root = document.createElement("div");

  const openSection = document.createElement("section");
  openSection.className = "section";
  openSection.innerHTML = `
    <h3>Open Tabs</h3>
    <p class="section-note">Open tabs in this window for "${workspace.name}". Drag to reorder or drop onto a workspace to move.</p>
  `;

  if (state.dashboard.openTabs.length === 0) {
    openSection.appendChild(renderEmpty("No open tabs in this workspace window."));
  } else {
    for (const tab of state.dashboard.openTabs) {
      const openTabFromList = () =>
        runAction(
          () =>
            send("ACTIVATE_OPEN_TAB", {
              windowId: state.windowId,
              workspaceId: workspace.id,
              tabId: tab.id,
              url: tab.url,
              title: tab.title
            }),
          "Tab opened."
        );

      const card = makeItemCard({
        title: tab.title,
        subtitle: formatDisplayUrl(tab.url, { baseOnly: true, maxLength: 48 }),
        actions: []
      });
      card.draggable = true;
      card.classList.add("draggable-item");
      wireItemCopyOpen(card, `Open ${tab.title}`, () => {
        void openTabFromList();
      });

      const actionsEl = card.querySelector(".item-actions");
      const alreadyBookmarked = isBookmarkedInResources(workspace, tab.url);

      const bookmarkButton = createIconActionButton({
        icon: "🔖",
        title: alreadyBookmarked ? "Already bookmarked in Resources" : "Bookmark in Resources",
        active: alreadyBookmarked,
        onClick: () => {
          if (alreadyBookmarked) {
            setToast("Already bookmarked in Resources.", "success");
            return;
          }
          void runAction(
            () =>
              send("ADD_RESOURCE", {
                workspaceId: workspace.id,
                url: tab.url,
                title: tab.title
              }),
            "Bookmarked in Resources."
          );
        }
      });
      actionsEl.appendChild(bookmarkButton);

      const closeButton = createIconActionButton({
        icon: "\u2715",
        title: "Close tab",
        className: "danger",
        onClick: () => {
          void runAction(
            () =>
              send("CLOSE_OPEN_TAB", {
                windowId: state.windowId,
                tabId: tab.id
              }),
            "Tab closed."
          );
        }
      });
      actionsEl.appendChild(closeButton);

      const moveMenu = createMoveMenuControl(workspace.id, (targetWorkspaceId) => {
        void runAction(
          () =>
            send("MOVE_OPEN_TAB_TO_WORKSPACE", {
              windowId: state.windowId,
              tabId: tab.id,
              targetWorkspaceId
            }),
          "Tab moved to workspace."
        );
      });
      if (moveMenu) {
        actionsEl.appendChild(moveMenu);
      }

      card.addEventListener("dragstart", (event) => {
        card.classList.add("dragging");
        beginDrag(
          "open-tab",
          {
            tabId: tab.id,
            sourceWorkspaceId: workspace.id,
            url: tab.url,
            title: tab.title
          },
          event
        );
      });

      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        endDrag();
      });

      card.addEventListener("dragover", (event) => {
        const sourceTabId = dragState.payload?.tabId;
        if (dragState.type !== "open-tab" || dragState.payload?.sourceWorkspaceId !== workspace.id || sourceTabId === tab.id) {
          return;
        }
        event.preventDefault();
        card.classList.add("drop-target");
      });

      card.addEventListener("dragleave", () => {
        card.classList.remove("drop-target");
      });

      card.addEventListener("drop", (event) => {
        event.preventDefault();
        card.classList.remove("drop-target");
        const sourceTabId = dragState.payload?.tabId;
        if (dragState.type !== "open-tab" || dragState.payload?.sourceWorkspaceId !== workspace.id || sourceTabId === tab.id) {
          endDrag();
          return;
        }

        const reordered = moveItemBefore(
          state.dashboard.openTabs,
          (item) => item.id === sourceTabId,
          (item) => item.id === tab.id
        );

        void runAction(
          () =>
            send("REORDER_OPEN_TABS", {
              windowId: state.windowId,
              workspaceId: workspace.id,
              orderedTabIds: reordered.map((item) => item.id)
            }),
          "Open tabs reordered."
        );
        endDrag();
      });

      openSection.appendChild(card);
    }
  }

  const sleepingSection = document.createElement("section");
  sleepingSection.className = "section";
  sleepingSection.innerHTML = `
    <h3>Sleeping Tabs</h3>
    <p class="section-note">Saved tabs that can be reopened later. Drag to reorder or move across workspaces.</p>
  `;

  if (workspace.sessionTabs.length === 0) {
    sleepingSection.appendChild(renderEmpty("No sleeping tabs saved yet."));
  } else {
    for (const tab of workspace.sessionTabs) {
      const openSleepingTabFromList = () =>
        runAction(
          () =>
            send("OPEN_SLEEPING_TAB", {
              windowId: state.windowId,
              workspaceId: workspace.id,
              url: tab.url
            }),
          "Opened sleeping tab."
        );

      const card = makeItemCard({
        title: tab.title,
        subtitle: formatDisplayUrl(tab.url, { maxLength: 72 }),
        actions: []
      });
      card.draggable = true;
      card.classList.add("draggable-item");
      wireItemCopyOpen(card, `Open ${tab.title}`, () => {
        void openSleepingTabFromList();
      });

      const actionsEl = card.querySelector(".item-actions");

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "primary";
      openButton.textContent = "Open";
      openButton.addEventListener("click", () => {
        void openSleepingTabFromList();
      });
      actionsEl.appendChild(openButton);

      const alreadyBookmarked = isBookmarkedInResources(workspace, tab.url);
      const bookmarkButton = createIconActionButton({
        icon: "🔖",
        title: alreadyBookmarked ? "Already bookmarked in Resources" : "Bookmark in Resources",
        active: alreadyBookmarked,
        onClick: () => {
          if (alreadyBookmarked) {
            setToast("Already bookmarked in Resources.", "success");
            return;
          }
          void runAction(
            () =>
              send("ADD_RESOURCE", {
                workspaceId: workspace.id,
                url: tab.url,
                title: tab.title
              }),
            "Bookmarked in Resources."
          );
        }
      });
      actionsEl.appendChild(bookmarkButton);

      const moveMenu = createMoveMenuControl(workspace.id, (targetWorkspaceId) => {
        void runAction(
          () =>
            send("MOVE_SLEEPING_TAB_TO_WORKSPACE", {
              sourceWorkspaceId: workspace.id,
              targetWorkspaceId,
              url: tab.url,
              title: tab.title
            }),
          "Sleeping tab moved to workspace."
        );
      });
      if (moveMenu) {
        actionsEl.appendChild(moveMenu);
      }

      const removeButton = createIconActionButton({
        icon: "\u2715",
        title: "Remove sleeping tab",
        className: "danger",
        onClick: () => {
          void runAction(
            () =>
              send("REMOVE_SLEEPING_TAB", {
                windowId: state.windowId,
                workspaceId: workspace.id,
                url: tab.url
              }),
            "Removed sleeping tab."
          );
        }
      });
      actionsEl.appendChild(removeButton);

      card.addEventListener("dragstart", (event) => {
        card.classList.add("dragging");
        beginDrag(
          "sleeping-tab",
          {
            sourceWorkspaceId: workspace.id,
            url: tab.url,
            title: tab.title
          },
          event
        );
      });

      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        endDrag();
      });

      card.addEventListener("dragover", (event) => {
        const sourceUrl = dragState.payload?.url;
        if (
          dragState.type !== "sleeping-tab" ||
          dragState.payload?.sourceWorkspaceId !== workspace.id ||
          sourceUrl === tab.url
        ) {
          return;
        }
        event.preventDefault();
        card.classList.add("drop-target");
      });

      card.addEventListener("dragleave", () => {
        card.classList.remove("drop-target");
      });

      card.addEventListener("drop", (event) => {
        event.preventDefault();
        card.classList.remove("drop-target");
        const sourceUrl = dragState.payload?.url;
        if (
          dragState.type !== "sleeping-tab" ||
          dragState.payload?.sourceWorkspaceId !== workspace.id ||
          sourceUrl === tab.url
        ) {
          endDrag();
          return;
        }

        const reordered = moveItemBefore(
          workspace.sessionTabs,
          (item) => item.url === sourceUrl,
          (item) => item.url === tab.url
        );

        void runAction(
          () =>
            send("REORDER_SLEEPING_TABS", {
              workspaceId: workspace.id,
              orderedUrls: reordered.map((item) => item.url)
            }),
          "Sleeping tabs reordered."
        );
        endDrag();
      });

      sleepingSection.appendChild(card);
    }
  }

  root.append(openSection, sleepingSection);
  return root;
}

function renderHistoryView(workspace) {
  const root = document.createElement("section");
  root.className = "section";
  root.innerHTML = `
    <h3>Snapshot History</h3>
    <p class="section-note">Automatic snapshots captured during switch/sleep/memory cleanup.</p>
  `;

  if (!workspace.history.length) {
    root.appendChild(renderEmpty("No snapshots yet."));
    return root;
  }

  for (const snapshot of workspace.history) {
    const card = makeItemCard({
      title: `${snapshot.tabs.length} tabs • ${snapshot.reason}`,
      subtitle: formatDate(snapshot.createdAt),
      actions: [
        {
          label: "Restore",
          className: "primary",
          onClick: () =>
            runAction(
              () =>
                send("RESTORE_SNAPSHOT", {
                  windowId: state.windowId,
                  workspaceId: workspace.id,
                  snapshotId: snapshot.id
                }),
              "Snapshot restored."
            )
        }
      ]
    });
    root.appendChild(card);
  }

  return root;
}

function renderResourcesView(workspace) {
  const root = document.createElement("div");

  const addSection = document.createElement("section");
  addSection.className = "section";
  addSection.innerHTML = `
    <h3>Add Resource</h3>
    <p class="section-note">Resources are bookmark-like links that are not auto-opened.</p>
  `;

  const form = document.createElement("form");
  form.className = "inline-form";
  form.innerHTML = `
    <input name="url" type="url" placeholder="https://example.com" required />
    <input name="title" type="text" placeholder="Optional title" />
    <button class="primary" type="submit">Add</button>
  `;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const url = String(formData.get("url") || "").trim();
    const title = String(formData.get("title") || "").trim();
    void runAction(
      async () => {
        await send("ADD_RESOURCE", {
          windowId: state.windowId,
          workspaceId: workspace.id,
          url,
          title
        });
      },
      "Resource added."
    );
    form.reset();
  });

  addSection.appendChild(form);

  const listSection = document.createElement("section");
  listSection.className = "section";
  listSection.innerHTML = `
    <h3>Saved Resources</h3>
    <p class="section-note">${workspace.resources.length} item(s)</p>
  `;

  if (!workspace.resources.length) {
    listSection.appendChild(renderEmpty("No resources saved."));
  } else {
    for (const resource of workspace.resources) {
      const card = makeItemCard({
        title: resource.title,
        subtitle: resource.url,
        actions: [
          {
            label: "Open",
            className: "primary",
            onClick: () =>
              runAction(
                () =>
                  send("OPEN_RESOURCE", {
                    windowId: state.windowId,
                    workspaceId: workspace.id,
                    resourceId: resource.id
                  }),
                "Resource opened."
              )
          },
          {
            label: "Remove",
            className: "danger",
            onClick: () =>
              runAction(
                () =>
                  send("REMOVE_RESOURCE", {
                    windowId: state.windowId,
                    workspaceId: workspace.id,
                    resourceId: resource.id
                  }),
                "Resource removed."
              )
          }
        ]
      });
      listSection.appendChild(card);
    }
  }

  root.append(addSection, listSection);
  return root;
}

function renderSettingsView() {
  const root = document.createElement("div");
  root.className = "settings-stack";

  const memorySection = document.createElement("section");
  memorySection.className = "section";
  memorySection.innerHTML = `
    <h3>Memory Settings</h3>
    <p class="section-note">Settings are stored in chrome.storage.local on this browser profile.</p>
  `;

  const form = document.createElement("form");
  form.className = "settings-form";
  form.innerHTML = `
    <label class="settings-row">
      <span>Sleep tabs after inactivity (minutes)</span>
      <input name="inactivityMinutes" type="number" min="5" step="5" value="${state.dashboard.settings.inactivityMinutes}" required />
    </label>
    <label class="settings-row">
      <span>Sleep unfocused workspace after (minutes)</span>
      <input name="unfocusedSleepMinutes" type="number" min="10" step="5" value="${state.dashboard.settings.unfocusedSleepMinutes}" required />
    </label>
    <label class="settings-row">
      <span>Snapshots retained per workspace</span>
      <input name="maxSnapshotsPerWorkspace" type="number" min="5" step="1" value="${state.dashboard.settings.maxSnapshotsPerWorkspace}" required />
    </label>
    <label class="settings-row">
      <span>Unsplash Access Key for new tab backgrounds</span>
      <input name="unsplashAccessKey" type="text" placeholder="Optional" value="${state.dashboard.settings.unsplashAccessKey || ""}" />
    </label>
    <button class="primary" type="submit">Save Settings</button>
  `;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const inactivityMinutes = Number(formData.get("inactivityMinutes"));
    const unfocusedSleepMinutes = Number(formData.get("unfocusedSleepMinutes"));
    const maxSnapshotsPerWorkspace = Number(formData.get("maxSnapshotsPerWorkspace"));
    const unsplashAccessKey = String(formData.get("unsplashAccessKey") || "").trim();

    void runAction(
      () =>
        send("UPDATE_SETTINGS", {
          windowId: state.windowId,
          settings: {
            inactivityMinutes,
            unfocusedSleepMinutes,
            maxSnapshotsPerWorkspace,
            unsplashAccessKey
          }
        }),
      "Settings saved."
    );
  });

  memorySection.appendChild(form);
  root.appendChild(memorySection);

  const managerSection = document.createElement("section");
  managerSection.className = "section";
  managerSection.innerHTML = `
    <h3>Workspace Manager</h3>
    <p class="section-note">Archive hides a workspace from the left rail and converts any open tabs in it into sleeping tabs. Archived workspaces can be restored later.</p>
  `;

  const activeWorkspaces = Array.isArray(state.dashboard.workspaces) ? state.dashboard.workspaces : [];
  const archivedWorkspaces = Array.isArray(state.dashboard.archivedWorkspaces) ? state.dashboard.archivedWorkspaces : [];

  const activeList = document.createElement("div");
  activeList.className = "manager-list";
  const activeHeading = document.createElement("p");
  activeHeading.className = "manager-heading";
  activeHeading.textContent = `Active Workspaces (${activeWorkspaces.length})`;
  managerSection.appendChild(activeHeading);

  if (activeWorkspaces.length === 0) {
    activeList.appendChild(renderEmpty("No active workspaces."));
  } else {
    for (const managedWorkspace of activeWorkspaces) {
      const summaryParts = [
        `${managedWorkspace.sessionTabs.length} sleeping`,
        `${managedWorkspace.resources.length} resources`
      ];
      if (managedWorkspace.id === state.dashboard.activeWorkspaceId) {
        summaryParts.unshift("Currently selected");
      }

      const card = makeItemCard({
        title: managedWorkspace.name,
        subtitle: summaryParts.join(" • "),
        actions: [
          {
            label: "Archive",
            className: "danger",
            onClick: () => {
              const confirmed = window.confirm(`Archive workspace "${managedWorkspace.name}"?`);
              if (!confirmed) {
                return;
              }
              void runAction(
                () =>
                  send("ARCHIVE_WORKSPACE", {
                    windowId: state.windowId,
                    workspaceId: managedWorkspace.id
                  }),
                "Workspace archived."
              );
            }
          }
        ]
      });
      activeList.appendChild(card);
    }
  }

  managerSection.appendChild(activeList);

  const archivedHeading = document.createElement("p");
  archivedHeading.className = "manager-heading";
  archivedHeading.textContent = `Archived Workspaces (${archivedWorkspaces.length})`;
  managerSection.appendChild(archivedHeading);

  const archivedList = document.createElement("div");
  archivedList.className = "manager-list";
  if (archivedWorkspaces.length === 0) {
    archivedList.appendChild(renderEmpty("No archived workspaces."));
  } else {
    for (const archivedWorkspace of archivedWorkspaces) {
      const card = makeItemCard({
        title: archivedWorkspace.name,
        subtitle: `${archivedWorkspace.sessionTabs.length} sleeping • ${archivedWorkspace.resources.length} resources`,
        actions: [
          {
            label: "Restore",
            className: "primary",
            onClick: () =>
              runAction(
                () =>
                  send("RESTORE_WORKSPACE", {
                    workspaceId: archivedWorkspace.id
                  }),
                "Workspace restored."
              )
          }
        ]
      });
      archivedList.appendChild(card);
    }
  }

  managerSection.appendChild(archivedList);
  root.appendChild(managerSection);
  return root;
}

function renderMainContent() {
  const workspace = currentWorkspace();
  ui.content.textContent = "";
  clearToast();

  if (!workspace) {
    ui.content.appendChild(renderEmpty("No active workspace."));
    return;
  }

  if (state.activeView === "tabs") {
    ui.content.appendChild(renderTabsView(workspace));
  } else if (state.activeView === "history") {
    ui.content.appendChild(renderHistoryView(workspace));
  } else if (state.activeView === "resources") {
    ui.content.appendChild(renderResourcesView(workspace));
  } else {
    ui.content.appendChild(renderSettingsView());
  }
}

function render() {
  const workspace = currentWorkspace();
  if (!workspace) {
    return;
  }

  renderWorkspaceList();
  renderParkedWorkspaceList();
  ui.workspaceName.textContent = workspace.name;
  ui.workspaceMeta.textContent = `${state.dashboard.openTabs.length} open • ${workspace.sessionTabs.length} sleeping • ${workspace.resources.length} resources`;
  applyWorkspaceIdentity(workspace);

  for (const button of ui.tabButtons) {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  }
  ui.settingsRailButton.classList.toggle("active", state.activeView === "settings");

  renderMainContent();
}

async function refreshDashboard(silent = false) {
  try {
    const dashboard = await send("GET_DASHBOARD_DATA", { windowId: state.windowId });
    state.dashboard = dashboard;
    render();
  } catch (error) {
    if (!silent) {
      setToast(error.message || "Could not load workspace data.", "error");
    }
  }
}

async function runAction(action, successMessage) {
  try {
    await action();
    await refreshDashboard(true);
    setToast(successMessage, "success");
  } catch (error) {
    setToast(error.message || "Action failed.", "error");
  }
}

function wireEvents() {
  ui.createWorkspaceButton.addEventListener("click", () => {
    const workspaceName = window.prompt("Workspace name");
    if (workspaceName === null) {
      return;
    }
    void runAction(
      () =>
        send("CREATE_WORKSPACE", {
          windowId: state.windowId,
          name: workspaceName
        }),
      "Workspace created."
    );
  });

  ui.sleepButton.addEventListener("click", () => {
    void runAction(
      () =>
        send("SLEEP_ACTIVE_WORKSPACE", {
          windowId: state.windowId,
          reason: "manual"
        }),
      "Open tabs were put to sleep."
    );
  });

  ui.wakeButton.addEventListener("click", () => {
    void runAction(
      () =>
        send("WAKE_SLEEPING_TABS", {
          windowId: state.windowId
        }),
      "Sleeping tabs reopened."
    );
  });

  for (const button of ui.tabButtons) {
    button.addEventListener("click", () => {
      state.activeView = button.dataset.view;
      render();
    });
  }

  ui.settingsRailButton.addEventListener("click", () => {
    state.activeView = "settings";
    render();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "STATE_UPDATED") {
      debounceRefresh();
    }
  });

  chrome.tabs.onCreated.addListener(debounceRefresh);
  chrome.tabs.onRemoved.addListener(debounceRefresh);
  chrome.tabs.onActivated.addListener(debounceRefresh);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
      debounceRefresh();
    }
  });

  window.addEventListener("resize", () => {
    if (!state.dashboard) {
      return;
    }
    renderParkedWorkspaceList();
  });
}

async function init() {
  const windowInfo = await chrome.windows.getCurrent();
  if (typeof windowInfo.id !== "number") {
    throw new Error("Could not determine current window ID.");
  }
  state.windowId = windowInfo.id;
  wireEvents();
  await refreshDashboard();
}

void init();
