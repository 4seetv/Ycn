// ============================================================================
// YCN LIVE STREAM GATEWAY
// Cloudflare Worker - Single File
//
// Version: 3.0
//
// Main improvements:
// - Stable /c/{id} -> /live/{id}.m3u8
// - Fresh stream URL on every live manifest refresh
// - No caching for live manifests
// - Automatic t/e propagation
// - Automatic token refresh before expiry
// - Automatic retry after 401/403
// - HLS master/media playlist rewriting
// - AES-128 key proxy
// - MPEG-TS / disguised .pdf / .js chunks
// - Range request support
// ============================================================================


// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {

  API_BASE:
    "https://def.ycnapi.com/api",

  STATIC_KEY:
    "c!xZj+N9&G@Ev@vw",

  API_USER_AGENT:
    "okhttp/4.12.0",

  API_ACCEPT:
    "application/json",

  DEFAULT_CATEGORY_ID:
    4,

  DEFAULT_REFERER:
    "https://x.com/",

  DEFAULT_PLAYER_UA:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/139.0.0.0 Safari/537.36",

  // Cache only category/channel indexes.
  INDEX_CACHE_SECONDS:
    300,

  // Refresh token shortly before its expiration.
  TOKEN_REFRESH_MARGIN_SECONDS:
    20,

  CORS_ORIGIN:
    "*",
};


// ============================================================================
// MAIN WORKER
// ============================================================================

