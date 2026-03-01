# homebridge-hubspace2

[![npm](https://img.shields.io/npm/v/homebridge-hubspace2?color=blue)](https://www.npmjs.com/package/homebridge-hubspace2)
[![npm](https://img.shields.io/npm/dt/homebridge-hubspace2)](https://www.npmjs.com/package/homebridge-hubspace2)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Homebridge](https://img.shields.io/badge/homebridge-≥1.8.0-purple)](https://homebridge.io)

A [Homebridge](https://homebridge.io) plugin that brings your **Hubspace** smart home devices into Apple HomeKit — no Home Assistant required.

Hubspace is The Home Depot's smart home platform (sold under brands like Hampton Bay, EcoSmart, and Defiant). This plugin communicates directly with the Hubspace cloud API.

---

## Supported Devices

| Device Type | HomeKit Service | Notes |
|---|---|---|
| Lights | Lightbulb | On/off, brightness, color temperature, RGB color |
| Ceiling Fans | Fan | On/off, speed (%), direction |
| Switches | Switch | On/off |
| Outlets | Outlet | On/off |
| Thermostats | Thermostat | Heat/cool/auto/off modes, current & target temp |
| Locks | Lock Mechanism | Lock / unlock |
| Water Valves / Timers | Valve | Open / close |

> Unsupported device classes are skipped silently (enable `debug` in config to log them).

---

## Requirements

- [Homebridge](https://homebridge.io) ≥ 1.8.0
- Node.js ≥ 20.0.0
- A Hubspace account with at least one paired device

---

## Installation

### Via Homebridge UI (recommended)

1. Open the **Homebridge UI** in your browser.
2. Go to **Plugins** and search for `homebridge-hubspace2`.
3. Click **Install**.
4. Click **Settings** and enter your Hubspace username (email) and password.
5. Restart Homebridge.

### Manual

```bash
npm install -g homebridge-hubspace2
```

Then add the platform to your `~/.homebridge/config.json` (see [Configuration](#configuration) below) and restart Homebridge.

---

## Configuration

Add the following to the `platforms` array in your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "HubspacePlatform",
      "name": "Hubspace",
      "username": "your@email.com",
      "password": "yourpassword"
    }
  ]
}
```

### All options

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `platform` | string | — | Yes | Must be `HubspacePlatform` |
| `name` | string | `"Hubspace"` | No | Display name in Homebridge logs |
| `username` | string | — | Yes | Your Hubspace account email |
| `password` | string | — | Yes | Your Hubspace account password |
| `otp` | string | — | No | One-time password for 2FA — see [Two-Factor Authentication](#two-factor-authentication) |
| `pollingInterval` | integer | `30` | No | How often (seconds) to poll device state. Minimum 10. |
| `temperatureUnit` | string | `"fahrenheit"` | No | `"fahrenheit"` or `"celsius"` — must match your Hubspace app setting |
| `debug` | boolean | `false` | No | Log extra detail including skipped device classes |

---

## Two-Factor Authentication

Some Hubspace accounts require an emailed one-time password (OTP) to log in. Because the OTP is only sent *after* you attempt a login, it cannot be provided upfront. Follow these steps the first time you set up the plugin:

1. **Start Homebridge** with just your username and password in the config.
2. **Check the Homebridge log.** If your account uses 2FA you will see a banner like this:

   ```
   ══════════════════════════════════════════════════════
     Hubspace: Two-factor authentication (OTP) required
   ══════════════════════════════════════════════════════
     A one-time code was just sent to your email address.
     To complete login:
       1. Copy the code from your email.
       2. Add  "otp": "<code>"  to your Hubspace config.
       3. Restart Homebridge.
       4. Once running, remove the "otp" line – it is no
          longer needed after the first successful login.
   ══════════════════════════════════════════════════════
   ```

3. **Add the OTP to your config** and restart Homebridge:

   ```json
   {
     "platform": "HubspacePlatform",
     "username": "your@email.com",
     "password": "yourpassword",
     "otp": "123456"
   }
   ```

4. After a successful login, **remove the `otp` line**. The plugin saves a refresh token to disk (`~/.homebridge/hubspace-tokens.json`) and uses it automatically on future restarts. You should not need to go through this process again unless you change your password or manually delete the token file.

---

## How It Works

- **Authentication** — Uses the Hubspace OAuth2 PKCE flow (the same method as the official app). Access tokens expire after ~2 minutes; the plugin refreshes them automatically in the background using a long-lived refresh token stored on disk.
- **Device discovery** — On startup the plugin fetches all devices from your Hubspace account and registers them as HomeKit accessories. Devices no longer present in your account are automatically removed.
- **State updates** — The plugin polls the Hubspace API every `pollingInterval` seconds (default 30 s) and pushes updated values to HomeKit. Commands sent from HomeKit are applied immediately.

---

## Troubleshooting

### No devices appear in HomeKit

- Confirm your credentials are correct by logging into the Hubspace app.
- Enable `"debug": true` in your config and check the logs for skipped device classes.
- Make sure your Hubspace devices are online and visible in the app before starting Homebridge.

### Authentication keeps failing

- Delete `~/.homebridge/hubspace-tokens.json` and restart Homebridge to force a fresh login.
- If your account uses 2FA, follow the [Two-Factor Authentication](#two-factor-authentication) steps again.

### A device type is not supported

Open an issue on GitHub and include the device name and model. Enable `"debug": true` first — the log will show the `deviceClass` string the API returns, which helps add support quickly.

---

## Development

```bash
git clone https://github.com/ctrlcmdshft/homebridge-hubspace2
cd homebridge-hubspace2
npm install
npm run build       # compile TypeScript
npm run watch       # auto-recompile + restart Homebridge on file changes
npm run lint        # check for lint errors
```

To test locally against a real Homebridge instance:

```bash
npm link
# then add the platform to your Homebridge config and restart
```

---

## License

[MIT](LICENSE) © 2025
