/**
 * Enlil Redline Resolver
 *
 * التطبيق:
 *   /live/bein1.m3u8
 *
 * Worker:
 *   1. يولد R-Auth
 *   2. يطلب Redline
 *   3. يحصل على 302
 *   4. يعيد Redirect للتطبيق
 *
 * الفيديو نفسه لا يمر عبر Worker.
 */

const REDLINE_BASE =
  "http://play.redroidiptv.com/live/hls/20/US";

const DEVICE_MAC = "02:00:00:00:00:00";
const DEVICE_CODE = "RDLNB89BED0248FA";
const XOR_KEY = "KCQ";

const REDLINE_UA = "Rediptv 2.0.74";


const CHANNELS = {

  bein1: "Plus/beIN_Sports1_HD-ar",

  // أضف البقية هنا:
  // bein2: "Plus/beIN_Sports2_HD-ar",
  // bein3: "Plus/beIN_Sports3_HD-ar",
  // bein4: "Plus/beIN_Sports4_HD-ar",

};


// ============================================================
// Helpers
// ============================================================

function utf8(text) {
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

  const bytes = utf8(text);

  return Array.from(bytes)
    .map(
      b =>
        b
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}


// ============================================================
// Generate R-Auth
// ============================================================

function generateRAuth() {

  const timestamp =
    Math.floor(Date.now() / 1000);


  const raw =
    DEVICE_MAC +
    "\x02|" +
    DEVICE_CODE +
    "\x02|" +
    timestamp;


  const input = utf8(raw);

  const key =
    utf8(XOR_KEY);


  const output =
    new Uint8Array(input.length);


  for (
    let i = 0;
    i < input.length;
    i++
  ) {

    output[i] =
      input[i] ^
      key[i % key.length];

  }


  return bytesToBase64(output);
}


// ============================================================
// Headers
// ============================================================

function redlineHeaders() {

  return {

    "User-Agent":
      REDLINE_UA,

    "R-Auth":
      generateRAuth(),

    "Accept":
      "*/*",

    "Accept-Encoding":
      "identity"

  };

}


// ============================================================
// JSON
// ============================================================

function json(data, status = 200) {

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
          "application/json; charset=UTF-8",

        "Access-Control-Allow-Origin":
          "*",

        "Cache-Control":
          "no-store"

      }
    }
  );

}


// ============================================================
// Resolve channel
// ============================================================

async function resolveChannel(channelID) {

  const streamName =
    CHANNELS[channelID];


  if (!streamName) {

    return {
      ok: false,
      status: 404,
      error: "Channel not found"
    };

  }


  const channelHex =
    stringToHex(streamName);


  const sourceURL =
    `${REDLINE_BASE}/${channelHex}/1`;


  let response;


  try {

    response =
      await fetch(
        sourceURL,
        {

          method: "GET",

          headers:
            redlineHeaders(),

          /*
           * مهم جداً.
           *
           * Cloudflare لا يتصل بعنوان
           * الـstream النهائي.
           */

          redirect: "manual"

        }
      );

  }

  catch (error) {

    return {

      ok: false,

      status: 502,

      error:
        error?.message ||
        String(error)

    };

  }


  // ==========================================================
  // Expected Redline response
  // ==========================================================

  if (
    response.status >= 300 &&
    response.status < 400
  ) {

    const location =
      response.headers.get(
        "location"
      );


    if (!location) {

      return {

        ok: false,

        status: 502,

        error:
          "Redline redirect has no Location header"

      };

    }


    return {

      ok: true,

      status:
        response.status,

      location,

      streamName,

      channelHex

    };

  }


  // ==========================================================
  // Unexpected response
  // ==========================================================

  let preview = "";


  try {

    preview =
      (await response.text())
        .substring(0, 500);

  }

  catch (_) {}


  return {

    ok: false,

    status:
      response.status,

    error:
      `Redline HTTP ${response.status}`,

    preview

  };

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


    // ========================================================
    // CORS
    // ========================================================

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

            "Access-Control-Allow-Methods":
              "GET, HEAD, OPTIONS",

            "Access-Control-Allow-Headers":
              "*"

          }

        }
      );

    }


    // ========================================================
    // Home
    // ========================================================

    if (
      pathname === "/" ||
      pathname === ""
    ) {

      return json({

        ok: true,

        service:
          "Enlil Redline Resolver",

        mode:
          "direct-stream",

        channels:
          Object.keys(CHANNELS),

        example:
          "/live/bein1.m3u8"

      });

    }


    // ========================================================
    // Health
    // ========================================================

    if (
      pathname === "/health"
    ) {

      return json({

        ok: true,

        service:
          "Enlil Redline Resolver",

        time:
          new Date()
            .toISOString()

      });

    }


    // ========================================================
    // API
    //
    // /resolve/bein1
    //
    // يعيد الرابط كـ JSON للاختبار
    // ========================================================

    const resolveMatch =
      pathname.match(
        /^\/resolve\/([a-zA-Z0-9_-]+)$/
      );


    if (resolveMatch) {

      const channelID =
        resolveMatch[1];


      const result =
        await resolveChannel(
          channelID
        );


      if (!result.ok) {

        return json(
          result,
          result.status || 502
        );

      }


      return json({

        ok: true,

        channel:
          channelID,

        stream:
          result.location,

        temporary:
          true

      });

    }


    // ========================================================
    // LIVE
    //
    // /live/bein1.m3u8
    // ========================================================

    const liveMatch =
      pathname.match(
        /^\/live\/([a-zA-Z0-9_-]+)\.m3u8$/
      );


    if (liveMatch) {

      const channelID =
        liveMatch[1];


      const result =
        await resolveChannel(
          channelID
        );


      if (!result.ok) {

        return json(
          result,
          result.status || 502
        );

      }


      /*
       * التطبيق سيستلم 302
       *
       * ثم يتصل مباشرة بخادم HLS.
       */

      return new Response(
        null,
        {

          status: 302,

          headers: {

            "Location":
              result.location,

            "Cache-Control":
              "no-store",

            "Access-Control-Allow-Origin":
              "*"

          }

        }
      );

    }


    // ========================================================
    // 404
    // ========================================================

    return json(
      {

        ok: false,

        error:
          "Route not found"

      },
      404
    );

  }

};
