# 10 - Monitoring dashboard

Issue: [#11](https://github.com/arafat-al-mahmud/bengali-tts-service/issues/11)

## What to build

Prometheus and Grafana behind an optional compose profile, with Prometheus scraping the gateway metrics endpoint and a pre-provisioned Grafana dashboard (datasource and dashboard JSON committed) showing queue depth, job duration percentiles, jobs by status, and per-gate rejection rates. A screenshot of the dashboard taken during a load-test run goes into the docs.

Covers user story 37.

## Acceptance criteria

- [ ] `docker compose --profile monitoring up` adds Prometheus and Grafana with zero manual configuration
- [ ] Grafana auto-provisions the datasource and dashboard from committed config
- [ ] Dashboard shows queue depth, job duration percentiles, jobs by status, and rejection rates per gate
- [ ] Docs include a dashboard screenshot captured during a load-test run

## Blocked by

- [08 - Observability](./08-observability.md)
