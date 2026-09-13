/**
 * Enlil Relay Hub
 * Cloudflare Worker + D1
 *
 * D1 binding: DB
 * Secrets:
 * ADMIN_PASSWORD
 * SIGNING_SECRET
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Accept-Ranges"
};

const BLOCKED_HEADERS = new Set([
    "connection",
    "host",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "keep-alive"
]);

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

function proxyResponse(body, status = 200, headers = {}) {
    return new Response(body, {
        status,
        headers: {
            ...CORS_HEADERS,
            ...headers
        }
    });
}

function encodeBase64Url(buffer) {
    let binary = "";

    for (const byte of new Uint8Array(buffer)) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
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
    const iv = crypto.getRandomValues(
        new Uint8Array(12)
    );

    const key = await getEncryptionKey(secret);

    const encrypted = await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv
        },
        key,
        encoder.encode(JSON.stringify(data))
    );

    const output = new Uint8Array(
        12 + encrypted.byteLength
    );

    output.set(iv);
    output.set(new Uint8Array(encrypted), 12);

    return encodeBase64Url(output);
}

async function decryptTicket(ticket, secret) {
    if (!ticket) {
        throw new Error("missing_ticket");
    }

    const bytes = decodeBase64Url(ticket);

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

    const data = JSON.parse(
        decoder.decode(decrypted)
    );

    if (!data.exp || Date.now() > data.exp) {
        throw new Error("expired_ticket");
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

    return encodeBase64Url(signature);
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
        const parsed = new URL(value);

        return (
            parsed.protocol === "http:" ||
            parsed.protocol === "https:"
        );
    } catch {
        return false;
    }
}

function buildSourceHeaders(stream, request) {
    const headers = new Headers({
        "Accept": "*/*"
    });

    const configuredHeaders = [
        ["User-Agent", stream.user_agent],
        ["Referer", stream.referer],
        ["Origin", stream.origin],
        ["Authorization", stream.authorization],
        ["Cookie", stream.cookie]
    ];

    for (const [name, value] of configuredHeaders) {
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
                !BLOCKED_HEADERS.has(name.toLowerCase())
            ) {
                headers.set(
                    name,
                    String(value).slice(0, 4096)
                );
            }
        }
    } catch {
        // تجاهل JSON غير الصالح
    }

    const range = request.headers.get("Range");

    if (range) {
        headers.set("Range", range);
    }

    return headers;
}

async function fetchSource(sourceUrl, stream, request) {
    if (!isValidUrl(sourceUrl)) {
        throw new Error("invalid_source_url");
    }

    const headers = buildSourceHeaders(
        stream,
        request
    );

    const method =
        request.method === "HEAD" ? "HEAD" : "GET";

    let currentUrl = sourceUrl;

    let response = await fetch(currentUrl, {
        method,
        headers,
        redirect: "manual"
    });

    for (
        let redirect = 0;
        redirect < 5 &&
        response.status >= 300 &&
        response.status < 400;
        redirect++
    ) {
        const location =
            response.headers.get("Location");

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

async function createResourceLink(
    resourceUrl,
    stream,
    env,
    workerOrigin
) {
    const ticket = await encryptTicket(
        {
            url: resourceUrl,

            exp:
                Date.now() +
                6 * 60 * 60 * 1000,

            headers: {
                user_agent:
                    stream.user_agent || "",

                referer:
                    stream.referer || "",

                origin:
                    stream.origin || "",

                authorization:
                    stream.authorization || "",

                cookie:
                    stream.cookie || "",

                extra_headers:
                    stream.extra_headers || "{}"
            }
        },
        env.SIGNING_SECRET
    );

    return (
        workerOrigin +
        "/p?t=" +
        ticket
    );
}

async function rewriteHlsManifest(
    manifest,
    manifestUrl,
    stream,
    env,
    workerOrigin
) {
    const result = [];
    const lines = manifest.split(/\r?\n/);

    for (let line of lines) {
        const tagWithUri =
            /^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF)/.test(
                line
            );

        if (tagWithUri) {
            const match = line.match(
                /URI="([^"]+)"/
            );

            if (match) {
                const absoluteUrl = new URL(
                    match[1],
                    manifestUrl
                ).href;

                const workerUrl =
                    await createResourceLink(
                        absoluteUrl,
                        stream,
                        env,
                        workerOrigin
                    );

                line = line.replace(
                    match[1],
                    workerUrl
                );
            }

            result.push(line);
            continue;
        }

        if (
            line.trim() &&
            !line.startsWith("#")
        ) {
            const absoluteUrl = new URL(
                line.trim(),
                manifestUrl
            ).href;

            result.push(
                await createResourceLink(
                    absoluteUrl,
                    stream,
                    env,
                    workerOrigin
                )
            );

            continue;
        }

        result.push(line);
    }

    return result.join("\n");
}

