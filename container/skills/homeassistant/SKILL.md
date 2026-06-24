---
name: homeassistant
description: Control and query Home Assistant devices and automations via the REST API. Use when the user asks about home devices, sensors, lights, heating, locks, media players, cats (Pickle or Poppy) or automations.
---

# Home Assistant

Control and query the smart home via the HA REST API.

Credentials are available as environment variables:
- `$HA_URL` — base URL (e.g. `http://homeassistant.lan:8123`)
- `$HA_TOKEN` — long-lived access token

If either variable is empty, respond: "Home Assistant isn't configured — ask George to set HA_URL and HA_TOKEN in .env."

## Common operations

### Get all entity states
```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states"
```

### Get a specific entity
```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" \
  "$HA_URL/api/states/climate.house"
```

### Call a service
```bash
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "ENTITY_ID"}' \
  "$HA_URL/api/services/DOMAIN/SERVICE"
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
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states" \
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
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "climate.house", "temperature": 20}' \
  "$HA_URL/api/services/climate/set_temperature"
```

Lock the back door:
```bash
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "lock.back_door_locked_out"}' \
  "$HA_URL/api/services/lock/lock"
```

Trigger an automation:
```bash
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "automation.AUTOMATION_NAME"}' \
  "$HA_URL/api/services/automation/trigger"
```

## Response format

Report results conversationally — e.g. "Set heating to 20°C" or "Back door is locked." Don't dump raw JSON at the user unless they ask for it.
