const CONFIG = {
  API_BASE: "https://def.ycnapi.com/api",
  STATIC_KEY: "c!xZj+N9&G@Ev@vw",

  API_HEADERS: {
    "User-Agent": "okhttp/4.12.0",
    "Accept": "application/json",
  },

  DEFAULT_CATEGORY_ID: 4,

  INDEX_CACHE_SECONDS: 300,
  STREAM_CACHE_SECONDS: 20,

  PLAYER_UA:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",

  DEFAULT_REFERER: "https://x.com/",

  CORS_ORIGIN: "*",
};

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return corsResponse(new Response(null, { status: 204 }));
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/+|\/+$/g, "");

      if (!path) {
        return corsResponse(
          jsonResponse({
            ok: true,
            service: "YCN Streaming Gateway",
            examples: [
              "/1",
              "/2",
              "/c/4",
              "/category/4",
              "/categories",
            ],
          })
        );
      }

      if (path === "categories") {
        return corsResponse(await handleCategories());
      }

      if (path.startsWith("category/")) {
        const id = path.split("/")[1];

        if (!id) {
          return corsResponse(errorResponse("Missing category id", 400));
        }

        return corsResponse(await handleCategory(id));
      }

      if (path.startsWith("c/")) {
        const channelId = path.split("/")[1];

        if (!channelId) {
          return corsResponse(errorResponse("Missing channel id", 400));
        }

        return await openChannelById(request, channelId);
      }

      if (path.startsWith("_manifest")) {
        return await proxyManifest(request);
      }

      if (path.startsWith("_resource")) {
        return await proxyResource(request);
      }

      if (/^\d+$/.test(path)) {
        const channelNumber = Number(path);

        if (channelNumber < 1) {
          return corsResponse(errorResponse("Invalid channel number", 400));
        }

        const channels = await getCategoryChannels(
          CONFIG.DEFAULT_CATEGORY_ID
        );

        if (channelNumber > channels.length) {
          return corsResponse(
            errorResponse(
              `Channel ${channelNumber} does not exist. Available: ${channels.length}`,
              404
            )
          );
        }

        const channel = channels[channelNumber - 1];

        return await openChannelById(request, channel.id);
      }

      return corsResponse(errorResponse("Route not found", 404));
    } catch (error) {
      return corsResponse(
        errorResponse(error?.message || String(error), 500)
      );
    }
  },
};


// ============================================================================
// API
// ============================================================================

async function apiFetch(endpoint) {
  const url = `${CONFIG.API_BASE}/${endpoint.replace(/^\/+/, "")}`;

  const response = await fetch(url, {
    method: "GET",
    headers: CONFIG.API_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`API HTTP ${response.status}`);
  }

  const t = response.headers.get("t") || "";

  if (!t) {
    throw new Error("Missing API header: t");
  }

  const encrypted = (await response.text()).trim();

  return decryptApiPayload(encrypted, t);
}


function decryptApiPayload(base64Data, t) {
  const binary = Uint8Array.from(
    atob(base64Data),
    c => c.charCodeAt(0)
  );

  const secretString = CONFIG.STATIC_KEY + t;
  const secret = new TextEncoder().encode(secretString);

  const output = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    output[i] = binary[i] ^ secret[i % secret.length];
  }

  const text = new TextDecoder("utf-8").decode(output);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Unable to parse decrypted API response");
  }
}


// ============================================================================
// CATEGORIES + CHANNEL INDEX
// ============================================================================