export default {

  async fetch(request, env, ctx) {

    try {

      // ----------------------------------------------------------------------
      // OPTIONS
      // ----------------------------------------------------------------------

      if (request.method === "OPTIONS") {

        return addCors(
          new Response(null, {
            status: 204
          })
        );
      }


      // ----------------------------------------------------------------------
      // METHODS
      // ----------------------------------------------------------------------

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


      const requestUrl =
        new URL(request.url);

      const path =
        requestUrl.pathname
          .replace(/^\/+/, "")
          .replace(/\/+$/, "");


      // ======================================================================
      // HOME
      // ======================================================================

      if (!path) {

        return addCors(
          jsonResponse({

            ok: true,

            service:
              "YCN Live Streaming Gateway",

            version:
              "3.0",

            default_category:
              CONFIG.DEFAULT_CATEGORY_ID,

            routes: {

              categories:
                "/categories",

              category_channels:
                "/category/4",

              direct_channel:
                "/c/1424",

              stable_live:
                "/live/1424.m3u8",

              numbered_channel:
                "/1",
            },
          })
        );
      }


      // ======================================================================
      // CATEGORIES
      // ======================================================================

      if (path === "categories") {

        return addCors(
          await categoriesRoute()
        );
      }


      // ======================================================================
      // CATEGORY
      // ======================================================================

      if (
        path.startsWith("category/")
      ) {

        const parts =
          path.split("/");

        const categoryId =
          parts[1];

        if (!categoryId) {

          return addCors(
            jsonError(
              "Missing category ID",
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


      // ======================================================================
      // CHANNEL REAL ID
      //
      // /c/1424
      //
      // Redirects to a STABLE manifest:
      //
      // /live/1424.m3u8
      //
      // ======================================================================

      if (
        path.startsWith("c/")
      ) {

        const parts =
          path.split("/");

        const channelId =
          parts[1];

        if (!channelId) {

          return addCors(
            jsonError(
              "Missing channel ID",
              400
            )
          );
        }

        const destination =
          `${requestUrl.origin}/live/${encodeURIComponent(channelId)}.m3u8`;

        return Response.redirect(
          destination,
          302
        );
      }


      // ======================================================================
      // STABLE LIVE MANIFEST
      //
      // /live/1424.m3u8
      //
      // IMPORTANT:
      // Every playlist refresh gets fresh channel information.
      // ======================================================================

      if (
        path.startsWith("live/")
      ) {

        let channelId =
          path.substring(
            "live/".length
          );

        channelId =
          channelId.replace(
            /\.m3u8$/i,
            ""
          );

        if (!channelId) {

          return addCors(
            jsonError(
              "Missing live channel ID",
              400
            )
          );
        }

        return await liveManifestRoute(
          request,
          channelId
        );
      }


      // ======================================================================
      // INTERNAL RESOURCE
      //
      // Segments
      // AES keys
      // nested playlists
      // fMP4
      // ======================================================================

      if (
        path === "_resource"
      ) {

        return await proxyResource(
          request
        );
      }


      // ======================================================================
      // NUMBERED CHANNEL
      //
      // /1
      // /2
      // /3
      //
      // ======================================================================

      if (
        /^\d+$/.test(path)
      ) {

        const number =
          parseInt(
            path,
            10
          );

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

              `Channel ${number} not found. ` +
              `Available: ${channels.length}`,

              404
            )
          );
        }


        const channel =
          channels[
            number - 1
          ];


        if (
          !channel ||
          channel.id === undefined ||
          channel.id === null
        ) {

          return addCors(
            jsonError(
              "Invalid channel information",
              500
            )
          );
        }


        const destination =
          `${requestUrl.origin}/live/${encodeURIComponent(channel.id)}.m3u8`;


        return Response.redirect(
          destination,
          302
        );
      }


      // ======================================================================
      // NOT FOUND
      // ======================================================================

      return addCors(
        jsonError(
          "Route not found",
          404
        )
      );

    }

    catch (error) {

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
// API FETCH
// ============================================================================

async function apiFetch(endpoint) {

  const cleanEndpoint =
    String(endpoint)
      .replace(/^\/+/, "");


  const url =
    `${CONFIG.API_BASE}/${cleanEndpoint}`;


  const response =
    await fetch(
      url,
      {

        method:
          "GET",

        headers: {

          "User-Agent":
            CONFIG.API_USER_AGENT,

          "Accept":
            CONFIG.API_ACCEPT,
        },

        redirect:
          "follow",

        // IMPORTANT:
        // Never use stale API playback information.
        cache:
          "no-store",
      }
    );


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
    (await response.text())
      .trim();


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
// BASE64 + XOR DECRYPTION
// ============================================================================

function decryptPayload(
  encryptedBase64,
  t
) {

  let binary;


  try {

    binary =
      atob(
        encryptedBase64
      );

  }

  catch {

    throw new Error(
      "Invalid Base64 API response"
    );
  }


  const encryptedBytes =
    new Uint8Array(
      binary.length
    );


  for (
    let i = 0;
    i < binary.length;
    i++
  ) {

    encryptedBytes[i] =
      binary.charCodeAt(i);
  }


  const finalKey =
    CONFIG.STATIC_KEY +
    String(t);


  const keyBytes =
    new TextEncoder()
      .encode(
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
    ).decode(
      decrypted
    );


  try {

    return JSON.parse(
      text
    );

  }

  catch {

    throw new Error(
      "Unable to parse decrypted API JSON"
    );
  }
}


// ============================================================================
// NORMALIZE DATA
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
      "https://internal.ycn/categories"
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
      "Categories response is invalid"
    );
  }


  const response =
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
    response.clone()
  );


  return categories;
}


// ============================================================================
// CATEGORY CHANNELS
// ============================================================================

async function getCategoryChannels(
  categoryId
) {

  const cache =
    caches.default;


  const cacheKey =
    new Request(

      "https://internal.ycn/category/" +

      encodeURIComponent(
        categoryId
      )
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
      "Channels response is invalid"
    );
  }


  const response =
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
    response.clone()
  );


  return channels;
}


