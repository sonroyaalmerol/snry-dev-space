
FROM debian:bookworm-slim

ENV PI_VERSION=0.80.2
ENV INSTALL_DEFAULTS=true

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-server \
        openssh-client \
        gnupg \
        gosu \
        libc6-dev \
        gcc \
        make \
        python3 \
        python3-pip \
        procps \
    && rm -rf /var/lib/apt/lists/*

RUN sed -i \
    -e 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' \
    -e 's/^#*PermitRootLogin.*/PermitRootLogin no/' \
    -e 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' \
    -e 's/^#*UsePAM.*/UsePAM no/' \
    /etc/ssh/sshd_config

COPY --from=oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun
COPY --from=oven/bun:1-debian /usr/local/bin/bunx /usr/local/bin/bunx

RUN ln -sf /usr/local/bin/bun /usr/local/bin/node

RUN groupadd --gid 1000 snry && \
    useradd --uid 1000 --gid snry --shell /bin/bash --create-home snry && \
    usermod -p '*' snry && \
    mkdir -p /home/snry/.pi/agent /home/snry/.ssh /run/sshd && \
    chown -R snry:snry /home/snry/.pi /home/snry/.ssh && \
    chmod 700 /home/snry/.ssh

COPY pi-config/ /usr/local/share/pi-seed/

COPY entrypoint.sh install-tools.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/install-tools.sh

RUN echo 'export PATH="/home/snry/.pi/bin:/home/snry/.pi/gopath/bin:/home/snry/.pi/sdk/go/bin:/home/snry/.pi/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' >> /home/snry/.bashrc

ENV HOME=/home/snry
ENV PI_CODING_AGENT_DIR=/home/snry/.pi/agent
ENV BUN_INSTALL=/home/snry/.pi/bun
ENV GOPATH=/home/snry/.pi/gopath
ENV GOROOT=/home/snry/.pi/sdk/go
ENV PATH="/home/snry/.pi/bin:/home/snry/.pi/gopath/bin:/home/snry/.pi/sdk/go/bin:/home/snry/.pi/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

EXPOSE 22
VOLUME ["/home/snry/.pi"]

WORKDIR /home/snry/workspace

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
    CMD pgrep sshd >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pi"]