// ============================================================
// Drama Live Gateway
// Cloudflare Worker - Single File
//
// API + AES-CBC + Resolver + HLS Proxy + Browser Player
// ============================================================

const CONFIG = {
  LIVE_API_BASE:
    "http://live.sepdatabridge.site/api/live/livedrama/v13.0.0",

  REDIRECT_API_BASE:
    "http://redirect.sepdatabridge.site/redirect",

  AES_KEY: "0123456789abcdef",
  AES_IV: "fedcba9876543210",

  APP_VERSION: "186",
  DEVICE_API: "36",
  LANGUAGE: "ar",
  TIMEZONE: "Asia/Baghdad",
  DEVICE_TYPE: "phone",
  STORE: "playStore",
  KEY_ACTIVATED_TYPE: "202122",

  // Cache inside current Worker isolate only.
  API_CACHE_MS: 12000,
  RESOLVE_CACHE_MS: 12000,

  // Upstream timeouts
  API_TIMEOUT: 15000,
  MANIFEST_TIMEOUT: 12000,
  RESOURCE_TIMEOUT: 20000,

  MAX_REDIRECT_DEPTH: 3,

  DEFAULT_UA:
    "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
};


// ============================================================
// MEMORY CACHE
// ============================================================

const apiCache = new Map();
const resolveCache = new Map();

function cacheGet(map, key, ttl) {
  const item = map.get(key);

  if (!item) return null;

  if (Date.now() - item.time > ttl) {
    map.delete(key);
    return null;
  }

  return item.value;
}

function cacheSet(map, key, value) {
  map.set(key, {
    time: Date.now(),
    value,
  });

  // Prevent unlimited growth in long-lived isolates.
  if (map.size > 500) {
    const first = map.keys().next().value;
    if (first) map.delete(first);
  }
}


// ============================================================
// BASIC HELPERS
// ============================================================

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function randomUUID() {
  try {
    return crypto.randomUUID();
  } catch {
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2)
    );
  }
}

const DEVICE_ID = randomUUID();

function makeUserId() {
  return `_41810_${Date.now()}_notloggedin.com_dramalive3`;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function textResponse(text, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(error, status = 500) {
  return jsonResponse(
    {
      ok: false,
      error: String(error?.message || error || "Unknown error"),
    },
    status
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJSON(value) {
  try {
    const x = JSON.parse(value);
    return x && typeof x === "object" ? x : null;
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}


// ============================================================
// BASE64
// ============================================================

function bytesToBase64(bytes) {
  let binary = "";

  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length))
    );
  }

  return btoa(binary);
}

function base64ToBytes(value) {
  const clean = String(value || "").replace(/\s+/g, "");
  const binary = atob(clean);

  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }

  return out;
}

function encodeBase64Url(text) {
  return bytesToBase64(textEncoder.encode(text))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  value = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (value.length % 4) {
    value += "=";
  }

  return textDecoder.decode(base64ToBytes(value));
}


// ============================================================
// AES-CBC
// ============================================================

let importedAesKey = null;

async function getAesKey() {
  if (importedAesKey) return importedAesKey;

  importedAesKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(CONFIG.AES_KEY),
    {
      name: "AES-CBC",
    },
    false,
    ["encrypt", "decrypt"]
  );

  return importedAesKey;
}

async function encryptPayload(data) {
  const key = await getAesKey();

  const iv = textEncoder.encode(CONFIG.AES_IV);

  const raw = textEncoder.encode(
    JSON.stringify(data)
  );

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-CBC",
      iv,
    },
    key,
    raw
  );

  const encryptedB64 = bytesToBase64(
    new Uint8Array(encrypted)
  );

  const ivB64 = bytesToBase64(iv);

  return `${encryptedB64}:${ivB64}`;
}

async function decryptPayload(payload) {
  payload = String(payload || "").trim();

  const pos = payload.lastIndexOf(":");

  if (pos === -1) {
    throw new Error("Encrypted response missing IV");
  }

  const encryptedB64 = payload.slice(0, pos);
  const ivB64 = payload.slice(pos + 1);

  const encrypted = base64ToBytes(encryptedB64);
  const iv = base64ToBytes(ivB64);

  const key = await getAesKey();

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-CBC",
      iv,
    },
    key,
    encrypted
  );

  const text = textDecoder.decode(decrypted);

  return JSON.parse(text);
}


// ============================================================
// TIMEOUT FETCH
// ============================================================

async function fetchTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// API PAYLOAD
// ============================================================

function commonPayload() {
  return {
    user_id: makeUserId(),

    device_id: DEVICE_ID,

    device_api: CONFIG.DEVICE_API,

    version_name: CONFIG.APP_VERSION,

    language: CONFIG.LANGUAGE,

    timezone: CONFIG.TIMEZONE,

    device_type: CONFIG.DEVICE_TYPE,

    KEY_ACTIVATED_TYPE:
      CONFIG.KEY_ACTIVATED_TYPE,

    store: CONFIG.STORE,

    isStoreVersion: false,

    isPremium: false,

    isCoupon_active: false,

    hideAds: false,

    appCount: JSON.stringify({
      adsFailed: 0,
      adsLoaded: 0,
      adsShowed: 0,
      runCount: 1,
    }),

    mainServer:
      "http://main.backendcoreapi.com/api/live/livedrama/v13.0.0/",
  };
}


// ============================================================
// ENCRYPTED POST
// ============================================================

async function encryptedPost(url, data) {
  const body = await encryptPayload(data);

  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchTimeout(
        url,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json; charset=utf-8",

            "User-Agent":
              "Dalvik/2.1.0 (Linux; U; Android 16)",

            Accept: "*/*",

            "Accept-Encoding": "gzip",
          },

          body,
          redirect: "follow",
        },
        CONFIG.API_TIMEOUT
      );

      if (!response.ok) {
        throw new Error(
          `API HTTP ${response.status}`
        );
      }

      const text = await response.text();

      return await decryptPayload(text);

    } catch (error) {
      lastError = error;

      if (attempt === 0) {
        await sleep(200);
      }
    }
  }

  throw lastError;
}