// ============================================================================
// GET CHANNEL STREAM DATA
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


  // API may return:
  //
  // data: [
  //   {
  //      name: "HD",
  //      url: "...",
  //      ...
  //   }
  // ]
  //
  if (
    Array.isArray(data)
  ) {

    if (!data.length) {

      throw new Error(
        "Channel API returned no streams"
      );
    }


    const valid =
      data.find(
        item =>

          item &&

          typeof item ===
            "object" &&

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
      "Channel has no stream URL"
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

    data.headers?.[
      "User-Agent"
    ] ||

    data.headers?.[
      "user-agent"
    ] ||

    CONFIG.DEFAULT_PLAYER_UA;


  return {

    id:
      String(channelId),

    url:
      streamUrl,

    referer:
      referer,

    userAgent:
      userAgent,

    raw:
      data,
  };
}


// ============================================================================
// STABLE LIVE MANIFEST
// ============================================================================

async function liveManifestRoute(
  request,
  channelId
) {

  // --------------------------------------------------------------------------
  // Fresh channel URL every manifest reload
  // --------------------------------------------------------------------------

  const stream =
    await getChannelStream(
      channelId
    );


  return fetchAndRewriteManifest(

    request,

    stream.url,

    stream.referer,

    stream.userAgent,

    channelId
  );
}


// ============================================================================
// FETCH + REWRITE MANIFEST
// ============================================================================

async function fetchAndRewriteManifest(

  request,

  manifestUrl,

  referer,

  userAgent,

  channelId
) {

  validateHttpUrl(
    manifestUrl
  );


  const upstream =
    await fetch(
      manifestUrl,
      {

        method:
          "GET",

        headers:
          buildUpstreamHeaders(
            request,
            referer,
            userAgent
          ),

        redirect:
          "follow",

        // CRITICAL FOR LIVE HLS
        cache:
          "no-store",
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
      .startsWith("#EXTM3U")
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
    manifestUrl;


  const workerUrl =
    new URL(
      request.url
    );


  const rewritten =
    rewriteManifest(

      manifest,

      finalManifestUrl,

      workerUrl.origin,

      referer,

      userAgent,

      channelId
    );


  const headers =
    new Headers();


  headers.set(
    "Content-Type",
    "application/vnd.apple.mpegurl; charset=utf-8"
  );


  // Absolutely no playlist caching.
  headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, max-age=0"
  );


  headers.set(
    "Pragma",
    "no-cache"
  );


  headers.set(
    "Expires",
    "0"
  );


  headers.set(
    "X-Content-Type-Options",
    "nosniff"
  );


  if (
    request.method === "HEAD"
  ) {

    return addCors(
      new Response(
        null,
        {
          status: 200,
          headers
        }
      )
    );
  }


  return addCors(
    new Response(
      rewritten,
      {

        status:
          200,

        headers:
          headers,
      }
    )
  );
}


// ============================================================================
// RESOURCE PROXY
// ============================================================================

async function proxyResource(
  request
) {

  const workerUrl =
    new URL(
      request.url
    );


  let upstreamUrl =
    workerUrl.searchParams.get(
      "u"
    );


  const channelId =
    workerUrl.searchParams.get(
      "cid"
    ) || "";


  const referer =
    workerUrl.searchParams.get(
      "r"
    ) ||
    CONFIG.DEFAULT_REFERER;


  const userAgent =
    workerUrl.searchParams.get(
      "a"
    ) ||
    CONFIG.DEFAULT_PLAYER_UA;


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


  // --------------------------------------------------------------------------
  // If token is already near expiry, renew BEFORE requesting the resource.
  // --------------------------------------------------------------------------

  if (
    channelId &&
    shouldRefreshToken(
      upstreamUrl
    )
  ) {

    upstreamUrl =
      await refreshResourceToken(

        upstreamUrl,

        channelId
      );
  }


  // --------------------------------------------------------------------------
  // FIRST ATTEMPT
  // --------------------------------------------------------------------------

  let upstream =
    await fetchResource(

      request,

      upstreamUrl,

      referer,

      userAgent
    );


  // --------------------------------------------------------------------------
  // If token failed, obtain a fresh token and retry once.
  // --------------------------------------------------------------------------

  if (
    channelId &&
    (
      upstream.status === 401 ||
      upstream.status === 403
    )
  ) {

    const refreshedUrl =
      await refreshResourceToken(

        upstreamUrl,

        channelId,

        true
      );


    if (
      refreshedUrl !==
      upstreamUrl
    ) {

      upstreamUrl =
        refreshedUrl;


      upstream =
        await fetchResource(

          request,

          upstreamUrl,

          referer,

          userAgent
        );
    }
  }


  // --------------------------------------------------------------------------
  // ERROR
  // --------------------------------------------------------------------------

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

            "Cache-Control":
              "no-store",
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
  // NESTED PLAYLIST
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

          userAgent,

          channelId
        );


      const headers =
        new Headers();


      headers.set(

        "Content-Type",

        "application/vnd.apple.mpegurl; charset=utf-8"
      );


      headers.set(

        "Cache-Control",

        "no-store, no-cache, must-revalidate, max-age=0"
      );


      headers.set(
        "Pragma",
        "no-cache"
      );


      headers.set(
        "Expires",
        "0"
      );


      if (
        request.method === "HEAD"
      ) {

        return addCors(
          new Response(
            null,
            {
              status:
                200,

              headers:
                headers,
            }
          )
        );
      }


      return addCors(
        new Response(
          rewritten,
          {

            status:
              200,

            headers:
              headers,
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


  responseHeaders.set(

    "Content-Type",

    detectContentType(
      finalUrl,
      contentType
    )
  );


  // Segments may be cached briefly by the player/browser,
  // but prevent long-lived stale Cloudflare responses.

  responseHeaders.set(

    "Cache-Control",

    "private, max-age=5"
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
// FETCH RESOURCE
// ============================================================================

async function fetchResource(

  request,

  upstreamUrl,

  referer,

  userAgent
) {

  return await fetch(
    upstreamUrl,
    {

      method:
        "GET",

      headers:
        buildUpstreamHeaders(
          request,
          referer,
          userAgent
        ),

      redirect:
        "follow",

      // Avoid Cloudflare serving an expired tokenized resource.
      cache:
        "no-store",
    }
  );
}


// ============================================================================
// TOKEN EXPIRY CHECK
// ============================================================================

function shouldRefreshToken(
  url
) {

  try {

    const parsed =
      new URL(url);


    const expiry =
      parsed.searchParams.get(
        "e"
      );


    // No expiry marker.
    if (!expiry) {

      return false;
    }


    const expiryNumber =
      Number(expiry);


    if (
      !Number.isFinite(
        expiryNumber
      )
    ) {

      return false;
    }


    const now =
      Math.floor(
        Date.now() / 1000
      );


    return (
      expiryNumber <=
      (
        now +
        CONFIG.TOKEN_REFRESH_MARGIN_SECONDS
      )
    );

  }

  catch {

    return false;
  }
}


// ============================================================================
// REFRESH RESOURCE TOKEN
// ============================================================================

async function refreshResourceToken(

  oldResourceUrl,

  channelId,

  force = false
) {

  try {

    if (
      !force &&
      !shouldRefreshToken(
        oldResourceUrl
      )
    ) {

      return oldResourceUrl;
    }


    const freshStream =
      await getChannelStream(
        channelId
      );


    const freshRoot =
      new URL(
        freshStream.url
      );


    const target =
      new URL(
        oldResourceUrl
      );


    // ----------------------------------------------------------------------
    // Replace important authentication parameters
    // ----------------------------------------------------------------------

    const authParams = [
      "t",
      "e"
    ];


    for (
      const key
      of authParams
    ) {

      if (
        freshRoot.searchParams.has(
          key
        )
      ) {

        target.searchParams.set(

          key,

          freshRoot.searchParams.get(
            key
          )
        );
      }
    }


    return target.href;

  }

  catch {

    // If refresh fails, keep the old URL.
    return oldResourceUrl;
  }
}


// ============================================================================
// MANIFEST REWRITE
// ============================================================================

function rewriteManifest(

  manifest,

  sourceManifestUrl,

  workerOrigin,

  referer,

  userAgent,

  channelId
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
    // URI ATTRIBUTES
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

          userAgent,

          channelId
        )
      );

      continue;
    }


    // ======================================================================
    // NORMAL HLS TAG
    // ======================================================================

    if (
      trimmed.startsWith("#")
    ) {

      output.push(
        originalLine
      );

      continue;
    }


    // ======================================================================
    // SEGMENT OR CHILD PLAYLIST
    // ======================================================================

    let absolute;


    try {

      absolute =
        resolveResourceUrl(

          trimmed,

          baseUrl
        );

    }

    catch {

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

        userAgent,

        channelId
      )
    );
  }


  return output.join(
    "\n"
  );
}


// ============================================================================
// URI ATTRIBUTE REWRITE
// ============================================================================

function rewriteUriAttribute(

  line,

  baseUrl,

  workerOrigin,

  referer,

  userAgent,

  channelId
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
          resolveResourceUrl(

            value,

            baseUrl
          );

      }

      catch {

        return full;
      }


      const proxy =
        buildResourceProxyUrl(

          workerOrigin,

          absolute,

          referer,

          userAgent,

          channelId
        );


      return (
        `URI=${quote}${proxy}${quote}`
      );
    }
  );
}


