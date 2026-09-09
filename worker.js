// ============================================================================
// YCN API + HLS CLOUDFLARE WORKER GATEWAY
// Single-file Cloudflare Worker
// ============================================================================

const CONFIG = {
  API_BASE: "https://def.ycnapi.com/api",

  STATIC_KEY: "c!xZj+N9&G@Ev@vw",

  API_HEADERS: {
    "User-Agent": "okhttp/4.12.0",
    "Accept": "application/json",
  },

  // القسم الافتراضي المستخدم مع:
  // /1
  // /2
  // /3
  DEFAULT_CATEGORY_ID: 4,

  // Cache
  INDEX_CACHE_SECONDS: 300,
  MANIFEST_CACHE_SECONDS: 5,

  DEFAULT_REFERER: "https://x.com/",

  DEFAULT_USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/139.0.0.0 Safari/537.36",

  CORS_ORIGIN: "*",
};


// ============================================================================
// MAIN
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return addCors(
          new Response(null, {
            status: 204,
          })
        );
      }

      if (
        request.method !== "GET" &&
        request.method !== "HEAD"
      ) {
        return addCors(
          jsonError(
            "Method not allowed",
            405
          )
        );
      }

      const url = new URL(request.url);

      const path = url.pathname
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");

      // ================================================================
      // HOME
      // ================================================================

      if (!path) {
        return addCors(
          jsonResponse({
            ok: true,
            name: "YCN Streaming Gateway",
            version: "2.0",

            routes: {
              categories: "/categories",

              category:
                "/category/{category_id}",

              channel_by_id:
                "/c/{channel_id}",

              channel_by_number:
                "/1",

              stream_by_number:
                "/1",
            },

            default_category:
              CONFIG.DEFAULT_CATEGORY_ID,
          })
        );
      }


      // ================================================================
      // CATEGORIES
      // ================================================================

      if (path === "categories") {
        return addCors(
          await categoriesRoute()
        );
      }


      // ================================================================
      // CATEGORY CHANNELS
      // ================================================================

      if (
        path.startsWith("category/")
      ) {
        const categoryId =
          path.split("/")[1];

        if (!categoryId) {
          return addCors(
            jsonError(
              "Missing category id",
              400
            )
          );
        }

        return addCors(
          await categoryRoute(
            categoryId
          )
        );
      }


      // ================================================================
      // CHANNEL BY REAL ID
      // /c/1424
      // ================================================================

      if (
        path.startsWith("c/")
      ) {
        const channelId =
          path.split("/")[1];

        if (!channelId) {
          return addCors(
            jsonError(
              "Missing channel id",
              400
            )
          );
        }

        return await openChannel(
          request,
          channelId
        );
      }


      // ================================================================
      // INTERNAL MANIFEST PROXY
      // ================================================================

      if (
        path === "_manifest"
      ) {
        return await proxyManifest(
          request
        );
      }


      // ================================================================
      // INTERNAL RESOURCE PROXY
      // Segments / AES Keys / Nested playlists
      // ================================================================

      if (
        path === "_resource"
      ) {
        return await proxyResource(
          request
        );
      }


      // ================================================================
      // SIMPLE CHANNEL NUMBER
      //
      // /1
      // /2
      // /3
      //
      // Uses DEFAULT_CATEGORY_ID
      // ================================================================

      if (/^\d+$/.test(path)) {
        const number =
          parseInt(path, 10);

        if (
          !Number.isFinite(number) ||
          number < 1
        ) {
          return addCors(
            jsonError(
              "Invalid channel number",
              400
            )
          );
        }

        const channels =
          await getCategoryChannels(
            CONFIG.DEFAULT_CATEGORY_ID
          );

        if (
          number >
          channels.length
        ) {
          return addCors(
            jsonError(
              `Channel ${number} not found. Available channels: ${channels.length}`,
              404
            )
          );
        }

        const channel =
          channels[number - 1];

        if (
          !channel ||
          channel.id === undefined ||
          channel.id === null
        ) {
          return addCors(
            jsonError(
              "Invalid channel data",
              500
            )
          );
        }

        return await openChannel(
          request,
          String(channel.id)
        );
      }


      // ================================================================
      // NOT FOUND
      // ================================================================

      return addCors(
        jsonError(
          "Route not found",
          404
        )
      );

    } catch (error) {
      return addCors(
        jsonError(
          error?.message ||
            String(error),
          500
        )
      );
    }
  },
};


