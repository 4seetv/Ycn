// ============================================================================
// YCN 24/7 HLS GATEWAY
// Cloudflare Worker - Single File
//
// VERSION 5.0 - TIMELINE LOCK
//
// Fixes:
// 1. Prevents switching between different live timelines
//    e.g. 108xx/.pdf/4s <-> 72xx/.js/6s
//
// 2. Locks one HLS profile per channel session.
//
// 3. MEDIA-SEQUENCE is prevented from moving backwards.
//
// 4. Segment timeout/failure recovery:
//    re-fetches the SAME locked playlist and searches for the same segment
//    on another upstream host.
//
// 5. Fresh API playback URL is NOT requested on every playlist reload.
//
// 6. Token refresh only near real expiration or if root playlist fails.
//
// 7. No unsupported fetch({ cache: ... }) option.
//
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

  DEFAULT_REFERER:
    "https://x.com/",

  DEFAULT_PLAYER_UA:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/139.0.0.0 Safari/537.36",

  DEFAULT_CATEGORY_ID:
    4,

  // Number of manifest samples used to avoid a rotating upstream timeline.
  MANIFEST_SAMPLES:
    3,

  // When a segment host hangs, abort it before the player buffer is exhausted.
  SEGMENT_TIMEOUT_MS:
    5500,

  MANIFEST_TIMEOUT_MS:
    6000,

  API_TIMEOUT_MS:
    7000,

  // Refresh hours-long token before it actually expires.
  TOKEN_REFRESH_MARGIN_SECONDS:
    120,

  // Session state stored at Cloudflare edge.
  SESSION_TTL_SECONDS:
    21600,

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

        return cors(
          new Response(null, {
            status: 204
          })
        );
      }


      if (
        request.method !== "GET" &&
        request.method !== "HEAD"
      ) {

        return cors(
          errorJson(
            "Method not allowed",
            405
          )
        );
      }


      const url =
        new URL(request.url);


      const path =
        url.pathname
          .replace(/^\/+/, "")
          .replace(/\/+$/, "");


      // ======================================================================
      // HOME
      // ======================================================================

      if (!path) {

        return cors(
          json({

            ok: true,

            service:
              "YCN 24/7 Timeline Lock Gateway",

            version:
              "5.0",

            routes: {

              categories:
                "/categories",

              category:
                "/category/4",

              channel:
                "/c/1424",

              live:
                "/live/1424.m3u8"
            }
          })
        );
      }


      // ======================================================================
      // CATEGORIES
      // ======================================================================

      if (path === "categories") {

        const categories =
          await getCategories();


        return cors(
          json({

            ok: true,

            count:
              categories.length,

            categories:
              categories
          })
        );
      }


      // ======================================================================
      // CATEGORY
      // ======================================================================

      if (
        path.startsWith("category/")
      ) {

        const id =
          path.substring(
            "category/".length
          );


        const channels =
          await getCategoryChannels(
            id
          );


        return cors(
          json({

            ok: true,

            category_id:
              id,

            count:
              channels.length,

            channels:
              channels.map(
                (channel, index) => ({

                  number:
                    index + 1,

                  direct:
                    `/c/${channel.id}`,

                  live:
                    `/live/${channel.id}.m3u8`,

                  ...channel
                })
              )
          })
        );
      }


      // ======================================================================
      // /c/1424
      // ======================================================================

      if (
        path.startsWith("c/")
      ) {

        let channelId =
          path.substring(2)
            .replace(
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


        return Response.redirect(

          `${url.origin}/live/${encodeURIComponent(channelId)}.m3u8`,

          302
        );
      }


      // ======================================================================
      // STABLE LIVE ENTRY
      //
      // /live/1424.m3u8
      //
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

          return cors(
            errorJson(
              "Missing channel ID",
              400
            )
          );
        }


        return await liveEntry(
          request,
          channelId
        );
      }


      // ======================================================================
      // LOCKED SESSION
      // ======================================================================

      if (
        path.startsWith("_session/")
      ) {

        const parts =
          path.split("/");


        const sid =
          parts[1];


        if (!sid) {

          return cors(
            errorJson(
              "Missing session ID",
              400
            )
          );
        }


        return await lockedManifest(
          request,
          sid
        );
      }


      // ======================================================================
      // RESOURCE
      // ======================================================================

      if (path === "_resource") {

        return await proxyResource(
          request
        );
      }


      // ======================================================================
      // /1 /2 /3...
      // ======================================================================

      if (/^\d+$/.test(path)) {

        const number =
          Number(path);


        const channels =
          await getCategoryChannels(
            CONFIG.DEFAULT_CATEGORY_ID
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
          channels[
            number - 1
          ];


        return Response.redirect(

          `${url.origin}/live/${encodeURIComponent(channel.id)}.m3u8`,

          302
        );
      }


      return cors(
        errorJson(
          "Route not found",
          404
        )
      );

    }

    catch (error) {

      return cors(
        errorJson(
          error?.message ||
          String(error),

          500
        )
      );
    }
  }
};


