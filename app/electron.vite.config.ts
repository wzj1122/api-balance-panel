import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'

/**
 * 把资源内容统一转成字符串。
 * Rollup/Vite 的产物 source 可能是 string 或 Uint8Array，这里统一解码成 UTF-8 文本。
 * @param source 产物源内容
 * @returns 解码后的文本
 */
function toText(source: string | Uint8Array): string {
  if (typeof source === 'string') return source
  return new TextDecoder('utf-8').decode(source)
}

/**
 * 把构建产出的 CSS 内联进 HTML 的自定义 Vite 插件。
 *
 * 背景：打包后主进程使用 `win.loadFile(out/renderer/index.html)`，页面以 `file://` 协议加载。
 * 在该协议下，外链 `<link rel="stylesheet" href="./assets/index-xxx.css">` **不会生效**
 * （而 `<script type="module">` 可以正常加载），于是页面呈现"裸 HTML"：文字贴边、栅格/弹性布局失效、
 * CSS 变量缺失、以及 `position:fixed` 的弹窗遮罩失效导致"按钮点不动"。
 *
 * 解决办法：在 `generateBundle` 阶段把 CSS 源码直接内联为 `<style>` 标签，并删除独立的 .css 产物，
 * 让样式永远跟随 HTML 一起加载，不再依赖 file:// 下的外部样式表加载能力。
 *
 * @returns Vite 插件实例
 */
function inlineCssPlugin(): Plugin {
  return {
    name: 'api-show:inline-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      // 1. 收集所有 .css 产物（Vite 会按 chunk 拆成多个 .css，必须全收齐，否则会有组件没样式）
      const cssFiles: string[] = []
      let combinedCss = ''
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type === 'asset' && fileName.endsWith('.css')) {
          cssFiles.push(fileName)
          combinedCss += toText(item.source) + '\n'
        }
      }
      if (cssFiles.length === 0) {
        this.warn('[inline-css] 未找到任何 .css 产物，已跳过内联：打包后页面可能完全没有样式')
        return
      }
      this.info(
        `[inline-css] 收集到 ${cssFiles.length} 个 CSS chunk，共 ${combinedCss.length} 字节：\n` +
          cssFiles.map((f) => '  - ' + f).join('\n')
      )
      // 体积/规则数健康检查：太小时多半有组件样式丢了（比如 Teleport + scoped 边角问题）
      if (combinedCss.length < 4000) {
        this.warn(
          `[inline-css] 合并后 CSS 仅 ${combinedCss.length} 字节，可能漏掉了某些组件的样式，请检查。`
        )
      }

      // 2. 找到 HTML 产物
      let htmlFileName = ''
      let htmlSource = ''
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type === 'asset' && fileName.endsWith('.html')) {
          htmlFileName = fileName
          htmlSource = toText(item.source)
          break
        }
      }
      if (!htmlFileName) {
        this.warn(
          `[inline-css] 未找到 .html 产物，已跳过内联：${cssFiles.length} 个 CSS 文件未能写入页面`
        )
        return
      }

      // 3. 把所有 <link rel="stylesheet" ...> 整段替换为内联 <style>
      const linkPattern = /[ \t]*<link\b[^>]*\brel\s*=\s*(["']?)stylesheet\1[^>]*>\r?\n?/gi
      if (!linkPattern.test(htmlSource)) {
        this.warn(
          `[inline-css] ${htmlFileName} 中未找到 <link rel="stylesheet"> 标签，无法内联 ${cssFiles.length} 个 CSS`
        )
        return
      }
      htmlSource = htmlSource.replace(
        linkPattern,
        `<style>\n${combinedCss}\n</style>\n`
      )

      // 4. 删除所有残留的 crossorigin 属性（file:// 下会触发跨域拦截）
      htmlSource = htmlSource.replace(/\s+crossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')

      const htmlAsset = bundle[htmlFileName]
      if (htmlAsset && htmlAsset.type === 'asset') {
        htmlAsset.source = htmlSource
      }

      // 5. 删除所有 CSS 产物（含其 sourcemap），避免留下不会被加载的无用文件
      for (const cssFileName of cssFiles) {
        delete bundle[cssFileName]
        if (bundle[`${cssFileName}.map`]) {
          delete bundle[`${cssFileName}.map`]
        }
      }
    }
  }
}

/**
 * electron-vite 三段构建配置。
 * 目录约定：src/main（主进程）、src/preload（预加载）、src/renderer（渲染进程，入口 index.html）。
 * 别名在 tsconfig 与 vite 两处都要配，否则 IDE 不报错但运行会找不到模块。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // 打包后以 file:// 加载，必须用相对路径，否则资源会指向磁盘根目录
    base: './',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue(), inlineCssPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
