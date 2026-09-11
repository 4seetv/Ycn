// ============================================================================
// YCN HIGH-SCALE LIVE HLS GATEWAY
// Cloudflare Worker - SINGLE FILE
//
// VERSION: 6.1 STABILITY EDITION
//
// Main fixes over v6.0:
// - Normalize disguised MPEG-TS segments (.pdf / .js / .ts) to video/mp2t
// - Always advertise Accept-Ranges: bytes on media responses
// - Preserve correct 206 / Content-Range / Content-Length semantics
// - Normalize cached segment responses before returning to clients
// - Add diagnostic headers
// - Keep timeline lock / segment cache / request coalescing / retry logic
// ============================================================================


// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  API_BASE: "https://def.ycnapi.com/api",

  STATIC_KEY: "c!xZj+N9&G@Ev@vw",

  API_UA: "okhttp/4.12.0",

  DEFAULT_REFERER: "https://x.com/",

  DEFAULT_PLAYER_UA:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/139.0.0.0 Safari/537.36",

  DEFAULT_CATEGORY: 4,

  LIVE_MANIFEST_TTL: 1,
  PLAYBACK_TTL: 45,
  CATEGORY_TTL: 300,
  SEGMENT_CACHE_TTL: 180,
  GENERIC_RESOURCE_TTL: 15,
  LOCK_TTL: 21600,

  API_TIMEOUT_MS: 7000,
  MANIFEST_TIMEOUT_MS: 5000,
  SEGMENT_TIMEOUT_MS: 9000,
  GENERIC_TIMEOUT_MS: 9000,

  MANIFEST_ATTEMPTS: 4,
  INITIAL_PROFILE_SAMPLES: 4,
  SEGMENT_ATTEMPTS: 3,
  ALTERNATIVE_LOOKUPS: 2,

  TOKEN_REFRESH_MARGIN: 120,

  CORS: "*",
};


// ============================================================================
// L1 / INFLIGHT
// ============================================================================

const L1_MANIFEST = new Map();
const L1_PLAYBACK = new Map();
const INFLIGHT = new Map();


// ============================================================================
// ENTRY
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return cors(
          new Response(null, {
            status: 204,
          })
        );
      }

      if (
        request.method !== "GET" &&
        request.method !== "HEAD"
      ) {
        return cors(
          errorJson("Method not allowed", 405)
        );
      }

      const url = new URL(request.url);

      const path = url.pathname
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");

      if (!path) {
        return cors(
          json({
            ok: true,
            service: "YCN High Scale Gateway",
            version: "6.1",
            mode:
              "timeline-lock + shared-manifest + normalized-segment-cache",
            routes: {
              categories: "/categories",
              category: "/category/4",
              numeric: "/1",
              channel: "/c/1424",
              live: "/live/1424.m3u8",
            },
          })
        );
      }

      if (path === "categories") {
        const categories = await getCategories();

        return cors(
          json({
            ok: true,
            count: categories.length,
            categories,
          })
        );
      }

      if (path.startsWith("category/")) {
        const categoryId = path.substring(
          "category/".length
        );

        const channels =
          await getCategoryChannels(categoryId);

        return cors(
          json({
            ok: true,
            category_id: categoryId,
            count: channels.length,
            channels: channels.map(
              (channel, index) => ({
                number: index + 1,
                direct: `/c/${channel.id}`,
                live: `/live/${channel.id}.m3u8`,
                ...channel,
              })
            ),
          })
        );
      }

      if (path.startsWith("c/")) {
        let channelId = path.substring(2);

        channelId = channelId.replace(
          /\.m3u8$/i,
          ""
        );

        return Response.redirect(
          `${url.origin}/live/${encodeURIComponent(
            channelId
          )}.m3u8`,
          302
        );
      }

      if (path.startsWith("live/")) {
        let channelId = path.substring(
          "live/".length
        );

        channelId = channelId.replace(
          /\.m3u8$/i,
          ""
        );

        if (!channelId) {
          return cors(
            errorJson(
              "Missing channel ID",
              400
            )
          );
        }

        return await liveRoute(
          request,
          channelId
        );
      }

      if (path === "_r") {
        return await resourceRoute(request);
      }

      if (/^\d+$/.test(path)) {
        const number = Number(path);

        const channels =
          await getCategoryChannels(
            CONFIG.DEFAULT_CATEGORY
          );

        if (
          number < 1 ||
          number > channels.length
        ) {
          return cors(
            errorJson(
              "Invalid channel number",
              404
            )
          );
        }

        const channel =
          channels[number - 1];

        return Response.redirect(
          `${url.origin}/live/${encodeURIComponent(
            channel.id
          )}.m3u8`,
          302
        );
      }

      return cors(
        errorJson("Route not found", 404)
      );
    } catch (error) {
      console.log(
        "WORKER ERROR:",
        error?.message || String(error)
      );

      return cors(
        errorJson(
          error?.message || String(error),
          500
        )
      );
    }
  },
};


// ============================================================================
// LIVE
// ============================================================================

