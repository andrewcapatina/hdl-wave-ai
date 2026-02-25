#!/bin/bash
docker run --memory=126g --runtime=nvidia -e NVIDIA_VISIBLE_DEVICES=all \
    --ulimit memlock=-1 --ulimit stack=67108864 \
    -v "$(pwd)/data:/workspace/data" \
    -v "$(pwd)/output:/workspace/output" \
    -it --rm hdl-fine-tuner