// ============================================================================
// RESOLVE CHILD URL + INHERIT AUTH TOKENS
// ============================================================================

function resolveResourceUrl(

  value,

  baseUrl
) {

  const target =
    new URL(
      value,
      baseUrl
    );


  // --------------------------------------------------------------------------
  // Important:
  //
  // Relative URL resolution normally does NOT inherit the query string
  // from the playlist URL.
  //
  // If t/e are authentication parameters and the child resource does not
  // already contain them, inherit them.
  // --------------------------------------------------------------------------

  const inheritedParams = [
    "t",
    "e"
  ];


  for (
    const key
    of inheritedParams
  ) {

    if (
      !target.searchParams.has(
        key
      ) &&

      baseUrl.searchParams.has(
        key
      )
    ) {

      target.searchParams.set(

        key,

        baseUrl.searchParams.get(
          key
        )
      );
    }
  }


  return target.href;
}


// ============================================================================
// BUILD RESOURCE PROXY URL
// ============================================================================

function buildResourceProxyUrl(

  workerOrigin,

  upstream,

  referer,

  userAgent,

  channelId
) {

  const params =
    new URLSearchParams();


  params.set(
    "u",
    upstream
  );


  if (channelId) {

    params.set(
      "cid",
      channelId
    );
  }


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


  // --------------------------------------------------------------------------
  // VLC / players may use Range
  // --------------------------------------------------------------------------

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


  return headers;
}