async function liveRoute(
  request,
  channelId
) {
  const item =
    await getSharedManifest(channelId);

  const origin = new URL(
    request.url
  ).origin;

  const rewritten =
    await rewriteManifest(
      item.text,
      item.finalUrl,
      origin,
      channelId,
      item.profile
    );

  const headers =
    playlistHeaders();

  headers.set(
    "X-YCN-Version",
    "6.1"
  );

  headers.set(
    "X-YCN-Profile",
    item.profile
  );

  headers.set(
    "X-YCN-Sequence",
    String(item.sequence)
  );

  headers.set(
    "X-YCN-Shared",
    "1"
  );

  if (request.method === "HEAD") {
    return cors(
      new Response(null, {
        status: 200,
        headers,
      })
    );
  }

  return cors(
    new Response(rewritten, {
      status: 200,
      headers,
    })
  );
}


// ============================================================================
// SHARED MANIFEST
// ============================================================================

async function getSharedManifest(
  channelId,
  force = false
) {
  const now = Date.now();

  if (!force) {
    const l1 =
      L1_MANIFEST.get(channelId);

    if (
      l1 &&
      l1.expires > now
    ) {
      return l1.value;
    }
  }

  const cacheKey =
    internalRequest(
      `manifest/${channelId}`
    );

  if (!force) {
    try {
      const cached =
        await caches.default.match(
          cacheKey
        );

      if (cached) {
        const value =
          await cached.json();

        L1_MANIFEST.set(
          channelId,
          {
            expires: now + 900,
            value,
          }
        );

        return value;
      }
    } catch {}
  }

  return await dedupe(
    `manifest:${channelId}`,
    async () => {
      if (!force) {
        try {
          const again =
            await caches.default.match(
              cacheKey
            );

          if (again) {
            return await again.json();
          }
        } catch {}
      }

      const value =
        await buildLockedManifest(
          channelId
        );

      L1_MANIFEST.set(
        channelId,
        {
          expires:
            Date.now() + 900,
          value,
        }
      );

      try {
        await putJsonCache(
          cacheKey,
          value,
          CONFIG.LIVE_MANIFEST_TTL
        );
      } catch {}

      return value;
    }
  );
}


// ============================================================================
// LOCKED MANIFEST
// ============================================================================

async function buildLockedManifest(
  channelId
) {
  let playback =
    await getPlaybackInfo(channelId);

  let lock =
    await getTimelineLock(channelId);

  if (!lock) {
    const samples = [];

    for (
      let i = 0;
      i <
      CONFIG.INITIAL_PROFILE_SAMPLES;
      i++
    ) {
      try {
        const candidate =
          await fetchManifestCandidate(
            playback
          );

        samples.push(candidate);
      } catch {}
    }

    if (!samples.length) {
      playback =
        await getPlaybackInfo(
          channelId,
          true
        );

      samples.push(
        await fetchManifestCandidate(
          playback
        )
      );
    }

    const selected =
      chooseProfile(samples);

    lock = {
      channelId:
        String(channelId),

      profile:
        selected.profile,

      lastSequence:
        selected.sequence,

      lastText:
        selected.text,

      lastUrl:
        selected.finalUrl,

      lastGoodAt:
        Date.now(),
    };

    await saveTimelineLock(
      channelId,
      lock
    );

    return selected;
  }

  if (
    tokenNearExpiry(
      playback.url
    )
  ) {
    playback =
      await getPlaybackInfo(
        channelId,
        true
      );
  }

  let best = null;

  for (
    let attempt = 0;
    attempt <
    CONFIG.MANIFEST_ATTEMPTS;
    attempt++
  ) {
    try {
      const candidate =
        await fetchManifestCandidate(
          playback
        );

      if (
        candidate.profile !==
        lock.profile
      ) {
        continue;
      }

      if (
        candidate.sequence <
        lock.lastSequence
      ) {
        continue;
      }

      if (
        !best ||
        candidate.sequence >
          best.sequence
      ) {
        best = candidate;
      }
    } catch {}
  }

  if (!best) {
    try {
      playback =
        await getPlaybackInfo(
          channelId,
          true
        );

      for (
        let attempt = 0;
        attempt < 4;
        attempt++
      ) {
        try {
          const candidate =
            await fetchManifestCandidate(
              playback
            );

          if (
            candidate.profile ===
              lock.profile &&
            candidate.sequence >=
              lock.lastSequence
          ) {
            best = candidate;
            break;
          }
        } catch {}
      }
    } catch {}
  }

  if (
    !best &&
    lock.lastText
  ) {
    return {
      text:
        lock.lastText,

      finalUrl:
        lock.lastUrl,

      sequence:
        lock.lastSequence,

      targetDuration:
        getTargetDuration(
          lock.lastText
        ),

      profile:
        lock.profile,
    };
  }

  if (!best) {
    throw new Error(
      "Locked HLS timeline unavailable"
    );
  }

  lock.lastSequence =
    best.sequence;

  lock.lastText =
    best.text;

  lock.lastUrl =
    best.finalUrl;

  lock.lastGoodAt =
    Date.now();

  await saveTimelineLock(
    channelId,
    lock
  );

  return best;
}


// ============================================================================
// FETCH MANIFEST
// ============================================================================

