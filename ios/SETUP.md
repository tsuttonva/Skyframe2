# SkyFrame iOS + watchOS — Setup Guide

## Prerequisites

- Mac with **Xcode 15+** (free from the Mac App Store)
- iPhone with iOS 17+ and an Apple Watch with watchOS 10+
- A free Apple ID (no paid developer account needed for sideloading to your own devices)

## One-time setup

### 1. Install XcodeGen

XcodeGen reads `project.yml` and generates the `.xcodeproj` file automatically.

```bash
brew install xcodegen
```

(If you don't have Homebrew: https://brew.sh)

### 2. Copy the america.mp3 audio file

```bash
cp ../web/audio/america.mp3 "SkyFrame Watch App"/
# Also add it to the iOS target resources folder:
mkdir -p SkyFrame/Resources
cp ../web/audio/america.mp3 SkyFrame/Resources/
```

### 3. Generate the Xcode project

From the `ios/` directory:

```bash
cd /path/to/Skyframe2/ios
xcodegen generate
```

This creates `SkyFrame.xcodeproj`. Open it:

```bash
open SkyFrame.xcodeproj
```

### 4. Configure signing in Xcode

- Select the **SkyFrame** project in the Navigator
- Under **Signing & Capabilities**, set Team to your Apple ID
- Do the same for the **SkyFrame Watch App** target
- Let Xcode manage signing automatically

### 5. Build and run on your iPhone

- Plug in your iPhone via USB
- Select your iPhone as the run destination
- Hit **Run** (⌘R)
- The Watch app installs automatically via the paired iPhone

Xcode will ask you to trust the developer on the phone (Settings → General → VPN & Device Management).

## Sideload expiry

Free sideloads expire after **7 days**. Just reconnect to Xcode and re-run to refresh.

When you're ready to share with others (TestFlight), you'll need the $99/year Apple Developer account.

## Project structure

```
ios/
  project.yml                    ← XcodeGen config (edit this, not the .xcodeproj)
  SkyFrame/
    App.swift                    ← iOS app entry point
    Models/
      Aircraft.swift             ← data model (matches Worker JSON)
      AppModel.swift             ← state + refresh loop + alert logic
    Services/
      FlightService.swift        ← hits the Cloudflare Worker /flights endpoint
      LocationService.swift      ← CoreLocation wrapper
      AudioService.swift         ← chimes + speech + america.mp3 via AVAudioEngine
    Views/
      ContentView.swift          ← aircraft list + stats header
      AircraftRow.swift          ← single list row
      DetailView.swift           ← tapped-aircraft detail card
      SettingsView.swift         ← radar/alert radius, custom location, audio toggle
    Resources/
      america.mp3
  SkyFrame Watch App/
    WatchApp.swift               ← watchOS entry point
    WatchModel.swift             ← state + refresh loop + haptic alerts
    WatchContentView.swift       ← aircraft list + detail views
    Aircraft.swift               ← (shared copy)
    FlightService.swift          ← (shared copy)
    LocationService.swift        ← (shared copy)
```

## Backend

The app hits the existing Cloudflare Worker at:
`https://skyframe2-worker.tom-tsutton.workers.dev`

No backend changes needed. The same Worker powering the web app powers the iOS/watchOS app.
