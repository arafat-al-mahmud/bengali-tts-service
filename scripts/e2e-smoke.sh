#!/usr/bin/env bash
# Black-box smoke test against a running compose stack: registers a user,
# issues an API key, submits Bengali text, polls to completion, downloads
# the audio, and asserts it is a playable WAV. Exits non-zero on any failure.
#
#   docker compose up -d --build
#   ./scripts/e2e-smoke.sh
#
# BASE_URL overrides the target (default http://localhost:3000).
# TIMEOUT_SECONDS bounds the wait for job completion (default 330, sized
# for CPU inference with the real engine; the fake engine finishes in ms).
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-330}"
TEXT='আগামীকাল সকাল দশটায় প্রকল্পের অগ্রগতি নিয়ে একটি সভা অনুষ্ঠিত হবে।'

say() { printf '>> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Extract a field from a JSON body without requiring jq.
json_get() {
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1:]:
    value = value[key]
print(value)
' "$@"
}

say "waiting for the gateway at ${BASE_URL}"
for _ in $(seq 1 30); do
  if curl -fsS "${BASE_URL}/readyz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "${ready:-}" = 1 ] || fail "gateway never became ready at ${BASE_URL}/readyz"

EMAIL="smoke-$(date +%s)-$$@example.com"
PASSWORD="a sufficiently long password"

say "registering ${EMAIL}"
register_status=$(curl -sS -o /tmp/smoke-register.json -w '%{http_code}' \
  -X POST "${BASE_URL}/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\": \"${EMAIL}\", \"password\": \"${PASSWORD}\"}")
[ "$register_status" = 201 ] || fail "registration returned ${register_status}: $(cat /tmp/smoke-register.json)"

say "creating an API key"
key_status=$(curl -sS -o /tmp/smoke-key.json -w '%{http_code}' \
  -X POST "${BASE_URL}/v1/keys" \
  -u "${EMAIL}:${PASSWORD}")
[ "$key_status" = 201 ] || fail "key creation returned ${key_status}: $(cat /tmp/smoke-key.json)"
API_KEY=$(json_get key < /tmp/smoke-key.json)

say "checking that a missing key is rejected"
anon_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/v1/tts" \
  -H 'Content-Type: application/json' -d '{"text": "x"}')
[ "$anon_status" = 401 ] || fail "unauthenticated submission returned ${anon_status}, expected 401"

say "submitting a job"
submit_status=$(curl -sS -o /tmp/smoke-submit.json -w '%{http_code}' \
  -X POST "${BASE_URL}/v1/tts" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"${TEXT}\"}")
[ "$submit_status" = 202 ] || fail "submission returned ${submit_status}: $(cat /tmp/smoke-submit.json)"
JOB_ID=$(json_get jobId < /tmp/smoke-submit.json)
STATUS_URL=$(json_get statusUrl < /tmp/smoke-submit.json)
POLL_MS=$(json_get pollIntervalMs < /tmp/smoke-submit.json)
say "job ${JOB_ID} accepted"

say "polling ${STATUS_URL} every ${POLL_MS}ms (timeout ${TIMEOUT_SECONDS}s)"
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while :; do
  curl -fsS -o /tmp/smoke-status.json -H "Authorization: Bearer ${API_KEY}" "${BASE_URL}${STATUS_URL}"
  status=$(json_get status < /tmp/smoke-status.json)
  case "$status" in
    COMPLETED) break ;;
    FAILED) fail "job failed: $(cat /tmp/smoke-status.json)" ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || fail "job still ${status} after ${TIMEOUT_SECONDS}s"
  sleep "$(python3 -c "print(${POLL_MS} / 1000)")"
done
say "job completed"

WAV_FILE=/tmp/smoke-audio.wav
say "downloading the audio"
audio_status=$(curl -sS -o "$WAV_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer ${API_KEY}" \
  "${BASE_URL}/v1/jobs/${JOB_ID}/audio")
[ "$audio_status" = 200 ] || fail "audio download returned ${audio_status}"

# A playable WAV starts with the RIFF/WAVE container magic and carries
# more than the 44-byte header.
[ "$(head -c 4 "$WAV_FILE")" = "RIFF" ] || fail "audio does not start with RIFF magic"
[ "$(tail -c +9 "$WAV_FILE" | head -c 4)" = "WAVE" ] || fail "audio is missing the WAVE format tag"
size=$(wc -c < "$WAV_FILE" | tr -d ' ')
[ "$size" -gt 44 ] || fail "audio is only ${size} bytes"

say "PASS: playable WAV at ${WAV_FILE} (${size} bytes)"
