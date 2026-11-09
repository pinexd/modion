'use strict';

const UA = 'modion/0.1.0 (Linux desktop mod manager)';

// An error whose message is written for the person using the app.
class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code || 'API_ERROR';
    this.status = status;
  }
}

async function getJson(url, { headers = {}, method = 'GET', body } = {}) {
  const host = new URL(url).hostname;
  // One deadline covers connecting, the response and reading its body.
  const signal = AbortSignal.timeout(20000);
  const unreachable = (e) => {
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : (e.cause && e.cause.code) || e.message;
    return new ApiError(`Could not reach ${host} (${why})`, 'NETWORK');
  };

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    throw unreachable(e);
  }

  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset'));
    throw new ApiError(`${host} is rate-limiting requests. Try again ${wait > 0 ? `in ${Math.ceil(wait)} seconds` : 'in a moment'}.`, 'RATE_LIMIT', 429);
  }
  if (res.status === 404) throw new ApiError(`${host} has no such item (404).`, 'NOT_FOUND', 404);
  if (!res.ok) throw new ApiError(`${host} answered ${res.status} ${res.statusText}`.trim(), 'HTTP', res.status);

  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw unreachable(e);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`${host} sent a reply that could not be read.`, 'BAD_REPLY', res.status);
  }
}

// The API replies are other people's data: read lists defensively.
const arr = (v) => (Array.isArray(v) ? v : []);

module.exports = { getJson, ApiError, UA, arr };
