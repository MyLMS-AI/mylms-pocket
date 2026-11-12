import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3090);
const UPSTREAM_API = (process.env.MYLMS_API_URL || "https://plataforma.mylms.ai/api").replace(/\/$/, "");
const UPSTREAM_ORIGIN = new URL(UPSTREAM_API).origin;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rewriteSetCookieForHost(rawCookies) {
  if (!rawCookies) return undefined;
  const list = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
  return list.map((cookieStr) =>
    String(cookieStr)
      .replace(/;\s*Domain=[^;]+/gi, "")
      .replace(/;\s*SameSite=None/gi, "; SameSite=Lax")
  );
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (reqUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "mylms-pocket",
        upstream: UPSTREAM_API,
      })
    );
    return;
  }

  // Proxy /api/auth/* to MyLMS BetterAuth (/auth/secure/* on UPSTREAM_API)
  if (reqUrl.pathname.startsWith("/api/auth/")) {
    let subPath = reqUrl.pathname.replace(/^\/api\/auth/, "");
    if (!subPath.startsWith("/secure/")) {
      subPath = "/secure" + (subPath.startsWith("/") ? subPath : "/" + subPath);
    }
    const targetUrl = `${UPSTREAM_API}/auth${subPath}${reqUrl.search}`;
    try {
      const bodyBuffer = await readBodyBuffer(req);
      const headers = {
        Accept: "application/json",
        Origin: UPSTREAM_ORIGIN,
      };
      if (req.headers["content-type"]) {
        headers["Content-Type"] = req.headers["content-type"];
      }
      if (req.headers["cookie"]) {
        headers["Cookie"] = req.headers["cookie"];
      }
      if (req.headers["authorization"]) {
        headers["Authorization"] = req.headers["authorization"];
      }

      const upstreamRes = await fetch(targetUrl, {
        method: req.method || "GET",
        headers,
        body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : bodyBuffer,
      });

      const responseBytes = Buffer.from(await upstreamRes.arrayBuffer());
      const outHeaders = {
        "Content-Type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      };
      const rawCookies = upstreamRes.headers.getSetCookie
        ? upstreamRes.headers.getSetCookie()
        : upstreamRes.headers.get("set-cookie");
      const rewrittenCookies = rewriteSetCookieForHost(rawCookies);
      if (rewrittenCookies && rewrittenCookies.length > 0) {
        outHeaders["Set-Cookie"] = rewrittenCookies;
      }

      res.writeHead(upstreamRes.status, outHeaders);
      res.end(responseBytes);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: "Falha ao comunicar com autenticação do MyLMS",
          detail: err instanceof Error ? err.message : String(err),
        })
      );
    }
    return;
  }

  // Proxy /api/offline/* to the MyLMS mother backend (/v1/offline/*)
  if (reqUrl.pathname.startsWith("/api/offline/")) {
    const upstreamPath = reqUrl.pathname.replace(/^\/api\/offline/, "/v1/offline") + reqUrl.search;
    const targetUrl = `${UPSTREAM_API}${upstreamPath}`;

    try {
      const bodyBuffer = await readBodyBuffer(req);

      const headers = {
        Accept: "application/json",
        Origin: UPSTREAM_ORIGIN,
      };
      if (req.headers["content-type"]) {
        headers["Content-Type"] = req.headers["content-type"];
      }
      if (req.headers["cookie"]) {
        headers["Cookie"] = req.headers["cookie"];
      }
      if (req.headers["authorization"]) {
        headers["Authorization"] = req.headers["authorization"];
      }

      const upstreamRes = await fetch(targetUrl, {
        method: req.method || "GET",
        headers,
        body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : bodyBuffer,
      });

      const responseBytes = Buffer.from(await upstreamRes.arrayBuffer());
      res.writeHead(upstreamRes.status, {
        "Content-Type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(responseBytes);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: "Upstream MyLMS API unreachable",
          detail: err instanceof Error ? err.message : String(err),
        })
      );
    }
    return;
  }

  // Serve static PWA files
  let safePath = path.normalize(reqUrl.pathname).replace(/^(\.\.[/\\])+/, "");
  if (safePath === "/" || safePath === "") safePath = "/index.html";

  let filePath = path.join(PUBLIC_DIR, safePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" || safePath === "/sw.js" ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[MyLMS Pocket] Listening on http://0.0.0.0:${PORT} (upstream: ${UPSTREAM_API})`);
});
