// Server-Sent Events helper for Fastify.
//
// Why SSE (not WebSockets, not the AI SDK data stream protocol):
//   - One-way server → client is exactly the model we need.
//   - EventSource has built-in reconnect + last-event-id support.
//   - Native browser support; no client lib needed.
//   - Plays well with Fastify's reply.raw escape hatch.
//
// EventSource can't set headers, so streaming endpoints accept a short-lived
// `?token=...` query param minted by a sibling POST (see ./stream-token.ts).

import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseStream {
  /** Emit a typed event with auto-generated id. */
  send: (type: string, data: unknown) => void;
  /** Send a heartbeat comment (kept-alive ping). */
  heartbeat: () => void;
  /** Close the connection cleanly. Subsequent send/heartbeat are no-ops. */
  close: () => void;
  /** Resolves when the connection terminates (client disconnect, close, abort). */
  done: Promise<void>;
  /** AbortSignal that fires on client disconnect — pass to long-running work. */
  signal: AbortSignal;
}

export interface SseOptions {
  /** Heartbeat interval in ms. Default 15 s. */
  heartbeatMs?: number;
  /** Initial event id to start from (resume after reconnect). */
  startEventId?: number;
}

export function startSse(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: SseOptions = {},
): SseStream {
  // Mirror any headers Fastify already queued on `reply` (notably the
  // CORS plugin's Access-Control-Allow-* headers) onto reply.raw — once we
  // hijack and flushHeaders, anything left on the Fastify reply wrapper is
  // discarded. Without this, the browser blocks the EventSource as a CORS
  // failure even though the response itself is fine.
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value === undefined) continue;
    if (Array.isArray(value)) reply.raw.setHeader(name, value as string[]);
    else reply.raw.setHeader(name, value as string | number);
  }
  // Belt and suspenders: ensure CORS allows the admin origin even if the
  // CORS plugin missed (e.g. when the request didn't trip onRequest before
  // hijack ran).
  const origin = request.headers.origin;
  if (origin && !reply.raw.hasHeader('access-control-allow-origin')) {
    const allowed = [
      request.server.ctx.env.PUBLIC_ADMIN_ORIGIN,
      request.server.ctx.env.PUBLIC_PWA_ORIGIN,
    ];
    if (allowed.includes(origin)) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin);
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
      reply.raw.setHeader('Vary', 'Origin');
    }
  }
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  // Tell Fastify we're hijacking the response so it doesn't try to send headers.
  reply.hijack();
  reply.raw.statusCode = 200;
  reply.raw.flushHeaders();

  let nextId = (opts.startEventId ?? 0) + 1;
  let closed = false;
  const ac = new AbortController();
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const onClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(hbTimer);
    ac.abort();
    try {
      reply.raw.end();
    } catch {
      // already closed
    }
    resolveDone();
  };

  request.raw.on('close', onClose);
  request.raw.on('aborted', onClose);
  reply.raw.on('error', onClose);

  const send = (type: string, data: unknown) => {
    if (closed) return;
    const id = nextId++;
    const payload = JSON.stringify(data);
    // SSE format: id, event, data, blank line.
    try {
      reply.raw.write(`id: ${id}\nevent: ${type}\ndata: ${payload}\n\n`);
    } catch {
      onClose();
    }
  };

  const heartbeat = () => {
    if (closed) return;
    try {
      reply.raw.write(`: hb ${Date.now()}\n\n`);
    } catch {
      onClose();
    }
  };

  const hbTimer = setInterval(heartbeat, opts.heartbeatMs ?? 15_000);

  return {
    send,
    heartbeat,
    close: onClose,
    done,
    signal: ac.signal,
  };
}
