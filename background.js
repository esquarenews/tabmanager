const STORAGE_KEY = "workspace_tab_manager_state";
const SYNC_META_KEY = "workspace_tab_manager_sync_meta_v1";
const SYNC_OPEN_TABS_KEY_PREFIX = "workspace_tab_manager_sync_tabs_v1_";
const MEMORY_ALARM = "workspace_tab_memory_sweep";
const STARTUP_BOOTSTRAP_KEY = "workspace_tab_manager_startup_bootstrap_v1";
const STARTUP_DASHBOARD_ALARM = "workspace_tab_startup_dashboard_retry";
const EXTENSION_HEARTBEAT_KEY = "workspace_tab_manager_heartbeat_v1";
const NEW_TAB_URL = "chrome://newtab/";
const NEW_TAB_PAGE_PATH = "newtab.html";
const NEW_TAB_PAGE_URL = chrome.runtime.getURL(NEW_TAB_PAGE_PATH);
const DASHBOARD_PATH = "dashboard.html";
const PARKING_NOTICE_PATH = "parking-window.html";
const PARKING_NOTICE_URL = chrome.runtime.getURL(PARKING_NOTICE_PATH);
const OPENABLE_URL_REGEX = /^https?:\/\//i;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const SYNC_OPEN_TABS_TARGET_ITEM_BYTES = 7000;
const SYNC_EXPORT_DEBOUNCE_MS = 2500;
const SEARCH_RESULT_LIMIT = 10;
const STARTUP_TAB_ASSIGNMENT_SUPPRESSION_MS = 2 * 60 * 1000;
const STARTUP_DASHBOARD_RETRY_WINDOW_MS = 5 * 60 * 1000;
const STARTUP_DASHBOARD_RETRY_ALARM_MINUTES = 1;
const STARTUP_DASHBOARD_FAST_RETRY_DELAYS_MS = [1000, 4000, 10000, 30000];
const STALE_HEARTBEAT_SUPPRESSION_MS = 10 * 60 * 1000;
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
let syncExportTimer = null;
let startupDashboardRetryTimers = [];

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

function getTabUrl(tab) {
  if (typeof tab?.url === "string" && tab.url.length > 0) {
    return tab.url;
  }
  if (typeof tab?.pendingUrl === "string" && tab.pendingUrl.length > 0) {
    return tab.pendingUrl;
  }
  return "";
}

function isNewTabUrl(url) {
  if (typeof url !== "string") {
    return false;
  }
  return (
    url === NEW_TAB_URL ||
    url === "chrome://newtab" ||
    url === NEW_TAB_PAGE_URL ||
    url.startsWith(`${NEW_TAB_PAGE_URL}?`) ||
    url.startsWith(`${NEW_TAB_PAGE_URL}#`)
  );
}

function isDashboardUrl(url) {
  const dashboardUrl = getDashboardUrl();
  return typeof url === "string" && (url === dashboardUrl || url.startsWith(`${dashboardUrl}?`) || url.startsWith(`${dashboardUrl}#`));
}

function isWorkspaceManagedUrl(url) {
  if (typeof url !== "string" || url.trim().length === 0) {
    return false;
  }
  return !isParkingNoticeUrl(url) && !isDashboardUrl(url);
}