async function fetchManifestCandidate(
  playback
) {
  const headers =
    new Headers();

  headers.set(
    "Accept",
    "*/*"
  );

  headers.set(
    "Cache-Control",
    "no-cache"
  );

  headers.set(
    "Pragma",
    "no-cache"
  );

  if (playback.referer) {
    headers.set(
      "Referer",
      playback.referer
    );
  }

  if (playback.userAgent) {
    headers.set(
      "User-Agent",
      playback.userAgent
    );
  }

  const response =
    await timedFetch(
      playback.url,
      {
        method: "GET",
        headers,
        redirect: "follow",
      },
      CONFIG.MANIFEST_TIMEOUT_MS
    );

  if (!response.ok) {
    throw new Error(
      `Manifest HTTP ${response.status}`
    );
  }

  const text =
    await response.text();

  if (
    !text
      .trimStart()
      .startsWith("#EXTM3U")
  ) {
    throw new Error(
      "Not an HLS playlist"
    );
  }

  const finalUrl =
    response.url ||
    playback.url;

  const sequence =
    getMediaSequence(text);

  const targetDuration =
    getTargetDuration(text);

  const family =
    detectResourceFamily(
      text,
      finalUrl
    );

  return {
    text,
    finalUrl,
    sequence,
    targetDuration,
    profile:
      `${targetDuration}|${family}`,
  };
}


// ============================================================================
// PROFILE
// ============================================================================

function chooseProfile(samples) {
  const groups = new Map();

  for (const sample of samples) {
    if (
      !groups.has(
        sample.profile
      )
    ) {
      groups.set(
        sample.profile,
        []
      );
    }

    groups
      .get(sample.profile)
      .push(sample);
  }

  let winner = null;

  for (
    const group
    of groups.values()
  ) {
    group.sort(
      (a, b) =>
        b.sequence -
        a.sequence
    );

    if (
      !winner ||
      group.length >
        winner.length
    ) {
      winner = group;
      continue;
    }

    if (
      group.length ===
      winner.length
    ) {
      const a =
        group[0]
          .targetDuration ||
        999;

      const b =
        winner[0]
          .targetDuration ||
        999;

      if (a < b) {
        winner = group;
      }
    }
  }

  return winner[0];
}


// ============================================================================
// RESOURCE ROUTE
// ============================================================================

async function resourceRoute(
  request
) {
  const workerUrl =
    new URL(request.url);

  const upstreamUrl =
    workerUrl.searchParams.get(
      "u"
    );

  const channelId =
    workerUrl.searchParams.get(
      "cid"
    );

  const profile =
    workerUrl.searchParams.get(
      "p"
    ) || "default";

  if (
    !upstreamUrl ||
    !channelId
  ) {
    return cors(
      errorJson(
        "Invalid resource request",
        400
      )
    );
  }

  validateHttpUrl(
    upstreamUrl
  );

  const playback =
    await getPlaybackInfo(
      channelId
    );

  if (
    isLikelyMediaSegment(
      upstreamUrl
    )
  ) {
    return await serveMediaSegment(
      request,
      channelId,
      profile,
      upstreamUrl,
      playback
    );
  }

  return await serveGenericResource(
    request,
    channelId,
    profile,
    upstreamUrl,
    playback
  );
}


// ============================================================================
// MEDIA SEGMENT
// ============================================================================

async function serveMediaSegment(
  request,
  channelId,
  profile,
  upstreamUrl,
  playback
) {
  const canonical =
    canonicalMediaIdentity(
      upstreamUrl
    );

  const cacheKey =
    internalRequest(
      `segment/${encodeURIComponent(
        channelId
      )}/` +
        `${encodeURIComponent(
          profile
        )}/` +
        encodeURIComponent(
          canonical
        )
    );

  const hit =
    await matchWithRange(
      cacheKey,
      request
    );

  if (hit) {
    return normalizedMediaResponse(
      request,
      hit,
      upstreamUrl,
      "HIT"
    );
  }

  await dedupe(
    `seg:${channelId}:${profile}:${canonical}`,
    async () => {
      const secondCheck =
        await caches.default.match(
          cacheKey
        );

      if (secondCheck) {
        return true;
      }

      const result =
        await fetchSegmentWithRecovery(
          channelId,
          profile,
          upstreamUrl,
          playback
        );

      if (!result) {
        return false;
      }

      const cacheable =
        normalizeForCache(
          result.response
        );

      if (!cacheable) {
        return false;
      }

      const headers =
        new Headers(
          cacheable.headers
        );

      headers.delete(
        "Set-Cookie"
      );

      headers.delete(
        "Content-Range"
      );

      if (
        headers.get("Vary") ===
        "*"
      ) {
        headers.delete("Vary");
      }

      const mediaType =
        detectContentType(
          result.finalUrl,
          headers.get(
            "Content-Type"
          ) || ""
        );

      headers.set(
        "Content-Type",
        mediaType
      );

      headers.set(
        "Accept-Ranges",
        "bytes"
      );

      headers.set(
        "Cache-Control",
        `public, max-age=${CONFIG.SEGMENT_CACHE_TTL}`
      );

      headers.set(
        "X-YCN-Origin-Host",
        safeHost(
          result.finalUrl
        )
      );

      headers.set(
        "X-YCN-Segment-Type",
        segmentTypeLabel(
          result.finalUrl
        )
      );

      const stored =
        new Response(
          cacheable.body,
          {
            status: 200,
            headers,
          }
        );

      try {
        await caches.default.put(
          cacheKey,
          stored
        );

        return true;
      } catch (error) {
        console.log(
          "SEGMENT CACHE PUT FAILED:",
          error?.message ||
            String(error)
        );

        return false;
      }
    }
  );

  const after =
    await matchWithRange(
      cacheKey,
      request
    );

  if (after) {
    return normalizedMediaResponse(
      request,
      after,
      upstreamUrl,
      "MISS-FILLED"
    );
  }

  const direct =
    await fetchSegmentWithRecovery(
      channelId,
      profile,
      upstreamUrl,
      playback
    );

  if (!direct) {
    return cors(
      new Response(
        "Upstream segment unavailable",
        {
          status: 504,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8",

            "Cache-Control":
              "no-store",

            "X-YCN-Cache":
              "FAIL",
          },
        }
      )
    );
  }

  return normalizedMediaResponse(
    request,
    direct.response,
    direct.finalUrl,
    "BYPASS"
  );
}


