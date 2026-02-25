# Fine-tuning container for DGX Spark (GB10 / Blackwell)
#
# Build:  docker build -t hdl-fine-tuner .
# Run:    docker run --gpus all --ulimit memlock=-1 --ulimit stack=67108864 \
#           -v $(pwd)/data:/workspace/data \
#           -v $(pwd)/output:/workspace/output \
#           -it hdl-fine-tuner
#
FROM nvcr.io/nvidia/pytorch:25.11-py3

RUN pip install --no-cache-dir \
    transformers peft hf_transfer "datasets==4.3.0" "trl==0.26.1" && \
    pip install --no-cache-dir --no-deps unsloth unsloth_zoo bitsandbytes

WORKDIR /workspace