import { useEffect, useRef } from 'react'
import { audioEngine } from '../player/audioEngine'

export function WaveformVisualizer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const data = new Uint8Array(256)
    let frame = 0
    let animation = 0

    const render = () => {
      const rect = canvas.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * scale))
      canvas.height = Math.max(1, Math.floor(rect.height * scale))
      context.setTransform(scale, 0, 0, scale, 0, 0)
      audioEngine.getWaveformData(data)

      context.clearRect(0, 0, rect.width, rect.height)
      context.fillStyle = 'rgba(6, 8, 10, 0.34)'
      context.fillRect(0, 0, rect.width, rect.height)
      context.lineWidth = 2
      context.strokeStyle = '#f1d47a'
      context.beginPath()

      data.forEach((value, index) => {
        const idle = 128 + Math.sin(frame / 16 + index / 10) * 18
        const normalized = (Math.abs(value - 128) > 3 ? value : idle) / 255
        const x = (index / (data.length - 1)) * rect.width
        const y = normalized * rect.height
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })

      context.stroke()
      frame += 1
      animation = requestAnimationFrame(render)
    }

    render()
    return () => cancelAnimationFrame(animation)
  }, [])

  return <canvas className="visualizer-canvas" ref={canvasRef} />
}
