import { useEffect, useRef } from 'react'
import { audioEngine } from '../player/audioEngine'

const SAMPLE_COUNT = 256

export function WaveformVisualizer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const data = new Uint8Array(SAMPLE_COUNT)
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

      audioEngine.getWaveformData(data)

      // Backdrop
      const backdrop = context.createLinearGradient(0, 0, 0, rect.height)
      backdrop.addColorStop(0, bg)
      backdrop.addColorStop(1, '#02060a')
      context.fillStyle = backdrop
      context.fillRect(0, 0, rect.width, rect.height)

      // Centerline
      context.strokeStyle = line
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(0, rect.height / 2)
      context.lineTo(rect.width, rect.height / 2)
      context.stroke()

      // Glow pass — wider, soft accent.
      context.lineWidth = 6
      context.strokeStyle = `${accent}33`
      drawWave(context, data, rect, frame)

      // Body pass — crisp gradient stroke.
      const stroke = context.createLinearGradient(0, 0, rect.width, 0)
      stroke.addColorStop(0, mint)
      stroke.addColorStop(0.5, accent)
      stroke.addColorStop(1, mint)
      context.strokeStyle = stroke
      context.lineWidth = 2
      context.lineJoin = 'round'
      context.lineCap = 'round'
      drawWave(context, data, rect, frame)

      frame += 1
      animation = requestAnimationFrame(render)
    }

    render()
    return () => cancelAnimationFrame(animation)
  }, [])

  return <canvas className="visualizer-canvas" ref={canvasRef} />
}

function drawWave(
  ctx: CanvasRenderingContext2D,
  data: Uint8Array,
  rect: DOMRect,
  frame: number,
) {
  ctx.beginPath()
  for (let index = 0; index < data.length; index += 1) {
    const idle = 128 + Math.sin(frame / 18 + index / 9) * 16 + Math.sin(frame / 7 + index / 22) * 6
    const raw = data[index]
    const value = Math.abs(raw - 128) > 3 ? raw : idle
    const normalized = value / 255
    const x = (index / (data.length - 1)) * rect.width
    const y = normalized * rect.height
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}
