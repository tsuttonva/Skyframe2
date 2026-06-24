import SwiftUI

struct DetailView: View {
    let aircraft: Aircraft
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Identity") {
                    row("Callsign", aircraft.displayCallsign)
                    row("ICAO24", aircraft.icao24.uppercased())
                    if !aircraft.aircraftType.isEmpty {
                        row("Type", aircraft.aircraftType)
                    }
                    if !aircraft.squawk.isEmpty {
                        row("Squawk", aircraft.squawk)
                    }
                }

                Section("Position") {
                    row("Distance", String(format: "%.1f nm", aircraft.distNm))
                    row("Latitude", String(format: "%.4f°", aircraft.lat))
                    row("Longitude", String(format: "%.4f°", aircraft.lon))
                    row("Heading", "\(Int(aircraft.trueTrack))°")
                }

                Section("Altitude & Speed") {
                    row("Altitude", aircraft.baroAlt > 0 ? "\(aircraft.baroAlt) ft (\(aircraft.altitudeDisplay))" : "On ground")
                    row("Speed", aircraft.velocity > 0 ? "\(aircraft.velocity) kt" : "—")
                    if aircraft.vertRate != 0 {
                        row("Vert Rate", "\(aircraft.vertRate > 0 ? "+" : "")\(aircraft.vertRate) fpm")
                    }
                }

                Section("Classification") {
                    row("Military", aircraft.isMilitary ? "Yes" : "No")
                    if aircraft.isEmergency {
                        row("Emergency", squawkName(aircraft.squawk))
                            .foregroundColor(.red)
                    }
                }
            }
            .navigationTitle(aircraft.displayCallsign)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundColor(.secondary)
            Spacer()
            Text(value).font(.system(.body, design: .monospaced))
        }
    }

    private func squawkName(_ squawk: String) -> String {
        switch squawk {
        case "7500": return "Hijack"
        case "7600": return "Lost Comms"
        case "7700": return "General Emergency"
        default: return squawk
        }
    }
}
