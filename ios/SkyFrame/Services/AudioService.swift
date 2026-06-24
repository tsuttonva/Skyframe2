import AVFoundation

class AudioService: NSObject {
    static let shared = AudioService()

    var isEnabled: Bool = true

    private let speechSynth = AVSpeechSynthesizer()
    private var engine: AVAudioEngine?
    private var americaPlayer: AVAudioPlayer?
    private var sessionReady = false

    // Nothing in init — all AVAudio* setup is deferred to first use.
    override private init() { super.init() }

    private func ensureSession() {
        guard !sessionReady else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .default, options: [.duckOthers, .mixWithOthers])
        try? s.setActive(true)
        sessionReady = true
    }

    private func ensureEngine() -> AVAudioEngine? {
        if engine == nil {
            ensureSession()
            engine = AVAudioEngine()
        }
        if let e = engine, !e.isRunning {
            do { try e.start() } catch { return nil }
        }
        return engine
    }

    private func ensurePlayer() {
        guard americaPlayer == nil,
              let url = Bundle.main.url(forResource: "america", withExtension: "mp3"),
              let player = try? AVAudioPlayer(contentsOf: url) else { return }
        player.prepareToPlay()
        americaPlayer = player
    }

    // Plays america.mp3 then calls completion when done (or immediately on failure).
    func playAmericaClip(completion: @escaping () -> Void) {
        guard isEnabled else { completion(); return }
        ensureSession()
        ensurePlayer()
        guard let player = americaPlayer else { completion(); return }
        player.currentTime = 0
        let duration = player.duration
        player.play()
        DispatchQueue.main.asyncAfter(deadline: .now() + max(duration, 0.1)) {
            completion()
        }
    }

    func playChimes(count: Int = 1, completion: @escaping () -> Void = {}) {
        guard isEnabled else { completion(); return }
        guard let eng = ensureEngine() else { completion(); return }

        let sampleRate = eng.mainMixerNode.outputFormat(forBus: 0).sampleRate
        guard sampleRate > 0 else { completion(); return }

        let duration = 0.22
        let gap = 0.45
        for i in 0..<count {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * gap) {
                self.playTone(engine: eng, frequency: 880, duration: duration, sampleRate: sampleRate)
            }
        }
        let total = Double(count) * gap + duration
        DispatchQueue.main.asyncAfter(deadline: .now() + total + 0.1) { completion() }
    }

    private func playTone(engine: AVAudioEngine, frequency: Double, duration: Double, sampleRate: Double) {
        let frameCount = AVAudioFrameCount(sampleRate * duration)
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
        buffer.frameLength = frameCount
        let data = buffer.floatChannelData![0]
        for i in 0..<Int(frameCount) {
            let t = Double(i) / sampleRate
            let env = min(t / 0.01, 1.0) * max(1.0 - (t - duration + 0.05) / 0.05, 0.0)
            data[i] = Float(sin(2 * .pi * frequency * t) * 0.4 * env)
        }
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        player.scheduleBuffer(buffer, at: nil) { self.engine?.detach(player) }
        player.play()
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
