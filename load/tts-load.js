/**
 * Load test for the TTS job API: a burst of users submitting concurrently,
 * demonstrating the three backpressure gates and the queue draining
 * afterwards. See docs/load-test.md for the invocation and results.
 *
 * Setup is idempotent: users are seeded with fixed emails, registration
 * tolerates EMAIL_TAKEN on re-runs, and each run issues fresh API keys.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import encoding from 'k6/encoding';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const USERS = Number(__ENV.USERS || 20);
const BURST_DURATION = __ENV.BURST_DURATION || '60s';
const PASSWORD = 'load-test-password-1234';
const BENGALI = 'আজকের আবহাওয়া খুব সুন্দর এবং আকাশ পরিষ্কার।';

const accepted = new Counter('tts_accepted');
const rateLimited = new Counter('tts_rejected_rate_limit');
const pendingCapped = new Counter('tts_rejected_pending_cap');
const queueFull = new Counter('tts_rejected_queue_full');
const otherResponses = new Counter('tts_other_responses');

// Gate rejections are correct behavior, not transport failures.
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 409, 429, 503));

export const options = {
  // The drain phase waits for the single-flight worker to empty the
  // backlog, which takes minutes by design.
  teardownTimeout: '15m',
  scenarios: {
    burst: {
      executor: 'constant-vus',
      vus: USERS,
      duration: BURST_DURATION,
      exec: 'submit',
    },
  },
};

export function setup() {
  const keys = [];
  for (let i = 0; i < USERS; i += 1) {
    const email = `k6-user-${i}@example.com`;
    const registered = http.post(
      `${BASE_URL}/v1/auth/register`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (registered.status !== 201 && registered.status !== 409) {
      throw new Error(`registration failed for ${email}: ${registered.status}`);
    }
    const created = http.post(`${BASE_URL}/v1/keys`, null, {
      headers: { Authorization: `Basic ${encoding.b64encode(`${email}:${PASSWORD}`)}` },
    });
    if (created.status !== 201) {
      throw new Error(`key creation failed for ${email}: ${created.status}`);
    }
    keys.push(created.json('key'));
  }
  return { keys };
}

export function submit(data) {
  const key = data.keys[(__VU - 1) % data.keys.length];
  const res = http.post(`${BASE_URL}/v1/tts`, JSON.stringify({ text: BENGALI }), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  });

  const code = res.status === 202 ? 'accepted' : res.json('error.code');
  if (res.status === 202) accepted.add(1);
  else if (code === 'RATE_LIMITED') rateLimited.add(1);
  else if (code === 'PENDING_CAP_EXCEEDED') pendingCapped.add(1);
  else if (code === 'QUEUE_FULL') queueFull.add(1);
  else otherResponses.add(1);

  check(res, {
    'is a known outcome': () =>
      res.status === 202 ||
      (res.status === 429 && (code === 'RATE_LIMITED' || code === 'PENDING_CAP_EXCEEDED')) ||
      (res.status === 503 && code === 'QUEUE_FULL'),
  });

  // A polite client would honor Retry-After; the point here is pressure,
  // so pause just enough to keep response parsing sane.
  sleep(0.2 + Math.random() * 0.3);
}

function queueDepth() {
  const res = http.get(`${BASE_URL}/metrics`);
  const match = /^tts_queue_depth (\d+)/m.exec(res.body);
  return match ? Number(match[1]) : NaN;
}

export function teardown() {
  // Watch the backlog drain: single-flight worker, one job at a time.
  const started = Date.now();
  const deadline = started + 10 * 60 * 1000;
  let depth = queueDepth();
  console.log(`drain started, queue depth ${depth}`);
  while (depth > 0 && Date.now() < deadline) {
    sleep(2);
    depth = queueDepth();
  }
  const elapsed = (Date.now() - started) / 1000;
  console.log(`queue drained to ${depth} in ${elapsed}s`);
}
