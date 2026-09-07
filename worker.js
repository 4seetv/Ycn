export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);

    const targetUrl =
      "http://45.137.151.100:8000" +
      incomingUrl.pathname +
      incomingUrl.search;

    const headers = new Headers(request.headers);

    // مهم حتى لا يصل Host الخاص بـ workers.dev للسيرفر الأصلي
    headers.delete("host");

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? null
          : request.body,
      redirect: "manual"
    });

    const responseHeaders = new Headers(response.headers);

    // منع بعض الهيدرز التي قد تسبب مشاكل عبر البروكسي
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  }
};
