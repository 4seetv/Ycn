export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Accept-Ranges, Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    const incomingUrl = new URL(request.url);

    // =========================================================
    // API proxy
    // =========================================================
    const apiTarget = incomingUrl.searchParams.get("api_target");

    if (apiTarget) {
      try {
        const apiResponse = await fetch(apiTarget, {
          method: "GET",
          headers: {
            "User-Agent": "okhttp/4.12.0",
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
          },
          cache: "no-store",
          redirect: "follow"
        });

        const headers = new Headers(apiResponse.headers);

        for (const [k, v] of Object.entries(cors)) {
          headers.set(k, v);
        }

        headers.set(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, max-age=0"
        );

        return new Response(apiResponse.body, {
          status: apiResponse.status,
          headers
        });

      } catch (e) {
        return new Response("API Proxy Error: " + e.message, {
          status: 502,
          headers: cors
        });
      }
    }

    // =========================================================
    // Stream proxy
    // =========================================================

    const targetUrl = incomingUrl.searchParams.get("url");

    const referer =
      incomingUrl.searchParams.get("ref") ||
      "https://x.com/";

    const userAgent =
      incomingUrl.searchParams.get("ua") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/139.0.0.0 Safari/537.36";

    if (!targetUrl) {
      return new Response("Missing url parameter", {
        status: 400,
        headers: cors
      });
    }

    let parsedTarget;

    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return new Response("Invalid target URL", {
        status: 400,
        headers: cors
      });
    }

    const isPlaylist =
      parsedTarget.pathname.toLowerCase().endsWith(".m3u8");

    const headersToOrigin = new Headers();

    headersToOrigin.set("Referer", referer);
    headersToOrigin.set("User-Agent", userAgent);
    headersToOrigin.set("Accept", "*/*");

    // playlist لازم دائماً fresh
    if (isPlaylist) {
      headersToOrigin.set(
        "Cache-Control",
        "no-cache, no-store, must-revalidate"
      );

      headersToOrigin.set("Pragma", "no-cache");
    }

    // Range إذا احتاجه المصدر
    const range = request.headers.get("Range");

    if (range) {
      headersToOrigin.set("Range", range);
    }

    try {

      const upstream = await fetch(targetUrl, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: headersToOrigin,
        redirect: "follow",
        cache: isPlaylist ? "no-store" : "no-cache"
      });

      // لا تحوّل الأخطاء إلى بث وهمي
      if (!upstream.ok && upstream.status !== 206) {
        const headers = new Headers(cors);

        headers.set(
          "Content-Type",
          upstream.headers.get("Content-Type") ||
          "text/plain"
        );

        return new Response(upstream.body, {
          status: upstream.status,
          headers
        });
      }

      const outHeaders = new Headers(upstream.headers);

      for (const [k, v] of Object.entries(cors)) {
        outHeaders.set(k, v);
      }

      if (!isPlaylist) {

        // مهم جداً:
        // لا تجبر كل شيء على video/mp2t
        //
        // AES key قد يكون application/octet-stream
        // fMP4 قد يكون video/mp4
        // m4s قد يكون video/iso.segment
        // TS غالباً video/mp2t

        return new Response(upstream.body, {
          status: upstream.status,
          headers: outHeaders
        });
      }

      // =========================================================
      // Rewrite HLS playlist
      // =========================================================

      outHeaders.set(
        "Content-Type",
        "application/vnd.apple.mpegurl; charset=utf-8"
      );

      outHeaders.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, max-age=0"
      );

      outHeaders.set("Pragma", "no-cache");
      outHeaders.set("Expires", "0");

      outHeaders.delete("Content-Length");
      outHeaders.delete("ETag");
      outHeaders.delete("Last-Modified");
      outHeaders.delete("Age");

      let playlist = await upstream.text();

      const base = new URL(targetUrl);

      function proxyURL(value) {
        const absolute = new URL(value, base).href;

        return (
          incomingUrl.origin +
          incomingUrl.pathname +
          "?url=" +
          encodeURIComponent(absolute) +
          "&ref=" +
          encodeURIComponent(referer) +
          "&ua=" +
          encodeURIComponent(userAgent)
        );
      }

      const lines = playlist.split(/\r?\n/);

      const rewritten = lines.map(originalLine => {

        const line = originalLine.trim();

        if (!line) {
          return originalLine;
        }

        // Segment / nested playlist
        if (!line.startsWith("#")) {
          return proxyURL(line);
        }

        // أي TAG داخله URI=""
        //
        // يدعم:
        // EXT-X-KEY
        // EXT-X-MAP
        // EXT-X-MEDIA
        // EXT-X-I-FRAME-STREAM-INF
        // EXT-X-PART
        // EXT-X-PRELOAD-HINT
        // EXT-X-RENDITION-REPORT
        //
        if (/URI="/i.test(line)) {

          return originalLine.replace(
            /URI="([^"]+)"/gi,
            (_, uri) => {
              return `URI="${proxyURL(uri)}"`;
            }
          );
        }

        return originalLine;

      }).join("\n");

      return new Response(rewritten, {
        status: 200,
        headers: outHeaders
      });

    } catch (e) {

      return new Response(
        "Worker Proxy Error: " + e.message,
        {
          status: 502,
          headers: cors
        }
      );
    }
  }
};
