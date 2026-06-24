import Foundation
import CoreLocation
import Combine

// Aircraft type codes that trigger legendary alerts (mirrors web app logic)
private let legendaryTypes: Set<String> = ["U2", "VC25", "B52H", "E3C", "B2", "F22", "F35"]
private let emergencySquawks: Set<String> = ["7500", "7600", "7700"]

@MainActor
class AppModel: ObservableObject {
    // Aircraft state
    @Published var aircraft: [Aircraft] = []
    @Published var isLoading = false
    @Published var lastUpdated: Date?
    @Published var errorMessage: String?

    // Settings (persisted)
    @Published var radarRadiusNm: Double {
        didSet { UserDefaults.standard.set(radarRadiusNm, forKey: "radarRadius") }
    }
    @Published var alertRadiusNm: Double {
        didSet { UserDefaults.standard.set(alertRadiusNm, forKey: "alertRadius") }
    }
    @Published var customLocation: CLLocationCoordinate2D? {
        didSet {
            if let loc = customLocation {
                UserDefaults.standard.set(loc.latitude, forKey: "customLat")
                UserDefaults.standard.set(loc.longitude, forKey: "customLon")
                UserDefaults.standard.set(true, forKey: "useCustomLocation")
            } else {
                UserDefaults.standard.set(false, forKey: "useCustomLocation")
            }
        }
    }
    @Published var customLocationLabel: String = "" {
        didSet { UserDefaults.standard.set(customLocationLabel, forKey: "customLocationLabel") }
    }
    @Published var audioEnabled: Bool {
        didSet {
            UserDefaults.standard.set(audioEnabled, forKey: "audioEnabled")
            AudioService.shared.isEnabled = audioEnabled
        }
    }

    // Location
    let locationService = LocationService()
    @Published var selectedIcao: String? = nil

    private let flightService = FlightService()
    private var refreshTask: Task<Void, Never>?
    private var alertedIcaos: Set<String> = []
    private var refreshInterval: TimeInterval = 30

    var effectiveLocation: CLLocationCoordinate2D? {
        customLocation ?? locationService.coordinate
    }

    var locationLabel: String {
        if customLocation != nil { return customLocationLabel.isEmpty ? "Custom Location" : customLocationLabel }
        return "Current Location"
    }

    var aircraftInAlertZone: [Aircraft] {
        aircraft.filter { $0.distNm <= alertRadiusNm }
    }

    var militaryCount: Int { aircraft.filter(\.isMilitary).count }
    var highestAlt: Int { Int(aircraft.map(\.baroAlt).max() ?? 0) }
    var fastestSpeed: Int { Int(aircraft.map(\.velocity).max() ?? 0) }

    init() {
        radarRadiusNm = UserDefaults.standard.double(forKey: "radarRadius").nonZero ?? 50
        alertRadiusNm = UserDefaults.standard.double(forKey: "alertRadius").nonZero ?? 15
        audioEnabled = UserDefaults.standard.object(forKey: "audioEnabled") as? Bool ?? true
        AudioService.shared.isEnabled = audioEnabled

        if UserDefaults.standard.bool(forKey: "useCustomLocation") {
            let lat = UserDefaults.standard.double(forKey: "customLat")
            let lon = UserDefaults.standard.double(forKey: "customLon")
            if lat != 0 || lon != 0 {
                customLocation = CLLocationCoordinate2D(latitude: lat, longitude: lon)
                customLocationLabel = UserDefaults.standard.string(forKey: "customLocationLabel") ?? ""
            }
        }

        locationService.requestPermission()
        startAutoRefresh()
    }

    func startAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: UInt64(refreshInterval * 1_000_000_000))
            }
        }
    }

    func refresh() async {
        guard let loc = effectiveLocation else { return }
        isLoading = true
        errorMessage = nil
        do {
            let newAircraft = try await flightService.fetchFlights(
                lat: loc.latitude, lon: loc.longitude, distNm: radarRadiusNm
            )
            aircraft = newAircraft.sorted { $0.distNm < $1.distNm }
            lastUpdated = Date()
            checkAlerts()
        } catch {
            errorMessage = "Fetch failed — retrying"
        }
        isLoading = false
    }

    private func checkAlerts() {
        let seenIcaos = Set(aircraft.map(\.icao24))
        // Clear alerted set for aircraft that have left radar
        alertedIcaos = alertedIcaos.intersection(seenIcaos)

        for ac in aircraft {
            let alreadyAlerted = alertedIcaos.contains(ac.icao24)
            if alreadyAlerted { continue }

            if legendaryTypes.contains(ac.aircraftType) {
                alertedIcaos.insert(ac.icao24)
                fireLegendaryAlert(ac)
            } else if ac.isEmergency {
                alertedIcaos.insert(ac.icao24)
                fireEmergencyAlert(ac)
            } else if ac.distNm <= alertRadiusNm {
                alertedIcaos.insert(ac.icao24)
                fireStandardAlert(ac)
            }
        }
    }

    private func fireStandardAlert(_ ac: Aircraft) {
        guard audioEnabled else { return }
        if ac.isMilitary {
            AudioService.shared.playAmericaClip {
                AudioService.shared.speak("Military aircraft in alert zone. \(self.announceAircraft(ac))")
            }
        } else {
            AudioService.shared.playChimes(count: 1) {
                AudioService.shared.speak(self.announceAircraft(ac))
            }
        }
    }

    private func fireLegendaryAlert(_ ac: Aircraft) {
        guard audioEnabled else { return }
        let line: String
        switch ac.aircraftType {
        case "U2":   line = "Lockheed U-2. Dragon Lady."
        case "VC25": line = "VC-25. The President's aircraft. Air Force One."
        case "B52H": line = "B-52 Stratofortress. Still flying after 70 years."
        case "E3C":  line = "E-3 Sentry AWACS. Eyes in the sky."
        default:     line = "Special aircraft on radar. \(ac.aircraftType)."
        }
        AudioService.shared.playChimes(count: 2) {
            AudioService.shared.speak(line)
        }
    }

    private func fireEmergencyAlert(_ ac: Aircraft) {
        guard audioEnabled else { return }
        let squawkName: String
        switch ac.squawk {
        case "7500": squawkName = "hijack"
        case "7600": squawkName = "lost communications"
        case "7700": squawkName = "general emergency"
        default:     squawkName = "emergency"
        }
        AudioService.shared.playChimes(count: 3) {
            AudioService.shared.speak("Emergency. Squawk \(squawkName). \(self.announceAircraft(ac))")
        }
    }

    private func announceAircraft(_ ac: Aircraft) -> String {
        var parts: [String] = []
        if !ac.callsign.isEmpty { parts.append(ac.callsign) }
        if !ac.aircraftType.isEmpty { parts.append(ac.aircraftType) }
        parts.append("\(Int(ac.distNm)) miles out")
        if ac.baroAlt > 0 { parts.append("altitude \(Int(ac.baroAlt) / 100) hundred feet") }
        return parts.joined(separator: ". ")
    }
}

private extension Double {
    var nonZero: Double? { self == 0 ? nil : self }
}
