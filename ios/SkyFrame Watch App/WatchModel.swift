import Foundation
import CoreLocation
import WatchKit

@MainActor
class WatchModel: ObservableObject {
    @Published var aircraft: [Aircraft] = []
    @Published var isLoading = false
    @Published var lastUpdated: Date?
    @Published var locationLabel: String = "—"

    @Published var alertRadiusNm: Double {
        didSet { UserDefaults.standard.set(alertRadiusNm, forKey: "alertRadius") }
    }
    @Published var radarRadiusNm: Double {
        didSet { UserDefaults.standard.set(radarRadiusNm, forKey: "radarRadius") }
    }

    private let flightService = FlightService()
    private let locationService = LocationService()
    private var alertedIcaos: Set<String> = []
    private var refreshTask: Task<Void, Never>?

    var militaryCount: Int { aircraft.filter(\.isMilitary).count }
    var emergencyCount: Int { aircraft.filter(\.isEmergency).count }
    var nearbyCount: Int { aircraft.filter { $0.distNm <= alertRadiusNm }.count }

    init() {
        radarRadiusNm = UserDefaults.standard.double(forKey: "radarRadius").nonZero ?? 50
        alertRadiusNm = UserDefaults.standard.double(forKey: "alertRadius").nonZero ?? 15
        locationService.requestPermission()
        startAutoRefresh()
    }

    func startAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
    }

    func refresh() async {
        guard let coord = locationService.coordinate else { return }
        isLoading = true
        locationLabel = String(format: "%.2f°, %.2f°", coord.latitude, coord.longitude)
        do {
            let newAircraft = try await flightService.fetchFlights(
                lat: coord.latitude, lon: coord.longitude, distNm: radarRadiusNm
            )
            aircraft = newAircraft.sorted { $0.distNm < $1.distNm }
            lastUpdated = Date()
            checkAlerts()
        } catch { /* retry next cycle */ }
        isLoading = false
    }

    private func checkAlerts() {
        let seenIcaos = Set(aircraft.map(\.icao24))
        alertedIcaos = alertedIcaos.intersection(seenIcaos)

        for ac in aircraft {
            guard !alertedIcaos.contains(ac.icao24) else { continue }
            if ac.distNm <= alertRadiusNm || ac.isEmergency || ac.isMilitary {
                alertedIcaos.insert(ac.icao24)
                fireHapticAlert(for: ac)
            }
        }
    }

    private func fireHapticAlert(for ac: Aircraft) {
        if ac.isEmergency {
            WKInterfaceDevice.current().play(.failure)
        } else if ac.isMilitary {
            WKInterfaceDevice.current().play(.notification)
        } else {
            WKInterfaceDevice.current().play(.click)
        }
    }
}

private extension Double {
    var nonZero: Double? { self == 0 ? nil : self }
}
