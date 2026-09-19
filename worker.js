/**
 * Enlil Redline Gateway
 * Cloudflare Worker
 *
 * Routes:
 *   /live/<channel>.m3u8
 *   /health
 *
 * Example:
 *   /live/bein1.m3u8
 */

const REDLINE_BASE =
  "http://play.redroidiptv.com/live/hls/20/US";

const DEVICE_MAC = "02:00:00:00:00:00";
const DEVICE_CODE = "RDLNB89BED0248FA";
const XOR_KEY = "KCQ";

const REDLINE_UA = "Rediptv 2.0.74";

/*
 * ضع هنا أسماء القنوات كما يعرفها Redline.
 * سيتم تحويلها إلى HEX تلقائياً.
 */
const CHANNELS = {
  bein1: "Plus/beIN_Sports1_HD-ar",

  // أمثلة لإضافة المزيد:
  // bein2: "Plus/beIN_Sports2_HD-ar",
  // bein3: "Plus/beIN_Sports3_HD-ar",
};


// ============================================================
// Utilities
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
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}


// ============================================================
// R-Auth
// ============================================================

function generateRAuth() {

  const timestamp = Math.floor(Date.now() / 1000);

  /*
   * DEVICE_MAC
   * + 0x02 0x7C
   * + DEVICE_CODE
   * + 0x02 0x7C
   * + timestamp
   */

  const raw =
    DEVICE_MAC +
    "\x02|" +
    DEVICE_CODE +
    "\x02|" +
    timestamp;

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

function redlineHeaders() {

  return {
    "User-Agent": REDLINE_UA,
    "R-Auth": generateRAuth(),

    "Accept": "*/*",
    "Accept-Encoding": "identity"
  };
}


// ============================================================
// Resolve Redline channel
// ============================================================

async function resolveRedline(channelName) {

  const streamName = CHANNELS[channelName];

  if (!streamName) {
    throw new Error("Unknown channel");
  }

  const channelHex = stringToHex(streamName);

  const sourceURL =
    `${REDLINE_BASE}/${channelHex}/1`;

  const response = await fetch(sourceURL, {
    method: "GET",

    headers: redlineHeaders(),

    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `Redline HTTP ${response.status}`
    );
  }

  const playlist = await response.text();

  if (!playlist.includes("#EXTM3U")) {
    throw new Error(
      "Redline response is not an HLS playlist"
    );
  }

  /*
   * response.url = final redirected URL
   *
   * مهم جداً لأن الروابط النسبية داخل
   * الـMaster يجب حلها بالنسبة لهذا العنوان.
   */

  return {
    playlist,
    finalURL: response.url
  };
}


// ============================================================
// HLS URL resolution
// ============================================================

function absoluteURL(uri, base) {

  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}


// ============================================================
// Rewrite Master Playlist
// ============================================================

function rewritePlaylist(
  playlist,
  finalURL,
  workerOrigin
) {

  const lines = playlist.split(/\r?\n/);

  const output = [];

  for (let line of lines) {

    const trimmed = line.trim();

    if (!trimmed) {
      output.push(line);
      continue;
    }

    /*
     * HLS directives
     */

    if (trimmed.startsWith("#")) {

      /*
       * URI="..."
       *
       * Covers:
       *
       * EXT-X-KEY
       * EXT-X-MAP
       * EXT-X-MEDIA
       */

      line = line.replace(
        /URI="([^"]+)"/g,
        (_, uri) => {

          const absolute =
            absoluteURL(uri, finalURL);

          const proxy =
            workerOrigin +
            "/resource?url=" +
            encodeURIComponent(absolute);

          return `URI="${proxy}"`;
        }
      );

      output.push(line);

      continue;
    }

    /*
     * Normal URI line.
     *
     * Could be:
     *
     * variant playlist
     * segment
     * audio playlist
     */

    const absolute =
      absoluteURL(trimmed, finalURL);

    output.push(
      workerOrigin +
      "/resource?url=" +
      encodeURIComponent(absolute)
    );
  }

  return output.join("\n");
}


// ============================================================
// Resource proxy
// ============================================================

