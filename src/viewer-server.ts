import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { viewerBus, type ViewerEvent } from "./event-bus.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const sseClients = new Set<ServerResponse>();

function handleSSE(req: IncomingMessage, res: ServerResponse): void {
  setCorsHeaders(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  sseClients.add(res);

  const initEvent = viewerBus.getInitSnapshot();
  res.write(`data: ${JSON.stringify(initEvent)}\n\n`);

  const onEvent = (evt: ViewerEvent) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {}
  };

  viewerBus.on("viewer_event", onEvent);

  const heartbeat = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch {
      cleanup();
    }
  }, 15_000);

  const cleanup = () => {
    sseClients.delete(res);
    viewerBus.off("viewer_event", onEvent);
    clearInterval(heartbeat);
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
}

function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
  setCorsHeaders(res);
  const snapshot = viewerBus.getInitSnapshot();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(snapshot.data));
}

function handleStatic(req: IncomingMessage, res: ServerResponse): void {
  setCorsHeaders(res);

  let staticDir = join(__dirname, "viewer");
  if (!existsSync(join(staticDir, "index.html"))) {
    staticDir = join(__dirname, "..", "dist", "viewer");
  }

  let urlPath = (req.url ?? "/").split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = join(staticDir, urlPath);

  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    const indexPath = join(staticDir, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      createReadStream(indexPath).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(res);
}


export function startViewerServer(port = 4242): { port: number; close: () => void } {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (req.method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === "/api/stream") {
      handleSSE(req, res);
    } else if (url === "/api/status") {
      handleStatus(req, res);
    } else {
      handleStatic(req, res);
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      server.close();
      const nextPort = port + 1;
      const result = startViewerServer(nextPort);
      Object.assign(serverInfo, result);
    }
  });

  const serverInfo = {
    port,
    close: () => {
      for (const res of sseClients) {
        try { res.end(); } catch {}
      }
      sseClients.clear();
      server.close();
    },
  };

  server.listen(port, "127.0.0.1", () => {
    serverInfo.port = port;
  });

  server.unref();

  return serverInfo;
}