// ============================================================================
// API REQUEST + DECRYPTION
// ============================================================================

async function apiFetch(endpoint) {
  const cleanEndpoint =
    endpoint.replace(/^\/+/, "");

  const apiUrl =
    `${CONFIG.API_BASE}/${cleanEndpoint}`;

  const response =
    await fetch(apiUrl, {
      method: "GET",

      headers: {
        "User-Agent":
          CONFIG.API_HEADERS[
            "User-Agent"
          ],

        "Accept":
          CONFIG.API_HEADERS.Accept,
      },

      redirect: "follow",
    });

  if (!response.ok) {
    throw new Error(
      `API returned HTTP ${response.status}`
    );
  }

  const t =
    response.headers.get("t") ||
    response.headers.get("T") ||
    "";

  if (!t) {
    throw new Error(
      'API response is missing "t" header'
    );
  }

  const encrypted =
    (await response.text()).trim();

  if (!encrypted) {
    throw new Error(
      "API returned an empty body"
    );
  }

  return decryptPayload(
    encrypted,
    t
  );
}


// ============================================================================
// BASE64 + XOR
// ============================================================================

function decryptPayload(
  encryptedBase64,
  t
) {
  let binaryString;

  try {
    binaryString =
      atob(encryptedBase64);
  } catch {
    throw new Error(
      "Invalid Base64 API response"
    );
  }

  const encryptedBytes =
    new Uint8Array(
      binaryString.length
    );

  for (
    let i = 0;
    i < binaryString.length;
    i++
  ) {
    encryptedBytes[i] =
      binaryString.charCodeAt(i);
  }

  const finalKey =
    CONFIG.STATIC_KEY +
    String(t);

  const keyBytes =
    new TextEncoder().encode(
      finalKey
    );

  if (!keyBytes.length) {
    throw new Error(
      "Invalid XOR key"
    );
  }

  const decrypted =
    new Uint8Array(
      encryptedBytes.length
    );

  for (
    let i = 0;
    i < encryptedBytes.length;
    i++
  ) {
    decrypted[i] =
      encryptedBytes[i] ^
      keyBytes[
        i % keyBytes.length
      ];
  }

  const text =
    new TextDecoder(
      "utf-8"
    ).decode(decrypted);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "Unable to parse decrypted JSON"
    );
  }
}


// ============================================================================
// NORMALIZE API DATA
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


// ============================================================================
// CATEGORIES
// ============================================================================

async function getCategories() {
  const cache =
    caches.default;

  const cacheKey =
    new Request(
      "https://worker.internal/cache/categories"
    );

  const cached =
    await cache.match(
      cacheKey
    );

  if (cached) {
    return await cached.json();
  }

  const payload =
    await apiFetch(
      "categories"
    );

  const categories =
    normalizeData(
      payload
    );

  if (
    !Array.isArray(categories)
  ) {
    throw new Error(
      "Categories API did not return an array"
    );
  }

  const cacheResponse =
    new Response(
      JSON.stringify(
        categories
      ),
      {
        headers: {
          "Content-Type":
            "application/json",

          "Cache-Control":
            `public, max-age=${CONFIG.INDEX_CACHE_SECONDS}`,
        },
      }
    );

  await cache.put(
    cacheKey,
    cacheResponse.clone()
  );

  return categories;
}


// ============================================================================
// CHANNELS INSIDE CATEGORY
// ============================================================================

async function getCategoryChannels(
  categoryId
) {
  const cache =
    caches.default;

  const cacheKey =
    new Request(
      `https://worker.internal/cache/category/${encodeURIComponent(categoryId)}`
    );

  const cached =
    await cache.match(
      cacheKey
    );

  if (cached) {
    return await cached.json();
  }

  const payload =
    await apiFetch(
      `categories/${encodeURIComponent(categoryId)}/channels`
    );

  const channels =
    normalizeData(
      payload
    );

  if (
    !Array.isArray(channels)
  ) {
    throw new Error(
      "Channels API did not return an array"
    );
  }

  const cacheResponse =
    new Response(
      JSON.stringify(
        channels
      ),
      {
        headers: {
          "Content-Type":
            "application/json",

          "Cache-Control":
            `public, max-age=${CONFIG.INDEX_CACHE_SECONDS}`,
        },
      }
    );

  await cache.put(
    cacheKey,
    cacheResponse.clone()
  );

  return channels;
}


