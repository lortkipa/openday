<p align="center">
  <img src="assets/logo.svg" alt="OpenDay logo" width="112" height="112">
</p>

<h1 align="center">OpenDay</h1>

<p align="center">
  <b>A self-hosted calendar that looks and works like Google Calendar.</b><br>
  Open source. One Docker container. Your data, on your server.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Go" src="https://img.shields.io/badge/backend-Go-00ADD8?logo=go&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/frontend-React-61DAFB?logo=react&logoColor=black">
  <img alt="SQLite" src="https://img.shields.io/badge/database-SQLite-003B57?logo=sqlite&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/ships%20as-one%20Docker%20image-2496ED?logo=docker&logoColor=white">
</p>

<p align="center">
  <a href="#-quick-start">Quick start</a> ·
  <a href="#-features">Features</a> ·
  <a href="#%EF%B8%8F-desktop-app">Desktop app</a> ·
  <a href="#-screenshots">Screenshots</a> ·
  <a href="#-for-developers">For developers</a>
</p>

<p align="center">
  <img src="assets/screenshots/week.png" alt="OpenDay week view with several calendars and two time zones" width="900">
</p>

> [!WARNING]
> OpenDay is in early development. Many features are missing and things may change or break between updates.

## 📸 Screenshots

<table>
  <tr>
    <td width="50%"><img src="assets/screenshots/form.png" alt="Create an event"><br><p align="center"><b>Create events</b> — time, time zone, notifications, calendar, color</p></td>
    <td width="50%"><img src="assets/screenshots/details.png" alt="Event details card"><br><p align="center"><b>Event details</b> — edit or delete in one click</p></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/screenshots/month-dark.png" alt="Month view in dark theme"><br><p align="center"><b>Month view</b> — with dark theme</p></td>
    <td width="50%"><img src="assets/screenshots/year.png" alt="Year view"><br><p align="center"><b>Year view</b> — the whole year at a glance</p></td>
  </tr>
</table>

<p align="center">
  <img src="assets/screenshots/phone.png" alt="OpenDay on a phone" width="260"><br>
  <b>Works on phones</b> — tap, long-press, swipe
</p>


## 🚀 Quick start

You need [Docker](https://docs.docker.com/get-docker/).

```bash
git clone https://github.com/lortkipa/openday.git
cd openday
docker build -t openday .
docker run -d --name openday -p 8080:8080 -v openday-data:/data --restart unless-stopped openday
```

Open **http://localhost:8080**.

Your events are saved in the `openday-data` volume.

## 🧰 Commands

| What | Command |
| --- | --- |
| Stop | `docker stop openday` |
| Start again | `docker start openday` |
| See logs | `docker logs openday` |
| Delete the app (keeps your data) | `docker rm -f openday` |
| Delete your data too | `docker volume rm openday-data` |

## 🔄 Update

```bash
git pull
docker build -t openday .
docker rm -f openday
docker run -d --name openday -p 8080:8080 -v openday-data:/data --restart unless-stopped openday
```

Your data stays in the volume.

## ✨ Features

- Day, week, month, year and Schedule (agenda) views.
- All-day and multi-day events, with their own row in the day and week views.
- Repeating events: daily, weekly (pick the days), monthly or yearly, every N days/weeks/months/years, ending never or on a date. Delete one occurrence or the whole series.
- Click the calendar to add an event. Drag to pick a time range.
- Drag events to move them. Drag the bottom edge to resize.
- Events have a title, description and color. Events can overlap.
- Right-click an event to change its color, duplicate it or delete it.
- Several calendars (for example "Work" and "Family"), each with its own name and color. Tick them in the sidebar to show or hide their events. Create, rename, recolor and delete calendars in Settings.
- The event form can float or be docked to the side. On phones it slides up from the bottom.
- Notifications: each event can have up to 5 reminders ("30 minutes before"). Set any number of minutes, hours, days or weeks (up to 4 weeks). Shown as desktop notifications (with Snooze) or as alerts in the page, with an optional sound. The calendar must be open in a browser tab, or the [desktop app](#%EF%B8%8F-desktop-app) must be running.
- Live sync: a change in one browser tab, another computer or the desktop app shows everywhere else right away (no reload).
- Backup and export: download all your data as a JSON backup (and restore it later), or export your events as an iCalendar (`.ics`) file for another calendar app. Deleting a calendar can be undone.
- Installable on your phone or computer (PWA), with a basic offline shell.
- Settings: date format, time format, time zone, default event length, default notification, notification settings, week start, default view, drag step and default calendar.
- Several time zones: add up to 5 other time zones in Settings. They show as extra hour columns in the day and week views, and you can set an event's time zone to any of them.
- Light, dark or device theme.
- Works on phones: tap to add or open, hold an event to drag it or open its menu, swipe to change the day/week/month.
- Keyboard shortcuts: `D` `W` `M` `Y` (views), `T` (today), `J`/`K` (next/previous), `C` (create).

## 🖥️ Desktop app

The desktop app (Linux, Windows, macOS) shows your OpenDay server in its own window.

- Closing the window keeps the app running in the tray, so **notifications still show**.
- Tray menu: Open, Reload, Change server, Start at login, Quit.
- It has no data of its own. Everything is on your server, so it stays in sync with the web app.

Build it (needs Node.js):

```bash
cd desktop && npm install && npm run dist
```

The installer is in `desktop/dist` (AppImage on Linux, `.exe` on Windows, `.dmg` on macOS). Build each one on its own system.
On the first start, enter your server address (for example `http://localhost:8080`).

Notes:

- Linux AppImages need FUSE 2 (Fedora: `sudo dnf install fuse-libs`, Ubuntu: `sudo apt install libfuse2`).
- The Snooze button works on Windows and macOS. On Linux it depends on your desktop (GNOME and KDE show it).
- If the calendar is also open in a browser, both can show the same reminder.

## 🛠️ For developers

Run the backend (Go) and the frontend (Vite) in two terminals:

```bash
cd backend && go run .
```

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. Run the backend tests with `cd backend && go test ./...`.

Desktop app in development (with the backend running): `cd desktop && npm install && npm start`.

AI coding agents should read [`AGENTS.md`](AGENTS.md) first.

## 📄 License

[MIT](LICENSE)
