import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const SERVICE_NAME = "apidot-bridge";
const SERVICE_VERSION = "1.0.0";
const APIDOT_BASE_URL = "https://api.apidot.ai/api/generate";
const MEDIA_DIR = "/tmp/apidot-bridge-media";
const MEDIA_TTL_MS = 2 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const PROVIDER_TIMEOUT_MS = 60_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime"]);
const mediaFiles = new Map();

await mkdir(MEDIA_DIR, { recursive: true });

const OpenAIFile = z
  .object({
    download_url: z.string().url(),
    file_id: z.string().min(1),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })
  .strict();

function publicBaseUrl() {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "PUBLIC_BASE_URL is not configured. Set it to this service's public HTTPS origin before creating a motion-control task.",
    );
  }

  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("PUBLIC_BASE_URL must use http or https.");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function apiKey() {
  const value = process.env.APIDOT_API_KEY?.trim();
  if (!value) {
    throw new Error("APIDOT_API_KEY is not configured on the server.");
  }
  return value;
}

function normalizeMimeType(value) {
  return value?.split(";", 1)[0].trim().toLowerCase() || "";
}

function isPrivateIp(address) {
  if (address === "::1" || address === "::") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;

  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(ipv4) !== 4) return false;

  const parts = ipv4.split(".").map(Number);
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] >= 224
  );
}

async function assertSafeDownloadUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("Attached file download URLs must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Attached file download URLs cannot contain URL credentials.");
  }

  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Attached file download URL resolves to a blocked network address.");
  }
  return parsed;
}

async function fetchDownloadUrl(rawUrl, signal) {
  let current = rawUrl;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const parsed = await assertSafeDownloadUrl(current);
    const response = await fetch(parsed, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { "User-Agent": `${SERVICE_NAME}/${SERVICE_VERSION}` },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) {
        throw new Error("Too many redirects while downloading an attached file.");
      }
      current = new URL(location, parsed).toString();
      continue;
    }
    return response;
  }
  throw new Error("Unable to download the attached file.");
}

async function removeMedia(token) {
  const entry = mediaFiles.get(token);
  if (!entry) return;
  mediaFiles.delete(token);
  await rm(entry.path, { force: true }).catch(() => {});
}

