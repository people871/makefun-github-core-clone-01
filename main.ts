// Boot sequence for the Git forge.
//
// This file only drives the process lifecycle. The HTTP surface — health
// probe, REST v3, GraphQL, MCP, git smart HTTP — is built by app.ts and
// the modules it pulls in; nothing here touches a request.
//
// The harness fixes the order:
//   1. MAKEFUN_ENV_URL names the env origin (http://store:8080 inside a
//      trial container). Without it there is nothing to register with, so
//      the process exits 1 right away.
//   2. Build the server and listen on port 0, letting the kernel pick a
//      free port. Port 8080 is never bound — the env owns it.
//   3. POST the bound port to $MAKEFUN_ENV_URL/register. The env records
//      the caller's address plus the port as this entry's base URL and
//      dials it from then on. The first register wins; a 409 means some
//      other entry already registered, and this process just waits.
//   4. Poll GET $MAKEFUN_ENV_URL/done until the body is {"done": true}.
//      The env answers immediately ({"done": false} while the suite runs),
//      so this is a poll, not a long-held request. A failed or slow poll is
//      retried with a short exponential backoff; the process never exits
//      before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// Only the server factory is imported here: no package, no Node built-in,
// no model call.

import { createApp } from './app.ts';

/** The env origin, with any trailing slashes removed. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may run before it is abandoned and retried. */
const requestTimeoutMs = 30_000;
/** The first pause between retries, and the longest pause. */
const retryFirstMs = 250;
const retryCapMs = 2_000;

/** Pause for `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The pause after `attempt` failed requests: exponential from retryFirstMs, capped at retryCapMs. */
function backoffMs(attempt: number): number {
  return Math.min(retryCapMs, retryFirstMs * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer;
 * 409 means a first register already won, which is not this process's to
 * fix. 400 and 405 are contract errors and end the program; a network
 * error or any other status is retried, since the env may still be
 * starting up.
 */
async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await pause(backoffMs(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForEnvDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoffMs(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function boot(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => resolve());
  });
  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForEnvDone();
  forge.close();
  process.stdout.write('[entry] done\n');
}

try {
  await boot();
  process.exit(0);
} catch (failure) {
  process.stderr.write(`[entry] ${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exit(1);
}
