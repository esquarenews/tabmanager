const STORAGE_KEY = "workspace_tab_manager_state";
const MEMORY_ALARM = "workspace_tab_memory_sweep";
const NEW_TAB_URL = "chrome://newtab/";
const DASHBOARD_PATH = "dashboard.html";
const OPENABLE_URL_REGEX = /^https?:\/\//i;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const WORKSPACE_COLORS = Object.freeze([
  "#2563EB",
  "#7C3AED",
  "#0F766E",
  "#D97706",
  "#BE123C",
  "#0369A1",
  "#166534",
  "#9333EA",
  "#B45309",
  "#1D4ED8"
]);

const DEFAULT_SETTINGS = Object.freeze({
  inactivityMinutes: 120,
  maxSnapshotsPerWorkspace: 20,
  unfocusedSleepMinutes: 60,
  unsplashAccessKey: "SQ54dvC8cGsSs51mFhu-bb807LDd8FWOP_fm4IqhcMs"
});

let stateCache = null;
let operationQueue = Promise.resolve();

function now() {
  return Date.now();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function windowKey(windowId) {
  return String(windowId);
}

function isOpenableUrl(url) {
  return typeof url === "string" && OPENABLE_URL_REGEX.test(url);
}

function normalizeText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function getDashboardUrl() {
  return chrome.runtime.getURL(DASHBOARD_PATH);
}

function hashText(value) {
  let hash = 0;
  for (const character of value) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }
  return Math.abs(hash);
}

function isValidWorkspaceColor(color) {
  return typeof color === "string" && HEX_COLOR_REGEX.test(color);
}

function colorForWorkspaceSeed(seed) {
  const safeSeed = typeof seed === "string" && seed.length > 0 ? seed : "workspace";
  const index = hashText(safeSeed) % WORKSPACE_COLORS.length;
  return WORKSPACE_COLORS[index];
}

function normalizeWorkspaceColor(color, seed) {
  if (isValidWorkspaceColor(color)) {
    return color.toUpperCase();
  }
  return colorForWorkspaceSeed(seed);
}

function dedupeTabRecords(records) {
  const seen = new Set();
  const output = [];

  for (const record of records) {
    if (!record || !isOpenableUrl(record.url)) {
      continue;
    }
    if (seen.has(record.url)) {
      continue;
    }
    seen.add(record.url);
    output.push({
      url: record.url,
      title: normalizeText(record.title, record.url),
      favIconUrl: typeof record.favIconUrl === "string" ? record.favIconUrl : "",
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : now()
    });
  }

  return output;
}

function normalizeResources(resources) {
  const seen = new Set();
  const output = [];

  for (const resource of resources) {
    if (!resource || !isOpenableUrl(resource.url)) {
      continue;
    }
    if (seen.has(resource.url)) {
      continue;
    }
    seen.add(resource.url);
    output.push({
      id: typeof resource.id === "string" ? resource.id : makeId("res"),
      url: resource.url,
      title: normalizeText(resource.title, resource.url),
      createdAt: Number.isFinite(resource.createdAt) ? resource.createdAt : now()
    });
  }

  return output;
}

function normalizeHistory(snapshots) {
  const output = [];

  for (const snapshot of snapshots) {
    if (!snapshot || !Array.isArray(snapshot.tabs)) {
      continue;
    }
    const tabs = dedupeTabRecords(snapshot.tabs);
    if (tabs.length === 0) {
      continue;
    }
    output.push({
      id: typeof snapshot.id === "string" ? snapshot.id : makeId("snap"),
      createdAt: Number.isFinite(snapshot.createdAt) ? snapshot.createdAt : now(),
      reason: normalizeText(snapshot.reason, "manual"),
      tabs
    });
  }

  return output;
}

function createWorkspace(name, preferredColor = null) {
  const id = makeId("ws");
  const timestamp = now();
  return {
    id,
    name: normalizeText(name, "Workspace"),
    color: normalizeWorkspaceColor(preferredColor, id),
    parkedTabs: [],
    sessionTabs: [],
    resources: [],
    history: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivatedAt: null,
    archivedAt: null
  };
}

function createInitialState() {
  const firstWorkspace = createWorkspace("Workspace 1", WORKSPACE_COLORS[0]);
  return {
    version: 2,
    settings: { ...DEFAULT_SETTINGS },
    workspaceOrder: [firstWorkspace.id],
    archivedWorkspaceOrder: [],
    workspaces: {
      [firstWorkspace.id]: firstWorkspace
    },
    activeWorkspaceByWindow: {},
    tabWorkspaceById: {},
    deferredSleepByWindow: {},
    parkedWindowByWorkspace: {}
  };
}

function normalizeWorkspace(id, workspace) {
  const timestamp = now();
  return {
    id,
    name: normalizeText(workspace.name, "Workspace"),
    color: normalizeWorkspaceColor(workspace.color, id),
    parkedTabs: dedupeTabRecords(Array.isArray(workspace.parkedTabs) ? workspace.parkedTabs : []),
    sessionTabs: dedupeTabRecords(Array.isArray(workspace.sessionTabs) ? workspace.sessionTabs : []),
    resources: normalizeResources(Array.isArray(workspace.resources) ? workspace.resources : []),
    history: normalizeHistory(Array.isArray(workspace.history) ? workspace.history : []),
    createdAt: Number.isFinite(workspace.createdAt) ? workspace.createdAt : timestamp,
    updatedAt: Number.isFinite(workspace.updatedAt) ? workspace.updatedAt : timestamp,
    lastActivatedAt: Number.isFinite(workspace.lastActivatedAt) ? workspace.lastActivatedAt : null,
    archivedAt: Number.isFinite(workspace.archivedAt) ? workspace.archivedAt : null
  };
}

