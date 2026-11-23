#!/bin/sh
# Capture the current agent-browser page as a docs screenshot.
#
#   shot.sh <name>                       whole viewport
#   shot.sh <name> "<text in a dialog>"  cropped to the dialog/card holding that text
#
# Writes packages/marketing/public/docs/images/<name>.webp. Before capturing it
# removes the Nuxt dev toolbar and rewrites local URLs to the production hosts,
# so shots taken against a local stack read like the real product. Set SESS to
# use an agent-browser session other than "docs". Needs agent-browser, cwebp
# and sips (macOS).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../../public/docs/images"
SESS=${SESS:-docs}
PAD=${PAD:-16}
ab() { agent-browser --session "$SESS" "$@"; }

ab eval "document.querySelectorAll('nuxt-devtools-container,#nuxt-devtools-container,vue-tracer-overlay,NUXT-DEVTOOLS-INSPECT-PANEL').forEach(e=>e.remove())" >/dev/null
ab eval "(()=>{const fix=s=>s.replace(/http:\/\/localhost:3100/g,'https://app.trytree.house').replace(/http:\/\/localhost:3110/g,'https://api.trytree.house');const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode()))if(n.nodeValue.includes('localhost:31'))n.nodeValue=fix(n.nodeValue);document.querySelectorAll('input,textarea').forEach(i=>{if(i.value.includes('localhost:31'))i.value=fix(i.value)})})()" >/dev/null
sleep 0.5
RAW=$(mktemp -t docs-shot).png
ab screenshot "$RAW" >/dev/null

if [ -z "$2" ]; then
  W=$(sips -g pixelWidth "$RAW" | awk '/pixelWidth/{print $2}')
  R=1600; [ "$W" -lt 1600 ] && R=$W
  cwebp -quiet -q 82 -resize $R 0 "$RAW" -o "$OUT/$1.webp"
else
  # The outermost ancestor of the text that still fits inside the viewport.
  TEXT=$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')
  BOX=$(ab eval "((t)=>{const h=[...document.querySelectorAll('h1,h2,h3,h4,p,span,label')].find(e=>e.textContent.trim()===t);let e=h,b=null;while(e){const r=e.getBoundingClientRect();if(r.width>=1100||r.height>=780)break;b=r;e=e.parentElement}return b?[b.x,b.y,b.width,b.height].map(Math.round).join(' '):''})($TEXT)" | tr -d '"')
  [ -n "$BOX" ] || { echo "no element containing: $2" >&2; exit 1; }
  set -- "$1" $BOX
  X=$(( ($2-PAD)*2 )); Y=$(( ($3-PAD)*2 )); CW=$(( ($4+2*PAD)*2 )); CH=$(( ($5+2*PAD)*2 ))
  [ $X -lt 0 ] && X=0; [ $Y -lt 0 ] && Y=0
  R=1200; [ $CW -lt 1200 ] && R=$CW
  cwebp -quiet -q 85 -crop $X $Y $CW $CH -resize $R 0 "$RAW" -o "$OUT/$1.webp"
fi
rm -f "$RAW"
echo "$OUT/$1.webp"
