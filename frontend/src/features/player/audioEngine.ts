import type { Track } from '../../types'
import { mediaUrl } from '../../lib/tauri'

type EngineListener = () => void

export type RepeatMode = 'off' | 'all' | 'one'

const VOLUME_KEY = 'polysong:volume'
const SHUFFLE_KEY = 'polysong:shuffle'
const REPEAT_KEY = 'polysong:repeat'

function readStoredVolume(fallback: number) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY)
    if (raw == null) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(0, Math.min(1, value))
  } catch {
    return fallback
  }
}

function readStoredBool(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return fallback
    return raw === 'true'
  } catch {
    return fallback
  }
}

function readStoredRepeat(): RepeatMode {
  if (typeof window === 'undefined') return 'off'
  try {
    const raw = window.localStorage.getItem(REPEAT_KEY)
    if (raw === 'all' || raw === 'one') return raw
    return 'off'
  } catch {
    return 'off'
  }
}

function writeStored(key: string, value: string) {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

class AudioEngine {
  private audio = new Audio()
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private gain: GainNode | null = null
  private source: MediaElementAudioSourceNode | null = null
  private listeners = new Set<EngineListener>()

  // Track loaded as a Blob URL so seek works without backend Range support.
  // Streaming `<audio>` from a server that doesn't honor Range headers makes
  // seeks past the buffered window either fail silently or refetch from byte 0
  // (which is what makes the song appear to "restart"). By fetching the whole
  // file into a Blob and setting `audio.src` to a blob: URL, the entire media
  // sits in browser memory and `audio.currentTime = X` is instant and reliable.
  private currentBlobUrl: string | null = null
  private currentLoadId = 0
  private playOnReady = false

  // Seek target the user requested. Suppresses stale timeupdate events while a
  // seek is in flight so the slider doesn't snap back during the seek.
  private pendingSeekTarget: number | null = null
  private seekConfirmTimer: number | null = null

  // Captured queue scoped to the place the user pressed play.
  queue: Track[] = []
  queueLabel = ''
  private playOrder: number[] = []
  private position = -1

  shuffleEnabled = readStoredBool(SHUFFLE_KEY, false)
  repeatMode: RepeatMode = readStoredRepeat()

  currentTrack: Track | null = null
  isPlaying = false
  isLoading = false
  currentTime = 0
  duration = 0
  volume = readStoredVolume(0.7)

  constructor() {
    this.audio.crossOrigin = 'anonymous'
    this.audio.volume = this.volume
    this.audio.preload = 'auto'

    this.audio.addEventListener('play', () => this.setPlaying(true))
    this.audio.addEventListener('pause', () => this.setPlaying(false))
    this.audio.addEventListener('ended', () => {
      this.setPlaying(false)
      void this.handleEnded()
    })

    this.audio.addEventListener('timeupdate', () => {
      if (this.pendingSeekTarget !== null) return
      this.currentTime = this.audio.currentTime || 0
      this.notify()
    })

    this.audio.addEventListener('seeked', () => this.confirmSeek())

    this.audio.addEventListener('loadedmetadata', () => {
      this.duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0
      this.currentTime = this.audio.currentTime || 0
      this.notify()
    })

    this.audio.addEventListener('emptied', () => {
      this.duration = 0
      this.currentTime = 0
      this.pendingSeekTarget = null
      if (this.seekConfirmTimer != null) {
        window.clearTimeout(this.seekConfirmTimer)
        this.seekConfirmTimer = null
      }
      this.notify()
    })
  }

  subscribe(listener: EngineListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  startQueue(tracks: Track[], label: string, startTrackId: number) {
    this.queue = [...tracks]
    this.queueLabel = label
    this.rebuildPlayOrder(startTrackId)
    const startTrack = this.queue.find((track) => track.id === startTrackId) ?? this.queue[0]
    if (!startTrack) return
    this.playOnReady = true
    void this.load(startTrack)
  }

  setQueue(tracks: Track[], label: string) {
    this.queue = [...tracks]
    this.queueLabel = label
    this.rebuildPlayOrder(this.currentTrack?.id ?? null)
    this.notify()
  }

  setShuffle(enabled: boolean) {
    if (this.shuffleEnabled === enabled) return
    this.shuffleEnabled = enabled
    writeStored(SHUFFLE_KEY, String(enabled))
    this.rebuildPlayOrder(this.currentTrack?.id ?? null)
    this.notify()
  }

  toggleShuffle() {
    this.setShuffle(!this.shuffleEnabled)
  }

  setRepeatMode(mode: RepeatMode) {
    this.repeatMode = mode
    writeStored(REPEAT_KEY, mode)
    this.notify()
  }

  cycleRepeat() {
    const next: RepeatMode = this.repeatMode === 'off' ? 'all' : this.repeatMode === 'all' ? 'one' : 'off'
    this.setRepeatMode(next)
  }

  getQueueInPlayOrder(): Track[] {
    if (!this.queue.length) return []
    if (this.position < 0) return this.playOrder.map((idx) => this.queue[idx])
    return this.playOrder.slice(this.position).map((idx) => this.queue[idx])
  }

  /**
   * Load a track into the audio element. Fetches the entire file as a Blob
   * first so the audio element gets a `blob:` URL, which makes seeks work
   * regardless of the backend's HTTP Range support.
   */
  async load(track: Track): Promise<void> {
    const loadId = ++this.currentLoadId
    this.currentTrack = track
    this.duration = 0
    this.currentTime = 0
    this.pendingSeekTarget = null
    if (this.seekConfirmTimer != null) {
      window.clearTimeout(this.seekConfirmTimer)
      this.seekConfirmTimer = null
    }
    this.position = this.playOrder.findIndex((idx) => this.queue[idx]?.id === track.id)
    this.isLoading = true
    this.notify()

    const url = this.resolveSource(track)
    if (!url) {
      this.audio.src = ''
      this.isLoading = false
      this.notify()
      return
    }

    // Free the previous blob URL — we always replace it on every load so we
    // don't accumulate audio data in memory across track changes.
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl)
      this.currentBlobUrl = null
    }

    if (url.startsWith('http://polysong.localhost/')) {
      this.audio.src = url
      this.isLoading = false
      this.notify()
      if (loadId === this.currentLoadId && this.playOnReady) {
        this.playOnReady = false
        try {
          await this.play()
        } catch {
          /* ignore */
        }
      }
      return
    }

    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`fetch failed: ${response.status}`)
      const blob = await response.blob()
      // If a newer load started while we were fetching, abandon this one.
      if (loadId !== this.currentLoadId) {
        return
      }
      const blobUrl = URL.createObjectURL(blob)
      this.currentBlobUrl = blobUrl
      this.audio.src = blobUrl
    } catch (error) {
      // Fall back to streaming URL — seek may misbehave without Range support
      // but at least playback works.
      console.warn('Polysong: failed to preload track as blob, falling back to streaming.', error)
      if (loadId !== this.currentLoadId) return
      this.audio.src = url
    }

    this.isLoading = false
    this.notify()

    if (loadId === this.currentLoadId && this.playOnReady) {
      this.playOnReady = false
      try {
        await this.play()
      } catch {
        /* ignore */
      }
    }
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

  toggle() {
    if (this.audio.paused) return this.play()
    this.pause()
    return Promise.resolve()
  }

  /**
   * Move the playhead to a target time. Locks `currentTime` to the target and
   * suppresses timeupdate until the audio element fires `seeked` so the slider
   * stays where the user dragged it.
   */
  seek(seconds: number) {
    if (!Number.isFinite(seconds)) return
    if (!this.audio.src) return
    const max = this.duration > 0 ? this.duration : Number.POSITIVE_INFINITY
    const clamped = Math.max(0, Math.min(seconds, max))
    this.pendingSeekTarget = clamped
    this.currentTime = clamped
    try {
      this.audio.currentTime = clamped
    } catch {
      /* ignore */
    }
    if (this.seekConfirmTimer != null) window.clearTimeout(this.seekConfirmTimer)
    this.seekConfirmTimer = window.setTimeout(() => this.confirmSeek(), 800)
    this.notify()
  }

  seekBy(deltaSeconds: number) {
    this.seek((this.audio.currentTime || 0) + deltaSeconds)
  }

  setVolume(value: number) {
    const next = Math.max(0, Math.min(1, value))
    this.volume = next
    if (this.gain) this.gain.gain.value = next
    this.audio.volume = next
    writeStored(VOLUME_KEY, String(next))
    this.notify()
  }

  async next() {
    if (!this.queue.length || !this.playOrder.length) return
    if (this.repeatMode === 'one') {
      this.seek(0)
      await this.play()
      return
    }
    if (this.position < 0) this.position = -1
    let nextPos = this.position + 1
    if (nextPos >= this.playOrder.length) {
      if (this.repeatMode === 'all') {
        if (this.shuffleEnabled) this.rebuildPlayOrder(null)
        nextPos = 0
      } else {
        return
      }
    }
    this.position = nextPos
    const track = this.queue[this.playOrder[nextPos]]
    if (!track) return
    this.playOnReady = true
    await this.load(track)
  }

  async previous() {
    if (!this.queue.length || !this.playOrder.length) return
    if (this.audio.currentTime > 3) {
      this.seek(0)
      return
    }
    let prevPos = this.position - 1
    if (prevPos < 0) {
      if (this.repeatMode === 'all') {
        prevPos = this.playOrder.length - 1
      } else {
        this.seek(0)
        return
      }
    }
    this.position = prevPos
    const track = this.queue[this.playOrder[prevPos]]
    if (!track) return
    this.playOnReady = true
    await this.load(track)
  }

  hasPrevious() {
    if (!this.queue.length) return false
    if (this.repeatMode === 'all') return true
    return this.position > 0
  }

  hasNext() {
    if (!this.queue.length) return false
    if (this.repeatMode !== 'off') return true
    return this.position >= 0 && this.position < this.playOrder.length - 1
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

  getBassEnergy(): number {
    if (!this.analyser) return 0
    const frequencyBinCount = this.analyser.frequencyBinCount
    const data = new Uint8Array(frequencyBinCount)
    this.analyser.getByteFrequencyData(data)
    const cutoff = Math.max(4, Math.floor(frequencyBinCount * 0.08))
    let sum = 0
    for (let i = 0; i < cutoff; i += 1) sum += data[i]
    return sum / (cutoff * 255)
  }

  private confirmSeek() {
    this.pendingSeekTarget = null
    if (this.seekConfirmTimer != null) {
      window.clearTimeout(this.seekConfirmTimer)
      this.seekConfirmTimer = null
    }
  }

  private rebuildPlayOrder(activeId: number | null) {
    if (!this.queue.length) {
      this.playOrder = []
      this.position = -1
      return
    }
    const indices = this.queue.map((_, idx) => idx)
    if (this.shuffleEnabled) {
      for (let i = indices.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[indices[i], indices[j]] = [indices[j], indices[i]]
      }
      if (activeId != null) {
        const activeIdx = this.queue.findIndex((track) => track.id === activeId)
        if (activeIdx >= 0) {
          const where = indices.indexOf(activeIdx)
          if (where > 0) {
            indices.splice(where, 1)
            indices.unshift(activeIdx)
          }
        }
      }
    }
    this.playOrder = indices
    if (activeId != null) {
      this.position = indices.findIndex((idx) => this.queue[idx]?.id === activeId)
    } else {
      this.position = -1
    }
  }

  private async handleEnded() {
    if (this.repeatMode === 'one') {
      this.seek(0)
      await this.play()
      return
    }
    if (this.hasNext() || this.repeatMode === 'all') {
      await this.next()
    }
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
    return mediaUrl(track.filePath) ?? ''
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
