until curl -s https://greenwindow-one.vercel.app/scheduler | grep -q "index-" && [ "$(curl -s https://greenwindow-one.vercel.app/scheduler | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)" != "/assets/index-Bp4gpCG0.js" ]; do sleep 10; done
curl -s "https://greenwindow-one.vercel.app/api/health?db=1"; echo
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for m in "When should I charge my EV? It needs to be done by 7am." "Compare Chronos and Prophet for me."; do
  curl -sN --max-time 90 -X POST https://greenwindow-one.vercel.app/api/chat -H 'content-type: application/json' -d "{\"conversation_id\":null,\"message\":\"$m\",\"history\":[],\"panel_state\":null,\"client_now_utc\":\"$NOW\"}" | grep -E "^event: (gate|tool_end|answer|done)" -A1 | grep "^data" | sed -E 's/,"trace":.*/}/' | cut -c1-220
  echo ---
done