function normalizeState(state) {
  if (!state || typeof state !== "object") {
    return createInitialState();
  }

  const workspaces = {};
  if (state.workspaces && typeof state.workspaces === "object") {
    for (const [workspaceId, workspace] of Object.entries(state.workspaces)) {
      if (!workspace || typeof workspace !== "object") {
        continue;
      }
      workspaces[workspaceId] = normalizeWorkspace(workspaceId, workspace);
    }
  }

  const workspaceOrder = Array.isArray(state.workspaceOrder)
    ? state.workspaceOrder.filter(
      (workspaceId) =>
        typeof workspaceId === "string" &&
        workspaces[workspaceId] &&
        !Number.isFinite(workspaces[workspaceId].archivedAt)
    )
    : [];

  const archivedWorkspaceOrder = Array.isArray(state.archivedWorkspaceOrder)
    ? state.archivedWorkspaceOrder.filter(
      (workspaceId) =>
        typeof workspaceId === "string" &&
        workspaces[workspaceId] &&
        Number.isFinite(workspaces[workspaceId].archivedAt)
    )
    : [];

  if (workspaceOrder.length === 0 && archivedWorkspaceOrder.length === 0) {
    const workspaceIds = Object.keys(workspaces);
    if (workspaceIds.length === 0) {
      const fallback = createWorkspace("Workspace 1", WORKSPACE_COLORS[0]);
      workspaces[fallback.id] = fallback;
      workspaceOrder.push(fallback.id);
    }
  }

  const seenWorkspaceIds = new Set([...workspaceOrder, ...archivedWorkspaceOrder]);
  for (const workspaceId of Object.keys(workspaces)) {
    if (seenWorkspaceIds.has(workspaceId)) {
      continue;
    }
    if (Number.isFinite(workspaces[workspaceId].archivedAt)) {
      archivedWorkspaceOrder.push(workspaceId);
    } else {
      workspaceOrder.push(workspaceId);
    }
  }

  const activeWorkspaceByWindow = {};
  if (state.activeWorkspaceByWindow && typeof state.activeWorkspaceByWindow === "object") {
    for (const [windowId, workspaceId] of Object.entries(state.activeWorkspaceByWindow)) {
      if (
        typeof workspaceId === "string" &&
        workspaces[workspaceId] &&
        !Number.isFinite(workspaces[workspaceId].archivedAt)
      ) {
        activeWorkspaceByWindow[windowId] = workspaceId;
      }
    }
  }

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(state.settings && typeof state.settings === "object" ? state.settings : {})
  };

  settings.inactivityMinutes = Math.max(5, Number(settings.inactivityMinutes) || DEFAULT_SETTINGS.inactivityMinutes);
  settings.maxSnapshotsPerWorkspace = Math.max(
    5,
    Number(settings.maxSnapshotsPerWorkspace) || DEFAULT_SETTINGS.maxSnapshotsPerWorkspace
  );
  settings.unfocusedSleepMinutes = Math.max(
    10,
    Number(settings.unfocusedSleepMinutes) || DEFAULT_SETTINGS.unfocusedSleepMinutes
  );
  settings.unsplashAccessKey =
    typeof settings.unsplashAccessKey === "string" ? settings.unsplashAccessKey.trim() : DEFAULT_SETTINGS.unsplashAccessKey;

  const tabWorkspaceById = {};
  if (state.tabWorkspaceById && typeof state.tabWorkspaceById === "object") {
    for (const [tabId, workspaceId] of Object.entries(state.tabWorkspaceById)) {
      if (typeof workspaceId === "string" && workspaces[workspaceId]) {
        tabWorkspaceById[tabId] = workspaceId;
      }
    }
  }

  const deferredSleepByWindow = {};
  if (state.deferredSleepByWindow && typeof state.deferredSleepByWindow === "object") {
    for (const [windowId, byWorkspace] of Object.entries(state.deferredSleepByWindow)) {
      if (!byWorkspace || typeof byWorkspace !== "object") {
        continue;
      }
      const cleanByWorkspace = {};
      for (const [workspaceId, payload] of Object.entries(byWorkspace)) {
        if (!workspaces[workspaceId] || !payload || typeof payload !== "object") {
          continue;
        }
        const tabIds = Array.isArray(payload.tabIds)
          ? payload.tabIds.filter((tabId) => Number.isFinite(tabId))
          : [];
        if (tabIds.length === 0) {
          continue;
        }
        const dueAt = Number.isFinite(payload.dueAt) ? payload.dueAt : now();
        cleanByWorkspace[workspaceId] = { tabIds, dueAt };
      }
      if (Object.keys(cleanByWorkspace).length > 0) {
        deferredSleepByWindow[windowId] = cleanByWorkspace;
      }
    }
  }

  const parkedWindowByWorkspace = {};
  if (state.parkedWindowByWorkspace && typeof state.parkedWindowByWorkspace === "object") {
    for (const [workspaceId, parkedWindowId] of Object.entries(state.parkedWindowByWorkspace)) {
      if (!workspaces[workspaceId] || !Number.isFinite(parkedWindowId)) {
        continue;
      }
      parkedWindowByWorkspace[workspaceId] = parkedWindowId;
    }
  }

  return {
    version: 2,
    settings,
    workspaceOrder,
    archivedWorkspaceOrder,
    workspaces,
    activeWorkspaceByWindow,
    tabWorkspaceById,
    deferredSleepByWindow,
    parkedWindowByWorkspace
  };
}

function queueOperation(task) {
  const run = operationQueue.then(task);
  operationQueue = run.catch(() => {});
  return run;
}

async function loadState() {
  if (stateCache) {
    return structuredClone(stateCache);
  }

  const localStored = await chrome.storage.local.get(STORAGE_KEY);
  if (localStored[STORAGE_KEY]) {
    const normalized = normalizeState(localStored[STORAGE_KEY]);
    stateCache = normalized;
    return structuredClone(normalized);
  }

  // One-time migration path from older sync-based storage.
  const syncStored = await chrome.storage.sync.get(STORAGE_KEY);
  if (syncStored[STORAGE_KEY]) {
    const normalized = normalizeState(syncStored[STORAGE_KEY]);
    stateCache = normalized;
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    try {
      await chrome.storage.sync.remove(STORAGE_KEY);
    } catch (error) {
      console.warn("Could not clear legacy sync state:", error);
    }
    return structuredClone(normalized);
  }

  const initial = createInitialState();
  stateCache = initial;
  await chrome.storage.local.set({ [STORAGE_KEY]: initial });
  return structuredClone(initial);
}

async function saveState(nextState) {
  const normalized = normalizeState(nextState);
  stateCache = normalized;
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  return structuredClone(normalized);
}

async function notifyStateUpdated() {
  try {
    await chrome.runtime.sendMessage({ type: "STATE_UPDATED" });
  } catch (error) {
    // Ignore "receiving end does not exist" when no UI is currently open.
  }
}

async function ensureAlarm() {
  const existingAlarm = await chrome.alarms.get(MEMORY_ALARM);
  if (!existingAlarm) {
    await chrome.alarms.create(MEMORY_ALARM, { periodInMinutes: 5 });
  }
}

function ensureWorkspaceForWindow(state, windowId) {
  const key = windowKey(windowId);
  const existingWorkspaceId = state.activeWorkspaceByWindow[key];
  if (
    existingWorkspaceId &&
    state.workspaces[existingWorkspaceId] &&
    !Number.isFinite(state.workspaces[existingWorkspaceId].archivedAt)
  ) {
    return { workspaceId: existingWorkspaceId, changed: false };
  }

  let fallbackWorkspaceId = state.workspaceOrder.find(
    (workspaceId) => state.workspaces[workspaceId] && !Number.isFinite(state.workspaces[workspaceId].archivedAt)
  );
  if (!fallbackWorkspaceId) {
    fallbackWorkspaceId = addWorkspaceToState(state).id;
  }
  state.activeWorkspaceByWindow[key] = fallbackWorkspaceId;
  return { workspaceId: fallbackWorkspaceId, changed: true };
}

async function getManageableWindowTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.filter((tab) => typeof tab.id === "number" && !tab.pinned && isOpenableUrl(tab.url));
}

function setTabAssignments(state, tabIds, workspaceId) {
  if (!state.workspaces[workspaceId]) {
    return;
  }
  for (const tabId of tabIds || []) {
    if (!Number.isFinite(tabId)) {
      continue;
    }
    state.tabWorkspaceById[String(tabId)] = workspaceId;
  }
}

function removeTabIdsFromDeferredSleep(state, tabIds) {
  const removeSet = new Set((tabIds || []).filter((tabId) => Number.isFinite(tabId)));
  if (removeSet.size === 0) {
    return;
  }

  for (const [windowId, byWorkspace] of Object.entries(state.deferredSleepByWindow)) {
    for (const [workspaceId, entry] of Object.entries(byWorkspace)) {
      entry.tabIds = entry.tabIds.filter((tabId) => !removeSet.has(tabId));
      if (entry.tabIds.length === 0) {
        delete byWorkspace[workspaceId];
      }
    }
    if (Object.keys(byWorkspace).length === 0) {
      delete state.deferredSleepByWindow[windowId];
    }
  }
}

function removeTabAssignments(state, tabIds) {
  for (const tabId of tabIds || []) {
    if (!Number.isFinite(tabId)) {
      continue;
    }
    delete state.tabWorkspaceById[String(tabId)];
  }
  removeTabIdsFromDeferredSleep(state, tabIds);
}

function scheduleDeferredSleep(state, windowId, workspaceId, tabIds) {
  const uniqueTabIds = [...new Set((tabIds || []).filter((tabId) => Number.isFinite(tabId)))];
  if (uniqueTabIds.length === 0) {
    return;
  }

  const key = windowKey(windowId);
  if (!state.deferredSleepByWindow[key]) {
    state.deferredSleepByWindow[key] = {};
  }

  state.deferredSleepByWindow[key][workspaceId] = {
    tabIds: uniqueTabIds,
    dueAt: now() + state.settings.unfocusedSleepMinutes * 60 * 1000
  };
}

function clearDeferredSleep(state, windowId, workspaceId) {
  const key = windowKey(windowId);
  if (!state.deferredSleepByWindow[key]) {
    return;
  }
  delete state.deferredSleepByWindow[key][workspaceId];
  if (Object.keys(state.deferredSleepByWindow[key]).length === 0) {
    delete state.deferredSleepByWindow[key];
  }
}

function clearDeferredSleepForWorkspace(state, workspaceId) {
  for (const key of Object.keys(state.deferredSleepByWindow)) {
    if (!state.deferredSleepByWindow[key] || !state.deferredSleepByWindow[key][workspaceId]) {
      continue;
    }
    delete state.deferredSleepByWindow[key][workspaceId];
    if (Object.keys(state.deferredSleepByWindow[key]).length === 0) {
      delete state.deferredSleepByWindow[key];
    }
  }
}

