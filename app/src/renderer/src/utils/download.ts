/**
 * 浏览器端下载公共工具（renderer 专用）。
 * 收敛各处手写的「Blob + createObjectURL + a.click」下载逻辑。
 */

/** 触发一次文本下载（Blob + objectURL，点击后立即释放 URL） */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 触发一次 data URL 下载（canvas.toDataURL 之类的图片导出） */
export function downloadDataUrl(filename: string, dataUrl: string): void {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
