# Yeelight Control (Windows desktop app)

A simple Windows app to control Yeelight / Xiaomi smart lamps over your local network.
No cloud, no account, no internet needed.

**Features**
- Automatic lamp discovery, or add lamps by IP
- Per lamp: power, brightness, white temperature, color
- Presets: save a lamp's current settings and reuse them on any lamp
- "All lamps" panel to control everything at once
- Option to start with Windows (minimized)
- Status refreshes automatically, so changes made in the Yeelight app show up too

Looking for Stream Deck support? See the companion project:
[yeelight-streamdeck](https://github.com/YOUR-USERNAME/yeelight-streamdeck).

## Download

Get the latest version from the **[Releases](../../releases/latest)** page:

- `Yeelight-Control-Setup-x.y.z.exe`: installer
- `Yeelight-Control-Portable-x.y.z.exe`: portable, no installation

Windows may show a SmartScreen warning because the app is not code-signed.
Click *More info*, then *Run anyway*.

## Before you start (every lamp)

1. In the **Yeelight** app (or Mi Home), open the lamp's settings and turn on **LAN Control**.
   Some Xiaomi / Mi Home lamps don't support it.
2. Give each lamp a fixed IP address (DHCP reservation in your router).

## Using it

- On first launch the app searches for lamps. If none are found, enter the IP and click **Add**.
- Each lamp card: power switch, brightness, temperature, color and preset buttons.
- Click a lamp's name to rename it, **x** to remove it.
- **+ Save current as preset** stores what the lamp is doing right now. Hover a preset and click **x** to delete it.
  Presets are stored in `%APPDATA%\Yeelight Control\presets.json`.
- Tick **Start with Windows** to launch at login, minimized to the taskbar
  (works in the installed or portable app, not when running from source).
- Sliders send their command when released, because lamps accept about 60 commands per minute.

## Build from source

Requires [Node.js](https://nodejs.org) 20 or newer.

    npm install
    npm start          # run it
    npm run dist       # build installer + portable exe into dist/

If PowerShell blocks `npm`, run once:
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

If `npm run dist` fails with "Cannot create symbolic link", enable Windows Developer Mode
(Settings > System > For developers) or run the terminal as Administrator.

## Publishing a release (maintainers)

    git tag v1.1.0
    git push origin v1.1.0

GitHub Actions builds the installer and portable `.exe` and attaches them to the release
(see `.github/workflows/build.yml`). Keep the tag in sync with `version` in `package.json`.

## Troubleshooting

- **No lamps found:** check LAN Control is on, the PC and lamps share a network, and allow the app
  through Windows Firewall (private networks). Adding by IP always works.
- **A lamp rejects a value:** white temperature range depends on the model
  (many bulbs are 2700-6500 K, bedside lamps from 1700 K). The app shows the lamp's error message.

## Disclaimer

Unofficial project, not affiliated with or endorsed by Yeelight or Xiaomi.
All product names and trademarks belong to their respective owners.

## License

[MIT](LICENSE)
