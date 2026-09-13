/**
 * Enlil Relay Hub
 * Cloudflare Worker + D1
 *
 * D1 Binding:
 * DB
 *
 * Secrets:
 * ADMIN_PASSWORD
 * SIGNING_SECRET
 *
 * استخدمه فقط مع مصادر البث المصرح لك بإعادة توزيعها.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Accept-Ranges"
};

const FORBIDDEN_HEADERS = new Set([
    "connection",
    "host",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "keep-alive"
]);

function toBase64Url(buffer) {
    let binary = "";

    for (const byte of new Uint8Array(buffer)) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function fromBase64Url(value) {
    let normalized = value
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    while (normalized.length % 4) {
        normalized += "=";
    }

    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

function jsonResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...headers
        }
    });
}

function streamResponse(body, status = 200, headers = {}) {
    return new Response(body, {
        status,
        headers: {
            ...CORS,
            ...headers
        }
    });
}

async function getEncryptionKey(secret) {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(secret)
    );

    return crypto.subtle.importKey(
        "raw",
        digest,
        "AES-GCM",
        false,
        ["encrypt", "decrypt"]
    );
}

async function encryptTicket(data, secret) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await getEncryptionKey(secret);

    const encrypted = await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv
        },
        key,
        encoder.encode(JSON.stringify(data))
    );

    const output = new Uint8Array(12 + encrypted.byteLength);

    output.set(iv);
    output.set(new Uint8Array(encrypted), 12);

    return toBase64Url(output);
}

async function decryptTicket(ticket, secret) {
    const bytes = fromBase64Url(ticket);

    if (bytes.length < 13) {
        throw new Error("invalid_ticket");
    }

    const iv = bytes.slice(0, 12);
    const encrypted = bytes.slice(12);
    const key = await getEncryptionKey(secret);

    const decrypted = await crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv
        },
        key,
        encrypted
    );

    const data = JSON.parse(decoder.decode(decrypted));

    if (!data.exp || Date.now() > data.exp) {
        throw new Error("expired_link");
    }

    return data;
}

async function createSignature(value, secret) {
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        {
            name: "HMAC",
            hash: "SHA-256"
        },
        false,
        ["sign"]
    );

    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(value)
    );

    return toBase64Url(signature);
}

async function initializeDatabase(env) {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS streams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            category TEXT DEFAULT '',
            url TEXT NOT NULL,
            kind TEXT DEFAULT 'hls',
            user_agent TEXT DEFAULT '',
            referer TEXT DEFAULT '',
            origin TEXT DEFAULT '',
            authorization TEXT DEFAULT '',
            cookie TEXT DEFAULT '',
            extra_headers TEXT DEFAULT '{}',
            backup_url TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `).run();
}

function cleanSlug(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 60);
}

function isValidUrl(value) {
    try {
        const url = new URL(value);

        return (
            url.protocol === "http:" ||
            url.protocol === "https:"
        );
    } catch {
        return false;
    }
}

function buildUpstreamHeaders(stream, request) {
    const headers = new Headers({
        "Accept": "*/*"
    });

    const standardHeaders = [
        ["User-Agent", stream.user_agent],
        ["Referer", stream.referer],
        ["Origin", stream.origin],
        ["Authorization", stream.authorization],
        ["Cookie", stream.cookie]
    ];

    for (const [name, value] of standardHeaders) {
        if (value) {
            headers.set(name, value);
        }
    }

    try {
        const extraHeaders = JSON.parse(
            stream.extra_headers || "{}"
        );

        for (const [name, value] of Object.entries(extraHeaders)) {
            if (
                value &&
                !FORBIDDEN_HEADERS.has(name.toLowerCase())
            ) {
                headers.set(
                    name,
                    String(value).slice(0, 4096)
                );
            }
        }
    } catch {
        // تجاهل الهيدرز الإضافية غير الصالحة
    }

    const range = request.headers.get("Range");

    if (range) {
        headers.set("Range", range);
    }

    return headers;
}

