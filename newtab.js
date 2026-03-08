const SETTINGS_ACTION = "GET_SETTINGS";
const BACKGROUND_CACHE_KEY = "ordinator_newtab_background_cache";
const LAST_BACKGROUND_KEY = "ordinator_newtab_last_background";
const WEATHER_CACHE_KEY = "ordinator_newtab_weather_cache";
const BACKGROUND_CACHE_MS = 4 * 60 * 60 * 1000;
const BACKGROUND_BATCH_SIZE = 4;
const WEATHER_CACHE_MS = 15 * 60 * 1000;
const CHATGPT_PROMPT_PARAM = "ordinator_prompt";

const ui = {
  googleForm: document.querySelector("#googleForm"),
  googleQuery: document.querySelector("#googleQuery"),
  chatgptForm: document.querySelector("#chatgptForm"),
  chatgptQuery: document.querySelector("#chatgptQuery"),
  timeValue: document.querySelector("#timeValue"),
  dateValue: document.querySelector("#dateValue"),
  weatherValue: document.querySelector("#weatherValue"),
  photoCredit: document.querySelector("#photoCredit")
};

async function send(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, payload });
  if (!response || !response.ok) {
    throw new Error(response?.error || "Request failed.");
  }
  return response.result;
}

function formatClockParts(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return {
    time: `${hour}:${minute}`,
    date: `${day}/${month}/${year}`
  };
}

function updateClock() {
  const now = new Date();
  const parts = formatClockParts(now);
  ui.timeValue.textContent = parts.time;
  ui.dateValue.textContent = parts.date;
}

