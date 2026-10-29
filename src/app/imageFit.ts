/**
 * 生成图入库前的压缩。
 *
 * 为什么必须做：qwen-image 出一张 1024 的图，base64 后接近 1.9MB 文本。
 * 十张图就是十几 MB 的存档 JSON——导出会卡、IndexedDB 会胀、手机直接崩。
 * 压到长边 768 的 JPEG（q0.82）大约 120–160KB，投在正文里肉眼几乎看不出差别。
 *
 * 浏览器里才有 canvas；测试环境（node）直接原样返回，保证纯函数可测。
 */

const MAX_SIDE = 768
const QUALITY = 0.82
/** 已经足够小的图不再重编码：二次压缩只会更糊 */
const SKIP_UNDER = 360_000

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

export async function fitImage(
  dataUrl: string,
  maxSide = MAX_SIDE,
  quality = QUALITY,
): Promise<string> {
  if (typeof document === 'undefined' || !dataUrl.startsWith('data:image/')) return dataUrl
  if (dataUrl.length < SKIP_UNDER) return dataUrl
  try {
    const img = await loadImage(dataUrl)
    const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1))
    if (scale >= 1) return dataUrl

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round((img.width || 1) * scale))
    canvas.height = Math.max(1, Math.round((img.height || 1) * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const out = canvas.toDataURL('image/jpeg', quality)
    // 压完反而更大（小图、纯色图）就保留原图
    return out.length < dataUrl.length ? out : dataUrl
  } catch {
    return dataUrl
  }
}