async function downloadToMedia(file, { allowedMimeTypes, maxBytes, label }) {
  const declaredMime = normalizeMimeType(file.mime_type);
  if (declaredMime && !allowedMimeTypes.has(declaredMime)) {
    throw new Error(`${label} has unsupported MIME type ${declaredMime}.`);
  }

  const token = randomBytes(32).toString("hex");
  const path = join(MEDIA_DIR, token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let handle;

  try {
    const response = await fetchDownloadUrl(file.download_url, controller.signal);
    if (!response.ok) {
      throw new Error(`${label} download failed with HTTP ${response.status}.`);
    }

    const responseMime = normalizeMimeType(response.headers.get("content-type"));
    const mimeType = declaredMime || responseMime;
    if (!allowedMimeTypes.has(mimeType)) {
      throw new Error(`${label} must be one of: ${[...allowedMimeTypes].join(", ")}.`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`${label} exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
    }
    if (!response.body) throw new Error(`${label} download returned an empty body.`);

    handle = await open(path, "wx", 0o600);
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
      }
      await handle.write(buffer);
    }
    if (total === 0) throw new Error(`${label} is empty.`);

    await handle.close();
    handle = undefined;
    mediaFiles.set(token, {
      path,
      mimeType,
      size: total,
      expiresAt: Date.now() + MEDIA_TTL_MS,
    });
    return token;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    if (error?.name === "AbortError") {
      throw new Error(`${label} download timed out.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readProviderResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 8000) };
  }
}

function providerMessage(payload, fallback) {
  return (
    payload?.message ||
    payload?.msg ||
    payload?.error?.message ||
    payload?.data?.message ||
    fallback
  );
}

function providerError(status, payload) {
  const labels = {
    400: "APIDot rejected the request",
    401: "APIDot authentication failed",
    402: "APIDot reports insufficient credits or payment required",
    429: "APIDot rate limit reached",
  };
  const prefix = labels[status] || (status >= 500 ? "APIDot service error" : "APIDot request failed");
  return `${prefix} (HTTP ${status}): ${providerMessage(payload, "No error details returned.")}`;
}

async function apidotRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(`${APIDOT_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const payload = await readProviderResponse(response);
    if (!response.ok) throw new Error(providerError(response.status, payload));
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("APIDot request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

function extractTaskId(payload) {
  return payload?.task_id || payload?.taskId || payload?.data?.task_id || payload?.data?.taskId;
}

function extractStatus(payload, fallback = "not_started") {
  return payload?.status || payload?.data?.status || payload?.state || payload?.data?.state || fallback;
}

function extractFiles(payload) {
  const candidate = payload?.files || payload?.data?.files || payload?.output?.files || payload?.data?.output?.files;
  if (!Array.isArray(candidate)) return [];
  return candidate
    .map((item) => (typeof item === "string" ? item : item?.url || item?.file_url))
    .filter((item) => typeof item === "string" && item.length > 0);
}

export function createServer() {
  const server = new McpServer(
    { name: SERVICE_NAME, version: SERVICE_VERSION },
    {
      instructions:
        "Use create_motion_control with exactly one attached image and one attached motion video. Save its task_id, then call get_motion_control_status to retrieve progress and final video URLs.",
    },
  );

  server.registerTool(
    "create_motion_control",
    {
      title: "Create Kling motion control video",
      description:
        "Apply the motion from one attached reference video to one attached character image using APIDot Kling 3.0 Motion Control. Returns an APIDot task ID for status polling.",
      inputSchema: {
        image: OpenAIFile.describe("The attached JPEG or PNG character image."),
        motion_video: OpenAIFile.describe("The attached MP4 or MOV motion-reference video."),
        prompt: z.string().max(2500).optional().describe("Optional generation guidance."),
        character_orientation: z.enum(["image", "video"]).default("image"),
        resolution: z.enum(["720p", "1080p"]).default("720p"),
      },
      outputSchema: {
        task_id: z.string(),
        status: z.string(),
        message: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        "openai/fileParams": ["image", "motion_video"],
        "openai/toolInvocation/invoking": "Submitting motion control task…",
        "openai/toolInvocation/invoked": "Motion control task submitted",
      },
    },
    async ({ image, motion_video, prompt, character_orientation, resolution }) => {
      let imageToken;
      let videoToken;
      try {
        const baseUrl = publicBaseUrl();
        imageToken = await downloadToMedia(image, {
          allowedMimeTypes: IMAGE_MIME_TYPES,
          maxBytes: IMAGE_MAX_BYTES,
          label: "Image",
        });
        videoToken = await downloadToMedia(motion_video, {
          allowedMimeTypes: VIDEO_MIME_TYPES,
          maxBytes: VIDEO_MAX_BYTES,
          label: "Motion video",
        });

        const input = {
          image_urls: [`${baseUrl}/media/${imageToken}`],
          video_urls: [`${baseUrl}/media/${videoToken}`],
          character_orientation,
          resolution,
        };
        if (prompt?.trim()) input.prompt = prompt.trim();

        const payload = await apidotRequest("/submit", {
          method: "POST",
          body: JSON.stringify({ model: "kling-3.0-motion-control", input }),
        });
        const taskId = extractTaskId(payload);
        if (!taskId) throw new Error("APIDot accepted the request but did not return a task_id.");

        const result = {
          task_id: taskId,
          status: extractStatus(payload),
          message: providerMessage(payload, "Motion-control task submitted."),
        };
        return {
          structuredContent: result,
          content: [{ type: "text", text: `Task ${result.task_id} submitted with status ${result.status}.` }],
        };
      } catch (error) {
        if (imageToken) await removeMedia(imageToken);
        if (videoToken) await removeMedia(videoToken);
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_motion_control_status",
    {
      title: "Get motion control status",
      description:
        "Check an APIDot Kling 3.0 Motion Control task. Returns its status and final generated video URLs when finished.",
      inputSchema: {
        task_id: z.string().min(1).max(256),
      },
      outputSchema: {
        task_id: z.string(),
        status: z.string(),
        files: z.array(z.string()),
        message: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Checking motion control status…",
        "openai/toolInvocation/invoked": "Motion control status received",
      },
    },
    async ({ task_id }) => {
      try {
        const payload = await apidotRequest(`/status/${encodeURIComponent(task_id)}`, { method: "GET" });
        const status = extractStatus(payload, "not_started");
        const files = extractFiles(payload);
        const result = {
          task_id: extractTaskId(payload) || task_id,
          status,
          files,
          message: providerMessage(
            payload,
            status === "finished"
              ? "Motion-control task finished."
              : status === "failed"
                ? "Motion-control task failed."
                : `Motion-control task is ${status}.`,
          ),
        };
        return {
          structuredContent: result,
          content: [
            {
              type: "text",
              text:
                status === "finished" && files.length
                  ? `Task ${result.task_id} finished. Files: ${files.join(", ")}`
                  : `Task ${result.task_id} status: ${status}. ${result.message}`,
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export function createApp() {
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: SERVICE_NAME });
  });

  app.get("/media/:token", async (req, res) => {
    const { token } = req.params;
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).json({ error: "Media not found." });
    const entry = mediaFiles.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) await removeMedia(token);
      return res.status(404).json({ error: "Media not found or expired." });
    }

    try {
      await stat(entry.path);
      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Length", String(entry.size));
      res.setHeader("Cache-Control", "private, max-age=300");
      createReadStream(entry.path).on("error", () => res.destroy()).pipe(res);
    } catch {
      await removeMedia(token);
      return res.status(404).json({ error: "Media not found." });
    }
  });

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error instanceof Error ? error.message : "Unknown error");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  for (const method of ["get", "delete"]) {
    app[method]("/mcp", (_req, res) => {
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed for stateless MCP transport." },
        id: null,
      });
    });
  }

  return app;
}

const cleanupTimer = setInterval(async () => {
  const now = Date.now();
  await Promise.all(
    [...mediaFiles.entries()]
      .filter(([, entry]) => entry.expiresAt <= now)
      .map(([token]) => removeMedia(token)),
  );
}, 5 * 60 * 1000);
cleanupTimer.unref();

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, "0.0.0.0", () => {
    console.log(`${SERVICE_NAME} listening on port ${port}`);
  });
}