// ============================================================================
// CHANNEL STREAM INFO
// ============================================================================

async function getChannelStream(
  channelId
) {
  const payload =
    await apiFetch(
      `channel/${encodeURIComponent(channelId)}`
    );

  let data =
    normalizeData(
      payload
    );

  // Some APIs return:
  // data: [...]
  if (
    Array.isArray(data)
  ) {
    if (!data.length) {
      throw new Error(
        "Channel API returned no streams"
      );
    }

    // Prefer first valid item
    const valid =
      data.find(
        item =>
          item &&
          typeof item === "object" &&
          (
            item.url ||
            item.stream_url ||
            item.link
          )
      );

    data =
      valid ||
      data[0];
  }

  if (
    !data ||
    typeof data !== "object"
  ) {
    throw new Error(
      "Invalid channel response"
    );
  }

  const streamUrl =
    data.url ||
    data.stream_url ||
    data.link;

  if (!streamUrl) {
    throw new Error(
      "No stream URL found for channel"
    );
  }

  validateHttpUrl(
    streamUrl
  );

  const referer =
    data.referer ||
    data.headers?.Referer ||
    data.headers?.referer ||
    CONFIG.DEFAULT_REFERER;

  const userAgent =
    data.user_agent ||
    data.userAgent ||
    data.headers?.["User-Agent"] ||
    data.headers?.["user-agent"] ||
    CONFIG.DEFAULT_USER_AGENT;

  return {
    id: channelId,

    url:
      streamUrl,

    referer,

    userAgent,

    raw:
      data,
  };
}


// ============================================================================
// OPEN CHANNEL
// ============================================================================

async function openChannel(
  request,
  channelId
) {
  const stream =
    await getChannelStream(
      channelId
    );

  const requestUrl =
    new URL(
      request.url
    );

  const params =
    new URLSearchParams();

  params.set(
    "u",
    stream.url
  );

  params.set(
    "r",
    stream.referer || ""
  );

  params.set(
    "a",
    stream.userAgent || ""
  );

  const destination =
    `${requestUrl.origin}/_manifest?${params.toString()}`;

  return Response.redirect(
    destination,
    302
  );
}


// ============================================================================
// MANIFEST PROXY
// ============================================================================

async function proxyManifest(
  request
) {
  const workerUrl =
    new URL(
      request.url
    );

  const upstreamUrl =
    workerUrl.searchParams.get(
      "u"
    );

  const referer =
    workerUrl.searchParams.get(
      "r"
    ) ||
    CONFIG.DEFAULT_REFERER;

  const userAgent =
    workerUrl.searchParams.get(
      "a"
    ) ||
    CONFIG.DEFAULT_USER_AGENT;

  if (!upstreamUrl) {
    return addCors(
      jsonError(
        "Missing manifest URL",
        400
      )
    );
  }

  validateHttpUrl(
    upstreamUrl
  );

  const headers =
    buildUpstreamHeaders(
      request,
      referer,
      userAgent
    );

  const upstream =
    await fetch(
      upstreamUrl,
      {
        method: "GET",
        headers,
        redirect: "follow",
      }
    );

  if (!upstream.ok) {
    return addCors(
      jsonError(
        `Manifest upstream returned HTTP ${upstream.status}`,
        upstream.status
      )
    );
  }

  const manifest =
    await upstream.text();

  if (
    !manifest
      .trimStart()
      .startsWith(
        "#EXTM3U"
      )
  ) {
    return addCors(
      jsonError(
        "Upstream response is not a valid HLS manifest",
        502
      )
    );
  }

  const finalManifestUrl =
    upstream.url ||
    upstreamUrl;

  const rewritten =
    rewriteManifest(
      manifest,

      finalManifestUrl,

      workerUrl.origin,

      referer,

      userAgent
    );

  if (
    request.method === "HEAD"
  ) {
    return addCors(
      new Response(
        null,
        {
          status: 200,

          headers: {
            "Content-Type":
              "application/vnd.apple.mpegurl",

            "Cache-Control":
              "no-cache",
          },
        }
      )
    );
  }

  return addCors(
    new Response(
      rewritten,
      {
        status: 200,

        headers: {
          "Content-Type":
            "application/vnd.apple.mpegurl; charset=utf-8",

          "Cache-Control":
            `public, max-age=${CONFIG.MANIFEST_CACHE_SECONDS}`,

          "X-Content-Type-Options":
            "nosniff",
        },
      }
    )
  );
}


