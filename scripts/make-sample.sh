#!/usr/bin/env bash
set -euo pipefail

mkdir -p sources/e2e campaigns/cnpl/assets

# Generate placeholder watermark PNG (128x128 bright orange badge) if missing
if [ ! -f campaigns/cnpl/assets/cnpl_icon.png ]; then
  ffmpeg -y -v error \
    -f lavfi -i "color=c=orange:s=128x128:d=1" \
    -frames:v 1 \
    campaigns/cnpl/assets/cnpl_icon.png
fi

# Generate 1920x1080 10s horizontal source with moving box and sine beeps at 1.0s, 3.5s, 6.0s, 8.8s
ffmpeg -y -v error \
  -f lavfi -i "color=c=0x1e3a5f:s=1920x1080:r=30:d=10" \
  -f lavfi -i "color=c=white:s=200x200:r=30:d=10" \
  -f lavfi -i "sine=frequency=880:sample_rate=44100:duration=10" \
  -filter_complex "
    [0:v][1:v]overlay=x='100+150*t':y=440[v];
    [2:a]volume='if(between(t,1.0,1.2)+between(t,3.5,3.7)+between(t,6.0,6.2)+between(t,8.8,9.0),0.8,0.02)':eval=frame[a]
  " \
  -map "[v]" -map "[a]" \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast \
  -c:a aac -b:a 128k \
  sources/e2e/sample_horiz.mp4

# Generate 1080x1920 10s vertical source with moving box and sine beeps
ffmpeg -y -v error \
  -f lavfi -i "color=c=0x2d4a22:s=1080x1920:r=30:d=10" \
  -f lavfi -i "color=c=yellow:s=200x200:r=30:d=10" \
  -f lavfi -i "sine=frequency=660:sample_rate=44100:duration=10" \
  -filter_complex "
    [0:v][1:v]overlay=x=440:y='200+120*t'[v];
    [2:a]volume='if(between(t,1.0,1.2)+between(t,4.5,4.7)+between(t,8.8,9.0),0.8,0.02)':eval=frame[a]
  " \
  -map "[v]" -map "[a]" \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast \
  -c:a aac -b:a 128k \
  sources/e2e/sample_vert.mp4

echo "Generated sample_horiz.mp4, sample_vert.mp4, and cnpl_icon.png"
