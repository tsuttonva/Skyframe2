import SwiftUI
import CoreLocation

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var showLocationEntry = false
    @State private var customLatText = ""
    @State private var customLonText = ""
    @State private var customLabelText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Location") {
                    Toggle("Use Current Location", isOn: useCurrentLocationBinding)
                    if model.customLocation != nil {
                        Button("Change Custom Location") { showLocationEntry = true }
                        Text(model.customLocationLabel.isEmpty ? "Custom Location" : model.customLocationLabel)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    if model.customLocation == nil {
                        if let loc = model.locationService.coordinate {
                            Text(String(format: "%.4f°, %.4f°", loc.latitude, loc.longitude))
                                .font(.caption)
                                .foregroundColor(.secondary)
                        } else {
                            Text("Waiting for GPS…")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }

                Section("Radar") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Radar Radius: \(Int(model.radarRadiusNm)) nm")
                        Slider(value: $model.radarRadiusNm, in: 5...300, step: 5)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Alert Radius: \(Int(model.alertRadiusNm)) nm")
                        Slider(value: $model.alertRadiusNm, in: 1...20, step: 1)
                    }
                }

                Section("Audio") {
                    Toggle("Enable Audio Alerts", isOn: $model.audioEnabled)
                }

                Section("About") {
                    HStack {
                        Text("Backend")
                        Spacer()
                        Text("skyframe2-worker").font(.caption).foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Refresh Interval")
                        Spacer()
                        Text("30 seconds").foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showLocationEntry) {
                customLocationSheet
            }
        }
        .preferredColorScheme(.dark)
    }

    private var useCurrentLocationBinding: Binding<Bool> {
        Binding(
            get: { model.customLocation == nil },
            set: { useGPS in
                if useGPS {
                    model.customLocation = nil
                } else {
                    showLocationEntry = true
                }
            }
        )
    }

    private var customLocationSheet: some View {
        NavigationStack {
            Form {
                Section("Coordinates") {
                    TextField("Latitude (e.g. 38.6862)", text: $customLatText)
                        .keyboardType(.decimalPad)
                    TextField("Longitude (e.g. -77.7997)", text: $customLonText)
                        .keyboardType(.decimalPad)
                }
                Section("Label (optional)") {
                    TextField("e.g. Home, Work…", text: $customLabelText)
                }
            }
            .navigationTitle("Custom Location")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { showLocationEntry = false }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        if let lat = Double(customLatText), let lon = Double(customLonText) {
                            model.customLocation = CLLocationCoordinate2D(latitude: lat, longitude: lon)
                            model.customLocationLabel = customLabelText
                            showLocationEntry = false
                        }
                    }
                    .disabled(Double(customLatText) == nil || Double(customLonText) == nil)
                }
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            if let loc = model.customLocation {
                customLatText = String(loc.latitude)
                customLonText = String(loc.longitude)
                customLabelText = model.customLocationLabel
            }
        }
    }
}