// ============================================================================
// CONTENT TYPE
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

  }

  catch {

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


  // MPEG Transport Stream
  if (

    pathname.endsWith(".ts") ||

    pathname.endsWith(".mpegts")
  ) {

    return "video/mp2t";
  }


  // Disguised TS chunks
  if (

    pathname.endsWith(".pdf") ||

    pathname.endsWith(".js")
  ) {

    return "video/mp2t";
  }


  // Fragmented MP4
  if (

    pathname.endsWith(".m4s") ||

    pathname.endsWith(".cmfv")
  ) {

    return "video/mp4";
  }


  if (
    pathname.endsWith(".cmfa")
  ) {

    return "audio/mp4";
  }


  if (
    pathname.endsWith(".mp4")
  ) {

    return "video/mp4";
  }


  if (
    pathname.endsWith(".aac")
  ) {

    return "audio/aac";
  }


  if (
    pathname.endsWith(".mp3")
  ) {

    return "audio/mpeg";
  }


  // Keep valid upstream type when available.
  if (
    upstreamContentType &&

    !String(
      upstreamContentType
    )
      .toLowerCase()
      .includes(
        "text/html"
      )
  ) {

    return upstreamContentType;
  }


  // AES key / unknown binary
  return (
    "application/octet-stream"
  );
}


// ============================================================================
// HLS DETECTION
// ============================================================================

function isManifestResponse(

  url,

  contentType
) {

  const type =
    String(
      contentType || ""
    ).toLowerCase();


  if (

    type.includes(
      "mpegurl"
    ) ||

    type.includes(
      "m3u"
    )
  ) {

    return true;
  }


  try {

    return new URL(url)
      .pathname
      .toLowerCase()
      .endsWith(
        ".m3u8"
      );

  }

  catch {

    return String(url)
      .toLowerCase()
      .includes(
        ".m3u8"
      );
  }
}


// ============================================================================
// CATEGORY ROUTES
// ============================================================================

async function categoriesRoute() {

  const categories =
    await getCategories();


  return jsonResponse({

    ok:
      true,

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


async function categoryRoute(
  categoryId
) {

  const channels =
    await getCategoryChannels(
      categoryId
    );


  return jsonResponse({

    ok:
      true,

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

          stable_live:
            `/live/${channel.id}.m3u8`,

          ...channel,
        })
      ),
  });
}


// ============================================================================
// URL VALIDATION
// ============================================================================

function validateHttpUrl(
  value
) {

  let parsed;


  try {

    parsed =
      new URL(
        value
      );

  }

  catch {

    throw new Error(
      "Invalid upstream URL"
    );
  }


  if (

    parsed.protocol !== "http:" &&

    parsed.protocol !== "https:"
  ) {

    throw new Error(
      "Unsupported upstream protocol"
    );
  }


  return parsed;
}


// ============================================================================
// HEADER COPY
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


  if (
    value !== null
  ) {

    target.set(
      name,
      value
    );
  }
}


// ============================================================================
// JSON
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

      status:
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


function jsonError(

  message,

  status = 500
) {

  return jsonResponse(

    {

      ok:
        false,

      error:
        message,
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

    "Range, Accept, Content-Type"
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

      headers:
        headers,
    }
  );
}