function findWorkspaceIdByParkedWindow(state, parkedWindowId) {
  for (const [workspaceId, candidateWindowId] of Object.entries(state.parkedWindowByWorkspace || {})) {
    if (candidateWindowId === parkedWindowId) {
      return workspaceId;
    }
  }
  return null;
}

async function getValidParkedWindowId(state, workspaceId) {
  const parkedWindowId = state.parkedWindowByWorkspace?.[workspaceId];
  if (!Number.isFinite(parkedWindowId)) {
    return null;
  }
  try {
    await chrome.windows.get(parkedWindowId);
    return parkedWindowId;
  } catch (error) {
    delete state.parkedWindowByWorkspace[workspaceId];
    return null;
  }
}

async function ensureParkedWindow(state, workspaceId) {
  const existingWindowId = await getValidParkedWindowId(state, workspaceId);
  if (Number.isFinite(existingWindowId)) {
    return existingWindowId;
  }

  const created = await chrome.windows.create({
    url: NEW_TAB_URL,
    focused: false,
    state: "minimized"
  });
  if (!Number.isFinite(created?.id)) {
    throw new Error("Could not create parked workspace window.");
  }
  state.parkedWindowByWorkspace[workspaceId] = created.id;
  return created.id;
}

async function cleanupParkedWindow(state, workspaceId) {
  const parkedWindowId = await getValidParkedWindowId(state, workspaceId);
  if (!Number.isFinite(parkedWindowId)) {
    return;
  }

  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId: parkedWindowId });
  } catch (error) {
    delete state.parkedWindowByWorkspace[workspaceId];
    return;
  }

  const removableIds = tabs
    .filter((tab) => Number.isFinite(tab.id) && (tab.url === NEW_TAB_URL || !isOpenableUrl(tab.url)))
    .map((tab) => tab.id);

  const openWorkspaceTabs = tabs.filter(
    (tab) =>
      Number.isFinite(tab.id) &&
      isOpenableUrl(tab.url) &&
      state.tabWorkspaceById[String(tab.id)] === workspaceId
  );

  if (openWorkspaceTabs.length === 0) {
    delete state.parkedWindowByWorkspace[workspaceId];
    try {
      await chrome.windows.remove(parkedWindowId);
    } catch (error) {
      // Window may already be gone.
    }
    return;
  }

  if (removableIds.length > 0) {
    try {
      await chrome.tabs.remove(removableIds);
    } catch (error) {
      // Best effort cleanup.
    }
  }
}

function addWorkspaceToState(state, preferredName = null) {
  const workspaceCount = state.workspaceOrder.length + (state.archivedWorkspaceOrder || []).length;
  const workspaceName = normalizeText(preferredName, `Workspace ${workspaceCount + 1}`);
  const color = WORKSPACE_COLORS[workspaceCount % WORKSPACE_COLORS.length];
  const workspace = createWorkspace(workspaceName, color);
  state.workspaces[workspace.id] = workspace;
  state.workspaceOrder.push(workspace.id);
  return workspace;
}

function reorderWorkspaceOrder(state, requestedOrder) {
  const existing = state.workspaceOrder.filter(
    (workspaceId) => state.workspaces[workspaceId] && !Number.isFinite(state.workspaces[workspaceId].archivedAt)
  );
  const seen = new Set();
  const ordered = [];

  if (Array.isArray(requestedOrder)) {
    for (const workspaceId of requestedOrder) {
      if (
        typeof workspaceId !== "string" ||
        !state.workspaces[workspaceId] ||
        Number.isFinite(state.workspaces[workspaceId].archivedAt) ||
        seen.has(workspaceId)
      ) {
        continue;
      }
      ordered.push(workspaceId);
      seen.add(workspaceId);
    }
  }

  for (const workspaceId of existing) {
    if (seen.has(workspaceId)) {
      continue;
    }
    ordered.push(workspaceId);
    seen.add(workspaceId);
  }

  state.workspaceOrder = ordered;
}

function reorderSleepingTabs(workspace, requestedUrls) {
  const original = Array.isArray(workspace.sessionTabs) ? workspace.sessionTabs : [];
  if (!Array.isArray(requestedUrls) || requestedUrls.length === 0 || original.length < 2) {
    return false;
  }

  const byUrl = new Map(original.map((tab) => [tab.url, tab]));
  const seen = new Set();
  const next = [];

  for (const url of requestedUrls) {
    if (typeof url !== "string" || seen.has(url) || !byUrl.has(url)) {
      continue;
    }
    next.push(byUrl.get(url));
    seen.add(url);
  }

  for (const tab of original) {
    if (!seen.has(tab.url)) {
      next.push(tab);
    }
  }

  const changed = next.some((tab, index) => tab !== original[index]);
  if (changed) {
    workspace.sessionTabs = next;
    workspace.updatedAt = now();
  }

  return changed;
}

async function reorderOpenTabsInWindow(state, windowId, workspaceId, requestedTabOrder) {
  const { tabs } = await getWorkspaceTabsForWindow(state, windowId, workspaceId, {
    assignUnknownToWorkspaceId: workspaceId
  });

  if (tabs.length < 2) {
    return { reordered: false, tabCount: tabs.length };
  }

  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const seen = new Set();
  const finalOrder = [];

  if (Array.isArray(requestedTabOrder)) {
    for (const tabId of requestedTabOrder) {
      if (!Number.isFinite(tabId) || !byId.has(tabId) || seen.has(tabId)) {
        continue;
      }
      finalOrder.push(tabId);
      seen.add(tabId);
    }
  }

  for (const tab of tabs) {
    if (!seen.has(tab.id)) {
      finalOrder.push(tab.id);
    }
  }

  const currentOrder = tabs.map((tab) => tab.id);
  const unchanged = currentOrder.length === finalOrder.length && currentOrder.every((tabId, idx) => tabId === finalOrder[idx]);
  if (unchanged) {
    return { reordered: false, tabCount: finalOrder.length };
  }

  const indices = tabs.map((tab) => tab.index).filter((index) => Number.isFinite(index));
  const startIndex = indices.length > 0 ? Math.min(...indices) : 1;

  for (const [position, tabId] of finalOrder.entries()) {
    try {
      await chrome.tabs.move(tabId, { windowId, index: startIndex + position });
    } catch (error) {
      console.warn("Failed to reorder tab:", tabId, error);
    }
  }

  return { reordered: true, tabCount: finalOrder.length };
}

function moveSleepingTabBetweenWorkspaces(state, sourceWorkspaceId, targetWorkspaceId, url, title = "") {
  const sourceWorkspace = state.workspaces[sourceWorkspaceId];
  const targetWorkspace = state.workspaces[targetWorkspaceId];
  if (!sourceWorkspace || !targetWorkspace) {
    throw new Error("Workspace not found.");
  }
  if (sourceWorkspaceId === targetWorkspaceId) {
    return { moved: false };
  }

  const sourceTabs = Array.isArray(sourceWorkspace.sessionTabs) ? sourceWorkspace.sessionTabs : [];
  const sourceIndex = sourceTabs.findIndex((tab) => tab.url === url);
  if (sourceIndex < 0) {
    throw new Error("Sleeping tab not found.");
  }

  const [tab] = sourceTabs.splice(sourceIndex, 1);
  sourceWorkspace.sessionTabs = sourceTabs;
  sourceWorkspace.updatedAt = now();

  const record = {
    url: tab.url,
    title: normalizeText(tab.title, normalizeText(title, tab.url)),
    favIconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
    createdAt: Number.isFinite(tab.createdAt) ? tab.createdAt : now()
  };

  appendSleepingTabs(targetWorkspace, [record]);
  targetWorkspace.updatedAt = now();
  return { moved: true };
}

