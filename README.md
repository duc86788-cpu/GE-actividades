# GE Actividades

Work management app for teams of ~20: tasks, updates, photos, calendar, activity log.
Zero-dependency Node.js server + single-file HTML app. Bilingual (Español / English).

## Quick start

```bash
node ge-server.js
```

First run creates an admin account:

```
Usuario: admin
Clave:   ge12345
```

**Change the password immediately in Settings (Ajustes).**

Open `http://localhost:8080` in any browser (phone or computer).

## Roles

| Role | Can do |
|------|--------|
| **Admin** | Everything: create/delete users, create/edit/delete tasks, assign, schedule, view all logs |
| **Sub-admin** | Create/edit tasks, assign employees, create schedule entries. No user management. |
| **Employee** | See assigned tasks, post updates + photos, mark tasks done. Nothing else. |

## Features

- **Language pick** — first screen. Español or English. Remembered per device.
- **Calendar** — month view with dots for tasks/activity. Tap any day to see:
  - Tasks due that day (who assigned, by whom, created time, completion time + by whom)
  - Full activity log for that day (every event with time and author)
- **Tasks** — title, description, assignee, priority, due date. Status: Pending → In progress → Done.
- **Updates** — text notes + photos on any task. Photos auto-resized.
- **Notifications** — bell icon with unread count. Tap to see who did what.
- **Team** (admin) — create, edit, activate/deactivate, delete users.
- **Live sync** — changes appear on all screens in real time (SSE).

## Deploy to cloud

### Option 1: Render.com (free tier works)

1. Push this folder to a GitHub repo
2. On Render: New → Web Service → connect repo
3. Start command: `node ge-server.js`
4. Render gives you a public URL

### Option 2: Railway.app

1. `npm i -g @railway/cli`
2. `railway login && railway init && railway up`

### Option 3: Any VPS (DigitalOcean, Hetzner, etc.)

```bash
# On the server
git clone <your-repo> ge-actividades && cd ge-actividades
node ge-server.js  # runs on port 8080

# With a process manager (recommended)
npm i -g pm2
pm2 start ge-server.js --name ge-actividades
pm2 save && pm2 startup

# Put nginx in front for HTTPS
# Proxy / to http://127.0.0.1:8080
```

### Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `./data` | Where the JSON database and uploaded files live |

## Files

```
ge-actividades/
├── ge-server.js      # Zero-dep Node server (auth, API, SSE, file serving)
├── app.html          # Single-file client (HTML + CSS + JS)
├── test/e2e.js       # End-to-end test suite (run with server running)
├── data/             # Created at runtime: ge-data.json + files/
└── README.md         # This file
```

## Test

```bash
# Terminal 1: start server
node ge-server.js

# Terminal 2: run tests
node test/e2e.js
```

## Tech

- **Server**: Node.js, zero npm dependencies. JSON file database.
- **Client**: Single HTML file, no framework, no build step.
- **Real-time**: Server-Sent Events (SSE) for live sync.
- **Auth**: Bearer token (30-day session, sliding expiry). Passwords hashed with scrypt.
- **Photos**: Base64 upload, auto-resized client-side to max 1600px, stored on disk.

## Data backup

The `data/` folder is your entire database. Copy it to back up:

```bash
cp -r data/ data-backup-$(date +%Y%m%d)/
```

---

GE Actividades · v1.2
