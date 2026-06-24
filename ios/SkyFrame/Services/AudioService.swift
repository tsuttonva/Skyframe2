import AVFoundation
import AudioToolbox

class AudioService: NSObject {
    static let shared = AudioService()

    var isEnabled: Bool = true

    private lazy var speechSynth = AVSpeechSynthesizer()
    private var americaPlayer: AVAudioPlayer?
    private var sessionConfigured = false

    override private init() { super.init() }

    private func configureSession() {
        guard !sessionConfigured else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .default, options: [.duckOthers, .mixWithOthers])
        try? s.setActive(true)
        sessionConfigured = true
    }

    private func ensurePlayer() {
        guard americaPlayer == nil,
              let url = Bundle.main.url(forResource: "america", withExtension: "mp3"),
              let player = try? AVAudioPlayer(contentsOf: url) else { return }
        player.prepareToPlay()
        americaPlayer = player
    }

    func playAmericaClip(completion: @escaping () -> Void) {
        guard isEnabled else { completion(); return }
        configureSession()
        ensurePlayer()
        guard let player = americaPlayer else { completion(); return }
        player.currentTime = 0
        player.play()
        DispatchQueue.main.asyncAfter(deadline: .now() + max(player.duration, 0.1)) {
            completion()
        }
    }

    func playChimes(count: Int = 1, completion: @escaping () -> Void = {}) {
        guard isEnabled else { completion(); return }
        // AudioServicesPlaySystemSound requires no setup and never crashes.
        // 1057 = "Tink" -- a short pleasant chime, good for alerts.
        for i in 0..<count {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.45) {
                AudioServicesPlaySystemSound(1057)
            }
        }
        let total = Double(count) * 0.45 + 0.3
        DispatchQueue.main.asyncAfter(deadline: .now() + total) { completion() }
    }

    func speak(_ text: String) {
        guard isEnabled else { return }
        let u = AVSpeechUtterance(string: text)
        u.rate = 0.52
        u.volume = 0.9
        speechSynth.stopSpeaking(at: .word)
        speechSynth.speak(u)
    }
}
