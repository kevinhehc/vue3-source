// 包装一下vue的异常
export function warn(msg: string, ...args: any[]): void {
  console.warn(`[Vue warn] ${msg}`, ...args)
}