// ============================================================================
// RESOURCE PROXY
// Handles:
//
// .ts
// .pdf
// .js
// .m4s
// .mp4
// AES keys
// nested m3u8
// ============================================================================

async function proxyResource(
  request
) {
  const workerUrl =
    new URL(
      request.url
    );

  const upstreamUrl =
    workerUrl.searchParams.get(
      "u"
    );

  const referer =
    workerUrl.searchParams.get(
      "r"
    ) ||
    CONFIG.DEFAULT_REFERER;

  const userAgent =
    workerUrl.searchParams.get(
      "a"
    ) ||
    CONFIG.DEFAULT_USER_AGENT;

  if (!upstreamUrl) {
    return addCors(
      jsonError(
        "Missing resource URL",
        400
      )
    );
  }

  validateHttpUrl(
    upstreamUrl
  );

  const headers =
    buildUpstreamHeaders(
      request,
      referer,
      userAgent
    );

  let upstream =
    await fetch(
      upstreamUrl,
      {
        method: "GET",
        headers,
        redirect: "follow",
      }
    );

  if (!upstream.ok) {
    return addCors(
      new Response(
        `Upstream HTTP ${upstream.status}`,
        {
          status:
            upstream.status,

          headers: {
            "Content-Type":
              "text/plain; charset=utf-8",
          },
        }
      )
    );
  }

  const finalUrl =
    upstream.url ||
    upstreamUrl;

  const contentType =
    upstream.headers.get(
      "Content-Type"
    ) || "";

  // ========================================================================
  // NESTED HLS MANIFEST
  // ========================================================================

  if (
    isManifestResponse(
      finalUrl,
      contentType
    )
  ) {
    const manifest =
      await upstream.text();

    if (
      manifest
        .trimStart()
        .startsWith(
          "#EXTM3U"
        )
    ) {
      const rewritten =
        rewriteManifest(
          manifest,

          finalUrl,

          workerUrl.origin,

          referer,

          userAgent
        );

      if (
        request.method === "HEAD"
      ) {
        return addCors(
          new Response(
            null,
            {
              status: 200,

              headers: {
                "Content-Type":
                  "application/vnd.apple.mpegurl",

                "Cache-Control":
                  "no-cache",
              },
            }
          )
        );
      }

      return addCors(
        new Response(
          rewritten,
          {
            status: 200,

            headers: {
              "Content-Type":
                "application/vnd.apple.mpegurl; charset=utf-8",

              "Cache-Control":
                `public, max-age=${CONFIG.MANIFEST_CACHE_SECONDS}`,
            },
          }
        )
      );
    }
  }


  // ========================================================================
  // BINARY RESOURCE
  // ========================================================================

  const responseHeaders =
    new Headers();

  copyHeader(
    upstream.headers,
    responseHeaders,
    "Content-Length"
  );

  copyHeader(
    upstream.headers,
    responseHeaders,
    "Content-Range"
  );

  copyHeader(
    upstream.headers,
    responseHeaders,
    "Accept-Ranges"
  );

  copyHeader(
    upstream.headers,
    responseHeaders,
    "ETag"
  );

  copyHeader(
    upstream.headers,
    responseHeaders,
    "Last-Modified"
  );

  copyHeader(
    upstream.headers,
    responseHeaders,
    "Content-Encoding"
  );

  responseHeaders.set(
    "Content-Type",
    detectContentType(
      finalUrl,
      contentType
    )
  );

  responseHeaders.set(
    "Cache-Control",
    "public, max-age=15"
  );

  if (
    request.method === "HEAD"
  ) {
    return addCors(
      new Response(
        null,
        {
          status:
            upstream.status,

          headers:
            responseHeaders,
        }
      )
    );
  }

  return addCors(
    new Response(
      upstream.body,
      {
        status:
          upstream.status,

        headers:
          responseHeaders,
      }
    )
  );
}


// ============================================================================
// MANIFEST REWRITE
// ============================================================================

