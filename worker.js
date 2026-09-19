/**
 * Enlil Redline Worker - Diagnostic Version
 */

const REDLINE_BASE = "http://play.redroidiptv.com/live/hls/20/US";

const DEVICE_MAC = "02:00:00:00:00:00";
const DEVICE_CODE = "RDLNB89BED0248FA";
const XOR_KEY = "KCQ";
const REDLINE_UA = "Rediptv 2.0.74";

const CHANNELS = {
  bein1: "Plus/beIN_Sports1_HD-ar",

  // أضف القنوات لاحقاً:
  // bein2: "Plus/beIN_Sports2_HD-ar",
  // bein3: "Plus/beIN_Sports3_HD-ar",
};


// ============================================================
// Encoding
// ============================================================

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

function bytesToBase64(bytes) {
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

function stringToHex(text) {
  const bytes = utf8Bytes(text);

  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}


// ============================================================
// R-Auth
// ============================================================

function generateRAuth(timestamp = null) {
  const ts =
    timestamp !== null
      ? Number(timestamp)
      : Math.floor(Date.now() / 1000);

  const raw =
    DEVICE_MAC +
    "\x02|" +
    DEVICE_CODE +
    "\x02|" +
    String(ts);

  const input = utf8Bytes(raw);
  const key = utf8Bytes(XOR_KEY);

  const output = new Uint8Array(input.length);

  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] ^ key[i % key.length];
  }

  return bytesToBase64(output);
}


// ============================================================
// Redline headers
// ============================================================

function createRedlineHeaders(rAuth = null) {
  return {
    "User-Agent": REDLINE_UA,
    "R-Auth": rAuth || generateRAuth(),
    "Accept": "*/*",
    "Accept-Encoding": "identity",
  };
}


// ============================================================
// CORS
// ============================================================

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...extra,
  };
}


// ============================================================
// JSON response
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: corsHeaders({
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store",
      }),
    }
  );
}


// ============================================================
// Channel URL
// ============================================================

function getChannelSource(channelName) {
  const streamName = CHANNELS[channelName];

  if (!streamName) {
    throw new Error(`Unknown channel: ${channelName}`);
  }

  const channelHex = stringToHex(streamName);

  return {
    streamName,
    channelHex,
    sourceURL:
      `${REDLINE_BASE}/${channelHex}/1`,
  };
}


// ============================================================
// DEBUG
//
// مهم:
// لا يتبع Redirect.
//
// الهدف معرفة:
// Redline -> 302 ؟
// أم Redline -> 403 ؟
// ============================================================

async function debugRedline(channelName) {
  const channel = getChannelSource(channelName);

  const timestamp =
    Math.floor(Date.now() / 1000);

  const rAuth =
    generateRAuth(timestamp);

  let response;

  try {
    response = await fetch(
      channel.sourceURL,
      {
        method: "GET",

        headers: createRedlineHeaders(rAuth),

        redirect: "manual",
      }
    );
  } catch (error) {
    return json(
      {
        ok: false,
        stage: "initial_fetch",

        error:
          error?.message || String(error),

        channel: channelName,

        sourceURL:
          channel.sourceURL,

        timestamp,
      },
      502
    );
  }

  let body = "";

  try {
    body = await response.text();
  } catch (_) {
    body = "";
  }

  const interestingHeaders = {};

  const names = [
    "location",
    "server",
    "content-type",
    "content-length",
    "date",
    "via",
    "cf-ray",
    "cf-cache-status",
  ];

  for (const name of names) {
    const value =
      response.headers.get(name);

    if (value !== null) {
      interestingHeaders[name] = value;
    }
  }

  return json({
    ok:
      response.status >= 200 &&
      response.status < 400,

    stage: "initial_redline_request",

    channel: channelName,

    streamName:
      channel.streamName,

    channelHex:
      channel.channelHex,

    sourceURL:
      channel.sourceURL,

    timestamp,

    authGenerated: true,

    requestHeaders: {
      "User-Agent": REDLINE_UA,
      "R-Auth": "[generated]",
      "Accept": "*/*",
      "Accept-Encoding": "identity",
    },

    response: {
      status: response.status,

      statusText:
        response.statusText,

      url:
        response.url,

      redirected:
        response.redirected,

      location:
        response.headers.get("location"),

      headers:
        interestingHeaders,

      bodyPreview:
        body.substring(0, 1500),
    },

    interpretation:
      response.status >= 300 &&
      response.status < 400
        ? "Initial authentication appears accepted and Redline returned a redirect."
        : response.status === 401 ||
          response.status === 403
        ? "Initial Redline endpoint rejected the Worker request."
        : response.status === 200
        ? "Initial endpoint returned HTTP 200 directly."
        : "Unexpected upstream response.",
  });
}