async function moveOpenTabToWorkspace(state, windowId, tabId, targetWorkspaceId) {
  if (!Number.isFinite(tabId)) {
    throw new Error("Tab ID is required.");
  }
  if (!state.workspaces[targetWorkspaceId] || Number.isFinite(state.workspaces[targetWorkspaceId].archivedAt)) {
    throw new Error("Target workspace not found.");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab || tab.pinned || !isOpenableUrl(tab.url)) {
    throw new Error("Tab cannot be moved.");
  }

  const sourceWorkspaceId =
    state.tabWorkspaceById[String(tabId)] || state.activeWorkspaceByWindow[windowKey(windowId)] || targetWorkspaceId;
  if (sourceWorkspaceId === targetWorkspaceId) {
    return { moved: false };
  }

  state.tabWorkspaceById[String(tabId)] = targetWorkspaceId;
  removeTabIdsFromDeferredSleep(state, [tabId]);

  if (state.workspaces[sourceWorkspaceId]) {
    state.workspaces[sourceWorkspaceId].updatedAt = now();
  }
  state.workspaces[targetWorkspaceId].updatedAt = now();
  return {
    moved: true,
    sourceWorkspaceId,
    targetWorkspaceId
  };
}

async function parkWorkspaceTabsFromWindow(state, windowId, workspaceId) {
  if (!state.workspaces[workspaceId] || Number.isFinite(state.workspaces[workspaceId].archivedAt)) {
    return { parkedCount: 0 };
  }

  const workspace = state.workspaces[workspaceId];
  const { tabs } = await getWorkspaceTabsForWindow(state, windowId, workspaceId, {
    assignUnknownToWorkspaceId: workspaceId
  });
  if (tabs.length === 0) {
    workspace.parkedTabs = [];
    clearDeferredSleepForWorkspace(state, workspaceId);
    await cleanupParkedWindow(state, workspaceId);
    return { parkedCount: 0 };
  }

  const parkedWindowId = await ensureParkedWindow(state, workspaceId);
  const orderedTabs = [...tabs].sort((a, b) => a.index - b.index);
  const movedTabIds = [];
  const movedRecords = [];

  for (const tab of orderedTabs) {
    if (!Number.isFinite(tab.id)) {
      continue;
    }
    try {
      await chrome.tabs.move(tab.id, { windowId: parkedWindowId, index: -1 });
      movedTabIds.push(tab.id);
      movedRecords.push(tabToRecord(tab));
    } catch (error) {
      console.warn("Failed to park workspace tab:", tab.id, error);
    }
  }

  workspace.parkedTabs = dedupeTabRecords(movedRecords);
  clearDeferredSleepForWorkspace(state, workspaceId);
  await cleanupParkedWindow(state, workspaceId);
  return { parkedCount: movedTabIds.length, parkedWindowId };
}

async function restoreParkedWorkspaceTabsToWindow(state, windowId, workspaceId) {
  if (!state.workspaces[workspaceId] || Number.isFinite(state.workspaces[workspaceId].archivedAt)) {
    return { restoredCount: 0 };
  }

  const workspace = state.workspaces[workspaceId];
  const parkedWindowId = await getValidParkedWindowId(state, workspaceId);
  if (!Number.isFinite(parkedWindowId) || parkedWindowId === windowId) {
    clearDeferredSleepForWorkspace(state, workspaceId);
    moveParkedTabsToSleeping(state, workspace, "parked-window-closed");
    return { restoredCount: 0 };
  }

  const parkedTabs = await chrome.tabs.query({ windowId: parkedWindowId });
  const workspaceTabs = parkedTabs
    .filter(
      (tab) =>
        Number.isFinite(tab.id) &&
        !tab.pinned &&
        isOpenableUrl(tab.url) &&
        state.tabWorkspaceById[String(tab.id)] === workspaceId
    )
    .sort((a, b) => a.index - b.index);

  if (workspaceTabs.length === 0) {
    clearDeferredSleepForWorkspace(state, workspaceId);
    await cleanupParkedWindow(state, workspaceId);
    moveParkedTabsToSleeping(state, workspace, "parked-window-closed");
    return { restoredCount: 0 };
  }

  const remainingRecords = [];
  let restoredCount = 0;
  for (const tab of workspaceTabs) {
    try {
      await chrome.tabs.move(tab.id, { windowId, index: -1 });
      restoredCount += 1;
    } catch (error) {
      console.warn("Failed to restore parked tab:", tab.id, error);
      remainingRecords.push(tabToRecord(tab));
    }
  }

  workspace.parkedTabs = dedupeTabRecords(remainingRecords);
  clearDeferredSleepForWorkspace(state, workspaceId);
  await cleanupParkedWindow(state, workspaceId);
  return { restoredCount };
}

async function syncWindowWorkspaceVisibility(state, windowId, activeWorkspaceId) {
  const manageableTabs = await getManageableWindowTabs(windowId);
  const workspaceIdsToPark = new Set();
  let changed = false;

  for (const tab of manageableTabs) {
    const tabIdKey = String(tab.id);
    let assignedWorkspaceId = state.tabWorkspaceById[tabIdKey];
    if (!assignedWorkspaceId || !state.workspaces[assignedWorkspaceId] || Number.isFinite(state.workspaces[assignedWorkspaceId].archivedAt)) {
      assignedWorkspaceId = activeWorkspaceId;
      state.tabWorkspaceById[tabIdKey] = activeWorkspaceId;
      changed = true;
    }
    if (assignedWorkspaceId !== activeWorkspaceId) {
      workspaceIdsToPark.add(assignedWorkspaceId);
    }
  }

  for (const workspaceId of workspaceIdsToPark) {
    const result = await parkWorkspaceTabsFromWindow(state, windowId, workspaceId);
    if (result.parkedCount > 0) {
      changed = true;
    }
  }

  return { changed };
}

async function activateOrOpenWorkspaceTab(state, windowId, workspaceId, tabId, url, title = "") {
  const workspace = state.workspaces[workspaceId];
  if (!workspace || Number.isFinite(workspace.archivedAt)) {
    throw new Error("Workspace not found.");
  }

  if (Number.isFinite(tabId)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && !tab.pinned && isOpenableUrl(tab.url)) {
        const tabWindowId = Number.isFinite(tab.windowId) ? tab.windowId : windowId;
        state.tabWorkspaceById[String(tabId)] = workspaceId;
        removeTabIdsFromDeferredSleep(state, [tabId]);
        state.activeWorkspaceByWindow[windowKey(tabWindowId)] = workspaceId;

        await chrome.tabs.update(tabId, { active: true });
        try {
          await chrome.windows.update(tabWindowId, { focused: true });
        } catch (error) {
          // Best effort only.
        }

        workspace.updatedAt = now();
        workspace.lastActivatedAt = now();
        return { activated: true, openedCount: 0, tabId };
      }
    } catch (error) {
      // Tab may already be closed; fall through to URL open fallback.
    }
  }

  if (!isOpenableUrl(url)) {
    throw new Error("Tab is no longer available to open.");
  }

  const openResult = await openTabRecords(
    windowId,
    [
      {
        url,
        title: normalizeText(title, url),
        createdAt: now()
      }
    ],
    { openFallback: false, activateFirst: true }
  );
  setTabAssignments(state, openResult.tabIds, workspaceId);
  workspace.sessionTabs = workspace.sessionTabs.filter((tab) => tab.url !== url);
  workspace.updatedAt = now();
  workspace.lastActivatedAt = now();
  state.activeWorkspaceByWindow[windowKey(windowId)] = workspaceId;
  return {
    activated: false,
    openedCount: openResult.openedCount,
    tabId: openResult.tabIds[0] || null
  };
}

async function getWorkspaceTabsForWindow(state, windowId, workspaceId, options = {}) {
  const { assignUnknownToWorkspaceId = null } = options;
  const tabs = await getManageableWindowTabs(windowId);
  const output = [];
  let changed = false;

  for (const tab of tabs) {
    if (!Number.isFinite(tab.id)) {
      continue;
    }

    const key = String(tab.id);
    let assignedWorkspaceId = state.tabWorkspaceById[key];
    if (!assignedWorkspaceId || !state.workspaces[assignedWorkspaceId]) {
      if (assignUnknownToWorkspaceId && state.workspaces[assignUnknownToWorkspaceId]) {
        assignedWorkspaceId = assignUnknownToWorkspaceId;
        state.tabWorkspaceById[key] = assignUnknownToWorkspaceId;
        changed = true;
      } else {
        continue;
      }
    }

    if (assignedWorkspaceId === workspaceId) {
      output.push(tab);
    }
  }

  return { tabs: output, changed };
}

