#!/usr/bin/env bash
# Generate image(s) in one ChatGPT web chat and save them locally.
# usage: gen.sh <outdir> <prompt>
# Prints the saved PNG paths. One chat yields what ChatGPT decides (often 1 image).
set -euo pipefail

browser=${WG_BROWSER:-ab} # any CLI exposing: open, eval, fill, click, tab close
out=${1:?usage: gen.sh <outdir> <prompt>}
prompt=${2:?usage: gen.sh <outdir> <prompt>}
mkdir -p "$out"

# Where the browser drops downloads. WSL sees the Windows folder through /mnt/c.
if [ -n "${WG_DOWNLOAD_DIR:-}" ]; then
	dl=$WG_DOWNLOAD_DIR
elif [ -d /mnt/c/Users ]; then
	# Skip the built-in Windows profiles (Default, Public, ...); keep the first writable one.
	dl=$(find /mnt/c/Users -maxdepth 2 -type d -name Downloads -writable ! -path '*/Default*' ! -path '*/Public*' ! -path '*/All Users*' -print -quit 2>/dev/null || true)
elif [ -d "$HOME/Downloads" ]; then
	dl=$HOME/Downloads
else
	dl=${USERPROFILE:-$HOME}/Downloads
fi
[ -d "$dl" ] || { echo "ERR: download dir not found; set WG_DOWNLOAD_DIR" >&2; exit 2; }

stamp=$((RANDOM * 1000 + RANDOM % 1000))
marker=/tmp/wg-marker-$stamp
touch "$marker"
export AB_SESSION="wg-$stamp"

say() { echo "[gen:$stamp] $*" >&2; }
is_png() { [ "$(od -An -tx1 -N4 "$1" | tr -d ' \n')" = 89504e47 ]; }

"$browser" open "https://chatgpt.com/" >/dev/null
ready=false
for _ in $(seq 1 20); do
	if [ "$("$browser" eval '!!document.querySelector("div[contenteditable=\"true\"]")' 2>/dev/null | tr -d '"')" = true ]; then ready=true; break; fi
	sleep 2
done
[ "$ready" = true ] || { echo "ERR: chatgpt.com prompt box missing (logged out?)" >&2; exit 2; }

"$browser" fill 'div[contenteditable="true"]' "$prompt" >/dev/null
# Enter is unreliable right after the SPA mounts; the send button always submits.
sent=false
for _ in 1 2 3; do
	"$browser" click 'button[aria-label="보내기"]' >/dev/null 2>&1 || "$browser" press Enter >/dev/null 2>&1 || true
	sleep 3
	if [ "$("$browser" eval 'location.pathname.startsWith("/c/")' 2>/dev/null | tr -d '"')" = true ]; then sent=true; break; fi
done
[ "$sent" = true ] || { echo "ERR: could not submit prompt" >&2; exit 2; }
say "submitted"

# Wait until at least one image exists and the answer stopped streaming ("중지" button gone).
n=0
for _ in $(seq 1 180); do
	sleep 2
	state=$("$browser" eval '(()=>{const n=document.querySelectorAll("img[alt^=\"생성된 이미지\"]").length;const busy=!![...document.querySelectorAll("button")].find(b=>/^(중지|Stop)$/.test((b.textContent||"").trim()));return n+","+(busy?1:0)})()' 2>/dev/null | tr -d '"')
	[ -z "$state" ] && continue
	n=${state%%,*}
	[ "$n" -ge 1 ] && [ "${state##*,}" = 0 ] && break
done
if [ "$n" -lt 1 ]; then
	echo "ERR: no image appeared within 6min; last page text:" >&2
	"$browser" eval 'document.body.innerText.trim().split("\n").filter(Boolean).slice(-5).join(" | ").slice(0,300)' >&2 || true
	exit 3
fi
say "images ready: $n"

# Fetch each blob and hand it to the browser's downloader.
"$browser" eval "(async()=>{const imgs=[...document.querySelectorAll('img[alt^=\"생성된 이미지\"]')];for(let i=0;i<imgs.length;i++){const b=await (await fetch(imgs[i].src)).blob();const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='webgpt-$stamp-'+i+'.png';document.body.appendChild(a);a.click();await new Promise(r=>setTimeout(r,400))}return imgs.length})()" >/dev/null

files=()
for _ in $(seq 1 60); do
	files=()
	while IFS= read -r f; do files+=("$f"); done < <(find "$dl" -maxdepth 1 -type f -newer "$marker" 2>/dev/null | sort)
	[ "${#files[@]}" -ge "$n" ] && break
	sleep 1
done

i=0
for f in ${files[@]+"${files[@]}"}; do
	is_png "$f" || continue
	dest="$out/webgpt-$stamp-$i.png"
	cp "$f" "$dest" && rm -f "$f"
	echo "$dest"
	i=$((i + 1))
done
rm -f "$marker"
[ "$i" -ge 1 ] || { echo "ERR: download did not land in $dl" >&2; exit 4; }
say "saved $i file(s) -> $out"
"$browser" tab close >/dev/null 2>&1 || true
