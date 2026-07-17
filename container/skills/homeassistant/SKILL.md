---
name: homeassistant
description: Control and query Home Assistant devices and automations via the REST API. Use when the user asks about home devices, sensors, lights, heating, locks, media players, cats (Pickle or Poppy) or automations.
---

# Home Assistant

Control and query the smart home via the HA REST API at `http://homeassistant.lan:8123`.

**Auth is automatic.** The OneCLI gateway injects the `Authorization: Bearer` token
for every request to `homeassistant.lan` — you do **not** handle tokens and must
**not** add an `Authorization` header yourself.

If a request returns `401`/`403` or a connection error, the HomeAssistant secret
or OneCLI link may be misconfigured — tell George: "Home Assistant access isn't
working — the OneCLI HomeAssistant secret may need attention."

## Common operations

### Get all entity states
```bash
curl -s "http://homeassistant.lan:8123/api/states"
```

### Get a specific entity
```bash
curl -s "http://homeassistant.lan:8123/api/states/climate.house"
```

### Call a service
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "ENTITY_ID"}' \
  "http://homeassistant.lan:8123/api/services/DOMAIN/SERVICE"
```

## Key domains and services

| Domain | Services | Notes |
|--------|----------|-------|
| `homeassistant` | `turn_on`, `turn_off`, `toggle` | Works on most entities |
| `climate` | `set_temperature`, `set_hvac_mode` | `hvac_mode`: heat, cool, off |
| `lock` | `lock`, `unlock` | e.g. `lock.back_door_locked_out` |
| `media_player` | `turn_on`, `turn_off`, `media_play`, `media_pause`, `volume_set` | `volume_level`: 0.0–1.0 |
| `automation` | `turn_on`, `turn_off`, `trigger` | |
| `switch` | `turn_on`, `turn_off`, `toggle` | |

## Finding entities

When you don't know an entity ID, fetch all states and filter:
```bash
curl -s "http://homeassistant.lan:8123/api/states" \
  | python3 -c "
import json, sys, re
q = 'SEARCH_TERM'
for s in json.load(sys.stdin):
    if re.search(q, s['entity_id'] + ' ' + s.get('attributes', {}).get('friendly_name', ''), re.I):
        print(s['entity_id'], '-', s['state'])
"
```

## Examples

Set heating temperature:
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "climate.house", "temperature": 20}' \
  "http://homeassistant.lan:8123/api/services/climate/set_temperature"
```

Lock the back door:
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "lock.back_door_locked_out"}' \
  "http://homeassistant.lan:8123/api/services/lock/lock"
```

Trigger an automation:
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "automation.AUTOMATION_NAME"}' \
  "http://homeassistant.lan:8123/api/services/automation/trigger"
```

## Response format

Report results conversationally — e.g. "Set heating to 20°C" or "Back door is locked." Don't dump raw JSON at the user unless they ask for it.
