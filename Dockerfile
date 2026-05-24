# Trade Compliance Classification Engine — Rust/Axum container
FROM rust:1.78-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates clang && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY migrations ./migrations
COPY templates ./templates
RUN cargo build --release

FROM debian:bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/trade-compliance-classification-engine /usr/local/bin/app
COPY migrations ./migrations
COPY templates ./templates
ENV RUST_LOG=info
EXPOSE 8080
CMD ["app"]