function tabToRecord(tab) {
  return {
    url: tab.url || "",
    title: normalizeText(tab.title, tab.url || "Untitled"),
    favIconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
    createdAt: now()
  };
}

function appendSleepingTabs(workspace, records) {
  workspace.sessionTabs = dedupeTabRecords([...(records || []), ...(workspace.sessionTabs || [])]);
}

function pushSnapshot(workspace, records, reason, maxSnapshots) {
  const tabs = dedupeTabRecords(records || []);
  if (tabs.length === 0) {
    return;
  }
  workspace.history.unshift({
    id: makeId("snap"),
    createdAt: now(),
    reason,
    tabs
  });
  workspace.history = workspace.history.slice(0, maxSnapshots);
}

function moveParkedTabsToSleeping(state, workspace, reason) {
  const parkedRecords = dedupeTabRecords(Array.isArray(workspace?.parkedTabs) ? workspace.parkedTabs : []);
  if (parkedRecords.length === 0) {
    workspace.parkedTabs = [];
    return 0;
  }

  appendSleepingTabs(workspace, parkedRecords);
  pushSnapshot(workspace, parkedRecords, reason, state.settings.maxSnapshotsPerWorkspace);
  workspace.parkedTabs = [];
  workspace.updatedAt = now();
  return parkedRecords.length;
}

async function openTabRecords(windowId, records, options = {}) {
  const { openFallback = true, activateFirst = true } = options;
  const openableRecords = dedupeTabRecords(records || []);
  const tabIds = [];

  if (openableRecords.length === 0) {
    if (openFallback) {
      const created = await chrome.tabs.create({ windowId, url: NEW_TAB_URL, active: activateFirst });
      if (Number.isFinite(created.id)) {
        tabIds.push(created.id);
      }
      return { openedCount: 1, tabIds };
    }
    return { openedCount: 0, tabIds };
  }

  let openedCount = 0;
  let first = true;
  for (const record of openableRecords) {
    try {
      const created = await chrome.tabs.create({
        windowId,
        url: record.url,
        active: activateFirst && first
      });
      if (Number.isFinite(created.id)) {
        tabIds.push(created.id);
      }
      openedCount += 1;
      first = false;
    } catch (error) {
      console.warn("Failed to open tab for record:", record.url, error);
    }
  }

  if (openedCount === 0 && openFallback) {
    const created = await chrome.tabs.create({ windowId, url: NEW_TAB_URL, active: activateFirst });
    if (Number.isFinite(created.id)) {
      tabIds.push(created.id);
    }
    return { openedCount: 1, tabIds };
  }

  return { openedCount, tabIds };
}

async function closeTabsKeepingWindow(windowId, tabIds, state = null) {
  const uniqueTabIds = [...new Set((tabIds || []).filter((tabId) => typeof tabId === "number"))];
  if (uniqueTabIds.length === 0) {
    return 0;
  }

  const windowTabs = await chrome.tabs.query({ windowId });
  const windowTabIds = windowTabs.map((tab) => tab.id).filter((tabId) => typeof tabId === "number");

  if (windowTabIds.length > 0 && uniqueTabIds.length >= windowTabIds.length) {
    await chrome.tabs.create({ windowId, url: NEW_TAB_URL, active: false });
  }

  try {
    await chrome.tabs.remove(uniqueTabIds);
  } catch (error) {
    console.warn("Some tabs could not be removed:", error);
  }

  if (state) {
    removeTabAssignments(state, uniqueTabIds);
  }

  return uniqueTabIds.length;
}

async function sleepActiveWorkspaceTabs(state, windowId, reason) {
  const ensured = ensureWorkspaceForWindow(state, windowId);
  const workspace = state.workspaces[ensured.workspaceId];

  const { tabs } = await getWorkspaceTabsForWindow(state, windowId, ensured.workspaceId, {
    assignUnknownToWorkspaceId: ensured.workspaceId
  });
  if (tabs.length === 0) {
    return { workspaceId: ensured.workspaceId, sleptCount: 0 };
  }

  const records = dedupeTabRecords(tabs.map(tabToRecord));
  appendSleepingTabs(workspace, records);
  pushSnapshot(workspace, records, reason, state.settings.maxSnapshotsPerWorkspace);
  workspace.updatedAt = now();

  await closeTabsKeepingWindow(
    windowId,
    tabs.map((tab) => tab.id),
    state
  );

  clearDeferredSleep(state, windowId, workspace.id);

  return { workspaceId: ensured.workspaceId, sleptCount: records.length };
}

async function switchWorkspaceInWindow(state, windowId, targetWorkspaceId) {
  if (!state.workspaces[targetWorkspaceId] || Number.isFinite(state.workspaces[targetWorkspaceId].archivedAt)) {
    throw new Error("Workspace not found.");
  }

  const key = windowKey(windowId);
  const currentWorkspaceId = state.activeWorkspaceByWindow[key];
  if (currentWorkspaceId === targetWorkspaceId) {
    const visibilityResult = await syncWindowWorkspaceVisibility(state, windowId, targetWorkspaceId);
    const restoreResult = await restoreParkedWorkspaceTabsToWindow(state, windowId, targetWorkspaceId);
    return {
      activeWorkspaceId: targetWorkspaceId,
      openedCount: restoreResult.restoredCount,
      sleptCount: 0,
      parkedCount: 0,
      visibilityChanged: visibilityResult.changed
    };
  }

  let parkedCount = 0;
  if (currentWorkspaceId && state.workspaces[currentWorkspaceId] && !Number.isFinite(state.workspaces[currentWorkspaceId].archivedAt)) {
    const parkResult = await parkWorkspaceTabsFromWindow(state, windowId, currentWorkspaceId);
    parkedCount = parkResult.parkedCount;
  }

  const targetWorkspace = state.workspaces[targetWorkspaceId];
  let openedCount = 0;
  const restoreResult = await restoreParkedWorkspaceTabsToWindow(state, windowId, targetWorkspaceId);
  openedCount += restoreResult.restoredCount;

  const { tabs: visibleTargetTabs } = await getWorkspaceTabsForWindow(state, windowId, targetWorkspaceId, {
    assignUnknownToWorkspaceId: targetWorkspaceId
  });

  if (visibleTargetTabs.length === 0) {
    const openResult = await openTabRecords(windowId, targetWorkspace.sessionTabs, {
      openFallback: false,
      activateFirst: false
    });
    openedCount += openResult.openedCount;
    setTabAssignments(state, openResult.tabIds, targetWorkspaceId);
    if (openResult.openedCount > 0) {
      targetWorkspace.sessionTabs = [];
    }
  }

  targetWorkspace.updatedAt = now();
  targetWorkspace.lastActivatedAt = now();

  state.activeWorkspaceByWindow[key] = targetWorkspaceId;
  const visibilityResult = await syncWindowWorkspaceVisibility(state, windowId, targetWorkspaceId);

  return {
    activeWorkspaceId: targetWorkspaceId,
    openedCount,
    sleptCount: 0,
    parkedCount,
    visibilityChanged: visibilityResult.changed
  };
}

function addResource(workspace, url, title) {
  if (!isOpenableUrl(url)) {
    throw new Error("Only http/https URLs can be added to resources.");
  }

  const existing = workspace.resources.find((resource) => resource.url === url);
  if (existing) {
    return existing;
  }

  const resource = {
    id: makeId("res"),
    url,
    title: normalizeText(title, url),
    createdAt: now()
  };
  workspace.resources.unshift(resource);
  workspace.updatedAt = now();
  return resource;
}

function removeSleepingTab(workspace, url) {
  const before = workspace.sessionTabs.length;
  workspace.sessionTabs = workspace.sessionTabs.filter((tab) => tab.url !== url);
  if (workspace.sessionTabs.length !== before) {
    workspace.updatedAt = now();
    return true;
  }
  return false;
}