// ============================================================================
// API
// ============================================================================

async function apiFetch(
  endpoint
) {

  const url =
    `${CONFIG.API_BASE}/${String(endpoint).replace(/^\/+/, "")}`;


  const headers =
    new Headers();


  headers.set(
    "User-Agent",
    CONFIG.API_USER_AGENT
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
        redirect: "follow"
      },

      CONFIG.API_TIMEOUT_MS
    );


  if (!response.ok) {

    throw new Error(
      `API HTTP ${response.status}`
    );
  }


  const t =
    response.headers.get("t") || "";


  if (!t) {

    throw new Error(
      "Missing API t header"
    );
  }


  const body =
    (await response.text())
      .trim();


  return decryptApi(
    body,
    t
  );
}


// ============================================================================
// DECRYPT
// ============================================================================

function decryptApi(
  encrypted,
  t
) {

  let binary;


  try {

    binary =
      atob(encrypted);

  }

  catch {

    throw new Error(
      "Invalid Base64 response"
    );
  }


  const input =
    new Uint8Array(
      binary.length
    );


  for (
    let i = 0;
    i < binary.length;
    i++
  ) {

    input[i] =
      binary.charCodeAt(i);
  }


  const key =
    new TextEncoder()
      .encode(
        CONFIG.STATIC_KEY +
        String(t)
      );


  const output =
    new Uint8Array(
      input.length
    );


  for (
    let i = 0;
    i < input.length;
    i++
  ) {

    output[i] =
      input[i] ^
      key[
        i % key.length
      ];
  }


  const text =
    new TextDecoder()
      .decode(output);


  try {

    return JSON.parse(
      text
    );

  }

  catch {

    throw new Error(
      "Invalid decrypted JSON"
    );
  }
}


// ============================================================================
// DATA NORMALIZATION
// ============================================================================

function normalize(
  payload
) {

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

  const data =
    normalize(
      await apiFetch(
        "categories"
      )
    );


  if (!Array.isArray(data)) {

    throw new Error(
      "Invalid categories response"
    );
  }


  return data;
}


// ============================================================================
// CHANNELS
// ============================================================================

async function getCategoryChannels(
  categoryId
) {

  const data =
    normalize(
      await apiFetch(

        `categories/${encodeURIComponent(categoryId)}/channels`
      )
    );


  if (!Array.isArray(data)) {

    throw new Error(
      "Invalid channels response"
    );
  }


  return data;
}


// ============================================================================
// PLAYBACK INFO
// ============================================================================