// ============================================================
// Resolve Redline
// ============================================================

async function resolveRedline(channelName) {
  const channel =
    getChannelSource(channelName);

  const response = await fetch(
    channel.sourceURL,
    {
      method: "GET",

      headers:
        createRedlineHeaders(),

      redirect: "follow",
    }
  );

  if (!response.ok) {
    let preview = "";

    try {
      preview =
        (await response.text())
          .substring(0, 500);
    } catch (_) {}

    throw new Error(
      `Redline HTTP ${response.status}` +
      (preview ? `: ${preview}` : "")
    );
  }

  const playlist =
    await response.text();

  if (!playlist.includes("#EXTM3U")) {
    throw new Error(
      "Redline response is not an HLS playlist"
    );
  }

  return {
    playlist,
    finalURL: response.url,
  };
}


// ============================================================
// URL resolver
// ============================================================

function absoluteURL(uri, base) {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}


// ============================================================
// Rewrite HLS
// ============================================================

function rewritePlaylist(
  playlist,
  finalURL,
  workerOrigin
) {
  const lines =
    playlist.split(/\r?\n/);

  const output = [];

  for (let line of lines) {
    const trimmed =
      line.trim();

    if (!trimmed) {
      output.push(line);
      continue;
    }

    // -----------------------------------------
    // HLS directive
    // -----------------------------------------

    if (trimmed.startsWith("#")) {
      line = line.replace(
        /URI="([^"]+)"/g,
        (_, uri) => {
          const absolute =
            absoluteURL(
              uri,
              finalURL
            );

          return (
            `URI="${workerOrigin}` +
            `/resource?url=` +
            `${encodeURIComponent(absolute)}"`
          );
        }
      );

      output.push(line);
      continue;
    }

    // -----------------------------------------
    // Normal playlist URI
    // -----------------------------------------

    const absolute =
      absoluteURL(
        trimmed,
        finalURL
      );

    output.push(
      `${workerOrigin}/resource?url=` +
      encodeURIComponent(absolute)
    );
  }

  return output.join("\n");
}


// ============================================================
// Resource proxy
// ============================================================