async function sleepWorkspaceTabsAcrossWindows(state, workspaceId, reason) {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    return { sleptCount: 0 };
  }

  const openTabs = await chrome.tabs.query({});
  const matchingTabs = openTabs.filter(
    (tab) =>
      Number.isFinite(tab?.id) &&
      Number.isFinite(tab?.windowId) &&
      !tab.pinned &&
      isOpenableUrl(tab.url) &&
      state.tabWorkspaceById[String(tab.id)] === workspaceId
  );

  if (matchingTabs.length === 0) {
    return { sleptCount: 0 };
  }

  const records = dedupeTabRecords(matchingTabs.map(tabToRecord));
  if (records.length > 0) {
    appendSleepingTabs(workspace, records);
    pushSnapshot(workspace, records, reason, state.settings.maxSnapshotsPerWorkspace);
    workspace.updatedAt = now();
  }
  workspace.parkedTabs = [];

  const tabIdsByWindow = new Map();
  for (const tab of matchingTabs) {
    if (!tabIdsByWindow.has(tab.windowId)) {
      tabIdsByWindow.set(tab.windowId, []);
    }
    tabIdsByWindow.get(tab.windowId).push(tab.id);
  }

  for (const [windowId, tabIds] of tabIdsByWindow.entries()) {
    await closeTabsKeepingWindow(windowId, tabIds, state);
  }

  clearDeferredSleepForWorkspace(state, workspaceId);
  await cleanupParkedWindow(state, workspaceId);
  return { sleptCount: records.length };
}

async function archiveWorkspace(state, windowId, workspaceId) {
  const workspace = state.workspaces[workspaceId];
  if (!workspace || Number.isFinite(workspace.archivedAt)) {
    throw new Error("Workspace not found.");
  }

  let fallbackWorkspaceId = state.workspaceOrder.find(
    (candidateId) => candidateId !== workspaceId && state.workspaces[candidateId] && !Number.isFinite(state.workspaces[candidateId].archivedAt)
  );
  if (!fallbackWorkspaceId) {
    fallbackWorkspaceId = addWorkspaceToState(state).id;
  }

  const currentWindowKey = windowKey(windowId);
  const currentWasActive = state.activeWorkspaceByWindow[currentWindowKey] === workspaceId;

  const sleepResult = await sleepWorkspaceTabsAcrossWindows(state, workspaceId, "archive");

  workspace.archivedAt = now();
  workspace.updatedAt = now();
  state.workspaceOrder = state.workspaceOrder.filter((candidateId) => candidateId !== workspaceId);
  state.archivedWorkspaceOrder = [workspaceId, ...(state.archivedWorkspaceOrder || []).filter((candidateId) => candidateId !== workspaceId)];
  clearDeferredSleepForWorkspace(state, workspaceId);

  if (currentWasActive) {
    state.activeWorkspaceByWindow[currentWindowKey] = workspaceId;
    await switchWorkspaceInWindow(state, windowId, fallbackWorkspaceId);
  }

  for (const [key, activeWorkspaceId] of Object.entries(state.activeWorkspaceByWindow)) {
    if (activeWorkspaceId === workspaceId) {
      state.activeWorkspaceByWindow[key] = fallbackWorkspaceId;
    }
  }

  return {
    archived: true,
    workspaceId,
    fallbackWorkspaceId,
    sleptCount: sleepResult.sleptCount
  };
}

function restoreWorkspace(state, workspaceId) {
  const workspace = state.workspaces[workspaceId];
  if (!workspace || !Number.isFinite(workspace.archivedAt)) {
    throw new Error("Archived workspace not found.");
  }

  workspace.archivedAt = null;
  workspace.updatedAt = now();
  state.archivedWorkspaceOrder = (state.archivedWorkspaceOrder || []).filter((candidateId) => candidateId !== workspaceId);
  state.workspaceOrder.push(workspaceId);
  return { restored: true, workspaceId };
}

function serializeWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    color: workspace.color,
    sessionTabs: workspace.sessionTabs,
    resources: workspace.resources,
    history: workspace.history,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    lastActivatedAt: workspace.lastActivatedAt,
    archivedAt: workspace.archivedAt,
    isArchived: Number.isFinite(workspace.archivedAt)
  };
}

async function fetchCurrentWindowId() {
  const currentWindow = await chrome.windows.getCurrent();
  if (typeof currentWindow.id !== "number") {
    throw new Error("Could not detect current window.");
  }
  return currentWindow.id;
}

async function openOrFocusDashboard(windowId) {
  const dashboardUrl = getDashboardUrl();
  const windowTabs = await chrome.tabs.query({ windowId });
  const dashboardTabs = windowTabs
    .filter((tab) => typeof tab.id === "number" && typeof tab.url === "string" && tab.url.startsWith(dashboardUrl))
    .sort((a, b) => (Number.isFinite(a.index) ? a.index : 9999) - (Number.isFinite(b.index) ? b.index : 9999));

  const existingDashboardTab = dashboardTabs[0];

  if (existingDashboardTab && typeof existingDashboardTab.id === "number") {
    await chrome.tabs.update(existingDashboardTab.id, { active: true, pinned: true });
    await chrome.tabs.move(existingDashboardTab.id, { windowId, index: 0 });

    const duplicateDashboardTabIds = dashboardTabs
      .slice(1)
      .map((tab) => tab.id)
      .filter((tabId) => typeof tabId === "number");
    if (duplicateDashboardTabIds.length > 0) {
      await chrome.tabs.remove(duplicateDashboardTabIds);
    }

    return { reused: true, tabId: existingDashboardTab.id };
  }

  const created = await chrome.tabs.create({
    windowId,
    url: dashboardUrl,
    active: true,
    pinned: true,
    index: 0
  });

  if (typeof created.id === "number") {
    await chrome.tabs.move(created.id, { windowId, index: 0 });
  }

  return {
    reused: false,
    tabId: Number.isFinite(created.id) ? created.id : null
  };
}

async function openDashboardInAllNormalWindows() {
  const state = await loadState();
  const parkedWindowIds = new Set(
    Object.values(state.parkedWindowByWorkspace || {}).filter((windowId) => Number.isFinite(windowId))
  );
  const browserWindows = await chrome.windows.getAll();
  for (const browserWindow of browserWindows) {
    if (!Number.isFinite(browserWindow?.id)) {
      continue;
    }
    if (parkedWindowIds.has(browserWindow.id)) {
      continue;
    }
    if (browserWindow.type && browserWindow.type !== "normal") {
      continue;
    }
    if (browserWindow.incognito) {
      continue;
    }
    try {
      await openOrFocusDashboard(browserWindow.id);
    } catch (error) {
      console.warn("Could not open dashboard for window:", browserWindow.id, error);
    }
  }
}

async function getOpenTabsForWindow(state, windowId, workspaceId) {
  const { tabs, changed } = await getWorkspaceTabsForWindow(state, windowId, workspaceId, {
    assignUnknownToWorkspaceId: workspaceId
  });

  return {
    changed,
    openTabs: tabs
    .map((tab) => ({
      id: tab.id,
      url: tab.url || "",
      title: normalizeText(tab.title, tab.url || "Untitled"),
      favIconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
      active: !!tab.active,
      lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null
    }))
  };
}

function buildDashboardPayload(state, windowId, openTabs) {
  const activeWorkspaceId = state.activeWorkspaceByWindow[windowKey(windowId)] || state.workspaceOrder[0];
  const orderedWorkspaces = state.workspaceOrder.map((workspaceId) => serializeWorkspace(state.workspaces[workspaceId]));
  const archivedWorkspaces = (state.archivedWorkspaceOrder || []).map((workspaceId) =>
    serializeWorkspace(state.workspaces[workspaceId])
  );
  const parkedWorkspaces = orderedWorkspaces.filter((workspace) =>
    Number.isFinite(state.parkedWindowByWorkspace?.[workspace.id])
  );

  return {
    windowId,
    activeWorkspaceId,
    workspaces: orderedWorkspaces,
    parkedWorkspaces,
    archivedWorkspaces,
    activeWorkspace: serializeWorkspace(state.workspaces[activeWorkspaceId]),
    openTabs,
    settings: state.settings
  };
}