// ============================================================================
// NORMALIZED MEDIA RESPONSE
// ============================================================================

function normalizedMediaResponse(
  request,
  response,
  sourceUrl,
  cacheStatus
) {
  const headers =
    new Headers(
      response.headers
    );

  const originalType =
    headers.get(
      "Content-Type"
    ) || "";

  const normalizedType =
    detectContentType(
      sourceUrl,
      originalType
    );

  headers.set(
    "Content-Type",
    normalizedType
  );

  headers.set(
    "Accept-Ranges",
    "bytes"
  );

  headers.set(
    "X-YCN-Version",
    "6.1"
  );

  headers.set(
    "X-YCN-Cache",
    cacheStatus
  );

  headers.set(
    "X-YCN-Original-Type",
    originalType || "-"
  );

  headers.set(
    "X-YCN-Segment-Type",
    segmentTypeLabel(
      sourceUrl
    )
  );

  headers.set(
    "Access-Control-Allow-Origin",
    CONFIG.CORS
  );

  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, " +
      "X-YCN-Version, X-YCN-Cache, X-YCN-Original-Type, X-YCN-Segment-Type"
  );

  if (
    response.status === 206
  ) {
    const contentRange =
      headers.get(
        "Content-Range"
      );

    if (!contentRange) {
      console.log(
        "WARNING: 206 without Content-Range"
      );
    }
  }

  return new Response(
    request.method === "HEAD"
      ? null
      : response.body,
    {
      status:
        response.status,

      statusText:
        response.statusText,

      headers,
    }
  );
}


// ============================================================================
// SEGMENT RECOVERY
// ============================================================================

async function fetchSegmentWithRecovery(
  channelId,
  profile,
  originalUrl,
  playback
) {
  let currentUrl =
    originalUrl;

  let currentPlayback =
    playback;

  for (
    let attempt = 0;
    attempt <
    CONFIG.SEGMENT_ATTEMPTS;
    attempt++
  ) {
    try {
      const response =
        await timedFetch(
          currentUrl,
          {
            method: "GET",

            headers:
              originHeaders(
                currentPlayback,
                false
              ),

            redirect:
              "follow",
          },
          CONFIG.SEGMENT_TIMEOUT_MS
        );

      if (response.ok) {
        return {
          response,
          finalUrl:
            response.url ||
            currentUrl,
        };
      }

      try {
        response.body?.cancel();
      } catch {}
    } catch {}

    const alternative =
      await findAlternativeResource(
        channelId,
        profile,
        currentUrl
      );

    if (
      alternative &&
      alternative !==
        currentUrl
    ) {
      currentUrl =
        alternative;

      continue;
    }

    try {
      currentPlayback =
        await getPlaybackInfo(
          channelId,
          true
        );
    } catch {}
  }

  return null;
}


// ============================================================================
// ALTERNATIVE RESOURCE
// ============================================================================

async function findAlternativeResource(
  channelId,
  profile,
  failedUrl
) {
  const wanted =
    canonicalMediaIdentity(
      failedUrl
    );

  for (
    let attempt = 0;
    attempt <
    CONFIG.ALTERNATIVE_LOOKUPS;
    attempt++
  ) {
    try {
      const manifest =
        await getSharedManifest(
          channelId,
          true
        );

      if (
        manifest.profile !==
        profile
      ) {
        continue;
      }

      const resources =
        extractResources(
          manifest.text,
          manifest.finalUrl
        );

      for (const url of resources) {
        if (
          canonicalMediaIdentity(
            url
          ) === wanted &&
          url !== failedUrl
        ) {
          return url;
        }
      }
    } catch {}
  }

  return null;
}


// ============================================================================
// GENERIC RESOURCE
// ============================================================================