// ============================================================
// API
// ============================================================

async function getTopics(force = false) {
  const key = "topics";

  if (!force) {
    const cached = cacheGet(
      apiCache,
      key,
      CONFIG.API_CACHE_MS
    );

    if (cached) return cached;
  }

  const payload = commonPayload();

  payload.type = "tv";

  const obj = await encryptedPost(
    `${CONFIG.LIVE_API_BASE}/getliveTopics`,
    payload
  );

  const items = obj.live_topics || [];

  cacheSet(apiCache, key, items);

  return items;
}

async function getChannels(topic, force = false) {
  const key = `channels:${topic}`;

  if (!force) {
    const cached = cacheGet(
      apiCache,
      key,
      CONFIG.API_CACHE_MS
    );

    if (cached) return cached;
  }

  const payload = commonPayload();

  payload.type = "tv";
  payload.topic = topic;

  const obj = await encryptedPost(
    `${CONFIG.LIVE_API_BASE}/getLiveByTopic`,
    payload
  );

  const items = obj.live || [];

  cacheSet(apiCache, key, items);

  return items;
}

async function getStreamInfo(channelId) {
  const payload = commonPayload();

  payload.id = String(channelId);

  const obj = await encryptedPost(
    `${CONFIG.LIVE_API_BASE}/getLiveAllStreamsById`,
    payload
  );

  if (!obj.live) {
    throw new Error(
      "لم يرجع الخادم معلومات بث للقناة"
    );
  }

  return obj.live;
}


// ============================================================
// SERVER PARSING
// ============================================================

function prettyLabel(value, fallback) {
  const text = String(value || "");
  const upper = text.toUpperCase();

  if (upper.includes("DADDY")) {
    const m = upper.match(
      /DADDY[_\- ]*([A-Z0-9]+)/
    );

    return m
      ? `Daddy ${m[1]}`
      : "Daddy";
  }

  if (
    upper.includes("LOAD_BALANCER") ||
    upper.includes("LOADBALANCER")
  ) {
    return "Load Balancer";
  }

  if (
    upper.includes("DESCRIPTION_M+") ||
    upper.includes("DESCRIPTION_MPLUS") ||
    upper.includes("_M+_")
  ) {
    return "M+";
  }

  if (
    upper.includes("DESCRIPTION_DL") ||
    upper.includes("_DL_")
  ) {
    return "DL";
  }

  if (
    upper.includes("DESCRIPTION_SD") ||
    upper.includes("_SD_")
  ) {
    return "SD";
  }

  const m = text.match(
    /description_([^/]+?)(?:_DL_|\/|$)/i
  );

  if (m) {
    const label = m[1]
      .replace(/_/g, " ")
      .replace(/-/g, " ")
      .trim();

    if (label) return label.slice(0, 50);
  }

  return fallback;
}

function parseBackupPiece(raw, index) {
  let part = String(raw || "").trim();

  if (!part) return null;

  let source = part;
  let resolverAgent = "redirect";

  if (part.includes(" -- ")) {
    const splitIndex = part.lastIndexOf(" -- ");

    source = part.slice(0, splitIndex).trim();

    resolverAgent =
      part.slice(splitIndex + 4).trim() ||
      "redirect";
  }

  const meta = safeJSON(source) || {};

  const directUrl = String(
    meta.url || source
  ).trim();

  const description = String(
    meta.description || ""
  ).trim();

  return {
    request_url: source,

    direct_url: directUrl,

    agent: resolverAgent,

    label:
      description ||
      prettyLabel(
        directUrl,
        `سيرفر ${index}`
      ),

    description:
      description ||
      prettyLabel(
        directUrl,
        `سيرفر ${index}`
      ),

    headers:
      meta.headers &&
      typeof meta.headers === "object"
        ? meta.headers
        : {},

    acceptSSL: meta.acceptSSL,

    mediatype: meta.mediatype,

    swap:
      meta.swap &&
      typeof meta.swap === "object"
        ? meta.swap
        : {},
  };
}

function parseStreamOptions(live) {
  const options = [];

  const mainUrl = String(
    live.url || ""
  ).trim();

  if (mainUrl) {
    options.push({
      request_url: mainUrl,

      direct_url: mainUrl,

      agent:
        String(live.agent || "redirect"),

      label: prettyLabel(
        mainUrl,
        "الرئيسي"
      ),

      description: "السيرفر الرئيسي",

      headers:
        live.headers &&
        typeof live.headers === "object"
          ? live.headers
          : {},

      acceptSSL: live.acceptSSL,

      mediatype: live.mediatype,

      swap:
        live.swap &&
        typeof live.swap === "object"
          ? live.swap
          : {},
    });
  }

  let parts = [];

  if (Array.isArray(live.backup)) {
    parts = live.backup;
  } else if (typeof live.backup === "string") {
    parts = live.backup.split("-;-");
  }

  for (let i = 0; i < parts.length; i++) {
    const item = parseBackupPiece(
      parts[i],
      i + 2
    );

    if (item) options.push(item);
  }

  const unique = [];
  const seen = new Set();

  for (const option of options) {
    const signature =
      `${option.request_url}|${option.agent}`;

    if (seen.has(signature)) continue;

    seen.add(signature);
    unique.push(option);
  }

  return unique;
}

async function getStreamOptions(channelId) {
  const live =
    await getStreamInfo(channelId);

  const options =
    parseStreamOptions(live);

  if (!options.length) {
    throw new Error(
      "لا توجد سيرفرات لهذه القناة"
    );
  }

  return {
    live,
    options,
  };
}


// ============================================================
// REDIRECT RESOLVER
// ============================================================