async function getDashboardData(windowId) {
  return queueOperation(async () => {
    const state = await loadState();
    const working = structuredClone(state);
    const ensured = ensureWorkspaceForWindow(working, windowId);
    const activeWorkspaceId = ensured.workspaceId;
    const visibilityResult = await syncWindowWorkspaceVisibility(working, windowId, activeWorkspaceId);
    const restoreResult = await restoreParkedWorkspaceTabsToWindow(working, windowId, activeWorkspaceId);
    const openTabsResult = await getOpenTabsForWindow(working, windowId, activeWorkspaceId);

    let finalState = working;
    if (ensured.changed || openTabsResult.changed || visibilityResult.changed || restoreResult.restoredCount > 0) {
      finalState = await saveState(working);
      await notifyStateUpdated();
    }

    return buildDashboardPayload(finalState, windowId, openTabsResult.openTabs);
  });
}

async function mutateState(mutator) {
  return queueOperation(async () => {
    const state = await loadState();
    const working = structuredClone(state);
    const result = await mutator(working);
    await saveState(working);
    await notifyStateUpdated();
    return result;
  });
}

async function runMemorySweep() {
  return mutateState(async (state) => {
    const nowTs = now();
    const cutoff = nowTs - state.settings.inactivityMinutes * 60 * 1000;
    const windows = await chrome.windows.getAll({ populate: true });
    let sleptCount = 0;

    for (const browserWindow of windows) {
      if (typeof browserWindow.id !== "number" || !Array.isArray(browserWindow.tabs)) {
        continue;
      }

      const windowId = browserWindow.id;
      if (findWorkspaceIdByParkedWindow(state, windowId)) {
        delete state.deferredSleepByWindow[windowKey(windowId)];
        continue;
      }
      const activeWorkspaceId = state.activeWorkspaceByWindow[windowKey(windowId)];
      const manageableTabs = browserWindow.tabs.filter(
        (tab) => tab && typeof tab.id === "number" && !tab.pinned && isOpenableUrl(tab.url)
      );

      if (activeWorkspaceId && state.workspaces[activeWorkspaceId]) {
        for (const tab of manageableTabs) {
          const tabIdKey = String(tab.id);
          if (!state.tabWorkspaceById[tabIdKey]) {
            state.tabWorkspaceById[tabIdKey] = activeWorkspaceId;
          }
        }
      }

      if (activeWorkspaceId && state.workspaces[activeWorkspaceId]) {
        const workspace = state.workspaces[activeWorkspaceId];
        const staleTabs = manageableTabs.filter((tab) => {
          if (tab.active) {
            return false;
          }
          if (state.tabWorkspaceById[String(tab.id)] !== activeWorkspaceId) {
            return false;
          }
          if (!Number.isFinite(tab.lastAccessed)) {
            return false;
          }
          return tab.lastAccessed < cutoff;
        });

        if (staleTabs.length > 0) {
          const records = dedupeTabRecords(staleTabs.map(tabToRecord));
          if (records.length > 0) {
            appendSleepingTabs(workspace, records);
            pushSnapshot(workspace, records, "memory", state.settings.maxSnapshotsPerWorkspace);
            workspace.updatedAt = nowTs;
            sleptCount += records.length;

            await closeTabsKeepingWindow(
              windowId,
              staleTabs.map((tab) => tab.id),
              state
            );
          }
        }
      }

      const deferredByWorkspace = state.deferredSleepByWindow[windowKey(windowId)];
      if (!deferredByWorkspace) {
        continue;
      }

      for (const [workspaceId, entry] of Object.entries(deferredByWorkspace)) {
        if (!entry || !Array.isArray(entry.tabIds)) {
          delete deferredByWorkspace[workspaceId];
          continue;
        }
        if (workspaceId === activeWorkspaceId) {
          continue;
        }

        if (!state.workspaces[workspaceId] || !Number.isFinite(entry.dueAt) || entry.dueAt > nowTs) {
          continue;
        }

        const idSet = new Set(entry.tabIds.filter((tabId) => Number.isFinite(tabId)));
        if (idSet.size === 0) {
          delete deferredByWorkspace[workspaceId];
          continue;
        }

        const dueTabs = manageableTabs.filter((tab) => {
          if (!idSet.has(tab.id)) {
            return false;
          }
          return state.tabWorkspaceById[String(tab.id)] === workspaceId;
        });

        const workspace = state.workspaces[workspaceId];
        if (dueTabs.length > 0) {
          const records = dedupeTabRecords(dueTabs.map(tabToRecord));
          if (records.length > 0) {
            appendSleepingTabs(workspace, records);
            pushSnapshot(workspace, records, "unfocused-timeout", state.settings.maxSnapshotsPerWorkspace);
            workspace.updatedAt = nowTs;
            sleptCount += records.length;

            await closeTabsKeepingWindow(
              windowId,
              dueTabs.map((tab) => tab.id),
              state
            );
            if (findWorkspaceIdByParkedWindow(state, windowId) === workspaceId) {
              await cleanupParkedWindow(state, workspaceId);
            }
          }
        }

        delete deferredByWorkspace[workspaceId];
      }

      if (Object.keys(deferredByWorkspace).length === 0) {
        delete state.deferredSleepByWindow[windowKey(windowId)];
      }
    }

    return { sleptCount };
  });
}

