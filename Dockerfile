# Ollama with CUDA 13.0 support for DGX Spark (GB10)
#
# Build:  docker build -t ollama-cuda13 .
# Run:    docker run -d --runtime=nvidia --gpus all --name ollama \
#           -p 11434:11434 -v ollama_models:/root/.ollama ollama-cuda13
#
FROM nvidia/cuda:13.0.0-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    zstd \
    && rm -rf /var/lib/apt/lists/*

# Install Ollama
RUN curl -fsSL https://ollama.com/install.sh | sh

EXPOSE 11434

ENV OLLAMA_HOST=0.0.0.0
ENV NVIDIA_VISIBLE_DEVICES=all

CMD ["ollama", "serve"]