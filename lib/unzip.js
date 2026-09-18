// 极简 zip 读取（stored / deflate），只为解析桌宠 zip 包；无外部依赖。
import zlib from 'node:zlib'

export function unzipSync(buf) {
  const out = []
  // 从 End of Central Directory 找 central directory
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nlen)
    p += 46 + nlen + elen + clen
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue
    const lnlen = buf.readUInt16LE(lho + 26)
    const lelen = buf.readUInt16LE(lho + 28)
    const start = lho + 30 + lnlen + lelen
    const raw = buf.subarray(start, start + csize)
    let data
    if (method === 0) data = raw
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else continue
    if (usize && data.length !== usize) continue
    out.push({ name, data })
  }
  return out
}
