import { useEffect, useRef } from 'react'
import { audioEngine } from '../player/audioEngine'

export function BarsVisualizer({ compact = false }: { compact?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const data = new Uint8Array(96)
    let frame = 0
    let animation = 0

    const render = () => {
      const rect = canvas.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * scale))
      canvas.height = Math.max(1, Math.floor(rect.height * scale))
      context.setTransform(scale, 0, 0, scale, 0, 0)

      audioEngine.getFrequencyData(data)
      context.clearRect(0, 0, rect.width, rect.height)
      context.fillStyle = compact ? 'rgba(16, 20, 24, 0.35)' : 'rgba(0, 0, 0, 0.2)'
      context.fillRect(0, 0, rect.width, rect.height)

      const barWidth = rect.width / data.length
      for (let index = 0; index < data.length; index += 1) {
        const idle = 42 + Math.sin(frame / 14 + index / 3) * 26
        const value = Math.max(data[index], idle)
        const height = (value / 255) * rect.height
        const hue = 160 + index * 1.8
        context.fillStyle = `hsl(${hue} 72% ${compact ? 55 : 62}%)`
        context.fillRect(index * barWidth + 1, rect.height - height, Math.max(2, barWidth - 2), height)
      }

      frame += 1
      animation = requestAnimationFrame(render)
    }

    render()
    return () => cancelAnimationFrame(animation)
  }, [compact])

  return <canvas className="visualizer-canvas" ref={canvasRef} />
}