function rewriteManifest(
  manifest,
  sourceManifestUrl,
  workerOrigin,
  referer,
  userAgent
) {
  const baseUrl =
    new URL(
      sourceManifestUrl
    );

  const lines =
    manifest.split(
      /\r?\n/
    );

  const output =
    [];

  for (
    const originalLine
    of lines
  ) {
    const trimmed =
      originalLine.trim();

    if (!trimmed) {
      output.push(
        originalLine
      );

      continue;
    }


    // ======================================================================
    // TAGS THAT CONTAIN URI="..."
    // ======================================================================

    if (
      trimmed.startsWith(
        "#EXT-X-KEY:"
      ) ||

      trimmed.startsWith(
        "#EXT-X-SESSION-KEY:"
      ) ||

      trimmed.startsWith(
        "#EXT-X-MAP:"
      ) ||

      trimmed.startsWith(
        "#EXT-X-MEDIA:"
      ) ||

      trimmed.startsWith(
        "#EXT-X-I-FRAME-STREAM-INF:"
      ) ||

      trimmed.startsWith(
        "#EXT-X-PART:"
      ) ||

      trimmed.startsWith(
        "#EXT-X-PRELOAD-HINT:"
      ) ||

      trimmed.startsWith(
        "#EXT-X-RENDITION-REPORT:"
      )
    ) {
      output.push(
        rewriteUriAttribute(
          originalLine,

          baseUrl,

          workerOrigin,

          referer,

          userAgent
        )
      );

      continue;
    }


    // ======================================================================
    // OTHER TAGS
    // ======================================================================

    if (
      trimmed.startsWith(
        "#"
      )
    ) {
      output.push(
        originalLine
      );

      continue;
    }


    // ======================================================================
    // NORMAL RESOURCE / CHILD MANIFEST
    // ======================================================================

    let absolute;

    try {
      absolute =
        new URL(
          trimmed,
          baseUrl
        ).href;
    } catch {
      output.push(
        originalLine
      );

      continue;
    }

    output.push(
      buildResourceProxyUrl(
        workerOrigin,

        absolute,

        referer,

        userAgent
      )
    );
  }

  return output.join(
    "\n"
  );
}


// ============================================================================
// REWRITE URI="..."
// ============================================================================

