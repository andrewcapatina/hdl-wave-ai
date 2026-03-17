#!/bin/bash
docker run --memory=126g --runtime=nvidia -e NVIDIA_VISIBLE_DEVICES=all \
    --ulimit memlock=-1 --ulimit stack=67108864 \
    -v "$(pwd)/data:/workspace/data" \
    -v "$(pwd)/output:/workspace/output" \
    -v "$(pwd)/../sample-hdls:/workspace/sample-hdls:ro" \
    -v "$(pwd)/teacher.py:/workspace/teacher.py:ro" \
    -v "$(pwd)/train.py:/workspace/train.py:ro" \
    -it --rm hdl-fine-tuner