function fallbackTitleForUrl(url) {
  return isNewTabUrl(url) ? "New Tab" : url || "Untitled";
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

function isParkingNoticeUrl(url) {
  return typeof url === "string" && url.startsWith(PARKING_NOTICE_URL);
}

function normalizeSearchValue(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function computeSearchScore(query, primaryText, secondaryText = "") {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) {
    return null;
  }

  const primary = normalizeSearchValue(primaryText);
  const secondary = normalizeSearchValue(secondaryText);
  const searchable = [primary, secondary].filter(Boolean);
  if (searchable.length === 0) {
    return null;
  }

  const terms = normalizedQuery.split(" ").filter(Boolean);
  const matchesAllTerms = terms.every((term) => searchable.some((field) => field.includes(term)));
  if (!matchesAllTerms) {
    return null;
  }

  let score = 0;
  if (primary === normalizedQuery) {
    score += 420;
  } else if (primary.startsWith(normalizedQuery)) {
    score += 280;
  } else if (primary.includes(normalizedQuery)) {
    score += 200;
  }

  if (secondary === normalizedQuery) {
    score += 240;
  } else if (secondary.startsWith(normalizedQuery)) {
    score += 170;
  } else if (secondary.includes(normalizedQuery)) {
    score += 110;
  }

  for (const term of terms) {
    if (primary.startsWith(term)) {
      score += 36;
    } else if (primary.includes(term)) {
      score += 26;
    }

    if (secondary.startsWith(term)) {
      score += 20;
    } else if (secondary.includes(term)) {
      score += 14;
    }
  }

  const primaryIndex = primary.includes(normalizedQuery) ? primary.indexOf(normalizedQuery) : 40;
  const secondaryIndex = secondary.includes(normalizedQuery) ? secondary.indexOf(normalizedQuery) : 40;
  score -= Math.min(primaryIndex, secondaryIndex, 40);

  return score;
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

function getTabRecordKey(record) {
  const url = typeof record?.url === "string" ? record.url : "";
  const title = normalizeText(record?.title, fallbackTitleForUrl(url));
  return `${url}\n${title}`;
}

function dedupeTabRecords(records) {
  const seen = new Set();
  const output = [];

  for (const record of records) {
    if (!record || !isWorkspaceManagedUrl(record.url)) {
      continue;
    }
    const url = record.url;
    const title = normalizeText(record.title, fallbackTitleForUrl(url));
    const dedupeKey = getTabRecordKey({ url, title });
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    output.push({
      url,
      title,
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

function normalizeSyncedOpenTabsByWorkspace(value) {
  const output = {};
  if (!value || typeof value !== "object") {
    return output;
  }

  for (const [workspaceId, records] of Object.entries(value)) {
    if (typeof workspaceId !== "string") {
      continue;
    }
    const tabs = dedupeTabRecords(Array.isArray(records) ? records : []);
    if (tabs.length > 0) {
      output[workspaceId] = tabs;
    }
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
    tabRecordsById: {},
    deferredSleepByWindow: {},
    parkedWindowByWorkspace: {},
    syncedOpenTabsByWorkspace: {}
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

  const tabRecordsById = {};
  if (state.tabRecordsById && typeof state.tabRecordsById === "object") {
    for (const [tabId, record] of Object.entries(state.tabRecordsById)) {
      if (!tabWorkspaceById[tabId] || !record || !isWorkspaceManagedUrl(record.url)) {
        continue;
      }
      tabRecordsById[tabId] = {
        url: record.url,
        title: normalizeText(record.title, fallbackTitleForUrl(record.url)),
        favIconUrl: typeof record.favIconUrl === "string" ? record.favIconUrl : "",
        createdAt: Number.isFinite(record.createdAt) ? record.createdAt : now()
      };
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
    tabRecordsById,
    deferredSleepByWindow,
    parkedWindowByWorkspace,
    syncedOpenTabsByWorkspace: normalizeSyncedOpenTabsByWorkspace(state.syncedOpenTabsByWorkspace)
  };
}

function createWorkspaceFromSyncRecord(workspaceId, record) {
  const timestamp = Number.isFinite(record?.updatedAt) ? record.updatedAt : now();
  return {
    id: workspaceId,
    name: normalizeText(record?.name, "Workspace"),
    color: normalizeWorkspaceColor(record?.color, workspaceId),
    parkedTabs: [],
    sessionTabs: [],
    resources: [],
    history: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivatedAt: null,
    archivedAt: Number.isFinite(record?.archivedAt) ? record.archivedAt : null
  };
}

function normalizeSyncMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return null;
  }

  const workspaces = {};
  if (meta.workspaces && typeof meta.workspaces === "object") {
    for (const [workspaceId, record] of Object.entries(meta.workspaces)) {
      if (typeof workspaceId !== "string" || !record || typeof record !== "object") {
        continue;
      }
      workspaces[workspaceId] = {
        id: workspaceId,
        name: normalizeText(record.name, "Workspace"),
        color: normalizeWorkspaceColor(record.color, workspaceId),
        archivedAt: Number.isFinite(record.archivedAt) ? record.archivedAt : null,
        updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : now()
      };
    }
  }

  const workspaceOrder = Array.isArray(meta.workspaceOrder)
    ? meta.workspaceOrder.filter((workspaceId) => typeof workspaceId === "string" && workspaces[workspaceId])
    : [];
  const archivedWorkspaceOrder = Array.isArray(meta.archivedWorkspaceOrder)
    ? meta.archivedWorkspaceOrder.filter((workspaceId) => typeof workspaceId === "string" && workspaces[workspaceId])
    : [];

  const seen = new Set([...workspaceOrder, ...archivedWorkspaceOrder]);
  for (const workspaceId of Object.keys(workspaces)) {
    if (seen.has(workspaceId)) {
      continue;
    }
    if (Number.isFinite(workspaces[workspaceId].archivedAt)) {
      archivedWorkspaceOrder.push(workspaceId);
    } else {
      workspaceOrder.push(workspaceId);
    }
  }

  return {
    version: Number.isFinite(meta.version) ? meta.version : 1,
    updatedAt: Number.isFinite(meta.updatedAt) ? meta.updatedAt : now(),
    chunkCount: Math.max(0, Number(meta.chunkCount) || 0),
    workspaceOrder,
    archivedWorkspaceOrder,
    workspaces
  };
}

async function loadSyncSnapshot() {
  const metaStored = await chrome.storage.sync.get(SYNC_META_KEY);
  const meta = normalizeSyncMeta(metaStored[SYNC_META_KEY]);
  if (!meta) {
    return null;
  }

  const chunkKeys = Array.from({ length: meta.chunkCount }, (_value, index) => `${SYNC_OPEN_TABS_KEY_PREFIX}${index}`);
  const chunkStored = chunkKeys.length > 0 ? await chrome.storage.sync.get(chunkKeys) : {};
  const openTabsByWorkspace = {};

  for (const chunkKey of chunkKeys) {
    const chunk = Array.isArray(chunkStored[chunkKey]) ? chunkStored[chunkKey] : [];
    for (const record of chunk) {
      if (!record || typeof record !== "object" || typeof record.workspaceId !== "string") {
        continue;
      }
      if (!openTabsByWorkspace[record.workspaceId]) {
        openTabsByWorkspace[record.workspaceId] = [];
      }
      openTabsByWorkspace[record.workspaceId].push({
        url: record.url,
        title: record.title
      });
    }
  }

  return {
    ...meta,
    openTabsByWorkspace: normalizeSyncedOpenTabsByWorkspace(openTabsByWorkspace)
  };
}

function mergeSyncSnapshotIntoState(state, syncSnapshot) {
  const working = structuredClone(state);
  if (!syncSnapshot) {
    const hadSyncedOpenTabs = Object.keys(working.syncedOpenTabsByWorkspace || {}).length > 0;
    working.syncedOpenTabsByWorkspace = {};
    return { state: normalizeState(working), changed: hadSyncedOpenTabs };
  }

  let changed = false;
  const localHasMeaningfulData =
    Object.keys(working.workspaces || {}).length > 1 ||
    Object.values(working.workspaces || {}).some(
      (workspace) =>
        Array.isArray(workspace?.sessionTabs) && workspace.sessionTabs.length > 0 ||
        Array.isArray(workspace?.resources) && workspace.resources.length > 0 ||
        Array.isArray(workspace?.history) && workspace.history.length > 0 ||
        normalizeText(workspace?.name, "Workspace 1") !== "Workspace 1"
    );
  const preferSyncWorkspaceMetadata = !localHasMeaningfulData;

  for (const [workspaceId, syncedWorkspace] of Object.entries(syncSnapshot.workspaces)) {
    const localWorkspace = working.workspaces[workspaceId];
    if (!localWorkspace) {
      working.workspaces[workspaceId] = createWorkspaceFromSyncRecord(workspaceId, syncedWorkspace);
      changed = true;
      continue;
    }

    const localUpdatedAt = Number.isFinite(localWorkspace.updatedAt) ? localWorkspace.updatedAt : 0;
    const syncedUpdatedAt = Number.isFinite(syncedWorkspace.updatedAt) ? syncedWorkspace.updatedAt : 0;
    if (!preferSyncWorkspaceMetadata && syncedUpdatedAt < localUpdatedAt) {
      continue;
    }

    if (localWorkspace.name !== syncedWorkspace.name) {
      localWorkspace.name = syncedWorkspace.name;
      changed = true;
    }
    if (localWorkspace.color !== syncedWorkspace.color) {
      localWorkspace.color = syncedWorkspace.color;
      changed = true;
    }

    const nextArchivedAt = Number.isFinite(syncedWorkspace.archivedAt) ? syncedWorkspace.archivedAt : null;
    if ((Number.isFinite(localWorkspace.archivedAt) ? localWorkspace.archivedAt : null) !== nextArchivedAt) {
      localWorkspace.archivedAt = nextArchivedAt;
      changed = true;
    }

    if (localWorkspace.updatedAt !== syncedUpdatedAt) {
      localWorkspace.updatedAt = syncedUpdatedAt;
      changed = true;
    }
  }

  const nextWorkspaceOrder = syncSnapshot.workspaceOrder.filter(
    (workspaceId) => working.workspaces[workspaceId] && !Number.isFinite(working.workspaces[workspaceId].archivedAt)
  );
  for (const workspaceId of working.workspaceOrder) {
    if (
      working.workspaces[workspaceId] &&
      !Number.isFinite(working.workspaces[workspaceId].archivedAt) &&
      !nextWorkspaceOrder.includes(workspaceId)
    ) {
      nextWorkspaceOrder.push(workspaceId);
    }
  }

  const nextArchivedWorkspaceOrder = syncSnapshot.archivedWorkspaceOrder.filter(
    (workspaceId) => working.workspaces[workspaceId] && Number.isFinite(working.workspaces[workspaceId].archivedAt)
  );
  for (const workspaceId of working.archivedWorkspaceOrder || []) {
    if (
      working.workspaces[workspaceId] &&
      Number.isFinite(working.workspaces[workspaceId].archivedAt) &&
      !nextArchivedWorkspaceOrder.includes(workspaceId)
    ) {
      nextArchivedWorkspaceOrder.push(workspaceId);
    }
  }

  if (JSON.stringify(working.workspaceOrder) !== JSON.stringify(nextWorkspaceOrder)) {
    working.workspaceOrder = nextWorkspaceOrder;
    changed = true;
  }
  if (JSON.stringify(working.archivedWorkspaceOrder) !== JSON.stringify(nextArchivedWorkspaceOrder)) {
    working.archivedWorkspaceOrder = nextArchivedWorkspaceOrder;
    changed = true;
  }

  if (Object.keys(working.syncedOpenTabsByWorkspace || {}).length > 0) {
    working.syncedOpenTabsByWorkspace = {};
    changed = true;
  }

  return {
    state: normalizeState(working),
    changed
  };
}

function syncOpenTabsChunkKey(index) {
  return `${SYNC_OPEN_TABS_KEY_PREFIX}${index}`;
}

function estimateSyncItemBytes(key, value) {
  return JSON.stringify(value).length + String(key).length;
}

function chunkSyncedOpenTabs(records) {
  const chunks = [];
  let current = [];

  for (const record of records) {
    const candidate = [...current, record];
    if (current.length > 0 && estimateSyncItemBytes(syncOpenTabsChunkKey(chunks.length), candidate) > SYNC_OPEN_TABS_TARGET_ITEM_BYTES) {
      chunks.push(current);
      current = [record];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

async function collectOpenTabsByWorkspace(state) {
  const openTabsByWorkspace = {};
  const tabs = await chrome.tabs.query({});
  const parkedWindowIds = getParkedWindowIds(state, tabs);

  for (const tab of tabs) {
    const url = getTabUrl(tab);
    if (
      !Number.isFinite(tab?.id) ||
      !Number.isFinite(tab?.windowId) ||
      parkedWindowIds.has(tab.windowId) ||
      tab.pinned ||
      !isWorkspaceManagedUrl(url)
    ) {
      continue;
    }

    const workspaceId = state.tabWorkspaceById[String(tab.id)];
    if (!workspaceId || !state.workspaces[workspaceId]) {
      continue;
    }

    if (!openTabsByWorkspace[workspaceId]) {
      openTabsByWorkspace[workspaceId] = [];
    }

    openTabsByWorkspace[workspaceId].push({
      url,
      title: normalizeText(tab.title, fallbackTitleForUrl(url))
    });
  }

  return normalizeSyncedOpenTabsByWorkspace(openTabsByWorkspace);
}

async function assignNewTabToActiveWorkspace(tab, options = {}) {
  const { allowNewAssignment = false } = options;
  const url = getTabUrl(tab);
  if (!Number.isFinite(tab?.id) || !Number.isFinite(tab?.windowId) || tab.pinned || !isWorkspaceManagedUrl(url)) {
    return false;
  }
  if (await isStartupTabAssignmentSuppressed(tab)) {
    return false;
  }

  return queueOperation(async () => {
    const state = await loadState();
    const tabIdKey = String(tab.id);
    const existingWorkspaceId = state.tabWorkspaceById[tabIdKey];
    if (!existingWorkspaceId && !allowNewAssignment) {
      return false;
    }

    const workspaceId = existingWorkspaceId || state.activeWorkspaceByWindow[windowKey(tab.windowId)];
    if (!workspaceId || !state.workspaces[workspaceId] || Number.isFinite(state.workspaces[workspaceId].archivedAt)) {
      return false;
    }

    const working = structuredClone(state);
    const changed = setTabAssignments(working, [tab], workspaceId);
    if (changed) {
      await saveState(working);
      await notifyStateUpdated();
    }
    return changed;
  });
}

function buildSyncSnapshot(state, openTabsByWorkspace) {
  const workspaces = {};
  for (const [workspaceId, workspace] of Object.entries(state.workspaces || {})) {
    workspaces[workspaceId] = {
      id: workspaceId,
      name: normalizeText(workspace.name, "Workspace"),
      color: normalizeWorkspaceColor(workspace.color, workspaceId),
      archivedAt: Number.isFinite(workspace.archivedAt) ? workspace.archivedAt : null,
      updatedAt: Number.isFinite(workspace.updatedAt) ? workspace.updatedAt : now()
    };
  }

  return {
    meta: {
      version: 1,
      updatedAt: now(),
      workspaceOrder: Array.isArray(state.workspaceOrder) ? [...state.workspaceOrder] : [],
      archivedWorkspaceOrder: Array.isArray(state.archivedWorkspaceOrder) ? [...state.archivedWorkspaceOrder] : [],
      workspaces,
      chunkCount: 0
    },
    openTabChunks: []
  };
}

async function exportSyncSnapshot() {
  try {
    const baseState = stateCache ? structuredClone(stateCache) : await loadState();
    const snapshot = buildSyncSnapshot(baseState);
    const nextItems = {
      [SYNC_META_KEY]: snapshot.meta
    };

    snapshot.openTabChunks.forEach((chunk, index) => {
      nextItems[syncOpenTabsChunkKey(index)] = chunk;
    });

    const existingSync = await chrome.storage.sync.get(null);
    const removableKeys = Object.keys(existingSync).filter(
      (key) => key === STORAGE_KEY || (key.startsWith(SYNC_OPEN_TABS_KEY_PREFIX) && !(key in nextItems))
    );

    if (removableKeys.length > 0) {
      await chrome.storage.sync.remove(removableKeys);
    }
    await chrome.storage.sync.set(nextItems);
  } catch (error) {
    console.warn("Could not export synced workspaces/open tabs:", error);
  }
}

function scheduleSyncExport(delay = SYNC_EXPORT_DEBOUNCE_MS) {
  if (syncExportTimer) {
    clearTimeout(syncExportTimer);
  }

  syncExportTimer = setTimeout(() => {
    syncExportTimer = null;
    void exportSyncSnapshot();
  }, delay);
}

async function syncNow() {
  return queueOperation(async () => {
    if (syncExportTimer) {
      clearTimeout(syncExportTimer);
      syncExportTimer = null;
    }

    const localState = stateCache ? structuredClone(stateCache) : await loadState();
    const syncSnapshot = await loadSyncSnapshot();
    const merged = mergeSyncSnapshotIntoState(localState, syncSnapshot);
    const savedState = await saveState(merged.state);
    await exportSyncSnapshot();
    await notifyStateUpdated();

    return {
      synced: true,
      workspaceCount: savedState.workspaceOrder.length,
      syncedWorkspaceCount: Object.keys(savedState.syncedOpenTabsByWorkspace || {}).length
    };
  });
}

function sanitizeStateForPortableTransfer(state, options = {}) {
  const { openTabsByWorkspace = {} } = options;
  const normalized = normalizeState(state);
  const portableOpenTabsByWorkspace = normalizeSyncedOpenTabsByWorkspace({
    ...(normalized.syncedOpenTabsByWorkspace || {}),
    ...(openTabsByWorkspace || {})
  });

  for (const workspace of Object.values(normalized.workspaces || {})) {
    const parkedTabs = dedupeTabRecords(Array.isArray(workspace?.parkedTabs) ? workspace.parkedTabs : []);
    const sleepingTabs = dedupeTabRecords(Array.isArray(workspace?.sessionTabs) ? workspace.sessionTabs : []);
    const openTabs = dedupeTabRecords(portableOpenTabsByWorkspace[workspace.id] || []);
    workspace.parkedTabs = dedupeTabRecords([...openTabs, ...parkedTabs]);
    workspace.sessionTabs = sleepingTabs;
  }

  normalized.activeWorkspaceByWindow = {};
  normalized.tabWorkspaceById = {};
  normalized.tabRecordsById = {};
  normalized.deferredSleepByWindow = {};
  normalized.parkedWindowByWorkspace = {};
  normalized.syncedOpenTabsByWorkspace = {};

  return normalizeState(normalized);
}

async function buildStateBackup(state) {
  const openTabsByWorkspace = await collectOpenTabsByWorkspace(state);
  const portableState = sanitizeStateForPortableTransfer(state, {
    openTabsByWorkspace
  });

  return {
    schemaVersion: 1,
    exportedAt: now(),
    app: "ordinator",
    state: portableState
  };
}

function extractStateFromBackup(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Backup file is invalid.");
  }

  if (payload.state && typeof payload.state === "object") {
    return sanitizeStateForPortableTransfer(payload.state, {
      openTabsByWorkspace: payload.state.syncedOpenTabsByWorkspace
    });
  }

  // Support direct state dumps too.
  if (payload.workspaces && typeof payload.workspaces === "object") {
    return sanitizeStateForPortableTransfer(payload, {
      openTabsByWorkspace: payload.syncedOpenTabsByWorkspace
    });
  }

  throw new Error("Backup file is missing state data.");
}

async function exportStateBackup() {
  return queueOperation(async () => {
    const state = stateCache ? structuredClone(stateCache) : await loadState();
    return buildStateBackup(state);
  });
}

async function importStateBackup(payload) {
  return queueOperation(async () => {
    if (syncExportTimer) {
      clearTimeout(syncExportTimer);
      syncExportTimer = null;
    }

    const importedState = extractStateFromBackup(payload);
    const savedState = await saveState(importedState);
    await exportSyncSnapshot();
    await notifyStateUpdated();

    return {
      imported: true,
      workspaceCount: savedState.workspaceOrder.length,
      archivedWorkspaceCount: savedState.archivedWorkspaceOrder.length
    };
  });
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
    const syncSnapshot = await loadSyncSnapshot();
    const merged = mergeSyncSnapshotIntoState(normalized, syncSnapshot);
    stateCache = merged.state;
    if (merged.changed) {
      await chrome.storage.local.set({ [STORAGE_KEY]: merged.state });
    }
    return structuredClone(merged.state);
  }

  // One-time migration path from older sync-based storage.
  const syncStored = await chrome.storage.sync.get(STORAGE_KEY);
  if (syncStored[STORAGE_KEY]) {
    const normalized = mergeSyncSnapshotIntoState(normalizeState(syncStored[STORAGE_KEY]), null).state;
    stateCache = normalized;
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    try {
      await chrome.storage.sync.remove(STORAGE_KEY);
    } catch (error) {
      console.warn("Could not clear legacy sync state:", error);
    }
    return structuredClone(normalized);
  }

  const syncSnapshot = await loadSyncSnapshot();
  const initial = syncSnapshot ? mergeSyncSnapshotIntoState(createInitialState(), syncSnapshot).state : createInitialState();
  stateCache = initial;
  await chrome.storage.local.set({ [STORAGE_KEY]: initial });
  return structuredClone(initial);
}

async function saveState(nextState) {
  const normalized = normalizeState(nextState);
  stateCache = normalized;
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  scheduleSyncExport();
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

async function readStartupBootstrapState() {
  const stored = await chrome.storage.local.get(STARTUP_BOOTSTRAP_KEY);
  const value = stored[STARTUP_BOOTSTRAP_KEY];
  return value && typeof value === "object" ? value : {};
}

async function writeStartupBootstrapState(patch) {
  const current = await readStartupBootstrapState();
  const next = {
    ...current,
    ...patch,
    updatedAt: now()
  };
  await chrome.storage.local.set({ [STARTUP_BOOTSTRAP_KEY]: next });
  return next;
}

async function refreshExtensionHeartbeat(reason = "activity") {
  await chrome.storage.local.set({
    [EXTENSION_HEARTBEAT_KEY]: {
      reason,
      updatedAt: now()
    }
  });
}

async function hasStaleExtensionHeartbeat() {
  const stored = await chrome.storage.local.get(EXTENSION_HEARTBEAT_KEY);
  const heartbeat = stored[EXTENSION_HEARTBEAT_KEY];
  const updatedAt = Number(heartbeat?.updatedAt);
  return !Number.isFinite(updatedAt) || now() - updatedAt > STALE_HEARTBEAT_SUPPRESSION_MS;
}

function isLikelySessionRestoreTab(tab) {
  const url = getTabUrl(tab);
  return (
    Number.isFinite(tab?.id) &&
    Number.isFinite(tab?.windowId) &&
    !tab.pinned &&
    !Number.isFinite(tab.openerTabId) &&
    isWorkspaceManagedUrl(url) &&
    !isNewTabUrl(url)
  );
}

async function isStartupTabAssignmentSuppressed(tab) {
  if (!isLikelySessionRestoreTab(tab)) {
    return false;
  }
  const bootstrapState = await readStartupBootstrapState();
  return Number(bootstrapState.suppressAssignmentUntil) > now();
}

async function extendStartupTabAssignmentSuppression(reason) {
  const current = await readStartupBootstrapState();
  const timestamp = now();
  const suppressAssignmentUntil = Math.max(
    Number(current.suppressAssignmentUntil) || 0,
    timestamp + STARTUP_TAB_ASSIGNMENT_SUPPRESSION_MS
  );
  await writeStartupBootstrapState({
    reason,
    suppressAssignmentUntil
  });
  return suppressAssignmentUntil;
}

async function shouldSuppressCreatedTabAssignment(tab) {
  if (!isLikelySessionRestoreTab(tab)) {
    return false;
  }

  if (await isStartupTabAssignmentSuppressed(tab)) {
    return true;
  }

  if (await hasStaleExtensionHeartbeat()) {
    await extendStartupTabAssignmentSuppression("stale-heartbeat");
    await startStartupDashboardRetries("stale-heartbeat", { suppressTabAssignment: true });
    return true;
  }

  return false;
}

function clearStartupDashboardFastRetries() {
  for (const timerId of startupDashboardRetryTimers) {
    clearTimeout(timerId);
  }
  startupDashboardRetryTimers = [];
}

function scheduleStartupDashboardFastRetries(reason) {
  clearStartupDashboardFastRetries();
  startupDashboardRetryTimers = STARTUP_DASHBOARD_FAST_RETRY_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      void runStartupDashboardRetry(`${reason}:fast-retry`).catch((error) =>
        console.warn("Could not retry startup dashboard open:", error)
      );
    }, delay)
  );
}

async function startStartupDashboardRetries(reason, options = {}) {
  const { suppressTabAssignment = false } = options;
  const timestamp = now();
  const patch = {
    reason,
    dashboardRetryUntil: timestamp + STARTUP_DASHBOARD_RETRY_WINDOW_MS,
    dashboardAttemptCount: 0
  };
  if (suppressTabAssignment) {
    patch.suppressAssignmentUntil = timestamp + STARTUP_TAB_ASSIGNMENT_SUPPRESSION_MS;
  }

  await writeStartupBootstrapState(patch);
  scheduleStartupDashboardFastRetries(reason);
  try {
    await chrome.alarms.create(STARTUP_DASHBOARD_ALARM, {
      delayInMinutes: STARTUP_DASHBOARD_RETRY_ALARM_MINUTES,
      periodInMinutes: STARTUP_DASHBOARD_RETRY_ALARM_MINUTES
    });
  } catch (error) {
    console.warn("Could not schedule startup dashboard retry alarm:", error);
  }
}

async function stopStartupDashboardRetries(patch = {}) {
  clearStartupDashboardFastRetries();
  await chrome.alarms.clear(STARTUP_DASHBOARD_ALARM);
  await writeStartupBootstrapState({
    dashboardRetryUntil: 0,
    ...patch
  });
}

async function runStartupDashboardRetry(reason) {
  const bootstrapState = await readStartupBootstrapState();
  const retryUntil = Number(bootstrapState.dashboardRetryUntil) || 0;
  if (retryUntil <= 0) {
    return { attemptedWindowCount: 0, dashboardWindowCount: 0, inactive: true };
  }
  if (retryUntil > 0 && retryUntil < now()) {
    await stopStartupDashboardRetries({
      reason,
      lastDashboardResult: "expired"
    });
    return { attemptedWindowCount: 0, dashboardWindowCount: 0, expired: true };
  }

  if (Number(bootstrapState.suppressAssignmentUntil) > now()) {
    try {
      await hydrateOpenTabRecords({ trustExistingTabIds: false, includeSleepingTabs: false });
    } catch (error) {
      console.warn("Could not rehydrate restored tabs during startup retry:", error);
    }
  }

  const result = await openDashboardInAllNormalWindows();
  const dashboardAttemptCount = (Number(bootstrapState.dashboardAttemptCount) || 0) + 1;
  await writeStartupBootstrapState({
    reason,
    dashboardAttemptCount,
    lastDashboardAttemptAt: now(),
    lastDashboardResult: result
  });

  if (result.dashboardWindowCount > 0) {
    await stopStartupDashboardRetries({
      reason,
      dashboardAttemptCount,
      lastDashboardResult: result
    });
  }

  return result;
}

async function bootstrapExtensionRuntime(reason, options = {}) {
  const { openDashboard = true, suppressTabAssignment = false } = options;
  if (openDashboard) {
    await startStartupDashboardRetries(reason, { suppressTabAssignment });
  } else if (suppressTabAssignment) {
    await extendStartupTabAssignmentSuppression(reason);
  }

  try {
    await loadState();
    await hydrateOpenTabRecords({
      trustExistingTabIds: !suppressTabAssignment,
      includeSleepingTabs: false
    });
    await repairParkedWorkspaceWindows();
    await ensureAlarm();
    scheduleSyncExport(1000);
  } catch (error) {
    console.warn("Could not finish extension startup maintenance:", error);
  }

  if (openDashboard) {
    try {
      await runStartupDashboardRetry(reason);
    } catch (error) {
      console.warn("Could not open dashboard during startup bootstrap:", error);
    }
  }

  try {
    await refreshExtensionHeartbeat(reason);
  } catch (error) {
    // Best effort only.
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
  return tabs.filter((tab) => typeof tab.id === "number" && !tab.pinned && isWorkspaceManagedUrl(getTabUrl(tab)));
}

function rememberTabRecord(state, tab) {
  if (!Number.isFinite(tab?.id) || tab.pinned || !isWorkspaceManagedUrl(getTabUrl(tab))) {
    return false;
  }

  if (!state.tabRecordsById || typeof state.tabRecordsById !== "object") {
    state.tabRecordsById = {};
  }

  const key = String(tab.id);
  const nextRecord = tabToRecord(tab);
  const existingRecord = state.tabRecordsById[key];
  const changed =
    !existingRecord ||
    existingRecord.url !== nextRecord.url ||
    existingRecord.title !== nextRecord.title ||
    existingRecord.favIconUrl !== nextRecord.favIconUrl;

  state.tabRecordsById[key] = {
    ...nextRecord,
    createdAt: Number.isFinite(existingRecord?.createdAt) ? existingRecord.createdAt : nextRecord.createdAt
  };

  return changed;
}

function setTabAssignments(state, tabsOrIds, workspaceId) {
  if (!state.workspaces[workspaceId]) {
    return false;
  }
  let changed = false;
  for (const tabOrId of tabsOrIds || []) {
    const tabId = Number.isFinite(tabOrId) ? tabOrId : tabOrId?.id;
    if (!Number.isFinite(tabId)) {
      continue;
    }
    const key = String(tabId);
    if (state.tabWorkspaceById[key] !== workspaceId) {
      changed = true;
    }
    state.tabWorkspaceById[key] = workspaceId;
    if (tabOrId && typeof tabOrId === "object") {
      changed = rememberTabRecord(state, tabOrId) || changed;
    }
  }
  return changed;
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
    if (state.tabRecordsById && typeof state.tabRecordsById === "object") {
      delete state.tabRecordsById[String(tabId)];
    }
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

function findWorkspaceIdsByParkedWindow(state, parkedWindowId) {
  return Object.entries(state.parkedWindowByWorkspace || {})
    .filter(([_workspaceId, candidateWindowId]) => candidateWindowId === parkedWindowId)
    .map(([workspaceId]) => workspaceId);
}

function clearParkedWindowReferences(state, parkedWindowId) {
  for (const [workspaceId, candidateWindowId] of Object.entries(state.parkedWindowByWorkspace || {})) {
    if (candidateWindowId === parkedWindowId) {
      delete state.parkedWindowByWorkspace[workspaceId];
    }
  }
  delete state.activeWorkspaceByWindow[windowKey(parkedWindowId)];
  delete state.deferredSleepByWindow[windowKey(parkedWindowId)];
}

function getParkedWindowIds(state, tabs = []) {
  const parkedWindowIds = new Set(
    Object.values(state.parkedWindowByWorkspace || {}).filter((windowId) => Number.isFinite(windowId))
  );

  for (const tab of tabs) {
    if (Number.isFinite(tab?.windowId) && isParkingNoticeUrl(getTabUrl(tab))) {
      parkedWindowIds.add(tab.windowId);
    }
  }

  return parkedWindowIds;
}

async function getSharedParkedWindowId(state) {
  const seenWindowIds = new Set();
  for (const candidateWindowId of Object.values(state.parkedWindowByWorkspace || {})) {
    if (!Number.isFinite(candidateWindowId) || seenWindowIds.has(candidateWindowId)) {
      continue;
    }
    seenWindowIds.add(candidateWindowId);
    try {
      await chrome.windows.get(candidateWindowId);
      return candidateWindowId;
    } catch (error) {
      clearParkedWindowReferences(state, candidateWindowId);
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
    clearParkedWindowReferences(state, parkedWindowId);
    return null;
  }
}

async function ensureParkingNoticeTab(windowId) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId });
  } catch (error) {
    return null;
  }

  const noticeTabs = tabs.filter((tab) => Number.isFinite(tab.id) && isParkingNoticeUrl(tab.url));
  let noticeTab = noticeTabs[0] || null;

  if (!noticeTab) {
    try {
      noticeTab = await chrome.tabs.create({
        windowId,
        url: PARKING_NOTICE_URL,
        active: true,
        pinned: true,
        index: 0
      });
    } catch (error) {
      console.warn("Could not create parked window notice tab:", error);
      return null;
    }
  }

  if (!Number.isFinite(noticeTab?.id)) {
    return null;
  }

  try {
    await chrome.tabs.update(noticeTab.id, {
      active: true,
      pinned: true
    });
  } catch (error) {
    // Best effort only.
  }

  try {
    await chrome.tabs.move(noticeTab.id, { windowId, index: 0 });
  } catch (error) {
    // Best effort only.
  }

  const duplicateNoticeIds = noticeTabs
    .slice(1)
    .map((tab) => tab.id)
    .filter((tabId) => Number.isFinite(tabId));
  if (duplicateNoticeIds.length > 0) {
    try {
      await chrome.tabs.remove(duplicateNoticeIds);
    } catch (error) {
      // Best effort only.
    }
  }

  return noticeTab.id;
}

async function ensureParkedWindowPresentation(windowId) {
  await ensureParkingNoticeTab(windowId);
  try {
    await chrome.windows.update(windowId, {
      focused: false,
      state: "minimized"
    });
  } catch (error) {
    // Best effort only.
  }
}

async function ensureParkedWindow(state, workspaceId) {
  const existingWindowId = await getSharedParkedWindowId(state);
  if (Number.isFinite(existingWindowId)) {
    state.parkedWindowByWorkspace[workspaceId] = existingWindowId;
    await ensureParkedWindowPresentation(existingWindowId);
    return existingWindowId;
  }

  const created = await chrome.windows.create({
    url: PARKING_NOTICE_URL,
    focused: false,
    state: "minimized"
  });
  if (!Number.isFinite(created?.id)) {
    throw new Error("Could not create parked workspace window.");
  }
  state.parkedWindowByWorkspace[workspaceId] = created.id;
  await ensureParkedWindowPresentation(created.id);
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
    clearParkedWindowReferences(state, parkedWindowId);
    return;
  }

  const removableIds = tabs
    .filter((tab) => {
      if (!Number.isFinite(tab.id)) {
        return false;
      }
      const url = getTabUrl(tab);
      const workspaceId = state.tabWorkspaceById[String(tab.id)];
      const assignedWorkspaceTab = isWorkspaceManagedUrl(url) && !!state.workspaces[workspaceId];
      return !assignedWorkspaceTab && !isParkingNoticeUrl(url) && (isNewTabUrl(url) || !isWorkspaceManagedUrl(url));
    })
    .map((tab) => tab.id);

  const allWorkspaceTabs = tabs.filter(
    (tab) => {
      const url = getTabUrl(tab);
      return (
        Number.isFinite(tab.id) &&
        isWorkspaceManagedUrl(url) &&
        !!state.workspaces[state.tabWorkspaceById[String(tab.id)]]
      );
    }
  );

  const openWorkspaceTabs = tabs.filter(
    (tab) => {
      const url = getTabUrl(tab);
      return (
        Number.isFinite(tab.id) &&
        isWorkspaceManagedUrl(url) &&
        state.tabWorkspaceById[String(tab.id)] === workspaceId
      );
    }
  );

  if (openWorkspaceTabs.length === 0) {
    delete state.parkedWindowByWorkspace[workspaceId];
  }

  if (allWorkspaceTabs.length === 0) {
    clearParkedWindowReferences(state, parkedWindowId);
    return;
  }

  if (removableIds.length > 0) {
    console.warn("Leaving unassigned tabs in parked window instead of removing them:", removableIds);
  }

  await ensureParkedWindowPresentation(parkedWindowId);
}

async function collapseParkedWorkspaceWindow(state, workspaceId) {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    const parkedWindowId = state.parkedWindowByWorkspace?.[workspaceId];
    delete state.parkedWindowByWorkspace[workspaceId];
    if (Number.isFinite(parkedWindowId) && findWorkspaceIdsByParkedWindow(state, parkedWindowId).length === 0) {
      delete state.activeWorkspaceByWindow[windowKey(parkedWindowId)];
      delete state.deferredSleepByWindow[windowKey(parkedWindowId)];
    }
    return { changed: Number.isFinite(parkedWindowId), collapsedCount: 0 };
  }

  const parkedWindowId = await getValidParkedWindowId(state, workspaceId);
  const workspaceIdsInWindow = Number.isFinite(parkedWindowId)
    ? findWorkspaceIdsByParkedWindow(state, parkedWindowId)
    : [];
  const recordsByWorkspaceId = new Map();
  let changed = false;
  let collapsedCount = 0;

  if (Number.isFinite(parkedWindowId)) {
    changed = true;
    try {
      const parkedTabs = await chrome.tabs.query({ windowId: parkedWindowId });
      for (const candidateWorkspaceId of workspaceIdsInWindow) {
        const workspaceTabs = parkedTabs.filter(
          (tab) =>
            Number.isFinite(tab.id) &&
            !tab.pinned &&
            isWorkspaceManagedUrl(getTabUrl(tab)) &&
            state.tabWorkspaceById[String(tab.id)] === candidateWorkspaceId
        );
        const liveRecords = dedupeTabRecords(workspaceTabs.map(tabToRecord));
        if (liveRecords.length > 0) {
          recordsByWorkspaceId.set(candidateWorkspaceId, liveRecords);
        }
        removeTabAssignments(state, workspaceTabs.map((tab) => tab.id));
      }
    } catch (error) {
      console.warn("Could not inspect parked window during repair:", parkedWindowId, error);
    }

    clearParkedWindowReferences(state, parkedWindowId);
  }

  const processedWorkspaceIds = new Set(workspaceIdsInWindow);
  if (!processedWorkspaceIds.has(workspaceId)) {
    processedWorkspaceIds.add(workspaceId);
  }

  for (const candidateWorkspaceId of processedWorkspaceIds) {
    const candidateWorkspace = state.workspaces[candidateWorkspaceId];
    if (!candidateWorkspace) {
      continue;
    }

    const fallbackRecords = dedupeTabRecords(Array.isArray(candidateWorkspace.parkedTabs) ? candidateWorkspace.parkedTabs : []);
    const records = recordsByWorkspaceId.get(candidateWorkspaceId) || fallbackRecords;

    if (records.length > 0) {
      appendParkedTabs(candidateWorkspace, records);
      collapsedCount += records.length;
      changed = true;
    }

    clearDeferredSleepForWorkspace(state, candidateWorkspaceId);
    if (records.length > 0 || fallbackRecords.length > 0 || workspaceIdsInWindow.includes(candidateWorkspaceId)) {
      candidateWorkspace.updatedAt = now();
    }
  }

  return { changed, collapsedCount };
}

async function repairParkedWorkspaceWindows() {
  return queueOperation(async () => {
    const state = await loadState();
    const parkedWindowEntries = Object.entries(state.parkedWindowByWorkspace || {}).filter(
      ([workspaceId, windowId]) => state.workspaces[workspaceId] && Number.isFinite(windowId)
    );
    const orphanedParkedTabs = Object.values(state.workspaces || {}).some(
      (workspace) => Array.isArray(workspace?.parkedTabs) && workspace.parkedTabs.length > 0
    );

    if (parkedWindowEntries.length === 0 && !orphanedParkedTabs) {
      return { repaired: false, collapsedCount: 0 };
    }

    const working = structuredClone(state);
    let changed = false;
    let collapsedCount = 0;
    const validParkedWorkspaceIds = new Set();
    const checkedWindowIds = new Set();
    const validWindowIds = new Set();
    const invalidWindowIds = new Set();

    for (const [_workspaceId, windowId] of parkedWindowEntries) {
      if (checkedWindowIds.has(windowId)) {
        continue;
      }
      checkedWindowIds.add(windowId);
      try {
        await chrome.windows.get(windowId);
        validWindowIds.add(windowId);
        await ensureParkedWindowPresentation(windowId);
      } catch (error) {
        invalidWindowIds.add(windowId);
      }
    }

    for (const [workspaceId, windowId] of parkedWindowEntries) {
      if (validWindowIds.has(windowId)) {
        validParkedWorkspaceIds.add(workspaceId);
        continue;
      }
      if (invalidWindowIds.has(windowId)) {
        clearParkedWindowReferences(working, windowId);
        changed = true;
      }
    }

    for (const [workspaceId, workspace] of Object.entries(working.workspaces || {})) {
      if (validParkedWorkspaceIds.has(workspaceId)) {
        continue;
      }
      if (!Array.isArray(workspace?.parkedTabs) || workspace.parkedTabs.length === 0) {
        continue;
      }
      collapsedCount += workspace.parkedTabs.length;
    }

    if (!changed) {
      return { repaired: false, collapsedCount: 0 };
    }

    await saveState(working);
    await notifyStateUpdated();
    return { repaired: true, collapsedCount };
  });
}

function takeStoredTabCandidate(candidatesByUrl, tab) {
  const url = getTabUrl(tab);
  const candidates = candidatesByUrl.get(url);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const title = normalizeText(tab.title, fallbackTitleForUrl(url));
  const matchingTitleIndexes = [];
  const matchingTitleWorkspaceIds = new Set();
  candidates.forEach((candidate, index) => {
    if (normalizeText(candidate.record?.title, fallbackTitleForUrl(candidate.record?.url)) !== title) {
      return;
    }
    matchingTitleIndexes.push(index);
    matchingTitleWorkspaceIds.add(candidate.workspaceId);
  });

  let candidateIndex = -1;
  if (matchingTitleIndexes.length > 0) {
    if (matchingTitleWorkspaceIds.size > 1) {
      return null;
    }
    candidateIndex = matchingTitleIndexes[0];
  } else {
    const workspaceIds = new Set(candidates.map((candidate) => candidate.workspaceId));
    if (workspaceIds.size > 1) {
      return null;
    }
    candidateIndex = 0;
  }

  const [candidate] = candidates.splice(candidateIndex, 1);
  if (candidates.length === 0) {
    candidatesByUrl.delete(url);
  }
  return candidate || null;
}

function addStoredTabCandidate(candidatesByUrl, workspaceId, record, source) {
  const tabs = dedupeTabRecords([record]);
  if (tabs.length === 0) {
    return;
  }
  const [safeRecord] = tabs;
  if (!candidatesByUrl.has(safeRecord.url)) {
    candidatesByUrl.set(safeRecord.url, []);
  }
  candidatesByUrl.get(safeRecord.url).push({ workspaceId, record: safeRecord, source });
}

async function hydrateOpenTabRecords(options = {}) {
  const { trustExistingTabIds = true, includeSleepingTabs = false } = options;
  return queueOperation(async () => {
    const state = await loadState();
    const working = structuredClone(state);
    const tabs = await chrome.tabs.query({});
    const previousAssignments = { ...(working.tabWorkspaceById || {}) };
    const previousRecords = { ...(working.tabRecordsById || {}) };
    const candidatesByUrl = new Map();
    let changed = false;

    for (const [tabId, workspaceId] of Object.entries(previousAssignments)) {
      const workspace = working.workspaces[workspaceId];
      const record = previousRecords[tabId];
      if (!workspace || Number.isFinite(workspace.archivedAt) || !record) {
        continue;
      }
      addStoredTabCandidate(candidatesByUrl, workspaceId, record, "record");
    }

    if (includeSleepingTabs) {
      for (const [workspaceId, workspace] of Object.entries(working.workspaces || {})) {
        if (!workspace || Number.isFinite(workspace.archivedAt)) {
          continue;
        }
        for (const record of workspace.sessionTabs || []) {
          addStoredTabCandidate(candidatesByUrl, workspaceId, record, "sleeping");
        }
      }
    }

    if (!trustExistingTabIds) {
      if (
        Object.keys(working.activeWorkspaceByWindow || {}).length > 0 ||
        Object.keys(working.deferredSleepByWindow || {}).length > 0 ||
        Object.keys(working.tabWorkspaceById || {}).length > 0 ||
        Object.keys(working.tabRecordsById || {}).length > 0
      ) {
        changed = true;
      }
      working.activeWorkspaceByWindow = {};
      working.deferredSleepByWindow = {};
      working.tabWorkspaceById = {};
      working.tabRecordsById = {};
    }

    for (const tab of tabs) {
      if (!Number.isFinite(tab?.id) || tab.pinned || !isWorkspaceManagedUrl(getTabUrl(tab))) {
        continue;
      }

      let workspaceId = trustExistingTabIds ? previousAssignments[String(tab.id)] : null;
      let matchedCandidate = null;
      if (!workspaceId || !working.workspaces[workspaceId]) {
        matchedCandidate = takeStoredTabCandidate(candidatesByUrl, tab);
        workspaceId = matchedCandidate?.workspaceId || null;
      } else {
        matchedCandidate = takeStoredTabCandidate(candidatesByUrl, tab);
      }

      const workspace = working.workspaces[workspaceId];
      if (!workspace || Number.isFinite(workspace.archivedAt)) {
        continue;
      }

      const beforeSleepingCount = Array.isArray(workspace.sessionTabs) ? workspace.sessionTabs.length : 0;
      workspace.sessionTabs = removeFirstMatchingTabRecord(workspace.sessionTabs, matchedCandidate?.record || tabToRecord(tab));
      if (workspace.sessionTabs.length !== beforeSleepingCount) {
        workspace.updatedAt = now();
        changed = true;
      }
      changed = setTabAssignments(working, [tab], workspaceId) || changed;
    }

    if (!trustExistingTabIds) {
      for (const candidates of candidatesByUrl.values()) {
        for (const candidate of candidates) {
          if (candidate.source !== "record") {
            continue;
          }
          const workspace = working.workspaces[candidate.workspaceId];
          if (!workspace || Number.isFinite(workspace.archivedAt)) {
            continue;
          }
          appendSleepingTabs(workspace, [candidate.record]);
          workspace.updatedAt = now();
          changed = true;
        }
      }
    }

    if (!changed) {
      return { hydrated: false };
    }

    await saveState(working);
    await notifyStateUpdated();
    return { hydrated: true };
  });
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
  const { tabs } = await getWorkspaceTabsForWindow(state, windowId, workspaceId);

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
  if (!tab || tab.pinned || !isWorkspaceManagedUrl(getTabUrl(tab))) {
    throw new Error("Tab cannot be moved.");
  }

  const sourceWorkspaceId =
    state.tabWorkspaceById[String(tabId)] || state.activeWorkspaceByWindow[windowKey(windowId)] || targetWorkspaceId;
  if (sourceWorkspaceId === targetWorkspaceId) {
    return { moved: false };
  }

  setTabAssignments(state, [tab], targetWorkspaceId);
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

async function parkWorkspaceTabsFromWindow(state, windowId, workspaceId, snapshotReason = null) {
  if (!state.workspaces[workspaceId] || Number.isFinite(state.workspaces[workspaceId].archivedAt)) {
    return { parkedCount: 0 };
  }

  const workspace = state.workspaces[workspaceId];
  const { tabs } = await getWorkspaceTabsForWindow(state, windowId, workspaceId, {
    assignUnknownToWorkspaceId: workspaceId
  });
  if (tabs.length === 0) {
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
    rememberTabRecord(state, tab);
    try {
      await chrome.tabs.move(tab.id, { windowId: parkedWindowId, index: -1 });
      movedTabIds.push(tab.id);
      movedRecords.push(tabToRecord(tab));
    } catch (error) {
      console.warn("Failed to park workspace tab:", tab.id, error);
    }
  }

  const parkedRecords = dedupeTabRecords(movedRecords);
  workspace.parkedTabs = dedupeTabRecords([...(workspace.parkedTabs || []), ...parkedRecords]);
  if (snapshotReason && parkedRecords.length > 0) {
    pushSnapshot(workspace, parkedRecords, snapshotReason, state.settings.maxSnapshotsPerWorkspace);
  }
  workspace.updatedAt = now();
  clearDeferredSleepForWorkspace(state, workspaceId);
  await cleanupParkedWindow(state, workspaceId);
  return { parkedCount: movedTabIds.length, parkedWindowId };
}

async function restoreParkedWorkspaceTabsToWindow(state, windowId, workspaceId) {
  if (!state.workspaces[workspaceId] || Number.isFinite(state.workspaces[workspaceId].archivedAt)) {
    return { restoredCount: 0 };
  }

  const workspace = state.workspaces[workspaceId];
  const restoreSavedParkedRecords = async () => {
    const savedRecords = dedupeTabRecords(Array.isArray(workspace.parkedTabs) ? workspace.parkedTabs : []);
    if (savedRecords.length === 0) {
      workspace.parkedTabs = [];
      return { restoredCount: 0 };
    }

    const openResult = await openTabRecords(windowId, savedRecords, {
      openFallback: false,
      activateFirst: false
    });
    if (openResult.openedCount > 0) {
      setTabAssignments(state, openResult.tabs, workspaceId);
      workspace.parkedTabs = [];
      workspace.updatedAt = now();
    }
    clearDeferredSleepForWorkspace(state, workspaceId);
    return { restoredCount: openResult.openedCount };
  };

  const parkedWindowId = await getValidParkedWindowId(state, workspaceId);
  if (!Number.isFinite(parkedWindowId) || parkedWindowId === windowId) {
    clearDeferredSleepForWorkspace(state, workspaceId);
    return restoreSavedParkedRecords();
  }

  const parkedTabs = await chrome.tabs.query({ windowId: parkedWindowId });
  const workspaceTabs = parkedTabs
    .filter(
      (tab) =>
        Number.isFinite(tab.id) &&
        !tab.pinned &&
        isWorkspaceManagedUrl(getTabUrl(tab)) &&
        state.tabWorkspaceById[String(tab.id)] === workspaceId
    )
    .sort((a, b) => a.index - b.index);

  if (workspaceTabs.length === 0) {
    clearDeferredSleepForWorkspace(state, workspaceId);
    await cleanupParkedWindow(state, workspaceId);
    return restoreSavedParkedRecords();
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
    changed = rememberTabRecord(state, tab) || changed;
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
      if (tab && !tab.pinned && isWorkspaceManagedUrl(getTabUrl(tab))) {
        const tabWindowId = Number.isFinite(tab.windowId) ? tab.windowId : windowId;
        setTabAssignments(state, [tab], workspaceId);
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

  if (!isWorkspaceManagedUrl(url)) {
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
  setTabAssignments(state, openResult.tabs, workspaceId);
  const sleepingIndex = workspace.sessionTabs.findIndex((tab) => tab.url === url);
  if (sleepingIndex >= 0) {
    workspace.sessionTabs.splice(sleepingIndex, 1);
  }
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
    if (!assignedWorkspaceId || !state.workspaces[assignedWorkspaceId] || Number.isFinite(state.workspaces[assignedWorkspaceId].archivedAt)) {
      if (
        typeof assignUnknownToWorkspaceId !== "string" ||
        !state.workspaces[assignUnknownToWorkspaceId] ||
        Number.isFinite(state.workspaces[assignUnknownToWorkspaceId].archivedAt)
      ) {
        continue;
      }
      assignedWorkspaceId = assignUnknownToWorkspaceId;
      state.tabWorkspaceById[key] = assignedWorkspaceId;
      changed = true;
    }
    changed = rememberTabRecord(state, tab) || changed;

    if (assignedWorkspaceId === workspaceId) {
      output.push(tab);
    }
  }

  return { tabs: output, changed };
}

function tabToRecord(tab) {
  const url = getTabUrl(tab);
  return {
    url,
    title: normalizeText(tab.title, fallbackTitleForUrl(url)),
    favIconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
    createdAt: now()
  };
}

function appendSleepingTabs(workspace, records) {
  workspace.sessionTabs = dedupeTabRecords([...(records || []), ...(workspace.sessionTabs || [])]);
}

function appendParkedTabs(workspace, records) {
  workspace.parkedTabs = dedupeTabRecords([...(workspace.parkedTabs || []), ...(records || [])]);
}

function removeFirstMatchingTabRecord(records, record) {
  if (!Array.isArray(records) || !record) {
    return records || [];
  }
  const index = records.findIndex(
    (candidate) =>
      candidate &&
      candidate.url === record.url &&
      normalizeText(candidate.title, fallbackTitleForUrl(candidate.url)) ===
        normalizeText(record.title, fallbackTitleForUrl(record.url))
  );
  if (index < 0) {
    return records;
  }
  const nextRecords = [...records];
  nextRecords.splice(index, 1);
  return nextRecords;
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

async function openTabRecords(windowId, records, options = {}) {
  const { openFallback = true, activateFirst = true } = options;
  const openableRecords = dedupeTabRecords(records || []);
  const tabIds = [];
  const openedTabs = [];

  if (openableRecords.length === 0) {
    if (openFallback) {
      const created = await chrome.tabs.create({ windowId, url: NEW_TAB_URL, active: activateFirst });
      if (Number.isFinite(created.id)) {
        tabIds.push(created.id);
        openedTabs.push({ ...created, url: getTabUrl(created) || NEW_TAB_URL, title: normalizeText(created.title, "New Tab") });
      }
      return { openedCount: 1, tabIds, tabs: openedTabs };
    }
    return { openedCount: 0, tabIds, tabs: openedTabs };
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
        openedTabs.push({
          ...created,
          url: getTabUrl(created) || record.url,
          title: normalizeText(created.title, normalizeText(record.title, fallbackTitleForUrl(record.url))),
          favIconUrl: typeof created.favIconUrl === "string" ? created.favIconUrl : record.favIconUrl || ""
        });
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
      openedTabs.push({ ...created, url: getTabUrl(created) || NEW_TAB_URL, title: normalizeText(created.title, "New Tab") });
    }
    return { openedCount: 1, tabIds, tabs: openedTabs };
  }

  return { openedCount, tabIds, tabs: openedTabs };
}

async function discardTabsInPlace(tabIds) {
  const uniqueTabIds = [...new Set((tabIds || []).filter((tabId) => typeof tabId === "number"))];
  if (uniqueTabIds.length === 0) {
    return 0;
  }

  let discardedCount = 0;
  for (const tabId of uniqueTabIds) {
    try {
      await chrome.tabs.discard(tabId);
      discardedCount += 1;
    } catch (error) {
      console.warn("Could not discard tab in place:", tabId, error);
    }
  }

  return discardedCount;
}

async function removeTabsById(tabIds) {
  const uniqueTabIds = [...new Set((tabIds || []).filter((tabId) => typeof tabId === "number"))];
  if (uniqueTabIds.length === 0) {
    return 0;
  }

  let removedCount = 0;
  for (const tabId of uniqueTabIds) {
    try {
      await chrome.tabs.remove(tabId);
      removedCount += 1;
    } catch (error) {
      console.warn("Could not remove tab:", tabId, error);
    }
  }

  return removedCount;
}

async function deleteSelectedTabsPermanently(state, windowId, workspaceId, openTabIds = [], sleepingTabs = []) {
  const uniqueOpenTabIds = [...new Set((openTabIds || []).filter((tabId) => Number.isFinite(tabId)))];
  const selectedSleepingKeys = new Set(
    (sleepingTabs || [])
      .filter((record) => record && typeof record === "object")
      .map((record) => getTabRecordKey(record))
  );

  let deletedSleepingCount = 0;
  if (selectedSleepingKeys.size > 0) {
    const workspace = state.workspaces[workspaceId];
    if (!workspace || Number.isFinite(workspace.archivedAt)) {
      throw new Error("Workspace not found.");
    }

    const originalTabs = Array.isArray(workspace.sessionTabs) ? workspace.sessionTabs : [];
    const remainingTabs = [];
    for (const record of originalTabs) {
      if (selectedSleepingKeys.has(getTabRecordKey(record))) {
        deletedSleepingCount += 1;
        continue;
      }
      remainingTabs.push(record);
    }

    if (deletedSleepingCount > 0) {
      workspace.sessionTabs = remainingTabs;
      workspace.updatedAt = now();
    }
  }

  let deletedOpenCount = 0;
  if (uniqueOpenTabIds.length > 0) {
    const requestedOpenTabIds = new Set(uniqueOpenTabIds);
    const windowTabs = await chrome.tabs.query({ windowId });
    const tabsToDelete = windowTabs.filter(
      (tab) =>
        Number.isFinite(tab?.id) &&
        requestedOpenTabIds.has(tab.id) &&
        !tab.pinned &&
        isWorkspaceManagedUrl(getTabUrl(tab))
    );

    if (tabsToDelete.length > 0) {
      const touchedWorkspaceIds = new Set();
      for (const tab of tabsToDelete) {
        const assignedWorkspaceId = state.tabWorkspaceById[String(tab.id)];
        if (assignedWorkspaceId && state.workspaces[assignedWorkspaceId]) {
          touchedWorkspaceIds.add(assignedWorkspaceId);
        }
      }

      removeTabAssignments(state, tabsToDelete.map((tab) => tab.id));
      for (const touchedWorkspaceId of touchedWorkspaceIds) {
        state.workspaces[touchedWorkspaceId].updatedAt = now();
      }
      deletedOpenCount = await removeTabsById(tabsToDelete.map((tab) => tab.id));
    }
  }

  return {
    deletedOpenCount,
    deletedSleepingCount,
    deletedCount: deletedOpenCount + deletedSleepingCount
  };
}

async function sleepOpenTabsById(state, windowId, tabIds, reason) {
  const requestedTabIds = new Set((tabIds || []).filter((tabId) => Number.isFinite(tabId)));
  if (requestedTabIds.size === 0) {
    return { sleptCount: 0 };
  }

  const ensured = ensureWorkspaceForWindow(state, windowId);
  const windowTabs = await chrome.tabs.query({ windowId });
  const tabs = windowTabs.filter(
    (tab) =>
      Number.isFinite(tab.id) &&
      requestedTabIds.has(tab.id) &&
      !tab.pinned &&
      isWorkspaceManagedUrl(getTabUrl(tab))
  );

  if (tabs.length === 0) {
    return { sleptCount: 0, workspaceId: ensured.workspaceId };
  }

  const tabsByWorkspace = new Map();
  for (const tab of tabs) {
    const tabIdKey = String(tab.id);
    let workspaceId = state.tabWorkspaceById[tabIdKey] || ensured.workspaceId;
    if (!state.workspaces[workspaceId] || Number.isFinite(state.workspaces[workspaceId].archivedAt)) {
      workspaceId = ensured.workspaceId;
    }

    setTabAssignments(state, [tab], workspaceId);
    if (!tabsByWorkspace.has(workspaceId)) {
      tabsByWorkspace.set(workspaceId, []);
    }
    tabsByWorkspace.get(workspaceId).push(tab);
  }

  for (const [workspaceId, workspaceTabs] of tabsByWorkspace.entries()) {
    const workspace = state.workspaces[workspaceId];
    const records = dedupeTabRecords(workspaceTabs.map(tabToRecord));
    if (records.length === 0) {
      continue;
    }
    appendSleepingTabs(workspace, records);
    pushSnapshot(workspace, records, reason, state.settings.maxSnapshotsPerWorkspace);
    workspace.updatedAt = now();
    clearDeferredSleep(state, windowId, workspaceId);
  }

  await saveState(state);
  const removedCount = await removeTabsById(tabs.map((tab) => tab.id));

  return {
    sleptCount: removedCount,
    workspaceId: ensured.workspaceId
  };
}

async function sleepActiveWorkspaceTabs(state, windowId, reason) {
  const ensured = ensureWorkspaceForWindow(state, windowId);
  const workspace = state.workspaces[ensured.workspaceId];

  const { tabs } = await getWorkspaceTabsForWindow(state, windowId, ensured.workspaceId);
  if (tabs.length === 0) {
    return { workspaceId: ensured.workspaceId, sleptCount: 0 };
  }

  const records = dedupeTabRecords(tabs.map(tabToRecord));
  appendSleepingTabs(workspace, records);
  pushSnapshot(workspace, records, reason, state.settings.maxSnapshotsPerWorkspace);
  workspace.updatedAt = now();
  clearDeferredSleep(state, windowId, workspace.id);

  await saveState(state);
  const removedCount = await removeTabsById(tabs.map((tab) => tab.id));

  return { workspaceId: ensured.workspaceId, sleptCount: removedCount };
}

async function switchWorkspaceInWindow(state, windowId, targetWorkspaceId, options = {}) {
  const openSleepingTabsWhenEmpty = options.openSleepingTabsWhenEmpty === true;

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
    const parkResult = await parkWorkspaceTabsFromWindow(state, windowId, currentWorkspaceId, "switch");
    parkedCount = parkResult.parkedCount;
  }

  const targetWorkspace = state.workspaces[targetWorkspaceId];
  let openedCount = 0;
  const restoreResult = await restoreParkedWorkspaceTabsToWindow(state, windowId, targetWorkspaceId);
  openedCount += restoreResult.restoredCount;

  if (openSleepingTabsWhenEmpty) {
    const { tabs: visibleTargetTabs } = await getWorkspaceTabsForWindow(state, windowId, targetWorkspaceId);
    const shouldOpenSleepingTabs = targetWorkspace.sessionTabs.length > 0;
    if (visibleTargetTabs.length === 0 && shouldOpenSleepingTabs) {
      const openResult = await openTabRecords(windowId, targetWorkspace.sessionTabs, {
        openFallback: false,
        activateFirst: false
      });
      openedCount += openResult.openedCount;
      setTabAssignments(state, openResult.tabs, targetWorkspaceId);
      if (openResult.openedCount > 0) {
        targetWorkspace.sessionTabs = [];
      }
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
  const index = workspace.sessionTabs.findIndex((tab) => tab.url === url);
  if (index < 0) {
    return false;
  }
  workspace.sessionTabs.splice(index, 1);
  workspace.updatedAt = now();
  return true;
}

async function sleepWorkspaceTabsAcrossWindows(state, workspaceId, reason) {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    return { sleptCount: 0 };
  }

  const openTabs = await chrome.tabs.query({});
  const parkedWindowIds = getParkedWindowIds(state, openTabs);
  const matchingTabs = openTabs.filter(
    (tab) =>
      Number.isFinite(tab?.id) &&
      Number.isFinite(tab?.windowId) &&
      !tab.pinned &&
      isWorkspaceManagedUrl(getTabUrl(tab)) &&
      state.tabWorkspaceById[String(tab.id)] === workspaceId
  );

  if (matchingTabs.length === 0) {
    return { sleptCount: 0 };
  }

  const visibleTabs = matchingTabs
    .filter((tab) => !parkedWindowIds.has(tab.windowId))
    .sort((left, right) => {
      if (left.windowId !== right.windowId) {
        return left.windowId - right.windowId;
      }
      return left.index - right.index;
    });
  const alreadyParkedRecords = dedupeTabRecords(
    matchingTabs.filter((tab) => parkedWindowIds.has(tab.windowId)).map(tabToRecord)
  );
  const movedRecords = [];
  let parkedWindowId = await getValidParkedWindowId(state, workspaceId);

  if (visibleTabs.length > 0) {
    parkedWindowId = await ensureParkedWindow(state, workspaceId);
    for (const tab of visibleTabs) {
      if (!Number.isFinite(tab.id)) {
        continue;
      }
      rememberTabRecord(state, tab);
      try {
        await chrome.tabs.move(tab.id, { windowId: parkedWindowId, index: -1 });
        movedRecords.push(tabToRecord(tab));
      } catch (error) {
        console.warn("Failed to move archived workspace tab into parked window:", tab.id, error);
      }
    }
  }

  const parkedRecords = dedupeTabRecords([...(workspace.parkedTabs || []), ...alreadyParkedRecords, ...movedRecords]);
  if (parkedRecords.length > 0) {
    workspace.parkedTabs = parkedRecords;
    pushSnapshot(workspace, parkedRecords, reason, state.settings.maxSnapshotsPerWorkspace);
    workspace.updatedAt = now();
  }
  clearDeferredSleepForWorkspace(state, workspaceId);
  await cleanupParkedWindow(state, workspaceId);
  return { sleptCount: alreadyParkedRecords.length + movedRecords.length, parkedWindowId };
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

function serializeWorkspace(workspace, openTabCount = 0) {
  return {
    id: workspace.id,
    name: workspace.name,
    color: workspace.color,
    openTabCount: Math.max(0, Number(openTabCount) || 0),
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
  const tabs = await chrome.tabs.query({});
  const parkedWindowIds = getParkedWindowIds(state, tabs);
  const browserWindows = await chrome.windows.getAll();
  let attemptedWindowCount = 0;
  let dashboardWindowCount = 0;
  let failedWindowCount = 0;

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
    attemptedWindowCount += 1;
    try {
      await openOrFocusDashboard(browserWindow.id);
      dashboardWindowCount += 1;
    } catch (error) {
      failedWindowCount += 1;
      console.warn("Could not open dashboard for window:", browserWindow.id, error);
    }
  }

  return {
    attemptedWindowCount,
    dashboardWindowCount,
    failedWindowCount
  };
}

async function getOpenTabsForWindow(state, windowId, workspaceId) {
  const { tabs, changed } = await getWorkspaceTabsForWindow(state, windowId, workspaceId);

  return {
    changed,
    openTabs: tabs
      .map((tab) => {
      const url = getTabUrl(tab);
      return {
        id: tab.id,
        url,
        title: normalizeText(tab.title, fallbackTitleForUrl(url)),
        favIconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
        active: !!tab.active,
        lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null,
        discarded: !!tab.discarded
      };
      })
  };
}

async function getOpenTabCounts(state, windowId = null) {
  const counts = {};
  for (const workspaceId of Object.keys(state.workspaces || {})) {
    counts[workspaceId] = 0;
  }

  const tabs = await chrome.tabs.query(Number.isFinite(windowId) ? { windowId } : {});
  const parkedWindowIds = getParkedWindowIds(state, tabs);
  for (const tab of tabs) {
    if (
      !Number.isFinite(tab?.id) ||
      !Number.isFinite(tab?.windowId) ||
      parkedWindowIds.has(tab.windowId) ||
      tab.pinned ||
      !isWorkspaceManagedUrl(getTabUrl(tab))
    ) {
      continue;
    }

    const workspaceId = state.tabWorkspaceById[String(tab.id)];
    if (!workspaceId || !state.workspaces[workspaceId]) {
      continue;
    }

    counts[workspaceId] = (counts[workspaceId] || 0) + 1;
  }

  return counts;
}

function compareSearchResults(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  const kindRank = {
    workspace: 0,
    "open-tab": 1,
    "sleeping-tab": 2,
    "history-tab": 3
  };
  const leftRank = kindRank[left.kind] ?? 9;
  const rightRank = kindRank[right.kind] ?? 9;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if ((right.timestamp || 0) !== (left.timestamp || 0)) {
    return (right.timestamp || 0) - (left.timestamp || 0);
  }

  return String(left.title || left.url || "").localeCompare(String(right.title || right.url || ""));
}

async function searchWorkspaceContent(query, limit = SEARCH_RESULT_LIMIT, windowId = null) {
  return queueOperation(async () => {
    const state = await loadState();
    const safeLimit = Math.max(1, Math.min(25, Number(limit) || SEARCH_RESULT_LIMIT));
    const results = [];
    const historySeen = new Set();
    const openTabs = await chrome.tabs.query({});

    for (const workspaceId of state.workspaceOrder) {
      const workspace = state.workspaces[workspaceId];
      if (!workspace || Number.isFinite(workspace.archivedAt)) {
        continue;
      }

      const workspaceScore = computeSearchScore(query, workspace.name);
      if (workspaceScore !== null) {
        results.push({
          kind: "workspace",
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          title: workspace.name,
          url: "",
          openTabCount: 0,
          sleepingTabCount: Array.isArray(workspace.sessionTabs) ? workspace.sessionTabs.length : 0,
          timestamp: workspace.updatedAt,
          score: workspaceScore + 80
        });
      }

      for (const record of Array.isArray(workspace.sessionTabs) ? workspace.sessionTabs : []) {
        const score = computeSearchScore(query, record.title, record.url);
        if (score === null) {
          continue;
        }

        results.push({
          kind: "sleeping-tab",
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          title: normalizeText(record.title, record.url),
          url: record.url,
          snapshotId: null,
          timestamp: record.createdAt,
          score
        });
      }

      for (const snapshot of Array.isArray(workspace.history) ? workspace.history : []) {
        for (const record of Array.isArray(snapshot.tabs) ? snapshot.tabs : []) {
          const dedupeKey = `${workspace.id}:${record.url}`;
          if (historySeen.has(dedupeKey)) {
            continue;
          }

          const score = computeSearchScore(query, record.title, record.url);
          if (score === null) {
            continue;
          }

          historySeen.add(dedupeKey);
          results.push({
            kind: "history-tab",
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            title: normalizeText(record.title, record.url),
            url: record.url,
            snapshotId: snapshot.id,
            timestamp: snapshot.createdAt,
            score: score - 10
          });
        }
      }
    }

    const openTabCounts = {};
    const parkedWindowIds = getParkedWindowIds(state, openTabs);
    for (const tab of openTabs) {
      const url = getTabUrl(tab);
      if (
        !Number.isFinite(tab?.id) ||
        !Number.isFinite(tab?.windowId) ||
        parkedWindowIds.has(tab.windowId) ||
        tab.pinned ||
        !isWorkspaceManagedUrl(url)
      ) {
        continue;
      }

      const workspaceId = state.tabWorkspaceById[String(tab.id)];
      if (!workspaceId || !state.workspaces[workspaceId] || Number.isFinite(state.workspaces[workspaceId].archivedAt)) {
        continue;
      }

      openTabCounts[workspaceId] = (openTabCounts[workspaceId] || 0) + 1;
      const workspace = state.workspaces[workspaceId];
      const score = computeSearchScore(query, normalizeText(tab.title, fallbackTitleForUrl(url)), url);
      if (score === null) {
        continue;
      }

      results.push({
        kind: "open-tab",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        tabId: tab.id,
        title: normalizeText(tab.title, fallbackTitleForUrl(url)),
        url,
        timestamp: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : now(),
        score: score + 20
      });
    }

    for (const result of results) {
      if (result.kind === "workspace") {
        result.openTabCount = openTabCounts[result.workspaceId] || 0;
      }
    }

    return {
      results: results.sort(compareSearchResults).slice(0, safeLimit).map(({ score, ...result }) => result)
    };
  });
}

async function findWorkspaceTabInWindow(state, windowId, workspaceId, matcher) {
  const { tabs } = await getWorkspaceTabsForWindow(state, windowId, workspaceId);
  return tabs.find(matcher) || null;
}

async function activateTabInWindow(windowId, tabId) {
  await chrome.tabs.update(tabId, { active: true });
  try {
    await chrome.windows.update(windowId, { focused: true });
  } catch (error) {
    // Best effort only.
  }
}

async function openSearchResult(state, windowId, payload) {
  const workspace = state.workspaces[payload.workspaceId];
  if (!workspace || Number.isFinite(workspace.archivedAt)) {
    throw new Error("Workspace not found.");
  }

  if (payload.kind === "workspace") {
    const switchResult = await switchWorkspaceInWindow(state, windowId, workspace.id);
    return {
      kind: payload.kind,
      workspaceId: workspace.id,
      ...switchResult
    };
  }

  if (payload.kind === "open-tab" && Number.isFinite(payload.tabId)) {
    try {
      const existingTab = await chrome.tabs.get(payload.tabId);
      if (
        existingTab &&
        !existingTab.pinned &&
        isWorkspaceManagedUrl(getTabUrl(existingTab)) &&
        Number.isFinite(existingTab.windowId) &&
        existingTab.windowId !== windowId
      ) {
        return activateOrOpenWorkspaceTab(state, windowId, workspace.id, payload.tabId, payload.url, payload.title);
      }
    } catch (error) {
      // Fall through if the tab no longer exists.
    }
  }

  await switchWorkspaceInWindow(state, windowId, workspace.id, {
    openSleepingTabsWhenEmpty: false
  });

  const matchingVisibleTab = await findWorkspaceTabInWindow(
    state,
    windowId,
    workspace.id,
    (tab) =>
      (Number.isFinite(payload.tabId) && tab.id === payload.tabId) ||
      (typeof payload.url === "string" && payload.url.length > 0 && getTabUrl(tab) === payload.url)
  );

  if (matchingVisibleTab && Number.isFinite(matchingVisibleTab.id)) {
    state.activeWorkspaceByWindow[windowKey(windowId)] = workspace.id;
    workspace.updatedAt = now();
    workspace.lastActivatedAt = now();
    await activateTabInWindow(windowId, matchingVisibleTab.id);
    return {
      kind: payload.kind,
      workspaceId: workspace.id,
      tabId: matchingVisibleTab.id,
      openedCount: 0,
      activated: true
    };
  }

  if (payload.kind === "sleeping-tab") {
    const sleepingIndex = workspace.sessionTabs.findIndex((tab) => tab.url === payload.url);
    if (sleepingIndex >= 0) {
      const [record] = workspace.sessionTabs.splice(sleepingIndex, 1);
      const openResult = await openTabRecords(windowId, [record], {
        openFallback: false,
        activateFirst: true
      });
      setTabAssignments(state, openResult.tabs, workspace.id);
      workspace.updatedAt = now();
      workspace.lastActivatedAt = now();
      return {
        kind: payload.kind,
        workspaceId: workspace.id,
        tabId: openResult.tabIds[0] || null,
        openedCount: openResult.openedCount,
        activated: false
      };
    }
  }

  if (payload.kind === "history-tab") {
    const snapshot = workspace.history.find((item) => item.id === payload.snapshotId);
    const record = snapshot?.tabs.find((tab) => tab.url === payload.url);
    if (record) {
      const openResult = await openTabRecords(windowId, [record], {
        openFallback: false,
        activateFirst: true
      });
      setTabAssignments(state, openResult.tabs, workspace.id);
      workspace.updatedAt = now();
      workspace.lastActivatedAt = now();
      return {
        kind: payload.kind,
        workspaceId: workspace.id,
        tabId: openResult.tabIds[0] || null,
        openedCount: openResult.openedCount,
        activated: false
      };
    }
  }

  if (!isWorkspaceManagedUrl(payload.url)) {
    throw new Error("Result can no longer be opened.");
  }

  const openResult = await openTabRecords(
    windowId,
    [
      {
        url: payload.url,
        title: normalizeText(payload.title, payload.url),
        createdAt: now()
      }
    ],
    {
      openFallback: false,
      activateFirst: true
    }
  );
  setTabAssignments(state, openResult.tabs, workspace.id);
  workspace.updatedAt = now();
  workspace.lastActivatedAt = now();
  return {
    kind: payload.kind,
    workspaceId: workspace.id,
    tabId: openResult.tabIds[0] || null,
    openedCount: openResult.openedCount,
    activated: false
  };
}

function buildDashboardPayload(state, windowId, openTabs, openTabCounts = {}) {
  const activeWorkspaceId = state.activeWorkspaceByWindow[windowKey(windowId)] || state.workspaceOrder[0];
  const orderedWorkspaces = state.workspaceOrder.map((workspaceId) =>
    serializeWorkspace(state.workspaces[workspaceId], openTabCounts[workspaceId] || 0)
  );
  const archivedWorkspaces = (state.archivedWorkspaceOrder || []).map((workspaceId) =>
    serializeWorkspace(state.workspaces[workspaceId], openTabCounts[workspaceId] || 0)
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
    activeWorkspace: serializeWorkspace(state.workspaces[activeWorkspaceId], openTabCounts[activeWorkspaceId] || 0),
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
    let openTabsResult = await getOpenTabsForWindow(working, windowId, activeWorkspaceId);

    let finalState = working;
    if (ensured.changed || openTabsResult.changed || visibilityResult.changed) {
      finalState = await saveState(working);
      await notifyStateUpdated();
    }

    const openTabCounts = await getOpenTabCounts(finalState);
    return buildDashboardPayload(finalState, windowId, openTabsResult.openTabs, openTabCounts);
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
    const cutoff = now() - state.settings.inactivityMinutes * 60 * 1000;
    const tabs = await chrome.tabs.query({});
    let discardedCount = 0;
    let skippedUnassignedCount = 0;

    for (const tab of tabs) {
      const url = getTabUrl(tab);
      if (
        !Number.isFinite(tab?.id) ||
        !Number.isFinite(tab?.windowId) ||
        tab.pinned ||
        tab.active ||
        tab.discarded ||
        !isWorkspaceManagedUrl(url) ||
        !Number.isFinite(tab.lastAccessed) ||
        tab.lastAccessed > cutoff
      ) {
        continue;
      }

      const tabIdKey = String(tab.id);
      const workspaceId = state.tabWorkspaceById[tabIdKey];
      if (!workspaceId || !state.workspaces[workspaceId] || Number.isFinite(state.workspaces[workspaceId].archivedAt)) {
        skippedUnassignedCount += 1;
        continue;
      }
      rememberTabRecord(state, tab);

      try {
        await chrome.tabs.discard(tab.id);
        discardedCount += 1;
      } catch (error) {
        console.warn("Could not discard dormant tab:", tab.id, error);
      }
    }

    const clearedDeferredSleep = Object.keys(state.deferredSleepByWindow || {}).length > 0;
    state.deferredSleepByWindow = {};
    return { discardedCount, assignedCount: 0, skippedUnassignedCount, sleptCount: 0, clearedDeferredSleep };
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

    case "SEARCH_WORKSPACE_CONTENT": {
      return searchWorkspaceContent(payload.query, payload.limit, requestedWindowId);
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
        setTabAssignments(state, openResult.tabs, workspace.id);
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
        setTabAssignments(state, openResult.tabs, workspace.id);
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
        const result = await sleepOpenTabsById(state, requestedWindowId, [payload.tabId], "manual");
        return { slept: result.sleptCount > 0, tabId: payload.tabId, ...result };
      });
    }

    case "DELETE_SELECTED_TABS": {
      return mutateState(async (state) =>
        deleteSelectedTabsPermanently(
          state,
          requestedWindowId,
          payload.workspaceId,
          payload.openTabIds,
          payload.sleepingTabs
        )
      );
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

    case "OPEN_SEARCH_RESULT": {
      return mutateState(async (state) => openSearchResult(state, requestedWindowId, payload));
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
        setTabAssignments(state, openResult.tabs, workspace.id);
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

        const { tabs: activeTabs } = await getWorkspaceTabsForWindow(state, requestedWindowId, workspace.id);
        const activeRecords = dedupeTabRecords(activeTabs.map(tabToRecord));
        if (activeRecords.length > 0) {
          pushSnapshot(workspace, activeRecords, "restore", state.settings.maxSnapshotsPerWorkspace);
        }

        const openResult = await openTabRecords(requestedWindowId, snapshot.tabs, { openFallback: true });
        setTabAssignments(state, openResult.tabs, workspace.id);

        workspace.updatedAt = now();
        workspace.lastActivatedAt = now();
        return { workspaceId: workspace.id, openedCount: openResult.openedCount };
      });
    }

    case "OPEN_SNAPSHOT_TAB": {
      return mutateState(async (state) => {
        const workspace = state.workspaces[payload.workspaceId];
        if (!workspace) {
          throw new Error("Workspace not found.");
        }
        const snapshot = workspace.history.find((item) => item.id === payload.snapshotId);
        if (!snapshot) {
          throw new Error("Snapshot not found.");
        }
        const record = snapshot.tabs.find((tab) => tab.url === payload.url);
        if (!record) {
          throw new Error("Snapshot tab not found.");
        }

        await switchWorkspaceInWindow(state, requestedWindowId, workspace.id);

        const openResult = await openTabRecords(requestedWindowId, [record], { openFallback: false });
        setTabAssignments(state, openResult.tabs, workspace.id);
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

    case "SYNC_NOW": {
      return syncNow();
    }

    case "EXPORT_STATE_BACKUP": {
      return exportStateBackup();
    }

    case "IMPORT_STATE_BACKUP": {
      return importStateBackup(payload.backup);
    }

    case "OPEN_DASHBOARD": {
      return openOrFocusDashboard(requestedWindowId);
    }

    default:
      throw new Error(`Unknown action: ${message.action}`);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  const shouldOpenDashboard = details.reason === "install" || details.reason === "update";
  void bootstrapExtensionRuntime(`installed:${details.reason}`, {
    openDashboard: shouldOpenDashboard,
    suppressTabAssignment: false
  }).catch((error) => console.warn("Could not bootstrap Ordinator after install/update:", error));
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrapExtensionRuntime("startup", {
    openDashboard: true,
    suppressTabAssignment: true
  }).catch((error) => console.warn("Could not bootstrap Ordinator on startup:", error));
});

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    const windowId = Number.isFinite(tab?.windowId) ? tab.windowId : await fetchCurrentWindowId();
    await openOrFocusDashboard(windowId);
  })();
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo = {}) => {
  scheduleSyncExport();
  void queueOperation(async () => {
    const state = await loadState();
    const key = String(tabId);
    const workspaceId = state.tabWorkspaceById[key];
    const record = state.tabRecordsById?.[key] || null;
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

    if (!workspaceId && !hasDeferredReference) {
      return;
    }

    const working = structuredClone(state);
    const workspace = working.workspaces[workspaceId];
    if (workspace && record && isWorkspaceManagedUrl(record.url)) {
      if (removeInfo?.isWindowClosing) {
        appendParkedTabs(workspace, [record]);
        workspace.updatedAt = now();
      } else {
        const previousParkedCount = Array.isArray(workspace.parkedTabs) ? workspace.parkedTabs.length : 0;
        workspace.parkedTabs = removeFirstMatchingTabRecord(workspace.parkedTabs, record);
        if (workspace.parkedTabs.length !== previousParkedCount) {
          workspace.updatedAt = now();
        }
      }
    }
    removeTabAssignments(working, [tabId]);
    await saveState(working);
    await notifyStateUpdated();
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    try {
      const suppressAssignment = await shouldSuppressCreatedTabAssignment(tab);
      if (!suppressAssignment) {
        await assignNewTabToActiveWorkspace(tab, { allowNewAssignment: true });
      }
    } catch (error) {
      console.warn("Could not assign created tab to workspace:", error);
    } finally {
      try {
        await refreshExtensionHeartbeat("tab-created");
      } catch (error) {
        // Best effort only.
      }
    }
  })();
  scheduleSyncExport();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((typeof changeInfo.url === "string" || changeInfo.status === "complete") && tab) {
    void assignNewTabToActiveWorkspace(tab, { allowNewAssignment: true });
  }
  if (changeInfo.status === "complete" || typeof changeInfo.title === "string" || typeof changeInfo.url === "string") {
    scheduleSyncExport();
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  scheduleSyncExport();
  void queueOperation(async () => {
    const state = await loadState();
    const workspaceIds = findWorkspaceIdsByParkedWindow(state, windowId);
    if (workspaceIds.length === 0) {
      return;
    }

    const working = structuredClone(state);
    for (const workspaceId of workspaceIds) {
      const workspace = working.workspaces[workspaceId];
      if (workspace) {
        workspace.parkedTabs = dedupeTabRecords(Array.isArray(workspace.parkedTabs) ? workspace.parkedTabs : []);
        workspace.updatedAt = now();
      }
    }
    clearParkedWindowReferences(working, windowId);
    await saveState(working);
    await notifyStateUpdated();
  });
});

chrome.windows.onCreated.addListener((browserWindow) => {
  if (!Number.isFinite(browserWindow?.id) || (browserWindow.type && browserWindow.type !== "normal") || browserWindow.incognito) {
    return;
  }

  void (async () => {
    try {
      await refreshExtensionHeartbeat("window-created");
      const bootstrapState = await readStartupBootstrapState();
      const retryUntil = Number(bootstrapState.dashboardRetryUntil);
      if (!Number.isFinite(retryUntil) || retryUntil <= now()) {
        return;
      }
      setTimeout(() => {
        void runStartupDashboardRetry("window-created").catch((error) =>
          console.warn("Could not retry startup dashboard after window creation:", error)
        );
      }, 1000);
    } catch (error) {
      console.warn("Could not process startup window creation:", error);
    }
  })();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!Number.isFinite(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  void queueOperation(async () => {
    const state = await loadState();
    if (findWorkspaceIdsByParkedWindow(state, windowId).length === 0) {
      return;
    }
    await ensureParkedWindowPresentation(windowId);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STARTUP_DASHBOARD_ALARM) {
    void runStartupDashboardRetry("startup-alarm").catch((error) =>
      console.warn("Could not retry startup dashboard after alarm:", error)
    );
    return;
  }

  if (alarm.name === MEMORY_ALARM) {
    void (async () => {
      try {
        await refreshExtensionHeartbeat("memory-alarm");
        await runMemorySweep();
        await refreshExtensionHeartbeat("memory-sweep");
      } catch (error) {
        console.warn("Could not complete memory sweep:", error);
      }
    })();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  const hasRelevantChange = Object.keys(changes || {}).some(
    (key) => key === STORAGE_KEY || key === SYNC_META_KEY || key.startsWith(SYNC_OPEN_TABS_KEY_PREFIX)
  );
  if (!hasRelevantChange) {
    return;
  }

  stateCache = null;
  void notifyStateUpdated();
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