async function relay(
    sourceUrl,
    stream,
    request,
    env
) {
    const {
        response,
        finalUrl
    } = await fetchSource(
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
        const originalManifest =
            await response.text();

        const rewrittenManifest =
            await rewriteHlsManifest(
                originalManifest,
                finalUrl,
                stream,
                env,
                new URL(request.url).origin
            );

        return proxyResponse(
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
        const value =
            response.headers.get(name);

        if (value) {
            responseHeaders[name] = value;
        }
    }

    return proxyResponse(
        response.body,
        response.status,
        responseHeaders
    );
}

async function isAdmin(request, env) {
    const cookies =
        request.headers.get("Cookie") || "";

    const match = cookies.match(
        /(?:^|;\s*)enlil_admin=([^;]+)/
    );

    if (!match) {
        return false;
    }

    const parts = match[1].split(".");

    if (parts.length !== 2) {
        return false;
    }

    const expires = parts[0];
    const signature = parts[1];

    if (Number(expires) <= Date.now()) {
        return false;
    }

    const expected =
        await createSignature(
            expires,
            env.SIGNING_SECRET
        );

    return signature === expected;
}

function sameOrigin(request) {
    const origin =
        request.headers.get("Origin");

    return (
        !origin ||
        origin === new URL(request.url).origin
    );
}

const ADMIN_PAGE = String.raw`
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
            min-height: 100vh;
            background: #07080b;
            color: #fff;
            font-family:
                -apple-system,
                BlinkMacSystemFont,
                "Segoe UI",
                Tahoma,
                sans-serif;
        }

        button,
        input,
        select {
            font: inherit;
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
            flex: 0 0 44px;
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
                0 8px 28px
                rgba(22, 140, 255, .3);
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
        }

        .input:focus {
            border-color: #168cff;
            box-shadow:
                0 0 0 3px
                rgba(22, 140, 255, .12);
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
            background:
                rgba(255, 69, 58, .14);

            color: #ff6961;
        }

        .stream-row {
            padding: 13px 0;
            border-bottom:
                1px solid #292c35;
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
        <section
            id="loginScreen"
            class="card login"
        >
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

        <main
            id="application"
            class="hidden"
        >
            <header class="header">
                <div class="logo">E</div>

                <div class="grow">
                    <strong>
                        مركز روابط البث
                    </strong>

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
                            onclick="resetStreamForm()"
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
        var streams = [];

        function findElement(selector) {
            return document.querySelector(
                selector
            );
        }

        async function api(url, options) {
            options = options || {};

            options.headers = Object.assign(
                {
                    "Content-Type":
                        "application/json"
                },
                options.headers || {}
            );

            var response = await fetch(
                url,
                options
            );

            var data = await response
                .json()
                .catch(function () {
                    return {};
                });

            if (!response.ok) {
                throw new Error(
                    data.error || "حدث خطأ"
                );
            }

            return data;
        }

        function showToast(message) {
            var toast =
                findElement("#toast");

            toast.textContent = message;
            toast.classList.add("active");

            setTimeout(function () {
                toast.classList.remove(
                    "active"
                );
            }, 2200);
        }

        function escapeHtml(value) {
            return String(value || "")
                .replace(
                    /[&<>"']/g,
                    function (character) {
                        var characters = {
                            "&": "&amp;",
                            "<": "&lt;",
                            ">": "&gt;",
                            '"': "&quot;",
                            "'": "&#39;"
                        };

                        return characters[
                            character
                        ];
                    }
                );
        }

        function getPlaybackUrl(stream) {
            var extension =
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
                            findElement(
                                "#password"
                            ).value
                    })
                });

                await loadStreams();
            } catch (error) {
                showToast(
                    "كلمة المرور غير صحيحة"
                );
            }
        }

        async function loadStreams() {
            try {
                var data =
                    await api("/api/streams");

                streams =
                    data.streams || [];

                findElement("#loginScreen")
                    .classList.add("hidden");

                findElement("#application")
                    .classList.remove(
                        "hidden"
                    );

                renderStreams();
            } catch (error) {
                // لم يتم تسجيل الدخول
            }
        }

        function renderStreams() {
            var container =
                findElement("#streamsList");

            if (!streams.length) {
                container.innerHTML =
                    '<p class="muted">' +
                    'لا توجد روابط بعد.' +
                    '</p>';

                return;
            }

            var content = "";

            streams.forEach(function (stream) {
                content +=
                    '<div class="stream-row">' +

                        '<div class="grow">' +

                            '<strong class="stream-name">' +
                                escapeHtml(
                                    stream.name
                                ) +
                                ' · ' +
                                escapeHtml(
                                    stream.category ||
                                    stream.kind
                                ) +
                            '</strong>' +

                            '<small class="stream-url">' +
                                escapeHtml(
                                    getPlaybackUrl(
                                        stream
                                    )
                                ) +
                            '</small>' +

                        '</div>' +

                        '<button ' +
                            'class="button secondary" ' +
                            'onclick="copyStream(' +
                            Number(stream.id) +
                            ')">' +
                            'نسخ' +
                        '</button>' +

                        '<button ' +
                            'class="button secondary" ' +
                            'onclick="editStream(' +
                            Number(stream.id) +
                            ')">' +
                            'تعديل' +
                        '</button>' +

                        '<button ' +
                            'class="button danger" ' +
                            'onclick="deleteStream(' +
                            Number(stream.id) +
                            ')">' +
                            'حذف' +
                        '</button>' +

                    '</div>';
            });

            container.innerHTML = content;
        }

        function copyStream(id) {
            var stream = streams.find(
                function (item) {
                    return item.id === id;
                }
            );

            if (!stream) {
                return;
            }

            navigator.clipboard.writeText(
                getPlaybackUrl(stream)
            );

            showToast("تم نسخ الرابط");
        }

        function editStream(id) {
            var stream = streams.find(
                function (item) {
                    return item.id === id;
                }
            );

            if (!stream) {
                return;
            }

            var form =
                findElement("#streamForm");

            Object.keys(stream).forEach(
                function (name) {
                    if (form.elements[name]) {
                        form.elements[name].value =
                            stream[name] || "";
                    }
                }
            );

            window.scrollTo({
                top: 0,
                behavior: "smooth"
            });
        }

        async function saveStream(event) {
            event.preventDefault();

            var form = event.target;

            var data = Object.fromEntries(
                new FormData(form)
            );

            try {
                JSON.parse(
                    data.extra_headers || "{}"
                );
            } catch (error) {
                showToast(
                    "صيغة Headers JSON غير صحيحة"
                );

                return;
            }

            try {
                await api("/api/streams", {
                    method: "POST",
                    body: JSON.stringify(data)
                });

                showToast("تم حفظ البث");

                resetStreamForm();
                await loadStreams();
            } catch (error) {
                showToast(error.message);
            }
        }

        async function deleteStream(id) {
            if (
                !confirm(
                    "تأكيد حذف هذا البث؟"
                )
            ) {
                return;
            }

            try {
                await api(
                    "/api/streams/" + id,
                    {
                        method: "DELETE"
                    }
                );

                showToast("تم حذف البث");
                await loadStreams();
            } catch (error) {
                showToast(error.message);
            }
        }

        function resetStreamForm() {
            var form =
                findElement("#streamForm");

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

        findElement("#password")
            .addEventListener(
                "keydown",
                function (event) {
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

async function handleAdminApi(
    request,
    env,
    path
) {
    if (
        path === "/api/login" &&
        request.method === "POST"
    ) {
        if (!sameOrigin(request)) {
            return jsonResponse(
                {
                    error: "bad_origin"
                },
                403
            );
        }

        const body = await request.json();

        if (
            String(body.password || "") !==
            env.ADMIN_PASSWORD
        ) {
            return jsonResponse(
                {
                    error: "invalid_password"
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
                    "enlil_admin=" +
                    expires +
                    "." +
                    signature +
                    "; HttpOnly; Secure;" +
                    " SameSite=Strict;" +
                    " Path=/; Max-Age=86400"
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
                    "enlil_admin=;" +
                    " HttpOnly; Secure;" +
                    " SameSite=Strict;" +
                    " Path=/; Max-Age=0"
            }
        );
    }

    if (path === "/api/streams") {
        if (!(await isAdmin(request, env))) {
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
            if (!sameOrigin(request)) {
                return jsonResponse(
                    {
                        error: "bad_origin"
                    },
                    403
                );
            }

            const body =
                await request.json();

            const streamSlug =
                cleanSlug(body.slug);

            if (
                !streamSlug ||
                !isValidUrl(body.url) ||
                (
                    body.backup_url &&
                    !isValidUrl(
                        body.backup_url
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
                    body.extra_headers || "{}"
                );
            } catch {
                return jsonResponse(
                    {
                        error:
                            "صيغة Headers JSON غير صحيحة"
                    },
                    400
                );
            }

            const kind = [
                "hls",
                "dash",
                "video"
            ].includes(body.kind)
                ? body.kind
                : "hls";

            const values = [
                String(
                    body.name || streamSlug
                ).slice(0, 100),

                streamSlug,

                String(
                    body.category || ""
                ).slice(0, 80),

                kind,
                String(body.url),
                String(body.user_agent || ""),
                String(body.referer || ""),
                String(body.origin || ""),
                String(body.authorization || ""),
                String(body.cookie || ""),

                String(
                    body.extra_headers || "{}"
                ),

                String(body.backup_url || ""),

                Number(body.active) !== 0
                    ? 1
                    : 0
            ];

            const id =
                Number(body.id) || 0;

            try {
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
            } catch (error) {
                if (
                    String(error.message)
                        .toLowerCase()
                        .includes("unique")
                ) {
                    return jsonResponse(
                        {
                            error:
                                "اسم الرابط مستخدم مسبقًا"
                        },
                        409
                    );
                }

                throw error;
            }

            return jsonResponse({
                ok: true
            });
        }
    }

    if (
        path.startsWith("/api/streams/") &&
        request.method === "DELETE"
    ) {
        if (
            !(await isAdmin(request, env)) ||
            !sameOrigin(request)
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

        if (!Number.isInteger(id) || id <= 0) {
            return jsonResponse(
                {
                    error: "invalid_id"
                },
                400
            );
        }

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

    return null;
}

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
                            "missing_bindings",

                        required: [
                            "DB",
                            "ADMIN_PASSWORD",
                            "SIGNING_SECRET"
                        ]
                    },
                    500
                );
            }

            await initializeDatabase(env);

            const requestUrl =
                new URL(request.url);

            const path =
                requestUrl.pathname;

            if (request.method === "OPTIONS") {
                return proxyResponse(null, 204);
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

            if (path.startsWith("/api/")) {
                const apiResponse =
                    await handleAdminApi(
                        request,
                        env,
                        path
                    );

                if (apiResponse) {
                    return apiResponse;
                }
            }

            if (path.startsWith("/live/")) {
                const fileName =
                    path.split("/").pop();

                const streamSlug =
                    cleanSlug(
                        fileName.replace(
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
                    return await relay(
                        stream.url,
                        stream,
                        request,
                        env
                    );
                } catch (primaryError) {
                    if (stream.backup_url) {
                        try {
                            return await relay(
                                stream.backup_url,
                                stream,
                                request,
                                env
                            );
                        } catch {
                            // إظهار الخطأ الأساسي
                        }
                    }

                    throw primaryError;
                }
            }

            if (path === "/p") {
                const ticket =
                    requestUrl.searchParams.get("t");

                const ticketData =
                    await decryptTicket(
                        ticket,
                        env.SIGNING_SECRET
                    );

                return relay(
                    ticketData.url,
                    ticketData.headers,
                    request,
                    env
                );
            }

            if (path === "/health") {
                return jsonResponse({
                    ok: true,
                    service: "Enlil Relay"
                });
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
                        error.message || error
                    )
                },
                502
            );
        }
    }
};
