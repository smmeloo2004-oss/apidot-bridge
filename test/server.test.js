import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.NODE_ENV = "test";

const { createApp } = await import("../src/index.js");

let httpServer;
let baseUrl;

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  const { port } = httpServer.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

test("health endpoint reports ready", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "apidot-bridge" });
});

test("MCP initializes and advertises both tools with OpenAI file metadata", async () => {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const rpc = async (body) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const initialized = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "apidot-bridge-test", version: "1.0.0" },
    },
  });
  assert.equal(initialized.result.serverInfo.name, "apidot-bridge");

  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = listed.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["create_motion_control", "get_motion_control_status"]);

  const createTool = listed.result.tools.find((tool) => tool.name === "create_motion_control");
  assert.deepEqual(createTool._meta["openai/fileParams"], ["image", "motion_video"]);
  for (const field of ["image", "motion_video"]) {
    const schema = createTool.inputSchema.properties[field];
    assert.deepEqual(schema.required.sort(), ["download_url", "file_id"]);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "download_url",
      "file_id",
      "file_name",
      "mime_type",
    ]);
  }
});

test("create tool fails before downloading when PUBLIC_BASE_URL is absent", async () => {
  delete process.env.PUBLIC_BASE_URL;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_motion_control",
        arguments: {
          image: { download_url: "https://example.com/image.png", file_id: "file_image" },
          motion_video: { download_url: "https://example.com/video.mp4", file_id: "file_video" },
          character_orientation: "image",
          resolution: "720p",
        },
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /PUBLIC_BASE_URL is not configured/);
});
