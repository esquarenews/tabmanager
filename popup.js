const ui = {
  meta: document.querySelector("#meta"),
  status: document.querySelector("#status"),
  workspaceSelect: document.querySelector("#workspaceSelect"),
  switchButton: document.querySelector("#switchButton"),
  sleepButton: document.querySelector("#sleepButton"),
  openPanelButton: document.querySelector("#openPanelButton")
};

const state = {
  windowId: null,
  dashboard: null
};

async function send(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, payload });
  if (!response || !response.ok) {
    throw new Error(response?.error || "Request failed.");
  }
  return response.result;
}

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.style.color = isError ? "#be123c" : "#60708f";
}

function render() {
  if (!state.dashboard) {
    return;
  }

  const workspace = state.dashboard.activeWorkspace;
  ui.meta.textContent = `${state.dashboard.openTabs.length} open • ${workspace.sessionTabs.length} sleeping • ${workspace.resources.length} resources`;

  ui.workspaceSelect.textContent = "";
  for (const item of state.dashboard.workspaces) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    if (item.id === state.dashboard.activeWorkspaceId) {
      option.selected = true;
    }
    ui.workspaceSelect.appendChild(option);
  }
}

async function refresh() {
  state.dashboard = await send("GET_DASHBOARD_DATA", { windowId: state.windowId });
  render();
}

async function init() {
  const windowInfo = await chrome.windows.getCurrent();
  if (typeof windowInfo.id !== "number") {
    throw new Error("Could not determine current window.");
  }
  state.windowId = windowInfo.id;
  await refresh();

  ui.switchButton.addEventListener("click", async () => {
    try {
      await send("SWITCH_WORKSPACE", {
        windowId: state.windowId,
        workspaceId: ui.workspaceSelect.value
      });
      await refresh();
      setStatus("Workspace switched.");
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  ui.sleepButton.addEventListener("click", async () => {
    try {
      await send("SLEEP_ACTIVE_WORKSPACE", {
        windowId: state.windowId,
        reason: "manual"
      });
      await refresh();
      setStatus("Open tabs were put to sleep.");
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  ui.openPanelButton.addEventListener("click", async () => {
    try {
      await send("OPEN_DASHBOARD", { windowId: state.windowId });
      setStatus("Dashboard opened.");
      window.close();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
}

void init().catch((error) => {
  setStatus(error.message || "Popup failed to initialize.", true);
});
