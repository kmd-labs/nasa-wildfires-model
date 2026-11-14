# syntax=docker/dockerfile:1
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# Install essential dev utilities, git, curl, build tools, zsh, sudo, and chromium for headless tests
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    ca-certificates \
    build-essential \
    python3 \
    jq \
    procps \
    sudo \
    zsh \
    openssh-client \
    nano \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium binary path for Karma / Puppeteer / headless test runners
ENV CHROME_BIN=/usr/bin/chromium

# Allow passwordless sudo for user 'node' so tools can install packages without permission errors
RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

# Preserve bash command history across container rebuilds
RUN mkdir -p /commandhistory \
    && chown -R node:node /commandhistory \
    && echo "export PROMPT_COMMAND='history -a'" >> /home/node/.bashrc \
    && echo "export HISTFILE=/commandhistory/.bash_history" >> /home/node/.bashrc

# Install Angular CLI globally
RUN npm install -g @angular/cli

USER node
WORKDIR /home/node

ENV PATH="/home/node/.local/bin:${PATH}"

# Install Google Antigravity CLI (agy) if available
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash || true

WORKDIR /workspace

EXPOSE 4200 9876

CMD ["/bin/bash"]
