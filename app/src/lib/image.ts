/**
 * 对话参考图片处理:客户端压缩 → base64
 * - 发送给模型的图:最长边 1568(Claude 建议上限),JPEG 0.85,控制在 ~1MB 内
 * - 历史回显用的缩略图:最长边 320,JPEG 0.7(消息表 meta 体积友好)
 */
import type { ImageRef } from "@contracts/a2ui";

export interface PendingImage extends ImageRef {
  /** 压缩后的完整 dataUrl(输入区/气泡里直接预览用) */
  dataUrl: string;
  /** 小尺寸缩略 dataUrl(持久化到消息 meta 用) */
  thumb: string;
}

const MAX_DIM = 1568;
const THUMB_DIM = 320;
export const MAX_IMAGES = 3;

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片读取失败"));
      img.src = url;
    });
    return img;
  } finally {
    // 注意:不能在 onload 前 revoke;这里统一在加载结束后释放
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function renderToJpeg(img: HTMLImageElement, maxDim: number, quality: number): Promise<string> {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("浏览器不支持 canvas"));
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("图片压缩失败"));
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("图片压缩失败"));
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

/** 文件 → 待发送图片;非图片类型或超过 8MB 原图直接拒绝 */
export async function fileToPendingImage(file: File): Promise<PendingImage> {
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) throw new Error("仅支持 PNG/JPEG/WebP/GIF 图片");
  if (file.size > 8 * 1024 * 1024) throw new Error("图片超过 8MB,请先压缩后再上传");
  const img = await loadImage(file);
  const dataUrl = await renderToJpeg(img, MAX_DIM, 0.85);
  const thumb = await renderToJpeg(img, THUMB_DIM, 0.7);
  return {
    name: file.name.slice(0, 120) || "image",
    mediaType: "image/jpeg",
    data: dataUrl.split(",")[1] ?? "",
    dataUrl,
    thumb,
  };
}
