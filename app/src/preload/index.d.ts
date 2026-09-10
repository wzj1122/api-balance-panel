import type { PanelApi } from '../shared/ipc'

/** 渲染进程里通过 window.api 访问预加载暴露的白名单方法 */
declare global {
  interface Window {
    api: PanelApi
  }
}

export type { PanelApi }
