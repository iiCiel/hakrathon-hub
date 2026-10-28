# Sandbox image for running student code. Built once by setup-runner.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip nodejs gcc g++ libc6-dev openjdk-17-jdk-headless bash coreutils findutils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Common Python libraries students reach for (no network inside the sandbox, so they must be baked in).
RUN pip3 install --no-cache-dir --break-system-packages numpy pandas requests flask
WORKDIR /tmp
USER 65534:65534