async function proxyResource(requestURL) {

  const encoded =
    requestURL.searchParams.get("url");

  if (!encoded) {
    return new Response(
      "Missing url",
      {
        status: 400
      }
    );
  }

  let target;

  try {
    target = new URL(encoded);
  } catch {
    return new Response(
      "Invalid URL",
      {
        status: 400
      }
    );
  }


  /*
   * منع استخدام الـWorker كبروكسي عام.
   *
   * يمكنك لاحقاً تشديد القائمة أكثر
   * حسب نطاقات CDN الحقيقية.
   */

  if (
    target.protocol !== "http:" &&
    target.protocol !== "https:"
  ) {
    return new Response(
      "Protocol not allowed",
      {
        status: 403
      }
    );
  }


  const headers = redlineHeaders();


  const upstream = await fetch(
    target.toString(),
    {
      method: "GET",

      headers,

      redirect: "follow"
    }
  );


  if (!upstream.ok) {

    return new Response(
      `Upstream HTTP ${upstream.status}`,
      {
        status: upstream.status
      }
    );
  }


  const contentType =
    upstream.headers.get("content-type") || "";


  /*
   * إذا كان المورد Playlist
   * نعيد كتابة روابطه أيضاً.
   */

  if (
    contentType.includes("mpegurl") ||
    target.pathname.endsWith(".m3u8")
  ) {

    const text =
      await upstream.text();

    const workerOrigin =
      requestURL.origin;

    const rewritten =
      rewritePlaylist(
        text,
        upstream.url,
        workerOrigin
      );

    return new Response(
      rewritten,
      {
        status: 200,

        headers: {
          "Content-Type":
            "application/vnd.apple.mpegurl",

          "Cache-Control":
            "no-store",

          "Access-Control-Allow-Origin":
            "*"
        }
      }
    );
  }


  /*
   * Segment / key / binary resource
   */

  const responseHeaders =
    new Headers();

  responseHeaders.set(
    "Content-Type",
    contentType ||
    "application/octet-stream"
  );

  responseHeaders.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  responseHeaders.set(
    "Cache-Control",
    "no-store"
  );


  const contentLength =
    upstream.headers.get("content-length");

  if (contentLength) {
    responseHeaders.set(
      "Content-Length",
      contentLength
    );
  }


  return new Response(
    upstream.body,
    {
      status: upstream.status,
      headers: responseHeaders
    }
  );
}


// ============================================================
// Main Worker
// ============================================================

export default {

  async fetch(request) {

    try {

      const url =
        new URL(request.url);

      const pathname =
        url.pathname;


      // ------------------------------------------------------
      // CORS
      // ------------------------------------------------------

      if (request.method === "OPTIONS") {

        return new Response(
          null,
          {
            status: 204,

            headers: {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Methods":
                "GET,HEAD,OPTIONS",

              "Access-Control-Allow-Headers":
                "*"
            }
          }
        );
      }


      // ------------------------------------------------------
      // Health
      // ------------------------------------------------------

      if (pathname === "/health") {

        return Response.json({
          ok: true,
          service:
            "Enlil Redline Gateway",

          time:
            new Date().toISOString()
        });
      }


      // ------------------------------------------------------
      // Resource proxy
      // ------------------------------------------------------

      if (pathname === "/resource") {

        return await proxyResource(url);
      }


      // ------------------------------------------------------
      // /live/bein1.m3u8
      // ------------------------------------------------------

      const match =
        pathname.match(
          /^\/live\/([a-zA-Z0-9_-]+)\.m3u8$/
        );


      if (match) {

        const channelName =
          match[1];

        if (!CHANNELS[channelName]) {

          return Response.json(
            {
              ok: false,
              error:
                "Channel not found"
            },
            {
              status: 404
            }
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

            headers: {
              "Content-Type":
                "application/vnd.apple.mpegurl",

              "Access-Control-Allow-Origin":
                "*",

              "Cache-Control":
                "no-store"
            }
          }
        );
      }


      // ------------------------------------------------------
      // Home
      // ------------------------------------------------------

      return Response.json({
        ok: true,

        service:
          "Enlil Redline Gateway",

        routes: {
          health:
            "/health",

          stream:
            "/live/<channel>.m3u8"
        },

        channels:
          Object.keys(CHANNELS)
      });

    }

    catch (error) {

      return Response.json(
        {
          ok: false,

          error:
            error?.message ||
            String(error)
        },
        {
          status: 502,

          headers: {
            "Access-Control-Allow-Origin":
              "*",

            "Cache-Control":
              "no-store"
          }
        }
      );
    }
  }
};
