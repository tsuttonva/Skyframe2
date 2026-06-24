import SwiftUI

struct WatchContentView: View {
    @EnvironmentObject var model: WatchModel

    var body: some View {
        NavigationStack {
            if model.aircraft.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .foregroundColor(.green)
                    Text(model.isLoading ? "Scanning…" : "No aircraft")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            } else {
                List {
                    // Summary row
                    HStack {
                        Label("\(model.aircraft.count)", systemImage: "airplane")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(.green)
                        Spacer()
                        if model.militaryCount > 0 {
                            Text("MIL \(model.militaryCount)")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(.yellow)
                        }
                        if model.emergencyCount > 0 {
                            Text("EMER \(model.emergencyCount)")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(.red)
                        }
                    }
                    .listRowBackground(Color(white: 0.1))

                    // Aircraft rows (top 10 closest)
                    ForEach(model.aircraft.prefix(10)) { ac in
                        NavigationLink {
                            WatchDetailView(aircraft: ac)
                        } label: {
                            WatchAircraftRow(aircraft: ac)
                        }
                        .listRowBackground(Color(white: 0.05))
                    }
                }
                .listStyle(.carousel)
            }
        }
        .navigationTitle("SkyFrame")
    }
}

struct WatchAircraftRow: View {
    let aircraft: Aircraft

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(aircraft.displayCallsign)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundColor(rowColor)
                    .lineLimit(1)
                if aircraft.isMilitary {
                    Text("MIL")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(.black)
                        .padding(.horizontal, 2)
                        .background(Color.yellow)
                        .cornerRadius(2)
                }
            }
            Text(String(format: "%.1f nm · %@", aircraft.distNm, aircraft.altitudeDisplay))
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.secondary)
        }
    }

    var rowColor: Color {
        if aircraft.isEmergency { return .red }
        if aircraft.isMilitary { return .yellow }
        return .green
    }
}

struct WatchDetailView: View {
    let aircraft: Aircraft

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text(aircraft.displayCallsign)
                    .font(.system(size: 14, weight: .bold, design: .monospaced))
                    .foregroundColor(aircraft.isMilitary ? .yellow : .green)

                if !aircraft.aircraftType.isEmpty {
                    detailRow("Type", aircraft.aircraftType)
                }
                detailRow("Dist", String(format: "%.1f nm", aircraft.distNm))
                detailRow("Alt", aircraft.altitudeDisplay)
                if aircraft.velocity > 0 {
                    detailRow("Speed", "\(aircraft.velocity) kt")
                }
                detailRow("Hdg", "\(Int(aircraft.trueTrack))°")
                if aircraft.isMilitary {
                    Text("MILITARY")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.yellow)
                        .padding(.top, 2)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.system(size: 10)).foregroundColor(.secondary)
            Spacer()
            Text(value).font(.system(size: 11, design: .monospaced))
        }
    }
}
