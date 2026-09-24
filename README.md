# APIDot Motion Control MCP Bridge

A remote MCP server that lets ChatGPT submit and monitor APIDot Kling 3.0 Motion Control jobs using files attached directly to a ChatGPT conversation.

## Endpoints

- `GET /health` — service health check
- `POST /mcp` — stateless Streamable HTTP MCP endpoint
- `GET /media/:token` — short-lived, unguessable media URL used by APIDot

## MCP tools

### `create_motion_control`

Accepts one attached JPEG/PNG image and one attached MP4/MOV motion-reference video, plus optional prompt, orientation, and resolution settings. It returns an APIDot `task_id`.

Defaults:

- `character_orientation`: `image`
- `resolution`: `720p`

### `get_motion_control_status`

Accepts an APIDot `task_id` and returns the current status and generated file URLs when available.

## Railway environment variables

Configure these variables in the Railway service. Never commit their values:

```env
APIDOT_API_KEY=
PUBLIC_BASE_URL=https://your-service.up.railway.app
```

`PUBLIC_BASE_URL` must be the public origin of this service without `/mcp`.

## Local development

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm start
```

The server listens on `process.env.PORT` and defaults to port `3000` locally.

## Security and file handling

- The APIDot key is read only from the server environment and is never returned by tools.
- Attached files are downloaded with timeouts and strict 10 MB image / 100 MB video limits.
- Download URLs must use HTTPS and cannot resolve to private network addresses.
- Temporary media filenames use random 256-bit tokens.
- Temporary media is deleted automatically after two hours and is never committed.
- No paid APIDot generation is performed during setup or discovery testing.

## Example ChatGPT request

> Apply the motion from this video to this character using Kling 3.0 Motion Control, 720p, character orientation=image.

ChatGPT calls `create_motion_control`, returns the `task_id`, and can then call `get_motion_control_status` until the job finishes.