function rewriteUriAttribute(
  line,
  baseUrl,
  workerOrigin,
  referer,
  userAgent
) {
  return line.replace(
    /URI=(["'])(.*?)\1/gi,

    (
      full,
      quote,
      value
    ) => {
      let absolute;

      try {
        absolute =
          new URL(
            value,
            baseUrl
          ).href;
      } catch {
        return full;
      }

      const proxyUrl =
        buildResourceProxyUrl(
          workerOrigin,

          absolute,

          referer,

          userAgent
        );

      return `URI=${quote}${proxyUrl}${quote}`;
    }
  );
}


// ============================================================================
// BUILD INTERNAL RESOURCE URL
// ============================================================================

function buildResourceProxyUrl(
  workerOrigin,
  upstream,
  referer,
  userAgent
) {
  const params =
    new URLSearchParams();

  params.set(
    "u",
    upstream
  );

  if (referer) {
    params.set(
      "r",
      referer
    );
  }

  if (userAgent) {
    params.set(
      "a",
      userAgent
    );
  }

  return (
    `${workerOrigin}/_resource?` +
    params.toString()
  );
}


// ============================================================================
// UPSTREAM HEADERS
// ============================================================================

function buildUpstreamHeaders(
  request,
  referer,
  userAgent
) {
  const headers =
    new Headers();

  // FIXED:
  // Do NOT use:
  //
  // headers.set("*/*", "*/*");
  //
  // because "*/*" is not a valid header name.

  headers.set(
    "Accept",
    "*/*"
  );

  if (userAgent) {
    headers.set(
      "User-Agent",
      userAgent
    );
  }

  if (referer) {
    headers.set(
      "Referer",
      referer
    );
  }

  const range =
    request.headers.get(
      "Range"
    );

  if (range) {
    headers.set(
      "Range",
      range
    );
  }

  const ifNoneMatch =
    request.headers.get(
      "If-None-Match"
    );

  if (ifNoneMatch) {
    headers.set(
      "If-None-Match",
      ifNoneMatch
    );
  }

  const ifModifiedSince =
    request.headers.get(
      "If-Modified-Since"
    );

  if (ifModifiedSince) {
    headers.set(
      "If-Modified-Since",
      ifModifiedSince
    );
  }

  return headers;
}


// ============================================================================
// CONTENT TYPE DETECTION
// ============================================================================

function detectContentType(
  url,
  upstreamContentType
) {
  let pathname = "";

  try {
    pathname =
      new URL(url)
        .pathname
        .toLowerCase();
  } catch {
    pathname =
      String(url)
        .toLowerCase();
  }


  // HLS
  if (
    pathname.endsWith(
      ".m3u8"
    )
  ) {
    return (
      "application/vnd.apple.mpegurl"
    );
  }


  // MPEG-TS
  if (
    pathname.endsWith(".ts") ||
    pathname.endsWith(".mpegts")
  ) {
    return "video/mp2t";
  }


  // Obfuscated MPEG-TS chunks
  if (
    pathname.endsWith(".pdf") ||
    pathname.endsWith(".js")
  ) {
    return "video/mp2t";
  }


  // fragmented MP4
  if (
    pathname.endsWith(".m4s") ||
    pathname.endsWith(".cmfv")
  ) {
    return "video/mp4";
  }


  if (
    pathname.endsWith(
      ".cmfa"
    )
  ) {
    return "audio/mp4";
  }


  if (
    pathname.endsWith(
      ".mp4"
    )
  ) {
    return "video/mp4";
  }


  if (
    pathname.endsWith(
      ".aac"
    )
  ) {
    return "audio/aac";
  }


  if (
    pathname.endsWith(
      ".mp3"
    )
  ) {
    return "audio/mpeg";
  }


  // AES key or unknown binary
  if (
    upstreamContentType &&
    !upstreamContentType
      .toLowerCase()
      .includes(
        "text/html"
      )
  ) {
    return upstreamContentType;
  }


  return (
    "application/octet-stream"
  );
}


// ============================================================================
// DETECT HLS MANIFEST
// ============================================================================

function isManifestResponse(
  url,
  contentType
) {
  const lowerType =
    String(
      contentType || ""
    ).toLowerCase();

  if (
    lowerType.includes(
      "mpegurl"
    ) ||
    lowerType.includes(
      "m3u"
    )
  ) {
    return true;
  }

  try {
    const pathname =
      new URL(url)
        .pathname
        .toLowerCase();

    return pathname.endsWith(
      ".m3u8"
    );

  } catch {
    return String(url)
      .toLowerCase()
      .includes(
        ".m3u8"
      );
  }
}


// ============================================================================
// CATEGORY ROUTE
// ============================================================================

async function categoriesRoute() {
  const categories =
    await getCategories();

  return jsonResponse({
    ok: true,

    count:
      categories.length,

    categories:
      categories.map(
        (
          category,
          index
        ) => ({
          number:
            index + 1,

          ...category,
        })
      ),
  });
}


// ============================================================================
// CATEGORY CHANNEL LIST
// ============================================================================

async function categoryRoute(
  categoryId
) {
  const channels =
    await getCategoryChannels(
      categoryId
    );

  return jsonResponse({
    ok: true,

    category_id:
      categoryId,

    count:
      channels.length,

    channels:
      channels.map(
        (
          channel,
          index
        ) => ({
          number:
            index + 1,

          direct:
            `/c/${channel.id}`,

          ...channel,
        })
      ),
  });
}


// ============================================================================
// VALIDATE URL
// ============================================================================

function validateHttpUrl(
  value
) {
  let url;

  try {
    url =
      new URL(
        value
      );
  } catch {
    throw new Error(
      "Invalid upstream URL"
    );
  }

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error(
      "Unsupported upstream protocol"
    );
  }

  return url;
}


// ============================================================================
// COPY HEADER
// ============================================================================

function copyHeader(
  source,
  target,
  name
) {
  const value =
    source.get(
      name
    );

  if (value !== null) {
    target.set(
      name,
      value
    );
  }
}


// ============================================================================
// JSON RESPONSE
// ============================================================================

function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",
      },
    }
  );
}


// ============================================================================
// JSON ERROR
// ============================================================================

function jsonError(
  message,
  status = 500
) {
  return jsonResponse(
    {
      ok: false,
      error: message,
    },
    status
  );
}


// ============================================================================
// CORS
// ============================================================================

function addCors(
  response
) {
  const headers =
    new Headers(
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
    "Range, Accept, Content-Type, If-None-Match, If-Modified-Since"
  );

  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified"
  );

  return new Response(
    response.body,
    {
      status:
        response.status,

      statusText:
        response.statusText,

      headers,
    }
  );
}