async function fetchUpstream(sourceUrl, stream, request) {
    if (!isValidUrl(sourceUrl)) {
        throw new Error("invalid_source");
    }

    const headers = buildUpstreamHeaders(stream, request);

    const method =
        request.method === "HEAD" ? "HEAD" : "GET";

    let currentUrl = sourceUrl;

    let response = await fetch(currentUrl, {
        method,
        headers,
        redirect: "manual"
    });

    for (
        let attempt = 0;
        attempt < 4 &&
        response.status >= 300 &&
        response.status < 400;
        attempt++
    ) {
        const location = response.headers.get("Location");

        if (!location) {
            break;
        }

        currentUrl = new URL(
            location,
            currentUrl
        ).href;

        response = await fetch(currentUrl, {
            method,
            headers,
            redirect: "manual"
        });
    }

    return {
        response,
        finalUrl: currentUrl
    };
}

async function createResourceUrl(
    resourceUrl,
    stream,
    env,
    workerOrigin
) {
    const ticketData = {
        url: resourceUrl,
        exp: Date.now() + 6 * 60 * 60 * 1000,

        headers: {
            user_agent: stream.user_agent || "",
            referer: stream.referer || "",
            origin: stream.origin || "",
            authorization: stream.authorization || "",
            cookie: stream.cookie || "",
            extra_headers: stream.extra_headers || "{}"
        }
    };

    const ticket = await encryptTicket(
        ticketData,
        env.SIGNING_SECRET
    );

    return `${workerOrigin}/p?t=${ticket}`;
}

async function rewriteHlsManifest(
    manifestText,
    manifestUrl,
    stream,
    env,
    workerOrigin
) {
    const output = [];
    const lines = manifestText.split(/\r?\n/);

    for (let line of lines) {
        const isTagWithUri =
            /^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF)/.test(
                line
            );

        if (isTagWithUri) {
            const match = line.match(/URI="([^"]+)"/);

            if (match) {
                const absoluteUrl = new URL(
                    match[1],
                    manifestUrl
                ).href;

                const proxiedUrl = await createResourceUrl(
                    absoluteUrl,
                    stream,
                    env,
                    workerOrigin
                );

                line = line.replace(
                    match[1],
                    proxiedUrl
                );
            }

            output.push(line);
            continue;
        }

        if (line.trim() && !line.startsWith("#")) {
            const absoluteUrl = new URL(
                line.trim(),
                manifestUrl
            ).href;

            const proxiedUrl = await createResourceUrl(
                absoluteUrl,
                stream,
                env,
                workerOrigin
            );

            output.push(proxiedUrl);
            continue;
        }

        output.push(line);
    }

    return output.join("\n");
}

async function relayStream(
    sourceUrl,
    stream,
    request,
    env
) {
    const {
        response,
        finalUrl
    } = await fetchUpstream(
        sourceUrl,
        stream,
        request
    );

    const contentType = (
        response.headers.get("Content-Type") || ""
    ).toLowerCase();

    const isHls =
        contentType.includes("mpegurl") ||
        finalUrl.toLowerCase().includes(".m3u8");

    if (isHls) {
        const originalManifest = await response.text();

        const rewrittenManifest =
            await rewriteHlsManifest(
                originalManifest,
                finalUrl,
                stream,
                env,
                new URL(request.url).origin
            );

        return streamResponse(
            rewrittenManifest,
            response.status,
            {
                "Content-Type":
                    "application/vnd.apple.mpegurl; charset=utf-8",

                "Cache-Control": "no-store"
            }
        );
    }

    const responseHeaders = {
        "Content-Type":
            response.headers.get("Content-Type") ||
            "application/octet-stream",

        "Cache-Control":
            response.headers.get("Cache-Control") ||
            "no-store"
    };

    const forwardedHeaders = [
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
        "ETag",
        "Last-Modified"
    ];

    for (const name of forwardedHeaders) {
        const value = response.headers.get(name);

        if (value) {
            responseHeaders[name] = value;
        }
    }

    return streamResponse(
        response.body,
        response.status,
        responseHeaders
    );
}

