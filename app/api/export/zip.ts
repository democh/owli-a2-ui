/**
 * 文件表 → zip Buffer(archiver v8 命名导出)
 */
import { ZipArchive } from "archiver";
import { Writable } from "node:stream";

export async function zipFiles(files: Record<string, string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk as Buffer);
      cb();
    },
  });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const done = new Promise<Buffer>((resolve, reject) => {
    sink.on("finish", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
  });
  archive.pipe(sink);
  for (const [path, content] of Object.entries(files)) {
    archive.append(content, { name: path });
  }
  await archive.finalize();
  return done;
}
