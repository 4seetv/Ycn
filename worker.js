// ============================================================================
// YCN LIVE STREAM GATEWAY
// Cloudflare Worker - Single File
//
// VERSION 4.0
//
// IMPORTANT:
// - NO fetch() "cache" option anywhere
// - NO cf.cacheTtl
// - NO Cache API
// - Compatible with old Cloudflare Worker runtimes
//
// Features:
// - Base64 + Dynamic XOR API decoding
// - Categories
// - Channels
// - Stable /live/{id}.m3u8 URLs
// - Fresh playback URL on every playlist refresh
// - HLS master + media playlist rewriting
// - AES-128 key proxy
// - Relative URL fixing
// - t/e propagation
// - Automatic token refresh
// - Automatic retry after 401/403
// - Range requests
// - .ts / .pdf / .js disguised segments
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

  TOKEN_REFRESH_MARGIN_SECONDS:
    30,

  CORS_ORIGIN:
    "*"
};


// ============================================================================
// MAIN
// ============================================================================

export default {

  async fetch(request) {

    try {

      if (request.method === "OPTIONS") {

        return addCors(
          new Response(null, {
            status: 204
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
              "4.0",

            default_category:
              CONFIG.DEFAULT_CATEGORY_ID,

            routes: {

              categories:
                "/categories",

              category:
                "/category/4",

              channel:
                "/c/1424",

              live:
                "/live/1424.m3u8",

              numbered:
                "/1"
            }

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

      if (path.startsWith("category/")) {

        const categoryId =
          path.substring(
            "category/".length
          );


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
      // /c/1424
      // ======================================================================

      if (path.startsWith("c/")) {

        let channelId =
          path.substring(
            "c/".length
          );


        channelId =
          channelId.replace(
            /\.m3u8$/i,
            ""
          );


        if (!channelId) {

          return addCors(
            jsonError(
              "Missing channel ID",
              400
            )
          );
        }


        const destination =

          `${requestUrl.origin}/live/` +

          `${encodeURIComponent(channelId)}.m3u8`;


        return Response.redirect(
          destination,
          302
        );
      }


      // ======================================================================
      // STABLE LIVE URL
      //
      // /live/1424.m3u8
      //
      // ======================================================================

      if (path.startsWith("live/")) {

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
      // RESOURCE PROXY
      // ======================================================================

      if (path === "_resource") {

        return await proxyResource(
          request
        );
      }


      // ======================================================================
      // /1 /2 /3 ...
      // ======================================================================

      if (/^\d+$/.test(path)) {

        const number =
          Number(path);


        if (
          !Number.isInteger(number) ||
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
          channels[number - 1];


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

          `${requestUrl.origin}/live/` +

          `${encodeURIComponent(channel.id)}.m3u8`;


        return Response.redirect(
          destination,
          302
        );
      }


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
  }
};


// ============================================================================
// API FETCH
//
// IMPORTANT:
// NO "cache:" RequestInitializer option.
// ============================================================================

async function apiFetch(endpoint) {

  const cleanEndpoint =
    String(endpoint)
      .replace(/^\/+/, "");


  const url =
    `${CONFIG.API_BASE}/${cleanEndpoint}`;


  const headers =
    new Headers();


  headers.set(
    "User-Agent",
    CONFIG.API_USER_AGENT
  );


  headers.set(
    "Accept",
    CONFIG.API_ACCEPT
  );


  headers.set(
    "Cache-Control",
    "no-cache, no-store, max-age=0"
  );


  headers.set(
    "Pragma",
    "no-cache"
  );


  const response =
    await fetch(
      url,
      {
        method: "GET",
        headers: headers,
        redirect: "follow"
      }
    );


  if (!response.ok) {

    throw new Error(
      `API HTTP ${response.status}`
    );
  }


  const t =
    response.headers.get("t") ||
    response.headers.get("T") ||
    "";


  if (!t) {

    throw new Error(
      'Missing API response header "t"'
    );
  }


  const encrypted =
    (await response.text())
      .trim();


  if (!encrypted) {

    throw new Error(
      "Empty API response"
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

  let binary;


  try {

    binary =
      atob(
        encryptedBase64
      );

  }

  catch {

    throw new Error(
      "Invalid API Base64"
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


  const output =
    new Uint8Array(
      encryptedBytes.length
    );


  for (
    let i = 0;
    i < encryptedBytes.length;
    i++
  ) {

    output[i] =

      encryptedBytes[i] ^

      keyBytes[
        i % keyBytes.length
      ];
  }


  const text =
    new TextDecoder(
      "utf-8"
    ).decode(
      output
    );


  try {

    return JSON.parse(
      text
    );

  }

  catch {

    throw new Error(
      "Decrypted API JSON is invalid"
    );
  }
}


// ============================================================================
// NORMALIZE
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
// GET CATEGORIES
// ============================================================================

async function getCategories() {

  const payload =
    await apiFetch(
      "categories"
    );


  const data =
    normalizeData(
      payload
    );


  if (!Array.isArray(data)) {

    throw new Error(
      "Invalid categories response"
    );
  }


  return data;
}


// ============================================================================
// GET CATEGORY CHANNELS
// ============================================================================

async function getCategoryChannels(
  categoryId
) {

  const payload =
    await apiFetch(

      `categories/${encodeURIComponent(categoryId)}/channels`
    );


  const data =
    normalizeData(
      payload
    );


  if (!Array.isArray(data)) {

    throw new Error(
      "Invalid channels response"
    );
  }


  return data;
}


// ============================================================================
// GET STREAM
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


  if (Array.isArray(data)) {

    if (!data.length) {

      throw new Error(
        "No streams found"
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
      "Invalid channel stream response"
    );
  }


  const streamUrl =

    data.url ||

    data.stream_url ||

    data.link;


  if (!streamUrl) {

    throw new Error(
      "No stream URL"
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

    CONFIG.DEFAULT_PLAYER_UA;


  return {

    id:
      String(channelId),

    url:
      streamUrl,

    referer:
      referer,

    userAgent:
      userAgent
  };
}


// ============================================================================
// LIVE MANIFEST
// ============================================================================

async function liveManifestRoute(
  request,
  channelId
) {

  // Always fetch fresh playback information.
  const stream =
    await getChannelStream(
      channelId
    );


  return await fetchManifest(

    request,

    stream.url,

    stream.referer,

    stream.userAgent,

    channelId
  );
}


// ============================================================================
// FETCH MANIFEST
// ============================================================================

async function fetchManifest(

  request,

  manifestUrl,

  referer,

  userAgent,

  channelId
) {

  validateHttpUrl(
    manifestUrl
  );


  const requestHeaders =
    buildUpstreamHeaders(

      request,

      referer,

      userAgent
    );


  requestHeaders.set(
    "Cache-Control",
    "no-cache, no-store, max-age=0"
  );


  requestHeaders.set(
    "Pragma",
    "no-cache"
  );


  let upstream =
    await fetch(
      manifestUrl,
      {
        method: "GET",
        headers: requestHeaders,
        redirect: "follow"
      }
    );


  // Fresh channel info if manifest token itself is rejected.
  if (
    upstream.status === 401 ||
    upstream.status === 403
  ) {

    const fresh =
      await getChannelStream(
        channelId
      );


    const freshHeaders =
      buildUpstreamHeaders(

        request,

        fresh.referer,

        fresh.userAgent
      );


    freshHeaders.set(
      "Cache-Control",
      "no-cache, no-store, max-age=0"
    );


    freshHeaders.set(
      "Pragma",
      "no-cache"
    );


    upstream =
      await fetch(
        fresh.url,
        {
          method: "GET",
          headers: freshHeaders,
          redirect: "follow"
        }
      );


    manifestUrl =
      fresh.url;


    referer =
      fresh.referer;


    userAgent =
      fresh.userAgent;
  }


  if (!upstream.ok) {

    return addCors(
      jsonError(

        `Manifest upstream HTTP ${upstream.status}`,

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
        "Upstream is not an HLS manifest",
        502
      )
    );
  }


  const finalUrl =
    upstream.url ||
    manifestUrl;


  const workerUrl =
    new URL(
      request.url
    );


  const rewritten =
    rewriteManifest(

      manifest,

      finalUrl,

      workerUrl.origin,

      referer,

      userAgent,

      channelId
    );


  const responseHeaders =
    livePlaylistHeaders();


  responseHeaders.set(
    "X-YCN-Version",
    "4.0"
  );


  responseHeaders.set(
    "X-YCN-Channel",
    channelId
  );


  if (
    request.method === "HEAD"
  ) {

    return addCors(
      new Response(
        null,
        {
          status: 200,
          headers: responseHeaders
        }
      )
    );
  }


  return addCors(
    new Response(
      rewritten,
      {
        status: 200,
        headers: responseHeaders
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


  let referer =
    workerUrl.searchParams.get(
      "r"
    ) ||
    CONFIG.DEFAULT_REFERER;


  let userAgent =
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


  // ========================================================================
  // REFRESH BEFORE EXPIRATION
  // ========================================================================

  if (
    channelId &&
    shouldRefreshToken(
      upstreamUrl
    )
  ) {

    const refreshed =
      await refreshResourceContext(

        upstreamUrl,

        channelId
      );


    upstreamUrl =
      refreshed.url;


    referer =
      refreshed.referer ||
      referer;


    userAgent =
      refreshed.userAgent ||
      userAgent;
  }


  // ========================================================================
  // REQUEST
  // ========================================================================

  let upstream =
    await fetchUpstreamResource(

      request,

      upstreamUrl,

      referer,

      userAgent
    );


  // ========================================================================
  // 401 / 403 => REFRESH TOKEN AND RETRY
  // ========================================================================

  if (
    channelId &&
    (
      upstream.status === 401 ||
      upstream.status === 403
    )
  ) {

    const refreshed =
      await refreshResourceContext(

        upstreamUrl,

        channelId,

        true
      );


    upstreamUrl =
      refreshed.url;


    referer =
      refreshed.referer ||
      referer;


    userAgent =
      refreshed.userAgent ||
      userAgent;


    upstream =
      await fetchUpstreamResource(

        request,

        upstreamUrl,

        referer,

        userAgent
      );
  }


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
              "no-store"
          }
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
  // CHILD MANIFEST
  // ========================================================================

  if (
    isManifestResponse(
      finalUrl,
      contentType
    )
  ) {

    const text =
      await upstream.text();


    if (
      text
        .trimStart()
        .startsWith("#EXTM3U")
    ) {

      const rewritten =
        rewriteManifest(

          text,

          finalUrl,

          workerUrl.origin,

          referer,

          userAgent,

          channelId
        );


      const headers =
        livePlaylistHeaders();


      headers.set(
        "X-YCN-Version",
        "4.0"
      );


      return addCors(
        new Response(
          request.method === "HEAD"
            ? null
            : rewritten,
          {
            status: 200,
            headers: headers
          }
        )
      );
    }
  }


  // ========================================================================
  // BINARY SEGMENT / KEY
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


  responseHeaders.set(
    "Cache-Control",
    "no-store"
  );


  responseHeaders.set(
    "X-YCN-Version",
    "4.0"
  );


  return addCors(
    new Response(

      request.method === "HEAD"
        ? null
        : upstream.body,

      {

        status:
          upstream.status,

        headers:
          responseHeaders
      }
    )
  );
}


// ============================================================================
// FETCH SEGMENT / KEY / CHILD PLAYLIST
//
// NO cache OPTION.
// ============================================================================

async function fetchUpstreamResource(

  request,

  upstreamUrl,

  referer,

  userAgent
) {

  const headers =
    buildUpstreamHeaders(

      request,

      referer,

      userAgent
    );


  headers.set(
    "Cache-Control",
    "no-cache, no-store, max-age=0"
  );


  headers.set(
    "Pragma",
    "no-cache"
  );


  return await fetch(
    upstreamUrl,
    {
      method: "GET",
      headers: headers,
      redirect: "follow"
    }
  );
}


// ============================================================================
// TOKEN EXPIRY
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

      now +

      CONFIG
        .TOKEN_REFRESH_MARGIN_SECONDS
    );

  }

  catch {

    return false;
  }
}


// ============================================================================
// REFRESH RESOURCE TOKEN
// ============================================================================

async function refreshResourceContext(

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

      return {

        url:
          oldResourceUrl,

        referer:
          null,

        userAgent:
          null
      };
    }


    const fresh =
      await getChannelStream(
        channelId
      );


    const freshRoot =
      new URL(
        fresh.url
      );


    const target =
      new URL(
        oldResourceUrl
      );


    // ======================================================================
    // COPY ALL QUERY AUTH PARAMETERS FROM FRESH ROOT WHEN MATCHING
    // ======================================================================

    for (
      const [key, value]
      of freshRoot.searchParams.entries()
    ) {

      // Known auth / expiry values.
      if (
        key === "t" ||
        key === "e" ||
        key === "token" ||
        key === "auth" ||
        key === "expires" ||
        key === "signature" ||
        key === "sig"
      ) {

        target.searchParams.set(
          key,
          value
        );
      }
    }


    return {

      url:
        target.href,

      referer:
        fresh.referer,

      userAgent:
        fresh.userAgent
    };

  }

  catch {

    return {

      url:
        oldResourceUrl,

      referer:
        null,

      userAgent:
        null
    };
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
    // TAGS WITH URI=""
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


    // Normal HLS metadata.
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

    try {

      const absolute =
        resolveResourceUrl(

          trimmed,

          baseUrl
        );


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

    catch {

      output.push(
        originalLine
      );
    }
  }


  return output.join(
    "\n"
  );
}


// ============================================================================
// URI="..." REWRITE
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

      try {

        const absolute =
          resolveResourceUrl(

            value,

            baseUrl
          );


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

      catch {

        return full;
      }
    }
  );
}


// ============================================================================
// RESOLVE RESOURCE + INHERIT QUERY PARAMETERS
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


  // ========================================================================
  // Relative playlist resources do not automatically inherit the query
  // parameters of the parent playlist.
  //
  // Preserve authentication parameters when absent.
  // ========================================================================

  for (
    const [key, val]
    of baseUrl.searchParams.entries()
  ) {

    if (
      !target.searchParams.has(
        key
      )
    ) {

      target.searchParams.set(
        key,
        val
      );
    }
  }


  return target.href;
}


// ============================================================================
// RESOURCE WORKER URL
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


  if (referer) {

    headers.set(
      "Referer",
      referer
    );
  }


  if (userAgent) {

    headers.set(
      "User-Agent",
      userAgent
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


  return headers;
}


// ============================================================================
// PLAYLIST RESPONSE HEADERS
// ============================================================================

function livePlaylistHeaders() {

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


  headers.set(
    "X-Content-Type-Options",
    "nosniff"
  );


  return headers;
}


// ============================================================================
// CONTENT TYPE
// ============================================================================

function detectContentType(

  url,

  upstreamType
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


  if (
    pathname.endsWith(".m3u8")
  ) {

    return (
      "application/vnd.apple.mpegurl"
    );
  }


  if (
    pathname.endsWith(".ts") ||
    pathname.endsWith(".mpegts")
  ) {

    return "video/mp2t";
  }


  // Disguised transport-stream chunks.
  if (
    pathname.endsWith(".pdf") ||
    pathname.endsWith(".js")
  ) {

    return "video/mp2t";
  }


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


  if (
    upstreamType &&
    !String(upstreamType)
      .toLowerCase()
      .includes("text/html")
  ) {

    return upstreamType;
  }


  return "application/octet-stream";
}


// ============================================================================
// MANIFEST DETECTION
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
    type.includes("mpegurl") ||
    type.includes("m3u")
  ) {

    return true;
  }


  try {

    return new URL(url)
      .pathname
      .toLowerCase()
      .endsWith(".m3u8");

  }

  catch {

    return String(url)
      .toLowerCase()
      .includes(".m3u8");
  }
}


// ============================================================================
// LIST ROUTES
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
          item,
          index
        ) => ({

          number:
            index + 1,

          ...item
        })
      )
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

          live:
            `/live/${channel.id}.m3u8`,

          ...channel
        })
      )
  });
}


// ============================================================================
// VALIDATE HTTP URL
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
          "no-store"
      }
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

      version:
        "4.0"
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
    "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, X-YCN-Version, X-YCN-Channel"
  );


  return new Response(

    response.body,

    {

      status:
        response.status,

      statusText:
        response.statusText,

      headers:
        headers
    }
  );
}
