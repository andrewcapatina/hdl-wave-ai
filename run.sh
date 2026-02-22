#!/bin/bash
# Run the EDA extension dev container
# Project files stay on the host - container is just for build tooling

docker run -it --rm \
    -e HOME=/tmp \
    -v "$(pwd)":/workspace \
    vscode-eda-dev \
    "$@"