async function serveGenericResource(
  request,
  channelId,
  profile,
  upstreamUrl,
  playback
) {
  const key =
    internalRequest(
      `generic/${encodeURIComponent(
        channelId
      )}/` +
        encodeURIComponent(
          upstreamUrl
        )
    );

  const cached =
    await matchWithRange(
      key,
      request
    );

  if (cached) {
    const type =
      cached.headers.get(
        "Content-Type"
      ) || "";

    if (
      isManifestType(
        upstreamUrl,
        type
      )
    ) {
      const text =
        await cached.text();

      const rewritten =
        await rewriteManifest(
          text,
          upstreamUrl,
          new URL(
            request.url
          ).origin,
          channelId,
          profile
        );

      return cors(
        new Response(
          rewritten,
          {
            status: 200,
            headers:
              playlistHeaders(),
          }
        )
      );
    }

    return normalizedMediaResponse(
      request,
      cached,
      upstreamUrl,
      "GENERIC-HIT"
    );
  }

  let response;

  try {
    response =
      await timedFetch(
        upstreamUrl,
        {
          method: "GET",

          headers:
            originHeaders(
              playback,
              false
            ),

          redirect:
            "follow",
        },
        CONFIG.GENERIC_TIMEOUT_MS
      );
  } catch {
    return cors(
      new Response(
        "Upstream timeout",
        {
          status: 504,
        }
      )
    );
  }

  if (!response.ok) {
    return cors(
      new Response(
        `Upstream HTTP ${response.status}`,
        {
          status:
            response.status,
        }
      )
    );
  }

  const finalUrl =
    response.url ||
    upstreamUrl;

  const contentType =
    response.headers.get(
      "Content-Type"
    ) || "";

  if (
    isManifestType(
      finalUrl,
      contentType
    )
  ) {
    const text =
      await response.text();

    if (
      text
        .trimStart()
        .startsWith(
          "#EXTM3U"
        )
    ) {
      const rewritten =
        await rewriteManifest(
          text,
          finalUrl,
          new URL(
            request.url
          ).origin,
          channelId,
          profile
        );

      return cors(
        new Response(
          request.method ===
          "HEAD"
            ? null
            : rewritten,
          {
            status: 200,
            headers:
              playlistHeaders(),
          }
        )
      );
    }
  }

  const cacheable =
    normalizeForCache(
      response
    );

  if (cacheable) {
    const headers =
      new Headers(
        cacheable.headers
      );

    headers.delete(
      "Set-Cookie"
    );

    headers.delete(
      "Content-Range"
    );

    if (
      headers.get("Vary") ===
      "*"
    ) {
      headers.delete("Vary");
    }

    const normalizedType =
      detectContentType(
        finalUrl,
        headers.get(
          "Content-Type"
        ) || ""
      );

    headers.set(
      "Content-Type",
      normalizedType
    );

    headers.set(
      "Accept-Ranges",
      "bytes"
    );

    headers.set(
      "Cache-Control",
      `public, max-age=${CONFIG.GENERIC_RESOURCE_TTL}`
    );

    try {
      await caches.default.put(
        key,
        new Response(
          cacheable.body,
          {
            status: 200,
            headers,
          }
        )
      );

      const stored =
        await matchWithRange(
          key,
          request
        );

      if (stored) {
        return normalizedMediaResponse(
          request,
          stored,
          finalUrl,
          "GENERIC-FILLED"
        );
      }
    } catch {}
  }

  return normalizedMediaResponse(
    request,
    response,
    finalUrl,
    "GENERIC-BYPASS"
  );
}


// ============================================================================
// CACHE NORMALIZATION
// ============================================================================

function normalizeForCache(
  response
) {
  if (
    response.status === 200
  ) {
    return new Response(
      response.body,
      {
        status: 200,
        headers:
          new Headers(
            response.headers
          ),
      }
    );
  }

  if (
    response.status !== 206
  ) {
    return null;
  }

  const contentRange =
    response.headers.get(
      "Content-Range"
    );

  if (!contentRange) {
    return null;
  }

  const match =
    contentRange.match(
      /^bytes\s+0-(\d+)\/(\d+)$/i
    );

  if (!match) {
    return null;
  }

  const end =
    Number(match[1]);

  const total =
    Number(match[2]);

  if (
    !Number.isFinite(end) ||
    !Number.isFinite(total)
  ) {
    return null;
  }

  if (
    end + 1 !== total
  ) {
    return null;
  }

  const headers =
    new Headers(
      response.headers
    );

  headers.delete(
    "Content-Range"
  );

  headers.set(
    "Content-Length",
    String(total)
  );

  headers.set(
    "Accept-Ranges",
    "bytes"
  );

  return new Response(
    response.body,
    {
      status: 200,
      headers,
    }
  );
}


// ============================================================================
// RANGE CACHE MATCH
// ============================================================================

async function matchWithRange(
  key,
  clientRequest
) {
  try {
    const range =
      clientRequest.headers.get(
        "Range"
      );

    if (!range) {
      return await caches.default.match(
        key
      );
    }

    const rangeRequest =
      new Request(
        key.url,
        {
          method: "GET",
          headers: {
            Range: range,
          },
        }
      );

    return await caches.default.match(
      rangeRequest
    );
  } catch {
    return null;
  }
}


// ============================================================================
// PLAYBACK INFO
// ============================================================================

async function getPlaybackInfo(
  channelId,
  force = false
) {
  const now = Date.now();

  if (!force) {
    const l1 =
      L1_PLAYBACK.get(
        channelId
      );

    if (
      l1 &&
      l1.expires > now
    ) {
      return l1.value;
    }
  }

  const key =
    internalRequest(
      `playback/${channelId}`
    );

  if (!force) {
    try {
      const cached =
        await caches.default.match(
          key
        );

      if (cached) {
        const value =
          await cached.json();

        L1_PLAYBACK.set(
          channelId,
          {
            expires:
              now + 15000,
            value,
          }
        );

        return value;
      }
    } catch {}
  }

  return await dedupe(
    `playback:${channelId}`,
    async () => {
      const payload =
        normalize(
          await apiFetch(
            `channel/${encodeURIComponent(
              channelId
            )}`
          )
        );

      let data = payload;

      if (
        Array.isArray(data)
      ) {
        data =
          data.find(
            (item) =>
              item &&
              (
                item.url ||
                item.stream_url ||
                item.link
              )
          ) ||
          data[0];
      }

      if (
        !data ||
        typeof data !==
          "object"
      ) {
        throw new Error(
          "Invalid channel playback response"
        );
      }

      const streamUrl =
        data.url ||
        data.stream_url ||
        data.link;

      if (!streamUrl) {
        throw new Error(
          "Missing stream URL"
        );
      }

      validateHttpUrl(
        streamUrl
      );

      const value = {
        channelId:
          String(channelId),

        url:
          streamUrl,

        referer:
          data.referer ||
          data.headers?.Referer ||
          data.headers?.referer ||
          CONFIG.DEFAULT_REFERER,

        userAgent:
          data.user_agent ||
          data.userAgent ||
          data.headers?.["User-Agent"] ||
          data.headers?.["user-agent"] ||
          CONFIG.DEFAULT_PLAYER_UA,
      };

      L1_PLAYBACK.set(
        channelId,
        {
          expires:
            Date.now() + 15000,
          value,
        }
      );

      try {
        await putJsonCache(
          key,
          value,
          CONFIG.PLAYBACK_TTL
        );
      } catch {}

      return value;
    }
  );
}