async function proxyResource(requestURL) {
  const targetString =
    requestURL.searchParams.get("url");

  if (!targetString) {
    return json(
      {
        ok: false,
        error: "Missing url",
      },
      400
    );
  }

  let target;

  try {
    target =
      new URL(targetString);
  } catch {
    return json(
      {
        ok: false,
        error: "Invalid target URL",
      },
      400
    );
  }

  if (
    target.protocol !== "http:" &&
    target.protocol !== "https:"
  ) {
    return json(
      {
        ok: false,
        error: "Protocol not allowed",
      },
      403
    );
  }

  let upstream;

  try {
    upstream = await fetch(
      target.toString(),
      {
        method: "GET",

        headers:
          createRedlineHeaders(),

        redirect: "follow",
      }
    );
  } catch (error) {
    return json(
      {
        ok: false,

        stage: "resource_fetch",

        error:
          error?.message ||
          String(error),
      },
      502
    );
  }

  if (!upstream.ok) {
    return json(
      {
        ok: false,

        stage: "resource_fetch",

        status:
          upstream.status,

        target:
          target.toString(),
      },
      upstream.status
    );
  }

  const contentType =
    upstream.headers.get(
      "content-type"
    ) || "";

  // -----------------------------------------
  // Nested HLS playlist
  // -----------------------------------------

  if (
    contentType
      .toLowerCase()
      .includes("mpegurl") ||
    upstream.url
      .toLowerCase()
      .includes(".m3u8") ||
    target.pathname
      .toLowerCase()
      .endsWith(".m3u8")
  ) {
    const playlist =
      await upstream.text();

    const rewritten =
      rewritePlaylist(
        playlist,
        upstream.url,
        requestURL.origin
      );

    return new Response(
      rewritten,
      {
        status: 200,

        headers:
          corsHeaders({
            "Content-Type":
              "application/vnd.apple.mpegurl",

            "Cache-Control":
              "no-store",
          }),
      }
    );
  }

  // -----------------------------------------
  // Binary resource / segment / key
  // -----------------------------------------

  const headers =
    new Headers();

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Cache-Control",
    "no-store"
  );

  if (contentType) {
    headers.set(
      "Content-Type",
      contentType
    );
  }

  const contentLength =
    upstream.headers.get(
      "content-length"
    );

  if (contentLength) {
    headers.set(
      "Content-Length",
      contentLength
    );
  }

  return new Response(
    upstream.body,
    {
      status: upstream.status,
      headers,
    }
  );
}


// ============================================================
// Worker
// ============================================================

export default {
  async fetch(request) {
    const url =
      new URL(request.url);

    const pathname =
      url.pathname;

    // -----------------------------------------
    // OPTIONS
    // -----------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(
        null,
        {
          status: 204,
          headers: corsHeaders(),
        }
      );
    }

    try {

      // =======================================
      // Home
      // =======================================

      if (
        pathname === "/" ||
        pathname === ""
      ) {
        return json({
          ok: true,

          service:
            "Enlil Redline Worker",

          version:
            "diagnostic-2",

          channels:
            Object.keys(CHANNELS),

          examples: {
            health:
              "/health",

            debug:
              "/debug/bein1",

            live:
              "/live/bein1.m3u8",
          },
        });
      }


      // =======================================
      // Health
      // =======================================

      if (pathname === "/health") {
        return json({
          ok: true,

          service:
            "Enlil Redline Worker",

          time:
            new Date().toISOString(),
        });
      }


      // =======================================
      // DEBUG
      // /debug/bein1
      // =======================================

      const debugMatch =
        pathname.match(
          /^\/debug\/([a-zA-Z0-9_-]+)$/
        );

      if (debugMatch) {
        const channelName =
          debugMatch[1];

        if (!CHANNELS[channelName]) {
          return json(
            {
              ok: false,
              error:
                "Channel not found",
            },
            404
          );
        }

        return await debugRedline(
          channelName
        );
      }


      // =======================================
      // Resource
      // =======================================

      if (pathname === "/resource") {
        return await proxyResource(url);
      }


      // =======================================
      // LIVE
      // /live/bein1.m3u8
      // =======================================

      const liveMatch =
        pathname.match(
          /^\/live\/([a-zA-Z0-9_-]+)\.m3u8$/
        );

      if (liveMatch) {
        const channelName =
          liveMatch[1];

        if (!CHANNELS[channelName]) {
          return json(
            {
              ok: false,

              error:
                "Channel not found",
            },
            404
          );
        }

        const result =
          await resolveRedline(
            channelName
          );

        const rewritten =
          rewritePlaylist(
            result.playlist,
            result.finalURL,
            url.origin
          );

        return new Response(
          rewritten,
          {
            status: 200,

            headers:
              corsHeaders({
                "Content-Type":
                  "application/vnd.apple.mpegurl",

                "Cache-Control":
                  "no-store",
              }),
          }
        );
      }


      // =======================================
      // 404
      // =======================================

      return json(
        {
          ok: false,
          error: "Route not found",
        },
        404
      );

    } catch (error) {
      return json(
        {
          ok: false,

          error:
            error?.message ||
            String(error),

          type:
            error?.name ||
            "Error",
        },
        502
      );
    }
  },
};
