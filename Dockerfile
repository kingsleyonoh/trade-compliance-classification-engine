# syntax=docker/dockerfile:1
FROM rust:1.78-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/trade-compliance-classification-engine /usr/local/bin/trade-compliance-classification-engine
COPY --from=builder /app/target/release/setup /usr/local/bin/setup
COPY migrations ./migrations
ENV APP_BIND_ADDR=0.0.0.0:8080 RUST_LOG=info
EXPOSE 8080
CMD ["trade-compliance-classification-engine"]