async function getCategories() {
  const cache = caches.default;

  const cacheRequest = new Request(
    "https://internal.local/categories-index"
  );

  let cached = await cache.match(cacheRequest);

  if (cached) {
    return await cached.json();
  }

  const payload = await apiFetch("categories");
  const data = normalizeData(payload);

  if (!Array.isArray(data)) {
    throw new Error("Invalid categories response");
  }

  const response = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CONFIG.INDEX_CACHE_SECONDS}`,
    },
  });

  await cache.put(cacheRequest, response.clone());

  return data;
}


async function getCategoryChannels(categoryId) {
  const cache = caches.default;

  const cacheRequest = new Request(
    `https://internal.local/category/${categoryId}`
  );

  let cached = await cache.match(cacheRequest);

  if (cached) {
    return await cached.json();
  }

  const payload = await apiFetch(
    `categories/${encodeURIComponent(categoryId)}/channels`
  );

  const data = normalizeData(payload);

  if (!Array.isArray(data)) {
    throw new Error("Invalid channels response");
  }

  const response = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CONFIG.INDEX_CACHE_SECONDS}`,
    },
  });

  await cache.put(cacheRequest, response.clone());

  return data;
}


// ============================================================================
// CHANNEL INFO
// ============================================================================

async function getChannelStream(channelId) {
  const payload = await apiFetch(
    `channel/${encodeURIComponent(channelId)}`
  );

  let data = normalizeData(payload);

  if (Array.isArray(data)) {
    if (!data.length) {
      throw new Error("Empty channel response");
    }

    data = data[0];
  }

  if (!data || typeof data !== "object") {
    throw new Error("Invalid channel stream response");
  }

  const streamUrl =
    data.url ||
    data.stream_url ||
    data.link;

  if (!streamUrl) {
    throw new Error("Channel has no stream URL");
  }

  return {
    ...data,

    url: streamUrl,

    referer:
      data.referer ||
      data.headers?.Referer ||
      data.headers?.referer ||
      CONFIG.DEFAULT_REFERER,

    userAgent:
      data.user_agent ||
      data.headers?.["User-Agent"] ||
      data.headers?.["user-agent"] ||
      CONFIG.PLAYER_UA,
  };
}


// ============================================================================
// OPEN CHANNEL
// ============================================================================

async function openChannelById(request, channelId) {
  const stream = await getChannelStream(channelId);

  const url = new URL(request.url);

  const gatewayUrl =
    `${url.origin}/_manifest?` +
    new URLSearchParams({
      u: stream.url,
      r: stream.referer || "",
      a: stream.userAgent || "",
    }).toString();

  return Response.redirect(gatewayUrl, 302);
}


// ============================================================================
// HLS MANIFEST PROXY
// ============================================================================

async function proxyManifest(request) {
  const currentUrl = new URL(request.url);

  const upstreamUrl = currentUrl.searchParams.get("u");
  const referer =
    currentUrl.searchParams.get("r") ||
    CONFIG.DEFAULT_REFERER;

  const userAgent =
    currentUrl.searchParams.get("a") ||
    CONFIG.PLAYER_UA;

  if (!upstreamUrl) {
    return corsResponse(errorResponse("Missing upstream URL", 400));
  }

  assertHttpUrl(upstreamUrl);

  const upstream = await fetch(upstreamUrl, {
    headers: buildUpstreamHeaders(
      request,
      referer,
      userAgent
    ),
    redirect: "follow",
  });

  if (!upstream.ok) {
    return corsResponse(
      errorResponse(
        `Manifest upstream returned ${upstream.status}`,
        upstream.status
      )
    );
  }

  const text = await upstream.text();

  if (!text.includes("#EXTM3U")) {
    return corsResponse(
      errorResponse("Upstream response is not an HLS manifest", 502)
    );
  }

  const finalBaseUrl = upstream.url || upstreamUrl;

  const rewritten = rewriteHlsManifest(
    text,
    finalBaseUrl,
    currentUrl.origin,
    referer,
    userAgent
  );

  return corsResponse(
    new Response(rewritten, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.apple.mpegurl; charset=utf-8",

        "Cache-Control":
          `public, max-age=${CONFIG.STREAM_CACHE_SECONDS}`,
      },
    })
  );
}


// ============================================================================
// HLS RESOURCE PROXY
// ============================================================================

async function proxyResource(request) {
  const url = new URL(request.url);

  const upstreamUrl = url.searchParams.get("u");
  const referer =
    url.searchParams.get("r") ||
    CONFIG.DEFAULT_REFERER;

  const userAgent =
    url.searchParams.get("a") ||
    CONFIG.PLAYER_UA;

  if (!upstreamUrl) {
    return corsResponse(errorResponse("Missing resource URL", 400));
  }

  assertHttpUrl(upstreamUrl);

  const upstream = await fetch(upstreamUrl, {
    headers: buildUpstreamHeaders(
      request,
      referer,
      userAgent
    ),
    redirect: "follow",
  });

  if (!upstream.ok) {
    return corsResponse(
      new Response(
        `Upstream error: ${upstream.status}`,
        {
          status: upstream.status,
        }
      )
    );
  }

  const contentType =
    upstream.headers.get("Content-Type") || "";

  const upstreamFinalUrl =
    upstream.url || upstreamUrl;

  // Nested HLS manifest
  if (
    contentType.includes("mpegurl") ||
    upstreamFinalUrl.toLowerCase().includes(".m3u8")
  ) {
    const text = await upstream.text();

    const rewritten = rewriteHlsManifest(
      text,
      upstreamFinalUrl,
      url.origin,
      referer,
      userAgent
    );

    return corsResponse(
      new Response(rewritten, {
        headers: {
          "Content-Type":
            "application/vnd.apple.mpegurl; charset=utf-8",
          "Cache-Control":
            `public, max-age=${CONFIG.STREAM_CACHE_SECONDS}`,
        },
      })
    );
  }

  const headers = new Headers();

  copyHeader(
    upstream.headers,
    headers,
    "Content-Length"
  );

  copyHeader(
    upstream.headers,
    headers,
    "Content-Range"
  );

  copyHeader(
    upstream.headers,
    headers,
    "Accept-Ranges"
  );

  copyHeader(
    upstream.headers,
    headers,
    "ETag"
  );

  copyHeader(
    upstream.headers,
    headers,
    "Last-Modified"
  );

  headers.set(
    "Content-Type",
    determineMediaContentType(
      upstreamFinalUrl,
      contentType
    )
  );

  headers.set(
    "Cache-Control",
    `public, max-age=${CONFIG.STREAM_CACHE_SECONDS}`
  );

  return corsResponse(
    new Response(upstream.body, {
      status: upstream.status,
      headers,
    })
  );
}


// ============================================================================
// MANIFEST REWRITER
// ============================================================================

function rewriteHlsManifest(
  manifest,
  manifestUrl,
  workerOrigin,
  referer,
  userAgent
) {
  const base = new URL(manifestUrl);

  const lines = manifest.split(/\r?\n/);

  return lines.map(line => {
    const trimmed = line.trim();

    if (!trimmed) {
      return line;
    }

    // AES-128 / SAMPLE-AES keys
    if (trimmed.startsWith("#EXT-X-KEY:")) {
      return rewriteUriAttribute(
        line,
        base,
        workerOrigin,
        referer,
        userAgent
      );
    }

    // EXT-X-MAP
    if (trimmed.startsWith("#EXT-X-MAP:")) {
      return rewriteUriAttribute(
        line,
        base,
        workerOrigin,
        referer,
        userAgent
      );
    }

    // EXT-X-MEDIA can contain URI
    if (trimmed.startsWith("#EXT-X-MEDIA:")) {
      return rewriteUriAttribute(
        line,
        base,
        workerOrigin,
        referer,
        userAgent
      );
    }

    // EXT-X-I-FRAME-STREAM-INF
    if (
      trimmed.startsWith(
        "#EXT-X-I-FRAME-STREAM-INF:"
      )
    ) {
      return rewriteUriAttribute(
        line,
        base,
        workerOrigin,
        referer,
        userAgent
      );
    }

    // LL-HLS parts
    if (
      trimmed.startsWith("#EXT-X-PART:") ||
      trimmed.startsWith(
        "#EXT-X-PRELOAD-HINT:"
      )
    ) {
      return rewriteUriAttribute(
        line,
        base,
        workerOrigin,
        referer,
        userAgent
      );
    }

    if (trimmed.startsWith("#")) {
      return line;
    }

    const absolute = new URL(trimmed, base).href;

    return makeResourceUrl(
      workerOrigin,
      absolute,
      referer,
      userAgent
    );
  }).join("\n");
}


function rewriteUriAttribute(
  line,
  base,
  workerOrigin,
  referer,
  userAgent
) {
  return line.replace(
    /URI="([^"]+)"/gi,
    (_, value) => {
      const absolute = new URL(
        value,
        base
      ).href;

      const rewritten = makeResourceUrl(
        workerOrigin,
        absolute,
        referer,
        userAgent
      );

      return `URI="${rewritten}"`;
    }
  );
}


function makeResourceUrl(
  origin,
  upstream,
  referer,
  userAgent
) {
  const qs = new URLSearchParams({
    u: upstream,
    r: referer || "",
    a: userAgent || "",
  });

  return `${origin}/_resource?${qs.toString()}`;
}


// ============================================================================
// REQUEST HEADERS
// ============================================================================

function buildUpstreamHeaders(
  request,
  referer,
  userAgent
) {
  const headers = new Headers();

  headers.set(
    "User-Agent",
    userAgent || CONFIG.PLAYER_UA
  );

  if (referer) {
    headers.set("Referer", referer);
  }

  headers.set("*/*", "*/*");

  const range = request.headers.get("Range");

  if (range) {
    headers.set("Range", range);
  }

  const accept = request.headers.get("Accept");

  if (accept) {
    headers.set("Accept", accept);
  } else {
    headers.set("Accept", "*/*");
  }

  return headers;
}


// ============================================================================
// LIST ROUTES
// ============================================================================

async function handleCategories() {
  const categories = await getCategories();

  return jsonResponse({
    ok: true,
    count: categories.length,
    categories,
  });
}


async function handleCategory(id) {
  const channels = await getCategoryChannels(id);

  return jsonResponse({
    ok: true,
    category_id: id,
    count: channels.length,

    channels: channels.map((channel, index) => ({
      number: index + 1,
      ...channel,
    })),
  });
}


// ============================================================================
// HELPERS
// ============================================================================

function normalizeData(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    Object.prototype.hasOwnProperty.call(
      payload,
      "data"
    )
  ) {
    return payload.data;
  }

  return payload;
}


function determineMediaContentType(
  url,
  upstreamContentType
) {
  const path = new URL(url).pathname.toLowerCase();

  if (path.endsWith(".m3u8")) {
    return "application/vnd.apple.mpegurl";
  }

  if (path.endsWith(".mpd")) {
    return "application/dash+xml";
  }

  if (
    path.endsWith(".ts") ||
    path.endsWith(".pdf") ||
    path.endsWith(".js")
  ) {
    return "video/mp2t";
  }

  if (
    path.endsWith(".m4s") ||
    path.endsWith(".mp4") ||
    path.endsWith(".cmfv")
  ) {
    return "video/mp4";
  }

  if (
    path.endsWith(".aac")
  ) {
    return "audio/aac";
  }

  if (
    upstreamContentType &&
    upstreamContentType !==
      "application/octet-stream"
  ) {
    return upstreamContentType;
  }

  return "application/octet-stream";
}


function copyHeader(
  source,
  target,
  name
) {
  const value = source.get(name);

  if (value) {
    target.set(name, value);
  }
}


function assertHttpUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid upstream URL");
  }

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw new Error("Unsupported upstream protocol");
  }
}


function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
      },
    }
  );
}


function errorResponse(message, status = 500) {
  return jsonResponse(
    {
      ok: false,
      error: message,
    },
    status
  );
}


function corsResponse(response) {
  const headers = new Headers(
    response.headers
  );

  headers.set(
    "Access-Control-Allow-Origin",
    CONFIG.CORS_ORIGIN
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, HEAD, OPTIONS"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Range, Content-Type, Accept"
  );

  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges"
  );

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    }
  );
}
