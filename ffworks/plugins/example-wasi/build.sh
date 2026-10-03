#!/bin/sh
# Builds plugin.wasm (needs: rustup target add wasm32-wasip1).
set -e
cd "$(dirname "$0")"
cargo build --release --target wasm32-wasip1
cp target/wasm32-wasip1/release/ffworks_example_wasi_plugin.wasm plugin.wasm
ls -l plugin.wasm
