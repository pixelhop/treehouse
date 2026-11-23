#!/bin/sh
# Treehouse CLI installer (macOS Apple Silicon / Linux).
#   curl -fsSL https://dl.trytree.house/install.sh | sh
set -eu

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
  echo "Intel Macs aren't supported yet — the binary is arm64-only." >&2
  echo "Use an Apple Silicon Mac, or build from source: pnpm --filter cli package" >&2
  exit 1
fi
if [ "$os" = linux ] && [ "$arch" = x64 ]; then
  echo "Linux x64 prebuilt binaries are paused for now — only linux-arm64 ships." >&2
  echo "Build from source instead: pnpm --filter cli package" >&2
  exit 1
fi

target="${os}-${arch}"
# Public R2 download host (the repo is private, so GitHub release URLs 404 for
# anonymous downloads). Override with TREEHOUSE_DL_BASE.
base="${TREEHOUSE_DL_BASE:-https://dl.trytree.house}/cli/latest"
dest="${TREEHOUSE_BIN_DIR:-$HOME/.local/bin}"
tmp="$(mktemp)"
mkdir -p "$dest"

echo "Downloading treehouse (${target})…"
curl -fSL "${base}/treehouse-${target}" -o "$tmp"

# Verify against published checksums (warn-and-continue if unavailable).
if curl -fsSL "${base}/SHA256SUMS" -o "${tmp}.sums" 2>/dev/null; then
  expected="$(grep "treehouse-${target}\$" "${tmp}.sums" | awk '{print $1}')"
  actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
    echo "Checksum mismatch — aborting." >&2
    rm -f "$tmp" "${tmp}.sums"
    exit 1
  fi
  rm -f "${tmp}.sums"
fi

chmod +x "$tmp"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true
mv "$tmp" "${dest}/treehouse"

echo "✓ Installed treehouse to ${dest}/treehouse"
case ":${PATH}:" in
  *":${dest}:"*) ;;
  *) echo "  Add it to your PATH:  export PATH=\"${dest}:\$PATH\"" ;;
esac
echo "  Get started:  treehouse login ~/your-folder"