async function isAdminAuthenticated(request, env) {
    const cookie = request.headers.get("Cookie") || "";

    const match = cookie.match(
        /(?:^|;\s*)enlil_admin=([^;]+)/
    );

    if (!match) {
        return false;
    }

    const [expires, signature] =
        match[1].split(".");

    if (
        !expires ||
        !signature ||
        Number(expires) <= Date.now()
    ) {
        return false;
    }

    const expectedSignature =
        await createSignature(
            expires,
            env.SIGNING_SECRET
        );

    return signature === expectedSignature;
}

function isSameOrigin(request) {
    const origin = request.headers.get("Origin");

    return (
        !origin ||
        origin === new URL(request.url).origin
    );
}

const ADMIN_PAGE = `
<!doctype html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="utf-8">

    <meta
        name="viewport"
        content="width=device-width,initial-scale=1,maximum-scale=1"
    >

    <meta name="theme-color" content="#07080b">

    <title>Enlil Relay</title>

    <style>
        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            background: #07080b;
            color: #fff;
            font-family:
                -apple-system,
                BlinkMacSystemFont,
                "Segoe UI",
                Tahoma,
                sans-serif;
        }

        .wrapper {
            max-width: 900px;
            margin: auto;
            padding: 22px;
        }

        .header,
        .stream-row,
        .actions {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .header {
            margin-bottom: 20px;
        }

        .logo {
            width: 44px;
            height: 44px;
            border-radius: 14px;
            background:
                linear-gradient(
                    135deg,
                    #168cff,
                    #655cff
                );

            display: grid;
            place-items: center;
            font-weight: 900;
            box-shadow:
                0 8px 28px rgba(22, 140, 255, .3);
        }

        .grow {
            flex: 1;
            min-width: 0;
        }

        .card {
            background: #15171d;
            border: 1px solid #272a34;
            border-radius: 22px;
            padding: 18px;
            margin-bottom: 14px;
        }

        .grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }

        .wide {
            grid-column: 1 / -1;
        }

        label {
            font-size: 12px;
            color: #a9adba;
        }

        .input {
            width: 100%;
            margin-top: 6px;
            padding: 13px;
            border: 1px solid #303440;
            border-radius: 13px;
            background: #0c0e13;
            color: #fff;
            outline: none;
            font: inherit;
        }

        .input:focus {
            border-color: #168cff;
            box-shadow:
                0 0 0 3px rgba(22, 140, 255, .12);
        }

        .button {
            border: 0;
            border-radius: 12px;
            padding: 11px 14px;
            background: #168cff;
            color: #fff;
            font-weight: 700;
            cursor: pointer;
        }

        .button:active {
            transform: scale(.97);
        }

        .secondary {
            background: #292c35;
        }

        .danger {
            background: rgba(255, 69, 58, .14);
            color: #ff6961;
        }

        .stream-row {
            padding: 13px 0;
            border-bottom: 1px solid #292c35;
        }

        .stream-row:last-child {
            border-bottom: 0;
        }

        .stream-name {
            display: block;
            margin-bottom: 5px;
        }

        .stream-url {
            display: block;
            color: #8e93a2;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            direction: ltr;
            text-align: right;
        }

        .muted {
            color: #8e93a2;
            font-size: 13px;
        }

        .login {
            max-width: 350px;
            margin: 15vh auto;
        }

        .hidden {
            display: none;
        }

        .toast {
            position: fixed;
            bottom: 25px;
            left: 50%;
            transform:
                translate(-50%, 20px);

            opacity: 0;
            pointer-events: none;
            background: #fff;
            color: #000;
            padding: 10px 18px;
            border-radius: 24px;
            transition: .2s;
            z-index: 100;
        }

        .toast.active {
            opacity: 1;
            transform:
                translate(-50%, 0);
        }

        @media (max-width: 650px) {
            .grid {
                grid-template-columns: 1fr;
            }

            .wide {
                grid-column: auto;
            }

            .stream-row {
                align-items: flex-start;
                flex-wrap: wrap;
            }
        }
    </style>
</head>

<body>
    <div class="wrapper">
        <section id="loginScreen" class="card login">
            <div class="header">
                <div class="logo">E</div>

                <div>
                    <strong>Enlil Relay</strong>
                    <div class="muted">
                        لوحة الإدارة السرية
                    </div>
                </div>
            </div>

            <input
                id="password"
                class="input"
                type="password"
                placeholder="كلمة المرور"
            >

            <button
                class="button"
                style="width:100%;margin-top:10px"
                onclick="login()"
            >
                دخول
            </button>
        </section>

        <main id="application" class="hidden">
            <header class="header">
                <div class="logo">E</div>

                <div class="grow">
                    <strong>مركز روابط البث</strong>

                    <div class="muted">
                        روابط ثابتة وإدارة الهيدرز
                    </div>
                </div>

                <button
                    class="button secondary"
                    onclick="logout()"
                >
                    خروج
                </button>
            </header>

            <form
                id="streamForm"
                class="card"
                onsubmit="saveStream(event)"
            >
                <input
                    type="hidden"
                    name="id"
                >

                <div class="grid">
                    <label>
                        اسم البث

                        <input
                            class="input"
                            name="name"
                            required
                        >
                    </label>

                    <label>
                        اسم الرابط بالإنجليزية

                        <input
                            class="input"
                            name="slug"
                            placeholder="bein1"
                            pattern="[a-zA-Z0-9_-]+"
                            required
                        >
                    </label>

                    <label>
                        التصنيف

                        <input
                            class="input"
                            name="category"
                            placeholder="رياضة"
                        >
                    </label>

                    <label>
                        نوع الرابط

                        <select
                            class="input"
                            name="kind"
                        >
                            <option value="hls">
                                HLS / M3U8
                            </option>

                            <option value="dash">
                                DASH / MPD
                            </option>

                            <option value="video">
                                MP4 / Video
                            </option>
                        </select>
                    </label>

                    <label class="wide">
                        رابط المصدر

                        <input
                            class="input"
                            name="url"
                            dir="ltr"
                            required
                        >
                    </label>

                    <label class="wide">
                        رابط احتياطي

                        <input
                            class="input"
                            name="backup_url"
                            dir="ltr"
                        >
                    </label>

                    <label class="wide">
                        User-Agent

                        <input
                            class="input"
                            name="user_agent"
                            dir="ltr"
                        >
                    </label>

                    <label>
                        Referer

                        <input
                            class="input"
                            name="referer"
                            dir="ltr"
                        >
                    </label>

                    <label>
                        Origin

                        <input
                            class="input"
                            name="origin"
                            dir="ltr"
                        >
                    </label>

                    <label class="wide">
                        Authorization

                        <input
                            class="input"
                            name="authorization"
                            dir="ltr"
                        >
                    </label>

                    <label class="wide">
                        Cookie

                        <input
                            class="input"
                            name="cookie"
                            dir="ltr"
                        >
                    </label>

                    <label class="wide">
                        Headers إضافية بصيغة JSON

                        <input
                            class="input"
                            name="extra_headers"
                            value="{}"
                            dir="ltr"
                        >
                    </label>

                    <label>
                        الحالة

                        <select
                            class="input"
                            name="active"
                        >
                            <option value="1">
                                مفعل
                            </option>

                            <option value="0">
                                متوقف
                            </option>
                        </select>
                    </label>

                    <div class="actions">
                        <button class="button">
                            حفظ البث
                        </button>

                        <button
                            type="button"
                            class="button secondary"
                            onclick="resetForm()"
                        >
                            بث جديد
                        </button>
                    </div>
                </div>
            </form>

            <section class="card">
                <h3>الروابط المحفوظة</h3>
                <div id="streamsList"></div>
            </section>
        </main>
    </div>

    <div id="toast" class="toast"></div>

    <script>
        const $ = selector =>
            document.querySelector(selector);

        let streams = [];

        async function api(url, options = {}) {
            options.headers = {
                "Content-Type": "application/json",
                ...(options.headers || {})
            };

            const response = await fetch(
                url,
                options
            );

            const data = await response
                .json()
                .catch(() => ({}));

            if (!response.ok) {
                throw new Error(
                    data.error || "حدث خطأ"
                );
            }

            return data;
        }

        function toast(message) {
            const element = $("#toast");

            element.textContent = message;
            element.classList.add("active");

            setTimeout(() => {
                element.classList.remove("active");
            }, 2200);
        }

        function escapeHtml(value) {
            return String(value ?? "")
                .replace(
                    /[&<>"']/g,
                    character => ({
                        "&": "&amp;",
                        "<": "&lt;",
                        ">": "&gt;",
                        '"': "&quot;",
                        "'": "&#39;"
                    })[character]
                );
        }

        function playbackUrl(stream) {
            const extension =
                stream.kind === "hls"
                    ? ".m3u8"
                    : "";

            return (
                location.origin +
                "/live/" +
                stream.slug +
                extension
            );
        }

        async function login() {
            try {
                await api("/api/login", {
                    method: "POST",

                    body: JSON.stringify({
                        password:
                            $("#password").value
                    })
                });

                await loadStreams();
            } catch {
                toast("كلمة المرور غير صحيحة");
            }
        }

        async function loadStreams() {
            try {
                const data =
                    await api("/api/streams");

                streams = data.streams || [];

                $("#loginScreen")
                    .classList.add("hidden");

                $("#application")
                    .classList.remove("hidden");

                renderStreams();
            } catch {
                // المستخدم لم يسجل الدخول بعد
            }
        }

        function renderStreams() {
            const container = $("#streamsList");

            if (!streams.length) {
                container.innerHTML =
                    '<p class="muted">لا توجد روابط بعد.</p>';

                return;
            }

            container.innerHTML = streams
                .map(stream => `
                    <div class="stream-row">
                        <div class="grow">
                            <strong class="stream-name">
                                ${escapeHtml(stream.name)}
                                ·
                                ${escapeHtml(
                                    stream.category ||
                                    stream.kind
                                )}
                            </strong>

                            <small class="stream-url">
                                ${escapeHtml(
                                    playbackUrl(stream)
                                )}
                            </small>
                        </div>

                        <button
                            class="button secondary"
                            onclick="copyStream(${stream.id})"
                        >
                            نسخ
                        </button>

                        <button
                            class="button secondary"
                            onclick="editStream(${stream.id})"
                        >
                            تعديل
                        </button>

                        <button
                            class="button danger"
                            onclick="deleteStream(${stream.id})"
                        >
                            حذف
                        </button>
                    </div>
                `)
                .join("");
        }

        function copyStream(id) {
            const stream = streams.find(
                item => item.id === id
            );

            if (!stream) {
                return;
            }

            navigator.clipboard.writeText(
                playbackUrl(stream)
            );

            toast("تم نسخ الرابط");
        }

        function editStream(id) {
            const stream = streams.find(
                item => item.id === id
            );

            if (!stream) {
                return;
            }

            const form = $("#streamForm");

            for (
                const [name, value]
                of Object.entries(stream)
            ) {
                if (form.elements[name]) {
                    form.elements[name].value =
                        value ?? "";
                }
            }

            window.scrollTo({
                top: 0,
                behavior: "smooth"
            });
        }

        async function saveStream(event) {
            event.preventDefault();

            const form = event.target;

            const data = Object.fromEntries(
                new FormData(form)
            );

            try {
                JSON.parse(
                    data.extra_headers || "{}"
                );
            } catch {
                toast(
                    "صيغة Headers JSON غير صحيحة"
                );

                return;
            }

            try {
                await api("/api/streams", {
                    method: "POST",
                    body: JSON.stringify(data)
                });

                toast("تم حفظ البث");

                resetForm();
                await loadStreams();
            } catch (error) {
                toast(error.message);
            }
        }

        async function deleteStream(id) {
            if (!confirm("تأكيد حذف هذا البث؟")) {
                return;
            }

            try {
                await api(
                    "/api/streams/" + id,
                    {
                        method: "DELETE"
                    }
                );

                toast("تم حذف البث");
                await loadStreams();
            } catch (error) {
                toast(error.message);
            }
        }

        function resetForm() {
            const form = $("#streamForm");

            form.reset();
            form.elements.id.value = "";
            form.elements.extra_headers.value =
                "{}";
        }

        async function logout() {
            await api("/api/logout", {
                method: "POST"
            });

            location.reload();
        }

        $("#password").addEventListener(
            "keydown",
            event => {
                if (event.key === "Enter") {
                    login();
                }
            }
        );

        loadStreams();
    </script>
</body>
</html>
`;

