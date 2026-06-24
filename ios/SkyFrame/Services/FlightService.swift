import Foundation

class FlightService {
    static let workerURL = "https://skyframe2-worker.tom-tsutton.workers.dev"

    func fetchFlights(lat: Double, lon: Double, distNm: Double) async throws -> [Aircraft] {
        guard let url = URL(string: "\(Self.workerURL)/flights?lat=\(lat)&lon=\(lon)&dist=\(Int(distNm))") else {
            throw URLError(.badURL)
        }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        // Worker returns either an array directly or { aircraft: [...] }
        if let array = try? JSONDecoder().decode([Aircraft].self, from: data) {
            return array
        }
        return try JSONDecoder().decode(FlightResponse.self, from: data).aircraft
    }
}