async function getLocalCache(key) {
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function setLocalCache(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

function shuffle(items) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function normalizeBackgroundBatch(cache) {
  if (!cache || typeof cache !== "object") {
    return null;
  }

  if (Array.isArray(cache.images)) {
    const images = cache.images.filter(
      (image) => image && typeof image.imageUrl === "string" && image.imageUrl.length > 0
    );
    if (images.length === 0) {
      return null;
    }
    return {
      images,
      batchFetchedAt: Number.isFinite(cache.batchFetchedAt) ? cache.batchFetchedAt : Date.now(),
      nextIndex: Number.isFinite(cache.nextIndex) ? Math.max(0, cache.nextIndex) : 0,
      expiresAt: Number.isFinite(cache.expiresAt)
        ? cache.expiresAt
        : (Number.isFinite(cache.batchFetchedAt) ? cache.batchFetchedAt : Date.now()) + images.length * BACKGROUND_CACHE_MS
    };
  }

  if (typeof cache.imageUrl === "string" && cache.imageUrl.length > 0) {
    return {
      images: [cache],
      batchFetchedAt: Number.isFinite(cache.fetchedAt) ? cache.fetchedAt : Date.now(),
      nextIndex: 0,
      expiresAt: Number.isFinite(cache.expiresAt) ? cache.expiresAt : Date.now() + BACKGROUND_CACHE_MS
    };
  }

  return null;
}

function getBackgroundForDisplay(cache) {
  const normalized = normalizeBackgroundBatch(cache);
  if (!normalized) {
    return null;
  }

  const currentIndex = normalized.nextIndex % normalized.images.length;
  const background = normalized.images[currentIndex] || normalized.images[0] || null;
  return {
    background,
    nextCache: {
      ...normalized,
      nextIndex: (currentIndex + 1) % normalized.images.length
    }
  };
}

function buildUnsplashImageUrl(photo) {
  if (typeof photo?.urls?.raw === "string") {
    const imageUrl = new URL(photo.urls.raw);
    imageUrl.searchParams.set("auto", "format");
    imageUrl.searchParams.set("fit", "max");
    imageUrl.searchParams.set("q", "80");
    imageUrl.searchParams.set("w", String(Math.max(1600, Math.round(window.innerWidth * window.devicePixelRatio))));
    return imageUrl.toString();
  }
  return typeof photo?.urls?.regular === "string" ? photo.urls.regular : "";
}

function applyBackground(background) {
  if (!background || typeof background.imageUrl !== "string" || background.imageUrl.length === 0) {
    try {
      window.localStorage.removeItem(LAST_BACKGROUND_KEY);
    } catch (error) {
      // Ignore local bootstrap cache errors.
    }
    ui.photoCredit.textContent = "Add an Unsplash Access Key in Ordinator settings to enable featured backgrounds.";
    return;
  }

  document.documentElement.style.setProperty("--backdrop-image", `url("${background.imageUrl}")`);
  try {
    window.localStorage.setItem(
      LAST_BACKGROUND_KEY,
      JSON.stringify({
        imageUrl: background.imageUrl
      })
    );
  } catch (error) {
    // Ignore local bootstrap cache errors.
  }
  if (background.photographer && background.photoPageUrl) {
    ui.photoCredit.textContent = "";
    ui.photoCredit.append("Photo by ");
    const link = document.createElement("a");
    link.href = background.photoPageUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = background.photographer;
    const imageLink = document.createElement("a");
    imageLink.href = background.photoPageUrl;
    imageLink.target = "_blank";
    imageLink.rel = "noreferrer";
    imageLink.textContent = "View image";
    ui.photoCredit.append(link, " on Unsplash", " · ", imageLink);
  } else {
    ui.photoCredit.textContent = "Background from Unsplash";
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function fetchFeaturedUnsplashBackgroundBatch(accessKey) {
  const headers = {
    Authorization: `Client-ID ${accessKey}`,
    "Accept-Version": "v1"
  };
  const topics = await fetchJson("https://api.unsplash.com/topics?per_page=12&order_by=featured", { headers });
  if (!Array.isArray(topics) || topics.length === 0) {
    throw new Error("No featured topics available.");
  }

  const topic = topics[Math.floor(Math.random() * topics.length)];
  const topicPhotos = await fetchJson(
    `https://api.unsplash.com/topics/${encodeURIComponent(topic.slug)}/photos?per_page=30&orientation=landscape&order_by=popular`,
    { headers }
  );
  if (!Array.isArray(topicPhotos) || topicPhotos.length === 0) {
    throw new Error("No topic photos available.");
  }

  const uniquePhotos = [];
  const seenPhotoLinks = new Set();
  for (const photo of shuffle(topicPhotos)) {
    const photoPageUrl = typeof photo?.links?.html === "string" ? photo.links.html : "";
    if (!photoPageUrl || seenPhotoLinks.has(photoPageUrl)) {
      continue;
    }
    seenPhotoLinks.add(photoPageUrl);
    uniquePhotos.push(photo);
    if (uniquePhotos.length >= BACKGROUND_BATCH_SIZE) {
      break;
    }
  }

  if (uniquePhotos.length === 0) {
    throw new Error("No usable topic photos available.");
  }

  const batchFetchedAt = Date.now();
  return {
    images: uniquePhotos.map((photo) => ({
      imageUrl: buildUnsplashImageUrl(photo),
      photographer: photo?.user?.name || "",
      photoPageUrl:
        typeof photo?.links?.html === "string"
          ? `${photo.links.html}${photo.links.html.includes("?") ? "&" : "?"}utm_source=ordinator&utm_medium=referral`
          : ""
    })),
    batchFetchedAt,
    nextIndex: 0,
    expiresAt: batchFetchedAt + uniquePhotos.length * BACKGROUND_CACHE_MS
  };
}

async function loadBackground() {
  const { settings } = await send(SETTINGS_ACTION);
  const cached = await getLocalCache(BACKGROUND_CACHE_KEY);
  const cachedBatch = normalizeBackgroundBatch(cached);
  const cachedSelection = getBackgroundForDisplay(cachedBatch);
  if (cachedSelection?.background) {
    applyBackground(cachedSelection.background);
    await setLocalCache(BACKGROUND_CACHE_KEY, cachedSelection.nextCache);
  } else {
    applyBackground(null);
  }

  const accessKey = typeof settings?.unsplashAccessKey === "string" ? settings.unsplashAccessKey.trim() : "";
  const shouldRefresh =
    !cachedBatch ||
    cachedBatch.images.length < BACKGROUND_BATCH_SIZE ||
    !Number.isFinite(cachedBatch.expiresAt) ||
    cachedBatch.expiresAt <= Date.now();
  if (!accessKey || !shouldRefresh) {
    return;
  }

  try {
    const freshBatch = await fetchFeaturedUnsplashBackgroundBatch(accessKey);
    const freshSelection = getBackgroundForDisplay(freshBatch);
    if (!freshSelection?.background) {
      return;
    }
    await setLocalCache(BACKGROUND_CACHE_KEY, freshSelection.nextCache);
    applyBackground(freshSelection.background);
  } catch (error) {
    if (!cachedSelection?.background) {
      applyBackground(null);
    }
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      maximumAge: WEATHER_CACHE_MS,
      timeout: 8000
    });
  });
}

async function fetchWeather(latitude, longitude) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}` +
    "&current=temperature_2m&timezone=auto";
  const payload = await fetchJson(url);
  const temperature = payload?.current?.temperature_2m;
  const units = payload?.current_units?.temperature_2m || "°C";
  if (!Number.isFinite(temperature)) {
    throw new Error("Weather data unavailable.");
  }
  return {
    label: `${Math.round(temperature)}${units}`,
    fetchedAt: Date.now(),
    expiresAt: Date.now() + WEATHER_CACHE_MS
  };
}

async function loadWeather() {
  const cached = await getLocalCache(WEATHER_CACHE_KEY);
  if (cached && Number.isFinite(cached.expiresAt) && cached.expiresAt > Date.now()) {
    ui.weatherValue.textContent = cached.label;
    return;
  }

  if (!("geolocation" in navigator)) {
    ui.weatherValue.textContent = "Weather unavailable";
    return;
  }

  try {
    const position = await getCurrentPosition();
    const weather = await fetchWeather(position.coords.latitude, position.coords.longitude);
    ui.weatherValue.textContent = weather.label;
    await setLocalCache(WEATHER_CACHE_KEY, weather);
  } catch (error) {
    ui.weatherValue.textContent = cached?.label || "Weather unavailable";
  }
}

function wireForms() {
  ui.chatgptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = ui.chatgptQuery.value.trim();
    if (!query) {
      ui.chatgptQuery.focus();
      return;
    }
    const targetUrl = new URL("https://chatgpt.com/");
    targetUrl.searchParams.set(CHATGPT_PROMPT_PARAM, query);
    window.location.href = targetUrl.toString();
  });
}

async function init() {
  updateClock();
  window.setInterval(updateClock, 1000);
  wireForms();
  await Promise.allSettled([loadBackground(), loadWeather()]);
  ui.googleQuery.focus();
}

void init();
