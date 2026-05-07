import { useEffect, useRef } from 'react'
import { audioEngine } from '../player/audioEngine'
import { mediaUrl } from '../../lib/tauri'
import type { Track } from '../../types'

const BAR_COUNT = 96

/**
 * The hero visualizer. Centerpiece is the cover art rendered as a still
 * circle that pulses (zoom in/out) with bass energy — no rotation, just
 * chill. Around it: a ring of frequency bars whose lengths track the FFT,
 * plus a soft accent glow whose intensity ties to the bass envelope.
 * Theme-aware: reads CSS tokens each frame so it follows light/dark.
 */
export function CoverVisualizer({ track, playing }: { track: Track | null; playing: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)

  // Preload cover art so we can draw it onto the canvas without flicker.
  useEffect(() => {
    const url = track?.coverPath ? mediaUrl(track.coverPath) : null
    if (!url) {
      imageRef.current = null
      return
    }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imageRef.current = img
    }
    img.onerror = () => {
      imageRef.current = null
    }
    img.src = url
    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [track?.coverPath])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const data = new Uint8Array(BAR_COUNT)
    let frame = 0
    let animation = 0
    let bassEnvelope = 0

    const readToken = (name: string, fallback: string) => {
      const value = getComputedStyle(canvas).getPropertyValue(name).trim()
      return value || fallback
    }

    const render = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      context.setTransform(dpr, 0, 0, dpr, 0, 0)

      const accent = readToken('--accent', '#d8ff5c')
      const mint = readToken('--mint', '#4cd2a8')
      const bg = readToken('--bg-sunken', '#08100d')
      const line = readToken('--line', '#232f29')
      const text = readToken('--text', '#e9f0e7')

      audioEngine.getFrequencyData(data)

      // Bass envelope follows the audio engine bass energy with smoothing —
      // attack is fast, decay is slow, so the cover punches and settles.
      const bass = audioEngine.getBassEnergy()
      const target = Math.min(1, bass * 1.2)
      const speed = target > bassEnvelope ? 0.4 : 0.06
      bassEnvelope += (target - bassEnvelope) * speed

      // Backdrop
      const backdrop = context.createRadialGradient(
        rect.width / 2,
        rect.height / 2,
        0,
        rect.width / 2,
        rect.height / 2,
        Math.max(rect.width, rect.height) * 0.7,
      )
      backdrop.addColorStop(0, mixColor(bg, accent, 0.06 + bassEnvelope * 0.18))
      backdrop.addColorStop(1, bg)
      context.fillStyle = backdrop
      context.fillRect(0, 0, rect.width, rect.height)

      // Subtle measurement grid for the workstation feel.
      context.strokeStyle = `${line}55`
      context.lineWidth = 1
      const gridStep = 28
      for (let x = gridStep; x < rect.width; x += gridStep) {
        context.beginPath()
        context.moveTo(x + 0.5, 0)
        context.lineTo(x + 0.5, rect.height)
        context.stroke()
      }
      for (let y = gridStep; y < rect.height; y += gridStep) {
        context.beginPath()
        context.moveTo(0, y + 0.5)
        context.lineTo(rect.width, y + 0.5)
        context.stroke()
      }

      const cx = rect.width / 2
      const cy = rect.height / 2
      const baseRadius = Math.min(rect.width, rect.height) * 0.28
      // Beat-driven zoom — punchy on the kick, smooth in between.
      const pulse = 1 + bassEnvelope * 0.14
      const radius = baseRadius * pulse
      const ringInner = radius + 8
      const ringOuter = radius + 8 + Math.min(rect.width, rect.height) * 0.18

      // Glow halo behind cover — intensifies on bass.
      const glow = context.createRadialGradient(cx, cy, radius * 0.6, cx, cy, ringOuter * 1.05)
      glow.addColorStop(0, mixColor(accent, '#000000', 1 - (0.18 + bassEnvelope * 0.45)))
      glow.addColorStop(1, 'transparent')
      context.fillStyle = glow
      context.beginPath()
      context.arc(cx, cy, ringOuter * 1.05, 0, Math.PI * 2)
      context.fill()

      // Frequency bar ring around the cover.
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const idle =
          0.12 +
          0.08 * Math.sin(frame / 24 + i / 3.5) +
          0.05 * Math.cos(frame / 18 + i / 7)
        const energy = Math.max(data[i] / 255, idle)
        const barLen = (ringOuter - ringInner) * energy
        const angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2
        const sx = cx + Math.cos(angle) * ringInner
        const sy = cy + Math.sin(angle) * ringInner
        const ex = cx + Math.cos(angle) * (ringInner + barLen)
        const ey = cy + Math.sin(angle) * (ringInner + barLen)

        const stroke = context.createLinearGradient(sx, sy, ex, ey)
        stroke.addColorStop(0, mint)
        stroke.addColorStop(1, accent)
        context.strokeStyle = stroke
        context.lineWidth = 2.4
        context.lineCap = 'round'
        context.beginPath()
        context.moveTo(sx, sy)
        context.lineTo(ex, ey)
        context.stroke()
      }

      // Cover disc — still, no rotation. The pulse comes purely from `radius`
      // already being scaled by the bass envelope above.
      context.save()
      context.translate(cx, cy)
      context.beginPath()
      context.arc(0, 0, radius, 0, Math.PI * 2)
      context.closePath()
      context.clip()

      const img = imageRef.current
      if (img && img.complete && img.naturalWidth > 0) {
        // Fit cover to circle, center-cropped.
        const size = radius * 2
        context.drawImage(img, -radius, -radius, size, size)
      } else {
        // Fallback gradient disc.
        const cover = context.createLinearGradient(-radius, -radius, radius, radius)
        cover.addColorStop(0, mixColor(accent, mint, 0.4))
        cover.addColorStop(1, mixColor(mint, bg, 0.6))
        context.fillStyle = cover
        context.fillRect(-radius, -radius, radius * 2, radius * 2)

        // Static concentric circles as a vinyl-ish fallback texture.
        context.strokeStyle = `${text}22`
        context.lineWidth = 1
        for (let r = radius * 0.25; r < radius; r += radius * 0.12) {
          context.beginPath()
          context.arc(0, 0, r, 0, Math.PI * 2)
          context.stroke()
        }
      }
      context.restore()

      // Cover ring outline.
      context.strokeStyle = mixColor(accent, '#ffffff', 0.15)
      context.lineWidth = 1.5
      context.beginPath()
      context.arc(cx, cy, radius, 0, Math.PI * 2)
      context.stroke()

      frame += 1
      animation = requestAnimationFrame(render)
    }

    render()
    return () => cancelAnimationFrame(animation)
  }, [playing])

  return <canvas className="visualizer-canvas" ref={canvasRef} />
}

/**
 * Mix two hex/named colors with a t between 0 and 1. We can't always rely on
 * `color-mix()` working inside canvas paint ops, so this falls back to a
 * lightweight RGBA-string blend.
 */
function mixColor(a: string, b: string, t: number) {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) return a
  const k = Math.max(0, Math.min(1, t))
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * k)
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * k)
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * k)
  return `rgb(${r}, ${g}, ${bl})`
}

function parseColor(input: string): [number, number, number] | null {
  const trimmed = input.trim()
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1)
    const expanded = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    if (expanded.length !== 6) return null
    const value = parseInt(expanded, 16)
    if (Number.isNaN(value)) return null
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  }
  const rgbMatch = trimmed.match(/rgba?\(([^)]+)\)/i)
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((part) => parseFloat(part))
    if (parts.length >= 3 && parts.slice(0, 3).every((value) => Number.isFinite(value))) {
      return [parts[0], parts[1], parts[2]]
    }
  }
  return null
}
