import { useEffect, useRef } from 'react'
import { audioEngine } from '../player/audioEngine'

const BAR_COUNT = 64

export function BarsVisualizer({ compact = false }: { compact?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const data = new Uint8Array(BAR_COUNT)
    let frame = 0
    let animation = 0

    const readToken = (name: string, fallback: string) => {
      const value = getComputedStyle(canvas).getPropertyValue(name).trim()
      return value || fallback
    }

    const render = () => {
      const rect = canvas.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * scale))
      canvas.height = Math.max(1, Math.floor(rect.height * scale))
      context.setTransform(scale, 0, 0, scale, 0, 0)

      const accent = readToken('--accent', '#d8ff5c')
      const mint = readToken('--mint', '#4cd2a8')
      const bg = readToken('--bg-sunken', '#08100d')
      const line = readToken('--line', '#232f29')

      audioEngine.getFrequencyData(data)
      context.clearRect(0, 0, rect.width, rect.height)

      // Sunken backdrop with a soft floor gradient.
      const backdrop = context.createLinearGradient(0, 0, 0, rect.height)
      backdrop.addColorStop(0, bg)
      backdrop.addColorStop(1, compact ? bg : '#02060a')
      context.fillStyle = backdrop
      context.fillRect(0, 0, rect.width, rect.height)

      // Faint baseline rule
      context.fillStyle = line
      context.fillRect(0, rect.height - 1, rect.width, 1)

      const gap = 2
      const barWidth = (rect.width - gap * (BAR_COUNT - 1)) / BAR_COUNT
      const baseHeight = rect.height * 0.06

      // Pre-build a vertical gradient once per frame
      const fill = context.createLinearGradient(0, rect.height, 0, 0)
      fill.addColorStop(0, mint)
      fill.addColorStop(0.55, accent)
      fill.addColorStop(1, accent)

      for (let index = 0; index < BAR_COUNT; index += 1) {
        const idle = 36 + Math.sin(frame / 18 + index / 2.4) * 22 + Math.cos(frame / 26 + index / 6) * 10
        const value = Math.max(data[index], idle)
        const norm = value / 255
        const height = Math.max(baseHeight, norm * (rect.height - 4))

        const x = index * (barWidth + gap)
        const y = rect.height - height
        const w = Math.max(2, barWidth)

        // Subtle reflection/halo behind tall bars
        if (norm > 0.55) {
          context.fillStyle = `rgba(216, 255, 92, ${0.08 * norm})`
          context.fillRect(x - 2, y - 4, w + 4, height + 4)
        }

        context.fillStyle = fill
        const radius = Math.min(w / 2, 2)
        roundedTopRect(context, x, y, w, height, radius)
      }

      frame += 1
      animation = requestAnimationFrame(render)
    }

    render()
    return () => cancelAnimationFrame(animation)
  }, [compact])

  return <canvas className="visualizer-canvas" ref={canvasRef} />
}

function roundedTopRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x, y + h)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h)
  ctx.closePath()
  ctx.fill()
}
