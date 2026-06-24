import Foundation

struct Aircraft: Identifiable, Decodable, Equatable {
    let icao24: String
    let callsign: String
    let lat: Double
    let lon: Double
    let baroAlt: Double
    let velocity: Double
    let trueTrack: Double
    let vertRate: Double
    let squawk: String
    let aircraftType: String
    let isMilitary: Bool
    let distKm: Double

    var id: String { icao24 }
    var distNm: Double { distKm / 1.852 }

    var isEmergency: Bool {
        ["7500", "7600", "7700"].contains(squawk)
    }

    var displayCallsign: String {
        callsign.isEmpty ? icao24.uppercased() : callsign
    }

    var altitudeDisplay: String {
        baroAlt > 0 ? "FL\(Int(baroAlt) / 100)" : "GND"
    }

    enum CodingKeys: String, CodingKey {
        case icao24, callsign, lat, lon
        case baroAlt = "baro_alt"
        case velocity
        case trueTrack = "true_track"
        case vertRate = "vert_rate"
        case squawk
        case aircraftType = "aircraft_type"
        case isMilitary = "is_military"
        case distKm = "dist_km"
    }
}

struct FlightResponse: Decodable {
    let aircraft: [Aircraft]
}
