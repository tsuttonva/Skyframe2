import SwiftUI

@main
struct SkyFrameWatchApp: App {
    @StateObject private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            WatchContentView()
                .environmentObject(model)
        }
    }
}
