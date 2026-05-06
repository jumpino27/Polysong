import type { Track } from '../../types'

type EngineListener = () => void

class AudioEngine {
  private audio = new Audio()
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private gain: GainNode | null = null
  private source: MediaElementAudioSourceNode | null = null
  private listeners = new Set<EngineListener>()

  currentTrack: Track | null = null
  isPlaying = false
  volume = 0.82

  constructor() {
    this.audio.crossOrigin = 'anonymous'
    this.audio.addEventListener('play', () => this.setPlaying(true))
    this.audio.addEventListener('pause', () => this.setPlaying(false))
    this.audio.addEventListener('ended', () => this.setPlaying(false))
  }

  subscribe(listener: EngineListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  load(track: Track) {
    this.currentTrack = track
    this.audio.src = this.resolveSource(track)
    this.notify()
  }

  async play() {
    this.ensureGraph()
    await this.context?.resume()
    try {
      await this.audio.play()
    } catch {
      this.setPlaying(false)
    }
  }

  pause() {
    this.audio.pause()
  }

  seek(seconds: number) {
    this.audio.currentTime = seconds
  }

  setVolume(value: number) {
    this.volume = value
    if (this.gain) this.gain.gain.value = value
    this.audio.volume = value
    this.notify()
  }

  getFrequencyData(out: Uint8Array<ArrayBuffer>) {
    if (!this.analyser) {
      out.fill(0)
      return
    }
    this.analyser.getByteFrequencyData(out)
  }

  getWaveformData(out: Uint8Array<ArrayBuffer>) {
    if (!this.analyser) {
      out.fill(128)
      return
    }
    this.analyser.getByteTimeDomainData(out)
  }

  private ensureGraph() {
    if (this.context) return
    this.context = new AudioContext()
    this.source = this.context.createMediaElementSource(this.audio)
    this.analyser = this.context.createAnalyser()
    this.gain = this.context.createGain()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.85
    this.gain.gain.value = this.volume
    this.source.connect(this.analyser)
    this.analyser.connect(this.gain)
    this.gain.connect(this.context.destination)
  }

  private resolveSource(track: Track) {
    if ((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      return `polysong://track/${track.id}`
    }

    return 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='
  }

  private setPlaying(value: boolean) {
    this.isPlaying = value
    this.notify()
  }

  private notify() {
    this.listeners.forEach((listener) => listener())
  }
}

export const audioEngine = new AudioEngine()
