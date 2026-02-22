FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js LTS via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install VSCode extension development tools
RUN npm install -g \
    yo \
    generator-code \
    @vscode/vsce && \
    mkdir -p /root/.config && \
    echo '{}' > /root/.yo-rc-global.json

WORKDIR /workspace

CMD ["/bin/bash"]