export default {
    async fetch(request, env) {
        try {
            if (
                !env.DB ||
                !env.ADMIN_PASSWORD ||
                !env.SIGNING_SECRET
            ) {
                return jsonResponse(
                    {
                        error:
                            "missing_bindings"
                    },
                    500
                );
            }

            await initializeDatabase(env);

            const requestUrl =
                new URL(request.url);

            const path = requestUrl.pathname;

            if (request.method === "OPTIONS") {
                return streamResponse(null, 204);
            }

            if (
                path === "/" ||
                path === "/admin"
            ) {
                return new Response(
                    ADMIN_PAGE,
                    {
                        headers: {
                            "Content-Type":
                                "text/html; charset=utf-8",

                            "Cache-Control":
                                "no-store",

                            "X-Frame-Options":
                                "DENY",

                            "Referrer-Policy":
                                "no-referrer"
                        }
                    }
                );
            }

            if (
                path === "/api/login" &&
                request.method === "POST"
            ) {
                if (!isSameOrigin(request)) {
                    return jsonResponse(
                        {
                            error: "bad_origin"
                        },
                        403
                    );
                }

                const data =
                    await request.json();

                if (
                    String(data.password || "") !==
                    env.ADMIN_PASSWORD
                ) {
                    return jsonResponse(
                        {
                            error:
                                "invalid_password"
                        },
                        403
                    );
                }

                const expires = String(
                    Date.now() +
                    24 * 60 * 60 * 1000
                );

                const signature =
                    await createSignature(
                        expires,
                        env.SIGNING_SECRET
                    );

                return jsonResponse(
                    {
                        ok: true
                    },
                    200,
                    {
                        "Set-Cookie":
                            `enlil_admin=${expires}.${signature}; ` +
                            "HttpOnly; Secure; SameSite=Strict; " +
                            "Path=/; Max-Age=86400"
                    }
                );
            }

            if (
                path === "/api/logout" &&
                request.method === "POST"
            ) {
                return jsonResponse(
                    {
                        ok: true
                    },
                    200,
                    {
                        "Set-Cookie":
                            "enlil_admin=; " +
                            "HttpOnly; Secure; SameSite=Strict; " +
                            "Path=/; Max-Age=0"
                    }
                );
            }

            if (path === "/api/streams") {
                const authenticated =
                    await isAdminAuthenticated(
                        request,
                        env
                    );

                if (!authenticated) {
                    return jsonResponse(
                        {
                            error: "unauthorized"
                        },
                        401
                    );
                }

                if (request.method === "GET") {
                    const result =
                        await env.DB.prepare(`
                            SELECT *
                            FROM streams
                            ORDER BY category, name
                        `).all();

                    return jsonResponse({
                        streams:
                            result.results || []
                    });
                }

                if (request.method === "POST") {
                    if (!isSameOrigin(request)) {
                        return jsonResponse(
                            {
                                error:
                                    "bad_origin"
                            },
                            403
                        );
                    }

                    const data =
                        await request.json();

                    const streamSlug =
                        cleanSlug(data.slug);

                    if (
                        !streamSlug ||
                        !isValidUrl(data.url) ||
                        (
                            data.backup_url &&
                            !isValidUrl(
                                data.backup_url
                            )
                        )
                    ) {
                        return jsonResponse(
                            {
                                error:
                                    "بيانات الرابط غير صحيحة"
                            },
                            400
                        );
                    }

                    try {
                        JSON.parse(
                            data.extra_headers ||
                            "{}"
                        );
                    } catch {
                        return jsonResponse(
                            {
                                error:
                                    "صيغة JSON غير صحيحة"
                            },
                            400
                        );
                    }

                    const kind = [
                        "hls",
                        "dash",
                        "video"
                    ].includes(data.kind)
                        ? data.kind
                        : "hls";

                    const values = [
                        String(
                            data.name ||
                            streamSlug
                        ).slice(0, 100),

                        streamSlug,

                        String(
                            data.category || ""
                        ).slice(0, 80),

                        kind,
                        data.url,
                        data.user_agent || "",
                        data.referer || "",
                        data.origin || "",
                        data.authorization || "",
                        data.cookie || "",

                        data.extra_headers ||
                            "{}",

                        data.backup_url || "",

                        Number(data.active) !== 0
                            ? 1
                            : 0
                    ];

                    const id =
                        Number(data.id) || 0;

                    if (id) {
                        await env.DB.prepare(`
                            UPDATE streams
                            SET
                                name = ?,
                                slug = ?,
                                category = ?,
                                kind = ?,
                                url = ?,
                                user_agent = ?,
                                referer = ?,
                                origin = ?,
                                authorization = ?,
                                cookie = ?,
                                extra_headers = ?,
                                backup_url = ?,
                                active = ?,
                                updated_at =
                                    CURRENT_TIMESTAMP
                            WHERE id = ?
                        `)
                            .bind(
                                ...values,
                                id
                            )
                            .run();
                    } else {
                        await env.DB.prepare(`
                            INSERT INTO streams (
                                name,
                                slug,
                                category,
                                kind,
                                url,
                                user_agent,
                                referer,
                                origin,
                                authorization,
                                cookie,
                                extra_headers,
                                backup_url,
                                active
                            )
                            VALUES (
                                ?, ?, ?, ?, ?, ?,
                                ?, ?, ?, ?, ?, ?,
                                ?
                            )
                        `)
                            .bind(...values)
                            .run();
                    }

                    return jsonResponse({
                        ok: true
                    });
                }
            }

            if (
                path.startsWith(
                    "/api/streams/"
                ) &&
                request.method === "DELETE"
            ) {
                const authenticated =
                    await isAdminAuthenticated(
                        request,
                        env
                    );

                if (
                    !authenticated ||
                    !isSameOrigin(request)
                ) {
                    return jsonResponse(
                        {
                            error: "unauthorized"
                        },
                        401
                    );
                }

                const id = Number(
                    path.split("/").pop()
                );

                await env.DB.prepare(`
                    DELETE FROM streams
                    WHERE id = ?
                `)
                    .bind(id)
                    .run();

                return jsonResponse({
                    ok: true
                });
            }

            if (path.startsWith("/live/")) {
                const filename =
                    path.split("/").pop();

                const streamSlug =
                    cleanSlug(
                        filename.replace(
                            /\.m3u8$/i,
                            ""
                        )
                    );

                const stream =
                    await env.DB.prepare(`
                        SELECT *
                        FROM streams
                        WHERE slug = ?
                        AND active = 1
                    `)
                        .bind(streamSlug)
                        .first();

                if (!stream) {
                    return jsonResponse(
                        {
                            error:
                                "stream_not_found"
                        },
                        404
                    );
                }

                try {
                    return await relayStream(
                        stream.url,
                        stream,
                        request,
                        env
                    );
                } catch (primaryError) {
                    if (stream.backup_url) {
                        try {
                            return await relayStream(
                                stream.backup_url,
                                stream,
                                request,
                                env
                            );
                        } catch {
                            // انتقل للخطأ الرئيسي
                        }
                    }

                    throw primaryError;
                }
            }

            if (path === "/p") {
                const ticket =
                    requestUrl.searchParams.get(
                        "t"
                    );

                const ticketData =
                    await decryptTicket(
                        ticket || "",
                        env.SIGNING_SECRET
                    );

                return relayStream(
                    ticketData.url,
                    ticketData.headers,
                    request,
                    env
                );
            }

            return jsonResponse(
                {
                    error: "not_found"
                },
                404
            );
        } catch (error) {
            return jsonResponse(
                {
                    error: String(
                        error.message ||
                        error
                    )
                },
                502
            );
        }
    }
};