// ============================================================================
// LOCK CACHE
// ============================================================================

async function getTimelineLock(
  channelId
) {
  const key =
    internalRequest(
      `lock/${channelId}`
    );

  try {
    const cached =
      await caches.default.match(
        key
      );

    if (!cached) {
      return null;
    }

    return await cached.json();
  } catch {
    return null;
  }
}


async function saveTimelineLock(
  channelId,
  state
) {
  const key =
    internalRequest(
      `lock/${channelId}`
    );

  try {
    await putJsonCache(
      key,
      state,
      CONFIG.LOCK_TTL
    );
  } catch {}
}


// ============================================================================
// CATEGORIES
// ============================================================================

async function getCategories() {
  const key =
    internalRequest(
      "categories"
    );

  try {
    const cached =
      await caches.default.match(
        key
      );

    if (cached) {
      return await cached.json();
    }
  } catch {}

  const data =
    normalize(
      await apiFetch(
        "categories"
      )
    );

  if (
    !Array.isArray(data)
  ) {
    throw new Error(
      "Invalid categories response"
    );
  }

  await putJsonCache(
    key,
    data,
    CONFIG.CATEGORY_TTL
  );

  return data;
}


async function getCategoryChannels(
  categoryId
) {
  const key =
    internalRequest(
      `category/${categoryId}`
    );

  try {
    const cached =
      await caches.default.match(
        key
      );

    if (cached) {
      return await cached.json();
    }
  } catch {}

  const data =
    normalize(
      await apiFetch(
        `categories/${encodeURIComponent(
          categoryId
        )}/channels`
      )
    );

  if (
    !Array.isArray(data)
  ) {
    throw new Error(
      "Invalid channels response"
    );
  }

  await putJsonCache(
    key,
    data,
    CONFIG.CATEGORY_TTL
  );

  return data;
}


// ============================================================================
// API FETCH
// ============================================================================

async function apiFetch(
  endpoint
) {
  const url =
    `${CONFIG.API_BASE}/` +
    String(endpoint)
      .replace(/^\/+/, "");

  const headers =
    new Headers();

  headers.set(
    "User-Agent",
    CONFIG.API_UA
  );

  headers.set(
    "Accept",
    "application/json"
  );

  headers.set(
    "Cache-Control",
    "no-cache"
  );

  const response =
    await timedFetch(
      url,
      {
        method: "GET",
        headers,
        redirect: "follow",
      },
      CONFIG.API_TIMEOUT_MS
    );

  if (!response.ok) {
    throw new Error(
      `API HTTP ${response.status}`
    );
  }

  const t =
    response.headers.get(
      "t"
    );

  if (!t) {
    throw new Error(
      "Missing API t header"
    );
  }

  const encrypted =
    (
      await response.text()
    ).trim();

  return decryptPayload(
    encrypted,
    t
  );
}


// ============================================================================
// DECRYPT
// ============================================================================

function decryptPayload(
  encrypted,
  t
) {
  let binary;

  try {
    binary =
      atob(encrypted);
  } catch {
    throw new Error(
      "Invalid Base64 API response"
    );
  }

  const input =
    new Uint8Array(
      binary.length
    );

  for (
    let i = 0;
    i <
    binary.length;
    i++
  ) {
    input[i] =
      binary.charCodeAt(i);
  }

  const key =
    new TextEncoder().encode(
      CONFIG.STATIC_KEY +
        String(t)
    );

  const output =
    new Uint8Array(
      input.length
    );

  for (
    let i = 0;
    i <
    input.length;
    i++
  ) {
    output[i] =
      input[i] ^
      key[
        i %
          key.length
      ];
  }

  const text =
    new TextDecoder(
      "utf-8"
    ).decode(output);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "Invalid decrypted JSON"
    );
  }
}


// ============================================================================
// NORMALIZE
// ============================================================================

function normalize(payload) {
  if (
    payload &&
    typeof payload ===
      "object" &&
    Object.prototype
      .hasOwnProperty.call(
        payload,
        "data"
      )
  ) {
    return payload.data;
  }

  return payload;
}


// ============================================================================
// MANIFEST REWRITE
// ============================================================================

