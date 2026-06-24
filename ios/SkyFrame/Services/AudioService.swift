import AVFoundation

// Handles chimes, voice announcements, and the america.mp3 clip.
// All audio goes through AVAudioEngine so there is one pipeline and
// no iOS audio-session conflicts between the mp3 and the tones.
class AudioService: NSObject {
    static let shared = AudioService()

    var isEnabled: Bool = true

    private let engine = AVAudioEngine()
    private let speechSynth = AVSpeechSynthesizer()
    private var americaBuffer: AVAudioPCMBuffer?
    private var isEngineRunning = false

    override private init() {
        super.init()
        configureSession()
        loadAmericaClip()
    }

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.duckOthers, .mixWithOthers])
        try? session.setActive(true)
    }

    private func startEngine() {
        guard !isEngineRunning else { return }
        do {
            try engine.start()
            isEngineRunning = true
        } catch {
            print("AudioEngine start failed: \(error)")
        }
    }

    private func loadAmericaClip() {
        guard let url = Bundle.main.url(forResource: "america", withExtension: "mp3") else { return }
        guard let file = try? AVAudioFile(forReading: url) else { return }
        let frameCount = AVAudioFrameCount(file.length)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frameCount) else { return }
        try? file.read(into: buffer)
        americaBuffer = buffer
    }

    // Plays america.mp3 then resolves; calls completion when done (or immediately on failure).
    func playAmericaClip(completion: @escaping () -> Void) {
        guard isEnabled, let buffer = americaBuffer else {
            completion(); return
        }
        startEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
        player.scheduleBuffer(buffer, at: nil, options: []) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.engine.detach(player)
                completion()
            }
        }
        player.play()
    }

    func playChimes(count: Int = 1, completion: @escaping () -> Void = {}) {
        guard isEnabled else { completion(); return }
        startEngine()
        let sampleRate = engine.mainMixerNode.outputFormat(forBus: 0).sampleRate
        guard sampleRate > 0 else { completion(); return }

        let duration: Double = 0.22
        let gap: Double = 0.45
        let totalDuration = Double(count) * gap + duration

        for i in 0..<count {
            let delay = Double(i) * gap
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                self.playTone(frequency: 880, duration: duration, sampleRate: sampleRate)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + totalDuration + 0.1) {
            completion()
        }
    }

    private func playTone(frequency: Double, duration: Double, sampleRate: Double) {
        let frameCount = AVAudioFrameCount(sampleRate * duration)
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
        buffer.frameLength = frameCount
        let data = buffer.floatChannelData![0]
        for i in 0..<Int(frameCount) {
            let t = Double(i) / sampleRate
            let envelope = min(t / 0.01, 1.0) * max(1.0 - (t - duration + 0.05) / 0.05, 0.0)
            data[i] = Float(sin(2 * .pi * frequency * t) * 0.4 * envelope)
        }
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        player.scheduleBuffer(buffer, at: nil, options: []) {
            self.engine.detach(player)
        }
        player.play()
    }

    func speak(_ text: String) {
        guard isEnabled else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = 0.52
        utterance.pitchMultiplier = 1.0
        utterance.volume = 0.9
        speechSynth.stopSpeaking(at: .word)
        speechSynth.speak(utterance)
    }
}
