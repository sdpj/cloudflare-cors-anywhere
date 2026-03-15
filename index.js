/*
  CORS Anywhere as a Cloudflare Worker!
  (c) 2019 by Zibri (www.zibri.org)
  https://github.com/Zibri/cloudflare-cors-anywhere

  Acts as a CORS proxy: forwards requests to a target URL supplied as the
  query-string parameter and injects the appropriate CORS response headers.

  Configuration
  -------------
  whitelistOrigins – regexp patterns; only matching Origins are proxied.
  blacklistUrls    – regexp patterns; matching target URLs are refused.
*/

// ── Configuration ────────────────────────────────────────────────────────────
const blacklistUrls    = [];        // e.g. ["example\\.com$"]
const whitelistOrigins = [".*"];    // ".*" = allow all origins

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true when `uri` matches at least one pattern in `list`.
 * A null/undefined uri is treated as allowed (handles missing Origin header).
 */
function matchesList(uri, list) {
    if (uri == null) return true;
    return list.some((pattern) => uri.match(pattern) !== null);
}

/**
 * Adds CORS headers to `headers` in-place and returns the same object.
 * For preflight (OPTIONS) requests the method/headers echo-back is also set.
 */
function applyCORSHeaders(headers, request, isPreflight) {
    headers.set("Access-Control-Allow-Origin", request.headers.get("Origin") ?? "*");

    if (isPreflight) {
        const requestedMethod  = request.headers.get("access-control-request-method");
        const requestedHeaders = request.headers.get("access-control-request-headers");

        if (requestedMethod)  headers.set("Access-Control-Allow-Methods", requestedMethod);
        if (requestedHeaders) headers.set("Access-Control-Allow-Headers", requestedHeaders);

        // Allow credentials to be forwarded
        headers.set("Access-Control-Max-Age", "86400");

        // Remove the header that would block cross-origin reads
        headers.delete("X-Content-Type-Options");
    }

    return headers;
}

/** Headers that must not be forwarded to the upstream target. */
const STRIP_REQUEST_HEADERS = /^(origin|referer|cf-|x-forw|x-cors-headers)/i;

// ── Main handler ──────────────────────────────────────────────────────────────

addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    const isPreflight = request.method === "OPTIONS";
    const workerUrl   = new URL(request.url);

    // Decode the target URL from the query string (?<encoded-url>)
    const rawTarget = workerUrl.search.startsWith("?")
        ? workerUrl.search.slice(1)   // strip leading "?"
        : null;

    const targetUrl = rawTarget
        ? decodeURIComponent(decodeURIComponent(rawTarget))
        : null;

    const originHeader  = request.headers.get("Origin");
    const connectingIp  = request.headers.get("CF-Connecting-IP");

    const targetAllowed = !matchesList(targetUrl, blacklistUrls);
    const originAllowed =  matchesList(originHeader, whitelistOrigins);

    // ── Forbidden ─────────────────────────────────────────────────────────────
    if (!targetAllowed || !originAllowed) {
        return new Response(
            "Create your own CORS proxy<br>\n" +
            "<a href='https://github.com/Zibri/cloudflare-cors-anywhere'>" +
                "https://github.com/Zibri/cloudflare-cors-anywhere</a><br>\n" +
            "<br>Donate<br>\n" +
            "<a href='https://paypal.me/Zibri/5'>https://paypal.me/Zibri/5</a>\n",
            {
                status: 403,
                statusText: "Forbidden",
                headers: { "Content-Type": "text/html" },
            }
        );
    }

    // ── Info page (no target URL provided) ────────────────────────────────────
    if (!targetUrl) {
        const headers = applyCORSHeaders(new Headers(), request, isPreflight);

        const cf      = request.cf ?? {};
        const country = cf.country   || null;
        const colo    = cf.colo      || null;

        // Parse custom headers for display only
        let customHeaders = null;
        try {
            const raw = request.headers.get("x-cors-headers");
            if (raw) customHeaders = JSON.parse(raw);
        } catch (_) { /* ignore malformed JSON */ }

        const body = [
            "CLOUDFLARE-CORS-ANYWHERE\n",
            "Source:\nhttps://github.com/Zibri/cloudflare-cors-anywhere\n",
            `Usage:\n${workerUrl.origin}/?<url>\n`,
            "Donate:\nhttps://paypal.me/Zibri/5\n",
            "Limits: 100,000 requests/day\n         1,000 requests/10 minutes",
            originHeader  ? `\nOrigin: ${originHeader}`         : "",
            connectingIp  ? `\nIP: ${connectingIp}`             : "",
            country       ? `\nCountry: ${country}`             : "",
            colo          ? `\nDatacenter: ${colo}`             : "",
            customHeaders ? `\nx-cors-headers: ${JSON.stringify(customHeaders)}` : "",
        ].join("\n");

        return new Response(body, { status: 200, headers });
    }

    // ── Proxy the request ─────────────────────────────────────────────────────

    // Build a clean set of forwarding headers
    const forwardHeaders = {};
    for (const [key, value] of request.headers.entries()) {
        if (!STRIP_REQUEST_HEADERS.test(key)) {
            forwardHeaders[key] = value;
        }
    }

    // Merge any custom headers injected via x-cors-headers
    try {
        const raw = request.headers.get("x-cors-headers");
        if (raw) {
            const extra = JSON.parse(raw);
            Object.assign(forwardHeaders, extra);
        }
    } catch (_) { /* ignore malformed JSON */ }

    const upstreamRequest = new Request(request, {
        redirect: "follow",
        headers: forwardHeaders,
    });

    const upstreamResponse = await fetch(targetUrl, upstreamRequest);

    // Collect upstream response headers for exposure
    const responseHeaders  = new Headers(upstreamResponse.headers);
    const exposedHeaderNames = [];
    const allUpstreamHeaders = {};

    for (const [key, value] of upstreamResponse.headers.entries()) {
        exposedHeaderNames.push(key);
        allUpstreamHeaders[key] = value;
    }
    exposedHeaderNames.push("cors-received-headers");

    // Apply CORS headers (mutates responseHeaders in-place)
    applyCORSHeaders(responseHeaders, request, isPreflight);
    responseHeaders.set("Access-Control-Expose-Headers", exposedHeaderNames.join(","));
    responseHeaders.set("cors-received-headers", JSON.stringify(allUpstreamHeaders));

    const responseBody = isPreflight ? null : await upstreamResponse.arrayBuffer();

    return new Response(responseBody, {
        headers:    responseHeaders,
        status:     isPreflight ? 200 : upstreamResponse.status,
        statusText: isPreflight ? "OK" : upstreamResponse.statusText,
    });
}