async function rewriteManifest(
  manifest,
  sourceUrl,
  workerOrigin,
  channelId,
  profile
) {
  const base =
    new URL(sourceUrl);

  const lines =
    manifest.split(/\r?\n/);

  const output = [];

  for (
    const original
    of lines
  ) {
    const line =
      original.trim();

    if (!line) {
      output.push(original);
      continue;
    }

    if (
      line.startsWith("#")
    ) {
      const rewritten =
        original.replace(
          /URI=(["'])(.*?)\1/gi,
          (
            full,
            quote,
            value
          ) => {
            try {
              const absolute =
                resolveChildUrl(
                  value,
                  base
                );

              const proxied =
                buildResourceUrl(
                  workerOrigin,
                  channelId,
                  profile,
                  absolute
                );

              return (
                `URI=${quote}` +
                proxied +
                quote
              );
            } catch {
              return full;
            }
          }
        );

      output.push(rewritten);
      continue;
    }

    try {
      const absolute =
        resolveChildUrl(
          line,
          base
        );

      output.push(
        buildResourceUrl(
          workerOrigin,
          channelId,
          profile,
          absolute
        )
      );
    } catch {
      output.push(original);
    }
  }

  return output.join("\n");
}


// ============================================================================
// RESOURCE URL
// ============================================================================

function buildResourceUrl(
  origin,
  channelId,
  profile,
  upstreamUrl
) {
  const params =
    new URLSearchParams();

  params.set(
    "cid",
    channelId
  );

  params.set(
    "p",
    profile
  );

  params.set(
    "u",
    upstreamUrl
  );

  return (
    `${origin}/_r?` +
    params.toString()
  );
}


// ============================================================================
// CHILD URL
// ============================================================================

function resolveChildUrl(
  value,
  parent
) {
  const target =
    new URL(
      value,
      parent
    );

  const authKeys = [
    "t",
    "e",
    "token",
    "auth",
    "expires",
    "signature",
    "sig",
  ];

  for (
    const key
    of authKeys
  ) {
    if (
      !target.searchParams.has(
        key
      ) &&
      parent.searchParams.has(
        key
      )
    ) {
      target.searchParams.set(
        key,
        parent.searchParams.get(
          key
        )
      );
    }
  }

  return target.href;
}


// ============================================================================
// EXTRACT RESOURCES
// ============================================================================

function extractResources(
  manifest,
  sourceUrl
) {
  const base =
    new URL(sourceUrl);

  const output = [];

  for (
    const raw
    of manifest.split(/\r?\n/)
  ) {
    const line =
      raw.trim();

    if (!line) {
      continue;
    }

    if (
      !line.startsWith("#")
    ) {
      try {
        output.push(
          resolveChildUrl(
            line,
            base
          )
        );
      } catch {}
    }

    const regex =
      /URI=(["'])(.*?)\1/gi;

    let match;

    while (
      (match =
        regex.exec(raw)) !==
      null
    ) {
      try {
        output.push(
          resolveChildUrl(
            match[2],
            base
          )
        );
      } catch {}
    }
  }

  return output;
}


// ============================================================================
// CANONICAL IDENTITY
// ============================================================================

function canonicalMediaIdentity(
  value
) {
  try {
    const url =
      new URL(value);

    const params =
      new URLSearchParams(
        url.search
      );

    const volatile = [
      "t",
      "e",
      "token",
      "auth",
      "expires",
      "signature",
      "sig",
    ];

    for (
      const key
      of volatile
    ) {
      params.delete(key);
    }

    const entries =
      [...params.entries()].sort(
        (a, b) =>
          a[0].localeCompare(
            b[0]
          )
      );

    const stable =
      new URLSearchParams(
        entries
      ).toString();

    return (
      url.pathname +
      (
        stable
          ? `?${stable}`
          : ""
      )
    );
  } catch {
    return String(value);
  }
}


// ============================================================================
// SEGMENT DETECTION
// ============================================================================

function isLikelyMediaSegment(
  value
) {
  try {
    const path =
      new URL(value)
        .pathname
        .toLowerCase();

    return (
      path.endsWith(".ts") ||
      path.endsWith(".mpegts") ||
      path.endsWith(".pdf") ||
      path.endsWith(".js") ||
      path.endsWith(".m4s") ||
      path.endsWith(".cmfv") ||
      path.endsWith(".cmfa") ||
      path.endsWith(".aac") ||
      path.endsWith(".mp4")
    );
  } catch {
    return false;
  }
}


// ============================================================================
// MEDIA TYPE LABEL
// ============================================================================

function segmentTypeLabel(
  value
) {
  try {
    const path =
      new URL(value)
        .pathname
        .toLowerCase();

    if (
      path.endsWith(".pdf") ||
      path.endsWith(".js") ||
      path.endsWith(".ts") ||
      path.endsWith(".mpegts")
    ) {
      return "mpegts";
    }

    if (
      path.endsWith(".m4s") ||
      path.endsWith(".cmfv") ||
      path.endsWith(".mp4")
    ) {
      return "fmp4";
    }

    if (
      path.endsWith(".cmfa")
    ) {
      return "audio-mp4";
    }

    if (
      path.endsWith(".aac")
    ) {
      return "aac";
    }
  } catch {}

  return "binary";
}


// ============================================================================
// TIMELINE
// ============================================================================

function getMediaSequence(
  manifest
) {
  const match =
    manifest.match(
      /#EXT-X-MEDIA-SEQUENCE:(\d+)/i
    );

  return match
    ? Number(match[1])
    : 0;
}


function getTargetDuration(
  manifest
) {
  const match =
    manifest.match(
      /#EXT-X-TARGETDURATION:(\d+)/i
    );

  return match
    ? Number(match[1])
    : 0;
}


function detectResourceFamily(
  manifest,
  sourceUrl
) {
  const base =
    new URL(sourceUrl);

  for (
    const raw
    of manifest.split(/\r?\n/)
  ) {
    const line =
      raw.trim();

    if (
      !line ||
      line.startsWith("#")
    ) {
      continue;
    }

    try {
      const pathname =
        new URL(
          line,
          base
        )
          .pathname
          .toLowerCase();

      const match =
        pathname.match(
          /\.([a-z0-9]+)$/
        );

      if (match) {
        return match[1];
      }
    } catch {}
  }

  return "unknown";
}


// ============================================================================
// TOKEN
// ============================================================================

function tokenNearExpiry(
  value
) {
  try {
    const url =
      new URL(value);

    const expiry =
      Number(
        url.searchParams.get(
          "e"
        )
      );

    if (
      !Number.isFinite(
        expiry
      ) ||
      expiry <= 0
    ) {
      return false;
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    return (
      expiry - now <=
      CONFIG.TOKEN_REFRESH_MARGIN
    );
  } catch {
    return false;
  }
}


// ============================================================================
// ORIGIN HEADERS
// ============================================================================

function originHeaders(
  playback,
  includeRange,
  request = null
) {
  const headers =
    new Headers();

  headers.set(
    "Accept",
    "*/*"
  );

  if (playback?.referer) {
    headers.set(
      "Referer",
      playback.referer
    );
  }

  if (playback?.userAgent) {
    headers.set(
      "User-Agent",
      playback.userAgent
    );
  }

  if (
    includeRange &&
    request
  ) {
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
  }

  return headers;
}


// ============================================================================
// FETCH TIMEOUT
// ============================================================================

async function timedFetch(
  url,
  options,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal,
      }
    );
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================================
// DEDUPE
// ============================================================================

async function dedupe(
  key,
  producer
) {
  if (
    INFLIGHT.has(key)
  ) {
    return await INFLIGHT.get(
      key
    );
  }

  const promise =
    (async () =>
      await producer())();

  INFLIGHT.set(
    key,
    promise
  );

  try {
    return await promise;
  } finally {
    INFLIGHT.delete(key);
  }
}


// ============================================================================
// CACHE KEYS
// ============================================================================

function internalRequest(path) {
  return new Request(
    `https://ycn-cache.internal/${path}`,
    {
      method: "GET",
    }
  );
}


// ============================================================================
// JSON CACHE
// ============================================================================

async function putJsonCache(
  key,
  value,
  ttl
) {
  const response =
    new Response(
      JSON.stringify(value),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json",

          "Cache-Control":
            `public, max-age=${ttl}`,
        },
      }
    );

  await caches.default.put(
    key,
    response
  );
}


// ============================================================================
// PLAYLIST HEADERS
// ============================================================================

function playlistHeaders() {
  return new Headers({
    "Content-Type":
      "application/vnd.apple.mpegurl; charset=utf-8",

    "Cache-Control":
      "no-store, no-cache, must-revalidate, max-age=0",

    Pragma: "no-cache",

    Expires: "0",

    "X-Content-Type-Options":
      "nosniff",
  });
}


// ============================================================================
// CONTENT TYPE
// ============================================================================

function detectContentType(
  value,
  upstreamType
) {
  let path = "";

  try {
    path =
      new URL(value)
        .pathname
        .toLowerCase();
  } catch {}

  if (
    path.endsWith(".m3u8")
  ) {
    return "application/vnd.apple.mpegurl";
  }

  if (
    path.endsWith(".ts") ||
    path.endsWith(".mpegts") ||
    path.endsWith(".pdf") ||
    path.endsWith(".js")
  ) {
    return "video/mp2t";
  }

  if (
    path.endsWith(".m4s") ||
    path.endsWith(".cmfv") ||
    path.endsWith(".mp4")
  ) {
    return "video/mp4";
  }

  if (
    path.endsWith(".cmfa")
  ) {
    return "audio/mp4";
  }

  if (
    path.endsWith(".aac")
  ) {
    return "audio/aac";
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
// MANIFEST TYPE
// ============================================================================

function isManifestType(
  value,
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
    return new URL(value)
      .pathname
      .toLowerCase()
      .endsWith(".m3u8");
  } catch {
    return false;
  }
}


// ============================================================================
// URL VALIDATION
// ============================================================================

function validateHttpUrl(value) {
  const url = new URL(value);

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
// HOST
// ============================================================================

function safeHost(value) {
  try {
    return new URL(value)
      .hostname;
  } catch {
    return "";
  }
}


// ============================================================================
// JSON
// ============================================================================

function json(
  value,
  status = 200
) {
  return new Response(
    JSON.stringify(
      value,
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


function errorJson(
  message,
  status = 500
) {
  return json(
    {
      ok: false,
      error: message,
      version: "6.1",
    },
    status
  );
}


// ============================================================================
// CORS
// ============================================================================

function cors(response) {
  const headers =
    new Headers(
      response.headers
    );

  headers.set(
    "Access-Control-Allow-Origin",
    CONFIG.CORS
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
    "Content-Length, Content-Range, Accept-Ranges, " +
      "X-YCN-Version, X-YCN-Profile, X-YCN-Sequence, " +
      "X-YCN-Cache, X-YCN-Original-Type, X-YCN-Segment-Type"
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
