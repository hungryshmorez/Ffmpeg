#!/bin/sh
# Builds plugin.wasm from src/lib.rs (needs: rustup target add wasm32-unknown-unknown).
set -e
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/ffworks_example_plugin.wasm plugin.wasm
ls -l plugin.wasm