async function handleMessage(message) {
  const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
  const requestedWindowId = Number.isFinite(payload.windowId) ? payload.windowId : await fetchCurrentWindowId();

  switch (message.action) {
    case "GET_DASHBOARD_DATA": {
      return getDashboardData(requestedWindowId);
    }

    case "GET_SETTINGS": {
      return queueOperation(async () => {
        const state = await loadState();
        return { settings: state.settings };
      });
    }

    case "CREATE_WORKSPACE": {
      return mutateState(async (state) => {
        const workspaceName = normalizeText(payload.name, `Workspace ${state.workspaceOrder.length + 1}`);
        const newWorkspace = addWorkspaceToState(state, workspaceName);

        const switchResult = await switchWorkspaceInWindow(state, requestedWindowId, newWorkspace.id);
        return {
          workspaceId: newWorkspace.id,
          ...switchResult
        };
      });
    }

    case "RENAME_WORKSPACE": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        workspace.name = normalizeText(payload.name, workspace.name);
        workspace.updatedAt = now();
        return { workspaceId: workspace.id };
      });
    }

    case "UPDATE_WORKSPACE_COLOR": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        if (!isValidWorkspaceColor(payload.color)) {
          throw new Error("Invalid workspace color.");
        }
        workspace.color = payload.color.toUpperCase();
        workspace.updatedAt = now();
        return { workspaceId: workspace.id, color: workspace.color };
      });
    }

    case "REORDER_WORKSPACES": {
      return mutateState(async (state) => {
        reorderWorkspaceOrder(state, payload.workspaceOrder);
        return { workspaceOrder: state.workspaceOrder };
      });
    }

    case "ARCHIVE_WORKSPACE": {
      return mutateState(async (state) => archiveWorkspace(state, requestedWindowId, payload.workspaceId));
    }

    case "RESTORE_WORKSPACE": {
      return mutateState(async (state) => restoreWorkspace(state, payload.workspaceId));
    }

    case "SWITCH_WORKSPACE": {
      return mutateState(async (state) => switchWorkspaceInWindow(state, requestedWindowId, payload.workspaceId));
    }

    case "REORDER_OPEN_TABS": {
      return mutateState(async (state) => {
        const ensured = ensureWorkspaceForWindow(state, requestedWindowId);
        const workspaceId =
          typeof payload.workspaceId === "string" && state.workspaces[payload.workspaceId]
            ? payload.workspaceId
            : ensured.workspaceId;
        const result = await reorderOpenTabsInWindow(state, requestedWindowId, workspaceId, payload.orderedTabIds);
        return {
          workspaceId,
          ...result
        };
      });
    }

    case "SLEEP_ACTIVE_WORKSPACE": {
      const reason = normalizeText(payload.reason, "manual");
      return mutateState(async (state) => sleepActiveWorkspaceTabs(state, requestedWindowId, reason));
    }

    case "WAKE_SLEEPING_TABS": {
      return mutateState(async (state) => {
        const ensured = ensureWorkspaceForWindow(state, requestedWindowId);
        const workspace = state.workspaces[ensured.workspaceId];
        const openResult = await openTabRecords(requestedWindowId, workspace.sessionTabs, { openFallback: false });
        setTabAssignments(state, openResult.tabIds, workspace.id);
        if (openResult.openedCount > 0) {
          workspace.sessionTabs = [];
          workspace.updatedAt = now();
          workspace.lastActivatedAt = now();
        }
        return {
          workspaceId: ensured.workspaceId,
          openedCount: openResult.openedCount
        };
      });
    }

    case "OPEN_SLEEPING_TAB": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const index = workspace.sessionTabs.findIndex((tab) => tab.url === payload.url);
        if (index < 0) {
          throw new Error("Sleeping tab not found.");
        }
        const [tab] = workspace.sessionTabs.splice(index, 1);
        const openResult = await openTabRecords(requestedWindowId, [tab], { openFallback: false });
        setTabAssignments(state, openResult.tabIds, workspace.id);
        workspace.updatedAt = now();
        return { workspaceId: workspace.id, openedCount: openResult.openedCount };
      });
    }

    case "REMOVE_SLEEPING_TAB": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const removed = removeSleepingTab(workspace, payload.url);
        return { workspaceId: workspace.id, removed };
      });
    }

    case "REORDER_SLEEPING_TABS": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const reordered = reorderSleepingTabs(workspace, payload.orderedUrls);
        return { workspaceId: workspace.id, reordered };
      });
    }

    case "ADD_RESOURCE": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const resource = addResource(workspace, payload.url, payload.title);
        return { workspaceId: workspace.id, resource };
      });
    }

    case "MOVE_OPEN_TAB_TO_RESOURCES": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const resource = addResource(workspace, payload.url, payload.title);
        return { workspaceId: workspace.id, resource, copied: true };
      });
    }

    case "CLOSE_OPEN_TAB": {
      return mutateState(async (state) => {
        if (!Number.isFinite(payload.tabId)) {
          throw new Error("Tab ID is required.");
        }
        await closeTabsKeepingWindow(requestedWindowId, [payload.tabId], state);
        return { closed: true, tabId: payload.tabId };
      });
    }

    case "ACTIVATE_OPEN_TAB": {
      return mutateState(async (state) => {
        const ensured = ensureWorkspaceForWindow(state, requestedWindowId);
        const workspaceId =
          typeof payload.workspaceId === "string" && state.workspaces[payload.workspaceId]
            ? payload.workspaceId
            : ensured.workspaceId;
        return activateOrOpenWorkspaceTab(
          state,
          requestedWindowId,
          workspaceId,
          payload.tabId,
          payload.url,
          payload.title
        );
      });
    }

    case "MOVE_SLEEPING_TAB_TO_RESOURCES": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const resource = addResource(workspace, payload.url, payload.title);
        return { workspaceId: workspace.id, resource, copied: true };
      });
    }

    case "MOVE_OPEN_TAB_TO_WORKSPACE": {
      return mutateState(async (state) =>
        moveOpenTabToWorkspace(state, requestedWindowId, payload.tabId, payload.targetWorkspaceId)
      );
    }

    case "MOVE_SLEEPING_TAB_TO_WORKSPACE": {
      return mutateState(async (state) =>
        moveSleepingTabBetweenWorkspaces(
          state,
          payload.sourceWorkspaceId,
          payload.targetWorkspaceId,
          payload.url,
          payload.title
        )
      );
    }

    case "REMOVE_RESOURCE": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const before = workspace.resources.length;
        workspace.resources = workspace.resources.filter((resource) => resource.id !== payload.resourceId);
        const removed = workspace.resources.length < before;
        if (removed) {
          workspace.updatedAt = now();
        }
        return { workspaceId: workspace.id, removed };
      });
    }

    case "OPEN_RESOURCE": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const resource = workspace.resources.find((item) => item.id === payload.resourceId);
        if (!resource) {
          throw new Error("Resource not found.");
        }
        const openResult = await openTabRecords(requestedWindowId, [resource], { openFallback: false });
        setTabAssignments(state, openResult.tabIds, workspace.id);
        return { workspaceId: workspace.id, openedCount: openResult.openedCount };
      });
    }

    case "RESTORE_SNAPSHOT": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const snapshot = workspace.history.find((item) => item.id === payload.snapshotId);
        if (!snapshot) {
          throw new Error("Snapshot not found.");
        }

        await switchWorkspaceInWindow(state, requestedWindowId, workspace.id);

        const { tabs: activeTabs } = await getWorkspaceTabsForWindow(state, requestedWindowId, workspace.id, {
          assignUnknownToWorkspaceId: workspace.id
        });
        const activeRecords = dedupeTabRecords(activeTabs.map(tabToRecord));
        if (activeRecords.length > 0) {
          appendSleepingTabs(workspace, activeRecords);
          pushSnapshot(workspace, activeRecords, "restore", state.settings.maxSnapshotsPerWorkspace);
        }

        const openResult = await openTabRecords(requestedWindowId, snapshot.tabs, { openFallback: true });
        setTabAssignments(state, openResult.tabIds, workspace.id);
        await closeTabsKeepingWindow(
          requestedWindowId,
          activeTabs.map((tab) => tab.id),
          state
        );

        workspace.updatedAt = now();
        workspace.lastActivatedAt = now();
        return { workspaceId: workspace.id, openedCount: openResult.openedCount };
      });
    }

    case "UPDATE_SETTINGS": {
      return mutateState(async (state) => {
        const incomingSettings =
          payload.settings && typeof payload.settings === "object" ? payload.settings : {};
        const nextSettings = {
          ...state.settings,
          ...incomingSettings
        };

        nextSettings.inactivityMinutes = Math.max(
          5,
          Number(nextSettings.inactivityMinutes) || state.settings.inactivityMinutes
        );
        nextSettings.maxSnapshotsPerWorkspace = Math.max(
          5,
          Number(nextSettings.maxSnapshotsPerWorkspace) || state.settings.maxSnapshotsPerWorkspace
        );
        nextSettings.unfocusedSleepMinutes = Math.max(
          10,
          Number(nextSettings.unfocusedSleepMinutes) || state.settings.unfocusedSleepMinutes
        );
        nextSettings.unsplashAccessKey =
          typeof incomingSettings.unsplashAccessKey === "string"
            ? incomingSettings.unsplashAccessKey.trim()
            : state.settings.unsplashAccessKey;

        state.settings = nextSettings;
        return { settings: state.settings };
      });
    }

    case "OPEN_DASHBOARD": {
      return openOrFocusDashboard(requestedWindowId);
    }

    default:
      throw new Error(`Unknown action: ${message.action}`);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await loadState();
    await ensureAlarm();

    if (details.reason === "install" || details.reason === "update") {
      try {
        await openDashboardInAllNormalWindows();
      } catch (error) {
        console.warn("Could not open dashboard automatically after install/update:", error);
      }
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await loadState();
    await ensureAlarm();
    await openDashboardInAllNormalWindows();
  })();
});

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    const windowId = Number.isFinite(tab?.windowId) ? tab.windowId : await fetchCurrentWindowId();
    await openOrFocusDashboard(windowId);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void queueOperation(async () => {
    const state = await loadState();
    const key = String(tabId);
    let hasDeferredReference = false;

    for (const byWorkspace of Object.values(state.deferredSleepByWindow)) {
      for (const entry of Object.values(byWorkspace || {})) {
        if (entry && Array.isArray(entry.tabIds) && entry.tabIds.includes(tabId)) {
          hasDeferredReference = true;
          break;
        }
      }
      if (hasDeferredReference) {
        break;
      }
    }

    if (!state.tabWorkspaceById[key] && !hasDeferredReference) {
      return;
    }

    const working = structuredClone(state);
    removeTabAssignments(working, [tabId]);
    await saveState(working);
    await notifyStateUpdated();
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void queueOperation(async () => {
    const state = await loadState();
    const workspaceId = findWorkspaceIdByParkedWindow(state, windowId);
    if (!workspaceId) {
      return;
    }

    const working = structuredClone(state);
    const workspace = working.workspaces[workspaceId];
    if (workspace) {
      moveParkedTabsToSleeping(working, workspace, "parked-window-closed");
    }
    delete working.parkedWindowByWorkspace[workspaceId];
    delete working.activeWorkspaceByWindow[windowKey(windowId)];
    delete working.deferredSleepByWindow[windowKey(windowId)];
    await saveState(working);
    await notifyStateUpdated();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MEMORY_ALARM) {
    void runMemorySweep();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object" || typeof message.action !== "string") {
    return false;
  }

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Unknown error" }));

  return true;
});
