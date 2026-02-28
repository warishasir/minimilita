# 🎮 Doodle War — Online Multiplayer Setup

## Requirements
- [Node.js](https://nodejs.org) (v16 or higher)
- Two computers on the same network **OR** a server/VPS with a public IP

---

## Quick Start

### 1. Start the server
```bash
node server.js
```
You'll see output like:
```
🎮 Doodle War Server running on port 3000

📡 Share one of these URLs with your friend:

   http://192.168.1.42:3000
   http://localhost:3000  (same machine)
```

### 2. Both players open the URL
- **Player 1** opens `http://<your-ip>:3000` in their browser
- **Player 2** opens the same URL

### 3. Create / Join a room
- **Player 1** clicks **CREATE ROOM** — a 4-letter code appears (e.g. `X7K2`)
- **Player 2** types that code and clicks **JOIN**
- Game starts automatically!

---

## Playing over the Internet (outside your local network)

You need to either:

### Option A: Port forward
1. Forward port `3000` on your router to your PC
2. Find your public IP at https://whatismyip.com
3. Share `http://<public-ip>:3000` with your friend

### Option B: Use ngrok (free, easy)
```bash
# Install ngrok from https://ngrok.com
ngrok http 3000
# Share the https://xxxx.ngrok.io URL
```

### Option C: Deploy to a VPS (Render, Railway, Fly.io)
Upload both files and run `node server.js`.
Set `PORT` env variable if needed.

---

## Controls

| Action   | Player 1 | Player 2 |
|----------|----------|----------|
| Move     | A / D    | ← / →   |
| Jump     | W        | ↑        |
| Jetpack  | G        | K        |
| Shoot    | F        | L        |
| Reload   | R        | ;        |
| Weapon   | Q        | ,        |

---

## Custom port
```bash
node server.js 8080
# or
PORT=8080 node server.js
```