async function getChannelStream(
  channelId
) {

  let data =
    normalize(
      await apiFetch(

        `channel/${encodeURIComponent(channelId)}`
      )
    );


  if (Array.isArray(data)) {

    if (!data.length) {

      throw new Error(
        "No playback servers"
      );
    }


    data =
      data.find(
        item =>
          item &&
          (
            item.url ||
            item.stream_url ||
            item.link
          )
      ) || data[0];
  }


  if (
    !data ||
    typeof data !== "object"
  ) {

    throw new Error(
      "Invalid playback data"
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


  checkUrl(
    streamUrl
  );


  return {

    channelId:
      String(channelId),

    url:
      streamUrl,

    referer:

      data.referer ||

      data.headers?.Referer ||

      CONFIG.DEFAULT_REFERER,

    userAgent:

      data.user_agent ||

      data.headers?.["User-Agent"] ||

      CONFIG.DEFAULT_PLAYER_UA
  };
}


// ============================================================================
// LIVE ENTRY
// ============================================================================

async function liveEntry(
  request,
  channelId
) {

  // Try to reuse the SAME session for repeated /live requests.
  const currentSid =
    await getDefaultSessionId(
      channelId
    );


  if (currentSid) {

    const existing =
      await loadSession(
        currentSid
      );


    if (
      existing &&
      existing.channelId ===
        String(channelId)
    ) {

      return Response.redirect(

        new URL(request.url).origin +
        `/_session/${currentSid}.m3u8`,

        302
      );
    }
  }


  // ========================================================================
  // CREATE NEW LOCKED TIMELINE
  // ========================================================================

  const stream =
    await getChannelStream(
      channelId
    );


  const initial =
    await selectInitialTimeline(
      request,
      stream
    );


  const sid =
    crypto.randomUUID();


  const state = {

    sid,

    channelId:
      String(channelId),

    upstreamUrl:
      stream.url,

    referer:
      stream.referer,

    userAgent:
      stream.userAgent,

    profile:
      initial.profile,

    lastSequence:
      initial.sequence,

    lastManifest:
      initial.text,

    lastManifestUrl:
      initial.finalUrl,

    created:
      Date.now()
  };


  await saveSession(
    state
  );


  await saveDefaultSession(
    channelId,
    sid
  );


  return Response.redirect(

    new URL(request.url).origin +
    `/_session/${sid}.m3u8`,

    302
  );
}


// ============================================================================
// INITIAL TIMELINE SELECTION
// ============================================================================

async function selectInitialTimeline(
  request,
  stream
) {

  const candidates = [];


  for (
    let i = 0;
    i < CONFIG.MANIFEST_SAMPLES;
    i++
  ) {

    try {

      const item =
        await fetchManifestCandidate(

          request,

          stream.url,

          stream.referer,

          stream.userAgent
        );


      candidates.push(
        item
      );

    }

    catch {
      // Try another sample.
    }
  }


  if (!candidates.length) {

    throw new Error(
      "Unable to obtain HLS playlist"
    );
  }


  // ========================================================================
  // GROUP BY TIMELINE PROFILE
  //
  // Example:
  //
  // 4|pdf
  // 6|js
  //
  // ========================================================================

  const groups =
    new Map();


  for (
    const item of candidates
  ) {

    if (
      !groups.has(
        item.profile
      )
    ) {

      groups.set(
        item.profile,
        []
      );
    }


    groups.get(
      item.profile
    ).push(
      item
    );
  }


  let selectedGroup =
    null;


  for (
    const group
    of groups.values()
  ) {

    if (
      !selectedGroup ||
      group.length >
        selectedGroup.length
    ) {

      selectedGroup =
        group;
    }

    else if (
      group.length ===
        selectedGroup.length
    ) {

      // In a tie prefer shorter target duration.
      const a =
        group[0].targetDuration || 999;


      const b =
        selectedGroup[0]
          .targetDuration || 999;


      if (a < b) {

        selectedGroup =
          group;
      }
    }
  }


  // Choose freshest sequence from selected timeline.
  selectedGroup.sort(
    (a, b) =>
      b.sequence -
      a.sequence
  );


  return selectedGroup[0];
}


// ============================================================================
// LOCKED MANIFEST
// ============================================================================

async function lockedManifest(
  request,
  sidPath
) {

  const sid =
    sidPath.replace(
      /\.m3u8$/i,
      ""
    );


  let state =
    await loadSession(
      sid
    );


  if (!state) {

    return cors(
      errorJson(
        "Session expired. Reopen /live/{channel}.m3u8",
        410
      )
    );
  }


  // ========================================================================
  // REAL TOKEN EXPIRY
  // ========================================================================

  if (
    tokenNearExpiry(
      state.upstreamUrl
    )
  ) {

    state =
      await renewLockedRoot(
        request,
        state
      );
  }


  let best =
    null;


  // ========================================================================
  // SAMPLE SAME ROOT BUT ACCEPT ONLY LOCKED PROFILE
  // ========================================================================

  for (
    let i = 0;
    i < CONFIG.MANIFEST_SAMPLES;
    i++
  ) {

    try {

      const candidate =
        await fetchManifestCandidate(

          request,

          state.upstreamUrl,

          state.referer,

          state.userAgent
        );


      if (
        candidate.profile !==
        state.profile
      ) {

        // Critical:
        // upstream returned another timeline.
        // Ignore it completely.
        continue;
      }


      if (
        !best ||
        candidate.sequence >
          best.sequence
      ) {

        best =
          candidate;
      }

    }

    catch {
      // Next sample.
    }
  }


  // ========================================================================
  // ROOT FAILED OR PROFILE DISAPPEARED
  // ========================================================================

  if (!best) {

    state =
      await renewLockedRoot(
        request,
        state
      );


    best =
      await findLockedCandidate(
        request,
        state
      );
  }


  // ========================================================================
  // NEVER GO BACKWARDS
  // ========================================================================

  if (
    best.sequence <
      state.lastSequence &&
    state.lastManifest
  ) {

    best = {

      text:
        state.lastManifest,

      finalUrl:
        state.lastManifestUrl,

      sequence:
        state.lastSequence,

      profile:
        state.profile,

      targetDuration:
        getTargetDuration(
          state.lastManifest
        )
    };
  }


  // ========================================================================
  // SAVE NEW FORWARD STATE
  // ========================================================================

  if (
    best.sequence >=
    state.lastSequence
  ) {

    state.lastSequence =
      best.sequence;


    state.lastManifest =
      best.text;


    state.lastManifestUrl =
      best.finalUrl;


    await saveSession(
      state
    );
  }


  const origin =
    new URL(request.url)
      .origin;


  const rewritten =
    rewriteManifest(

      best.text,

      best.finalUrl,

      origin,

      sid,

      state
    );


  const headers =
    playlistHeaders();


  headers.set(
    "X-YCN-Version",
    "5.0"
  );


  headers.set(
    "X-YCN-Profile",
    state.profile
  );


  headers.set(
    "X-YCN-Sequence",
    String(
      state.lastSequence
    )
  );


  if (
    request.method === "HEAD"
  ) {

    return cors(
      new Response(
        null,
        {
          status: 200,
          headers
        }
      )
    );
  }


  return cors(
    new Response(
      rewritten,
      {
        status: 200,
        headers
      }
    )
  );
}


// ============================================================================
// FIND CANDIDATE MATCHING LOCK
// ============================================================================

async function findLockedCandidate(
  request,
  state
) {

  let best =
    null;


  for (
    let i = 0;
    i < 5;
    i++
  ) {

    try {

      const item =
        await fetchManifestCandidate(

          request,

          state.upstreamUrl,

          state.referer,

          state.userAgent
        );


      if (
        item.profile !==
        state.profile
      ) {

        continue;
      }


      if (
        !best ||
        item.sequence >
          best.sequence
      ) {

        best =
          item;
      }

    }

    catch {
      //
    }
  }


  if (!best) {

    throw new Error(
      `Locked timeline ${state.profile} unavailable`
    );
  }


  return best;
}


// ============================================================================
// TOKEN / ROOT RENEWAL
// ============================================================================

async function renewLockedRoot(
  request,
  oldState
) {

  let fallback =
    null;


  // Try multiple API resolutions until SAME profile appears.
  for (
    let i = 0;
    i < 8;
    i++
  ) {

    try {

      const fresh =
        await getChannelStream(
          oldState.channelId
        );


      const candidate =
        await fetchManifestCandidate(

          request,

          fresh.url,

          fresh.referer,

          fresh.userAgent
        );


      if (!fallback) {

        fallback = {
          fresh,
          candidate
        };
      }


      if (
        candidate.profile ===
        oldState.profile
      ) {

        oldState.upstreamUrl =
          fresh.url;


        oldState.referer =
          fresh.referer;


        oldState.userAgent =
          fresh.userAgent;


        // Only advance sequence.
        if (
          candidate.sequence >=
          oldState.lastSequence
        ) {

          oldState.lastSequence =
            candidate.sequence;


          oldState.lastManifest =
            candidate.text;


          oldState.lastManifestUrl =
            candidate.finalUrl;
        }


        await saveSession(
          oldState
        );


        return oldState;
      }

    }

    catch {
      //
    }
  }


  // Keep old source while still usable rather than jumping timelines.
  if (
    oldState.upstreamUrl
  ) {

    return oldState;
  }


  throw new Error(
    "Unable to renew locked timeline"
  );
}


// ============================================================================
// MANIFEST CANDIDATE
// ============================================================================

async function fetchManifestCandidate(

  request,

  upstreamUrl,

  referer,

  userAgent
) {

  const headers =
    upstreamHeaders(

      request,

      referer,

      userAgent
    );


  headers.set(
    "Cache-Control",
    "no-cache"
  );


  const response =
    await timedFetch(

      upstreamUrl,

      {
        method: "GET",
        headers,
        redirect: "follow"
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
      .startsWith(
        "#EXTM3U"
      )
  ) {

    throw new Error(
      "Not HLS"
    );
  }


  const finalUrl =
    response.url ||
    upstreamUrl;


  const targetDuration =
    getTargetDuration(
      text
    );


  const sequence =
    getMediaSequence(
      text
    );


  const extension =
    detectSegmentFamily(
      text,
      finalUrl
    );


  return {

    text,

    finalUrl,

    targetDuration,

    sequence,

    extension,

    profile:
      `${targetDuration}|${extension}`
  };
}


// ============================================================================
// RESOURCE
// ============================================================================

async function proxyResource(
  request
) {

  const url =
    new URL(request.url);


  const upstreamUrl =
    url.searchParams.get("u");


  const sid =
    url.searchParams.get("sid");


  if (
    !upstreamUrl ||
    !sid
  ) {

    return cors(
      errorJson(
        "Invalid resource request",
        400
      )
    );
  }


  const state =
    await loadSession(
      sid
    );


  if (!state) {

    return cors(
      errorJson(
        "Stream session expired",
        410
      )
    );
  }


  // ========================================================================
  // FIRST TRY
  // ========================================================================

  let response =
    null;


  try {

    response =
      await timedFetch(

        upstreamUrl,

        {
          method: "GET",

          headers:
            upstreamHeaders(

              request,

              state.referer,

              state.userAgent
            ),

          redirect: "follow"
        },

        CONFIG.SEGMENT_TIMEOUT_MS
      );

  }

  catch {
    response = null;
  }


  // ========================================================================
  // FAILED HOST => FIND SAME RESOURCE ON CURRENT LOCKED PLAYLIST
  // ========================================================================

  if (
    !response ||
    !response.ok
  ) {

    const alternative =
      await recoverResourceUrl(

        request,

        state,

        upstreamUrl
      );


    if (alternative) {

      try {

        response =
          await timedFetch(

            alternative,

            {
              method: "GET",

              headers:
                upstreamHeaders(

                  request,

                  state.referer,

                  state.userAgent
                ),

              redirect:
                "follow"
            },

            CONFIG.SEGMENT_TIMEOUT_MS
          );

      }

      catch {
        response = null;
      }
    }
  }


  if (
    !response ||
    !response.ok
  ) {

    return cors(
      new Response(

        response
          ? `Upstream HTTP ${response.status}`
          : "Upstream segment timeout",

        {
          status:
            response
              ? response.status
              : 504,

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
    response.url ||
    upstreamUrl;


  const type =
    response.headers.get(
      "Content-Type"
    ) || "";


  // ========================================================================
  // CHILD M3U8
  // ========================================================================

  if (
    isManifest(
      finalUrl,
      type
    )
  ) {

    const text =
      await response.text();


    const rewritten =
      rewriteManifest(

        text,

        finalUrl,

        url.origin,

        sid,

        state
      );


    return cors(
      new Response(
        rewritten,
        {
          status: 200,
          headers:
            playlistHeaders()
        }
      )
    );
  }


  // ========================================================================
  // SEGMENT / AES KEY
  // ========================================================================

  const headers =
    new Headers();


  copyHeader(
    response.headers,
    headers,
    "Content-Length"
  );


  copyHeader(
    response.headers,
    headers,
    "Content-Range"
  );


  copyHeader(
    response.headers,
    headers,
    "Accept-Ranges"
  );


  headers.set(
    "Content-Type",

    mediaContentType(
      finalUrl,
      type
    )
  );


  headers.set(
    "Cache-Control",
    "no-store"
  );


  headers.set(
    "X-YCN-Version",
    "5.0"
  );


  return cors(
    new Response(

      request.method === "HEAD"
        ? null
        : response.body,

      {
        status:
          response.status,

        headers
      }
    )
  );
}


// ============================================================================
// BAD SEGMENT HOST RECOVERY
// ============================================================================

async function recoverResourceUrl(

  request,

  state,

  failedUrl
) {

  const identity =
    resourceIdentity(
      failedUrl
    );


  if (!identity) {

    return null;
  }


  // Re-read same root several times but ONLY accept locked timeline.
  for (
    let attempt = 0;
    attempt < 3;
    attempt++
  ) {

    try {

      const candidate =
        await fetchManifestCandidate(

          request,

          state.upstreamUrl,

          state.referer,

          state.userAgent
        );


      if (
        candidate.profile !==
        state.profile
      ) {

        continue;
      }


      const urls =
        extractManifestResources(

          candidate.text,

          candidate.finalUrl
        );


      for (
        const candidateUrl
        of urls
      ) {

        if (
          resourceIdentity(
            candidateUrl
          ) === identity &&
          candidateUrl !== failedUrl
        ) {

          return candidateUrl;
        }
      }

    }

    catch {
      //
    }
  }


  return null;
}


// ============================================================================
// RESOURCE IDENTITY
//
// Different CDN hostname:
//
// h50.x/0021012254/918454578001/10889.pdf
// h31.y/0021012254/918454578001/10889.pdf
//
// Same media resource.
// ============================================================================

function resourceIdentity(
  value
) {

  try {

    const url =
      new URL(value);


    const parts =
      url.pathname
        .split("/")
        .filter(Boolean);


    return parts
      .slice(-2)
      .join("/");

  }

  catch {

    return null;
  }
}


// ============================================================================
// EXTRACT RESOURCE URLS
// ============================================================================

function extractManifestResources(
  manifest,
  manifestUrl
) {

  const base =
    new URL(
      manifestUrl
    );


  const result =
    [];


  for (
    const line
    of manifest.split(/\r?\n/)
  ) {

    const trimmed =
      line.trim();


    if (!trimmed) {
      continue;
    }


    if (
      !trimmed.startsWith("#")
    ) {

      try {

        result.push(
          inheritQuery(

            new URL(
              trimmed,
              base
            ),

            base
          ).href
        );

      }

      catch {
        //
      }
    }


    const regex =
      /URI=(["'])(.*?)\1/gi;


    let match;


    while (
      (
        match =
          regex.exec(line)
      ) !== null
    ) {

      try {

        result.push(
          inheritQuery(

            new URL(
              match[2],
              base
            ),

            base
          ).href
        );

      }

      catch {
        //
      }
    }
  }


  return result;
}


// ============================================================================
// REWRITE MANIFEST
// ============================================================================

function rewriteManifest(

  manifest,

  manifestUrl,

  origin,

  sid,

  state
) {

  const base =
    new URL(
      manifestUrl
    );


  return manifest
    .split(/\r?\n/)
    .map(
      line => {

        const trimmed =
          line.trim();


        if (!trimmed) {

          return line;
        }


        // URI="..."
        if (
          trimmed.startsWith("#")
        ) {

          return line.replace(

            /URI=(["'])(.*?)\1/gi,

            (
              whole,
              quote,
              value
            ) => {

              try {

                const absolute =
                  inheritQuery(

                    new URL(
                      value,
                      base
                    ),

                    base
                  ).href;


                return (
                  `URI=${quote}` +
                  resourceWorkerUrl(
                    origin,
                    absolute,
                    sid
                  ) +
                  `${quote}`
                );

              }

              catch {

                return whole;
              }
            }
          );
        }


        try {

          const absolute =
            inheritQuery(

              new URL(
                trimmed,
                base
              ),

              base
            ).href;


          return resourceWorkerUrl(

            origin,

            absolute,

            sid
          );

        }

        catch {

          return line;
        }
      }
    )
    .join("\n");
}


// ============================================================================
// RESOURCE WORKER URL
// ============================================================================

function resourceWorkerUrl(
  origin,
  upstream,
  sid
) {

  const query =
    new URLSearchParams();


  query.set(
    "u",
    upstream
  );


  query.set(
    "sid",
    sid
  );


  return (
    `${origin}/_resource?` +
    query.toString()
  );
}


// ============================================================================
// RELATIVE QUERY INHERITANCE
// ============================================================================

function inheritQuery(
  target,
  parent
) {

  for (
    const [key, value]
    of parent.searchParams.entries()
  ) {

    if (
      !target.searchParams.has(
        key
      )
    ) {

      target.searchParams.set(
        key,
        value
      );
    }
  }


  return target;
}


// ============================================================================
// TARGET DURATION
// ============================================================================

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


// ============================================================================
// MEDIA SEQUENCE
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


// ============================================================================
// SEGMENT FAMILY
// ============================================================================

function detectSegmentFamily(
  manifest,
  manifestUrl
) {

  const base =
    new URL(
      manifestUrl
    );


  const lines =
    manifest.split(
      /\r?\n/
    );


  for (
    const line of lines
  ) {

    const value =
      line.trim();


    if (
      !value ||
      value.startsWith("#")
    ) {

      continue;
    }


    try {

      const path =
        new URL(
          value,
          base
        )
          .pathname
          .toLowerCase();


      const match =
        path.match(
          /\.([a-z0-9]+)$/
        );


      if (match) {

        return match[1];
      }

    }

    catch {
      //
    }
  }


  return "unknown";
}


// ============================================================================
// TOKEN EXPIRY
// ============================================================================

function tokenNearExpiry(
  value
) {

  try {

    const url =
      new URL(value);


    const expiry =
      Number(
        url.searchParams.get("e")
      );


    if (
      !Number.isFinite(expiry) ||
      expiry <= 0
    ) {

      return false;
    }


    const now =
      Math.floor(
        Date.now() / 1000
      );


    return (
      expiry -
      now <=
      CONFIG
        .TOKEN_REFRESH_MARGIN_SECONDS
    );

  }

  catch {

    return false;
  }
}


// ============================================================================
// EDGE SESSION STORAGE
// ============================================================================

function stateRequest(
  sid
) {

  return new Request(
    `https://ycn-state.internal/session/${sid}`
  );
}


function defaultSessionRequest(
  channelId
) {

  return new Request(
    `https://ycn-state.internal/channel/${channelId}`
  );
}


async function saveSession(
  state
) {

  const response =
    new Response(

      JSON.stringify(state),

      {
        headers: {

          "Content-Type":
            "application/json",

          "Cache-Control":
            `public, max-age=${CONFIG.SESSION_TTL_SECONDS}`
        }
      }
    );


  await caches.default.put(

    stateRequest(
      state.sid
    ),

    response
  );
}


async function loadSession(
  sid
) {

  const response =
    await caches.default.match(
      stateRequest(sid)
    );


  if (!response) {

    return null;
  }


  try {

    return await response.json();

  }

  catch {

    return null;
  }
}


async function saveDefaultSession(
  channelId,
  sid
) {

  await caches.default.put(

    defaultSessionRequest(
      channelId
    ),

    new Response(
      sid,
      {
        headers: {

          "Cache-Control":
            `public, max-age=${CONFIG.SESSION_TTL_SECONDS}`,

          "Content-Type":
            "text/plain"
        }
      }
    )
  );
}


async function getDefaultSessionId(
  channelId
) {

  const response =
    await caches.default.match(

      defaultSessionRequest(
        channelId
      )
    );


  if (!response) {

    return null;
  }


  return (
    await response.text()
  ).trim();
}


// ============================================================================
// FETCH WITH TIMEOUT
// ============================================================================

async function timedFetch(
  url,
  options,
  timeout
) {

  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeout
    );


  try {

    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal
      }
    );

  }

  finally {

    clearTimeout(
      timer
    );
  }
}


// ============================================================================
// HEADERS
// ============================================================================

function upstreamHeaders(
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


function playlistHeaders() {

  return new Headers({

    "Content-Type":
      "application/vnd.apple.mpegurl; charset=utf-8",

    "Cache-Control":
      "no-store, no-cache, must-revalidate, max-age=0",

    "Pragma":
      "no-cache",

    "Expires":
      "0"
  });
}


// ============================================================================
// MANIFEST DETECTION
// ============================================================================

function isManifest(
  url,
  type
) {

  const lower =
    String(type || "")
      .toLowerCase();


  if (
    lower.includes("mpegurl") ||
    lower.includes("m3u")
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

    return false;
  }
}


// ============================================================================
// CONTENT TYPE
// ============================================================================

function mediaContentType(
  url,
  upstreamType
) {

  let path = "";


  try {

    path =
      new URL(url)
        .pathname
        .toLowerCase();

  }

  catch {
    //
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
    upstreamType &&
    !upstreamType
      .toLowerCase()
      .includes("text/html")
  ) {

    return upstreamType;
  }


  return "application/octet-stream";
}


// ============================================================================
// URL
// ============================================================================

function checkUrl(
  value
) {

  const url =
    new URL(value);


  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {

    throw new Error(
      "Unsupported URL protocol"
    );
  }


  return url;
}


// ============================================================================
// COPY HEADER
// ============================================================================

function copyHeader(
  source,
  destination,
  name
) {

  const value =
    source.get(name);


  if (value !== null) {

    destination.set(
      name,
      value
    );
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
          "no-store"
      }
    }
  );
}


function errorJson(
  message,
  status = 500
) {

  return json(
    {

      ok:
        false,

      error:
        message,

      version:
        "5.0"
    },

    status
  );
}


// ============================================================================
// CORS
// ============================================================================

function cors(
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
    "Content-Length, Content-Range, Accept-Ranges, X-YCN-Version, X-YCN-Profile, X-YCN-Sequence"
  );


  return new Response(

    response.body,

    {

      status:
        response.status,

      statusText:
        response.statusText,

      headers
    }
  );
}