function unwrapResolverData(obj) {
  const data =
    obj && typeof obj.data === "object"
      ? obj.data
      : {};

  const outerAgent = data.agent;

  let nested = data.url;

  if (typeof nested === "string") {
    const parsed = safeJSON(nested);

    nested = parsed || {
      url: nested,
    };
  }

  if (
    !nested ||
    typeof nested !== "object"
  ) {
    nested = {};
  }

  return {
    outer_agent: outerAgent,

    url: nested.url,

    agent: nested.agent,

    acceptSSL: nested.acceptSSL,

    headers:
      nested.headers &&
      typeof nested.headers === "object"
        ? nested.headers
        : {},

    mediatype: nested.mediatype,

    swap:
      nested.swap &&
      typeof nested.swap === "object"
        ? nested.swap
        : {},

    raw: obj,
  };
}

async function resolveRedirect(
  channelId,
  streamUrl,
  agent
) {
  const payload = commonPayload();

  payload.id = String(channelId);
  payload.url = streamUrl;
  payload.agent = agent;

  const obj = await encryptedPost(
    `${CONFIG.REDIRECT_API_BASE}/getLiveByRedirect`,
    payload
  );

  return unwrapResolverData(obj);
}


// ============================================================
// CHANNEL RESOLUTION
// ============================================================

async function resolveChannel(
  channelId,
  serverIndex = 0,
  force = false
) {
  channelId = String(channelId);

  serverIndex =
    Number.parseInt(serverIndex, 10) || 0;

  const cacheKey =
    `${channelId}:${serverIndex}`;

  if (!force) {
    const cached = cacheGet(
      resolveCache,
      cacheKey,
      CONFIG.RESOLVE_CACHE_MS
    );

    if (cached) {
      return cached;
    }
  }

  const {
    live,
    options,
  } = await getStreamOptions(channelId);

  if (
    serverIndex < 0 ||
    serverIndex >= options.length
  ) {
    throw new Error(
      "رقم السيرفر غير صالح"
    );
  }

  const selected =
    options[serverIndex];

  const source =
    selected.request_url || "";

  let resolverAgent =
    selected.agent || "redirect";

  let resolved;

  const resolverModes = new Set([
    "redirect",
    "double_redirect",
    "all_streams_redirect",
  ]);

  if (resolverModes.has(resolverAgent)) {
    resolved =
      await resolveRedirect(
        channelId,
        source,
        resolverAgent
      );

    // --------------------------------------------------------
    // Recursive redirect handling
    // --------------------------------------------------------

    for (
      let depth = 0;
      depth < CONFIG.MAX_REDIRECT_DEPTH;
      depth++
    ) {
      const nextUrl = String(
        resolved.url || ""
      );

      const nextAgent = String(
        resolved.agent ||
        resolved.outer_agent ||
        ""
      );

      const looksLikeResolver =
        nextUrl.includes(".LS.") ||
        nextUrl.includes("custom_handler") ||
        resolverModes.has(nextAgent);

      if (!looksLikeResolver) {
        break;
      }

      try {
        const second =
          await resolveRedirect(
            channelId,
            nextUrl,
            nextAgent || "redirect"
          );

        if (!second.url) break;

        second.headers = {
          ...(resolved.headers || {}),
          ...(second.headers || {}),
        };

        second.swap = {
          ...(resolved.swap || {}),
          ...(second.swap || {}),
        };

        resolved = second;

      } catch {
        break;
      }
    }

  } else {
    const meta =
      safeJSON(source) || {};

    resolved = {
      url:
        meta.url ||
        selected.direct_url ||
        source,

      agent:
        meta.agent || "",

      headers:
        meta.headers ||
        selected.headers ||
        {},

      acceptSSL:
        meta.acceptSSL ??
        selected.acceptSSL,

      mediatype:
        meta.mediatype ||
        selected.mediatype,

      swap:
        meta.swap ||
        selected.swap ||
        {},
    };
  }

  if (!resolved.url) {
    throw new Error(
      "تعذر استخراج رابط البث النهائي"
    );
  }

  const headers = {
    ...(selected.headers || {}),
    ...(resolved.headers || {}),
  };

  const swap = {
    ...(selected.swap || {}),
    ...(resolved.swap || {}),
  };

  const result = {
    channel_id: channelId,

    name:
      live.name ||
      channelId,

    image:
      live.img_url || "",

    server_index:
      serverIndex,

    server_label:
      selected.label ||
      `سيرفر ${serverIndex + 1}`,

    server_type:
      resolverAgent,

    resolved_url:
      String(resolved.url),

    headers,

    agent:
      resolved.agent || "",

    acceptSSL:
      resolved.acceptSSL ??
      selected.acceptSSL,

    mediatype:
      String(
        resolved.mediatype ||
        selected.mediatype ||
        ""
      ).toLowerCase(),

    swap,
  };

  cacheSet(
    resolveCache,
    cacheKey,
    result
  );

  return result;
}


// ============================================================
// UPSTREAM HEADERS
// ============================================================

function buildUpstreamHeaders(
  info,
  url,
  incomingRequest = null
) {
  const headers = new Headers();

  const sourceHeaders =
    info.headers || {};

  for (
    const [key, value]
    of Object.entries(sourceHeaders)
  ) {
    if (
      value !== undefined &&
      value !== null
    ) {
      try {
        headers.set(
          key,
          String(value)
        );
      } catch {
        // Ignore invalid upstream header.
      }
    }
  }

  if (
    info.agent &&
    !headers.has("User-Agent")
  ) {
    headers.set(
      "User-Agent",
      String(info.agent)
    );
  }

  if (!headers.has("User-Agent")) {
    headers.set(
      "User-Agent",
      CONFIG.DEFAULT_UA
    );
  }

  if (!headers.has("Accept")) {
    headers.set(
      "Accept",
      "*/*"
    );
  }

  // Prevent origin compression from complicating raw streaming.
  headers.set(
    "Accept-Encoding",
    "identity"
  );

  if (
    !headers.has("Referer") &&
    isHttpUrl(url)
  ) {
    try {
      const u = new URL(url);

      headers.set(
        "Referer",
        `${u.protocol}//${u.host}/`
      );
    } catch {
      // Ignore.
    }
  }

  if (
    incomingRequest &&
    incomingRequest.headers.has("Range")
  ) {
    headers.set(
      "Range",
      incomingRequest.headers.get("Range")
    );
  }

  return headers;
}


