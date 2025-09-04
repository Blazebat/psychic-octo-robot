const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";

const CACHE_TTL = {
  MASTER: 10,   // 10 seconds for master playlist
  VARIANT: 5,   // 5 seconds for variant playlists
  SEGMENT: 30   // 30 seconds for segments
};

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const qp = url.searchParams;

    if (parts.length < 2) {
      return new Response("Usage: /@handle/stream.m3u8", { status: 400 });
    }

    const handle = parts[0];
    const filename = parts[1];

    if (!filename.endsWith(".m3u8")) {
      return new Response("Only .m3u8 supported", { status: 400 });
    }

    if (qp.has("url")) {
      return await cacheResponse(handleSegmentProxy, qp.get("url"), CACHE_TTL.SEGMENT, request);
    }

    if (qp.has("variant")) {
      return await cacheResponse(handleVariantPlaylistProxy, qp.get("variant"), CACHE_TTL.VARIANT, request);
    }

    return await cacheResponse(handleMasterRequest, handle, CACHE_TTL.MASTER, request);

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Range,Accept,Content-Type",
    ...extra
  };
}

async function cacheResponse(fn, key, ttl, request) {
  const cache = caches.default;
  const cacheKey = new Request(request.url);
  let response = await cache.match(cacheKey);

  if (!response) {
    response = await fn(key, request);
    if (response && response.ok) {
      response.headers.set("Cache-Control", `public, max-age=${ttl}`);
      await cache.put(cacheKey, response.clone());
    }
  }
  return response;
}

async function fetchWithUA(resource, init = {}) {
  init.headers = Object.assign({
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9"
  }, init.headers || {});
  return fetch(resource, init);
}

async function handleMasterRequest(handle, request) {
  const urls = [
    `https://www.youtube.com/${handle}/live`,
    `https://www.youtube.com/channel/${handle}/live`,
    `https://www.youtube.com/watch?v=${handle}`
  ];

  let manifestUrl;
  for (const u of urls) {
    manifestUrl = await extractHlsManifestFromYouTube(u);
    if (manifestUrl) break;
  }
  if (!manifestUrl) return new Response("Manifest not found", { status: 404 });

  const res = await fetchWithUA(manifestUrl);
  const text = await res.text();
  const proxyBase = request.url.split("?")[0];
  const rewritten = text.replace(/(https?:\/\/[^\s\r\n,]+)/g, (m) => {
    return `${proxyBase}?variant=${encodeURIComponent(m)}`;
  });

  return new Response(rewritten, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      ...corsHeaders()
    }
  });
}

async function handleVariantPlaylistProxy(variantUrl, request) {
  const res = await fetchWithUA(variantUrl);
  const text = await res.text();
  const proxyBase = request.url.split("?")[0];

  const rewritten = text.split("\n").map(line => {
    if (line.startsWith("#") || !line) return line;
    const abs = new URL(line, variantUrl).toString();
    return `${proxyBase}?url=${encodeURIComponent(abs)}`;
  }).join("\n");

  return new Response(rewritten, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      ...corsHeaders()
    }
  });
}

async function handleSegmentProxy(targetUrl, request) {
  const range = request.headers.get("range");
  const headers = range ? { Range: range } : {};

  const upstream = await fetchWithUA(targetUrl, { headers });
  const outHeaders = new Headers(upstream.headers);
  outHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders
  });
}

async function extractHlsManifestFromYouTube(url) {
  const res = await fetchWithUA(url);
  const html = await res.text();
  const match = html.match(/"hlsManifestUrl":"([^"]+)"/);
  if (match) {
    return decodeURIComponent(match[1].replace(/\\u0026/g, "&"));
  }
  return null;
}
