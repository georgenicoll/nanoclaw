---
name: google
description: Read the user's Gmail and Google Calendar (read-only) via the Google REST APIs. Use when the user asks about their email, inbox, unread messages, a specific sender, their calendar, schedule, upcoming events, meetings, or appointments.
---

# Gmail & Google Calendar (read-only)

Read George's email and calendar via the Google REST APIs. **Read-only** — the
tokens only grant `gmail.readonly` and `calendar.readonly`, so you cannot send,
delete, or modify anything (attempts will fail with 403). Never imply you can.

## How auth works

You do **not** handle any tokens. The OneCLI gateway transparently injects the
OAuth token based on the destination host, so requests need **no `Authorization`
header**. You only need to trust the gateway's TLS certificate, which is already
present in the container at `$NODE_EXTRA_CA_CERTS`.

Always call curl like this (note `--cacert`, and no auth header):

```bash
curl -s --cacert "$NODE_EXTRA_CA_CERTS" "https://gmail.googleapis.com/gmail/v1/users/me/profile"
```

If a call returns HTTP 401/403 with an auth error, the Google connection is down
— tell George: "Google access isn't working — the OneCLI connection may need
re-authorising."

## Gmail

Base: `https://gmail.googleapis.com/gmail/v1/users/me`

### Search / list messages
Use Gmail's search syntax in `q` (URL-encode it). `messages.list` returns only
IDs, so fetch details for the ones you need.

```bash
# Recent unread in the primary inbox (IDs only)
curl -s --cacert "$NODE_EXTRA_CA_CERTS" \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread%20category:primary&maxResults=10"
```

Handy `q` filters: `is:unread`, `from:alice@x.com`, `subject:invoice`,
`newer_than:3d`, `category:primary`, `has:attachment`, `label:important`.

### Read a message (headers + snippet — cheap, preferred for summaries)
```bash
curl -s --cacert "$NODE_EXTRA_CA_CERTS" \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/MESSAGE_ID?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date"
```
The response has `.snippet` (a short preview) and `.payload.headers`.

### Read a full message body (only when the snippet isn't enough)
Body parts are base64url-encoded. Decode like this:
```bash
curl -s --cacert "$NODE_EXTRA_CA_CERTS" \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/MESSAGE_ID?format=full" \
  | python3 -c "
import sys, json, base64
m = json.load(sys.stdin)
def walk(p):
    if p.get('mimeType') == 'text/plain' and p.get('body', {}).get('data'):
        return base64.urlsafe_b64decode(p['body']['data']).decode('utf-8', 'replace')
    for part in p.get('parts', []):
        t = walk(part)
        if t: return t
    return ''
print(walk(m.get('payload', {}))[:4000])
"
```

### List labels
```bash
curl -s --cacert "$NODE_EXTRA_CA_CERTS" "https://gmail.googleapis.com/gmail/v1/users/me/labels"
```

## Google Calendar

Base: `https://www.googleapis.com/calendar/v3`

### Upcoming events on the primary calendar
`timeMin`/`timeMax` are RFC3339 timestamps. Use `date` to build them.

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
WEEK=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)
curl -s --cacert "$NODE_EXTRA_CA_CERTS" \
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=$NOW&timeMax=$WEEK&singleEvents=true&orderBy=startTime&maxResults=20"
```

Each event has `.summary`, `.start` (`.dateTime` or `.date` for all-day),
`.end`, `.location`, and `.attendees`.

### List all calendars (to read a non-primary one)
```bash
curl -s --cacert "$NODE_EXTRA_CA_CERTS" "https://www.googleapis.com/calendar/v3/users/me/calendarList"
```
Then use a calendar's `id` (URL-encoded) in place of `primary` above.

## Response format

Summarise conversationally — e.g. "You have 3 unread: a calendar invite from
Sarah, a receipt from Amazon, and a newsletter" or "Tomorrow you've got the
dentist at 9am and a 2pm call with Tom." Don't dump raw JSON unless George asks.
For dates/times, use George's timezone (the container's local time).
