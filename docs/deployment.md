# Deployment

This service is packaged as a container and expects PostgreSQL plus three required secrets supplied by the deployment environment.

## Build and publish

CI builds the image with `docker build` and pushes to GHCR on `main` as:

```text
ghcr.io/OWNER/trade-compliance-classification-engine:<git-sha>
```

## Required environment

- `DATABASE_URL` — PostgreSQL connection string supplied by the runtime platform.
- `JWT_SECRET` — application signing secret from the secret manager.
- `API_KEY_PEPPER` — API-key hash pepper from the secret manager.
- `SELF_REGISTRATION_ENABLED=false` for production.

Optional adapters are disabled by default. If enabled, each adapter must have a URL and API key; adapter failures are reported in health checks and do not block core classification, review, or audit export flows.

## Release migration command

Run migrations before starting the new image:

```bash
sqlx migrate run
```

Then run the setup seed only for intentional demo/bootstrap environments:

```bash
setup
```

## Health checks

- `/health` confirms process liveness.
- `/health/db` verifies database connectivity.
- `/health/ready` verifies the service is ready for traffic.
- `/metrics` emits Prometheus text format and requires an API key.
