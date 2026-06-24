import SwiftUI

struct AircraftRow: View {
    let aircraft: Aircraft

    var body: some View {
        HStack(spacing: 10) {
            // Distance badge
            VStack(spacing: 1) {
                Text(String(format: "%.1f", aircraft.distNm))
                    .font(.system(size: 15, weight: .bold, design: .monospaced))
                    .foregroundColor(rowColor)
                Text("nm")
                    .font(.system(size: 9))
                    .foregroundColor(.secondary)
            }
            .frame(width: 44)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(aircraft.displayCallsign)
                        .font(.system(size: 14, weight: .semibold, design: .monospaced))
                        .foregroundColor(rowColor)
                    if aircraft.isMilitary {
                        Text("MIL")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(.black)
                            .padding(.horizontal, 3)
                            .padding(.vertical, 1)
                            .background(Color.yellow)
                            .cornerRadius(2)
                    }
                    if aircraft.isEmergency {
                        Text("EMER")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 3)
                            .padding(.vertical, 1)
                            .background(Color.red)
                            .cornerRadius(2)
                    }
                }
                HStack(spacing: 6) {
                    if !aircraft.aircraftType.isEmpty {
                        Text(aircraft.aircraftType)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.secondary)
                    }
                    Text(aircraft.altitudeDisplay)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.secondary)
                    if aircraft.velocity > 0 {
                        Text("\(aircraft.velocity)kt")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.secondary)
                    }
                }
            }

            Spacer()

            Image(systemName: "airplane")
                .font(.system(size: 14))
                .foregroundColor(rowColor.opacity(0.6))
                .rotationEffect(.degrees(aircraft.trueTrack - 90))
        }
        .padding(.vertical, 4)
    }

    var rowColor: Color {
        if aircraft.isEmergency { return .red }
        if aircraft.isMilitary { return .yellow }
        return .green
    }
}
