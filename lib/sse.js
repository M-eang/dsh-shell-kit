/**
 * 背压感知的 SSE 帧写入器（dsh-shell-kit 侧的实现）。
 *
 * 与 dsh-prompt-refine/src/sse.ts 同构：那边的增量改写路由往浏览器推模型
 * delta，模型可能比客户端快 —— `ServerResponse.write()` 在 socket 缓冲写满时
 * 返回 false，忽略这个返回值就会把帧无限堆在缓冲里，一个卡住的读者（被浏览器
 * 节流的标签页）就能把整次改写扣在内存里。所以每一帧都要等到 `drain`。
 *
 * 这边新增两个小工具：`sseFrame` 统一帧格式（JSON.stringify 保证 data 里
 * 不会有裸换行），`sseComment` 统一心跳/开流注释帧。
 */

/** 这次写入需要的响应面（真实的 ServerResponse 天然满足）。 */
function isWritable(res) {
  return res?.writableEnded !== true && res?.destroyed !== true
}

/**
 * 在一条响应上创建 SSE 写入器。
 * @param {object} res 宿主传进来的响应对象
 * @returns {{open: () => void, write: (frame: string) => Promise<void>, dispose: () => void}}
 */
export function createSseWriter(res) {
  let closed = false
  const onClose = () => {
    closed = true
  }
  res.once('close', onClose)
  return {
    open() {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // 先发一条注释帧把响应头冲出去：客户端的 reader 不必等第一行日志才开始读。
      res.write(sseComment('open'))
    },
    async write(frame) {
      if (closed || !isWritable(res)) return
      if (res.write(frame)) return
      await new Promise((resolve) => {
        const done = () => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    },
    dispose() {
      closed = true
      res.off('close', onClose)
    },
  }
}

/** 一条具名事件帧；`data` 走 JSON，因此不会出现裸换行把帧切断。 */
export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`
}

/** 注释帧（开流冲头、心跳保活都用它；SSE 客户端会忽略注释）。 */
export function sseComment(text) {
  return `: ${String(text).replace(/[\r\n]+/g, ' ')}\n\n`
}
