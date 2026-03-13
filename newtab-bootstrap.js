(function bootstrapNewTabBackground() {
  const STORAGE_KEY = "ordinator_newtab_last_background";

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }

    const background = JSON.parse(raw);
    if (
      !background ||
      typeof background.imageUrl !== "string" ||
      background.imageUrl.length === 0 ||
      !Number.isFinite(background.expiresAt) ||
      background.expiresAt <= Date.now()
    ) {
      return;
    }

    document.documentElement.style.setProperty("--backdrop-image", `url("${background.imageUrl}")`);

    const preload = document.createElement("link");
    preload.rel = "preload";
    preload.as = "image";
    preload.href = background.imageUrl;
    document.head.appendChild(preload);
  } catch (error) {
    // Ignore malformed local bootstrap cache.
  }
})();
