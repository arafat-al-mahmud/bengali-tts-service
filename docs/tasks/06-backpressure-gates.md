# 06 - Backpressure Gates

Issue: [#7](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/7)

## What to build

The three Backpressure Gates on Job submission, applied in order with distinct rejections: per-user token-bucket Rate Limit (429 with Retry-After header), per-user Pending Cap on Jobs in QUEUED or ACTIVE (429 with a distinct code), and global Queue Capacity (503). All limits configurable via environment. Redis backs the rate limiter.

Covers user stories 24-28.

## Acceptance criteria

- [ ] Exceeding the Rate Limit returns 429 with a correct Retry-After header and a machine-readable code
- [ ] Exceeding the Pending Cap returns 429 with a different code; completing or failing a Job frees capacity
- [ ] When global Queue Capacity is reached, all users receive 503 with a machine-readable code
- [ ] All three limits are env-configurable and documented
- [ ] Integration tests drive each gate to rejection independently and verify the distinct code per gate
- [ ] Gate rejections do not create Job rows or queue entries

## Blocked by

- [03 - Core tracer bullet](./03-core-tracer-bullet.md)
