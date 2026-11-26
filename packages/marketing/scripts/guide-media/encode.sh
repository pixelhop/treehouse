#!/bin/sh
# encode.sh <raw.mp4> <name> <crop w:h:x:y> <poster-second>
set -e
OUT=$(cd "$(dirname "$0")/../../public" && pwd)/guides/media
mkdir -p "$OUT"
ffmpeg -v error -y -i "$1" -vf "crop=$3,scale=1280:-2:flags=lanczos,fps=30" -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart -an "$OUT/$2.mp4"
ffmpeg -v error -y -ss "$4" -i "$1" -frames:v 1 -vf "crop=$3,scale=1280:-2:flags=lanczos" "$OUT/$2-poster.png"
cwebp -quiet -q 80 "$OUT/$2-poster.png" -o "$OUT/$2.webp" && rm "$OUT/$2-poster.png"
ls -la "$OUT/$2.mp4" "$OUT/$2.webp"