// ============================================================
// SWAP
// ============================================================

function applySwap(value, swaps) {
  let output =
    String(value || "");

  if (
    !swaps ||
    typeof swaps !== "object"
  ) {
    return output;
  }

  for (
    const [oldValue, newValue]
    of Object.entries(swaps)
  ) {
    if (!oldValue) continue;

    output =
      output.split(oldValue).join(
        String(newValue || "")
      );
  }

  return output;
}


// ============================================================
// RESOURCE URL
// ============================================================

function makeResourcePath(
  workerOrigin,
  channelId,
  serverIndex,
  absoluteUrl
) {
  const token =
    encodeBase64Url(absoluteUrl);

  return (
    `${workerOrigin}/r/` +
    `${encodeURIComponent(channelId)}/` +
    `${serverIndex}/` +
    token
  );
}


// ============================================================
// HLS REWRITER
// ============================================================

function makeAbsoluteUrl(baseUrl, value) {
  try {
    return new URL(
      value,
      baseUrl
    ).toString();
  } catch {
    return value;
  }
}

function rewriteUriAttributes(
  line,
  manifestUrl,
  workerOrigin,
  channelId,
  serverIndex,
  swap
) {
  return line.replace(
    /URI=(["'])(.*?)\1/gi,

    (
      full,
      quote,
      value
    ) => {
      const swapped =
        applySwap(
          value,
          swap
        );

      const absolute =
        makeAbsoluteUrl(
          manifestUrl,
          swapped
        );

      const proxy =
        makeResourcePath(
          workerOrigin,
          channelId,
          serverIndex,
          absolute
        );

      return `URI="${proxy}"`;
    }
  );
}

function rewriteHls(
  playlist,
  manifestUrl,
  workerOrigin,
  channelId,
  serverIndex,
  swap
) {
  const lines =
    String(playlist)
      .replace(/\r/g, "")
      .split("\n");

  const output = [];

  for (const original of lines) {
    const trimmed =
      original.trim();

    if (!trimmed) {
      output.push("");
      continue;
    }

    if (
      trimmed.startsWith("#")
    ) {
      output.push(
        rewriteUriAttributes(
          original,
          manifestUrl,
          workerOrigin,
          channelId,
          serverIndex,
          swap
        )
      );

      continue;
    }

    const swapped =
      applySwap(
        trimmed,
        swap
      );

    const absolute =
      makeAbsoluteUrl(
        manifestUrl,
        swapped
      );

    output.push(
      makeResourcePath(
        workerOrigin,
        channelId,
        serverIndex,
        absolute
      )
    );
  }

  return output.join("\n");
}


// ============================================================
// HLS DETECTION
// ============================================================

function looksLikeHls(
  text,
  contentType = "",
  url = ""
) {
  const sample =
    String(text || "")
      .trimStart()
      .slice(0, 1000);

  const ct =
    String(contentType || "")
      .toLowerCase();

  const path =
    String(url || "")
      .toLowerCase();

  return (
    sample.startsWith("#EXTM3U") ||
    ct.includes("mpegurl") ||
    path.includes(".m3u8")
  );
}


// ============================================================
// MEDIA FETCH
// ============================================================

async function fetchManifest(
  info,
  url
) {
  const headers =
    buildUpstreamHeaders(
      info,
      url
    );

  const response =
    await fetchTimeout(
      url,
      {
        method: "GET",

        headers,

        redirect: "follow",

        // Live playlist must never become stale.
        cf: {
          cacheTtl: 0,
          cacheEverything: false,
        },
      },

      CONFIG.MANIFEST_TIMEOUT
    );

  return response;
}


// ============================================================
// FIND HTML EMBEDDED M3U8
// ============================================================

function findMediaUrlInHtml(
  html,
  baseUrl
) {
  const patterns = [
    /(?:file|src|source|url)\s*[:=]\s*["']([^"']+)["']/gi,

    /["'](https?:\/\/[^"']+\.(?:m3u8|mpd)(?:\?[^"']*)?)["']/gi,
  ];

  for (const regex of patterns) {
    let match;

    while (
      (match = regex.exec(html))
    ) {
      let found =
        String(match[1] || "")
          .replace(/\\\//g, "/");

      if (
        !found.toLowerCase()
          .includes(".m3u8")
      ) {
        continue;
      }

      try {
        return new URL(
          found,
          baseUrl
        ).toString();
      } catch {
        return found;
      }
    }
  }

  return null;
}


// ============================================================
// RESOLVE + GET PLAYLIST
// ============================================================

async function getResolvedPlaylist(
  channelId,
  serverIndex,
  force = false
) {
  let info =
    await resolveChannel(
      channelId,
      serverIndex,
      force
    );

  let response =
    await fetchManifest(
      info,
      info.resolved_url
    );

  // --------------------------------------------------------
  // Expired token or transient resolver problem:
  // force one full resolve and retry.
  // --------------------------------------------------------

  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 410 ||
    response.status >= 500
  ) {
    info =
      await resolveChannel(
        channelId,
        serverIndex,
        true
      );

    response =
      await fetchManifest(
        info,
        info.resolved_url
      );
  }

  if (!response.ok) {
    throw new Error(
      `Upstream HTTP ${response.status}`
    );
  }

  let text =
    await response.text();

  let finalUrl =
    response.url;

  let contentType =
    response.headers.get(
      "Content-Type"
    ) || "";

  // HTML resolver/player page.
  if (
    contentType
      .toLowerCase()
      .includes("text/html") ||
    /<html|<!doctype/i.test(
      text.slice(0, 3000)
    )
  ) {
    const embedded =
      findMediaUrlInHtml(
        text,
        finalUrl
      );

    if (embedded) {
      const second =
        await fetchManifest(
          info,
          embedded
        );

      if (second.ok) {
        text =
          await second.text();

        finalUrl =
          second.url;

        contentType =
          second.headers.get(
            "Content-Type"
          ) || "";
      }
    }
  }

  if (
    !looksLikeHls(
      text,
      contentType,
      finalUrl
    )
  ) {
    throw new Error(
      "السيرفر لم يرجع HLS صالح"
    );
  }

  return {
    info,
    response,
    text,
    finalUrl,
  };
}


// ============================================================
// API: TOPICS
// ============================================================

async function routeTopics(url) {
  const force =
    url.searchParams.get("force") === "1";

  const items =
    await getTopics(force);

  return jsonResponse({
    ok: true,

    count: items.length,

    items,
  });
}


// ============================================================
// API: CHANNELS
// ============================================================

async function routeChannels(topic, url) {
  const force =
    url.searchParams.get("force") === "1";

  const items =
    await getChannels(
      topic,
      force
    );

  return jsonResponse({
    ok: true,

    topic,

    count: items.length,

    items,
  });
}


// ============================================================
// API: SERVERS
// ============================================================

async function routeServers(channelId) {
  const {
    live,
    options,
  } =
    await getStreamOptions(
      channelId
    );

  const servers =
    options.map(
      (server, index) => ({
        index,

        label:
          server.label ||
          `سيرفر ${index + 1}`,

        description:
          server.description || "",

        type:
          server.agent ||
          "redirect",

        media_type:
          String(
            server.mediatype || ""
          ).toLowerCase(),

        hls:
          `/live/${encodeURIComponent(channelId)}.m3u8?server=${index}`,

        watch:
          `/watch/${encodeURIComponent(channelId)}?server=${index}`,
      })
    );

  return jsonResponse({
    ok: true,

    channel_id:
      channelId,

    name:
      live.name ||
      channelId,

    image:
      live.img_url || "",

    count:
      servers.length,

    servers,
  });
}


// ============================================================
// API: RESOLVE DEBUG
// ============================================================

async function routeResolve(
  channelId,
  url
) {
  const server =
    Number.parseInt(
      url.searchParams.get("server") || "0",
      10
    ) || 0;

  const force =
    url.searchParams.get("force") === "1";

  const info =
    await resolveChannel(
      channelId,
      server,
      force
    );

  // Do not expose final upstream URL.
  return jsonResponse({
    ok: true,

    channel_id:
      channelId,

    server_index:
      server,

    server_label:
      info.server_label,

    server_type:
      info.server_type,

    media_type:
      info.mediatype,

    ready: true,

    play_url:
      `/live/${encodeURIComponent(channelId)}.m3u8?server=${server}`,
  });
}


// ============================================================
// LIVE PLAYLIST
// ============================================================

async function routeLive(
  request,
  url,
  channelId
) {
  const workerOrigin =
    url.origin;

  let serverIndex =
    Number.parseInt(
      url.searchParams.get("server") || "0",
      10
    );

  if (
    Number.isNaN(serverIndex) ||
    serverIndex < 0
  ) {
    serverIndex = 0;
  }

  const force =
    url.searchParams.get("force") === "1";

  let playlist;

  try {
    playlist =
      await getResolvedPlaylist(
        channelId,
        serverIndex,
        force
      );

  } catch (firstError) {
    // --------------------------------------------------------
    // Manifest-level failover.
    // We only switch servers when selected source is actually
    // unavailable. We do NOT randomly alternate live families.
    // --------------------------------------------------------

    const {
      options,
    } =
      await getStreamOptions(
        channelId
      );

    let lastError =
      firstError;

    let success =
      null;

    for (
      let i = 0;
      i < options.length;
      i++
    ) {
      if (i === serverIndex) {
        continue;
      }

      try {
        success =
          await getResolvedPlaylist(
            channelId,
            i,
            true
          );

        serverIndex = i;
        break;

      } catch (error) {
        lastError =
          error;
      }
    }

    if (!success) {
      throw lastError;
    }

    playlist =
      success;
  }

  const rewritten =
    rewriteHls(
      playlist.text,
      playlist.finalUrl,
      workerOrigin,
      channelId,
      serverIndex,
      playlist.info.swap || {}
    );

  return new Response(
    rewritten,
    {
      status: 200,

      headers: {
        "Content-Type":
          "application/vnd.apple.mpegurl; charset=utf-8",

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Headers":
          "*",

        "Access-Control-Expose-Headers":
          "X-Drama-Server",

        // Absolutely no browser/edge stale playlist.
        "Cache-Control":
          "no-store, no-cache, must-revalidate, max-age=0",

        Pragma:
          "no-cache",

        Expires:
          "0",

        "X-Drama-Server":
          String(serverIndex),
      },
    }
  );
}


// ============================================================
// RESOURCE PROXY
// ============================================================

async function routeResource(
  request,
  channelId,
  serverIndex,
  token
) {
  let targetUrl;

  try {
    targetUrl =
      decodeBase64Url(token);
  } catch {
    throw new Error(
      "Invalid resource token"
    );
  }

  if (!isHttpUrl(targetUrl)) {
    throw new Error(
      "Invalid upstream URL"
    );
  }

  let info =
    await resolveChannel(
      channelId,
      serverIndex,
      false
    );

  const headers =
    buildUpstreamHeaders(
      info,
      targetUrl,
      request
    );

  let upstream =
    await fetchTimeout(
      targetUrl,
      {
        method:
          request.method === "HEAD"
            ? "HEAD"
            : "GET",

        headers,

        redirect: "follow",

        // Segments are allowed tiny edge caching.
        // The playlist itself never uses this route unless nested.
        cf: {
          cacheTtl: 2,
          cacheEverything: true,

          cacheTtlByStatus: {
            "200-299": 2,
            "404": 0,
            "500-599": 0,
          },
        },
      },

      CONFIG.RESOURCE_TIMEOUT
    );

  // --------------------------------------------------------
  // If token/server authorization changed, refresh resolver
  // once. We cannot regenerate an already expired segment,
  // but this fixes origins where headers themselves changed.
  // --------------------------------------------------------

  if (
    upstream.status === 401 ||
    upstream.status === 403
  ) {
    try {
      info =
        await resolveChannel(
          channelId,
          serverIndex,
          true
        );

      const retryHeaders =
        buildUpstreamHeaders(
          info,
          targetUrl,
          request
        );

      upstream =
        await fetchTimeout(
          targetUrl,
          {
            method:
              request.method === "HEAD"
                ? "HEAD"
                : "GET",

            headers:
              retryHeaders,

            redirect:
              "follow",

            cf: {
              cacheTtl: 0,
            },
          },

          CONFIG.RESOURCE_TIMEOUT
        );

    } catch {
      // Continue with original response.
    }
  }

  if (!upstream.ok) {
    return new Response(
      `Upstream HTTP ${upstream.status}`,
      {
        status:
          upstream.status >= 400 &&
          upstream.status <= 599
            ? upstream.status
            : 502,

        headers: {
          "Content-Type":
            "text/plain",

          "Access-Control-Allow-Origin":
            "*",

          "Cache-Control":
            "no-store",
        },
      }
    );
  }

  const contentType =
    upstream.headers.get(
      "Content-Type"
    ) || "";

  // --------------------------------------------------------
  // Nested HLS playlist
  // --------------------------------------------------------

  const finalPath =
    (() => {
      try {
        return new URL(
          upstream.url
        ).pathname.toLowerCase();
      } catch {
        return "";
      }
    })();

  if (
    contentType
      .toLowerCase()
      .includes("mpegurl") ||
    finalPath.endsWith(".m3u8") ||
    finalPath.endsWith(".m3u")
  ) {
    const body =
      await upstream.text();

    if (
      body
        .trimStart()
        .startsWith("#EXTM3U")
    ) {
      const origin =
        new URL(request.url).origin;

      const rewritten =
        rewriteHls(
          body,
          upstream.url,
          origin,
          channelId,
          serverIndex,
          info.swap || {}
        );

      return new Response(
        rewritten,
        {
          headers: {
            "Content-Type":
              "application/vnd.apple.mpegurl; charset=utf-8",

            "Access-Control-Allow-Origin":
              "*",

            "Cache-Control":
              "no-store, no-cache, must-revalidate",
          },
        }
      );
    }
  }

  // --------------------------------------------------------
  // Raw streamed segment/key/init file
  // --------------------------------------------------------

  const responseHeaders =
    new Headers();

  const passHeaders = [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
  ];

  for (
    const header
    of passHeaders
  ) {
    const value =
      upstream.headers.get(
        header
      );

    if (value) {
      responseHeaders.set(
        header,
        value
      );
    }
  }

  // Some providers deliberately disguise TS as .js/.pdf.
  if (
    finalPath.endsWith(".ts") ||
    finalPath.endsWith(".js") ||
    finalPath.endsWith(".pdf")
  ) {
    const current =
      responseHeaders.get(
        "Content-Type"
      );

    if (
      !current ||
      current.includes("javascript") ||
      current.includes("pdf") ||
      current.includes("text/")
    ) {
      responseHeaders.set(
        "Content-Type",
        "video/mp2t"
      );
    }
  }

  if (
    finalPath.endsWith(".m4s")
  ) {
    responseHeaders.set(
      "Content-Type",
      "video/iso.segment"
    );
  }

  if (
    finalPath.endsWith(".mp4") &&
    !responseHeaders.has(
      "Content-Type"
    )
  ) {
    responseHeaders.set(
      "Content-Type",
      "video/mp4"
    );
  }

  responseHeaders.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  responseHeaders.set(
    "Access-Control-Allow-Headers",
    "*"
  );

  responseHeaders.set(
    "Access-Control-Expose-Headers",
    "Content-Length,Content-Range,Accept-Ranges"
  );

  responseHeaders.set(
    "Cache-Control",
    "public, max-age=1"
  );

  return new Response(
    upstream.body,
    {
      status:
        upstream.status,

      headers:
        responseHeaders,
    }
  );
}


// ============================================================
// BROWSER PLAYER
// ============================================================

function playerPage(
  channelId,
  server
) {
  const id =
    JSON.stringify(
      String(channelId)
    );

  const srv =
    Number(server) || 0;

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1,viewport-fit=cover"
/>

<meta
  name="theme-color"
  content="#000000"
/>

<title>Drama Live</title>

<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>

<style>
*{
 box-sizing:border-box;
}

html,
body{
 margin:0;
 width:100%;
 height:100%;
 background:#000;
 color:#fff;
 font-family:
 -apple-system,
 BlinkMacSystemFont,
 "SF Pro Display",
 "Segoe UI",
 sans-serif;
}

body{
 overflow:hidden;
}

#wrap{
 position:fixed;
 inset:0;
 background:#000;
 display:flex;
 align-items:center;
 justify-content:center;
}

video{
 width:100%;
 height:100%;
 background:#000;
 object-fit:contain;
}

.top{
 position:absolute;
 z-index:5;
 top:0;
 left:0;
 right:0;
 padding:
 max(16px,env(safe-area-inset-top))
 16px
 40px;
 background:
 linear-gradient(
   rgba(0,0,0,.8),
   transparent
 );
 pointer-events:none;
}

.title{
 font-weight:800;
 font-size:18px;
}

.status{
 margin-top:5px;
 color:#bbb;
 font-size:12px;
}

.live{
 color:#ff334f;
 font-weight:800;
}

.center{
 position:absolute;
 z-index:6;
 left:50%;
 top:50%;
 transform:
 translate(-50%,-50%);
 text-align:center;
 display:none;
 background:
 rgba(15,15,15,.92);
 border:
 1px solid #333;
 padding:18px;
 border-radius:18px;
 width:min(90%,350px);
}

button{
 background:#fff;
 color:#000;
 border:0;
 border-radius:100px;
 padding:11px 18px;
 font-weight:800;
 margin-top:12px;
}

.spinner{
 width:40px;
 height:40px;
 border:
 3px solid rgba(255,255,255,.18);
 border-top-color:#fff;
 border-radius:50%;
 animation:
 spin .75s linear infinite;
 position:absolute;
 z-index:4;
}

@keyframes spin{
 to{
   transform:rotate(360deg);
 }
}
</style>
</head>

<body>

<div id="wrap">

<video
 id="video"
 controls
 autoplay
 playsinline
 webkit-playsinline
></video>

<div class="top">

<div class="title">
Drama Live
</div>

<div class="status">

<span class="live">
● LIVE
</span>

&nbsp;

<span id="status">
جاري الاتصال...
</span>

</div>

</div>

<div
 id="spinner"
 class="spinner"
></div>

<div
 id="error"
 class="center"
>

<div id="errorText">
تعذر تشغيل البث
</div>

<button onclick="start(true)">
إعادة المحاولة
</button>

</div>

</div>

<script>
const CHANNEL=${id};
const SERVER=${srv};

const video=
 document.getElementById("video");

const statusText=
 document.getElementById("status");

const spinner=
 document.getElementById("spinner");

const errorBox=
 document.getElementById("error");

const errorText=
 document.getElementById("errorText");

let hls=null;

function source(force=false){
 let u=
   "/live/" +
   encodeURIComponent(CHANNEL) +
   ".m3u8?server=" +
   SERVER;

 if(force){
   u+="&force=1&_="+Date.now();
 }else{
   u+="&_="+Date.now();
 }

 return u;
}

function loading(v){
 spinner.style.display=
   v ? "block" : "none";
}

function destroy(){
 if(hls){
   try{
     hls.destroy();
   }catch(e){}
   hls=null;
 }
}

function showError(text){
 loading(false);

 errorText.textContent=
   text || "تعذر تشغيل البث";

 errorBox.style.display=
   "block";
}

function start(force=false){
 destroy();

 errorBox.style.display=
   "none";

 loading(true);

 statusText.textContent=
   "جاري الاتصال...";

 const src=source(force);

 if(
   window.Hls &&
   Hls.isSupported()
 ){
   hls=new Hls({
     enableWorker:true,

     lowLatencyMode:true,

     backBufferLength:30,

     liveSyncDurationCount:3,

     liveMaxLatencyDurationCount:8,

     maxBufferLength:20,

     maxMaxBufferLength:40,

     manifestLoadingTimeOut:12000,

     levelLoadingTimeOut:12000,

     fragLoadingTimeOut:18000,

     manifestLoadingMaxRetry:4,

     levelLoadingMaxRetry:6,

     fragLoadingMaxRetry:6,

     fragLoadingRetryDelay:500,

     levelLoadingRetryDelay:500
   });

   hls.attachMedia(video);

   hls.on(
     Hls.Events.MEDIA_ATTACHED,
     ()=>{
       hls.loadSource(src);
     }
   );

   hls.on(
     Hls.Events.MANIFEST_PARSED,
     ()=>{
       loading(false);

       statusText.textContent=
         "متصل";

       video.play().catch(()=>{});
     }
   );

   hls.on(
     Hls.Events.ERROR,
     (event,data)=>{
       console.log(
         "HLS",
         data
       );

       if(!data.fatal){
         return;
       }

       if(
         data.type ===
         Hls.ErrorTypes.MEDIA_ERROR
       ){
         try{
           hls.recoverMediaError();
           return;
         }catch(e){}
       }

       if(
         data.type ===
         Hls.ErrorTypes.NETWORK_ERROR
       ){
         try{
           hls.startLoad();
           return;
         }catch(e){}
       }

       showError(
         data.details ||
         "خطأ في البث"
       );
     }
   );

 }else if(
   video.canPlayType(
     "application/vnd.apple.mpegurl"
   )
 ){
   video.src=src;

   video.addEventListener(
     "loadedmetadata",
     ()=>{
       loading(false);

       statusText.textContent=
         "متصل";

       video.play().catch(()=>{});
     },
     {
       once:true
     }
   );

 }else{
   showError(
     "هذا المتصفح لا يدعم HLS"
   );
 }
}

video.addEventListener(
 "playing",
 ()=>{
   loading(false);
   statusText.textContent="متصل";
 }
);

video.addEventListener(
 "waiting",
 ()=>{
   loading(true);
   statusText.textContent="جاري التحميل...";
 }
);

start(false);
</script>

</body>
</html>`;
}


// ============================================================
// API HOME PAGE
// ============================================================

function homePage(origin) {
  return `<!doctype html>
<html lang="ar" dir="rtl">

<head>

<meta charset="UTF-8">

<meta
 name="viewport"
 content="width=device-width,initial-scale=1"
/>

<title>Drama Live API</title>

<style>
:root{
 color-scheme:dark;
}

*{
 box-sizing:border-box;
}

body{
 margin:0;
 background:#0b0b0c;
 color:#fff;
 font-family:
 -apple-system,
 BlinkMacSystemFont,
 "SF Pro Display",
 "Segoe UI",
 sans-serif;
}

main{
 width:min(900px,calc(100% - 28px));
 margin:auto;
 padding:50px 0 100px;
}

.logo{
 display:flex;
 align-items:center;
 gap:12px;
 margin-bottom:30px;
}

.icon{
 width:48px;
 height:36px;
 border-radius:11px;
 background:#ff0033;
 display:grid;
 place-items:center;
 font-size:20px;
}

h1{
 margin:0;
 font-size:27px;
}

.sub{
 color:#aaa;
 margin-top:5px;
}

.card{
 margin-top:16px;
 border:1px solid #252527;
 background:#141416;
 border-radius:18px;
 padding:18px;
}

.badge{
 display:inline-block;
 color:#8fffa8;
 background:#0d2b16;
 border:1px solid #185928;
 border-radius:100px;
 padding:5px 10px;
 font-size:12px;
 margin-bottom:13px;
}

code{
 direction:ltr;
 display:block;
 background:#09090a;
 border:1px solid #262629;
 border-radius:10px;
 padding:12px;
 overflow:auto;
 color:#d9d9de;
 margin-top:8px;
}

a{
 color:#fff;
}
</style>

</head>

<body>

<main>

<div class="logo">

<div class="icon">
▶
</div>

<div>

<h1>
Drama Live Gateway
</h1>

<div class="sub">
Cloudflare Streaming API
</div>

</div>

</div>

<div class="card">

<div class="badge">
● API ONLINE
</div>

<div>
التصنيفات
</div>

<code>
GET ${origin}/api/topics
</code>

</div>

<div class="card">

<div>
قنوات التصنيف
</div>

<code>
GET ${origin}/api/channels/{topic}
</code>

</div>

<div class="card">

<div>
سيرفرات القناة
</div>

<code>
GET ${origin}/api/servers/{channel_id}
</code>

</div>

<div class="card">

<div>
رابط HLS مباشر
</div>

<code>
${origin}/live/{channel_id}.m3u8
</code>

<code>
${origin}/live/{channel_id}.m3u8?server=1
</code>

</div>

<div class="card">

<div>
مشغل المتصفح
</div>

<code>
${origin}/watch/{channel_id}
</code>

<code>
${origin}/watch/{channel_id}?server=1
</code>

</div>

</main>

</body>
</html>`;
}


// ============================================================
// ROUTER
// ============================================================

export default {

  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      if (
        request.method === "OPTIONS"
      ) {
        return new Response(
          null,
          {
            status: 204,

            headers: {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Headers":
                "*",

              "Access-Control-Allow-Methods":
                "GET,HEAD,POST,OPTIONS",

              "Access-Control-Max-Age":
                "86400",
            },
          }
        );
      }

      const url =
        new URL(request.url);

      const path =
        url.pathname;

      // ------------------------------------------------------
      // HOME
      // ------------------------------------------------------

      if (
        path === "/" ||
        path === ""
      ) {
        return new Response(
          homePage(url.origin),
          {
            headers: {
              "Content-Type":
                "text/html; charset=utf-8",

              "Cache-Control":
                "no-store",
            },
          }
        );
      }

      // ------------------------------------------------------
      // HEALTH
      // ------------------------------------------------------

      if (
        path === "/health"
      ) {
        return jsonResponse({
          ok: true,

          service:
            "Drama Live Gateway",

          time:
            new Date().toISOString(),
        });
      }

      // ------------------------------------------------------
      // TOPICS
      // ------------------------------------------------------

      if (
        path === "/api/topics"
      ) {
        return await routeTopics(
          url
        );
      }

      // ------------------------------------------------------
      // CHANNELS
      // ------------------------------------------------------

      let match =
        path.match(
          /^\/api\/channels\/(.+)$/
        );

      if (match) {
        const topic =
          decodeURIComponent(
            match[1]
          );

        return await routeChannels(
          topic,
          url
        );
      }

      // ------------------------------------------------------
      // SERVERS
      // ------------------------------------------------------

      match =
        path.match(
          /^\/api\/servers\/([^/]+)$/
        );

      if (match) {
        const channelId =
          decodeURIComponent(
            match[1]
          );

        return await routeServers(
          channelId
        );
      }

      // ------------------------------------------------------
      // RESOLVE
      // ------------------------------------------------------

      match =
        path.match(
          /^\/api\/resolve\/([^/]+)$/
        );

      if (match) {
        const channelId =
          decodeURIComponent(
            match[1]
          );

        return await routeResolve(
          channelId,
          url
        );
      }

      // ------------------------------------------------------
      // WATCH
      // ------------------------------------------------------

      match =
        path.match(
          /^\/watch\/([^/]+)$/
        );

      if (match) {
        const channelId =
          decodeURIComponent(
            match[1]
          );

        const server =
          url.searchParams.get(
            "server"
          ) || "0";

        return new Response(
          playerPage(
            channelId,
            server
          ),
          {
            headers: {
              "Content-Type":
                "text/html; charset=utf-8",

              "Cache-Control":
                "no-store",
            },
          }
        );
      }

      // ------------------------------------------------------
      // LIVE
      // ------------------------------------------------------

      match =
        path.match(
          /^\/live\/(.+?)\.m3u8$/
        );

      if (match) {
        const channelId =
          decodeURIComponent(
            match[1]
          );

        return await routeLive(
          request,
          url,
          channelId
        );
      }

      // ------------------------------------------------------
      // RESOURCE
      // ------------------------------------------------------

      match =
        path.match(
          /^\/r\/([^/]+)\/(\d+)\/([^/]+)$/
        );

      if (match) {
        const channelId =
          decodeURIComponent(
            match[1]
          );

        const serverIndex =
          Number.parseInt(
            match[2],
            10
          );

        const token =
          match[3];

        return await routeResource(
          request,
          channelId,
          serverIndex,
          token
        );
      }

      return jsonResponse(
        {
          ok: false,
          error:
            "Route not found",
        },
        404
      );

    } catch (error) {
      console.error(
        "WORKER ERROR",
        error
      );

      return errorResponse(
        error,
        502
      );
    }
  },
};
