import SwiftUI

struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @State private var selectedAircraft: Aircraft?
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                statsHeader
                    .background(Color(white: 0.08))

                if model.aircraft.isEmpty && !model.isLoading {
                    emptyState
                } else {
                    aircraftList
                }
            }
            .navigationTitle("SkyFrame")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarItems }
            .sheet(item: $selectedAircraft) { ac in
                DetailView(aircraft: ac)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView().environmentObject(model)
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            if model.effectiveLocation != nil {
                Task { await model.refresh() }
            }
        }
    }

    private var statsHeader: some View {
        HStack(spacing: 0) {
            statCell(value: "\(model.aircraft.count)", label: "OVERHEAD")
            Divider().frame(height: 32).background(Color.white.opacity(0.2))
            statCell(value: model.highestAlt > 0 ? "\(model.highestAlt)" : "—", label: "HIGHEST FT")
            Divider().frame(height: 32).background(Color.white.opacity(0.2))
            statCell(value: model.fastestSpeed > 0 ? "\(model.fastestSpeed)" : "—", label: "FASTEST KT")
            Divider().frame(height: 32).background(Color.white.opacity(0.2))
            statCell(value: "\(Int(model.radarRadiusNm))nm", label: "RADAR")
            Divider().frame(height: 32).background(Color.white.opacity(0.2))
            statCell(value: "\(Int(model.alertRadiusNm))nm", label: "ALERT")
        }
        .padding(.vertical, 8)
    }

    private func statCell(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 14, weight: .bold, design: .monospaced))
                .foregroundColor(.green)
            Text(label)
                .font(.system(size: 8))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var aircraftList: some View {
        List(model.aircraft) { ac in
            AircraftRow(aircraft: ac)
                .contentShape(Rectangle())
                .onTapGesture { selectedAircraft = ac }
                .listRowBackground(Color(white: 0.05))
                .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
        }
        .listStyle(.plain)
        .background(Color.black)
        .refreshable { await model.refresh() }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 48))
                .foregroundColor(.green.opacity(0.5))
            if model.effectiveLocation == nil {
                Text("Waiting for location…")
                    .foregroundColor(.secondary)
                Button("Use Custom Location") { showSettings = true }
                    .buttonStyle(.bordered)
                    .tint(.green)
            } else {
                Text(model.errorMessage ?? "No aircraft in range")
                    .foregroundColor(model.errorMessage != nil ? .red : .secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(Color.black)
    }

    @ToolbarContentBuilder
    private var toolbarItems: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            HStack(spacing: 4) {
                Circle()
                    .fill(model.isLoading ? Color.yellow : Color.green)
                    .frame(width: 8, height: 8)
                Text(model.locationLabel)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
            }
            .tint(.green)
        }
    }
}
